/**
 * The operator policy: the decisions a player would make, made by code.
 *
 * A headless campaign needs someone to build halls, buy hardware, sign
 * contracts and choose research, or the pipeline runs against an empty site.
 * This is that someone. It is deliberately a strategy, not an optimiser: each
 * preset weights the same decisions differently, which is what lets the golden
 * scenarios check the chapter 14 assertions that no single choice dominates.
 *
 * Presentation and UI would replace this with player input; nothing else in the
 * simulation depends on it.
 */

import type { SimulationTick } from '../core/clock.js';
import { clamp01 } from '../core/math.js';
import type { ISimulationSystem, SimulationContext } from './context.js';
import { canStartResearch, researchCostUsd, startResearch } from './systems/research.js';
import { CRITICAL_TRUST } from './systems/community.js';
import { installedItMw } from './report.js';
import { probeCapacity } from './capacity.js';
import { currentRackOutput, eraFactors, fractionalYear, groupRackOutput } from './era.js';
import { thermalOutlook } from './thermal-outlook.js';
import type { CoolingTechnologyDefinition, HardwareDefinition } from '../definitions/types.js';
import { emptyShortfall } from '../state/types.js';
import type {
  ActiveContractState, HallState, PowerAssetState, RackGroupState,
} from '../state/types.js';

export type StrategyName = 'balanced' | 'green' | 'hyperscaler' | 'lean';

export interface StrategyWeights {
  /** How much of the cash balance may be committed to one build. */
  readonly capexAppetite01: number;
  /** Preference for low-carbon supply over cheap supply, 0-1. */
  readonly cleanPreference01: number;
  /** Preference for density over capital cost, 0-1. */
  readonly densityPreference01: number;
  /** Preference for water-light cooling beyond what the region forces, 0-1. */
  readonly waterCaution01: number;
  /** Cash buffer held back, as months of operating cost. */
  readonly reserveMonths: number;
  /** Research branch priority, highest first. */
  readonly researchPriority: readonly string[];
}

export const STRATEGIES: Record<StrategyName, StrategyWeights> = {
  balanced: {
    capexAppetite01: 0.35, cleanPreference01: 0.5, densityPreference01: 0.5, waterCaution01: 0.5,
    reserveMonths: 3,
    researchPriority: ['efficiency', 'cooling', 'hardware', 'operations', 'power', 'environment', 'grid', 'network', 'security', 'megaproject'],
  },
  green: {
    capexAppetite01: 0.30, cleanPreference01: 0.95, densityPreference01: 0.4, waterCaution01: 0.9,
    reserveMonths: 4,
    researchPriority: ['environment', 'power', 'grid', 'cooling', 'efficiency', 'operations', 'hardware', 'network', 'megaproject', 'security'],
  },
  hyperscaler: {
    capexAppetite01: 0.50, cleanPreference01: 0.35, densityPreference01: 0.95, waterCaution01: 0.3,
    reserveMonths: 2,
    researchPriority: ['hardware', 'cooling', 'network', 'efficiency', 'operations', 'power', 'grid', 'environment', 'security', 'megaproject'],
  },
  lean: {
    capexAppetite01: 0.22, cleanPreference01: 0.3, densityPreference01: 0.25, waterCaution01: 0.4,
    reserveMonths: 6,
    researchPriority: ['efficiency', 'operations', 'cooling', 'power', 'hardware', 'environment', 'grid', 'network', 'security', 'megaproject'],
  },
};

/** Largest hall shell the operator will build in one commitment. */
const MAX_OPENING_HALL_RACKS = 220;
/** Smallest hall worth building; below this the fixed costs dominate. */
const MIN_OPENING_HALL_RACKS = 60;
/** Share of the free balance a single hall commitment may consume. */
const MAX_HALL_SHARE_OF_BUDGET = 0.6;
/** The opening hall. Small enough to leave capital for racks and contracts. */
const OPENING_HALL_RACKS = 120;
/** Racks ordered in any one month. Procurement is not instantaneous. */
const RACK_ORDER_LIMIT = 60;
/** Share of an over-age rack group retired each month. */
export const RETIREMENT_SHARE_PER_MONTH = 0.25;

/**
 * Standing lost for walking away from a contract, by how hard its penalties
 * bite. A customer on an extreme-penalty workload talks about being dropped.
 */
const EXIT_REPUTATION_CLASS: Record<string, number> = {
  low: 0.6, medium: 1.0, high: 1.5, extreme: 2.4,
};

/**
 * Share of visible unserved demand the operator will build for before it has
 * won the work. Building for all of it fills the site with empty hall;
 * building for none of it is the trap that stopped the operator growing at
 * all once it learned not to oversell.
 */
const SPECULATIVE_BUILD_SHARE = 0.6;

/** Share of a power asset's original capital recovered on decommissioning. */
const POWER_SALVAGE_SHARE = 0.18;

/**
 * Share of the year a hall may lose to heat before its cooling is worth
 * replacing. Roughly 0.2% - about the gap between a 99.9% commitment and a
 * 99.7% one, which is the difference between the contracts worth having and
 * the rest.
 */
const THERMAL_CEILING_TOLERANCE = 0.002;
/** Premium for replacing cooling plant in a hall that is carrying live load. */
const RETROFIT_PREMIUM = 1.25;
/** Cooling capacity installed above the hall's design IT load. */
const COOLING_DESIGN_MARGIN = 1.25;
/** Share of a month's free capital the heuristic will commit to R&D. */
const RESEARCH_BUDGET_SHARE = 0.25;
/** Share of a workload's servable capacity the operator will commit. */
const WORKLOAD_CAPACITY_MARGIN = 0.85;
/** Debt an operator can carry, as a multiple of annual revenue at full standing. */
const DEBT_TO_REVENUE_CEILING = 2.5;
/** Purchases within this many ticks merge into one group, bounding group count. */
const GROUP_MERGE_TICKS = 90 * 24 * 4;

/**
 * The decisions a player can take over from the autopilot.
 *
 * Retirement and maintenance are absent on purpose: hardware reaching end of
 * life and plant needing repair are consequences, not choices, and the systems
 * that own them run regardless of who is deciding.
 */
export type DecisionCategory = 'research' | 'contracts' | 'capacity' | 'cooling' | 'power';

export const DECISION_CATEGORIES: readonly DecisionCategory[] =
  ['research', 'contracts', 'capacity', 'cooling', 'power'];

export type AutopilotState = Record<DecisionCategory, boolean>;

export function allAutopilot(enabled: boolean): AutopilotState {
  return {
    research: enabled, contracts: enabled, capacity: enabled, cooling: enabled, power: enabled,
  };
}

export class OperatorSystem implements ISimulationSystem {
  readonly name = 'operator';
  readonly order = 130;
  /**
   * Which decisions the heuristic still makes. A category switched off is the
   * player's: the autopilot stops acting on it and the action list offers it up
   * instead. Both paths run the same operations underneath, so a hall the
   * player builds costs and behaves exactly like one the autopilot builds.
   */
  private autopilot: AutopilotState;

  constructor(private readonly strategy: StrategyWeights, autopilot: AutopilotState = allAutopilot(true)) {
    this.autopilot = { ...autopilot };
  }

  setAutopilot(category: DecisionCategory, enabled: boolean): void {
    this.autopilot[category] = enabled;
  }

  autopilotState(): AutopilotState {
    return { ...this.autopilot };
  }

  strategyWeights(): StrategyWeights {
    return this.strategy;
  }

  initialize(context: SimulationContext): void {
    // Opening move: one hall, the best cooling available at the start, enough
    // racks to serve the first contracts, and a grid connection with diesel
    // standby. Everything after this is decided month by month.
    this.buildHall(context, 0, OPENING_HALL_RACKS);
    const facility = context.state.facilities[0];
    if (!facility) return;
    const hall = facility.halls[0];
    if (hall) {
      hall.constructionProgress01 = 1;
      hall.installedTick = 0;
      this.installRacks(context, hall, this.chooseHardware(context), Math.floor(OPENING_HALL_RACKS * 0.5));
    }
    // Size the opening interconnection to the first hall, not to the region's
    // whole capacity: an interconnection agreement is paid for by the megawatt,
    // and 60 MW of it serving a 1 MW hall is the most expensive idle asset an
    // operator can own. `investInPower` grows it as the load does.
    const openingMw = Math.max(0.5, (hall?.rackCapacity ?? OPENING_HALL_RACKS)
      * context.balance.baseRackPowerKw * eraFactors(context).rackPowerKw / 1000 * 1.8);
    this.buildPower(context, 'power.grid', Math.min(openingMw, context.region.grid.capacityMw), true);
    this.buildPower(context, 'power.diesel_backup', Math.max(1, openingMw * 0.3), true);

    // The opening hall, its racks and the grid connection are the starting
    // position, not a decision - a campaign that begins on bare land has no
    // operation to reason about. The first contract and the first research
    // project ARE decisions, so they are only made here for an autonomous
    // operator; a player is handed them on turn one.
    if (this.autopilot.contracts) this.signContracts(context, 0);
    if (this.autopilot.research) this.chooseResearch(context);
  }

