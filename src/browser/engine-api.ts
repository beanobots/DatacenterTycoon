/**
 * Browser entry point for the engine.
 *
 * Exposes a small API on the global object. The console drives a campaign a
 * year at a time rather than calling `runYears` once: a decade is a few hundred
 * thousand ticks, and stepping it lets the page paint each year as it closes
 * instead of freezing until the whole campaign finishes.
 */

import { SimulationEngine } from '../sim/engine.js';
import {
  DECISION_CATEGORIES, STRATEGIES, allAutopilot,
  type AutopilotState, type DecisionCategory, type StrategyName,
} from '../sim/operator.js';
import {
  RACK_ORDER_SIZES, applyAction, enumerateActions, hallName,
  type ActionResult, type PlayerAction,
} from '../sim/player.js';
import { freeSpecialists, totalSpecialists } from '../sim/systems/research.js';
import { SHORTFALL_LABEL, SHORTFALL_REMEDY } from '../sim/systems/sla.js';
import { createSave, restoreSave, type SaveFile } from '../save/save.js';
import {
  commissioningSchedule, projectCapacity, workloadHeadroom,
  type ProjectedMonth, type ScheduleEntry, type WorkloadHeadroom,
} from '../sim/planning.js';
import type { AnnualReport } from '../sim/report.js';
import type { AnnualScore, DiagnosticEntry, ShortfallCause } from '../state/types.js';
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

/** Resolves a dotted objective metric against an annual report. */
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

export interface TurnAlert {
  readonly severity: 'critical' | 'serious' | 'warning' | 'good';
  readonly title: string;
  readonly detail: string;
}

export interface TurnSummary {
  /** Simulated date at the end of the turn. */
  readonly dateIso: string;
  readonly month: number;
  readonly year: number;
  /** Years that closed during this turn, with their scored reports. */
  readonly closedYears: YearResult[];
  /** What happened that the player should know about. */
  readonly alerts: TurnAlert[];
  /** Diagnostics emitted during this turn. */
  readonly log: DiagnosticEntry[];
  readonly finished: boolean;
}

export interface Dashboard {
  readonly cash: number;
  readonly debt: number;
  readonly budget: number;
  readonly reputation: number;
  readonly trust: number;
  /** Projects under way, each with its own funding progress. */
  readonly projects: ReadonlyArray<{
    readonly name: string;
    readonly progress01: number;
    readonly specialists: number;
    readonly costPerDay: number;
  }>;
  readonly freeSpecialists: number;
  readonly totalSpecialists: number;
  readonly itCapacityMw: number;
  readonly rackCount: number;
  readonly contractCount: number;
  readonly committedUnits: number;
  /**
   * Units still sellable for the workload with the most room. NOT a total:
   * the same racks serve several workloads, so summing headroom would promise
   * capacity that does not exist.
   */
  readonly freeUnits: number;
  readonly bestFitWorkload: string | null;
  readonly staff: number;
  /** Live plant readings, so the player can see a hall in trouble now. */
  readonly ambientC: number;
  readonly worstInletC: number;
  readonly throttling: boolean;
  readonly gridAvailable: boolean;
  readonly activeEvents: ReadonlyArray<{ name: string; mitigation: string }>;
}

export interface CampaignRun {
  readonly totalYears: number;
  readonly totalTicks: number;
  remainingTicks(): number;
  /** Advances one simulated month and reports what happened. */
  advanceMonth(): TurnSummary;
  /** Advances without stopping, for players who want to hand it back. */
  advanceYear(): TurnSummary;
  actions(): PlayerAction[];
  act(actionId: string, quantity?: number): ActionResult;
  autopilot(): AutopilotState;
  setAutopilot(category: DecisionCategory, enabled: boolean): void;
  dashboard(): Dashboard;
  /** How much more work the fleet can take on, workload by workload. */
  headroom(): WorkloadHeadroom[];
  /** Capacity month by month if nothing further is ordered. */
  projection(horizonMonths: number): ProjectedMonth[];
  /** Everything already committed that lands, lapses or ages out. */
  schedule(): ScheduleEntry[];
  objectives(): ObjectiveResult[];
  diagnostics(): DiagnosticEntry[];
  fleet(): FleetSummary;
  years(): YearResult[];
  /** A resumable snapshot of this campaign, plus what a save list needs to show. */
  save(): { file: SaveFile; summary: SaveSummary };
}

