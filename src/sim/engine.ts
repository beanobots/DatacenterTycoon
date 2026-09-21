/**
 * The simulation engine.
 *
 * Owns the clock, the system list and the context. Spec chapter 9 fixes the
 * pipeline order; systems declare an `order` and are sorted once at
 * construction, so the sequence is a property of the content of this file
 * rather than of registration order.
 *
 * Spec chapter 11: "Headless simulation must run without opening a gameplay
 * scene." Nothing here imports anything that renders.
 */

import { MINUTES_PER_TICK_DEFAULT, SimulationClock, type SimulationTick } from '../core/clock.js';
import { RandomStreams } from '../core/rng.js';
import type { ContentRegistry } from '../content/registry.js';
import type { ScenarioDefinition } from '../definitions/types.js';
import { createInitialState } from '../state/campaign.js';
import type { DiagnosticEntry, GameState } from '../state/types.js';
import {
  createScratch, rebuildModifiers, resetScratch,
  type ISimulationSystem, type SimulationContext, type TickScratch,
} from './context.js';
import { ModifierStack } from './modifiers.js';
import { WeatherSystem } from './systems/weather.js';
import { MarketSystem } from './systems/market.js';
import { WorkloadArrivalSystem } from './systems/workload.js';
import { AllocationSystem } from './systems/allocation.js';
import { ItPowerSystem } from './systems/it-power.js';
import { PowerDispatchSystem } from './systems/power-dispatch.js';
import { CoolingDispatchSystem } from './systems/cooling-dispatch.js';
import { ReliabilitySystem } from './systems/reliability.js';
import { AccountingSystem } from './systems/accounting.js';
import { SlaSystem } from './systems/sla.js';
import { MaintenanceSystem } from './systems/maintenance.js';
import { ConstructionSystem } from './systems/construction.js';
import { EventSystem } from './systems/events.js';
import { ResearchSystem } from './systems/research.js';
import { FinanceSystem } from './systems/finance.js';
import { CommunitySystem } from './systems/community.js';
import { ContractMarketSystem } from './systems/contract-market.js';
import { AnnualScoringSystem } from './systems/annual-scoring.js';
import {
  OperatorSystem, STRATEGIES, allAutopilot,
  type AutopilotState, type StrategyName,
} from './operator.js';
import type { AnnualReport } from './report.js';

/** Diagnostics kept in memory. Older entries are dropped, not persisted twice. */
const MAX_DIAGNOSTICS = 4000;

export interface EngineOptions {
  readonly scenarioId: string;
  readonly campaignSeed: string;
  readonly minutesPerTick?: number;
  readonly strategy?: StrategyName;
  /**
   * Which decisions the built-in heuristic still makes. Everything switched
   * off is the player's to decide through `src/sim/player.ts`; the default is
   * a fully autonomous operator, which is what the headless runs need.
   */
  readonly autopilot?: AutopilotState;
  /** Restores a saved campaign instead of starting a new one. */
  readonly restoreState?: GameState;
}

export class SimulationEngine {
  readonly clock: SimulationClock;
  readonly context: SimulationContext;
  private readonly systems: readonly ISimulationSystem[];
  private readonly scoringSystem: AnnualScoringSystem;
  readonly strategy: StrategyName;
  /** The operations layer, shared by the heuristic and any player driving it. */
  readonly operator: OperatorSystem;