  tick(tick: SimulationTick, context: SimulationContext): void {
    if (!tick.cadence.month) return;
    if (this.autopilot.research) this.chooseResearch(context);
    if (this.autopilot.contracts) this.signContracts(context, tick.index);
    // Contracts reaching term renew or lapse whoever is deciding: that is the
    // customer's call, not the operator's.
    else this.resolveExpiringContracts(context, tick.index);
    this.retireEndOfLife(context, tick);
    if (this.autopilot.cooling) this.retrofitCooling(context, tick);
    if (this.autopilot.capacity) this.expand(context, tick);
    if (this.autopilot.power) this.investInPower(context);
  }

  // ---------------------------------------------------------- operations
  /*
   * Everything below is the operations layer: the mechanics of running the
   * business, with no judgement about WHEN to do them. The heuristic above
   * calls these after deciding; a player calls the same ones through
   * src/sim/player.ts. Keeping one implementation is what guarantees a
   * player-built hall costs, ages and fails exactly like an autopilot-built
   * one - two code paths would drift, and the simulation would quietly start
   * treating the player differently.
   */

  /** Free cash the operator may commit this month. */
  budget(context: SimulationContext): number {
    return this.availableBudget(context);
  }

  /** Free cash after setting aside what the fleet needs to stay its size. */
  discretionary(context: SimulationContext): number {
    return this.discretionaryBudget(context);
  }

  /** Price of one rack of this hardware, including any technology effects. */
  rackPrice(context: SimulationContext, hardware: HardwareDefinition): number {
    return context.balance.baseRackPurchaseCost * hardware.purchaseFactor
      * context.modifiers.value('hardware.purchaseCost', 1);
  }

  /** Price of a hall shell of `racks` capacity with this cooling technology. */
  priceHall(context: SimulationContext, racks: number, cooling: CoolingTechnologyDefinition): number {
    return this.hallCost(context, racks, cooling);
  }

  /** Price of `mw` of a power source. */
  pricePower(context: SimulationContext, definitionId: string, mw: number): number {
    return this.powerCost(context, definitionId, mw);
  }

  /** Price of re-plumbing a hall to a different cooling technology. */
  priceRetrofit(context: SimulationContext, hall: HallState, cooling: CoolingTechnologyDefinition): number {
    const current = context.registry.cooling(hall.coolingId, hall.instanceId);
    const capacityMw = this.requiredCoolingKw(context, hall) / 1000;
    const newPlant = capacityMw * context.balance.baseCoolingCapexPerMw * cooling.capexFactor;
    const oldResidual = (hall.ratedCoolingKw / 1000)
      * context.balance.baseCoolingCapexPerMw * current.capexFactor * hall.condition01 * 0.4;
    return Math.max(newPlant * 0.25, newPlant - oldResidual) * RETROFIT_PREMIUM;
  }

  /** Rack power this hall's cooling can serve, kW. */
  coolingCeilingKw(context: SimulationContext, hall: HallState): number {
    return context.registry.cooling(hall.coolingId, hall.instanceId).densityKwPerRack
      * context.modifiers.value('cooling.densityKwPerRack', 1);
  }

  /** Orders racks into a hall. Returns how many were actually installed. */
  orderRacks(context: SimulationContext, hall: HallState, hardware: HardwareDefinition, count: number): number {
    const installed = hall.rackGroups.reduce((total, group) => total + group.count, 0);
    const space = Math.max(0, hall.rackCapacity - installed);
    const wanted = Math.min(count, space);
    if (wanted <= 0) return 0;
    const price = this.rackPrice(context, hardware);
    if (!this.commit(context, wanted * price, context.state.meta.tickIndex)) return 0;
    this.installRacks(context, hall, hardware, wanted);
    context.diagnostic('build.racks',
      `Installed ${wanted} racks of ${hardware.name} in hall ${hall.instanceId}`,
      { tick: context.state.meta.tickIndex, hardwareId: hardware.id, racks: wanted });
    return wanted;
  }

  /** Starts construction of a hall shell. Returns false if it was not affordable. */
  orderHall(context: SimulationContext, racks: number, cooling: CoolingTechnologyDefinition): boolean {
    const cost = this.hallCost(context, racks, cooling);
    if (!this.commit(context, cost, context.state.meta.tickIndex)) return false;
    this.buildHall(context, context.state.meta.tickIndex, racks, cooling);
    context.diagnostic('build.hall', `Started construction of a ${racks}-rack hall`, {
      tick: context.state.meta.tickIndex, racks, cooling: cooling.id, cost: Math.round(cost),
    });
    return true;
  }

  /** Re-plumbs a hall to a different cooling technology. */
  orderRetrofit(context: SimulationContext, hall: HallState, cooling: CoolingTechnologyDefinition): boolean {
    const current = context.registry.cooling(hall.coolingId, hall.instanceId);
    const cost = this.priceRetrofit(context, hall, cooling);
    if (!this.commit(context, cost, context.state.meta.tickIndex)) return false;

    hall.coolingId = cooling.id;
    hall.ratedCoolingKw = Math.max(hall.ratedCoolingKw, this.requiredCoolingKw(context, hall));
    hall.condition01 = Math.min(1, hall.condition01 * 0.5 + 0.5);
    hall.coolingFailed = false;
    context.diagnostic('build.retrofit',
      `Retrofitted hall ${hall.instanceId} from ${current.name} to ${cooling.name}`,
      {
        tick: context.state.meta.tickIndex, from: current.id, to: cooling.id,
        cost: Math.round(cost), ratedCoolingKw: Math.round(hall.ratedCoolingKw),
      });
    return true;
  }

  /** Commissions power capacity. Grid import is available immediately. */
  orderPower(context: SimulationContext, definitionId: string, mw: number): boolean {
    const before = context.state.facilities[0]?.powerAssets.length ?? 0;
    const beforeMw = this.installedPowerMw(context, definitionId);
    this.buildPower(context, definitionId, mw, definitionId === 'power.grid');
    const after = context.state.facilities[0]?.powerAssets.length ?? 0;
    return after > before || this.installedPowerMw(context, definitionId) > beforeMw;
  }

  private installedPowerMw(context: SimulationContext, definitionId: string): number {
    let mw = 0;
    for (const facility of context.state.facilities) {
      for (const asset of facility.powerAssets) {
        if (asset.definitionId === definitionId) mw += asset.capacityMw;
      }
    }
    return mw;
  }

  /** Signs a specific offer from the contract market. */
  signOffer(context: SimulationContext, offerInstanceId: string): boolean {
    const state = context.state;
    const offer = state.contractOffers.find((candidate) => candidate.instanceId === offerInstanceId);
    if (!offer) return false;
    const definition = context.registry.contract(offer.definitionId, offer.instanceId);

    state.contracts.push({
      instanceId: `contract.${offer.instanceId}`,
      definitionId: offer.definitionId,
      computeUnits: offer.computeUnits,
      pricePerComputeUnitHour: offer.pricePerComputeUnitHour,
      termMonths: offer.termMonths,
      startTick: state.meta.tickIndex,
      endTick: state.meta.tickIndex + context.clock.ticksForDays(offer.termMonths * 30.44),
      demandedUnitHours: 0, servedUnitHours: 0,
      lifetimeDemandedUnitHours: 0, lifetimeServedUnitHours: 0,
      revenueThisPeriod: 0, contractedRevenueThisPeriod: 0, penaltiesThisPeriod: 0, backlogUnitHours: 0, shortfall: emptyShortfall(),
    });
    state.contractOffers = state.contractOffers.filter((c) => c.instanceId !== offerInstanceId);
    context.diagnostic('contract.signed', `Signed ${definition.name}`, {
      tick: state.meta.tickIndex, contractId: definition.id, computeUnits: offer.computeUnits,
      pricePerComputeUnitHour: Number(offer.pricePerComputeUnitHour.toFixed(4)),
      termMonths: offer.termMonths,
    });
    return true;
  }

  /** Compute units the fleet can deliver for a workload, exposed for the UI. */
  servableFor(context: SimulationContext, workloadId: string): number {
    return probeCapacity(context).forWorkload(workloadId).totalUnits;
  }

  /**
   * Compute units already claimed on racks this workload could have used.
   *
   * Not "contracts signed for this workload": a rack sold as archive is gone
   * whether or not the thing that took it was archive, and reporting only
   * same-workload reservations is what let the fleet be sold several times.
   */
  reservedFor(context: SimulationContext, workloadId: string): number {
    return probeCapacity(context).forWorkload(workloadId).claimedContractUnits;
  }

