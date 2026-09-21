/**
 * The player's decision surface.
 *
 * Enumerates what the operator could do this month and applies the choice.
 * Every action routes to the same operations the autopilot uses, so a decision
 * the player makes is priced, aged and failed identically to one the heuristic
 * would have made.
 *
 * An action carries its trade-off as text. The spec's first design pillar is
 * that every major technology improves at most two outcomes while adding a
 * cost, risk or constraint; that is only a pillar if the player can see the
 * other half before committing.
 */

import type { SimulationContext } from './context.js';
import type { DecisionCategory, OperatorSystem } from './operator.js';
import { canStartResearch } from './systems/research.js';
import { installedItMw } from './report.js';
import type { HallState } from '../state/types.js';

export interface PlayerActionBase {
  readonly id: string;
  readonly category: DecisionCategory;
  readonly label: string;
  /** What this does, in the player's terms. */
  readonly detail: string;
  /** What it costs beyond cash: the constraint it adds. */
  readonly tradeOff: string;
  readonly cost: number;
  readonly affordable: boolean;
  /** Set when the action cannot be taken, explaining why. */
  readonly blocked?: string;
}

export interface ResearchAction extends PlayerActionBase {
  readonly kind: 'research.start';
  readonly technologyId: string;
  readonly branch: string;
  readonly tier: number;
  readonly costRP: number;
  readonly durationDays: number;
}

export interface ContractAction extends PlayerActionBase {
  readonly kind: 'contract.sign';
  readonly offerId: string;
  readonly workload: string;
  readonly computeUnits: number;
  readonly termMonths: number;
  readonly annualRevenue: number;
  /** Compute units the fleet can actually deliver for this workload. */
  readonly servableUnits: number;
  readonly reservedUnits: number;
  /** Units still safely sellable for this workload BEFORE taking this offer. */
  readonly freeUnits: number;
  /** True when the fleet can serve this offer on top of what it already sold. */
  readonly fits: boolean;
  /** Units short if it does not fit. */
  readonly shortBy: number;
}

export interface HardwareAction extends PlayerActionBase {
  readonly kind: 'hardware.buy';
  readonly hardwareId: string;
  readonly family: string;
  readonly costPerRack: number;
  readonly rackKw: number;
  /** Racks that fit in the halls that can cool them. */
  readonly spaceAvailable: number;
  readonly maxAffordable: number;
  readonly computePerRack: number;
}

export interface HallAction extends PlayerActionBase {
  readonly kind: 'hall.build';
  readonly coolingId: string;
  readonly racks: number;
  readonly densityKwPerRack: number;
  readonly waterFactor: number;
}

export interface RetrofitAction extends PlayerActionBase {
  readonly kind: 'hall.retrofit';
  readonly hallId: string;
  readonly coolingId: string;
  readonly fromCooling: string;
}

export interface PowerAction extends PlayerActionBase {
  readonly kind: 'power.build';
  readonly definitionId: string;
  readonly mw: number;
  readonly clean: boolean;
  readonly carbonKgPerMwh: number;
}

export type PlayerAction =
  | ResearchAction | ContractAction | HardwareAction | HallAction | RetrofitAction | PowerAction;

export interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
}

/** Hall sizes offered when building. Modular expansion, per chapter 4. */
const HALL_SIZES = [60, 120, 220];
/** Rack order sizes offered. */
export const RACK_ORDER_SIZES = [10, 25, 50];
/** Power block sizes offered, MW. */
const POWER_SIZES = [2, 5];

