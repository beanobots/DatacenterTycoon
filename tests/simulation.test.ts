/**
 * Simulation behaviour: the pipeline, the physics, scoring and save round-trip.
 *
 * Covers the chapter 14 automated assertions that can be checked on a short
 * run; the longer balance assertions live in golden.test.ts.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { importContent } from '../src/content/importer.js';
import type { ContentRegistry } from '../src/content/registry.js';
import type { BalanceProfileDefinition } from '../src/definitions/types.js';
import { SimulationEngine } from '../src/sim/engine.js';
import { allAutopilot } from '../src/sim/operator.js';
import { applyAction, enumerateActions } from '../src/sim/player.js';
import { canStartResearch, researchBlocker } from '../src/sim/systems/research.js';
import {
  MAX_ERA_DOWNTIME, currentRackOutput, eraSlaUptime01, groupRackOutput, rackOutputAt,
  regionalCarbonAt, regionalPriceAt,
} from '../src/sim/era.js';
import {
  DEFAULT_SAVE_DIAGNOSTICS, createSave, loadSave, serializeSave,
} from '../src/save/save.js';
import { migrate, SAVE_VERSION } from '../src/save/migrations.js';
import { evaluateCooling } from '../src/sim/cooling-model.js';
import { ModifierStack } from '../src/sim/modifiers.js';
import { scoreYear } from '../src/sim/scoring.js';
import { wetBulbC } from '../src/sim/systems/weather.js';
import { buildAnnualReport, type AnnualReport } from '../src/sim/report.js';
import { createAccumulator } from '../src/state/types.js';

let registry: ContentRegistry;
let balance: BalanceProfileDefinition;
beforeAll(() => {
  registry = importContent('content').registry;
  balance = registry.balanceProfile('balance.default', 'test');
});

const engineFor = (seed = 'test', scenarioId = 'scenario.dry_grid') =>
  new SimulationEngine(registry, { scenarioId, campaignSeed: seed });

describe('pipeline', () => {
  it('runs a headless campaign with no scene or asset dependency', () => {
    const engine = engineFor();
    const ticks = engine.runYears(2);
    expect(ticks).toBeGreaterThan(0);
    expect(engine.annualReports.length).toBeGreaterThanOrEqual(1);
  });

  it('produces no NaN or infinite values anywhere in the reports', () => {
    const engine = engineFor('nan-check');
    engine.runYears(3);
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'number') {
        expect(Number.isFinite(value), `${path} = ${value}`).toBe(true);
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
      }
    };
    walk(engine.annualReports, 'reports');
    walk(engine.state.annualScores, 'scores');
    walk(engine.state.company, 'company');
  });

  it('keeps no resource below its permitted minimum', () => {
    const engine = engineFor('minimums');
    engine.runYears(3);
    const company = engine.state.company;
    expect(company.cash).toBeGreaterThanOrEqual(0);
    expect(company.debt).toBeGreaterThanOrEqual(0);
    expect(company.reputation).toBeGreaterThanOrEqual(0);
    expect(company.reputation).toBeLessThanOrEqual(100);
    expect(company.communityTrust).toBeGreaterThanOrEqual(-100);
    expect(company.communityTrust).toBeLessThanOrEqual(100);
    for (const facility of engine.state.facilities) {
      for (const hall of facility.halls) {
        expect(hall.condition01).toBeGreaterThanOrEqual(0);
        expect(hall.throttle01).toBeGreaterThanOrEqual(0);
        expect(hall.throttle01).toBeLessThanOrEqual(1);
        for (const group of hall.rackGroups) {
          expect(group.failedCount).toBeLessThanOrEqual(group.count);
          expect(group.count).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('does not calculate PUE, CUE or WUE when IT energy is zero', () => {
    // Built directly from an empty accounting period: a year in which nothing
    // ran has no ratio to report, and must say so rather than divide by zero.
    const engine = engineFor('empty');
    engine.advanceTicks(10);
    const report = buildAnnualReport(engine.context, 2025, createAccumulator());
    expect(report.environment.itMwh).toBe(0);
    expect(report.environment.pue).toBeNull();
    expect(report.environment.cue).toBeNull();
    expect(report.environment.wue).toBeNull();
    // Availability with nothing demanded is complete, not zero.
    expect(report.reliability.availability01).toBe(1);
  });

  it('tracks power, water, carbon, waste and habitat independently', () => {
    const engine = engineFor('independent');
    engine.runYears(3);
    const report = engine.annualReports.at(-1);
    expect(report).toBeDefined();
    // Each is present as its own quantity, not folded into a single index.
    expect(report?.environment.facilityMwh).toBeGreaterThan(0);
    expect(report?.environment.operationalCarbonTonnes).toBeGreaterThan(0);
    expect(report?.environment.waterWithdrawnM3).toBeGreaterThanOrEqual(0);
    expect(report?.environment.biodiversity).toBeGreaterThan(0);
    // Facility energy is the sum of its parts, not an independent figure.
    const parts = report!.environment.itMwh;
    expect(report!.environment.facilityMwh).toBeGreaterThan(parts);
  });

  it('closes the month accumulator each month instead of letting it run for the campaign', () => {
    const engine = engineFor('month-accumulator');
    engine.runYears(2);
    const state = engine.state;

    // The month in progress has to be shorter than a month, and the closed one
    // has to be about a month. Before this, `month` was never cleared, so it
    // held every hour since the campaign opened - two years of trading under a
    // name that promised one month.
    const ticksPerMonth = (30.44 * 24 * 60) / state.meta.minutesPerTick;
    expect(state.month.totalTicks).toBeLessThanOrEqual(Math.ceil(ticksPerMonth));
    expect(state.lastMonth.totalTicks).toBeGreaterThan(ticksPerMonth * 0.85);
    expect(state.lastMonth.totalTicks).toBeLessThan(ticksPerMonth * 1.15);

    // And it is a slice of the campaign, not the whole of it. Compared against
    // the lifetime figure rather than the year, because a run that lands on a
    // calendar boundary has just had its year accumulator cleared too.
    expect(state.lastMonth.energyCost).toBeGreaterThan(0);
    expect(state.lastMonth.energyCost).toBeLessThan(state.company.lifetimeCost);
  });

  it('never resolves a definition lookup to undefined during a run', () => {
    const engine = engineFor('lookups');
    // Any failed lookup throws DefinitionLookupError, so completing the run is
    // the assertion.
    expect(() => engine.runYears(2)).not.toThrow();
  });
});

describe('determinism', () => {
  it('produces identical results from the same seed and inputs', () => {
    const a = engineFor('same-seed');
    const b = engineFor('same-seed');
    a.runYears(3);
    b.runYears(3);
    expect(JSON.stringify(a.annualReports)).toBe(JSON.stringify(b.annualReports));
    expect(JSON.stringify(a.state.annualScores)).toBe(JSON.stringify(b.state.annualScores));
  });

  it('produces different results from a different seed', () => {
    const a = engineFor('seed-a');
    const b = engineFor('seed-b');
    a.runYears(3);
    b.runYears(3);
    expect(JSON.stringify(a.annualReports)).not.toBe(JSON.stringify(b.annualReports));
  });

  it('is unaffected by tick batching', () => {
    const whole = engineFor('batching');
    whole.runYears(2);

    const piecemeal = engineFor('batching');
    const total = piecemeal.clock.ticksForDays(365.25 * 2);
    for (let done = 0; done < total; done += 137) {
      piecemeal.advanceTicks(Math.min(137, total - done));
    }
    expect(JSON.stringify(piecemeal.annualReports)).toBe(JSON.stringify(whole.annualReports));
  });
});

describe('save and load', () => {
  it('continues a campaign identically after a save round-trip', () => {
    const original = engineFor('save-test');
    original.runYears(2);
    const text = serializeSave(createSave(original, registry));

    const { engine: restored, contentMismatch } = loadSave(text, registry);
    expect(contentMismatch).toBe(false);
    restored.runYears(2);

    const straight = engineFor('save-test');
    straight.runYears(4);

    // Compare only the years both engines reported; the restored engine does
    // not replay the years that were already closed before the save.
    const restoredYears = new Map(restored.annualReports.map((r) => [r.year, r]));
    const overlapping = straight.annualReports.filter((r) => restoredYears.has(r.year));
    expect(overlapping.length).toBeGreaterThan(0);
    for (const report of overlapping) {
      expect(restoredYears.get(report.year)).toEqual(report);
    }
  });

  it('trims the diagnostic log so a save fits a stored document', () => {
    const engine = engineFor('save-size');
    engine.runYears(5);
    expect(engine.state.diagnostics.length).toBeGreaterThan(DEFAULT_SAVE_DIAGNOSTICS);

    const save = createSave(engine, registry);
    expect(save.state.diagnostics.length).toBe(DEFAULT_SAVE_DIAGNOSTICS);
    // The log is write-only, so trimming it changes no outcome - but the size
    // it saves is the difference between storable and not.
    expect(serializeSave(save, false).length).toBeLessThan(256 * 1024);
  });

  it('records how the campaign was configured, so a resume plays the same', () => {
    const engine = new SimulationEngine(registry, {
      scenarioId: 'scenario.dry_grid', campaignSeed: 'config', autopilot: allAutopilot(false),
    });
    engine.operator.setAutopilot('power', true);
    const save = createSave(engine, registry, { campaignYears: 9 });
    expect(save.campaignYears).toBe(9);
    expect(save.autopilot).toMatchObject({ power: true, research: false });

    const { engine: restored, campaignYears } = loadSave(serializeSave(save), registry);
    expect(campaignYears).toBe(9);
    expect(restored.operator.autopilotState()).toEqual(save.autopilot);
  });

  it('carries the campaign history so a resumed save is not blank', () => {
    const engine = engineFor('history');
    engine.runYears(3);
    expect(engine.annualReports.length).toBe(3);

    const { engine: restored } = loadSave(serializeSave(createSave(engine, registry)), registry);
    expect(restored.annualReports.length).toBe(3);
    expect(restored.state.annualScores.length).toBe(3);
    expect(restored.annualReports[0]).toEqual(engine.annualReports[0]);
  });

  it('preserves random stream state across the round-trip', () => {
    const engine = engineFor('stream-state');
    engine.runYears(1);
    const save = createSave(engine, registry);
    expect(save.state.randomStreams.weather.counter).not.toBe('0');
    const { engine: restored } = loadSave(serializeSave(save), registry);
    expect(restored.state.randomStreams).toEqual(save.state.randomStreams);
  });

  it('detects a save written against different content', () => {
    const engine = engineFor('content-drift');
    engine.runYears(1);
    const save = { ...createSave(engine, registry), contentHash: 'deadbeef' };
    const { contentMismatch } = loadSave(JSON.stringify(save), registry);
    expect(contentMismatch).toBe(true);
  });

  it('migrates a save from the oldest supported version through every step', () => {
    expect(SAVE_VERSION).toBeGreaterThanOrEqual(3);

    const engine = engineFor('migration');
    engine.runYears(1);
    const current = createSave(engine, registry);

    // Rebuild a version-1 save: no contract market, no hall install tick, and
    // research as a points balance driving a single project.
    const legacy = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
    legacy.saveVersion = 1;
    const state = legacy.state as Record<string, unknown>;
    delete state.contractOffers;
    for (const facility of state.facilities as Array<Record<string, unknown>>) {
      for (const hall of facility.halls as Array<Record<string, unknown>>) delete hall.installedTick;
    }
    delete state.annualReports;
    const research = state.research as Record<string, unknown>;
    delete research.active;
    research.activeId = 'technology.cooling.containment';
    research.activeProgressRP = 750;
    (state.company as Record<string, unknown>).researchPoints = 4000;

    const migrated = migrate(legacy as { saveVersion: number });
    expect(migrated.applied).toEqual([
      '001-contract-market', '002-hall-install-tick', '003-research-in-dollars',
      '004-annual-reports-in-state', '005-sla-shortfall-attribution',
      '006-hall-peak-throttle', '007-instance-counter-in-state', '008-rack-vintage', '009-research-budget', '010-negotiated-sla',
      '011-month-accumulator', '012-halls-and-hardware',
    ]);
    expect(migrated.save.saveVersion).toBe(SAVE_VERSION);

    const migratedState = (migrated.save as unknown as { state: Record<string, unknown> }).state;
    expect(Array.isArray(migratedState.contractOffers)).toBe(true);

    // The single in-flight project became a one-element list, its progress
    // re-expressed in dollars at the rate the content migration used.
    const migratedResearch = migratedState.research as Record<string, unknown>;
    const active = migratedResearch.active as Array<Record<string, unknown>>;
    expect(active).toHaveLength(1);
    expect(active[0]!.technologyId).toBe('technology.cooling.containment');
    expect(active[0]!.fundedUsd).toBe(750_000);
    expect(migratedResearch.activeId).toBeUndefined();
    expect((migratedState.company as Record<string, unknown>).researchPoints).toBeUndefined();
    expect(Array.isArray(migratedState.annualReports)).toBe(true);

    // The month accumulator used to run for the whole campaign, so a legacy
    // save's figure is not a month. Both accumulators come back cleared, and
    // keep the shape the save was written with rather than today's.
    const migratedMonth = migratedState.month as Record<string, number>;
    const migratedLastMonth = migratedState.lastMonth as Record<string, number>;
    const runMonth = (current.state as unknown as { month: Record<string, unknown> }).month;
    expect(Object.keys(migratedMonth).sort()).toEqual(Object.keys(runMonth).sort());
    expect(migratedMonth.totalTicks).toBe(0);
    expect(migratedMonth.revenue).toBe(0);
    expect(migratedLastMonth.totalTicks).toBe(0);
    expect(migratedLastMonth.energyCost).toBe(0);
  });

  it('carries one capacity flag onto both halves of the decision it became', () => {
    const engine = engineFor('autopilot-split');
    engine.runYears(1);
    const current = createSave(engine, registry);

    // A version-12 save has one autopilot flag covering halls and hardware
    // together, so rebuild that shape and check both halves inherit it.
    for (const wasAuto of [true, false]) {
      const legacy = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
      legacy.saveVersion = 12;
      legacy.autopilot = {
        research: true, contracts: true, capacity: wasAuto, cooling: true, power: true,
      };

      const migrated = migrate(legacy as { saveVersion: number });
      const autopilot = (migrated.save as unknown as { autopilot: Record<string, unknown> })
        .autopilot;
      expect(migrated.applied).toContain('012-halls-and-hardware');
      expect(autopilot.halls).toBe(wasAuto);
      expect(autopilot.hardware).toBe(wasAuto);
      // The old key is gone rather than left beside the two that replaced it.
      expect(autopilot.capacity).toBeUndefined();
    }
  });

  it('restores a migrated save into a runnable campaign', () => {
    const engine = engineFor('migration-load');
    engine.runYears(1);
    const save = createSave(engine, registry);
    const { engine: restored } = loadSave(serializeSave(save), registry);
    expect(() => restored.runYears(1)).not.toThrow();
    expect(restored.annualReports.length).toBeGreaterThan(0);
  });

  it('refuses a save from a newer build rather than guessing', () => {
    expect(() => migrate({ saveVersion: SAVE_VERSION + 1 })).toThrow(/newer build/);
  });
});

describe('cooling model', () => {
  const baseInput = {
    heatLoadKw: 1000,
    itPowerKw: 1000,
    ratedCoolingKw: 2000,
    condition01: 1,
    maintenance01: 1,
    contamination01: 0,
    elevationM: 0,
    baseCoolingOverhead01: 0.42,
    modifiers: new ModifierStack(),
    heatExportAvailable: false,
  };

  it('responds to climate: the same plant costs more in the heat', () => {
    const cooling = registry.cooling('cooling.chilled_water');
    const cool = evaluateCooling({ ...baseInput, cooling, dryBulbC: 5, wetBulbC: 3 });
    const hot = evaluateCooling({ ...baseInput, cooling, dryBulbC: 40, wetBulbC: 28 });
    expect(hot.coolingPowerKw).toBeGreaterThan(cool.coolingPowerKw);
    expect(hot.severity01).toBeGreaterThan(cool.severity01);
  });

  it('derates capacity to a shortfall once ambient passes the design limit', () => {
    const cooling = registry.cooling('cooling.basic_air');
    const ok = evaluateCooling({ ...baseInput, cooling, dryBulbC: 20, wetBulbC: 14 });
    const extreme = evaluateCooling({ ...baseInput, cooling, dryBulbC: 44, wetBulbC: 24 });
    expect(ok.shortfall01).toBe(0);
    expect(extreme.shortfall01).toBeGreaterThan(0);
    expect(extreme.effectiveCapacityKw).toBeLessThan(ok.effectiveCapacityKw);
  });

  it('charges evaporative cooling for its water and air cooling for none', () => {
    const evaporative = evaluateCooling({
      ...baseInput, cooling: registry.cooling('cooling.evaporative_assist'), dryBulbC: 35, wetBulbC: 20,
    });
    const air = evaluateCooling({
      ...baseInput, cooling: registry.cooling('cooling.basic_air'), dryBulbC: 35, wetBulbC: 20,
    });
    expect(evaporative.waterM3PerHour).toBeGreaterThan(0);
    expect(air.waterM3PerHour).toBe(0);
  });

  it('never returns a negative or non-finite result', () => {
    for (const cooling of registry.all('cooling').values()) {
      for (const dryBulbC of [-30, 0, 25, 50, 60]) {
        const result = evaluateCooling({ ...baseInput, cooling, dryBulbC, wetBulbC: dryBulbC - 5 });
        expect(Number.isFinite(result.coolingPowerKw)).toBe(true);
        expect(result.coolingPowerKw).toBeGreaterThanOrEqual(0);
        expect(result.shortfall01).toBeGreaterThanOrEqual(0);
        expect(result.shortfall01).toBeLessThanOrEqual(1);
        expect(result.waterM3PerHour).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('computes a wet bulb at or below the dry bulb', () => {
    for (const dry of [0, 10, 20, 30, 45]) {
      for (const rh of [0.1, 0.5, 0.95]) {
        expect(wetBulbC(dry, rh)).toBeLessThanOrEqual(dry + 0.5);
      }
    }
  });
});

describe('modifier stack', () => {
  it('applies modifiers in priority order regardless of insertion order', () => {
    const forward = new ModifierStack();
    forward.add('a', [{ target: 'x.y', operation: 'add', value: 10, priority: 1 }]);
    forward.add('b', [{ target: 'x.y', operation: 'multiply', value: 2, priority: 2 }]);

    const reverse = new ModifierStack();
    reverse.add('b', [{ target: 'x.y', operation: 'multiply', value: 2, priority: 2 }]);
    reverse.add('a', [{ target: 'x.y', operation: 'add', value: 10, priority: 1 }]);

    expect(forward.value('x.y', 0)).toBe(20);
    expect(reverse.value('x.y', 0)).toBe(20);
  });

  it('returns the base value for an unmodified target', () => {
    expect(new ModifierStack().value('nothing.here', 3)).toBe(3);
  });

  it('removes every modifier from one source when it expires', () => {
    const stack = new ModifierStack();
    stack.add('event.heat', [{ target: 'cooling.energyFactor', operation: 'multiply', value: 1.5, priority: 10 }]);
    expect(stack.value('cooling.energyFactor')).toBe(1.5);
    stack.remove('event.heat');
    expect(stack.value('cooling.energyFactor')).toBe(1);
  });

  it('decomposes a value into its contributing sources', () => {
    const stack = new ModifierStack();
    stack.add('tech.a', [{ target: 'cooling.energyFactor', operation: 'multiply', value: 0.9, priority: 10 }]);
    stack.add('tech.b', [{ target: 'cooling.energyFactor', operation: 'multiply', value: 0.8, priority: 20 }]);
    const breakdown = stack.describe('cooling.energyFactor');
    expect(breakdown.steps.map((s) => s.sourceId)).toEqual(['tech.a', 'tech.b']);
    expect(breakdown.result).toBeCloseTo(0.72, 10);
  });
});

describe('scoring', () => {
  const profile = () => importContent('content').registry.scoreProfile('score.default');

  const report = (overrides: Partial<AnnualReport> = {}): AnnualReport => ({
    year: 2030,
    financial: {
      revenue: 50e6, cost: 35e6, operatingProfit: 15e6, operatingMargin01: 0.3,
      cash: 40e6, debt: 30e6, runwayMonths: 14, debtCoverage: 3, revenueDiversity01: 0.8, capex: 10e6,
    },
    reliability: {
      availability01: 0.9995, slaCompliance01: 1, incidents: 3, preventableIncidents: 0,
      degradedTickShare01: 0.001, reserveMargin01: 0.4,
    },
    environment: {
      itMwh: 20000, facilityMwh: 24000, pue: 1.2, cue: 60, wue: 0.3, ref01: 0.7, erf01: 0.2,
      hourlyMatch01: 0.7, operationalCarbonTonnes: 1200, embodiedCarbonTonnes: 200, offsetTonnes: 0,
      netCarbonTonnes: 1400, waterWithdrawnM3: 6000, waterConsumedM3: 5000, reclaimedShare01: 0.4,
      wasteDiversion01: 0.8, biodiversity: 60,
    },
    customer: { contractsActive: 6, completion01: 0.999, latencyMs: 10, latencySatisfaction01: 0.95, reputation: 80 },
    social: { trust: 40, jobs: 90, heatExportedMwh: 3000, gridServiceRevenue: 500000, transparent: true },
    capacity: { itCapacityMw: 8, rackCount: 900, hallCount: 4, powerCapacityMw: 12 },
    research: { completed: 20, active: 2 },
    ...overrides,
  });

  it('weights the five categories per chapter 7', () => {
    const score = scoreYear(report(), profile(), { minimumAvailability01: 0.995, gateFlags: [] });
    const weights = profile().weights;
    const expected =
      score.categories.financial.score * weights.financial +
      score.categories.reliability.score * weights.reliability +
      score.categories.environmental.score * weights.environmental +
      score.categories.customer.score * weights.customer +
      score.categories.social.score * weights.social;
    expect(score.overall).toBeCloseTo(Math.round(expected * 100) / 100, 2);
  });

  it('decomposes every category into named components', () => {
    const score = scoreYear(report(), profile(), { minimumAvailability01: 0.995, gateFlags: [] });
    for (const [name, detail] of Object.entries(score.categories)) {
      expect(Object.keys(detail.components).length, name).toBeGreaterThan(0);
      for (const value of Object.values(detail.components)) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('caps the rating at C on critical insolvency however good the year was', () => {
    const clean = scoreYear(report(), profile(), { minimumAvailability01: 0.995, gateFlags: [] });
    const gated = scoreYear(report(), profile(), {
      minimumAvailability01: 0.995, gateFlags: ['gate.critical_insolvency'],
    });
    expect(gated.overall).toBe(clean.overall);
    expect(['C', 'D']).toContain(gated.rating);
  });

  it('zeroes the environmental category on illegal disposal', () => {
    const gated = scoreYear(report(), profile(), {
      minimumAvailability01: 0.995, gateFlags: ['gate.illegal_disposal'],
    });
    expect(gated.categories.environmental.score).toBe(0);
  });

  it('trips the reliability floor below the scenario minimum', () => {
    const poor = report({
      reliability: { ...report().reliability, availability01: 0.90 },
    });
    const score = scoreYear(poor, profile(), { minimumAvailability01: 0.995, gateFlags: [] });
    expect(score.gatesTripped).toContain('gate.reliability_floor');
    expect(['B', 'C', 'D']).toContain(score.rating);
  });

  it('does not let offsets alone maximise the environmental score', () => {
    const dirty = report({
      environment: {
        ...report().environment,
        cue: 600, pue: 2.0, wue: 2.5, ref01: 0, erf01: 0, hourlyMatch01: 0,
        wasteDiversion01: 0, operationalCarbonTonnes: 10000, offsetTonnes: 10000, netCarbonTonnes: 0,
      },
    });
    const score = scoreYear(dirty, profile(), { minimumAvailability01: 0.995, gateFlags: [] });
    // Fully offset but genuinely dirty operations must not reach a good score.
    expect(score.categories.environmental.score).toBeLessThan(40);
  });
});

describe('explaining an SLA breach', () => {
  /**
   * A breach the player cannot diagnose is indistinguishable from a broken
   * game, which is exactly how it reads from the console. These check that the
   * cause is attributed to something the player can act on, and that the two
   * causes needing opposite responses are never confused.
   */
  function playerEngine(seed: string): SimulationEngine {
    return new SimulationEngine(registry, {
      scenarioId: 'scenario.dry_grid', campaignSeed: seed, autopilot: allAutopilot(false),
    });
  }

  /** Signs every offer on the table, which is how a player oversells. */
  function signEverything(engine: SimulationEngine): void {
    for (const action of enumerateActions(engine.context, engine.operator)) {
      if (action.kind === 'contract.sign' && !action.blocked) {
        applyAction(engine.context, engine.operator, action.id);
      }
    }
  }

  it('names a cause and a remedy on every breach it reports', () => {
    const engine = playerEngine('breach-cause');
    engine.advanceTicks(engine.clock.ticksForDays(40));
    signEverything(engine);
    engine.advanceTicks(engine.clock.ticksForDays(200));

    const breaches = engine.state.diagnostics.filter((entry) => entry.kind === 'sla.breach');
    expect(breaches.length).toBeGreaterThan(0);
    for (const breach of breaches) {
      expect(breach.data?.cause).toBeDefined();
      expect(breach.data?.cause).not.toBe('unattributed');
      // The message has to carry the remedy: the log is what the player reads.
      expect(breach.message.length).toBeGreaterThan(60);
    }
  });

  it('tells "nothing can run this" apart from "you sold too much of it"', () => {
    const engine = playerEngine('breach-kinds');
    engine.advanceTicks(engine.clock.ticksForDays(40));

    // Pick the two offers deliberately rather than hoping a seed produces
    // both: one for a workload the fleet cannot touch, one for a workload it
    // can serve but not at that size.
    let signedUnservable = false;
    let signedOversized = false;
    for (let month = 0; month < 24 && !(signedUnservable && signedOversized); month += 1) {
      for (const action of enumerateActions(engine.context, engine.operator)) {
        if (action.kind !== 'contract.sign' || action.blocked) continue;
        if (!signedUnservable && action.servableUnits <= 0) {
          applyAction(engine.context, engine.operator, action.id);
          signedUnservable = true;
        } else if (!signedOversized && action.servableUnits > 0 && !action.fits) {
          applyAction(engine.context, engine.operator, action.id);
          signedOversized = true;
        }
      }
      engine.advanceTicks(engine.clock.ticksForDays(30.44));
    }
    expect(signedUnservable).toBe(true);
    expect(signedOversized).toBe(true);

    const causes = new Set(engine.state.diagnostics
      .filter((entry) => entry.kind === 'sla.breach')
      .map((entry) => String(entry.data?.cause)));
    expect(causes.has('noCompatibleHardware')).toBe(true);
    expect(causes.has('oversold')).toBe(true);
  });

  it('charges the largest credit for the worst month, not the smallest', () => {
    // Penalties used to be charged against delivered revenue, so serving
    // nothing cost nothing and serving 90% cost real money. A contract that is
    // entirely unserved has to be the most expensive outcome there is.
    const engine = playerEngine('breach-penalty');
    engine.advanceTicks(engine.clock.ticksForDays(40));
    signEverything(engine);
    engine.advanceTicks(engine.clock.ticksForDays(200));

    const total = engine.state.diagnostics
      .filter((entry) => entry.kind === 'sla.breach' && Number(entry.data?.achieved ?? 1) === 0);
    expect(total.length).toBeGreaterThan(0);
    for (const breach of total) {
      expect(Number(breach.data?.penalty ?? 0)).toBeGreaterThan(0);
    }
  });

  it('clears the attribution at the end of each SLA period', () => {
    const engine = playerEngine('breach-reset');
    engine.advanceTicks(engine.clock.ticksForDays(40));
    signEverything(engine);
    engine.advanceTicks(engine.clock.ticksForDays(400));

    // Every contract's record covers the period in progress only, so a month
    // is never judged on hours it did not contain.
    for (const contract of engine.state.contracts) {
      const booked = Object.values(contract.shortfall).reduce((a, b) => a + b, 0);
      expect(booked).toBeLessThanOrEqual(contract.demandedUnitHours + 1e-6);
    }
  });
});