  /** What could still be sold as this workload, margin and peak hour included. */
  freeContractUnitsFor(context: SimulationContext, workloadId: string): number {
    return probeCapacity(context).forWorkload(workloadId).freeContractUnits;
  }

  // -------------------------------------------------------------- research
  /**
   * Starts research, in branch priority order, until the specialists run out.
   *
   * Projects run concurrently, so the heuristic fills its bench rather than
   * queueing one at a time - but only with what the discretionary budget can
   * keep funded, since a stalled project holds specialists without producing
   * anything.
   */
  private chooseResearch(context: SimulationContext): void {
    for (;;) {
      const budget = this.discretionaryBudget(context);
      const available = [...context.registry.all('technologies').values()]
        .filter((tech) => canStartResearch(context, tech.id))
        // Only take on what a year of free capital could actually fund.
        .filter((tech) => researchCostUsd(context, tech) <= budget * RESEARCH_BUDGET_SHARE * 12)
        .sort((a, b) => {
          const priorityA = this.strategy.researchPriority.indexOf(a.branch);
          const priorityB = this.strategy.researchPriority.indexOf(b.branch);
          return priorityA - priorityB || a.tier - b.tier
            || a.research.costUsd - b.research.costUsd || a.id.localeCompare(b.id);
        });
      const chosen = available[0];
      if (!chosen || !startResearch(context, chosen.id)) return;
    }
  }

  // -------------------------------------------------------------- contracts
  /**
   * Bids on the contract market. The operator signs what it can serve with the
   * capacity it already has: bidding for work it cannot deliver buys penalties,
   * not revenue.
   */
  private signContracts(context: SimulationContext, tick: number): void {
    const state = context.state;
    let unitsLeft = this.spareComputeUnits(context);

    const offers = [...state.contractOffers]
      .filter((offer) => {
        const definition = context.registry.contract(offer.definitionId, offer.instanceId);
        if (definition.minimumReputation > state.company.reputation) return false;
        if (!definition.requiredTechnologies.every((id) => state.research.completed.includes(id))) return false;
        return this.canServe(context, definition.workloadId);
      })
      // Best price first, so limited capacity goes to the most valuable work.
      .sort((a, b) => b.pricePerComputeUnitHour - a.pricePerComputeUnitHour
        || a.instanceId.localeCompare(b.instanceId));

    const taken = new Set<string>();
    // Re-probed after every signature: capacity is shared between workloads, so
    // taking an archive contract genuinely reduces what can be sold as
    // streaming. Tracking reservations per workload - as this did - let the
    // heuristic sell the same CPU rack to six different tenants.
    let probe = probeCapacity(context);
    for (const offer of offers) {
      if (offer.computeUnits > unitsLeft) continue;
      const definition = context.registry.contract(offer.definitionId, offer.instanceId);

      if (offer.computeUnits > probe.forWorkload(definition.workloadId).freeContractUnits) continue;
      state.contracts.push({
        instanceId: `contract.${offer.instanceId}`,
        definitionId: offer.definitionId,
        computeUnits: offer.computeUnits,
        pricePerComputeUnitHour: offer.pricePerComputeUnitHour,
        termMonths: offer.termMonths,
        startTick: tick,
        endTick: tick + context.clock.ticksForDays(offer.termMonths * 30.44),
        demandedUnitHours: 0, servedUnitHours: 0,
        lifetimeDemandedUnitHours: 0, lifetimeServedUnitHours: 0,
        revenueThisPeriod: 0, contractedRevenueThisPeriod: 0, penaltiesThisPeriod: 0, backlogUnitHours: 0, shortfall: emptyShortfall(),
      });
      unitsLeft -= offer.computeUnits;
      taken.add(offer.instanceId);
      probe = probeCapacity(context);
      context.diagnostic('contract.signed', `Signed ${definition.name}`, {
        tick, contractId: definition.id, computeUnits: offer.computeUnits,
        pricePerComputeUnitHour: Number(offer.pricePerComputeUnitHour.toFixed(4)),
        termMonths: offer.termMonths,
      });
    }
    state.contractOffers = state.contractOffers.filter((offer) => !taken.has(offer.instanceId));

    this.resolveExpiringContracts(context, tick);
  }

  /**
   * Contracts that reach term either renew on their existing commercial terms
   * or leave the book. Delivering the SLA is what makes renewal likely.
   */
  private resolveExpiringContracts(context: SimulationContext, tick: number): void {
    const stream = context.streams.get('market');
    context.state.contracts = context.state.contracts.filter((contract) => {
      if (tick < contract.endTick) return true;
      const definition = context.registry.contract(contract.definitionId, contract.instanceId);
      const availability = contract.lifetimeDemandedUnitHours > 0
        ? contract.lifetimeServedUnitHours / contract.lifetimeDemandedUnitHours
        : 1;
      const renewChance = clamp01(
        definition.renewalProbability01 * (availability >= definition.slaUptime01 ? 1 : 0.35),
      );
      if (stream.chance(renewChance)) {
        contract.endTick = tick + context.clock.ticksForDays(contract.termMonths * 30.44);
        context.state.company.reputation = Math.min(100,
          context.state.company.reputation + definition.reputationOnCompletion * 0.25);
        return true;
      }
      context.diagnostic('contract.ended', `${definition.name} was not renewed`, { tick, contractId: definition.id });
      return false;
    });
  }

  /**
   * Contracted units of work currently offered for this workload that the
   * fleet has no room for.
   *
   * Measured against the same capacity probe the signing decision uses, so
   * the operator builds for demand it would actually be able to win rather
   * than for every line on the market.
   */
  private unservedOpportunity(context: SimulationContext, workloadId: string): number {
    const state = context.state;
    const free = probeCapacity(context).forWorkload(workloadId).freeContractUnits;
    let wanted = 0;
    for (const offer of state.contractOffers) {
      const definition = context.registry.contract(offer.definitionId, offer.instanceId);
      if (definition.workloadId !== workloadId) continue;
      if (definition.minimumReputation > state.company.reputation) continue;
      if (!definition.requiredTechnologies.every((id) => state.research.completed.includes(id))) continue;
      wanted += offer.computeUnits;
    }
    return Math.max(0, wanted - free);
  }

  /** True when some installed hardware family can serve this workload. */
  private canServe(context: SimulationContext, workloadId: string): boolean {
    const workload = context.registry.workload(workloadId);
    for (const facility of context.state.facilities) {
      for (const hall of facility.halls) {
        for (const group of hall.rackGroups) {
          const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
          if (workload.compatibleFamilies.includes(hardware.family)
            && (hardware.workloadAffinity[workloadId] ?? 0) > 0.3) return true;
        }
      }
    }
    return false;
  }

  private spareComputeUnits(context: SimulationContext): number {
    let installed = 0;
    for (const facility of context.state.facilities) {
      for (const hall of facility.halls) {
        for (const group of hall.rackGroups) {
          installed += group.count * groupRackOutput(context, group).computeUnits;
        }
      }
    }
    const committed = context.state.contracts.reduce(
      (total, contract) => total + contract.computeUnits, 0);
    return Math.max(0, installed * 0.9 - committed);
  }

