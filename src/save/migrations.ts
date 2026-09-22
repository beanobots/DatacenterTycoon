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

export const SAVE_VERSION = 10;
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
  {
    from: 4, to: 5, id: '004-annual-reports-in-state',
    apply: (save) => {
      // Version 4 kept the annual reports in the scoring system's memory, so a
      // save carried the scores without the reports they came from and resumed
      // with an empty history. An older save cannot recover reports it never
      // stored; it resumes with the history it has and builds from there.
      const state = save.state;
      if (!Array.isArray(state.annualReports)) state.annualReports = [];
      // Campaign length and autopilot were not recorded either; the loader
      // falls back to the scenario's own duration and a fully autonomous
      // operator, which is what a version-4 save was.
    },
  },
  {
    from: 5, to: 6, id: '005-sla-shortfall-attribution',
    apply: (save) => {
      // Version 5 recorded that a contract had breached but not why. The
      // attribution accumulates over an SLA period, so an older save starts
      // its next period with an empty record rather than a guessed one - the
      // first month after a resume explains itself, and nothing claims to know
      // about months it did not watch.
      const contracts = save.state.contracts;
      if (!Array.isArray(contracts)) return;
      for (const entry of contracts) {
        const contract = entry as Record<string, unknown>;
        contract.shortfall = {
          noCompatibleHardware: 0, oversold: 0, throttled: 0, failedRacks: 0, degraded: 0,
        };
        // Version 5 charged SLA credits against delivered revenue, which made a
        // contract served at zero cost nothing. The basis is now the contract's
        // own value, accumulated over the period; a migrated save starts that
        // accumulator at zero and falls back to delivered revenue until the
        // first full period has run.
        contract.contractedRevenueThisPeriod = 0;
      }
    },
  },
  {
    from: 6, to: 7, id: '006-hall-peak-throttle',
    apply: (save) => {
      // Capacity advice is now judged on the worst throttling a hall has
      // reached recently rather than on the current instant. A version-6 save
      // never recorded that, so each hall starts from where it is now and the
      // figure builds from the resumed campaign forward.
      const facilities = save.state.facilities;
      if (!Array.isArray(facilities)) return;
      for (const entry of facilities) {
        const halls = (entry as Record<string, unknown>).halls;
        if (!Array.isArray(halls)) continue;
        for (const hallEntry of halls) {
          const hall = hallEntry as Record<string, unknown>;
          hall.peakThrottle01 = Number(hall.throttle01 ?? 0);
        }
      }
    },
  },
  {
    from: 7, to: 8, id: '007-instance-counter-in-state',
    apply: (save) => {
      // The instance counter used to live on the operator, which is rebuilt on
      // load, so a resumed campaign restarted it at zero and could mint a rack
      // group ID that already existed. Seed it past every ID already in use.
      const state = save.state;
      const meta = state.meta as Record<string, unknown> | undefined;
      if (!meta) return;

      let highest = -1;
      const facilities = state.facilities;
      if (Array.isArray(facilities)) {
        for (const facilityEntry of facilities) {
          const halls = (facilityEntry as Record<string, unknown>).halls;
          if (!Array.isArray(halls)) continue;
          for (const hallEntry of halls) {
            const groups = (hallEntry as Record<string, unknown>).rackGroups;
            if (!Array.isArray(groups)) continue;
            for (const groupEntry of groups) {
              const id = String((groupEntry as Record<string, unknown>).instanceId ?? '');
              const suffix = Number(id.slice(id.lastIndexOf('.') + 1));
              if (Number.isFinite(suffix)) highest = Math.max(highest, suffix);
            }
          }
        }
      }
      meta.nextInstanceId = highest + 1;
    },
  },
  {
    from: 8, to: 9, id: '008-rack-vintage',
    apply: (save) => {
      // Hardware performance and power draw are now properties of the year a
      // rack group was bought rather than of the current year. A version-8
      // save has no vintage, so derive it from the tick the group was
      // installed and the campaign's own start date.
      const state = save.state;
      const meta = state.meta as Record<string, unknown> | undefined;
      const startIso = String(meta?.startDateIso ?? '2025-01-01T00:00:00.000Z');
      const minutesPerTick = Number(meta?.minutesPerTick ?? 15);
      const startYear = new Date(startIso).getUTCFullYear();

      const facilities = state.facilities;
      if (!Array.isArray(facilities)) return;
      for (const facilityEntry of facilities) {
        const halls = (facilityEntry as Record<string, unknown>).halls;
        if (!Array.isArray(halls)) continue;
        for (const hallEntry of halls) {
          const groups = (hallEntry as Record<string, unknown>).rackGroups;
          if (!Array.isArray(groups)) continue;
          for (const groupEntry of groups) {
            const group = groupEntry as Record<string, unknown>;
            const installedTick = Number(group.installedTick ?? 0);
            group.vintageYear = startYear + installedTick * minutesPerTick / (60 * 8766);
          }
        }
      }
    },
  },
  {
    from: 9, to: 10, id: '009-research-budget',
    apply: (save) => {
      // A project's cost is now fixed at the year it started, so it cannot
      // move under a campaign that is already running it. Version-9 saves
      // carry no budget, and the right value is the technology's own cost -
      // which lives in the content registry, not in the save. Migrations run
      // on plain JSON with no registry, so this marks the projects and
      // restoreSave fills them in. Setting a number here instead would have
      // completed every project in flight the moment the save was opened.
      const research = save.state.research as Record<string, unknown> | undefined;
      const active = research?.active;
      if (!Array.isArray(active)) return;
      for (const entry of active) {
        const project = entry as Record<string, unknown>;
        if (project.budgetUsd === undefined) project.budgetUsd = null;
      }
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