  constructor(registry: ContentRegistry, options: EngineOptions) {
    const scenario: ScenarioDefinition = registry.scenario(options.scenarioId, '<engine options>');
    const minutesPerTick = options.minutesPerTick ?? MINUTES_PER_TICK_DEFAULT;
    const state = options.restoreState
      ?? createInitialState(registry, scenario, options.campaignSeed, minutesPerTick);

    this.strategy = options.strategy ?? 'balanced';
    this.clock = new SimulationClock(
      new Date(state.meta.startDateIso), state.meta.minutesPerTick, state.meta.tickIndex,
    );
    this.scoringSystem = new AnnualScoringSystem();

    const scratch: TickScratch = createScratch();
    const context: SimulationContext = {
      registry,
      clock: this.clock,
      streams: RandomStreams.fromState(state.randomStreams),
      scenario,
      region: registry.region(scenario.regionId, scenario.id),
      balance: registry.balanceProfile(scenario.balanceProfileId, scenario.id),
      scoreProfile: registry.scoreProfile(scenario.scoreProfileId, scenario.id),
      state,
      scratch,
      modifiers: new ModifierStack(),
      diagnostic: (kind, message, data) => {
        const entry: DiagnosticEntry = {
          tick: state.meta.tickIndex,
          timeIso: state.meta.gameTimeIso,
          kind, message, ...(data ? { data } : {}),
        };
        state.diagnostics.push(entry);
        if (state.diagnostics.length > MAX_DIAGNOSTICS) state.diagnostics.shift();
      },
    };
    this.context = context;
    rebuildModifiers(context);

    this.operator = new OperatorSystem(
      STRATEGIES[this.strategy], options.autopilot ?? allAutopilot(true),
    );

    this.systems = [
      // Pipeline, chapter 9, steps 1-10.
      new WeatherSystem(),
      new MarketSystem(),
      new WorkloadArrivalSystem(),
      new AllocationSystem(),
      new ItPowerSystem(),
      new PowerDispatchSystem(),
      new CoolingDispatchSystem(),
      new ReliabilitySystem(),
      new AccountingSystem(),
      new SlaSystem(),
      // Longer cadences.
      new MaintenanceSystem(),
      new ConstructionSystem(),
      new EventSystem(),
      new ResearchSystem(),
      new FinanceSystem(),
      new CommunitySystem(),
      new ContractMarketSystem(),
      this.operator,
      this.scoringSystem,
    ].sort((a, b) => a.order - b.order);

    if (!options.restoreState) {
      for (const system of this.systems) system.initialize?.(context);
    }
  }

  get state(): GameState {
    return this.context.state;
  }

  get annualReports(): readonly AnnualReport[] {
    return this.scoringSystem.reports;
  }

  /** Advances one tick through every system in pipeline order. */
  advanceTick(): SimulationTick | null {
    const tick = this.clock.advanceOneTick();
    if (!tick) return null;

    resetScratch(this.context.scratch);
    this.context.state.meta.tickIndex = tick.index;
    this.context.state.meta.gameTimeIso = tick.gameTimeUtc.toISOString();

    for (const system of this.systems) {
      system.tick(tick, this.context);
    }

    // Stream state lives in the save, so keep it current rather than
    // reconstructing it at save time.
    this.context.state.randomStreams = this.context.streams.toState();
    return tick;
  }

  /** Advances `count` ticks. Returns the number actually advanced. */
  advanceTicks(count: number): number {
    let advanced = 0;
    for (let i = 0; i < count; i += 1) {
      if (this.advanceTick() === null) break;
      advanced += 1;
    }
    return advanced;
  }

  /** Advances `years` of simulated time. */
  runYears(years: number): number {
    const ticksPerYear = this.clock.ticksForDays(365.25);
    return this.advanceTicks(Math.round(ticksPerYear * years));
  }

  /** Runs the scenario's full configured duration. */
  runScenario(): number {
    return this.runYears(this.context.scenario.durationYears);
  }

  /**
   * A read-only view for presentation. Spec chapter 11: "Presentation consumes
   * snapshots and event streams."
   */
  snapshot(): {
    tick: number;
    timeIso: string;
    itPowerKw: number;
    coolingPowerKw: number;
    facilityPowerKw: number;
    instantaneousPue: number | null;
    cash: number;
    reputation: number;
    trust: number;
    activeEvents: string[];
    diagnostics: readonly DiagnosticEntry[];
  } {
    const scratch = this.context.scratch;
    return {
      tick: this.context.state.meta.tickIndex,
      timeIso: this.context.state.meta.gameTimeIso,
      itPowerKw: scratch.itPowerKw,
      coolingPowerKw: scratch.coolingPowerKw,
      facilityPowerKw: scratch.facilityPowerKw,
      instantaneousPue: scratch.itPowerKw > 0 ? scratch.facilityPowerKw / scratch.itPowerKw : null,
      cash: this.context.state.company.cash,
      reputation: this.context.state.company.reputation,
      trust: this.context.state.company.communityTrust,
      activeEvents: this.context.state.activeEvents.map((e) => e.definitionId),
      diagnostics: this.context.state.diagnostics,
    };
  }
}
