/**
 * Forward planning.
 *
 * The whole value of a forecast is that it matches what happens, so the central
 * test here projects, then simulates the same period with no further orders,
 * and holds the two against each other. A schedule that runs early is worse
 * than no schedule: it invites the player to sell capacity that is not there.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { importContent } from '../src/content/importer.js';
import type { ContentRegistry } from '../src/content/registry.js';
import { SimulationEngine } from '../src/sim/engine.js';
import { allAutopilot } from '../src/sim/operator.js';
import { applyAction, enumerateActions } from '../src/sim/player.js';
import { COMMIT_MARGIN, commissioningSchedule, projectCapacity, workloadHeadroom } from '../src/sim/planning.js';

let registry: ContentRegistry;
beforeAll(() => {
  registry = importContent('content').registry;
});

function manualEngine(seed = 'planning'): SimulationEngine {
  return new SimulationEngine(registry, {
    scenarioId: 'scenario.dry_grid', campaignSeed: seed, autopilot: allAutopilot(false),
  });
}

/** Measures the live fleet the same way the projection models it. */
function measure(engine: SimulationEngine): { mw: number; racks: number; slots: number } {
  const halls = engine.state.facilities.flatMap((facility) => facility.halls)
    .filter((hall) => hall.constructionProgress01 >= 1);
  let kw = 0;
  let racks = 0;
  for (const hall of halls) {
    for (const group of hall.rackGroups) {
      racks += group.count;
      kw += group.count * engine.context.balance.baseRackPowerKw
        * registry.hardware(group.hardwareId, group.instanceId).powerFactor;
    }
  }
  return {
    mw: kw / 1000,
    racks,
    slots: halls.reduce((total, hall) => total + hall.rackCapacity, 0),
  };
}