/** What a save list shows without opening the save itself. */
export interface SaveSummary {
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly seed: string;
  readonly dateIso: string;
  readonly monthLabel: string;
  readonly monthsElapsed: number;
  readonly totalMonths: number;
  readonly itCapacityMw: number;
  readonly cash: number;
  readonly contracts: number;
  readonly rating: string | null;
  readonly overall: number | null;
  readonly manual: boolean;
  readonly contentHash: string;
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
  readonly contracts: ReadonlyArray<{
    readonly name: string;
    readonly computeUnits: number;
    readonly workload: string;
    readonly monthsLeft: number;
    /** Availability delivered over the last closed SLA period, or null before the first. */
    readonly availability01: number | null;
    readonly required01: number;
    /** Penalties charged for the last period. */
    readonly penalty: number;
    /** Why it was missed, ready to read; null when it was met. */
    readonly cause: string | null;
  }>;
  readonly research: ReadonlyArray<{ readonly name: string; readonly branch: string; readonly tier: number }>;
  /** Names of the projects currently under way. */
  readonly researching: readonly string[];
}

function createRun(scenarioId: string, seed: string, strategy: StrategyName, years: number,
                   manual: boolean): CampaignRun {
  return wrapRun(new SimulationEngine(registry, {
    scenarioId, campaignSeed: seed, strategy,
    autopilot: allAutopilot(!manual),
  }), years);
}

/** Resumes a saved campaign, with the same turn loop as a fresh one. */
function restoreRun(file: SaveFile): { run: CampaignRun; contentMismatch: boolean; migrations: string[] } {
  const restored = restoreSave(file, registry);
  return {
    run: wrapRun(restored.engine, restored.campaignYears, restored.engine.state.meta.tickIndex),
    contentMismatch: restored.contentMismatch,
    migrations: [...restored.appliedMigrations],
  };
}