  // ---------------------------------------------------------------- capacity
  /**
   * Capacity planning is demand-led, not utilisation-led. The operator looks at
   * the contracts it is eligible to win but cannot serve, and builds toward
   * them - bounded by the scenario's target capacity, the region's
   * interconnection limit, community trust and the strategy's cash appetite.
   *
   * Utilisation alone would deadlock: contracts are only signed against spare
   * capacity, so capacity that only grows when utilisation is high never grows.
   */
  private expand(context: SimulationContext, tick: SimulationTick): void {
    const state = context.state;
    if (state.gateFlags.includes('gate.community_trust')) return;
    if (state.company.communityTrust <= CRITICAL_TRUST) return;

    // Size the order in the SAME capacity terms the contract book is limited
    // by. Counting raw compute units here while `signContracts` counts
    // affinity-weighted units lets the operator conclude it has ample capacity
    // while being unable to serve the work it has already sold.
    const target = this.mostUnderservedWorkload(context);
    const hardware = this.bestHardwareFor(context, target);
    const affinity = hardware.workloadAffinity[target] ?? 0;
    if (affinity <= 0) return;

    const rackCost = context.balance.baseRackPurchaseCost * hardware.purchaseFactor
      * context.modifiers.value('hardware.purchaseCost', 1);
    const unitsPerRack = currentRackOutput(context, hardware).computeUnits * affinity;
    if (unitsPerRack <= 0) return;

    const deficit = this.reservedUnits(context, target) / WORKLOAD_CAPACITY_MARGIN
      - this.servableUnits(context, target);

    // Work on the table that the fleet cannot take.
    //
    // Without this the operator never grows. The deficit above is measured
    // against what it has already SOLD, and it will not sell beyond what it
    // can serve - so the deficit sits at zero for ever and the only racks it
    // ever buys are replacements for the ones wearing out. Real growth comes
    // from building for demand you have not signed yet, which is the whole
    // bet a data centre operator makes.
    const opportunity = this.unservedOpportunity(context, target);
    // Replacement is not netted against the deficit. The deficit is measured
    // for ONE workload, so a surplus there would otherwise cancel the whole
    // fleet's replacement need and the operator would watch its racks retire
    // without ordering any.
    const replacement = this.racksNearingRetirement(context);
    // Only a share of the visible opportunity, and weighted by appetite: an
    // operator that builds for every offer it can see builds a lot of empty
    // hall.
    const speculative = opportunity * SPECULATIVE_BUILD_SHARE
      * (0.5 + this.strategy.capexAppetite01);
    const racksWanted = Math.max(
      Math.ceil((deficit + speculative) / unitsPerRack),
      Math.ceil(replacement),
    );
    if (racksWanted <= 0) return;

    // Fill existing halls first: racks are cheaper than shells, they commission
    // as soon as they are paid for, and they are the asset that earns.
    let spaceAvailable = false;
    for (const facility of state.facilities) {
      for (const hall of facility.halls) {
        if (hall.constructionProgress01 < 1) continue;
        const installed = hall.rackGroups.reduce((total, g) => total + g.count, 0);
        const space = hall.rackCapacity - installed;
        if (space <= 0) continue;
        spaceAvailable = true;

        const wanted = Math.min(space, racksWanted, RACK_ORDER_LIMIT);
        const affordable = Math.floor(this.availableBudget(context) / Math.max(1, rackCost));
        const toInstall = Math.min(wanted, Math.max(affordable, 0));
        if (toInstall <= 0) continue;
        if (!this.commit(context, toInstall * rackCost, tick.index)) continue;
        this.installRacks(context, hall, hardware, toInstall);
        context.diagnostic('build.racks',
          `Installed ${toInstall} racks of ${hardware.name} in hall ${hall.instanceId}`,
          { tick: tick.index, hardwareId: hardware.id, racks: toInstall });
        return;
      }
    }

    // There is somewhere to put racks and the operator could not afford them.
    // Building another empty shell would only add debt and cooling plant with
    // nothing in it to earn the interest back.
    if (spaceAvailable) return;
    if (this.buildingHalls(context) >= 1) return;

    // Stop at the interconnection ceiling and at the scenario's own capacity
    // target: an operator that builds past either is building something it
    // cannot power or was never asked for.
    const itMw = installedItMw(context);
    if (itMw >= context.region.grid.capacityMw * 0.85) return;
    if (itMw >= context.scenario.targetCapacityMw * 1.5) return;

    // A shell is only worth starting if the racks to fill it are within reach
    // too; a hall on its own earns nothing.
    const shellRacks = Math.max(MIN_OPENING_HALL_RACKS,
      Math.min(MAX_OPENING_HALL_RACKS, Math.ceil(racksWanted * 2)));
    const hallCost = this.hallCost(context, shellRacks);
    if (hallCost > this.discretionaryBudget(context) * MAX_HALL_SHARE_OF_BUDGET) return;

    const seedRacks = Math.min(shellRacks, Math.max(RACK_ORDER_LIMIT, racksWanted));
    if (!this.commit(context, hallCost + seedRacks * rackCost * 0.5, tick.index)) return;
    // Only the shell is spent now; the rack budget was a solvency check.
    state.company.cash += seedRacks * rackCost * 0.5;
    state.hour.capex -= seedRacks * rackCost * 0.5;
    this.buildHall(context, tick.index, shellRacks);
    context.diagnostic('build.hall', `Started construction of a ${shellRacks}-rack hall`, {
      tick: tick.index, racks: shellRacks, cost: Math.round(hallCost),
    });
  }

  /** Halls currently under construction. Keeps the pipeline from running away. */
  private buildingHalls(context: SimulationContext): number {
    return context.state.facilities
      .flatMap((f) => f.halls)
      .filter((hall) => hall.constructionProgress01 < 1).length;
  }


  /**
   * Retrofits a hall to better cooling.
   *
   * Without this, a hall is stuck with whatever was available the month it was
   * built, and researching liquid cooling would only ever help the NEXT hall.
   * Spec chapter 5 treats containment and rear-door exchangers as retrofits
   * specifically, and the desert scenario depends on being able to move off air
   * cooling once the heat starts costing capacity.
   *
   * The trigger is either a hall that is losing capacity to heat, or a
   * meaningfully better technology being available; the cost is the new plant
   * less what the old plant is still worth, plus a premium for doing it in a
   * live facility.
   */
  private retrofitCooling(context: SimulationContext, tick: SimulationTick): void {
    const best = this.chooseCooling(context);
    const budget = this.discretionaryBudget(context);

    for (const facility of context.state.facilities) {
      for (const hall of facility.halls) {
        if (hall.constructionProgress01 < 1) continue;
        if (hall.coolingId === best.id) continue;
        const current = context.registry.cooling(hall.coolingId, hall.instanceId);

        // Retrofit for a problem or an efficiency gain - not for headroom the
        // fleet has no use for. Chasing density alone buys the most expensive
        // plant in the catalogue to cool racks that never needed it.
        const throttling = hall.throttle01 > 0.02;
        const energyGain = current.energyFactor / best.energyFactor;
        const plannedRackKw = currentRackOutput(context, this.chooseHardware(context)).powerKw;
        const densityNeeded = plannedRackKw > current.densityKwPerRack;
        // A hall that runs out of cooling for part of the year caps what the
        // whole fleet can promise, and it does that whether or not it happens
        // to be throttling today. Without this the operator answers a thermal
        // ceiling by quietly selling less for ever, which is not a strategy.
        const capped = thermalOutlook(context, hall).share01 > THERMAL_CEILING_TOLERANCE;
        if (!throttling && !capped && !densityNeeded && energyGain < 1.15) continue;

        const capacityMw = this.requiredCoolingKw(context, hall) / 1000;
        const newPlant = capacityMw * context.balance.baseCoolingCapexPerMw * best.capexFactor;
        const oldResidual = (hall.ratedCoolingKw / 1000)
          * context.balance.baseCoolingCapexPerMw * current.capexFactor * hall.condition01 * 0.4;
        const cost = Math.max(newPlant * 0.25, newPlant - oldResidual) * RETROFIT_PREMIUM;
        if (cost > budget) continue;
        if (!this.commit(context, cost, tick.index)) continue;

        hall.coolingId = best.id;
        hall.ratedCoolingKw = Math.max(hall.ratedCoolingKw, this.requiredCoolingKw(context, hall));
        // A retrofit in a live hall leaves the plant slightly shaken down.
        hall.condition01 = Math.min(1, hall.condition01 * 0.5 + 0.5);
        hall.coolingFailed = false;

        context.diagnostic('build.retrofit',
          `Retrofitted hall ${hall.instanceId} from ${current.name} to ${best.name}`,
          {
            tick: tick.index, from: current.id, to: best.id,
            cost: Math.round(cost), throttling, capped,
            ratedCoolingKw: Math.round(hall.ratedCoolingKw),
          });
        return; // One retrofit at a time: they are disruptive and expensive.
      }
    }
  }

  /**
   * Design IT load per rack for a hall, kW.
   *
   * A cooling technology's `densityKwPerRack` is a CEILING - the most it can
   * remove from one rack - not the load a hall is built for. Sizing plant to
   * the ceiling would make an immersion hall eighteen times the cost of an air
   * hall holding the same CPU racks, and would price every upgrade out of
   * reach. Plant is sized to the hardware actually going in, capped by what the
   * technology can handle.
   */
  private designRackKw(context: SimulationContext, cooling: CoolingTechnologyDefinition): number {
    const hardware = this.chooseHardware(context);
    const rackKw = currentRackOutput(context, hardware).powerKw;
    // The floor is a rack of this era, not of 2025: a hall built in 2006 is
    // not plumbed for a load that will not exist for twenty years.
    const floorKw = context.balance.baseRackPowerKw
      * eraFactors(context).rackPowerKw;
    return Math.min(cooling.densityKwPerRack, Math.max(rackKw, floorKw));
  }

  private hallCost(context: SimulationContext, racks: number, cooling?: CoolingTechnologyDefinition): number {
    const chosen = cooling ?? this.chooseCooling(context);
    const capacityMw = racks * this.designRackKw(context, chosen) * COOLING_DESIGN_MARGIN / 1000;
    const shell = capacityMw * context.balance.baseHallCapexPerMw
      * context.modifiers.value('facility.hallCapex', 1)
      * context.region.land.constructionCostFactor;
    const plant = capacityMw * context.balance.baseCoolingCapexPerMw * chosen.capexFactor;
    const incentive = 1 - context.region.policy.capitalIncentive01;
    return (shell + plant) * incentive;
  }

