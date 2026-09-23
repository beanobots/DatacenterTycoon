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
import {
  freeSpecialists, researchBlocker, researchCostUsd, startResearch, totalSpecialists,
} from './systems/research.js';
import { installedItMw } from './report.js';
import { probeCapacity, requiredHeadroom } from './capacity.js';
import { thermalOutlook } from './thermal-outlook.js';
import { currentRackOutput, groupRackOutput } from './era.js';
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
  /** Total budget, funded over the project's duration rather than up front. */
  readonly costUsd: number;
  /** Dollars per day while it runs, which is what the balance actually feels. */
  readonly costPerDay: number;
  readonly durationDays: number;
  readonly specialists: number;
  readonly freeSpecialists: number;
  readonly totalSpecialists: number;
  /** Calendar year it becomes researchable; may be in the future. */
  readonly availableFromYear: number;
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

/** A hall this hardware could go into, and how much of it is free. */
export interface HallSlot {
  readonly hallId: string;
  readonly name: string;
  /** Rack slots free in this hall. */
  readonly freeSlots: number;
  readonly racksInstalled: number;
  readonly rackCapacity: number;
  readonly cooling: string;
  /** False when this hall's cooling cannot carry this hardware's density. */
  readonly canCool: boolean;
  /** Why not, when it cannot. */
  readonly blocked?: string;
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
  /**
   * Every hall, whether or not it can take this hardware. Ordering racks used
   * to fill whichever hall came first, so a second hall could not be filled
   * and specific halls could not be specialised at all.
   */
  readonly halls: readonly HallSlot[];
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

/** Ending a contract early rather than breaching it for the rest of its term. */
export interface DropContractAction extends PlayerActionBase {
  readonly kind: 'contract.drop';
  readonly contractId: string;
  readonly workload: string;
  readonly computeUnits: number;
  readonly monthsLeft: number;
  readonly reputationLoss: number;
  /** Availability delivered over the last SLA period, 0-1. */
  readonly availability01: number;
  /** Penalties this contract cost last month. */
  readonly lastPenalty: number;
}

/** Taking racks off the floor before their design life, to free the space. */
export interface RetireHardwareAction extends PlayerActionBase {
  readonly kind: 'hardware.retire';
  readonly groupId: string;
  readonly hallId: string;
  readonly hardwareId: string;
  readonly racks: number;
  readonly ageYears: number;
  readonly resale: number;
}

/** Decommissioning a power asset. */
export interface RetirePowerAction extends PlayerActionBase {
  readonly kind: 'power.retire';
  readonly assetId: string;
  readonly definitionId: string;
  readonly mw: number;
  readonly salvage: number;
}

export type PlayerAction =
  | ResearchAction | ContractAction | HardwareAction | HallAction | RetrofitAction | PowerAction
  | DropContractAction | RetireHardwareAction | RetirePowerAction;

export interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
}

/** Hall sizes offered when building. Modular expansion, per chapter 4. */
const HALL_SIZES = [60, 120, 220];
/**
 * Rack order sizes offered. Each divides the 60- and 120-rack halls exactly,
 * so a hall can be filled in whole clicks rather than left with a remainder
 * the player has to reach with "fill".
 */
export const RACK_ORDER_SIZES = [15, 30, 60];
/** Hall token meaning "wherever there is room", the old placement behaviour. */
export const ANY_HALL = 'any';
/**
 * How far ahead an unavailable technology is still worth listing. Three years
 * is about one build cycle: long enough to be a reason to wait, short enough
 * that the list stays a menu rather than a catalogue.
 */