describe('headroom', () => {
  it('reports capacity per workload rather than one fungible total', () => {
    const rows = workloadHeadroom(manualEngine().context);
    expect(rows.length).toBeGreaterThan(3);
    // A CPU-and-disk opening fleet serves general work and cannot touch AI
    // training, which needs accelerators.
    const training = rows.find((row) => row.workloadId === 'workload.ai_training');
    const archive = rows.find((row) => row.workloadId === 'workload.archive');
    expect(training?.servableUnits).toBe(0);
    expect(archive?.servableUnits).toBeGreaterThan(0);
  });

  it('names the technology that would open a workload it cannot serve', () => {
    const rows = workloadHeadroom(manualEngine().context);
    const training = rows.find((row) => row.workloadId === 'workload.ai_training');
    expect(training?.unlockedBy).toBeTruthy();
    expect(training?.unlockedBy).toMatch(/GPU|Accelerator/i);
  });

  it('drops free capacity by exactly what a contract reserves', () => {
    const engine = manualEngine();
    const before = workloadHeadroom(engine.context);

    const action = enumerateActions(engine.context, engine.operator)
      .find((candidate) => candidate.kind === 'contract.sign' && !candidate.blocked);
    expect(action).toBeDefined();
    if (action?.kind !== 'contract.sign') throw new Error('expected a contract action');
    applyAction(engine.context, engine.operator, action.id);

    const workloadId = registry.contract(
      engine.state.contracts[0]!.definitionId, 'test',
    ).workloadId;
    const was = before.find((row) => row.workloadId === workloadId)!;
    const now = workloadHeadroom(engine.context).find((row) => row.workloadId === workloadId)!;

    expect(now.reservedUnits - was.reservedUnits).toBeCloseTo(action.computeUnits, 6);
    expect(was.freeUnits - now.freeUnits).toBeCloseTo(action.computeUnits, 6);
  });

  it('holds free capacity below servable capacity by the commit margin', () => {
    for (const row of workloadHeadroom(manualEngine().context)) {
      expect(row.freeUnits).toBeLessThanOrEqual(row.servableUnits * COMMIT_MARGIN + 1e-6);
      expect(row.freeUnits).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the projection matches what actually happens', () => {
  it('predicts capacity, racks and slots for a year of doing nothing', () => {
    const engine = manualEngine('projection');
    // Put a hall under construction so there is something to commission.
    const build = enumerateActions(engine.context, engine.operator)
      .find((action) => action.kind === 'hall.build' && action.affordable);
    expect(build).toBeDefined();
    applyAction(engine.context, engine.operator, build!.id);

    const forecast = projectCapacity(engine.context, 12);
    const ticksPerMonth = engine.clock.ticksForDays(30.44);

    for (let month = 1; month <= 12; month += 1) {
      engine.advanceTicks(ticksPerMonth);
      const actual = measure(engine);
      const predicted = forecast.find((entry) => entry.monthsAhead === month)!;

      expect(actual.mw, `month ${month} capacity`).toBeCloseTo(predicted.itCapacityMw, 5);
      expect(actual.racks, `month ${month} racks`).toBe(predicted.rackCount);
      // Slots may arrive a month EARLY in reality but never late: the schedule
      // must not promise capacity before it exists.
      expect(actual.slots, `month ${month} slots`).toBeGreaterThanOrEqual(predicted.rackSlots);
    }
  });

  it('predicts a retiring cohort rather than being surprised by it', () => {
    const engine = manualEngine('retirement');
    // Age every group to just under ITS OWN design life: the opening fleet's
    // hardware varies with the seed, and a tape library outlives a CPU rack by
    // six years.
    const ticksPerYear = engine.clock.ticksForDays(365.25);
    for (const facility of engine.state.facilities) {
      for (const hall of facility.halls) {
        for (const group of hall.rackGroups) {
          const hardware = registry.hardware(group.hardwareId, group.instanceId);
          group.installedTick = engine.state.meta.tickIndex
            - Math.round(ticksPerYear * (hardware.lifeYears - 0.1));
        }
      }
    }

    const forecast = projectCapacity(engine.context, 12);
    const start = forecast[0]!.rackCount;
    const end = forecast[forecast.length - 1]!.rackCount;
    expect(end).toBeLessThan(start);

    // And it says so in words, not only in the number.
    expect(forecast.some((month) => month.events.some((e) => /retire/.test(e)))).toBe(true);
  });

  it('never promises a commissioning earlier than it happens', () => {
    const engine = manualEngine('commissioning');
    const build = enumerateActions(engine.context, engine.operator)
      .find((action) => action.kind === 'hall.build' && action.affordable);
    applyAction(engine.context, engine.operator, build!.id);

    const scheduled = commissioningSchedule(engine.context, 24)
      .find((entry) => entry.kind === 'hall');
    expect(scheduled).toBeDefined();

    const ticksPerMonth = engine.clock.ticksForDays(30.44);
    let commissionedAt: number | null = null;
    for (let month = 1; month <= 24 && commissionedAt === null; month += 1) {
      engine.advanceTicks(ticksPerMonth);
      const done = engine.state.facilities.flatMap((f) => f.halls)
        .filter((hall) => hall.constructionProgress01 >= 1).length;
      if (done > 1) commissionedAt = month;
    }
    expect(commissionedAt).not.toBeNull();
    // The promise may be conservative; it may not be optimistic.
    expect(scheduled!.monthsAhead).toBeGreaterThanOrEqual(commissionedAt!);
  });

  it('does not age the real fleet while projecting', () => {
    const engine = manualEngine('purity');
    const before = JSON.stringify(engine.state.facilities);
    projectCapacity(engine.context, 24);
    workloadHeadroom(engine.context);
    commissioningSchedule(engine.context, 24);
    expect(JSON.stringify(engine.state.facilities)).toBe(before);
  });
});

describe('the schedule', () => {
  it('lists what is already committed, in date order', () => {
    const engine = manualEngine('schedule');
    const actions = enumerateActions(engine.context, engine.operator);
    applyAction(engine.context, engine.operator,
      actions.find((a) => a.kind === 'hall.build' && a.affordable)!.id);
    applyAction(engine.context, engine.operator,
      actions.find((a) => a.kind === 'contract.sign' && !a.blocked)!.id);

    // Reach past the contract's own term, which the market negotiates and can
    // run to ten years on an archive deal.
    const term = engine.state.contracts[0]!.termMonths;
    const schedule = commissioningSchedule(engine.context, term + 12);
    expect(schedule.length).toBeGreaterThan(1);
    for (let i = 1; i < schedule.length; i += 1) {
      expect(schedule[i]!.monthsAhead).toBeGreaterThanOrEqual(schedule[i - 1]!.monthsAhead);
    }
    expect(schedule.some((entry) => entry.kind === 'hall')).toBe(true);
    expect(schedule.some((entry) => entry.kind === 'contract')).toBe(true);
  });

  it('distinguishes rack slots from capacity in what it promises', () => {
    const engine = manualEngine('slots');
    applyAction(engine.context, engine.operator,
      enumerateActions(engine.context, engine.operator)
        .find((a) => a.kind === 'hall.build' && a.affordable)!.id);
    const hall = commissioningSchedule(engine.context, 24).find((e) => e.kind === 'hall');
    expect(hall!.detail).toMatch(/slots, not capacity/i);
  });

  it('reaches past a short chart horizon to show real commitments', () => {
    const engine = manualEngine('horizon');
    applyAction(engine.context, engine.operator,
      enumerateActions(engine.context, engine.operator)
        .find((a) => a.kind === 'contract.sign' && !a.blocked)!.id);
    const term = engine.state.contracts[0]!.termMonths;
    // The schedule lists what is committed, however far out it runs: a
    // multi-year contract is not hidden by a twelve-month view.
    const schedule = commissioningSchedule(engine.context);
    expect(schedule.some((entry) => entry.kind === 'contract' && entry.monthsAhead === term)).toBe(true);
    // A caller may still clip it when it wants to.
    expect(commissioningSchedule(engine.context, 6)
      .every((entry) => entry.monthsAhead <= 6)).toBe(true);
  });

  it('never sums headroom across workloads', () => {
    const engine = manualEngine('no-sum');
    const month = projectCapacity(engine.context, 1)[0]!;
    const rows = month.perWorkload;
    expect(rows.length).toBeGreaterThan(1);
    // The same racks serve several workloads, so each row's servable capacity
    // may exceed the raw compute the fleet holds; a sum would be nonsense.
    const rawUnits = engine.state.facilities.flatMap((f) => f.halls)
      .flatMap((h) => h.rackGroups)
      .reduce((total, group) => total + group.count * engine.context.balance.baseRackComputeUnits
        * registry.hardware(group.hardwareId, group.instanceId).computeFactor, 0);
    const summed = rows.reduce((total, row) => total + row.servableUnits, 0);
    expect(summed).toBeGreaterThan(rawUnits);
  });
});
