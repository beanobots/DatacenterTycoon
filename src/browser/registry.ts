/**
 * Browser-side content registry.
 *
 * The Node importer reads the content tree from disk and validates every file
 * against its JSON Schema with ajv. Neither is available in a browser, so the
 * web build inlines the definitions at build time - after `npm run validate`
 * has already checked them against the schemas - and rebuilds the registry
 * here.
 *
 * Schema validation is therefore a BUILD step for this target rather than a
 * load step. Cross-reference validation still runs at load: it is pure, it is
 * the half that catches a dangling prerequisite or an unnormalised score
 * weight, and the console surfaces its report.
 */

import { ContentRegistry, deepFreeze, type ContentKind } from '../content/registry.js';
import { validateContent, type ValidationReport } from '../content/validator.js';
import type { ContentRegistrySnapshot } from '../definitions/types.js';

/** One definition plus the source file it came from, for error messages. */
export interface BundledDefinition {
  readonly file: string;
  readonly definition: { id: string };
}

export type BundledContent = Record<ContentKind, readonly BundledDefinition[]>;

export interface BrowserContent {
  readonly registry: ContentRegistry;
  readonly report: ValidationReport;
  readonly definitionCount: number;
}

export function buildBrowserRegistry(bundle: BundledContent): BrowserContent {
  const maps = {} as Record<ContentKind, Map<string, unknown>>;
  const sources = new Map<string, string>();
  let definitionCount = 0;

  for (const kind of Object.keys(bundle) as ContentKind[]) {
    const map = new Map<string, unknown>();
    for (const { file, definition } of bundle[kind]) {
      map.set(definition.id, deepFreeze(definition));
      sources.set(definition.id, file);
      definitionCount += 1;
    }
    maps[kind] = map;
  }

  const registry = new ContentRegistry(maps as unknown as ContentRegistrySnapshot, sources);
  const report = validateContent(registry, { errors: [], warnings: [] });
  return { registry, report, definitionCount };
}