describe('the campaign sits in history', () => {
  /**
   * A thirty-year campaign is only worth running if the decades differ. These
   * check the three things that make them differ, and the one that made an
   * early version collapse.
   */
  function engineFor(scenarioId: string, seed = 'era-test'): SimulationEngine {
    return new SimulationEngine(registry, { scenarioId, campaignSeed: seed, strategy: 'balanced' });
  }

  it('opens each site in its own decade, all ending in 2036', () => {
    for (const id of ['scenario.dry_grid', 'scenario.urban_colo',
      'scenario.cold_cloud', 'scenario.fossil_grid']) {
      const scenario = registry.scenario(id, 'test');
      const startYear = new Date(scenario.startDate).getUTCFullYear();
      expect(startYear).toBeGreaterThanOrEqual(2006);
      expect(startYear + scenario.durationYears).toBe(2036);
    }
  });

  it('refuses to research what has not been invented', () => {
    const engine = engineFor('scenario.dry_grid');
    expect(engine.state.meta.campaignYear).toBe(2006);

    // Immersion cooling does not exist in 2006 and the reason says so.
    const blocker = researchBlocker(engine.context, 'technology.cooling.immersion_single');
    expect(blocker).toContain('Not invented yet');
    expect(blocker).toContain('2014');
    expect(canStartResearch(engine.context, 'technology.cooling.immersion_single')).toBe(false);
  });

  it('never lets a technology arrive before what it is built on', () => {
    for (const technology of registry.all('technologies').values()) {
      for (const id of technology.prerequisites) {
        const prerequisite = registry.all('technologies').get(id);
        if (!prerequisite) continue;
        expect(prerequisite.availableFromYear).toBeLessThanOrEqual(technology.availableFromYear);
      }
    }
  });

  it('holds a rack to the performance and the draw of its own vintage', () => {
    // The bug this guards: era curves were applied to the whole fleet, so a
    // 2006 rack quietly gained compute AND quadrupled its power draw as the
    // decades passed. The halls became uncoolable and the operation collapsed
    // around 2030 for no reason the player could see.
    const engine = engineFor('scenario.dry_grid', 'vintage');
    engine.advanceTicks(engine.clock.ticksForDays(40));

    const group = engine.state.facilities.flatMap((f) => f.halls)
      .flatMap((h) => h.rackGroups)[0];
    expect(group).toBeDefined();
    const hardware = registry.hardware(group!.hardwareId, 'test');
    const vintage = group!.vintageYear;

    engine.runYears(12);

    // Research still improves what is on the floor - virtualization genuinely
    // makes existing machines do more - so the guard is that the group tracks
    // ITS OWN year, not that nothing ever changes.
    const actual = groupRackOutput(engine.context, group!);
    const atVintage = rackOutputAt(engine.context, hardware, vintage);
    expect(actual.computeUnits).toBeCloseTo(atVintage.computeUnits, 6);
    expect(actual.powerKw).toBeCloseTo(atVintage.powerKw, 6);

    // And the decade has moved on around it: a rack bought now is far better,
    // and draws far more, than the one bought twelve years ago.
    const today = currentRackOutput(engine.context, hardware);
    expect(today.computeUnits).toBeGreaterThan(actual.computeUnits * 3);
    expect(today.powerKw).toBeGreaterThan(actual.powerKw);
  });

  it('gives a later rack more compute and more heat than an earlier one', () => {
    const engine = engineFor('scenario.dry_grid', 'vintage-2');
    const hardware = registry.hardware('hardware.cpu.gen1', 'test');
    const early = rackOutputAt(engine.context, hardware, 2006);
    const late = rackOutputAt(engine.context, hardware, 2030);

    expect(late.computeUnits).toBeGreaterThan(early.computeUnits * 50);
    expect(late.powerKw).toBeGreaterThan(early.powerKw * 2);
  });

  it('moves grid carbon along the region trajectory rather than a smooth curve', () => {
    // The 2022 energy crisis is a spike, not an exponential, which is exactly
    // what the old compounding drift rate could not represent.
    const desert = registry.region('region.desert_southwest', 'test');
    const price2020 = regionalPriceAt(desert, 2020);
    const price2022 = regionalPriceAt(desert, 2022);
    const price2025 = regionalPriceAt(desert, 2025);
    expect(price2022).toBeGreaterThan(price2020 * 1.5);
    expect(price2025).toBeLessThan(price2022);

    const coal = registry.region('region.coal_belt', 'test');
    expect(regionalCarbonAt(coal, 2006)).toBeGreaterThan(regionalCarbonAt(coal, 2036) * 2);
  });

  it('closes exactly one year per advance, even from a leap year', () => {
    // A campaign starting in a leap year ran 365.25 days and stopped one day
    // short of its first new year, so no annual report fired that turn.
    for (const id of ['scenario.dry_grid', 'scenario.cold_cloud', 'scenario.fossil_grid']) {
      const engine = engineFor(id, 'leap');
      engine.runYears(1);
      expect(engine.annualReports.length).toBe(1);
      engine.runYears(2);
      expect(engine.annualReports.length).toBe(3);
    }
  });
});