  /**
   * Builds a hall shell sized to what is needed now.
   *
   * Spec chapter 4 lists modularity as a spatial rule: small-step expansion in
   * exchange for less optimal density. A fixed maximum-size shell at
   * accelerator density is a single enormous commitment - one such hall can
   * consume a profitable operator's entire balance and leave nothing to buy the
   * racks that were the reason for building it.
   */
  private buildHall(context: SimulationContext, tick: number, racks: number,
                    coolingChoice?: CoolingTechnologyDefinition): void {
    const state = context.state;
    const cooling = coolingChoice ?? this.chooseCooling(context);
    let facility = state.facilities[0];
    if (!facility) {
      facility = {
        instanceId: `facility.${context.region.id}.0`,
        regionId: context.region.id,
        halls: [], powerAssets: [], landUsedHectares: 2, landRestoredHectares: 0,
        biodiversity: 50 * (1 - context.region.land.biodiversitySensitivity01 * 0.4),
        maintenanceBacklog: 0,
      };
      state.facilities.push(facility);
    }

    const ratedCoolingKw = racks * this.designRackKw(context, cooling) * COOLING_DESIGN_MARGIN;
    // The caller has already committed the cash through `commit()`.
    facility.landUsedHectares += 1.5;

    facility.halls.push({
      instanceId: `hall.${context.region.id}.${facility.halls.length}`,
      coolingId: cooling.id,
      installedTick: tick,
      rackCapacity: racks,
      rackGroups: [],
      constructionProgress01: 0,
      condition01: 1,
      ratedCoolingKw,
      coolingFailed: false,
      throttle01: 0,
      peakThrottle01: 0,
      inletTempC: context.balance.referenceInletTempC,
    });
  }

  /**
   * Cooling capacity a hall needs for the racks in it plus the space it still
   * has, at the design margin and under the technology's density ceiling.
   */
  private requiredCoolingKw(context: SimulationContext, hall: HallState): number {
    const cooling = context.registry.cooling(hall.coolingId, hall.instanceId);
    let installedKw = 0;
    let installedRacks = 0;
    for (const group of hall.rackGroups) {
      const rackKw = Math.min(cooling.densityKwPerRack, groupRackOutput(context, group).powerKw);
      installedKw += group.count * rackKw;
      installedRacks += group.count;
    }
    // Spare space is provisioned at the average density already installed, not
    // at the density of whatever the operator might buy next. Sizing a whole
    // hall's empty space for a fleet of accelerators buys megawatts of plant
    // years before there is anything to put under it, and the capital that
    // should have replaced retiring racks goes into chillers instead.
    const spareRacks = Math.max(0, hall.rackCapacity - installedRacks);
    const averageInstalledKw = installedRacks > 0
      ? installedKw / installedRacks
      : this.designRackKw(context, cooling);
    return (installedKw + spareRacks * averageInstalledKw) * COOLING_DESIGN_MARGIN;
  }

  private installRacks(
    context: SimulationContext,
    hall: HallState,
    hardware: HardwareDefinition,
    count: number,
  ): void {
    if (count <= 0) return;
    const state = context.state;

    // The caller has already committed the cash through `commit()`; what lands
    // here is the physical and environmental consequence of the purchase.
    // Embodied carbon lands in the year the hardware is bought, which is what
    // makes buying new a carbon decision as well as a cash one.
    state.hour.embodiedCarbonKg += count * context.balance.baseRackEmbodiedKgCo2e * hardware.embodiedFactor;

    // Purchases merge into a group only while they are of the same hardware and
    // close in age. Merging everything would give brand-new racks the age of the
    // oldest batch and retire them early; never merging would grow one group per
    // month for the length of the campaign, and every system that walks the
    // fleet would slow down with it.
    const mergeable = hall.rackGroups.find((group) =>
      group.hardwareId === hardware.id
      && state.meta.tickIndex - group.installedTick < GROUP_MERGE_TICKS);
    if (mergeable) {
      mergeable.count += count;
      const merged = this.requiredCoolingKw(context, hall);
      if (merged > hall.ratedCoolingKw) this.topUpCooling(context, hall, merged);
      return;
    }

    hall.rackGroups.push({
      instanceId: `${hall.instanceId}.${hardware.id}.${state.meta.nextInstanceId++}`,
      hardwareId: hardware.id,
      count,
      condition01: 1,
      installedTick: state.meta.tickIndex,
      vintageYear: fractionalYear(context),
      failedCount: 0,
      lifetimeItMwh: 0,
    });

    // Denser racks need more heat removed. Buying the racks without buying the
    // capacity to cool them is how a hall ends up throttling in its first
    // summer, so the plant is topped up at the same time.
    const required = this.requiredCoolingKw(context, hall);
    if (required > hall.ratedCoolingKw) this.topUpCooling(context, hall, required);
  }

  /**
   * Buys the extra cooling capacity a denser fleet needs. If the operator
   * cannot fund it, the plant stays as it is and the hall runs under-cooled -
   * the thermal and reliability systems will make that visible soon enough.
   */
  private topUpCooling(context: SimulationContext, hall: HallState, requiredKw: number): void {
    const cooling = context.registry.cooling(hall.coolingId, hall.instanceId);
    const addedMw = (requiredKw - hall.ratedCoolingKw) / 1000;
    const plantCost = addedMw * context.balance.baseCoolingCapexPerMw * cooling.capexFactor;
    if (!this.commit(context, plantCost, context.state.meta.tickIndex)) return;
    context.diagnostic('build.cooling_capacity',
      `Added ${Math.round(addedMw * 1000)} kW of ${cooling.name} capacity to hall ${hall.instanceId}`,
      {
        tick: context.state.meta.tickIndex, hall: hall.instanceId,
        addedKw: Math.round(addedMw * 1000), cost: Math.round(plantCost),
      });
    hall.ratedCoolingKw = requiredKw;
  }

  /**
   * Retires hardware past its design life. Retirement is where the circular
   * economy shows up: resale value and diversion both depend on what has been
   * researched, and what is not diverted is landfilled and scored as such.
   */
  private retireEndOfLife(context: SimulationContext, tick: SimulationTick): void {
    for (const facility of context.state.facilities) {
      for (const hall of facility.halls) {
        for (const group of hall.rackGroups) {
          const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
          const ageYears = (tick.index - group.installedTick) * tick.minutes / (60 * 8766);
          if (ageYears < hardware.lifeYears || group.count <= 0) continue;

          const retiring = Math.max(1, Math.ceil(group.count * RETIREMENT_SHARE_PER_MONTH));
          const resale = this.decommissionRacks(context, group, retiring);

          context.diagnostic('hardware.retired',
            `Retired ${retiring} racks of ${hardware.name} at ${ageYears.toFixed(1)} years`,
            { tick: tick.index, hardwareId: hardware.id, racks: retiring, resale: Math.round(resale) });
        }
        hall.rackGroups = hall.rackGroups.filter((group) => group.count > 0);
      }
    }
  }

  /**
   * Takes racks out of service and books the waste, resale and e-waste that go
   * with it. Shared by end-of-life retirement and a deliberate early
   * retirement, because the accounting is the same either way: the kit leaves
   * the floor, some of its mass is diverted and the rest is landfilled.
   *
   * Returns the resale proceeds, which the caller reports.
   */
  private decommissionRacks(
    context: SimulationContext, group: RackGroupState, count: number,
  ): number {
    const state = context.state;
    const retiring = Math.min(count, group.count);
    if (retiring <= 0) return 0;

    const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
    const diversion = clamp01(0.35 + context.modifiers.value('waste.diversionRate', 0));
    const resaleModifier = context.modifiers.value('hardware.resaleValue', 1);
    const ewasteModifier = context.modifiers.value('waste.ewasteGeneration', 1);

    group.count -= retiring;
    group.failedCount = Math.min(group.failedCount, group.count);

    const massTonnes = retiring * context.balance.rackMassTonnes * ewasteModifier;
    const divertedTonnes = massTonnes * diversion;
    state.hour.wasteGeneratedTonnes += massTonnes;
    state.hour.wasteDivertedTonnes += divertedTonnes;
    state.hour.wasteLandfilledTonnes += massTonnes - divertedTonnes;
    state.hour.otherCost += divertedTonnes * context.balance.wasteRecyclingCostPerTonne
      + (massTonnes - divertedTonnes) * context.balance.wasteLandfillCostPerTonne;

    // Resale falls off with age: kit sold early is worth more than kit sold at
    // the end of its life, which is most of the reason to switch early at all.
    const resale = retiring * context.balance.baseRackPurchaseCost * hardware.purchaseFactor
      * hardware.resaleValue01 * resaleModifier * this.remainingLifeShare(context, group, hardware);
    state.hour.hardwareResaleRevenue += resale;
    state.hour.hardwareRetiredRacks += retiring;
    return resale;
  }

