/**
 * Content pipeline tests.
 *
 * Acceptance criteria 1, 2 and 11: definitions validate against versioned
 * schemas, references resolve before campaign start, and runtime errors
 * identify the exact file and field.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importContent } from '../src/content/importer.js';
import { validateContent } from '../src/content/validator.js';
import { DefinitionLookupError } from '../src/content/registry.js';

const CONTENT = 'content';

/** Copies the shipped content into a temp dir so a test can corrupt one file. */
function contentCopyWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dct-content-'));
  cpSync(CONTENT, dir, { recursive: true });
  for (const [relative, value] of Object.entries(files)) {
    const target = join(dir, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  return dir;
}

describe('content import', () => {
  it('imports the shipped content with no errors or warnings', () => {
    const imported = importContent(CONTENT);
    const report = validateContent(imported.registry, imported);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('loads every content kind', () => {
    const { registry } = importContent(CONTENT);
    const counts = registry.counts;
    for (const [kind, count] of Object.entries(counts)) {
      expect(count, `${kind} should not be empty`).toBeGreaterThan(0);
    }
  });

  it('produces a stable content hash', () => {
    expect(importContent(CONTENT).registry.contentHash())
      .toBe(importContent(CONTENT).registry.contentHash());
  });

  it('deep-freezes definitions so no system can mutate content', () => {
    const { registry } = importContent(CONTENT);
    const cooling = registry.cooling('cooling.basic_air');
    expect(Object.isFrozen(cooling)).toBe(true);
    expect(() => {
      (cooling as unknown as { energyFactor: number }).energyFactor = 99;
    }).toThrow();
  });
});

describe('schema validation blocks invalid data', () => {
  it('rejects a missing required field and names the file', () => {
    const dir = contentCopyWith({
      'cooling/cooling.broken.json': {
        id: 'cooling.broken', schemaVersion: 1, name: 'Broken',
        // every other required field omitted
      },
    });
    try {
      const imported = importContent(dir);
      const errors = imported.errors.filter((e) => e.file.includes('cooling.broken'));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.code).toBe('schema_violation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a duplicate permanent ID', () => {
    const dir = contentCopyWith({
      'cooling/zz-duplicate.json': JSON.stringify(
        JSON.parse(require('node:fs').readFileSync(join(CONTENT, 'cooling/cooling.basic_air.json'), 'utf8')),
      ),
    });
    try {
      const imported = importContent(dir);
      expect(imported.errors.some((e) => e.code === 'duplicate_id')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed JSON with the file named', () => {
    const dir = contentCopyWith({ 'cooling/cooling.bad.json': '{ not json' });
    try {
      const imported = importContent(dir);
      const error = imported.errors.find((e) => e.code === 'invalid_json');
      expect(error?.file).toContain('cooling.bad.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cross-reference validation', () => {
  it('rejects an unknown prerequisite', () => {
    const dir = contentCopyWith({
      'technologies/technology.test.dangling.json': {
        id: 'technology.test.dangling', schemaVersion: 1, name: 'Dangling',
        branch: 'efficiency', tier: 1,
        research: { costUsd: 100000, durationDays: 10, minimumCompanyLevel: 0, requiredSpecialists: 1 },
        prerequisites: ['technology.does.not_exist'],
        effects: [], unlocks: {}, tradeOff: 'none',
      },
    });
    try {
      const imported = importContent(dir);
      const report = validateContent(imported.registry, imported);
      const error = report.errors.find((e) => e.code === 'unknown_reference');
      expect(error?.message).toContain('technology.does.not_exist');
      expect(report.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a technology dependency cycle', () => {
    const base = {
      schemaVersion: 1, branch: 'efficiency', tier: 1,
      research: { costUsd: 100000, durationDays: 10, minimumCompanyLevel: 0, requiredSpecialists: 1 },
      effects: [], unlocks: {}, tradeOff: 'none',
    };
    const dir = contentCopyWith({
      'technologies/technology.test.loop_a.json': { ...base, id: 'technology.test.loop_a', name: 'Loop A', prerequisites: ['technology.test.loop_b'] },
      'technologies/technology.test.loop_b.json': { ...base, id: 'technology.test.loop_b', name: 'Loop B', prerequisites: ['technology.test.loop_a'] },
    });
    try {
      const imported = importContent(dir);
      const report = validateContent(imported.registry, imported);
      expect(report.errors.some((e) => e.code === 'dependency_cycle')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects score weights that do not sum to 1', () => {
    const profile = JSON.parse(
      require('node:fs').readFileSync(join(CONTENT, 'profiles/score.default.json'), 'utf8'),
    ) as { id: string; weights: Record<string, number> };
    profile.id = 'score.broken';
    profile.weights.financial = 0.5;
    const dir = contentCopyWith({ 'profiles/score.broken.json': profile });
    try {
      const imported = importContent(dir);
      const report = validateContent(imported.registry, imported);
      expect(report.errors.some((e) => e.code === 'weights_not_normalised')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a unit incompatibility in a cooling definition', () => {
    const cooling = JSON.parse(
      require('node:fs').readFileSync(join(CONTENT, 'cooling/cooling.chilled_water.json'), 'utf8'),
    ) as Record<string, unknown>;
    cooling.id = 'cooling.inverted';
    cooling.energyFactorBest = 9; // best must not exceed the nominal factor
    const dir = contentCopyWith({ 'cooling/cooling.inverted.json': cooling });
    try {
      const imported = importContent(dir);
      const report = validateContent(imported.registry, imported);
      expect(report.errors.some((e) => e.code === 'unit_incompatibility')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('registry lookups', () => {
  it('names the missing ID and the referrer', () => {
    const { registry } = importContent(CONTENT);
    expect(() => registry.hardware('hardware.nope', 'test-case')).toThrow(DefinitionLookupError);
    try {
      registry.hardware('hardware.nope', 'test-case');
    } catch (error) {
      expect((error as Error).message).toContain('hardware.nope');
      expect((error as Error).message).toContain('test-case');
    }
  });
});