function money(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(0)}k`;
  return `$${value.toFixed(0)}`;
}

/**
 * Everything the operator could do this month, whether or not it is affordable.
 *
 * Unaffordable and blocked actions are listed rather than hidden: knowing that
 * immersion cooling exists and costs four times what you have is a different
 * kind of information from it being absent, and planning needs the first kind.
 */
export function enumerateActions(context: SimulationContext, operator: OperatorSystem): PlayerAction[] {
  const actions: PlayerAction[] = [];
  const cash = context.state.company.cash;
  const budget = operator.budget(context);

  // ------------------------------------------------------------- research
  if (!context.state.research.activeId) {
    for (const technology of context.registry.all('technologies').values()) {
      if (!canStartResearch(context, technology.id)) continue;
      const affordable = context.state.company.researchPoints >= technology.research.costRP * 0.15;
      actions.push({
        kind: 'research.start',
        id: `research:${technology.id}`,
        category: 'research',
        label: technology.name,
        detail: `${technology.description ?? ''} Tier ${technology.tier} ${technology.branch}. `
          + `${technology.research.costRP.toLocaleString()} RP over ${technology.research.durationDays} days.`,
        tradeOff: technology.tradeOff,
        cost: 0,
        affordable: true,
        blocked: affordable ? undefined
          : `Only ${Math.round(context.state.company.researchPoints).toLocaleString()} RP banked; `
            + 'research will run slowly until more accrues.',
        technologyId: technology.id,
        branch: technology.branch,
        tier: technology.tier,
        costRP: technology.research.costRP,
        durationDays: technology.research.durationDays,
      });
    }
  }

  // ------------------------------------------------------------ contracts
  for (const offer of context.state.contractOffers) {
    const definition = context.registry.contract(offer.definitionId, offer.instanceId);
    const workload = context.registry.workload(definition.workloadId, definition.id);
    const servable = operator.servableFor(context, workload.id);
    const reserved = operator.reservedFor(context, workload.id);
    const headroom = servable * 0.85 - reserved;
    const annualRevenue = offer.computeUnits * offer.pricePerComputeUnitHour * 8766;

    const reputationShort = definition.minimumReputation > context.state.company.reputation;
    const techShort = !definition.requiredTechnologies
      .every((id) => context.state.research.completed.includes(id));

    let blocked: string | undefined;
    if (reputationShort) {
      blocked = `Needs reputation ${definition.minimumReputation}; you have `
        + `${Math.round(context.state.company.reputation)}.`;
    } else if (techShort) {
      const missing = definition.requiredTechnologies
        .filter((id) => !context.state.research.completed.includes(id))
        .map((id) => context.registry.technology(id, definition.id).name);
      blocked = `Requires ${missing.join(', ')}.`;
    }

    const free = Math.max(0, headroom);
    const fits = offer.computeUnits <= free;
    const shortBy = Math.max(0, offer.computeUnits - free);

    actions.push({
      kind: 'contract.sign',
      id: `contract:${offer.instanceId}`,
      category: 'contracts',
      label: definition.name,
      detail: `${offer.computeUnits.toLocaleString()} compute units of ${workload.name} for `
        + `${offer.termMonths} months at $${offer.pricePerComputeUnitHour.toFixed(4)}/unit-hour `
        + `(${money(annualRevenue)}/year). SLA ${(definition.slaUptime01 * 100).toFixed(2)}%.`,
      // The fit is stated either way. Warning only on an oversell leaves the
      // player guessing on every offer that does fit, which is the same
      // arithmetic by hand.
      tradeOff: fits
        ? `Fits: you have room for ${Math.round(free).toLocaleString()} units of ${workload.name} and `
          + `this takes ${offer.computeUnits.toLocaleString()}, leaving `
          + `${Math.round(free - offer.computeUnits).toLocaleString()}. `
          + `${workload.penaltyClass === 'extreme' ? 'Extreme' : 'Standard'} penalties if you miss the SLA.`
        : `Oversells by ${Math.round(shortBy).toLocaleString()} units: you have room for `
          + `${Math.round(free).toLocaleString()} of ${workload.name} and this wants `
          + `${offer.computeUnits.toLocaleString()}. Unserved units are SLA breaches.`,
      cost: 0,
      affordable: true,
      blocked,
      offerId: offer.instanceId,
      workload: workload.name,
      computeUnits: offer.computeUnits,
      termMonths: offer.termMonths,
      annualRevenue,
      servableUnits: servable,
      reservedUnits: reserved,
      freeUnits: free,
      fits,
      shortBy,
    });
  }

  // ------------------------------------------------------------- hardware
  const unlockedHardware = ['hardware.cpu.gen1', ...context.state.research.unlockedHardware];
  const halls = context.state.facilities.flatMap((facility) => facility.halls)
    .filter((hall) => hall.constructionProgress01 >= 1);

  for (const hardwareId of [...new Set(unlockedHardware)]) {
    const hardware = context.registry.hardware(hardwareId, 'player');
    const rackKw = context.balance.baseRackPowerKw * hardware.powerFactor
      * context.modifiers.value('hardware.powerDraw', 1);
    const costPerRack = operator.rackPrice(context, hardware);

    // Space only counts in halls whose cooling can carry this rack density.
    let space = 0;
    for (const hall of halls) {
      if (operator.coolingCeilingKw(context, hall) < hardware.requiredCoolingKwPerRack) continue;
      const installed = hall.rackGroups.reduce((total, group) => total + group.count, 0);
      space += Math.max(0, hall.rackCapacity - installed);
    }

    actions.push({
      kind: 'hardware.buy',
      id: `hardware:${hardwareId}`,
      category: 'capacity',
      label: hardware.name,
      detail: `${money(costPerRack)} per rack, ${rackKw.toFixed(1)} kW each, `
        + `${Math.round(context.balance.baseRackComputeUnits * hardware.computeFactor)} compute units. `
        + `${hardware.lifeYears}-year life.`,
      tradeOff: hardware.refurbished
        ? 'A fifth of the embodied carbon, and it fails more and draws more for the same work.'
        : `Needs ${hardware.requiredCoolingKwPerRack} kW/rack of cooling. `
          + `Embodied carbon ${Math.round(context.balance.baseRackEmbodiedKgCo2e * hardware.embodiedFactor / 1000)} t `
          + `per rack lands in this year's report.`,
      cost: costPerRack,
      affordable: budget >= costPerRack,
      blocked: space <= 0
        ? 'No hall with cooling dense enough and space free. Build or retrofit a hall first.'
        : undefined,
      hardwareId,
      family: hardware.family,
      costPerRack,
      rackKw,
      spaceAvailable: space,
      maxAffordable: Math.floor(budget / Math.max(1, costPerRack)),
      computePerRack: context.balance.baseRackComputeUnits * hardware.computeFactor,
    });
  }

  // ----------------------------------------------------------------- halls
  const unlockedCooling = ['cooling.basic_air', ...context.state.research.unlockedCooling];
  const itMw = installedItMw(context);
  const atInterconnectLimit = itMw >= context.region.grid.capacityMw * 0.85;

  for (const coolingId of [...new Set(unlockedCooling)]) {
    const cooling = context.registry.cooling(coolingId, 'player');
    for (const racks of HALL_SIZES) {
      const cost = operator.priceHall(context, racks, cooling);
      actions.push({
        kind: 'hall.build',
        id: `hall:${coolingId}:${racks}`,
        category: 'capacity',
        label: `${racks}-rack hall · ${cooling.name}`,
        detail: `${money(cost)} to build, about six months to commission. `
          + `Cools up to ${cooling.densityKwPerRack} kW per rack.`,
        tradeOff: cooling.waterFactor > 0
          ? `Draws about ${cooling.waterFactor.toFixed(2)} L of water per kWh of IT energy. `
            + `Water stress here is ${Math.round(context.region.water.stress01 * 100)}/100.`
          : 'Uses no water, and pays for that in fan and compressor energy when it is hot.',
        cost,
        affordable: budget >= cost,
        blocked: atInterconnectLimit
          ? `At ${itMw.toFixed(1)} MW you are near this region's ${context.region.grid.capacityMw} MW interconnection limit.`
          : undefined,
        coolingId,
        racks,
        densityKwPerRack: cooling.densityKwPerRack,
        waterFactor: cooling.waterFactor,
      });
    }
  }

  // ------------------------------------------------------------- retrofits
  for (const hall of halls) {
    const current = context.registry.cooling(hall.coolingId, hall.instanceId);
    for (const coolingId of [...new Set(unlockedCooling)]) {
      if (coolingId === hall.coolingId) continue;
      const cooling = context.registry.cooling(coolingId, 'player');
      if (cooling.densityKwPerRack <= current.densityKwPerRack
        && cooling.energyFactor >= current.energyFactor) continue;
      const cost = operator.priceRetrofit(context, hall, cooling);
      actions.push({
        kind: 'hall.retrofit',
        id: `retrofit:${hall.instanceId}:${coolingId}`,
        category: 'cooling',
        label: `${hallName(hall)}: ${current.name} → ${cooling.name}`,
        detail: `${money(cost)} to re-plumb a live hall. `
          + `Density ${current.densityKwPerRack} → ${cooling.densityKwPerRack} kW/rack, `
          + `cooling energy ×${(cooling.energyFactor / current.energyFactor).toFixed(2)}.`
          + (hall.throttle01 > 0.02
            ? ` This hall is throttling ${(hall.throttle01 * 100).toFixed(0)}% of its load.`
            : ''),
        tradeOff: cooling.waterFactor > current.waterFactor
          ? `Water use rises from ${current.waterFactor.toFixed(2)} to ${cooling.waterFactor.toFixed(2)} L/kWh.`
          : `Maintenance complexity rises to ${(cooling.complexity01 * 100).toFixed(0)}/100; `
            + 'specialist staff and a leak regime come with it.',
        cost,
        affordable: budget >= cost,
        hallId: hall.instanceId,
        coolingId,
        fromCooling: current.name,
      });
    }
  }

  // ----------------------------------------------------------------- power
  const unlockedPower = ['power.grid', 'power.diesel_backup', ...context.state.research.unlockedPower];
  for (const definitionId of [...new Set(unlockedPower)]) {
    const definition = context.registry.power(definitionId, 'player');
    if (definition.kind === 'storage') {
      const cost = operator.pricePower(context, definitionId, POWER_SIZES[0] ?? 2);
      actions.push(powerAction(context, operator, definition.id, POWER_SIZES[0] ?? 2, cost, budget));
      continue;
    }
    for (const mw of POWER_SIZES) {
      const cost = operator.pricePower(context, definitionId, mw);
      actions.push(powerAction(context, operator, definitionId, mw, cost, budget));
    }
  }

  void cash;
  return actions;
}

