/**
 * Save and load.
 *
 * Acceptance criteria 3 and 6: the same seed and inputs produce the same
 * results, and save migrations support at least two prior schema versions.
 *
 * A save carries the random-stream state (chapter 9: "Persist random-stream
 * state in saves"), so a restored campaign continues the same sequence rather
 * than re-rolling from the campaign seed. It also carries a content hash, so
 * loading a save against changed content is detectable rather than silently
 * wrong.
 */

import type { ContentRegistry } from '../content/registry.js';
import type { GameState } from '../state/types.js';
import { SimulationEngine } from '../sim/engine.js';
import type { AutopilotState, StrategyName } from '../sim/operator.js';
import { migrate, SAVE_VERSION } from './migrations.js';

export interface SaveFile {
  readonly saveVersion: number;
  readonly migrationHistory: readonly string[];
  readonly createdUtc: string;
  readonly scenarioId: string;
  readonly campaignSeed: string;
  readonly tickIndex: number;
  readonly contentHash: string;
  readonly strategy: StrategyName;
  /** Which decisions the heuristic was holding, so a resumed campaign plays the same. */
  readonly autopilot: AutopilotState;
  /** Campaign length in years, so a resumed campaign ends where it was going to. */
  readonly campaignYears: number;
  readonly state: GameState;
}

export interface SaveOptions {
  /**
   * Diagnostics to keep, newest first. The log is write-only - nothing in the
   * simulation reads it - so trimming changes no outcome, and leaving it whole
   * is what makes a save too large to store: at fifteen years the log is 746 KB
   * of a 776 KB save, against a 256 KB ceiling.
   */
  readonly maxDiagnostics?: number;
  /** Campaign length in years. Defaults to the scenario's own duration. */
  readonly campaignYears?: number;
}

/** Diagnostics a save keeps when the caller does not say. */
export const DEFAULT_SAVE_DIAGNOSTICS = 150;

export function createSave(
  engine: SimulationEngine,
  registry: ContentRegistry,
  options: SaveOptions = {},
): SaveFile {
  const state = engine.state;
  // Round-trip through JSON so the save holds plain data with no live
  // references into the running simulation.
  const snapshot = JSON.parse(JSON.stringify(state)) as GameState;
  const keep = options.maxDiagnostics ?? DEFAULT_SAVE_DIAGNOSTICS;
  if (keep >= 0 && snapshot.diagnostics.length > keep) {
    snapshot.diagnostics = snapshot.diagnostics.slice(-keep);
  }

  return {
    saveVersion: SAVE_VERSION,
    migrationHistory: [],
    createdUtc: new Date().toISOString(),
    scenarioId: state.meta.scenarioId,
    campaignSeed: state.meta.campaignSeed,
    tickIndex: state.meta.tickIndex,
    contentHash: registry.contentHash(),
    strategy: engine.strategy,
    autopilot: engine.operator.autopilotState(),
    campaignYears: options.campaignYears
      ?? registry.scenario(state.meta.scenarioId, '<save>').durationYears,
    state: snapshot,
  };
}

/**
 * `pretty` is for a file a person will read. Storage wants compact: the
 * indentation alone is a third of the bytes, and a stored document has a hard
 * size ceiling.
 */
export function serializeSave(save: SaveFile, pretty = true): string {
  return pretty ? JSON.stringify(save, null, 2) : JSON.stringify(save);
}

export interface LoadResult {
  readonly engine: SimulationEngine;
  /** Campaign length the save was configured with. */
  readonly campaignYears: number;
  /** Set when the save was written against different content. */
  readonly contentMismatch: boolean;
  readonly appliedMigrations: readonly string[];
}

export function loadSave(text: string, registry: ContentRegistry): LoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Save file is not valid JSON: ${(cause as Error).message}`);
  }
  return restoreSave(parsed as SaveFile, registry);
}

export function restoreSave(save: SaveFile, registry: ContentRegistry): LoadResult {
  if (typeof save?.saveVersion !== 'number') {
    throw new Error('Save file has no saveVersion; it cannot be migrated safely');
  }
  const migrated = migrate(save);

  // Migration 010 marks contracts and offers whose promised availability the
  // save never stored; like the research budget below, the figure lives in the
  // content and so can only be filled in here.
  for (const row of [...migrated.save.state.contracts ?? [],
    ...migrated.save.state.contractOffers ?? []]) {
    const loose = row as unknown as { slaUptime01: number | null; definitionId: string };
    if (loose.slaUptime01 === null || loose.slaUptime01 === undefined) {
      loose.slaUptime01 = registry.all('contracts').get(loose.definitionId)?.slaUptime01 ?? 0.99;
    }
  }

  // Migration 009 marks research projects whose budget the save never stored;
  // the figure comes from the content, which only exists here.
  for (const project of migrated.save.state.research?.active ?? []) {
    const loose = project as unknown as { budgetUsd: number | null };
    if (loose.budgetUsd === null || loose.budgetUsd === undefined) {
      const technology = registry.all('technologies').get(project.technologyId);
      loose.budgetUsd = technology?.research.costUsd ?? 0;
    }
  }

  const engine = new SimulationEngine(registry, {
    scenarioId: migrated.save.scenarioId,
    campaignSeed: migrated.save.campaignSeed,
    minutesPerTick: migrated.save.state.meta.minutesPerTick,
    strategy: migrated.save.strategy,
    ...(migrated.save.autopilot ? { autopilot: migrated.save.autopilot } : {}),
    restoreState: migrated.save.state,
  });

  return {
    engine,
    campaignYears: migrated.save.campaignYears
      ?? registry.scenario(migrated.save.scenarioId, '<save>').durationYears,
    contentMismatch: migrated.save.contentHash !== registry.contentHash(),
    appliedMigrations: migrated.applied,
  };
}
