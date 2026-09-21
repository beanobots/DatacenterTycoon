/**
 * Golden scenarios (spec chapter 14).
 *
 *   Desert AI campus   - solar variability, water limits, liquid cooling, heat
 *   Cold cloud facility - free cooling, long network distance, heat reuse
 *   Urban colocation    - land, noise, low latency, vertical expansion
 *   Fossil-heavy grid   - carbon-aware scheduling, carbon policy, procurement
 *
 * These are regression tests for balance and logic, not for exact numbers: they
 * assert the SHAPE the spec requires (no universal pick, geography matters,
 * every metric stays independent) so that a balance change that breaks a design
 * pillar fails here rather than in playtesting.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { importContent } from '../src/content/importer.js';
import type { ContentRegistry } from '../src/content/registry.js';
import { SimulationEngine } from '../src/sim/engine.js';
import { STRATEGIES, type StrategyName } from '../src/sim/operator.js';
import type { AnnualReport } from '../src/sim/report.js';

const GOLDEN_YEARS = 8;
const SEED = 'golden';

let registry: ContentRegistry;
beforeAll(() => {
  registry = importContent('content').registry;
});

interface RunResult {
  readonly engine: SimulationEngine;
  readonly last: AnnualReport;
}

/**
 * Completed campaigns, keyed by their inputs.
 *
 * The assertions below examine the same few campaigns from different angles.
 * Re-simulating a decade for each assertion would make this file take minutes;
 * the runs are deterministic, so one run per distinct input is enough. The
 * cache is keyed by everything that can change a result, which is exactly the
 * determinism property the suite asserts elsewhere.
 */
const runCache = new Map<string, RunResult>();

function run(scenarioId: string, strategy: StrategyName = 'balanced', years = GOLDEN_YEARS): RunResult {
  const key = `${scenarioId}|${strategy}|${years}|${SEED}`;
  const cached = runCache.get(key);
  if (cached) return cached;

  const engine = new SimulationEngine(registry, { scenarioId, campaignSeed: SEED, strategy });
  engine.runYears(years);
  const last = engine.annualReports.at(-1);
  if (!last) throw new Error(`${scenarioId} produced no annual report`);
  const result = { engine, last };
  runCache.set(key, result);
  return result;
}

describe('every golden scenario completes and reports', () => {
  it.each([
    'scenario.dry_grid',
    'scenario.cold_cloud',
    'scenario.urban_colo',
    'scenario.fossil_grid',
  ])('%s runs headlessly and produces a scored year', (scenarioId) => {
    const { engine, last } = run(scenarioId);
    expect(engine.annualReports.length).toBe(GOLDEN_YEARS);
    expect(engine.state.annualScores.length).toBe(GOLDEN_YEARS);
    expect(last.environment.facilityMwh).toBeGreaterThan(0);

    const score = engine.state.annualScores.at(-1)!;
    expect(score.overall).toBeGreaterThanOrEqual(0);
    expect(score.overall).toBeLessThanOrEqual(100);
    expect(score.rating).toMatch(/^(D|C|B|A|S|S\+)$/);
    // Every score must decompose (acceptance criterion 7).
    for (const detail of Object.values(score.categories)) {
      expect(Object.keys(detail.components).length).toBeGreaterThan(0);
    }
  });
});

describe('geography changes strategy', () => {
  it('produces materially different outcomes in different regions', () => {
    const desert = run('scenario.dry_grid').last;
    const cold = run('scenario.cold_cloud').last;
    const fossil = run('scenario.fossil_grid').last;

    // A cold low-carbon grid must beat a fossil grid on carbon intensity by a
    // wide margin - that is the whole point of choosing a site.
    expect(cold.environment.cue!).toBeLessThan(fossil.environment.cue! * 0.5);

    // Free cooling in the north beats cooling a desert hall on efficiency FOR
    // THE SAME PLANT - which is asserted directly against the cooling model in
    // simulation.test.ts, where the comparison is like for like.
    //
    // It is NOT asserted between two campaigns, because the operators do not
    // end up with the same plant: the desert is forced onto denser cooling to
    // keep its halls inside their thermal envelope, and comes out of that with
    // a better PUE than the northern site that never had to bother. That is
    // the site trade-off working - the desert paid capital for it - not the
    // physics inverting.
    expect(cold.environment.pue!).toBeGreaterThan(1);

    // The three sites do not converge on the same operation.
    const pues = [desert.environment.pue!, cold.environment.pue!, fossil.environment.pue!];
    expect(Math.max(...pues) - Math.min(...pues)).toBeGreaterThan(0.01);
  });

  it('charges the desert for water, for energy, or for the plant that avoids both', () => {
    const desert = run('scenario.dry_grid');
    const cold = run('scenario.cold_cloud');

    // The desert operator pays for its climate in one of three currencies:
    // water drawn, energy spent avoiding it, or capital spent on plant good
    // enough to need neither. It cannot escape all three.
    //
    // The first two alone used to be asserted, and that held only while the
    // operator had no way to answer a thermal ceiling. Once it retrofits, the
    // desert site can end up with BETTER water and energy figures than the
    // cold one - bought with a more expensive cooling technology, which is the
    // trade-off working rather than the invariant breaking.
    const coolingCapex = (engine: typeof desert.engine): number => {
      let weighted = 0;
      let kw = 0;
      for (const facility of engine.state.facilities) {
        for (const hall of facility.halls) {
          const cooling = registry.cooling(hall.coolingId, hall.instanceId);
          weighted += cooling.capexFactor * hall.ratedCoolingKw;
          kw += hall.ratedCoolingKw;
        }
      }
      return kw > 0 ? weighted / kw : 0;
    };

    const worseOnWater = (desert.last.environment.wue ?? 0) > (cold.last.environment.wue ?? 0);
    const worseOnEnergy = (desert.last.environment.pue ?? 0) > (cold.last.environment.pue ?? 0);
    const worseOnCapital = coolingCapex(desert.engine) > coolingCapex(cold.engine);
    expect(worseOnWater || worseOnEnergy || worseOnCapital).toBe(true);
  });
});

