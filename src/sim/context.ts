/**
 * Simulation context: everything a system needs and nothing it should not have.
 *
 * Spec chapter 11 engineering constraints: "Simulation assemblies may not
 * reference UI or scene GameObjects" and "Presentation consumes snapshots and
 * event streams". Nothing reachable from here touches rendering.
 */

import type { SimulationClock, SimulationTick } from '../core/clock.js';
import type { RandomStreams } from '../core/rng.js';
import type { ContentRegistry } from '../content/registry.js';
import type {
  BalanceProfileDefinition, RegionDefinition, ScenarioDefinition, ScoreProfileDefinition,
} from '../definitions/types.js';
import type { GameState } from '../state/types.js';
import { ModifierStack } from './modifiers.js';

/**
 * Values derived during a tick and consumed by later systems in the same tick.
 * Cleared at the start of every tick so no system can read stale scratch.
 *
 * The one deliberate exception to "later systems read what earlier ones wrote"
 * is throttling: thermal shortfall is detected at step 7 and reduces allocation
 * at step 4 of the FOLLOWING tick. At 15 simulated minutes that lag matches how
 * quickly a real hall's inlet temperature moves, and it keeps the pipeline a
 * single forward pass rather than an iterative solve.
 */
export interface TickScratch {
  /** Step 3: compute units demanded this tick, by contract instance ID. */
  demandByContract: Map<string, number>;
  /** Step 4: compute units served this tick, by contract instance ID. */
  servedByContract: Map<string, number>;
  /**
   * Step 4: 0-1 share of each rack group's capacity RESERVED by a contract.
   * This is what limits how much can be sold.
   */
  utilizationByGroup: Map<string, number>;
  /**
   * Step 4: 0-1 share of each rack group actually doing work. Reserved capacity
   * that sits idle still occupies racks but draws far less power, which is what
   * makes a disaster-recovery tenant cheap to host and a training cluster not.
   */
  activeUtilizationByGroup: Map<string, number>;
  /** Step 5 */
  itPowerKw: number;
  heatLoadKw: number;
  /** Step 6 */
  coolingPowerKw: number;
  coolingWaterM3: number;
  /** Cooling capacity shortfall, 0 = keeping up, 1 = no cooling at all. */
  coolingShortfall01: number;
  recoverableHeatKw: number;
  electricalLossKw: number;
  auxiliaryKw: number;
  facilityPowerKw: number;
  /** Step 6: energy drawn from each power source this tick, MWh. */
  energyBySource: Map<string, number>;
  /** Unserved facility demand this tick, MWh. Drives outage severity. */
  unservedEnergyMwh: number;
  /** Step 8 */
  incidentsThisTick: number;
}

export function createScratch(): TickScratch {
  return {
    demandByContract: new Map(), servedByContract: new Map(), utilizationByGroup: new Map(),
    activeUtilizationByGroup: new Map(),
    itPowerKw: 0, heatLoadKw: 0, coolingPowerKw: 0, coolingWaterM3: 0, coolingShortfall01: 0,
    recoverableHeatKw: 0, electricalLossKw: 0, auxiliaryKw: 0, facilityPowerKw: 0,
    energyBySource: new Map(), unservedEnergyMwh: 0, incidentsThisTick: 0,
  };
}

export function resetScratch(scratch: TickScratch): void {
  scratch.demandByContract.clear();
  scratch.servedByContract.clear();
  scratch.utilizationByGroup.clear();
  scratch.activeUtilizationByGroup.clear();
  scratch.energyBySource.clear();
  scratch.itPowerKw = 0;
  scratch.heatLoadKw = 0;
  scratch.coolingPowerKw = 0;
  scratch.coolingWaterM3 = 0;
  scratch.coolingShortfall01 = 0;
  scratch.recoverableHeatKw = 0;
  scratch.electricalLossKw = 0;
  scratch.auxiliaryKw = 0;
  scratch.facilityPowerKw = 0;
  scratch.unservedEnergyMwh = 0;
  scratch.incidentsThisTick = 0;
}

export interface SimulationContext {
  readonly registry: ContentRegistry;
  readonly clock: SimulationClock;
  readonly streams: RandomStreams;
  readonly scenario: ScenarioDefinition;
  readonly region: RegionDefinition;
  readonly balance: BalanceProfileDefinition;
  readonly scoreProfile: ScoreProfileDefinition;
  readonly state: GameState;
  readonly scratch: TickScratch;
  /** Rebuilt whenever research completes or an event starts or ends. */
  modifiers: ModifierStack;
  /** Records a diagnostic snapshot; chapter 9 requires these around failures. */
  diagnostic(kind: string, message: string, data?: Record<string, number | string | boolean>): void;
}

/**
 * Rebuilds the modifier stack from completed research and active events. Cheap
 * enough to run on any change, and it keeps a single source of truth rather
 * than incrementally adding and removing effects.
 */
export function rebuildModifiers(context: SimulationContext): void {
  const stack = new ModifierStack();
  for (const techId of context.state.research.completed) {
    const tech = context.registry.all('technologies').get(techId);
    if (tech) stack.add(tech.id, tech.effects);
  }
  for (const active of context.state.activeEvents) {
    const event = context.registry.all('events').get(active.definitionId);
    if (event) stack.add(active.instanceId, event.effects);
  }
  context.modifiers = stack;
}

/** Contract for every simulation system (spec chapter 11 system contract). */
export interface ISimulationSystem {
  readonly name: string;
  /** Lower runs first. Spec chapter 9 fixes the pipeline order. */
  readonly order: number;
  initialize?(context: SimulationContext): void;
  tick(tick: SimulationTick, context: SimulationContext): void;
}
