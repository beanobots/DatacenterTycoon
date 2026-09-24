/**
 * The modifier stack.
 *
 * Technologies (chapter 8), events (chapter 13) and policies all express their
 * effects as `{target, operation, value, priority}`. This resolves a target to
 * a single number by applying its modifiers in priority order, lowest first,
 * so competing content resolves deterministically regardless of load order.
 *
 * Targets are documented in docs/MODIFIER-TARGETS.md; `describe()` returns the
 * contributing modifiers so a score or cost can be decomposed for the player -
 * acceptance criterion 7, "Every score decomposes into contributing values".
 */

import type { Modifier } from '../definitions/types.js';
import { assertFinite } from '../core/math.js';

export interface ModifierSource {
  /** Definition ID that contributed the modifier, for the explanation drawer. */
  readonly sourceId: string;
  readonly modifier: Modifier;
}

export interface ModifierBreakdown {
  readonly target: string;
  readonly base: number;
  readonly result: number;
  readonly steps: ReadonlyArray<{ sourceId: string; operation: string; value: number; after: number }>;
}

export class ModifierStack {
  private readonly byTarget = new Map<string, ModifierSource[]>();
  /** Invalidated on every mutation; rebuilt lazily per target. */
  private cache = new Map<string, number>();

  add(sourceId: string, modifiers: readonly Modifier[]): void {
    for (const modifier of modifiers) {
      const list = this.byTarget.get(modifier.target) ?? [];
      list.push({ sourceId, modifier });
      this.byTarget.set(modifier.target, list);
    }
    if (modifiers.length > 0) this.cache.clear();
  }

  /** Removes every modifier contributed by `sourceId`, e.g. an expired event. */
  remove(sourceId: string): void {
    let changed = false;
    for (const [target, list] of this.byTarget) {
      const kept = list.filter((entry) => entry.sourceId !== sourceId);
      if (kept.length !== list.length) {
        changed = true;
        if (kept.length === 0) this.byTarget.delete(target);
        else this.byTarget.set(target, kept);
      }
    }
    if (changed) this.cache.clear();
  }

  has(target: string): boolean {
    return this.byTarget.has(target);
  }

  /**
   * Resolves `target`, starting from `base`. With no modifiers this returns
   * `base` unchanged, so a system can always call it.
   */
  value(target: string, base = 1): number {
    if (base === 1) {
      const cached = this.cache.get(target);
      if (cached !== undefined) return cached;
    }
    const result = this.resolve(target, base).result;
    if (base === 1) this.cache.set(target, result);
    return result;
  }

  /** Like `value()`, but keeps every step for the explanation drawer. */
  describe(target: string, base = 1): ModifierBreakdown {
    return this.resolve(target, base);
  }

  private resolve(target: string, base: number): ModifierBreakdown {
    const entries = this.byTarget.get(target);
    const steps: Array<{ sourceId: string; operation: string; value: number; after: number }> = [];
    if (!entries || entries.length === 0) {
      return { target, base, result: base, steps };
    }
    // Sort by priority, then source ID: ties must not depend on insertion order.
    const ordered = [...entries].sort((a, b) =>
      a.modifier.priority - b.modifier.priority || a.sourceId.localeCompare(b.sourceId));

    let current = base;
    for (const { sourceId, modifier } of ordered) {
      switch (modifier.operation) {
        case 'add': current += modifier.value; break;
        case 'multiply': current *= modifier.value; break;
        case 'set': current = modifier.value; break;
        case 'min': current = Math.max(current, modifier.value); break;
        case 'max': current = Math.min(current, modifier.value); break;
      }
      steps.push({ sourceId, operation: modifier.operation, value: modifier.value, after: current });
    }
    assertFinite(current, `modifier target "${target}"`);
    return { target, base, result: current, steps };
  }

  /** Every target currently carrying at least one modifier. */
  targets(): string[] {
    return [...this.byTarget.keys()].sort();
  }
}