function powerAction(
  context: SimulationContext, operator: OperatorSystem,
  definitionId: string, mw: number, cost: number, budget: number,
): PowerAction {
  const definition = context.registry.power(definitionId, 'player');
  const quality = context.region.resourceQuality[definitionId] ?? definition.dispatchability01;
  const carbon = definition.carbonMode === 'regional'
    ? context.region.grid.baseCarbonKgPerMwh
    : definition.carbonFactor * context.balance.baseCarbonKgPerMwh;

  return {
    kind: 'power.build',
    id: `power:${definitionId}:${mw}`,
    category: 'power',
    label: `${mw} MW · ${definition.name}`,
    detail: `${money(cost)}. `
      + (definition.kind === 'storage'
        ? `${definition.storageDurationHours} hours of storage at `
          + `${(definition.roundTripEfficiency01 * 100).toFixed(0)}% round trip.`
        : `Delivers about ${(quality * 100).toFixed(0)}% of rated output here, `
          + `${carbon.toFixed(0)} kg CO2e/MWh.`)
      + (definition.leadTimeDays > 0 && definitionId !== 'power.grid'
        ? ` ${Math.round(definition.leadTimeDays / 30)} months to commission.`
        : ''),
    tradeOff: definition.communityDelta < 0
      ? `Community trust ${definition.communityDelta} on commissioning`
        + (definition.communityDeltaPerRunHour < 0 ? ', and more for every hour it runs.' : '.')
      : definition.renewable
        ? `Intermittent: ${definition.landHectaresPerMw} hectares per MW, and it generates when the `
          + 'weather says so, not when you need it.'
        : 'Firm supply at a premium price.',
    cost,
    affordable: budget >= cost,
    definitionId,
    mw,
    clean: definition.clean,
    carbonKgPerMwh: carbon,
  };
}

