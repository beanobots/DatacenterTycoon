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
import type { StrategyName } from '../sim/operator.js';
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
  readonly state: GameState;
}

export function createSave(engine: SimulationEngine, registry: ContentRegistry): SaveFile {
  const state = engine.state;
  return {
    saveVersion: SAVE_VERSION,
    migrationHistory: [],
    createdUtc: new Date().toISOString(),
    scenarioId: state.meta.scenarioId,
    campaignSeed: state.meta.campaignSeed,
    tickIndex: state.meta.tickIndex,
    contentHash: registry.contentHash(),
    strategy: engine.strategy,
    // Round-trip through JSON so the save holds plain data with no live
    // references into the running simulation.
    state: JSON.parse(JSON.stringify(state)) as GameState,
  };
}

export function serializeSave(save: SaveFile): string {
  return JSON.stringify(save, null, 2);
}

export interface LoadResult {
  readonly engine: SimulationEngine;
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

  const engine = new SimulationEngine(registry, {
    scenarioId: migrated.save.scenarioId,
    campaignSeed: migrated.save.campaignSeed,
    minutesPerTick: migrated.save.state.meta.minutesPerTick,
    strategy: migrated.save.strategy,
    restoreState: migrated.save.state,
  });

  return {
    engine,
    contentMismatch: migrated.save.contentHash !== registry.contentHash(),
    appliedMigrations: migrated.applied,
  };
}
