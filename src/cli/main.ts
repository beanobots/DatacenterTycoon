#!/usr/bin/env -S node --experimental-strip-types
/**
 * Headless command line.
 *
 * Spec chapter 11: "Headless simulation must run without opening a gameplay
 * scene." This is the entry point that proves it - content validation, campaign
 * runs, annual reports, telemetry export and save round-trips, with no
 * presentation layer anywhere beneath it.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { importContent } from '../content/importer.js';
import { validateContent } from '../content/validator.js';
import type { ContentRegistry } from '../content/registry.js';
import { SimulationEngine } from '../sim/engine.js';
import { STRATEGIES, type StrategyName } from '../sim/operator.js';
import { createSave, loadSave, serializeSave } from '../save/save.js';
import type { AnnualReport } from '../sim/report.js';
import type { AnnualScore } from '../state/types.js';

interface Options {
  readonly command: string;
  readonly content: string;
  readonly scenario: string;
  readonly seed: string;
  readonly years: number | null;
  readonly strategy: StrategyName;
  readonly out: string | null;
  readonly save: string | null;
  readonly load: string | null;
  readonly quiet: boolean;
  readonly diagnostics: number;
}

const USAGE = `DatacenterTycoon headless simulation

Usage:
  dct validate [--content <dir>]
  dct run --scenario <id> [options]
  dct scenarios [--content <dir>]
  dct golden [--content <dir>] [--years <n>]

Options:
  --content <dir>    Content root (default: ./content)
  --scenario <id>    Scenario definition ID (default: scenario.dry_grid)
  --seed <text>      Campaign seed (default: "default")
  --years <n>        Years to simulate (default: the scenario's own duration)
  --strategy <name>  Operator strategy: ${Object.keys(STRATEGIES).join(', ')} (default: balanced)
  --out <file>       Write annual reports and scores as JSON
  --save <file>      Write a save file at the end of the run
  --load <file>      Restore a save and continue from it
  --diagnostics <n>  Print the last n diagnostic entries (default: 0)
  --quiet            Suppress the per-year table
`;

function parseArgs(argv: readonly string[]): Options {
  const args = [...argv];
  const command = args[0]?.startsWith('--') || args[0] === undefined ? 'help' : args.shift() as string;
  const flag = (name: string): string | null => {
    const index = args.indexOf(`--${name}`);
    if (index === -1) return null;
    return args[index + 1] ?? null;
  };
  const has = (name: string): boolean => args.includes(`--${name}`);

  const strategy = (flag('strategy') ?? 'balanced') as StrategyName;
  if (!(strategy in STRATEGIES)) {
    throw new Error(`Unknown strategy "${strategy}". Known: ${Object.keys(STRATEGIES).join(', ')}`);
  }
  const yearsText = flag('years');

  return {
    command,
    content: flag('content') ?? 'content',
    scenario: flag('scenario') ?? 'scenario.dry_grid',
    seed: flag('seed') ?? 'default',
    years: yearsText === null ? null : Number(yearsText),
    strategy,
    out: flag('out'),
    save: flag('save'),
    load: flag('load'),
    quiet: has('quiet'),
    diagnostics: Number(flag('diagnostics') ?? 0),
  };
}

/** Loads content and refuses to continue while any error remains. */
function loadContentOrExit(contentRoot: string, quiet = false): ContentRegistry {
  const imported = importContent(contentRoot);
  const report = validateContent(imported.registry, imported);

  for (const issue of report.errors) {
    console.error(`error  ${issue.file}${issue.field ? ` [${issue.field}]` : ''}: ${issue.message}`);
  }
  if (!report.ok) {
    console.error(`\n${report.errors.length} content error(s). Campaign cannot start.`);
    process.exit(1);
  }
  if (!quiet) {
    for (const issue of report.warnings) {
      console.warn(`warn   ${issue.file}${issue.field ? ` [${issue.field}]` : ''}: ${issue.message}`);
    }
  }
  return imported.registry;
}