  /** 0-1 share of a group's design life still ahead of it. */
  private remainingLifeShare(
    context: SimulationContext, group: RackGroupState, hardware: HardwareDefinition,
  ): number {
    const minutes = context.state.meta.minutesPerTick;
    const ageYears = (context.state.meta.tickIndex - group.installedTick) * minutes / (60 * 8766);
    return clamp01(1 - ageYears / Math.max(0.5, hardware.lifeYears));
  }

  /** What retiring a group now would return, before doing it. */
  quoteRetireRacks(context: SimulationContext, group: RackGroupState, count: number): number {
    const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
    const retiring = Math.min(count, group.count);
    return retiring * context.balance.baseRackPurchaseCost * hardware.purchaseFactor
      * hardware.resaleValue01 * context.modifiers.value('hardware.resaleValue', 1)
      * this.remainingLifeShare(context, group, hardware);
  }

  /**
   * Retires a rack group before its design life, on the player's instruction.
   *
   * The floor space and the cooling it was using come back immediately, which
   * is the only way to change what a full hall is running without building
   * another one.
   */
  retireRacks(context: SimulationContext, groupInstanceId: string, count: number): number {
    for (const facility of context.state.facilities) {
      for (const hall of facility.halls) {
        const group = hall.rackGroups.find((candidate) => candidate.instanceId === groupInstanceId);
        if (!group) continue;
        const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
        const retiring = Math.min(count, group.count);
        if (retiring <= 0) return 0;
        const resale = this.decommissionRacks(context, group, retiring);
        hall.rackGroups = hall.rackGroups.filter((candidate) => candidate.count > 0);
        context.diagnostic('hardware.retired',
          `Retired ${retiring} racks of ${hardware.name} early, freeing the space`,
          {
            tick: context.state.meta.tickIndex, hardwareId: hardware.id,
            racks: retiring, resale: Math.round(resale),
          });
        return resale;
      }
    }
    return 0;
  }

  /**
   * What it costs to walk away from a contract, and what standing it costs.
   *
   * Three months of the contract's revenue, or the rest of its term if that is
   * shorter. The point of the number is that it has to be worse than serving
   * the contract and better than breaching it for years - an operator who sold
   * capacity it cannot build needs a way out that hurts without being a trap.
   */
  quoteContractExit(
    context: SimulationContext, contract: ActiveContractState,
  ): { fee: number; reputationLoss: number; monthsLeft: number } {
    const definition = context.registry.contract(contract.definitionId, contract.instanceId);
    const workload = context.registry.workload(definition.workloadId, definition.id);
    const ticksLeft = Math.max(0, contract.endTick - context.state.meta.tickIndex);
    const monthsLeft = ticksLeft * context.state.meta.minutesPerTick / (60 * 24 * 30.44);
    const monthlyRevenue = contract.computeUnits * contract.pricePerComputeUnitHour
      * workload.meanUtilization01 * 730;
    return {
      fee: monthlyRevenue * Math.min(3, monthsLeft),
      reputationLoss: Math.min(8, 3 * (EXIT_REPUTATION_CLASS[workload.penaltyClass] ?? 1)),
      monthsLeft,
    };
  }

  /** Ends a contract early, paying the exit fee. */
  dropContract(context: SimulationContext, contractInstanceId: string): boolean {
    const state = context.state;
    const contract = state.contracts.find((c) => c.instanceId === contractInstanceId);
    if (!contract) return false;
    const definition = context.registry.contract(contract.definitionId, contract.instanceId);
    const quote = this.quoteContractExit(context, contract);
    if (state.company.cash < quote.fee) return false;

    state.company.cash -= quote.fee;
    // An exit fee is a cost of doing business, not a capital asset: it belongs
    // in the month's operating result where the player will see it.
    state.hour.otherCost += quote.fee;
    state.company.reputation = Math.max(0, state.company.reputation - quote.reputationLoss);
    state.contracts = state.contracts.filter((c) => c.instanceId !== contractInstanceId);

    context.diagnostic('contract.dropped',
      `Ended ${definition.name} ${quote.monthsLeft.toFixed(0)} months early`,
      {
        tick: state.meta.tickIndex, contractId: definition.id,
        fee: Math.round(quote.fee), reputationLoss: Number(quote.reputationLoss.toFixed(1)),
      });
    return true;
  }

  /** Salvage value of a power asset, before deciding to decommission it. */
  quotePowerExit(context: SimulationContext, asset: PowerAssetState): number {
    const definition = context.registry.power(asset.definitionId, asset.instanceId);
    // An import connection is a contract, not a machine: there is nothing to
    // sell when it is given up.
    if (definition.kind === 'import') return 0;
    const minutes = context.state.meta.minutesPerTick;
    const ageYears = (context.state.meta.tickIndex - asset.installedTick) * minutes / (60 * 8766);
    const remaining = clamp01(1 - ageYears / Math.max(1, definition.lifeYears));
    return asset.capacityMw * context.balance.basePowerCapexPerMw * definition.capexFactor
      * POWER_SALVAGE_SHARE * remaining * clamp01(asset.condition01);
  }

  /** Decommissions a power asset, returning what it was salvaged for. */
  retirePower(context: SimulationContext, assetInstanceId: string): number {
    for (const facility of context.state.facilities) {
      const asset = facility.powerAssets.find((c) => c.instanceId === assetInstanceId);
      if (!asset) continue;
      const definition = context.registry.power(asset.definitionId, asset.instanceId);
      const salvage = this.quotePowerExit(context, asset);
      context.state.company.cash += salvage;
      context.state.hour.hardwareResaleRevenue += salvage;
      // Generation gives its land back; an import connection never took any.
      const land = asset.capacityMw * definition.landHectaresPerMw;
      facility.landUsedHectares = Math.max(0, facility.landUsedHectares - land);
      facility.powerAssets = facility.powerAssets.filter((c) => c.instanceId !== assetInstanceId);

      context.diagnostic('power.retired',
        `Decommissioned ${asset.capacityMw.toFixed(1)} MW of ${definition.name}`,
        {
          tick: context.state.meta.tickIndex, powerId: definition.id,
          mw: Number(asset.capacityMw.toFixed(2)), salvage: Math.round(salvage),
        });
      return salvage;
    }
    return 0;
  }

  // ------------------------------------------------------------------ power
  private investInPower(context: SimulationContext): void {
    const state = context.state;
    if (this.availableBudget(context) <= 0) return;

    const itMw = installedItMw(context);
    if (itMw <= 0) return;

    const installedByDefinition = new Map<string, number>();
    for (const facility of state.facilities) {
      for (const asset of facility.powerAssets) {
        installedByDefinition.set(asset.definitionId,
          (installedByDefinition.get(asset.definitionId) ?? 0) + asset.capacityMw);
      }
    }

    // Keep the grid connection sized to the load first: without it nothing else
    // matters.
    const gridMw = installedByDefinition.get('power.grid') ?? 0;
    const neededMw = itMw * 1.6;
    if (gridMw < Math.min(neededMw, context.region.grid.capacityMw)) {
      const addMw = Math.min(neededMw - gridMw, context.region.grid.capacityMw - gridMw);
      if (addMw > 0.5 && this.affordPower(context, 'power.grid', addMw)) {
        this.buildPower(context, 'power.grid', addMw, true);
        return;
      }
    }

    // Then clean supply, in proportion to the strategy's preference.
    const cleanMw = [...installedByDefinition.entries()]
      .filter(([id]) => context.registry.power(id).clean)
      .reduce((total, [, mw]) => total + mw, 0);
    const cleanTarget = itMw * this.strategy.cleanPreference01 * 1.3;
    if (cleanMw < cleanTarget) {
      const candidate = this.chooseCleanSource(context);
      if (candidate && this.affordPower(context, candidate, 2)) {
        this.buildPower(context, candidate, Math.min(4, cleanTarget - cleanMw), false);
        return;
      }
    }

    // Storage once there is intermittent generation worth shifting.
    const renewableMw = [...installedByDefinition.entries()]
      .filter(([id]) => context.registry.power(id).renewable)
      .reduce((total, [, mw]) => total + mw, 0);
    const storageMw = installedByDefinition.get('power.battery') ?? 0;
    if (renewableMw > 2 && storageMw < renewableMw * 0.5
      && state.research.unlockedPower.includes('power.battery')
      && this.affordPower(context, 'power.battery', 2)) {
      this.buildPower(context, 'power.battery', 2, false);
      return;
    }

    // Diesel standby sized to the load, so a grid loss is survivable.
    const dieselMw = installedByDefinition.get('power.diesel_backup') ?? 0;
    if (dieselMw < itMw * 0.6 && this.affordPower(context, 'power.diesel_backup', 2)) {
      this.buildPower(context, 'power.diesel_backup', 2, false);
    }
  }

