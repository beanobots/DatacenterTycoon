/**
 * Simulation behaviour: the pipeline, the physics, scoring and save round-trip.
 *
 * Covers the chapter 14 automated assertions that can be checked on a short
 * run; the longer balance assertions live in golden.test.ts.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { importContent } from '../src/content/importer.js';
import type { ContentRegistry } from '../src/content/registry.js';
import { SimulationEngine } from '../src/sim/engine.js';
import { createSave, loadSave, serializeSave } from '../src/save/save.js';
import { migrate, SAVE_VERSION } from '../src/save/migrations.js';
import { evaluateCooling } from '../src/sim/cooling-model.js';
import { ModifierStack } from '../src/sim/modifiers.js';
import { scoreYear } from '../src/sim/scoring.js';
import { wetBulbC } from '../src/sim/systems/weather.js';
import { buildAnnualReport, type AnnualReport } from '../src/sim/report.js';
import { createAccumulator } from '../src/state/types.js';

let registry: ContentRegistry;
beforeAll(() => {
  registry = importContent('content').registry;
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

  it('migrates saves from at least two prior versions', () => {
    expect(SAVE_VERSION).toBeGreaterThanOrEqual(3);

    const engine = engineFor('migration');
    engine.runYears(1);
    const current = createSave(engine, registry);

    // Version 1: no contract market, no hall install tick.
    const legacy = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
    legacy.saveVersion = 1;
    const state = legacy.state as Record<string, unknown>;
    delete state.contractOffers;
    for (const facility of state.facilities as Array<Record<string, unknown>>) {
      for (const hall of facility.halls as Array<Record<string, unknown>>) delete hall.installedTick;
    }

    const migrated = migrate(legacy as { saveVersion: number });
    expect(migrated.applied).toEqual(['001-contract-market', '002-hall-install-tick']);
    expect(migrated.save.saveVersion).toBe(SAVE_VERSION);
    const migratedState = (migrated.save as unknown as { state: Record<string, unknown> }).state;
    expect(Array.isArray(migratedState.contractOffers)).toBe(true);
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
    research: { completed: 20, points: 500 },
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