describe('history that the player meets', () => {
  it('fires each dated shock once, on its date', () => {
    const engine = new SimulationEngine(registry, {
      scenarioId: 'scenario.dry_grid', campaignSeed: 'shocks', strategy: 'balanced',
    });
    const expected: Record<string, string> = {
      'event.crash_2008': '2008-09-15',
      'event.thai_flood_2011': '2011-10-10',
      'event.chip_shortage_2021': '2021-03-01',
      'event.energy_crisis_2022': '2022-02-24',
    };
    const startedOn = new Map<string, string>();
    for (let y = 0; y < 20; y += 1) {
      engine.runYears(1);
      for (const active of engine.state.activeEvents) {
        if (!(active.definitionId in expected) || startedOn.has(active.definitionId)) continue;
        const when = new Date(Date.parse(engine.state.meta.startDateIso)
          + active.startTick * engine.state.meta.minutesPerTick * 60_000);
        startedOn.set(active.definitionId, when.toISOString().slice(0, 10));
      }
    }
    for (const [id, date] of Object.entries(expected)) {
      expect(startedOn.get(id), id).toBe(date);
    }
    // Once, not on a cooldown that could bring it round again.
    for (const id of Object.keys(expected)) {
      expect(engine.state.eventCooldowns[id]).toBe(Number.MAX_SAFE_INTEGER);
    }
  });

  it('negotiates an availability the decade would have accepted', () => {
    // Three nines was a premium claim in 2006 and a baseline by the late
    // 2010s. Offering 2025 terms in 2006 makes the desert site unwinnable,
    // because air cooling of that era cannot hold them through the summer.
    const early = eraSlaUptime01(balance, 0.999, 2006);
    const late = eraSlaUptime01(balance, 0.999, 2025);
    expect(early).toBeLessThan(late);
    expect(early).toBeGreaterThan(0.98);
    expect(late).toBeCloseTo(0.999, 5);

    // And it never gets silly at the loose end: six times the downtime of a
    // 98% archetype would be 88%, which nobody would sign.
    expect(eraSlaUptime01(balance, 0.98, 2006)).toBeGreaterThanOrEqual(1 - MAX_ERA_DOWNTIME - 1e-9);
  });

  it('holds a contract to what it promised, not to today’s expectations', () => {
    const engine = new SimulationEngine(registry, {
      scenarioId: 'scenario.dry_grid', campaignSeed: 'promise', strategy: 'balanced',
    });
    engine.runYears(1);
    const contract = engine.state.contracts[0];
    expect(contract).toBeDefined();

    const definition = registry.contract(contract!.definitionId, 'test');
    // The promise travels with the contract; reading it back off the archetype
    // would re-promise modern terms on a deal struck in 2006.
    expect(contract!.slaUptime01).toBeLessThanOrEqual(definition.slaUptime01);
    expect(contract!.slaUptime01).toBeGreaterThan(0.9);
  });

  it('sizes the opening hall to the market of its decade', () => {
    const early = new SimulationEngine(registry, {
      scenarioId: 'scenario.dry_grid', campaignSeed: 'sizing',
    });
    const late = new SimulationEngine(registry, {
      scenarioId: 'scenario.fossil_grid', campaignSeed: 'sizing',
    });
    const capacityOf = (engine: SimulationEngine) => engine.state.facilities
      .flatMap((f) => f.halls).reduce((n, hall) => n + hall.rackCapacity, 0);

    // A 2006 operation that opens with a 2020-sized hall spends fifteen years
    // paying to cool an empty room.
    expect(capacityOf(early)).toBeLessThan(capacityOf(late));
    // But large enough to trade on day one: half of a tiny hall cannot serve
    // even the smallest offer its own decade makes.
    expect(early.state.contracts.length + early.state.contractOffers.length)
      .toBeGreaterThan(0);
  });
});