function commandValidate(options: Options): void {
  const imported = importContent(options.content);
  const report = validateContent(imported.registry, imported);

  for (const issue of report.errors) {
    console.error(`error  ${issue.file}${issue.field ? ` [${issue.field}]` : ''}: ${issue.message}`);
  }
  for (const issue of report.warnings) {
    console.warn(`warn   ${issue.file}${issue.field ? ` [${issue.field}]` : ''}: ${issue.message}`);
  }

  const counts = imported.registry.counts;
  console.log(`\nRead ${imported.fileCount} files from ${resolve(options.content)}`);
  for (const [kind, count] of Object.entries(counts)) {
    console.log(`  ${kind.padEnd(16)} ${String(count).padStart(4)}`);
  }
  console.log(`  content hash     ${imported.registry.contentHash()}`);
  console.log(`\n${report.errors.length} error(s), ${report.warnings.length} warning(s)`);
  process.exit(report.ok ? 0 : 1);
}

function commandScenarios(options: Options): void {
  const registry = loadContentOrExit(options.content, true);
  for (const scenario of registry.all('scenarios').values()) {
    const region = registry.region(scenario.regionId, scenario.id);
    console.log(`${scenario.id}`);
    console.log(`  ${scenario.name} - ${region.name} (${region.archetype}), ${scenario.durationYears}y, ${scenario.difficulty}`);
    console.log(`  target ${scenario.targetCapacityMw} MW, min availability ${(scenario.minimumAvailability01 * 100).toFixed(1)}%`);
    for (const objective of scenario.objectives) {
      console.log(`    - ${objective.description} (by ${objective.byYear})`);
    }
  }
}

function formatReportRow(report: AnnualReport, score: AnnualScore | undefined): string {
  const pad = (value: string | number, width: number) => String(value).padStart(width);
  return [
    pad(report.year, 4),
    pad(report.capacity.itCapacityMw.toFixed(2), 7) + ' MW',
    pad(report.environment.pue?.toFixed(3) ?? '  n/a', 7),
    pad(report.environment.cue?.toFixed(0) ?? 'n/a', 6),
    pad(report.environment.wue?.toFixed(3) ?? '  n/a', 7),
    pad((report.reliability.availability01 * 100).toFixed(3) + '%', 9),
    pad((report.financial.revenue / 1e6).toFixed(1) + 'M', 9),
    pad((report.financial.operatingMargin01 * 100).toFixed(0) + '%', 6),
    pad((report.financial.cash / 1e6).toFixed(0) + 'M', 8),
    pad(report.social.trust.toFixed(0), 6),
    pad(score ? `${score.rating} ${score.overall.toFixed(1)}` : '', 9),
  ].join(' ');
}

function commandRun(options: Options): void {
  const registry = loadContentOrExit(options.content, options.quiet);

  let engine: SimulationEngine;
  if (options.load) {
    const result = loadSave(readFileSync(options.load, 'utf8'), registry);
    engine = result.engine;
    if (result.appliedMigrations.length > 0) {
      console.log(`Applied save migrations: ${result.appliedMigrations.join(', ')}`);
    }
    if (result.contentMismatch) {
      console.warn('warn   Save was written against different content; results may diverge.');
    }
    console.log(`Restored ${engine.state.meta.scenarioId} at tick ${engine.state.meta.tickIndex} (${engine.state.meta.gameTimeIso.slice(0, 10)})`);
  } else {
    engine = new SimulationEngine(registry, {
      scenarioId: options.scenario,
      campaignSeed: options.seed,
      strategy: options.strategy,
    });
  }

  const scenario = engine.context.scenario;
  const years = options.years ?? scenario.durationYears;
  const started = Date.now();
  const ticks = engine.runYears(years);
  const elapsed = (Date.now() - started) / 1000;

  if (!options.quiet) {
    console.log(`\n${scenario.name} - ${engine.context.region.name}`);
    console.log(`seed "${engine.state.meta.campaignSeed}", strategy "${engine.strategy}", ${years} years, ${ticks} ticks in ${elapsed.toFixed(1)}s\n`);
    console.log('year      IT cap     PUE    CUE     WUE   avail      revenue    mgn     cash  trust     score');
    console.log('-'.repeat(96));
    for (const report of engine.annualReports) {
      const score = engine.state.annualScores.find((s) => s.year === report.year);
      console.log(formatReportRow(report, score));
    }
  }

  printObjectives(engine);

  if (options.diagnostics > 0) {
    console.log('\nRecent diagnostics');
    for (const entry of engine.state.diagnostics.slice(-options.diagnostics)) {
      console.log(`  ${entry.timeIso.slice(0, 10)}  ${entry.kind.padEnd(28)} ${entry.message}`);
    }
  }

  if (options.out) {
    writeJson(options.out, {
      scenarioId: scenario.id,
      seed: engine.state.meta.campaignSeed,
      strategy: engine.strategy,
      contentHash: registry.contentHash(),
      reports: engine.annualReports,
      scores: engine.state.annualScores,
      diagnostics: engine.state.diagnostics,
    });
    console.log(`\nWrote telemetry to ${options.out}`);
  }

  if (options.save) {
    writeFile(options.save, serializeSave(createSave(engine, registry)));
    console.log(`Wrote save to ${options.save}`);
  }
}

