/**
 * The player decision layer.
 *
 * The point of these tests is that a decision a player makes and the same
 * decision made by the autopilot go through one implementation: if they ever
 * diverge, the simulation is quietly treating the player differently and no
 * amount of balance work will make the game fair.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { importContent } from '../src/content/importer.js';
import type { ContentRegistry } from '../src/content/registry.js';
import { SimulationEngine } from '../src/sim/engine.js';
import { allAutopilot } from '../src/sim/operator.js';
import { applyAction, enumerateActions } from '../src/sim/player.js';

let registry: ContentRegistry;
beforeAll(() => {
  registry = importContent('content').registry;
});

function manualEngine(seed = 'player-test'): SimulationEngine {
  return new SimulationEngine(registry, {
    scenarioId: 'scenario.dry_grid',
    campaignSeed: seed,
    autopilot: allAutopilot(false),
  });
}

const actionsFor = (engine: SimulationEngine) => enumerateActions(engine.context, engine.operator);
const act = (engine: SimulationEngine, id: string, quantity?: number) =>
  applyAction(engine.context, engine.operator, id, quantity);

describe('the opening position', () => {
  it('hands the player a running site, not bare land', () => {
    const engine = manualEngine();
    const halls = engine.state.facilities.flatMap((facility) => facility.halls);
    expect(halls.length).toBeGreaterThan(0);
    expect(halls[0]?.rackGroups.length).toBeGreaterThan(0);
    // Power to run it, or nothing else on the site matters.
    expect(engine.state.facilities.flatMap((f) => f.powerAssets).length).toBeGreaterThan(0);
  });

  it('leaves the first research and the first contract to the player', () => {
    const engine = manualEngine();
    expect(engine.state.research.active).toHaveLength(0);
    expect(engine.state.contracts).toHaveLength(0);
    // And offers the market immediately, so turn one has something to decide.
    expect(engine.state.contractOffers.length).toBeGreaterThan(0);
  });

  it('makes those decisions itself when the autopilot holds them', () => {
    const auto = new SimulationEngine(registry, {
      scenarioId: 'scenario.dry_grid', campaignSeed: 'player-test',
    });
    expect(auto.state.research.active.length).toBeGreaterThan(0);
    expect(auto.state.contracts.length).toBeGreaterThan(0);
  });
});

describe('the action list', () => {
  it('offers every decision category the player holds', () => {
    const categories = new Set(actionsFor(manualEngine()).map((action) => action.category));
    expect(categories).toContain('research');
    expect(categories).toContain('contracts');
    expect(categories).toContain('capacity');
    expect(categories).toContain('power');
  });

  it('gives every action a trade-off, not just a price', () => {
    for (const action of actionsFor(manualEngine())) {
      expect(action.tradeOff.length, action.label).toBeGreaterThan(10);
      expect(action.detail.length, action.label).toBeGreaterThan(10);
    }
  });

  it('lists unaffordable options rather than hiding them', () => {
    const engine = manualEngine();
    engine.state.company.cash = 0;
    const actions = actionsFor(engine);
    const buildable = actions.filter((action) => action.kind === 'hall.build');
    expect(buildable.length).toBeGreaterThan(0);
    expect(buildable.every((action) => !action.affordable)).toBe(true);
  });

  it('explains why a contract is out of reach instead of dropping it', () => {
    const engine = manualEngine();
    engine.state.company.reputation = 0;
    const contracts = actionsFor(engine).filter((action) => action.kind === 'contract.sign');
    const gated = contracts.filter((action) => action.blocked);
    expect(gated.length).toBeGreaterThan(0);
    expect(gated[0]?.blocked).toMatch(/reputation|Requires/);
  });

  it('only offers hardware the halls can actually cool', () => {
    const engine = manualEngine();
    const actions = actionsFor(engine).filter((action) => action.kind === 'hardware.buy');
    for (const action of actions) {
      if (action.kind !== 'hardware.buy') continue;
      const hardware = registry.hardware(action.hardwareId, 'test');
      const ceiling = engine.operator.coolingCeilingKw(
        engine.context,
        engine.state.facilities[0]!.halls[0]!,
      );
      if (hardware.requiredCoolingKwPerRack > ceiling) {
        expect(action.blocked, action.label).toBeTruthy();
      }
    }
  });

  it('keeps offering research while projects run, and drops the one taken', () => {
    const engine = manualEngine();
    const first = actionsFor(engine).find((action) => action.kind === 'research.start');
    expect(first).toBeDefined();
    act(engine, first!.id);

    const after = actionsFor(engine).filter((action) => action.kind === 'research.start');
    // Concurrency: the list stays open.
    expect(after.length).toBeGreaterThan(0);
    // But the project already under way is not offered twice.
    expect(after.some((action) => action.id === first!.id)).toBe(false);
  });

  it('runs several projects at once until the specialists are gone', () => {
    const engine = manualEngine();
    let started = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const action = actionsFor(engine)
        .find((candidate) => candidate.kind === 'research.start' && !candidate.blocked);
      if (!action) break;
      if (!act(engine, action.id).ok) break;
      started += 1;
    }
    expect(started).toBeGreaterThan(1);
    expect(engine.state.research.active.length).toBe(started);

    // The bench is what stops it, and the next action says so.
    const blocked = actionsFor(engine)
      .filter((action) => action.kind === 'research.start' && action.blocked);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.some((action) => /specialist/i.test(action.blocked ?? ''))).toBe(true);
  });

  it('funds research from cash rather than a separate currency', () => {
    const engine = manualEngine();
    const action = actionsFor(engine)
      .find((candidate) => candidate.kind === 'research.start' && !candidate.blocked);
    expect(action).toBeDefined();
    if (action?.kind !== 'research.start') throw new Error('expected a research action');
    expect(action.costUsd).toBeGreaterThan(0);
    act(engine, action.id);

    const before = engine.state.company.cash;
    engine.advanceTicks(engine.clock.ticksForDays(30));
    expect(engine.state.company.cash).toBeLessThan(before);
    expect(engine.state.research.active[0]!.fundedUsd).toBeGreaterThan(0);
  });
});

describe('taking an action', () => {
  it('starts research and refuses to start the same project twice', () => {
    const engine = manualEngine();
    const action = actionsFor(engine).find((a) => a.kind === 'research.start');
    expect(act(engine, action!.id).ok).toBe(true);
    expect(engine.state.research.active[0]!.technologyId).toBe(
      action!.kind === 'research.start' ? action!.technologyId : '',
    );
    // The same project cannot be started twice.
    expect(act(engine, action!.id).ok).toBe(false);
  });

  it('signs a contract on the terms that were offered', () => {
    const engine = manualEngine();
    const action = actionsFor(engine).find((a) => a.kind === 'contract.sign' && !a.blocked);
    expect(action).toBeDefined();
    expect(act(engine, action!.id).ok).toBe(true);

    const signed = engine.state.contracts[0];
    expect(signed).toBeDefined();
    if (action!.kind === 'contract.sign') {
      expect(signed!.computeUnits).toBe(action!.computeUnits);
      expect(signed!.termMonths).toBe(action!.termMonths);
    }
    // The offer leaves the table once taken.
    expect(engine.state.contractOffers.some((o) => `contract:${o.instanceId}` === action!.id)).toBe(false);
  });

  it('buys racks, charges for them, and books their embodied carbon', () => {
    const engine = manualEngine();
    const before = engine.state.company.cash;
    const racksBefore = engine.state.facilities[0]!.halls[0]!.rackGroups
      .reduce((total, group) => total + group.count, 0);

    const action = actionsFor(engine).find((a) => a.kind === 'hardware.buy' && !a.blocked);
    expect(action).toBeDefined();
    expect(act(engine, action!.id, 10).ok).toBe(true);

    const racksAfter = engine.state.facilities[0]!.halls[0]!.rackGroups
      .reduce((total, group) => total + group.count, 0);
    expect(racksAfter).toBe(racksBefore + 10);
    expect(engine.state.company.cash).toBeLessThan(before);
    expect(engine.state.hour.embodiedCarbonKg).toBeGreaterThan(0);
  });

  it('builds a hall that has to be commissioned before it holds racks', () => {
    const engine = manualEngine();
    const hallsBefore = engine.state.facilities[0]!.halls.length;
    const action = actionsFor(engine).find((a) => a.kind === 'hall.build' && a.affordable);
    expect(action).toBeDefined();
    expect(act(engine, action!.id).ok).toBe(true);

    const halls = engine.state.facilities[0]!.halls;
    expect(halls.length).toBe(hallsBefore + 1);
    expect(halls.at(-1)!.constructionProgress01).toBeLessThan(1);
    if (action!.kind === 'hall.build') {
      expect(halls.at(-1)!.coolingId).toBe(action!.coolingId);
      expect(halls.at(-1)!.rackCapacity).toBe(action!.racks);
    }
  });

  it('refuses a purchase the balance cannot carry', () => {
    const engine = manualEngine();
    engine.state.company.cash = 1000;
    const action = actionsFor(engine).find((a) => a.kind === 'hall.build');
    const result = act(engine, action!.id);
    expect(result.ok).toBe(false);
    expect(engine.state.company.cash).toBe(1000);
  });

  it('reports an unknown action rather than failing silently', () => {
    const engine = manualEngine();
    expect(act(engine, 'nonsense:thing').ok).toBe(false);
  });
});

describe('player and autopilot share one implementation', () => {
  it('prices a hall the same for both', () => {
    const engine = manualEngine();
    const cooling = registry.cooling('cooling.basic_air');
    const action = actionsFor(engine).find(
      (a) => a.kind === 'hall.build' && a.coolingId === 'cooling.basic_air' && a.racks === 120,
    );
    expect(action).toBeDefined();
    expect(action!.cost).toBeCloseTo(
      engine.operator.priceHall(engine.context, 120, cooling), 6,
    );
  });

  it('runs a full campaign under player control without diverging from the rules', () => {
    const engine = manualEngine('full-run');
    // A deliberately passive player: take nothing, just let time pass. The
    // simulation must still run, score and report.
    engine.runYears(3);
    expect(engine.annualReports.length).toBe(3);
    for (const report of engine.annualReports) {
      expect(Number.isFinite(report.financial.revenue)).toBe(true);
      expect(report.environment.facilityMwh).toBeGreaterThan(0);
    }
    // With nothing sold, availability is untested rather than failed.
    expect(engine.state.contracts).toHaveLength(0);
  });

  it('lets a category be handed back to the autopilot mid-campaign', () => {
    const engine = manualEngine('handback');
    engine.runYears(1);
    expect(engine.state.research.active).toHaveLength(0);

    engine.operator.setAutopilot('research', true);
    engine.runYears(1);
    // The heuristic picked something up once it held the category again.
    expect(engine.state.research.completed.length + engine.state.research.active.length)
      .toBeGreaterThan(5);
  });
});