  private chooseCleanSource(context: SimulationContext): string | null {
    const unlocked = ['power.grid', 'power.diesel_backup', ...context.state.research.unlockedPower];
    const candidates = unlocked
      .map((id) => context.registry.all('power').get(id))
      .filter((definition): definition is NonNullable<typeof definition> =>
        definition !== undefined && definition.clean && definition.kind !== 'storage')
      .map((definition) => {
        const quality = context.region.resourceQuality[definition.id] ?? definition.dispatchability01;
        // Value per unit of capital: how much useful energy it delivers here,
        // weighted by how firm it is, against what it costs to build.
        const value = quality * (0.6 + 0.4 * definition.dispatchability01) / definition.capexFactor;
        return { id: definition.id, value };
      })
      .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
    return candidates[0]?.id ?? null;
  }

  private affordPower(context: SimulationContext, definitionId: string, mw: number): boolean {
    // The grid connection is not discretionary - without it nothing runs - but
    // everything else competes with keeping the fleet alive.
    const budget = definitionId === 'power.grid'
      ? this.availableBudget(context)
      : this.discretionaryBudget(context);
    return budget >= this.powerCost(context, definitionId, mw);
  }

  private powerCost(context: SimulationContext, definitionId: string, mw: number): number {
    const definition = context.registry.power(definitionId);
    const renewableDiscount = definition.renewable
      ? context.modifiers.value('power.renewableCapex', 1) : 1;
    return mw * context.balance.basePowerCapexPerMw * definition.capexFactor
      * context.modifiers.value('power.capex', 1) * renewableDiscount;
  }

  private buildPower(context: SimulationContext, definitionId: string, mw: number, instant: boolean): void {
    if (mw <= 0) return;
    const state = context.state;
    const definition = context.registry.power(definitionId);
    const cost = this.powerCost(context, definitionId, mw);
    if (!this.commit(context, cost, state.meta.tickIndex)) return;
    context.diagnostic('build.power',
      `Commissioned ${mw.toFixed(1)} MW of ${definition.name}`,
      {
        tick: state.meta.tickIndex, definitionId, capacityMw: Number(mw.toFixed(2)),
        cost: Math.round(cost),
      });

    let facility = state.facilities[0];
    if (!facility) {
      facility = {
        instanceId: `facility.${context.region.id}.0`,
        regionId: context.region.id, halls: [], powerAssets: [],
        landUsedHectares: 2, landRestoredHectares: 0, biodiversity: 50, maintenanceBacklog: 0,
      };
      state.facilities.push(facility);
    }
    facility.landUsedHectares += mw * definition.landHectaresPerMw;

    const existing = facility.powerAssets.find((a) => a.definitionId === definitionId);
    if (existing && definition.kind !== 'storage') {
      existing.capacityMw += mw;
      return;
    }

    const usableMwh = definition.kind === 'storage' ? mw * definition.storageDurationHours : 0;
    facility.powerAssets.push({
      instanceId: `power.${definitionId}.${facility.powerAssets.length}`,
      definitionId,
      capacityMw: mw,
      condition01: 1,
      installedTick: state.meta.tickIndex,
      storedMwh: usableMwh * 0.5,
      usableMwh,
      cycles: 0,
      runHoursThisYear: 0,
      available: true,
      constructionProgress01: instant ? 1 : 0,
    });
  }

  // ------------------------------------------------------------------ choice
  /**
   * Picks cooling for a new hall. Scores every unlocked technology against this
   * region's climate, water stress and the density the strategy wants, which is
   * why the cheapest option is not the right answer everywhere (chapter 14).
   */
  chooseCooling(context: SimulationContext): CoolingTechnologyDefinition {
    const unlocked = ['cooling.basic_air', ...context.state.research.unlockedCooling];
    const region = context.region;
    const summerC = Math.max(...region.climate.monthlyMeanTempC)
      + Math.max(...region.climate.monthlySwingC) / 2;

    const scored = [...new Set(unlocked)]
      .map((id) => context.registry.cooling(id, 'operator'))
      .filter((cooling) => cooling.deratingEndC > summerC)
      .map((cooling) => {
        // Energy: what this technology costs to run in this climate, judged at
        // the hottest part of the year rather than at the annual mean.
        const severity = clamp01((summerC - (cooling.deratingStartC - 15))
          / Math.max(1, cooling.deratingEndC - (cooling.deratingStartC - 15)));
        const energyHere = cooling.energyFactorBest
          + (cooling.energyFactorWorst - cooling.energyFactorBest) * severity;

        const energyScore = (1.4 - energyHere) * 2.0;
        const waterPenalty = cooling.waterFactor
          * (region.water.stress01 * 2 + this.strategy.waterCaution01) * 0.55;
        const densityScore = Math.log2(cooling.densityKwPerRack / 12) * this.strategy.densityPreference01 * 0.55;
        const capexPenalty = (cooling.capexFactor - 1) * (1 - this.strategy.capexAppetite01) * 0.85;
        const complexityPenalty = cooling.complexity01 * 0.5;
        const contaminationPenalty = region.climate.contamination01 * cooling.contaminationSensitivity01 * 1.2;
        const heatBonus = cooling.heatReuse01 * this.strategy.cleanPreference01 * 0.4;

        return {
          cooling,
          score: energyScore - waterPenalty + densityScore - capexPenalty
            - complexityPenalty - contaminationPenalty + heatBonus,
        };
      })
      .sort((a, b) => b.score - a.score || a.cooling.id.localeCompare(b.cooling.id));

    const best = scored[0]?.cooling;
    return best ?? context.registry.cooling('cooling.basic_air', 'operator');
  }

  /**
   * Picks hardware for the next rack order.
   *
   * Hardware is chosen for the workload the fleet is shortest on, and scored by
   * what a rack of it would EARN serving that workload against what it costs to
   * own and run. Scoring on compute per watt alone picks the same winner for
   * every campaign - a tape library has an extraordinary compute-per-watt
   * number and earns almost nothing serving a bank - which is exactly the
   * universal pick the chapter 14 assertions say must not exist.
   */
  chooseHardware(context: SimulationContext): HardwareDefinition {
    return this.bestHardwareFor(context, this.mostUnderservedWorkload(context));
  }

  /**
   * The workload with the largest gap between capacity reserved against it and
   * capacity able to serve it. Falls back to a general-purpose workload for the
   * opening build, before any contract exists.
   */
  private mostUnderservedWorkload(context: SimulationContext): string {
    const workloadIds = new Set<string>();
    for (const contract of context.state.contracts) {
      workloadIds.add(context.registry.contract(contract.definitionId, contract.instanceId).workloadId);
    }
    for (const offer of context.state.contractOffers) {
      workloadIds.add(context.registry.contract(offer.definitionId, offer.instanceId).workloadId);
    }
    if (workloadIds.size === 0) return 'workload.streaming';

    let worstId = 'workload.streaming';
    let worstGap = Number.NEGATIVE_INFINITY;
    for (const workloadId of [...workloadIds].sort()) {
      const gap = this.reservedUnits(context, workloadId) - this.servableUnits(context, workloadId);
      if (gap > worstGap) {
        worstGap = gap;
        worstId = workloadId;
      }
    }
    return worstId;
  }

  /** Units reserved against one workload, counting likely wins at half weight. */
  private reservedUnits(context: SimulationContext, workloadId: string): number {
    let units = 0;
    for (const contract of context.state.contracts) {
      const definition = context.registry.contract(contract.definitionId, contract.instanceId);
      if (definition.workloadId === workloadId) units += contract.computeUnits;
    }
    for (const offer of context.state.contractOffers) {
      const definition = context.registry.contract(offer.definitionId, offer.instanceId);
      if (definition.workloadId === workloadId) units += offer.computeUnits * 0.5;
    }
    return units;
  }

  /**
   * Racks within a year of their design life.
   *
   * Replacing them before they go keeps the fleet flat instead of stepping
   * down every time a cohort retires; waiting until they are gone means
   * discovering the shortfall as an SLA breach.
   */
  private racksNearingRetirement(context: SimulationContext): number {
    const ticksPerYear = (8766 * 60) / context.state.meta.minutesPerTick;
    let racks = 0;
    for (const facility of context.state.facilities) {
      for (const hall of facility.halls) {
        for (const group of hall.rackGroups) {
          const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
          const ageYears = (context.state.meta.tickIndex - group.installedTick) / ticksPerYear;
          if (ageYears >= hardware.lifeYears - 1) racks += group.count;
        }
      }
    }
    // One year of replacement at a time, spread over the months of that year.
    return racks / 12;
  }

  /** Compute units the installed fleet can deliver for one workload. */
  private servableUnits(context: SimulationContext, workloadId: string): number {
    const workload = context.registry.workload(workloadId, 'operator');
    let units = 0;
    for (const facility of context.state.facilities) {
      for (const hall of facility.halls) {
        for (const group of hall.rackGroups) {
          const hardware = context.registry.hardware(group.hardwareId, group.instanceId);
          if (!workload.compatibleFamilies.includes(hardware.family)) continue;
          const affinity = hardware.workloadAffinity[workloadId] ?? 0;
          units += group.count * groupRackOutput(context, group).computeUnits * affinity;
        }
      }
    }
    return units;
  }

