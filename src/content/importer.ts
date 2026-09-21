/**
 * Content import: DTO parsing, JSON Schema validation, unit normalisation.
 *
 * Spec chapter 11 layering: Content (JSON + schema) -> Import (DTO parsing +
 * cross-reference validation + unit normalisation) -> Definitions (immutable).
 * This module covers the import step and hands the validator a registry.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import type { ContentKind } from './registry.js';
import { ContentRegistry, deepFreeze } from './registry.js';
import type { ContentRegistrySnapshot } from '../definitions/types.js';

export interface ImportIssue {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly file: string;
  /** Dotted path to the offending field, when the issue has one. */
  readonly field?: string;
  readonly message: string;
}

export interface ImportResult {
  readonly registry: ContentRegistry;
  readonly errors: readonly ImportIssue[];
  readonly warnings: readonly ImportIssue[];
  readonly fileCount: number;
}

/** Content directory -> the schema that validates it and its registry slot. */
const CONTENT_DIRECTORIES: ReadonlyArray<{ dir: string; schema: string; kind: ContentKind }> = [
  { dir: 'regions', schema: 'region.schema.json', kind: 'regions' },
  { dir: 'cooling', schema: 'cooling-technology.schema.json', kind: 'cooling' },
  { dir: 'power', schema: 'power-source.schema.json', kind: 'power' },
  { dir: 'hardware', schema: 'hardware.schema.json', kind: 'hardware' },
  { dir: 'workloads', schema: 'workload.schema.json', kind: 'workloads' },
  { dir: 'contracts', schema: 'contract.schema.json', kind: 'contracts' },
  { dir: 'technologies', schema: 'technology.schema.json', kind: 'technologies' },
  { dir: 'events', schema: 'event.schema.json', kind: 'events' },
  { dir: 'scenarios', schema: 'scenario.schema.json', kind: 'scenarios' },
];

/** Profiles share one directory and are routed by their ID prefix. */
const PROFILE_ROUTING: ReadonlyArray<{ prefix: string; schema: string; kind: ContentKind }> = [
  { prefix: 'score.', schema: 'score-profile.schema.json', kind: 'scoreProfiles' },
  { prefix: 'balance.', schema: 'balance-profile.schema.json', kind: 'balanceProfiles' },
];

function emptySnapshot(): { [K in ContentKind]: Map<string, unknown> } {
  return {
    regions: new Map(), cooling: new Map(), power: new Map(), hardware: new Map(),
    workloads: new Map(), contracts: new Map(), technologies: new Map(), events: new Map(),
    scenarios: new Map(), scoreProfiles: new Map(), balanceProfiles: new Map(),
  };
}

/** Compiles every schema once, resolving the relative $refs between them. */
function buildValidators(schemaDir: string): Map<string, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  const files = readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'));
  for (const file of files) {
    const schema = JSON.parse(readFileSync(join(schemaDir, file), 'utf8')) as object;
    // Register under the bare filename so "common.schema.json#/$defs/x" resolves.
    ajv.addSchema(schema, file);
  }
  const validators = new Map<string, ValidateFunction>();
  for (const file of files) {
    const validate = ajv.getSchema(file);
    if (validate) validators.set(file, validate as ValidateFunction);
  }
  return validators;
}

/**
 * Reads every content file under `contentRoot`, validates it against its
 * schema, and returns a registry plus any issues found. Import never throws on
 * bad content: it collects issues so the validator report can show all of them
 * at once. A campaign refuses to start while `errors` is non-empty.
 */
export function importContent(contentRoot: string): ImportResult {
  const root = resolve(contentRoot);
  const schemaDir = join(root, 'schemas');
  if (!existsSync(schemaDir)) {
    throw new Error(`Content root "${root}" has no schemas/ directory`);
  }
  const validators = buildValidators(schemaDir);
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const maps = emptySnapshot();
  const sources = new Map<string, string>();
  let fileCount = 0;

  const ingest = (filePath: string, schemaFile: string, kind: ContentKind): void => {
    const shortPath = relative(root, filePath);
    fileCount += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (cause) {
      errors.push({
        severity: 'error', code: 'invalid_json', file: shortPath,
        message: `File is not valid JSON: ${(cause as Error).message}`,
      });
      return;
    }

    const validate = validators.get(schemaFile);
    if (!validate) {
      errors.push({
        severity: 'error', code: 'missing_schema', file: shortPath,
        message: `Schema "${schemaFile}" is not loaded`,
      });
      return;
    }
    if (!validate(parsed)) {
      for (const err of validate.errors ?? []) {
        errors.push({
          severity: 'error', code: 'schema_violation', file: shortPath,
          field: err.instancePath.replace(/^\//, '').replace(/\//g, '.') || undefined,
          message: `${err.instancePath || '<root>'} ${err.message ?? 'failed validation'}`,
        });
      }
      return;
    }

    const definition = parsed as { id: string };
    const target = maps[kind];
    if (target.has(definition.id)) {
      errors.push({
        severity: 'error', code: 'duplicate_id', file: shortPath, field: 'id',
        message: `Duplicate permanent ID "${definition.id}", already defined in ${sources.get(definition.id)}`,
      });
      return;
    }
    target.set(definition.id, deepFreeze(definition));
    sources.set(definition.id, shortPath);
  };

  for (const { dir, schema, kind } of CONTENT_DIRECTORIES) {
    const dirPath = join(root, dir);
    if (!existsSync(dirPath)) continue;
    for (const file of readdirSync(dirPath).filter((f) => f.endsWith('.json')).sort()) {
      ingest(join(dirPath, file), schema, kind);
    }
  }

  const profileDir = join(root, 'profiles');
  if (existsSync(profileDir)) {
    for (const file of readdirSync(profileDir).filter((f) => f.endsWith('.json')).sort()) {
      const route = PROFILE_ROUTING.find((r) => file.startsWith(r.prefix));
      if (!route) {
        warnings.push({
          severity: 'warning', code: 'unrouted_profile', file: relative(root, join(profileDir, file)),
          message: `Profile file does not start with a known prefix (${PROFILE_ROUTING.map((r) => r.prefix).join(', ')}) and was skipped`,
        });
        continue;
      }
      ingest(join(profileDir, file), route.schema, route.kind);
    }
  }

  const snapshot = {
    regions: maps.regions, cooling: maps.cooling, power: maps.power, hardware: maps.hardware,
    workloads: maps.workloads, contracts: maps.contracts, technologies: maps.technologies,
    events: maps.events, scenarios: maps.scenarios, scoreProfiles: maps.scoreProfiles,
    balanceProfiles: maps.balanceProfiles,
  } as unknown as ContentRegistrySnapshot;

  return { registry: new ContentRegistry(snapshot, sources), errors, warnings, fileCount };
}