function wrapRun(engine: SimulationEngine, years: number, alreadyRunTicks = 0): CampaignRun {
  const context = engine.context;
  const operator = engine.operator;
  const ticksPerYear = engine.clock.ticksForDays(365.25);
  const ticksPerMonth = engine.clock.ticksForDays(30.44);
  const totalTicks = ticksPerYear * years;
  // A resumed campaign has already run its saved ticks; the budget is what is
  // left, not the whole campaign again.
  let ticksRun = Math.min(alreadyRunTicks, totalTicks);
  // Years already closed are part of the record, so the collector starts past
  // them rather than replaying them as newly closed.
  let reported = engine.annualReports.length;
  const collected: YearResult[] = engine.annualReports.map((report, index) => ({
    report,
    score: engine.state.annualScores[index] ?? engine.state.annualScores[engine.state.annualScores.length - 1]!,
  })).filter((entry) => entry.score !== undefined);

  function collectYears(): YearResult[] {
    const closed: YearResult[] = [];
    while (reported < engine.annualReports.length && reported < engine.state.annualScores.length) {
      const report = engine.annualReports[reported];
      const score = engine.state.annualScores[reported];
      if (!report || !score) break;
      closed.push({ report, score });
      collected.push({ report, score });
      reported += 1;
    }
    return closed;
  }

  /**
   * What the player needs to know from the month just simulated.
   *
   * Built from the diagnostics this turn plus the state they left behind, so an
   * alert always points at something the player can look up in the log.
   */
  function buildAlerts(log: DiagnosticEntry[], closed: YearResult[]): TurnAlert[] {
    const alerts: TurnAlert[] = [];
    const company = engine.state.company;

    const throttling = engine.state.facilities.flatMap((f) => f.halls)
      .filter((hall) => hall.throttle01 > 0.02);
    if (throttling.length > 0) {
      const worst = throttling.reduce((a, b) => (a.throttle01 > b.throttle01 ? a : b));
      alerts.push({
        severity: worst.throttle01 > 0.4 ? 'critical' : 'serious',
        title: `${throttling.length} hall${throttling.length > 1 ? 's' : ''} throttling`,
        detail: `Inlet ${worst.inletTempC.toFixed(0)} \u00b0C is above the throttle point, so load is being shed. `
          + 'Retrofit to denser cooling, or stop adding racks until it recovers.',
      });
    }

    const breaches = log.filter((entry) => entry.kind === 'sla.breach');
    if (breaches.length > 0) {
      // A breach count on its own tells the player nothing they can act on.
      // Group by the cause the allocation step attributed, lead with the one
      // costing the most, and say what closes it.
      const cost = new Map<ShortfallCause, number>();
      const counts = new Map<ShortfallCause, number>();
      let penalties = 0;
      for (const entry of breaches) {
        penalties += Number(entry.data?.penalty ?? 0);
        const cause = String(entry.data?.cause ?? '') as ShortfallCause;
        if (!(cause in SHORTFALL_LABEL)) continue;
        cost.set(cause, (cost.get(cause) ?? 0) + Number(entry.data?.unservedUnitHours ?? 0));
        counts.set(cause, (counts.get(cause) ?? 0) + 1);
      }
      const worst = [...cost.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

      const others = [...counts.entries()]
        .filter(([cause]) => !worst || cause !== worst[0])
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([cause, n]) => `${n} to ${SHORTFALL_LABEL[cause]}`);

      alerts.push({
        severity: 'critical',
        title: `${breaches.length} SLA breach${breaches.length > 1 ? 'es' : ''}`
          + (penalties > 0 ? ` \u00b7 $${Math.round(penalties).toLocaleString()} in penalties` : ''),
        detail: (worst
          ? `${counts.get(worst[0]) ?? 0} of ${breaches.length} came down to `
            + `${SHORTFALL_LABEL[worst[0]]}: ${SHORTFALL_REMEDY[worst[0]]}`
            + (others.length > 0 ? ` Also ${others.join(', ')}.` : '')
          : 'Contracted capacity went unserved.')
          + ' Reputation falls with every miss, which closes off the better contracts.',
      });
    }

    const failures = log.filter((entry) => entry.kind.indexOf('failure.') === 0);
    if (failures.length >= 3) {
      alerts.push({
        severity: 'warning',
        title: `${failures.length} equipment failures`,
        detail: 'Maintenance clears the backlog with the cash and staff it has. A growing backlog raises '
          + 'the hazard on everything else.',
      });
    }

    for (const active of engine.state.activeEvents) {
      const definition = registry.all('events').get(active.definitionId);
      if (!definition) continue;
      if (active.startTick < engine.state.meta.tickIndex - ticksPerMonth) continue;
      alerts.push({
        severity: definition.eventClass === 'opportunity' ? 'good' : 'serious',
        title: definition.name,
        detail: `${definition.description ?? ''} ${definition.mitigation}`.trim(),
      });
    }

    if (company.cash <= 0) {
      alerts.push({
        severity: 'critical',
        title: 'Out of cash',
        detail: 'Operating costs are being carried on credit, which trips the insolvency gate and caps '
          + 'this year\u2019s rating at C however well everything else goes.',
      });
    } else if (operator.budget(context) <= 0) {
      alerts.push({
        severity: 'warning',
        title: 'No free capital',
        detail: 'Cash is inside the reserve the operator holds against running costs. Nothing can be '
          + 'ordered until revenue rebuilds it.',
      });
    }

    for (const year of closed) {
      alerts.push({
        severity: year.score.rating === 'D' ? 'critical'
          : year.score.rating === 'C' ? 'warning' : 'good',
        title: `${year.report.year} closed: ${year.score.rating} (${year.score.overall.toFixed(1)})`,
        detail: `${year.score.label}. PUE ${year.report.environment.pue?.toFixed(3) ?? 'n/a'}, `
          + `availability ${(year.report.reliability.availability01 * 100).toFixed(2)}%, `
          + `margin ${(year.report.financial.operatingMargin01 * 100).toFixed(0)}%.`,
      });
    }

    // Only raise the contract market when there is something the fleet could
    // actually take on. "Six offers on the table" every month, most of them
    // beyond what the halls can serve, teaches the player to ignore alerts.
    if (!operator.autopilotState().contracts) {
      let signable = 0;
      for (const offer of engine.state.contractOffers) {
        const definition = registry.contract(offer.definitionId, offer.instanceId);
        if (definition.minimumReputation > engine.state.company.reputation) continue;
        if (!definition.requiredTechnologies.every((id) => engine.state.research.completed.includes(id))) continue;
        const headroom = operator.servableFor(context, definition.workloadId) * 0.85
          - operator.reservedFor(context, definition.workloadId);
        if (offer.computeUnits <= headroom) signable += 1;
      }
      if (signable > 0) {
        alerts.push({
          severity: 'good',
          title: `${signable} contract${signable > 1 ? 's' : ''} you can serve`,
          detail: 'Your fleet has the capacity for these today. Offers leave the table after about '
            + 'three months, and capacity you do not sell earns nothing.',
        });
      }
    }

    return alerts;
  }

  function advance(ticks: number): TurnSummary {
    const before = engine.state.diagnostics.length;
    const budget = Math.min(ticks, totalTicks - ticksRun);
    if (budget > 0) ticksRun += engine.advanceTicks(budget);

    const log = engine.state.diagnostics.slice(before);
    const closed = collectYears();
    const time = new Date(engine.state.meta.gameTimeIso);
    return {
      dateIso: engine.state.meta.gameTimeIso,
      month: time.getUTCMonth() + 1,
      year: time.getUTCFullYear(),
      closedYears: closed,
      alerts: buildAlerts(log, closed),
      log,
      finished: totalTicks - ticksRun <= 0,
    };
  }

  return {
    totalYears: years,
    totalTicks,
    remainingTicks: () => Math.max(0, totalTicks - ticksRun),
    advanceMonth: () => advance(ticksPerMonth),
    advanceYear: () => advance(ticksPerYear),
    actions: () => enumerateActions(context, operator),
    act: (actionId, quantity) => applyAction(context, operator, actionId, quantity),
    autopilot: () => operator.autopilotState(),
    setAutopilot: (category, enabled) => operator.setAutopilot(category, enabled),
    years: () => collected.slice(),
    headroom: () => workloadHeadroom(context),
    projection: (horizonMonths) => projectCapacity(context, horizonMonths),
    schedule: () => commissioningSchedule(context),
    dashboard(): Dashboard {
      const state = engine.state;
      const halls = state.facilities.flatMap((f) => f.halls);
      const worstInlet = halls.reduce((worst, hall) => Math.max(worst, hall.inletTempC), 0);
      const speed = Math.max(0.1, context.modifiers.value('research.speed', 1));
      const projects = state.research.active.map((project) => {
        const technology = registry.technology(project.technologyId, 'console');
        const days = Math.max(1, technology.research.durationDays / speed);
        return {
          name: technology.name,
          progress01: Math.min(1, project.fundedUsd / Math.max(1, technology.research.costUsd)),
          specialists: project.specialists,
          costPerDay: technology.research.costUsd / days,
        };
      });
      // Sorted by room, so the first row is the honest answer to "what can I
      // sell next?".
      const headroomRows = [...workloadHeadroom(context)]
        .sort((a, b) => b.freeUnits - a.freeUnits);
      return {
        cash: state.company.cash,
        debt: state.company.debt,
        budget: operator.budget(context),
        reputation: state.company.reputation,
        trust: state.company.communityTrust,
        projects,
        freeSpecialists: freeSpecialists(context),
        totalSpecialists: totalSpecialists(context),
        itCapacityMw: halls.reduce((mw, hall) => {
          if (hall.constructionProgress01 < 1) return mw;
          return mw + hall.rackGroups.reduce((kw, group) => kw + group.count
            * context.balance.baseRackPowerKw
            * registry.hardware(group.hardwareId, group.instanceId).powerFactor, 0) / 1000;
        }, 0),
        rackCount: halls.reduce((total, hall) =>
          total + hall.rackGroups.reduce((n, group) => n + group.count, 0), 0),
        contractCount: state.contracts.length,
        committedUnits: state.contracts.reduce((total, c) => total + c.computeUnits, 0),
        freeUnits: headroomRows[0]?.freeUnits ?? 0,
        bestFitWorkload: headroomRows[0]?.name ?? null,
        staff: Math.round(state.company.staffCount),
        ambientC: state.world.weather.dryBulbC,
        worstInletC: worstInlet,
        throttling: halls.some((hall) => hall.throttle01 > 0.02),
        gridAvailable: state.world.market.gridAvailable,
        activeEvents: state.activeEvents.map((active) => {
          const definition = registry.all('events').get(active.definitionId);
          return {
            name: definition ? definition.name : active.definitionId,
            mitigation: definition ? definition.mitigation : '',
          };
        }),
      };
    },
    objectives(): ObjectiveResult[] {
      const latest = engine.annualReports.at(-1);
      return context.scenario.objectives.map((objective) => {
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
    save(): { file: SaveFile; summary: SaveSummary } {
      const file = createSave(engine, registry, { campaignYears: years });
      const scenario = context.scenario;
      const latest = engine.state.annualScores.at(-1);
      const time = new Date(engine.state.meta.gameTimeIso);
      const totalMonths = years * 12;
      const elapsed = Math.round((ticksRun / totalTicks) * totalMonths);
      return {
        file,
        summary: {
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          seed: engine.state.meta.campaignSeed,
          dateIso: engine.state.meta.gameTimeIso,
          monthLabel: time.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
          monthsElapsed: Math.min(totalMonths, elapsed),
          totalMonths,
          itCapacityMw: engine.state.facilities.flatMap((f) => f.halls)
            .filter((hall) => hall.constructionProgress01 >= 1)
            .reduce((mw, hall) => mw + hall.rackGroups.reduce((kw, group) => kw + group.count
              * context.balance.baseRackPowerKw
              * registry.hardware(group.hardwareId, group.instanceId).powerFactor, 0) / 1000, 0),
          cash: engine.state.company.cash,
          contracts: engine.state.contracts.length,
          rating: latest ? latest.rating : null,
          overall: latest ? latest.overall : null,
          manual: Object.values(operator.autopilotState()).some((on) => !on),
          contentHash: registry.contentHash(),
        },
      };
    },
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
            id: hallName(hall),
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
        const last = contract.lastPeriod;
        const ticksLeft = Math.max(0, contract.endTick - engine.state.meta.tickIndex);
        return {
          name: definition.name,
          computeUnits: contract.computeUnits,
          workload: registry.workload(definition.workloadId, definition.id).name,
          monthsLeft: ticksLeft * engine.state.meta.minutesPerTick / (60 * 24 * 30.44),
          availability01: last ? last.availability01 : null,
          required01: definition.slaUptime01,
          penalty: last ? last.penalty : 0,
          // The book is where a player looks when the alert has scrolled away,
          // so the reason travels with the row rather than only with the event.
          cause: last && last.cause
            ? `${SHORTFALL_LABEL[last.cause]} \u2014 ${SHORTFALL_REMEDY[last.cause]}`
            : null,
        };
      });
      const research = engine.state.research.completed.map((id) => {
        const technology = registry.technology(id, 'console');
        return { name: technology.name, branch: technology.branch, tier: technology.tier };
      });
      return {
        halls,
        hardware: [...hardware].map(([name, racks]) => ({ name, racks }))
          .sort((a, b) => b.racks - a.racks),
        power: power.sort((a, b) => b.capacityMw - a.capacityMw),
        contracts: contracts.sort((a, b) => b.computeUnits - a.computeUnits),
        research,
        researching: engine.state.research.active
          .map((project) => registry.technology(project.technologyId, 'console').name),
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
  restoreRun,
  decisionCategories: DECISION_CATEGORIES,
  rackOrderSizes: RACK_ORDER_SIZES,
};

(globalThis as unknown as { DCT: typeof api }).DCT = api;
export default api;