  /**
   * The hardware with the best return on capital for one workload: annual
   * margin per rack over what the rack costs to buy.
   */
  private bestHardwareFor(context: SimulationContext, workloadId: string): HardwareDefinition {
    const balance = context.balance;
    const workload = context.registry.workload(workloadId, 'operator');
    const price = this.expectedPrice(context, workloadId);
    const coolingDensity = this.chooseCooling(context).densityKwPerRack
      * context.modifiers.value('cooling.densityKwPerRack', 1);
    const energyPrice = context.region.grid.basePricePerMwh * context.state.world.market.priceDriftFactor;
    const purchaseModifier = context.modifiers.value('hardware.purchaseCost', 1);

    const unlocked = ['hardware.cpu.gen1', ...context.state.research.unlockedHardware];
    const scored = [...new Set(unlocked)]
      .map((id) => context.registry.hardware(id, 'operator'))
      .filter((hardware) => workload.compatibleFamilies.includes(hardware.family))
      // Never buy hardware the halls cannot cool.
      .filter((hardware) => hardware.requiredCoolingKwPerRack <= coolingDensity)
      .map((hardware) => {
        const affinity = hardware.workloadAffinity[workloadId] ?? 0;
        if (affinity <= 0) return { hardware, score: Number.NEGATIVE_INFINITY };

        const output = currentRackOutput(context, hardware);
        const unitsPerRack = output.computeUnits * affinity;
        const annualRevenue = unitsPerRack * price * 8766;

        const purchase = balance.baseRackPurchaseCost * hardware.purchaseFactor * purchaseModifier;
        const rackKw = output.powerKw;
        // Energy at an assumed PUE of 1.4 and the workload's mean utilisation,
        // since reserved capacity that is idle still draws its idle share.
        const dutyCycle = 0.45 + 0.55 * workload.meanUtilization01;
        const annualEnergy = (rackKw / 1000) * 8766 * 1.4 * dutyCycle * energyPrice;
        const annualDepreciation = purchase / hardware.lifeYears;
        const annualMaintenance = purchase * balance.baseMaintenance01;
        const annualCost = annualEnergy + annualDepreciation + annualMaintenance;

        // Embodied carbon is a real cost to a green strategy and invisible to a
        // purely financial one.
        const embodiedPenalty = hardware.embodiedFactor * this.strategy.cleanPreference01
          * balance.baseRackEmbodiedKgCo2e / 1000
          * Math.max(5, context.region.policy.carbonPricePerTonne) / hardware.lifeYears;

        return {
          hardware,
          score: (annualRevenue - annualCost - embodiedPenalty) / Math.max(1, purchase),
        };
      })
      .filter((entry) => Number.isFinite(entry.score))
      .sort((a, b) => b.score - a.score || a.hardware.id.localeCompare(b.hardware.id));

    const best = scored[0];
    if (best && best.score > 0) return best.hardware;
    // Nothing unlocked pays for itself on this workload; fall back to the most
    // generally capable rack the halls can cool.
    return scored[0]?.hardware ?? context.registry.hardware('hardware.cpu.gen1', 'operator');
  }

  /** Price per compute-unit-hour the market is currently paying for a workload. */
  private expectedPrice(context: SimulationContext, workloadId: string): number {
    const relevant = [
      ...context.state.contractOffers
        .filter((o) => context.registry.contract(o.definitionId, o.instanceId).workloadId === workloadId)
        .map((o) => o.pricePerComputeUnitHour),
      ...context.state.contracts
        .filter((c) => context.registry.contract(c.definitionId, c.instanceId).workloadId === workloadId)
        .map((c) => c.pricePerComputeUnitHour),
    ];
    if (relevant.length > 0) {
      return relevant.reduce((a, b) => a + b, 0) / relevant.length;
    }
    // No market signal yet: fall back to the balance profile's own base.
    const workload = context.registry.workload(workloadId, 'operator');
    return context.balance.baseRevenuePerComputeUnitHour * workload.revenueFactor;
  }

  // ------------------------------------------------------------------ budget
  /**
   * Cash beyond the strategy's reserve, capped by its appetite for any one
   * commitment.
   *
   * The reserve is sized from the CURRENT month's run rate rather than from a
   * lifetime average: at campaign start a lifetime average is zero, which would
   * let the operator commit its entire opening balance in month one and then
   * discover what the facility costs to run.
   */
  private availableBudget(context: SimulationContext): number {
    const state = context.state;
    const ticksThisMonth = Math.max(1, state.month.totalTicks);
    const ticksPerMonth = (30.44 * 24 * 60) / state.meta.minutesPerTick;
    const monthCostSoFar = state.month.energyCost + state.month.waterCost + state.month.maintenanceCost
      + state.month.staffCost + state.month.fuelCost + state.month.carbonCost
      + state.month.penalties + state.month.otherCost;
    const projectedMonthlyCost = monthCostSoFar * (ticksPerMonth / ticksThisMonth);

    // Before any month has run, fall back to a floor derived from the opening
    // balance so the first build is bounded too.
    const monthlyCost = Math.max(projectedMonthlyCost, context.scenario.startingCash * 0.01);
    const reserve = monthlyCost * this.strategy.reserveMonths;

    // Appetite scales how much of the free balance is committed in a month, not
    // how much may ever be invested. Truncating every month's investment to a
    // third of the surplus leaves an operator unable to replace a fleet that
    // retires faster than a third of the surplus buys - which is a slow death
    // no strategy should be forced into.
    const commitShare = 0.5 + 0.5 * this.strategy.capexAppetite01;
    return Math.max(0, (state.company.cash - reserve) * commitShare);
  }

  /**
   * Budget for discretionary work - retrofits, new shells, extra generation -
   * after setting aside what the fleet needs to stay the size it is.
   *
   * Replacing retiring racks is the one commitment that cannot be deferred: a
   * rack that retires unreplaced is capacity sold and no longer deliverable, so
   * it costs an SLA breach, then reputation, then the contract. Discretionary
   * spending that crowds it out turns a profitable operator into a shrinking
   * one over a hardware generation.
   */
  private discretionaryBudget(context: SimulationContext): number {
    const hardware = this.chooseHardware(context);
    const rackCost = context.balance.baseRackPurchaseCost * hardware.purchaseFactor
      * context.modifiers.value('hardware.purchaseCost', 1);
    // Six months of replacement at the current retirement rate.
    const replacementReserve = this.racksNearingRetirement(context) * rackCost * 6;
    return Math.max(0, this.availableBudget(context) - replacementReserve);
  }

  /**
   * Commits cash to a purchase, borrowing if the balance cannot cover it.
   *
   * Every purchase the operator makes goes through here. Without a single gate,
   * a spend can push the balance negative, the finance system converts the
   * overdraft to debt, the interest raises next month's costs, and the operator
   * borrows again to cover them - a runaway that ends with a billion in debt
   * and an empty site.
   */
  private commit(context: SimulationContext, cost: number, tick: number): boolean {
    if (cost <= 0) return true;
    if (cost > this.availableBudget(context) && !this.raiseDebtFor(context, cost, tick)) return false;
    if (context.state.company.cash < cost) return false;
    context.state.company.cash -= cost;
    context.state.hour.capex += cost;
    return true;
  }

  /**
   * Draws debt to fund a commitment the balance cannot cover.
   *
   * Borrowing against a contracted revenue book is how this industry builds;
   * without it an operator can only ever grow at the rate it accumulates cash,
   * and a campaign's capacity target is unreachable. Capacity to borrow scales
   * with revenue and standing, and the finance system charges the interest.
   */
  private raiseDebtFor(context: SimulationContext, amount: number, tick: number): boolean {
    const state = context.state;
    if (amount <= 0) return true;
    if (state.company.cash >= amount) return true;

    // Trailing average rather than a year-to-date figure: year-to-date is near
    // zero every January, which would close the credit line once a year.
    const elapsedYears = Math.max(0.25,
      (state.meta.tickIndex * state.meta.minutesPerTick) / (60 * 8766));
    const annualRevenue = state.company.lifetimeRevenue / elapsedYears;
    const ceiling = Math.max(context.scenario.startingDebt, annualRevenue * DEBT_TO_REVENUE_CEILING)
      * (0.5 + state.company.reputation / 200);
    const headroom = ceiling - state.company.debt;
    if (headroom <= 0) return false;

    const needed = amount - state.company.cash;
    const draw = Math.min(headroom, needed * 1.1);
    if (draw < needed) return false;

    state.company.debt += draw;
    state.company.cash += draw;
    context.diagnostic('finance.debt_drawn', `Drew ${Math.round(draw / 1e6)}M of debt to fund expansion`, {
      tick, draw: Math.round(draw), debt: Math.round(state.company.debt),
    });
    return true;
  }
}