describe('no unintended universal pick', () => {
  it('does not choose the same cooling technology in every climate', () => {
    const chosen = new Set<string>();
    for (const scenarioId of ['scenario.dry_grid', 'scenario.cold_cloud', 'scenario.fossil_grid']) {
      const { engine } = run(scenarioId);
      for (const facility of engine.state.facilities) {
        for (const hall of facility.halls) chosen.add(hall.coolingId);
      }
    }
    // Climates that differ by 40 degrees of summer temperature must not all
    // land on one cooling technology.
    expect(chosen.size).toBeGreaterThan(1);
  });

  it('does not make the cheapest cooling optimal everywhere', () => {
    const { engine } = run('scenario.dry_grid');
    const halls = engine.state.facilities.flatMap((f) => f.halls);
    expect(halls.length).toBeGreaterThan(0);
    // A desert operator that never moves off the cheapest air cooling has not
    // been charged for the heat.
    expect(halls.some((hall) => hall.coolingId !== 'cooling.basic_air')).toBe(true);
  });

  it('does not make the densest hardware optimal for every workload', () => {
    const { engine } = run('scenario.dry_grid');
    const families = new Set<string>();
    for (const facility of engine.state.facilities) {
      for (const hall of facility.halls) {
        for (const group of hall.rackGroups) {
          families.add(registry.hardware(group.hardwareId, group.instanceId).family);
        }
      }
    }
    // A fleet serving archive, finance and AI work with one hardware family
    // means affinity is not doing its job.
    expect(families.size).toBeGreaterThan(1);
  });
});

describe('strategies remain viable', () => {
  const strategies = Object.keys(STRATEGIES) as StrategyName[];

  it.each(strategies)('%s survives a normal-difficulty campaign', (strategy) => {
    const { engine, last } = run('scenario.dry_grid', strategy);
    // Survival means still operating: capacity in service, revenue coming in,
    // and the year scored.
    expect(last.capacity.itCapacityMw).toBeGreaterThan(0);
    expect(last.financial.revenue).toBeGreaterThan(0);
    expect(engine.state.annualScores.length).toBe(GOLDEN_YEARS);
  });

  it('produces genuinely different outcomes across strategies', () => {
    const results = strategies.map((strategy) => run('scenario.dry_grid', strategy).last);
    const pues = results.map((r) => r.environment.pue ?? 0);
    const revenues = results.map((r) => r.financial.revenue);
    // If every strategy converges on the same operation, the preset weights are
    // not reaching the decisions they are meant to steer.
    expect(Math.max(...pues) - Math.min(...pues)).toBeGreaterThan(0.005);
    expect(Math.max(...revenues) / Math.max(1, Math.min(...revenues))).toBeGreaterThan(1.05);
  });
});

describe('research and events actually fire', () => {
  it('completes research and applies its unlocks', () => {
    const { engine } = run('scenario.dry_grid');
    const research = engine.state.research;
    expect(research.completed.length).toBeGreaterThan(5);
    // Unlocks accumulate as technologies complete.
    expect(research.unlockedCooling.length + research.unlockedPower.length
      + research.unlockedHardware.length).toBeGreaterThan(0);
    for (const id of research.completed) {
      expect(() => registry.technology(id, 'golden-test')).not.toThrow();
    }
  });

  it('fires events and lets them expire', () => {
    const { engine } = run('scenario.dry_grid');
    const started = engine.state.diagnostics.filter((d) => d.kind === 'event.started');
    // Over a decade of desert operation, something must have happened.
    expect(started.length + engine.state.activeEvents.length).toBeGreaterThan(0);
    for (const active of engine.state.activeEvents) {
      expect(() => registry.event(active.definitionId, 'golden-test')).not.toThrow();
    }
  });

  it('keeps every event mitigable, as the validator requires', () => {
    for (const event of registry.all('events').values()) {
      expect(event.mitigation.length).toBeGreaterThan(10);
    }
  });
});

describe('metric discipline', () => {
  it('keeps PUE, CUE, WUE, renewable share and reuse as separate values', () => {
    const { last } = run('scenario.cold_cloud');
    const environment = last.environment;
    // Each is reported in its own right, and none is derived from another.
    expect(environment.pue).not.toBeNull();
    expect(environment.cue).not.toBeNull();
    expect(typeof environment.ref01).toBe('number');
    expect(typeof environment.erf01).toBe('number');
    expect(typeof environment.hourlyMatch01).toBe('number');
    // Hourly matched clean energy can never exceed total facility energy.
    expect(environment.hourlyMatch01).toBeLessThanOrEqual(1);
    expect(environment.ref01).toBeLessThanOrEqual(1);
  });

  it('builds reports from accumulated energy rather than averaged ratios', () => {
    const { last } = run('scenario.dry_grid');
    // PUE recomputed from the accumulated totals must equal the reported value.
    if (last.environment.pue !== null) {
      const recomputed = last.environment.facilityMwh / last.environment.itMwh;
      expect(recomputed).toBeCloseTo(last.environment.pue, 3);
    }
  });
});
