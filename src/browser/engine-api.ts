/**
 * Browser entry point for the engine.
 *
 * Exposes a small API on the global object. The console drives a campaign a
 * year at a time rather than calling `runYears` once: a decade is a few hundred
 * thousand ticks, and stepping it lets the page paint each year as it closes
 * instead of freezing until the whole campaign finishes.
 */

import { SimulationEngine } from '../sim/engine.js';
import { STRATEGIES, type StrategyName } from '../sim/operator.js';
import type { AnnualReport } from '../sim/report.js';
import type { AnnualScore, DiagnosticEntry } from '../state/types.js';
import { buildBrowserRegistry, type BundledContent } from './registry.js';
import { CONTENT } from './content-data.js';

const { registry, report: validation, definitionCount } =
  buildBrowserRegistry(CONTENT as unknown as BundledContent);

export interface ScenarioSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly regionName: string;
  readonly archetype: string;
  readonly durationYears: number;
  readonly difficulty: string;
  readonly targetCapacityMw: number;
  readonly minimumAvailability01: number;
  readonly startingCash: number;
  readonly startingDebt: number;
  readonly objectives: ReadonlyArray<{
    readonly description: string;
    readonly metric: string;
    readonly comparison: string;
    readonly target: number;
    readonly byYear: number;
  }>;
  /** Regional facts, so the console can show why one site plays unlike another. */
  readonly region: {
    readonly summerPeakC: number;
    readonly winterLowC: number;
    readonly gridCarbonKgPerMwh: number;
    readonly gridPricePerMwh: number;
    readonly gridCapacityMw: number;
    readonly waterStress01: number;
    readonly latencyMs: number;
    readonly startingTrust: number;
    readonly permitDays: number;
    readonly carbonPricePerTonne: number;
  };
}

export interface ObjectiveResult {
  readonly description: string;
  readonly metric: string;
  readonly comparison: string;
  readonly target: number;
  readonly value: number | null;
  readonly met: boolean;
}

export interface YearResult {
  readonly report: AnnualReport;
  readonly score: AnnualScore;
}

export interface CampaignRun {
  readonly totalYears: number;
  readonly totalTicks: number;
  /** Ticks still to run. */
  remainingTicks(): number;
  /**
   * Advances at most `ticks` and returns any years that closed during the call.
   *
   * Finer than a year: the console advances in small slices so the progress bar
   * moves and the page stays responsive, and collects a year's report on the
   * slice where it closes.
   */
  advance(ticks: number): YearResult[];
  /** Objective progress against the most recently closed year. */
  objectives(): ObjectiveResult[];
  diagnostics(): DiagnosticEntry[];
  /** A description of the operation as it stands, for the fleet panel. */
  fleet(): FleetSummary;
}

export interface FleetSummary {
  readonly halls: ReadonlyArray<{
    readonly id: string;
    readonly cooling: string;
    readonly racks: number;
    readonly capacity: number;
    readonly inletTempC: number;
    readonly throttle01: number;
    readonly condition01: number;
    readonly underConstruction: boolean;
  }>;
  readonly hardware: ReadonlyArray<{ readonly name: string; readonly racks: number }>;
  readonly power: ReadonlyArray<{ readonly name: string; readonly capacityMw: number; readonly clean: boolean }>;
  readonly contracts: ReadonlyArray<{ readonly name: string; readonly computeUnits: number; readonly workload: string }>;
  readonly research: ReadonlyArray<{ readonly name: string; readonly branch: string; readonly tier: number }>;
  readonly researching: string | null;
}