const RESEARCH_PREVIEW_YEARS = 3;
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
  // Commissioned halls, needed from the contract section onward: the thermal
  // outlook on an offer depends on them just as much as a rack order does.
  const halls = context.state.facilities.flatMap((facility) => facility.halls)
    .filter((hall) => hall.constructionProgress01 >= 1);
  const cash = context.state.company.cash;
  const budget = operator.budget(context);

  // ------------------------------------------------------------- research
  // Several projects run at once, so the list is offered whether or not
  // something is already under way. What limits it is specialists and cash.
  const speed = Math.max(0.1, context.modifiers.value('research.speed', 1));
  const free = freeSpecialists(context);
  const bench = totalSpecialists(context);

  for (const technology of context.registry.all('technologies').values()) {
    if (context.state.research.completed.includes(technology.id)) continue;
    if (context.state.research.active.some((p) => p.technologyId === technology.id)) continue;

    // Prerequisites are a hard gate; everything else is reported so the player
    // can see what a project would need rather than wondering where it went.
    const missing = technology.prerequisites
      .filter((id) => !context.state.research.completed.includes(id));
    if (missing.length > 0) continue;

    // A technology the decade has not reached yet is shown while it is close,
    // so the player can plan around it, and hidden while it is distant. The
    // whole 2030s catalogue listed in 2006 is noise, but "immersion cooling
    // arrives in 2014" is a reason to wait rather than build.
    const yearsAway = technology.availableFromYear - context.state.meta.campaignYear;
    if (yearsAway > RESEARCH_PREVIEW_YEARS) continue;

    const days = Math.max(1, Math.round(technology.research.durationDays / speed));
    // Quoted in the money of the year it would be run in, not in 2025 dollars.
    const budgetUsd = researchCostUsd(context, technology);
    const costPerDay = budgetUsd / days;
    const blocker = researchBlocker(context, technology.id);

    actions.push({
      kind: 'research.start',
      id: `research:${technology.id}`,
      category: 'research',
      label: technology.name,
      detail: `${technology.description ?? ''} Tier ${technology.tier} ${technology.branch}. `
        + `${money(budgetUsd)} funded over ${days} days `
        + `(${money(costPerDay)}/day), ${technology.research.requiredSpecialists} specialists.`
        + (yearsAway > 0
          ? ` Arrives ${technology.availableFromYear}, in ${yearsAway} year`
            + `${yearsAway === 1 ? '' : 's'}.`
          : ''),
      tradeOff: technology.tradeOff,
      cost: budgetUsd,
      // Research is funded day by day, so what matters is whether the daily
      // draw is sustainable, not whether the whole budget is on the balance.
      affordable: context.state.company.cash > costPerDay * 30,
      blocked: blocker ?? undefined,
      technologyId: technology.id,
      branch: technology.branch,
      tier: technology.tier,
      costUsd: budgetUsd,
      costPerDay,
      durationDays: days,
      specialists: technology.research.requiredSpecialists,
      freeSpecialists: free,
      totalSpecialists: bench,
      availableFromYear: technology.availableFromYear,
    });
  }

  // ------------------------------------------------------------ contracts
  // One allocation pass answers every offer: the existing book is placed on
  // the fleet exactly as the allocation step places it, at each contract's own
  // peak hour, and what is left is what can still be sold.
  const probe = probeCapacity(context);

  // Thermal exposure is a property of the fleet, not of an offer, so it is
  // worked out once and said against every commitment it would threaten. A
  // hall that runs out of cooling for part of the year cannot hold an
  // availability above what the heat leaves it, however many racks are free -
  // and the player has to hear that BEFORE signing, not from a breach in July.
  const exposed = halls
    .map((hall) => ({ hall, outlook: thermalOutlook(context, hall) }))
    .filter((entry) => entry.outlook.share01 > 0.0005)
    .sort((a, b) => b.outlook.share01 - a.outlook.share01);
  const thermalCeiling01 = 1 - (exposed[0]?.outlook.share01 ?? 0);

  // Gathered rather than pushed straight onto the deck, so the board can be
  // ordered before the player reads it.
  const offers: ContractAction[] = [];
  for (const offer of context.state.contractOffers) {
    const definition = context.registry.contract(offer.definitionId, offer.instanceId);
    const workload = context.registry.workload(definition.workloadId, definition.id);
    const capacity = probe.forWorkload(workload.id);
    const servable = capacity.totalUnits;
    const reserved = capacity.claimedContractUnits;
    // What fits depends on the availability this offer is buying: a 99.9%
    // commitment needs half again the spare capacity a 98% one does.
    // The availability THIS offer asks for, which the era negotiates down in
    // earlier decades - not the archetype's modern figure.
    const promised01 = offer.slaUptime01;
    const headroom = capacity.fittingUnits(promised01);
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
    const roomFor = offer.computeUnits <= free;
    const shortBy = Math.max(0, offer.computeUnits - free);
    // Said plainly on every offer, because the peak is where the SLA is
    // measured and a player sizing against the mean will breach every evening.
    const spare = requiredHeadroom(promised01);
    const atPeak = offer.computeUnits * capacity.peakShape * spare;
    const peakNote = ` Holding ${(promised01 * 100).toFixed(2)}% needs `
      + `${Math.round(atPeak).toLocaleString()} units of capacity free at the busiest hour`
      + (capacity.peakShape > 1.02
        ? ` - ${workload.name} peaks at ${capacity.peakShape.toFixed(2)}x its average, `
          + `and demand varies around that.`
        : ', because demand varies around its average.');

    // Capacity is only half of a commitment. The other half is whether the
    // cooling can hold through the year's hot hours at all.
    const thermalHolds = promised01 <= thermalCeiling01;
    const worstHall = exposed[0];
    const thermalNote = worstHall && !thermalHolds
      ? ` ${hallName(worstHall.hall)} runs out of cooling above `
        + `${worstHall.outlook.ceilingC.toFixed(0)} \u00b0C, and this site is above that for about `
        + `${Math.round(worstHall.outlook.hoursAbovePerYear)} hours a year - so the fleet cannot `
        + `hold better than ${(thermalCeiling01 * 100).toFixed(2)}% against this contract's `
        + `${(promised01 * 100).toFixed(2)}%. Retrofit denser cooling first.`
      : worstHall
        ? ` ${hallName(worstHall.hall)} loses about `
          + `${Math.round(worstHall.outlook.hoursAbovePerYear)} hours a year to heat, which this `
          + 'SLA has room for.'
        : '';

    // "Fits" has to mean the commitment can be kept, not merely that racks are
    // free. Reporting capacity alone is what produced a fit claim followed by
    // breaches every summer.
    const fits = roomFor && thermalHolds;

    offers.push({
      kind: 'contract.sign',
      id: `contract:${offer.instanceId}`,
      category: 'contracts',
      label: definition.name,
      detail: `${offer.computeUnits.toLocaleString()} compute units of ${workload.name} for `
        + `${offer.termMonths} months at $${offer.pricePerComputeUnitHour.toFixed(4)}/unit-hour `
        + `(${money(annualRevenue)}/year). SLA ${(promised01 * 100).toFixed(2)}%.`,
      // The fit is stated either way. Warning only on an oversell leaves the
      // player guessing on every offer that does fit, which is the same
      // arithmetic by hand.
      tradeOff: fits
        ? `Fits: you have room for ${Math.round(free).toLocaleString()} units of ${workload.name} and `
          + `this takes ${offer.computeUnits.toLocaleString()}, leaving `
          + `${Math.round(free - offer.computeUnits).toLocaleString()}. `
          + `${workload.penaltyClass === 'extreme' ? 'Extreme' : 'Standard'} penalties if you miss the SLA.`
          + peakNote + thermalNote
        // Zero servable capacity is a different problem from too little of it,
        // and the fix is different too: no quantity of the racks already on the
        // floor will serve a workload they are not compatible with. Naming the
        // families is the difference between a solvable position and a mystery
        // run of breaches.
        : servable <= 0
          ? `Nothing in your fleet can run ${workload.name}. It needs `
            + `${workload.compatibleFamilies.join(' or ')} racks; buying more of what you have will `
            + 'not serve a single unit of this, and every unit unserved is an SLA breach.'
          // Racks but no cooling is its own answer: adding capacity does not
          // help, and that distinction is the whole complaint.
          : roomFor
            ? `You have the racks - ${Math.round(free).toLocaleString()} units of ${workload.name} `
              + `free against ${offer.computeUnits.toLocaleString()} wanted - but not the cooling.`
              + thermalNote
            : `Oversells by ${Math.round(shortBy).toLocaleString()} units: you have room for `
              + `${Math.round(free).toLocaleString()} of ${workload.name} and this wants `
              + `${offer.computeUnits.toLocaleString()}. Unserved units are SLA breaches.`
              + peakNote + thermalNote,
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

  // The offer board is read top-down, so what can actually be signed belongs
  // at the top. Beneath that it is ordered on the rate, not the headline
  // value: a large contract at a poor rate ties up the same racks for longer
  // and is the easier mistake to make. Blocked offers - reputation or
  // technology short - sink below the rest whatever they pay, because nothing
  // about the price makes them signable today.
  const rate = (a: ContractAction) => a.annualRevenue / Math.max(1, a.computeUnits);
  offers.sort((a, b) =>
    Number(!!a.blocked) - Number(!!b.blocked)
    || Number(b.fits) - Number(a.fits)
    || rate(b) - rate(a)
    || a.label.localeCompare(b.label));
  actions.push(...offers);

  // --------------------------------------------------------- live contracts
  // A signed contract you cannot serve is the most expensive thing an operator
  // can own, and until now there was no way off one. Exiting costs real money
  // and real standing, which is the point: it has to be worse than serving the
  // contract and better than breaching it every month until the term ends.
  for (const contract of context.state.contracts) {
    const definition = context.registry.contract(contract.definitionId, contract.instanceId);
    const workload = context.registry.workload(definition.workloadId, definition.id);
    const quote = operator.quoteContractExit(context, contract);
    const last = contract.lastPeriod;
    const availability = last ? last.availability01 : 1;
    const missing = last !== undefined && last.availability01 < last.required01;

    actions.push({
      kind: 'contract.drop',
      id: `drop:${contract.instanceId}`,
      category: 'contracts',
      label: `End ${definition.name}`,
      detail: `${contract.computeUnits.toLocaleString()} units of ${workload.name}, `
        + `${quote.monthsLeft.toFixed(0)} months left. `
        + (last
          ? `Last month it served ${(availability * 100).toFixed(1)}% against `
            + `${(last.required01 * 100).toFixed(2)}%`
            + (last.penalty > 0 ? `, costing ${money(last.penalty)} in penalties.` : '.')
          : 'It has not been through an SLA period yet.'),
      tradeOff: `Exit fee ${money(quote.fee)} - three months of its revenue - and `
        + `${quote.reputationLoss.toFixed(1)} reputation. `
        + (missing
          ? 'Keeping it costs penalties and reputation every month it is missed.'
          : 'This one is being served; ending it gives up the revenue for nothing.'),
      cost: quote.fee,
      affordable: context.state.company.cash >= quote.fee,
      contractId: contract.instanceId,
      workload: workload.name,
      computeUnits: contract.computeUnits,
      monthsLeft: quote.monthsLeft,
      reputationLoss: quote.reputationLoss,
      availability01: availability,
      lastPenalty: last ? last.penalty : 0,
    });
  }

  // ------------------------------------------------------------- hardware
  const unlockedHardware = ['hardware.cpu.gen1', ...context.state.research.unlockedHardware];

  for (const hardwareId of [...new Set(unlockedHardware)]) {
    const hardware = context.registry.hardware(hardwareId, 'player');
    const rackKw = currentRackOutput(context, hardware).powerKw;
    const costPerRack = operator.rackPrice(context, hardware);

    // Every hall is listed, so the player can see where this hardware can go
    // and put it there. Space only counts in halls whose cooling can carry the
    // density, but a hall that cannot is shown with the reason rather than
    // silently left out.
    let space = 0;
    const hallSlots: HallSlot[] = halls.map((hall) => {
      const ceiling = operator.coolingCeilingKw(context, hall);
      const canCool = ceiling >= hardware.requiredCoolingKwPerRack;
      const installed = hall.rackGroups.reduce((total, group) => total + group.count, 0);
      const freeSlots = Math.max(0, hall.rackCapacity - installed);
      if (canCool) space += freeSlots;
      return {
        hallId: hall.instanceId,
        name: hallName(hall),
        freeSlots,
        racksInstalled: installed,
        rackCapacity: hall.rackCapacity,
        cooling: context.registry.cooling(hall.coolingId, hall.instanceId).name,
        canCool,
        ...(canCool
          ? freeSlots <= 0 ? { blocked: 'Full.' } : {}
          : {
            blocked: `Cools ${ceiling.toFixed(1)} kW/rack; this needs `
              + `${hardware.requiredCoolingKwPerRack} kW/rack.`,
          }),
      };
    });

    actions.push({
      kind: 'hardware.buy',
      id: `hardware:${ANY_HALL}:${hardwareId}`,
      category: 'capacity',
      label: hardware.name,
      detail: `${money(costPerRack)} per rack, ${rackKw.toFixed(1)} kW each, `
        + `${Math.round(currentRackOutput(context, hardware).computeUnits).toLocaleString()} compute units. `
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
      computePerRack: currentRackOutput(context, hardware).computeUnits,
      halls: hallSlots,
    });
  }

  // --------------------------------------------------------- retiring racks
  // Halls fill up, and a full hall cannot change what it runs. Taking a group
  // off the floor early returns the space, the cooling and part of the capital
  // - and it is the only way to switch a running hall onto different hardware
  // without building another one.
  for (const hall of halls) {
    for (const group of hall.rackGroups) {
      const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
      const ageYears = (context.state.meta.tickIndex - group.installedTick)
        * context.state.meta.minutesPerTick / (60 * 8766);
      const resale = operator.quoteRetireRacks(context, group, group.count);

      actions.push({
        kind: 'hardware.retire',
        id: `retire:${group.instanceId}`,
        category: 'capacity',
        label: `Retire ${group.count} \u00d7 ${hardware.name}`,
        detail: `In ${hallName(hall)}, ${ageYears.toFixed(1)} years old, `
          + `condition ${Math.round(group.condition01 * 100)}%. `
          + `Returns ${money(resale)} and ${group.count} rack slots.`,
        tradeOff: `Loses ${Math.round(group.count
          * groupRackOutput(context, group).computeUnits).toLocaleString()} compute units immediately. `
          + 'Anything sold against them breaches until the replacements are in.',
        // Retiring pays rather than costs, so nothing gates it on the budget.
        cost: 0,
        affordable: true,
        groupId: group.instanceId,
        hallId: hall.instanceId,
        hardwareId: group.hardwareId,
        racks: group.count,
        ageYears,
        resale,
      });
    }
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

  // --------------------------------------------------- decommissioning power
  for (const facility of context.state.facilities) {
    for (const asset of facility.powerAssets) {
      const definition = context.registry.power(asset.definitionId, asset.instanceId);
      const salvage = operator.quotePowerExit(context, asset);
      const firm = definition.kind === 'import' || definition.dispatchability01 > 0.7;

      actions.push({
        kind: 'power.retire',
        id: `decommission:${asset.instanceId}`,
        category: 'power',
        label: `Decommission ${asset.capacityMw.toFixed(1)} MW \u00b7 ${definition.name}`,
        detail: `Condition ${Math.round(asset.condition01 * 100)}%. `
          + (salvage > 0 ? `Salvages ${money(salvage)}.` : 'An import connection salvages nothing.')
          + (definition.communityDeltaPerRunHour < 0
            ? ' Stops the community trust it costs for every hour it runs.'
            : ''),
        tradeOff: firm
          ? `Takes ${asset.capacityMw.toFixed(1)} MW of firm supply off the site. `
            + 'If what is left cannot carry the load, the halls go unserved.'
          : `Gives back ${(asset.capacityMw * definition.landHectaresPerMw).toFixed(1)} hectares, `
            + 'and the clean energy it was matching goes back on the grid\u2019s account.',
        cost: 0,
        affordable: true,
        assetId: asset.instanceId,
        definitionId: asset.definitionId,
        mw: asset.capacityMw,
        salvage,
      });
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
    const blocker = researchBlocker(context, technologyId);
    if (blocker) return { ok: false, message: blocker };
    const technology = context.registry.technology(technologyId, 'player');
    if (!startResearch(context, technologyId)) {
      return { ok: false, message: 'That project could not be started.' };
    }
    return {
      ok: true,
      message: `Started ${technology.name}. `
        + `${context.state.research.active.length} project`
        + `${context.state.research.active.length === 1 ? '' : 's'} under way.`,
    };
  }

  if (kind === 'contract') {
    const offerId = rest.join(':');
    return operator.signOffer(context, offerId)
      ? { ok: true, message: 'Contract signed.' }
      : { ok: false, message: 'That offer is no longer on the table.' };
  }

  if (kind === 'hardware') {
    // `hardware:<hallId>:<hardwareId>`, where a hall of ANY_HALL keeps the old
    // behaviour of filling whatever has room. Hardware IDs contain dots rather
    // than colons, so the hall is safe to take from the front.
    const target = rest[0] ?? ANY_HALL;
    const hardwareId = rest.slice(1).join(':');
    const hardware = context.registry.hardware(hardwareId, 'player');
    const cooled = context.state.facilities.flatMap((facility) => facility.halls)
      .filter((hall) => hall.constructionProgress01 >= 1
        && operator.coolingCeilingKw(context, hall) >= hardware.requiredCoolingKwPerRack);

    const halls = target === ANY_HALL
      ? cooled
      : cooled.filter((hall) => hall.instanceId === target);
    if (halls.length === 0) {
      const named = context.state.facilities.flatMap((facility) => facility.halls)
        .find((hall) => hall.instanceId === target);
      return {
        ok: false,
        message: named
          ? `${hallName(named)} cannot cool ${hardware.name} at `
            + `${hardware.requiredCoolingKwPerRack} kW/rack. Retrofit it first.`
          : 'No hall with cooling dense enough. Build or retrofit a hall first.',
      };
    }

    let remaining = Math.max(1, quantity);
    let installed = 0;
    for (const hall of halls) {
      if (remaining <= 0) break;
      const placed = operator.orderRacks(context, hall, hardware, remaining);
      installed += placed;
      remaining -= placed;
    }
    if (installed === 0) {
      return { ok: false, message: 'Could not order racks: no free slots there, or not enough cash.' };
    }
    const where = halls.length === 1 && halls[0] ? ` in ${hallName(halls[0])}` : '';
    return {
      ok: true,
      message: `Installed ${installed} racks of ${hardware.name}${where}.`
        + (remaining > 0 ? ` ${remaining} could not be placed.` : ''),
    };
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

  if (kind === 'drop') {
    const contractInstanceId = rest.join(':');
    const contract = context.state.contracts
      .find((candidate) => candidate.instanceId === contractInstanceId);
    if (!contract) return { ok: false, message: 'That contract has already ended.' };
    const definition = context.registry.contract(contract.definitionId, contract.instanceId);
    const quote = operator.quoteContractExit(context, contract);
    if (!operator.dropContract(context, contractInstanceId)) {
      return { ok: false, message: `Not enough cash for the ${money(quote.fee)} exit fee.` };
    }
    return {
      ok: true,
      message: `Ended ${definition.name}. Paid ${money(quote.fee)} and lost `
        + `${quote.reputationLoss.toFixed(1)} reputation.`,
    };
  }

  if (kind === 'retire') {
    const groupInstanceId = rest.join(':');
    const group = context.state.facilities
      .flatMap((facility) => facility.halls)
      .flatMap((hall) => hall.rackGroups)
      .find((candidate) => candidate.instanceId === groupInstanceId);
    if (!group) return { ok: false, message: 'Those racks are already gone.' };
    const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
    const racks = group.count;
    const resale = operator.retireRacks(context, groupInstanceId, racks);
    return {
      ok: true,
      message: `Retired ${racks} racks of ${hardware.name} for ${money(resale)}. `
        + `${racks} rack slots are free.`,
    };
  }

  if (kind === 'decommission') {
    const assetInstanceId = rest.join(':');
    const asset = context.state.facilities
      .flatMap((facility) => facility.powerAssets)
      .find((candidate) => candidate.instanceId === assetInstanceId);
    if (!asset) return { ok: false, message: 'That asset is already gone.' };
    const definition = context.registry.power(asset.definitionId, asset.instanceId);
    const mw = asset.capacityMw;
    const salvage = operator.retirePower(context, assetInstanceId);
    return {
      ok: true,
      message: `Decommissioned ${mw.toFixed(1)} MW of ${definition.name}`
        + (salvage > 0 ? `, salvaging ${money(salvage)}.` : '.'),
    };
  }

  return { ok: false, message: `Unknown action "${actionId}".` };
}
