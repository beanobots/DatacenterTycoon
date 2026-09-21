/**
 * The immutable content registry.
 *
 * Spec chapter 11: "Definitions are immutable after campaign load." Every
 * definition handed out here is deep-frozen, and every lookup either returns a
 * definition or throws an error naming the missing ID - acceptance criterion 11
 * ("Runtime errors identify exact file and field") and the chapter 14 assertion
 * "No failed definition lookup".
 */

import type {
  BalanceProfileDefinition,
  ContentRegistrySnapshot,
  ContractDefinition,
  CoolingTechnologyDefinition,
  EventDefinition,
  HardwareDefinition,
  PowerSourceDefinition,
  RegionDefinition,
  ScenarioDefinition,
  ScoreProfileDefinition,
  TechnologyDefinition,
  WorkloadDefinition,
} from '../definitions/types.js';

export type ContentKind = keyof ContentRegistrySnapshot;

/** Recursively freezes an imported definition so no system can mutate content. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

export class DefinitionLookupError extends Error {
  constructor(
    readonly kind: ContentKind,
    readonly id: string,
    readonly referencedBy?: string,
  ) {
    const from = referencedBy ? ` (referenced by ${referencedBy})` : '';
    super(`No ${kind} definition with id "${id}"${from}`);
    this.name = 'DefinitionLookupError';
  }
}

export class ContentRegistry {
  private readonly maps: ContentRegistrySnapshot;
  /** Source file for each ID, so errors can name the exact file. */
  private readonly sources: ReadonlyMap<string, string>;

  constructor(snapshot: ContentRegistrySnapshot, sources: ReadonlyMap<string, string>) {
    this.maps = snapshot;
    this.sources = sources;
  }

  sourceFile(id: string): string {
    return this.sources.get(id) ?? '<unknown file>';
  }

  private lookup<K extends ContentKind>(
    kind: K,
    id: string,
    referencedBy?: string,
  ): ContentRegistrySnapshot[K] extends ReadonlyMap<string, infer V> ? V : never {
    const found = (this.maps[kind] as ReadonlyMap<string, unknown>).get(id);
    if (found === undefined) throw new DefinitionLookupError(kind, id, referencedBy);
    return found as never;
  }

  region(id: string, referencedBy?: string): RegionDefinition {
    return this.lookup('regions', id, referencedBy);
  }
  cooling(id: string, referencedBy?: string): CoolingTechnologyDefinition {
    return this.lookup('cooling', id, referencedBy);
  }
  power(id: string, referencedBy?: string): PowerSourceDefinition {
    return this.lookup('power', id, referencedBy);
  }
  hardware(id: string, referencedBy?: string): HardwareDefinition {
    return this.lookup('hardware', id, referencedBy);
  }
  workload(id: string, referencedBy?: string): WorkloadDefinition {
    return this.lookup('workloads', id, referencedBy);
  }
  contract(id: string, referencedBy?: string): ContractDefinition {
    return this.lookup('contracts', id, referencedBy);
  }
  technology(id: string, referencedBy?: string): TechnologyDefinition {
    return this.lookup('technologies', id, referencedBy);
  }
  event(id: string, referencedBy?: string): EventDefinition {
    return this.lookup('events', id, referencedBy);
  }
  scenario(id: string, referencedBy?: string): ScenarioDefinition {
    return this.lookup('scenarios', id, referencedBy);
  }
  scoreProfile(id: string, referencedBy?: string): ScoreProfileDefinition {
    return this.lookup('scoreProfiles', id, referencedBy);
  }
  balanceProfile(id: string, referencedBy?: string): BalanceProfileDefinition {
    return this.lookup('balanceProfiles', id, referencedBy);
  }

  all<K extends ContentKind>(kind: K): ContentRegistrySnapshot[K] {
    return this.maps[kind];
  }

  get counts(): Record<ContentKind, number> {
    const out = {} as Record<ContentKind, number>;
    for (const kind of Object.keys(this.maps) as ContentKind[]) {
      out[kind] = (this.maps[kind] as ReadonlyMap<string, unknown>).size;
    }
    return out;
  }

  /**
   * A stable digest of every definition ID and schema version. Saves record it
   * so loading a save against changed content is detectable.
   */
  contentHash(): string {
    const parts: string[] = [];
    for (const kind of Object.keys(this.maps).sort() as ContentKind[]) {
      const map = this.maps[kind] as ReadonlyMap<string, { schemaVersion: number }>;
      for (const id of [...map.keys()].sort()) {
        parts.push(`${kind}:${id}:${map.get(id)?.schemaVersion ?? 0}`);
      }
    }
    // FNV-1a over the joined manifest. Enough to spot content drift.
    let hash = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(parts.join('|'))) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }
}