function describeScenarios(): ScenarioSummary[] {
  const summaries: ScenarioSummary[] = [];
  for (const scenario of registry.all('scenarios').values()) {
    const region = registry.region(scenario.regionId, scenario.id);
    const temps = region.climate.monthlyMeanTempC;
    const swings = region.climate.monthlySwingC;
    summaries.push({
      id: scenario.id,
      name: scenario.name,
      description: scenario.description ?? '',
      regionName: region.name,
      archetype: region.archetype,
      durationYears: scenario.durationYears,
      difficulty: scenario.difficulty,
      targetCapacityMw: scenario.targetCapacityMw,
      minimumAvailability01: scenario.minimumAvailability01,
      startingCash: scenario.startingCash,
      startingDebt: scenario.startingDebt,
      objectives: scenario.objectives.map((objective) => ({
        description: objective.description,
        metric: objective.metric,
        comparison: objective.comparison,
        target: objective.target,
        byYear: objective.byYear,
      })),
      region: {
        summerPeakC: Math.max(...temps) + Math.max(...swings) / 2,
        winterLowC: Math.min(...temps) - Math.max(...swings) / 2,
        gridCarbonKgPerMwh: region.grid.baseCarbonKgPerMwh,
        gridPricePerMwh: region.grid.basePricePerMwh,
        gridCapacityMw: region.grid.capacityMw,
        waterStress01: region.water.stress01,
        latencyMs: region.connectivity.latencyMsToDemandCentre,
        startingTrust: region.people.startingTrust,
        permitDays: region.policy.permitDays,
        carbonPricePerTonne: region.policy.carbonPricePerTonne,
      },
    });
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

function readMetric(report: AnnualReport, metric: string): number | null {
  let current: unknown = report;
  for (const part of metric.split('.')) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'number' ? current : null;
}

function compare(value: number, comparison: string, target: number): boolean {
  switch (comparison) {
    case 'gt': return value > target;
    case 'gte': return value >= target;
    case 'lt': return value < target;
    case 'lte': return value <= target;
    default: return false;
  }
}

function createRun(scenarioId: string, seed: string, strategy: StrategyName, years: number): CampaignRun {
  const engine = new SimulationEngine(registry, { scenarioId, campaignSeed: seed, strategy });
  const ticksPerYear = engine.clock.ticksForDays(365.25);
  let reported = 0;

  const totalTicks = ticksPerYear * years;
  let ticksRun = 0;

  return {
    totalYears: years,
    totalTicks,
    remainingTicks: () => Math.max(0, totalTicks - ticksRun),
    advance(ticks: number): YearResult[] {
      const budget = Math.min(ticks, totalTicks - ticksRun);
      if (budget <= 0) return [];
      ticksRun += engine.advanceTicks(budget);

      const closed: YearResult[] = [];
      while (reported < engine.annualReports.length && reported < engine.state.annualScores.length) {
        const report = engine.annualReports[reported];
        const score = engine.state.annualScores[reported];
        if (!report || !score) break;
        closed.push({ report, score });
        reported += 1;
      }
      return closed;
    },
    objectives(): ObjectiveResult[] {
      const latest = engine.annualReports.at(-1);
      return engine.context.scenario.objectives.map((objective) => {
        const value = latest ? readMetric(latest, objective.metric) : null;
        return {
          description: objective.description,
          metric: objective.metric,
          comparison: objective.comparison,
          target: objective.target,
          value,
          met: value !== null && compare(value, objective.comparison, objective.target),
        };
      });
    },
    diagnostics: () => [...engine.state.diagnostics],
    fleet(): FleetSummary {
      const hardware = new Map<string, number>();
      const halls = [];
      for (const facility of engine.state.facilities) {
        for (const hall of facility.halls) {
          let racks = 0;
          for (const group of hall.rackGroups) {
            racks += group.count;
            const name = registry.hardware(group.hardwareId, group.instanceId).name;
            hardware.set(name, (hardware.get(name) ?? 0) + group.count);
          }
          halls.push({
            id: hall.instanceId.replace(/^hall\.region\./, ''),
            cooling: registry.cooling(hall.coolingId, hall.instanceId).name,
            racks,
            capacity: hall.rackCapacity,
            inletTempC: hall.inletTempC,
            throttle01: hall.throttle01,
            condition01: hall.condition01,
            underConstruction: hall.constructionProgress01 < 1,
          });
        }
      }

      const power = engine.state.facilities.flatMap((f) => f.powerAssets).map((asset) => {
        const definition = registry.power(asset.definitionId, asset.instanceId);
        return { name: definition.name, capacityMw: asset.capacityMw, clean: definition.clean };
      });

      const contracts = engine.state.contracts.map((contract) => {
        const definition = registry.contract(contract.definitionId, contract.instanceId);
        return {
          name: definition.name,
          computeUnits: contract.computeUnits,
          workload: registry.workload(definition.workloadId, definition.id).name,
        };
      });

      const research = engine.state.research.completed.map((id) => {
        const technology = registry.technology(id, 'console');
        return { name: technology.name, branch: technology.branch, tier: technology.tier };
      });

      const activeId = engine.state.research.activeId;
      return {
        halls,
        hardware: [...hardware].map(([name, racks]) => ({ name, racks }))
          .sort((a, b) => b.racks - a.racks),
        power: power.sort((a, b) => b.capacityMw - a.capacityMw),
        contracts: contracts.sort((a, b) => b.computeUnits - a.computeUnits),
        research,
        researching: activeId ? registry.technology(activeId, 'console').name : null,
      };
    },
  };
}

const api = {
  describe: () => ({
    scenarios: describeScenarios(),
    strategies: Object.keys(STRATEGIES),
    definitionCount,
    contentHash: registry.contentHash(),
    counts: registry.counts,
    errors: validation.errors.length,
    warnings: validation.warnings.length,
    issues: [...validation.errors, ...validation.warnings].map((issue) => ({
      severity: issue.severity, code: issue.code, file: issue.file, message: issue.message,
    })),
  }),
  createRun,
};

(globalThis as unknown as { DCT: typeof api }).DCT = api;
export default api;