/** Reports objective progress against the scenario's own definitions. */
function printObjectives(engine: SimulationEngine): void {
  const scenario = engine.context.scenario;
  if (scenario.objectives.length === 0) return;
  const latest = engine.annualReports.at(-1);
  if (!latest) return;

  console.log('\nObjectives');
  for (const objective of scenario.objectives) {
    const value = readReportMetric(latest, objective.metric);
    const met = value !== null && compare(value, objective.comparison, objective.target);
    const shown = value === null ? 'n/a' : value.toFixed(4).replace(/\.?0+$/, '');
    console.log(`  [${met ? 'x' : ' '}] ${objective.description}  (${objective.metric} = ${shown}, target ${objective.comparison} ${objective.target})`);
  }
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

/** Resolves a dotted objective metric against an annual report. */
export function readReportMetric(report: AnnualReport, metric: string): number | null {
  const parts = metric.split('.');
  let current: unknown = report;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'number' ? current : null;
}

/** Runs every scenario once - the chapter 14 golden scenario sweep. */
function commandGolden(options: Options): void {
  const registry = loadContentOrExit(options.content, true);
  const rows: string[] = [];
  let failures = 0;

  for (const scenario of registry.all('scenarios').values()) {
    const engine = new SimulationEngine(registry, {
      scenarioId: scenario.id,
      campaignSeed: options.seed,
      strategy: options.strategy,
    });
    engine.runYears(options.years ?? scenario.durationYears);
    const last = engine.annualReports.at(-1);
    const score = engine.state.annualScores.at(-1);
    if (!last || !score) {
      console.error(`error  ${scenario.id} produced no annual report`);
      failures += 1;
      continue;
    }
    rows.push([
      scenario.id.padEnd(26),
      `${last.capacity.itCapacityMw.toFixed(2).padStart(6)} MW`,
      `PUE ${(last.environment.pue?.toFixed(3) ?? 'n/a').padStart(5)}`,
      `WUE ${(last.environment.wue?.toFixed(3) ?? 'n/a').padStart(5)}`,
      `avail ${(last.reliability.availability01 * 100).toFixed(2).padStart(6)}%`,
      `${score.rating.padStart(2)} ${score.overall.toFixed(1).padStart(5)}`,
    ].join('  '));
  }

  console.log('scenario                       capacity       PUE        WUE        availability   score');
  console.log('-'.repeat(88));
  for (const row of rows) console.log(row);
  process.exit(failures > 0 ? 1 : 0);
}

function writeJson(path: string, value: unknown): void {
  writeFile(path, JSON.stringify(value, null, 2));
}

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, text);
}

function main(): void {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }

  switch (options.command) {
    case 'validate': commandValidate(options); break;
    case 'run': commandRun(options); break;
    case 'scenarios': commandScenarios(options); break;
    case 'golden': commandGolden(options); break;
    default:
      console.log(USAGE);
      process.exit(options.command === 'help' ? 0 : 2);
  }
}

main();