/** A hall's name as the player would say it: "Hall 2". */
export function hallName(hall: HallState): string {
  const index = Number(hall.instanceId.split('.').pop());
  return Number.isFinite(index) ? `Hall ${index + 1}` : 'Hall';
}

/** Applies a chosen action. `quantity` applies to rack orders only. */
export function applyAction(
  context: SimulationContext,
  operator: OperatorSystem,
  actionId: string,
  quantity = 1,
): ActionResult {
  const [kind, ...rest] = actionId.split(':');

  if (kind === 'research') {
    const technologyId = rest.join(':');
    if (context.state.research.activeId) {
      return { ok: false, message: 'Another project is already in progress.' };
    }
    if (!canStartResearch(context, technologyId)) {
      return { ok: false, message: 'Prerequisites for that technology are not met.' };
    }
    context.state.research.activeId = technologyId;
    const technology = context.registry.technology(technologyId, 'player');
    return { ok: true, message: `Started research: ${technology.name}.` };
  }

  if (kind === 'contract') {
    const offerId = rest.join(':');
    return operator.signOffer(context, offerId)
      ? { ok: true, message: 'Contract signed.' }
      : { ok: false, message: 'That offer is no longer on the table.' };
  }

  if (kind === 'hardware') {
    const hardwareId = rest.join(':');
    const hardware = context.registry.hardware(hardwareId, 'player');
    const halls = context.state.facilities.flatMap((facility) => facility.halls)
      .filter((hall) => hall.constructionProgress01 >= 1
        && operator.coolingCeilingKw(context, hall) >= hardware.requiredCoolingKwPerRack);

    let remaining = Math.max(1, quantity);
    let installed = 0;
    for (const hall of halls) {
      if (remaining <= 0) break;
      const placed = operator.orderRacks(context, hall, hardware, remaining);
      installed += placed;
      remaining -= placed;
    }
    if (installed === 0) {
      return { ok: false, message: 'Could not order racks: no cooled space, or not enough cash.' };
    }
    return { ok: true, message: `Installed ${installed} racks of ${hardware.name}.` };
  }

  if (kind === 'hall') {
    const [coolingId, racksText] = [rest[0] ?? '', rest[1] ?? ''];
    const cooling = context.registry.cooling(coolingId, 'player');
    const racks = Number(racksText);
    return operator.orderHall(context, racks, cooling)
      ? { ok: true, message: `${racks}-rack hall started with ${cooling.name}.` }
      : { ok: false, message: 'Not enough available cash for that hall.' };
  }

  if (kind === 'retrofit') {
    const hallId = rest[0] ?? '';
    const coolingId = rest.slice(1).join(':');
    const hall = context.state.facilities.flatMap((f) => f.halls)
      .find((candidate) => candidate.instanceId === hallId);
    if (!hall) return { ok: false, message: 'That hall no longer exists.' };
    const cooling = context.registry.cooling(coolingId, 'player');
    return operator.orderRetrofit(context, hall, cooling)
      ? { ok: true, message: `Retrofitted to ${cooling.name}.` }
      : { ok: false, message: 'Not enough available cash for that retrofit.' };
  }

  if (kind === 'power') {
    const definitionId = rest[0] ?? '';
    const mw = Number(rest[1] ?? '0');
    const definition = context.registry.power(definitionId, 'player');
    return operator.orderPower(context, definitionId, mw)
      ? { ok: true, message: `${mw} MW of ${definition.name} ordered.` }
      : { ok: false, message: 'Not enough available cash for that power order.' };
  }

  return { ok: false, message: `Unknown action "${actionId}".` };
}
