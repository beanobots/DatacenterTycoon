/**
 * Save migrations.
 *
 * Acceptance criterion 6: save migrations support at least two prior schema
 * versions. Each entry upgrades one version to the next and records itself in
 * the save's migration history, so a file carries the record of how it got to
 * its current shape.
 *
 * Migrations are written against plain JSON, not against the typed state: a
 * save written by an older build does not satisfy today's types, which is the
 * entire reason the migration exists.
 */

export const SAVE_VERSION = 4;
/** Oldest version this build can still read. */
export const MIN_SUPPORTED_SAVE_VERSION = 1;

type LooseSave = Record<string, unknown> & {
  saveVersion: number;
  migrationHistory?: string[];
  state: Record<string, unknown>;
};

interface Migration {
  readonly from: number;
  readonly to: number;
  readonly id: string;
  readonly apply: (save: LooseSave) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    from: 1, to: 2, id: '001-contract-market',
    apply: (save) => {
      // Version 1 had no contract market: contracts carried no negotiated terms
      // and there were no standing offers. Back-fill both from the archetype
      // values the version-1 contracts were signed at.
      const state = save.state;
      if (!Array.isArray(state.contractOffers)) state.contractOffers = [];
      const contracts = state.contracts;
      if (Array.isArray(contracts)) {
        for (const entry of contracts as Array<Record<string, unknown>>) {
          if (entry.computeUnits === undefined) entry.computeUnits = 0;
          if (entry.pricePerComputeUnitHour === undefined) entry.pricePerComputeUnitHour = 0;
          if (entry.termMonths === undefined) entry.termMonths = 12;
        }
      }
    },
  },
  {
    from: 2, to: 3, id: '002-hall-install-tick',
    apply: (save) => {
      // Version 2 halls had no install tick, so cooling plant never aged.
      // Treat an existing hall as commissioned at the campaign start, which is
      // the most conservative reading of a save that never recorded it.
      const facilities = save.state.facilities;
      if (!Array.isArray(facilities)) return;
      for (const facility of facilities as Array<Record<string, unknown>>) {
        const halls = facility.halls;
        if (!Array.isArray(halls)) continue;
        for (const hall of halls as Array<Record<string, unknown>>) {
          if (hall.installedTick === undefined) hall.installedTick = 0;
        }
      }
    },
  },
  {
    from: 3, to: 4, id: '003-research-in-dollars',
    apply: (save) => {
      // Version 3 funded research from a points balance and ran one project at
      // a time. Points are gone and projects are concurrent, so a single
      // in-flight project becomes a one-element list, and its progress is
      // re-expressed as dollars funded. The conversion the content migration
      // used was 1 RP = $1,000, so the same rate reconstructs the spend.
      const state = save.state;
      const research = state.research as Record<string, unknown> | undefined;
      if (research) {
        const activeId = research.activeId;
        const progressRP = typeof research.activeProgressRP === 'number' ? research.activeProgressRP : 0;
        if (!Array.isArray(research.active)) {
          research.active = typeof activeId === 'string' && activeId.length > 0
            ? [{
                technologyId: activeId,
                fundedUsd: progressRP * RP_TO_USD,
                specialists: 2,
                startedTick: 0,
              }]
            : [];
        }
        delete research.activeId;
        delete research.activeProgressRP;
      }
      const company = state.company as Record<string, unknown> | undefined;
      if (company) delete company.researchPoints;
    },
  },
];

/** The rate the content migration used when research moved to dollars. */
const RP_TO_USD = 1000;

export interface MigrationResult<T> {
  readonly save: T;
  readonly applied: readonly string[];
}

export function migrate<T extends { saveVersion: number }>(save: T): MigrationResult<T> {
  const loose = save as unknown as LooseSave;
  if (loose.saveVersion > SAVE_VERSION) {
    throw new Error(
      `Save was written by a newer build (save version ${loose.saveVersion}, this build reads up to ${SAVE_VERSION})`,
    );
  }
  if (loose.saveVersion < MIN_SUPPORTED_SAVE_VERSION) {
    throw new Error(
      `Save version ${loose.saveVersion} is older than the oldest supported version (${MIN_SUPPORTED_SAVE_VERSION})`,
    );
  }

  const applied: string[] = [];
  let guard = MIGRATIONS.length + 1;
  while (loose.saveVersion < SAVE_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === loose.saveVersion);
    if (!step) {
      throw new Error(`No migration from save version ${loose.saveVersion} to ${SAVE_VERSION}`);
    }
    step.apply(loose);
    loose.saveVersion = step.to;
    applied.push(step.id);
    loose.migrationHistory = [...(loose.migrationHistory ?? []), step.id];
    if (guard-- <= 0) throw new Error('Save migration did not terminate');
  }

  return { save: save as T, applied };
}
