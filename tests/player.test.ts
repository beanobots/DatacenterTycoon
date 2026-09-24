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
import { peakShape } from '../src/sim/capacity.js';
import { thermalOutlook } from '../src/sim/thermal-outlook.js';

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

  it('opens on a full 60-rack hall of mixed kit, in every era', () => {
    // A fixed starting position rather than one sized to the decade: the era
    // shows up in what the site costs to run and what the market pays for it,
    // not in how much of it the player is given.
    for (const scenarioId of ['scenario.dry_grid', 'scenario.urban_colo',
      'scenario.cold_cloud', 'scenario.fossil_grid']) {
      const engine = new SimulationEngine(registry, {
        scenarioId, campaignSeed: 'opening', autopilot: allAutopilot(false),
      });
      const halls = engine.state.facilities.flatMap((f) => f.halls);
      expect(halls, scenarioId).toHaveLength(1);
      expect(halls[0]!.rackCapacity, scenarioId).toBe(60);

      const byHardware = new Map<string, number>();
      for (const group of halls[0]!.rackGroups) {
        byHardware.set(group.hardwareId, (byHardware.get(group.hardwareId) ?? 0) + group.count);
      }
      expect(Object.fromEntries(byHardware), scenarioId).toEqual({
        'hardware.cpu.gen1': 30,
        'hardware.storage.hdd_archive': 15,
        'hardware.archive.tape': 15,
      });
      // Full: the floor the player starts with has nothing spare on it.
      const racks = [...byHardware.values()].reduce((n, c) => n + c, 0);
      expect(racks, scenarioId).toBe(halls[0]!.rackCapacity);
    }
  });

  it('opens with cooling that can carry every rack it was given', () => {
    // The fleet is mixed, so the hall has to clear the densest of the three
    // rather than the average - a hall that cannot cool its own opening kit
    // would throttle from the first summer.
    for (const scenarioId of ['scenario.dry_grid', 'scenario.urban_colo',
      'scenario.cold_cloud', 'scenario.fossil_grid']) {
      const engine = new SimulationEngine(registry, {
        scenarioId, campaignSeed: 'opening', autopilot: allAutopilot(false),
      });
      const hall = engine.state.facilities.flatMap((f) => f.halls)[0]!;
      const ceiling = registry.cooling(hall.coolingId, scenarioId).densityKwPerRack;
      for (const group of hall.rackGroups) {
        const needs = registry.hardware(group.hardwareId, scenarioId).requiredCoolingKwPerRack;
        expect(ceiling, `${scenarioId} ${group.hardwareId}`).toBeGreaterThanOrEqual(needs);
      }
    }
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
    // Buildings and what goes inside them are separate decisions, and a
    // player who has taken one over has not thereby taken the other.
    expect(categories).toContain('halls');
    expect(categories).toContain('hardware');
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
    const first = actionsFor(engine)
      .find((action) => action.kind === 'research.start' && !action.blocked);
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
    const action = actionsFor(engine)
      .find((a) => a.kind === 'research.start' && !a.blocked);
    expect(action, 'a project the decade has actually reached').toBeDefined();
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

describe('changing what you already own', () => {
  // Every other action in the game acquires something. Without these the only
  // response to a bad position is to buy your way out of it, which is exactly
  // the position a player who has oversold cannot afford.
  /** Signs whatever the market is offering, so there is a book to act on. */
  function withSignedContracts(seed: string): SimulationEngine {
    const engine = manualEngine(seed);
    engine.advanceTicks(engine.clock.ticksForDays(40));
    for (const action of actionsFor(engine)) {
      if (action.kind === 'contract.sign' && !action.blocked) {
        applyAction(engine.context, engine.operator, action.id);
      }
    }
    return engine;
  }

  it('offers a way out of every live contract', () => {
    const engine = withSignedContracts('exit-offered');

    const drops = actionsFor(engine).filter((action) => action.kind === 'contract.drop');
    expect(drops.length).toBe(engine.state.contracts.length);
    expect(drops.length).toBeGreaterThan(0);
    for (const drop of drops) {
      expect(drop.cost).toBeGreaterThan(0);
      expect(drop.tradeOff).toContain('reputation');
    }
  });

  it('ends a contract for its exit fee and the standing that goes with it', () => {
    const engine = withSignedContracts('exit-taken');

    const drop = actionsFor(engine).find((action) => action.kind === 'contract.drop');
    expect(drop).toBeDefined();
    const before = {
      contracts: engine.state.contracts.length,
      cash: engine.state.company.cash,
      reputation: engine.state.company.reputation,
    };

    const result = applyAction(engine.context, engine.operator, drop!.id);
    expect(result.ok).toBe(true);
    expect(engine.state.contracts.length).toBe(before.contracts - 1);
    expect(engine.state.company.cash).toBeCloseTo(before.cash - drop!.cost, 4);
    expect(engine.state.company.reputation).toBeLessThan(before.reputation);
  });

  it('frees the floor when racks are retired early, and pays for them', () => {
    const engine = manualEngine('retire-early');
    engine.advanceTicks(engine.clock.ticksForDays(40));

    const retire = actionsFor(engine).find((action) => action.kind === 'hardware.retire');
    expect(retire).toBeDefined();
    const racksBefore = engine.state.facilities
      .flatMap((facility) => facility.halls)
      .flatMap((hall) => hall.rackGroups)
      .reduce((total, group) => total + group.count, 0);
    const cashBefore = engine.state.company.cash;

    const result = applyAction(engine.context, engine.operator, retire!.id);
    expect(result.ok).toBe(true);

    const racksAfter = engine.state.facilities
      .flatMap((facility) => facility.halls)
      .flatMap((hall) => hall.rackGroups)
      .reduce((total, group) => total + group.count, 0);
    expect(racksAfter).toBe(racksBefore - retire!.racks);
    // Resale is booked as revenue for the hour, so it reaches cash through
    // accounting rather than landing in the balance on the spot.
    expect(engine.state.hour.hardwareResaleRevenue).toBeGreaterThan(0);
    expect(engine.state.company.cash).toBeGreaterThanOrEqual(cashBefore);
  });

  it('values young racks above old ones when retiring them', () => {
    const young = manualEngine('resale-young');
    young.advanceTicks(young.clock.ticksForDays(40));
    const youngQuote = actionsFor(young).find((a) => a.kind === 'hardware.retire');

    const old = manualEngine('resale-young');
    old.advanceTicks(old.clock.ticksForDays(365 * 3));
    const oldQuote = actionsFor(old).find((a) => a.kind === 'hardware.retire');

    expect(youngQuote).toBeDefined();
    expect(oldQuote).toBeDefined();
    const perRackYoung = youngQuote!.resale / youngQuote!.racks;
    const perRackOld = oldQuote!.resale / oldQuote!.racks;
    expect(perRackYoung).toBeGreaterThan(perRackOld);
  });

  it('decommissions a power asset and takes its capacity off the site', () => {
    const engine = manualEngine('decommission');
    engine.advanceTicks(engine.clock.ticksForDays(40));

    const action = actionsFor(engine).find((a) => a.kind === 'power.retire');
    expect(action).toBeDefined();
    const before = engine.state.facilities.flatMap((f) => f.powerAssets).length;

    const result = applyAction(engine.context, engine.operator, action!.id);
    expect(result.ok).toBe(true);
    expect(engine.state.facilities.flatMap((f) => f.powerAssets).length).toBe(before - 1);
  });
});

describe('the fit claim on a contract offer', () => {
  /**
   * "It fits" has to mean the commitment can be kept. Three separate things
   * used to make it untrue, and each is checked here: capacity shared between
   * workloads counted more than once, demand judged at its average rather than
   * its peak, and cooling ignored entirely.
   */
  const offers = (engine: SimulationEngine) =>
    actionsFor(engine).filter((action) => action.kind === 'contract.sign');

  it('does not offer the same racks to two different workloads', () => {
    // The autopilot builds the fleet but the contract book is left to the
    // player, so there is real capacity sitting unsold to reason about. A
    // fully autonomous operator sells everything it can and leaves no offer
    // fitting; a fully manual one never builds a fleet at all.
    const engine = new SimulationEngine(registry, {
      scenarioId: 'scenario.fossil_grid',
      campaignSeed: 'shared-racks',
      autopilot: { ...allAutopilot(true), contracts: false },
    });
    engine.runYears(2);

    // Archive and disaster recovery both run on the opening fleet. Selling one
    // has to reduce what the other is told it can take.
    const before = offers(engine);
    const first = before.find((action) => action.kind === 'contract.sign' && action.fits);
    expect(first).toBeDefined();
    if (first?.kind !== 'contract.sign') throw new Error('expected an offer');

    applyAction(engine.context, engine.operator, first.id);

    for (const after of offers(engine)) {
      if (after.kind !== 'contract.sign') continue;
      const was = before.find((b) => b.id === after.id);
      if (!was || was.kind !== 'contract.sign') continue;
      // Every remaining offer on racks the signed contract could use must now
      // report less room, not the same room.
      expect(after.freeUnits).toBeLessThanOrEqual(was.freeUnits + 1e-6);
    }
  });

  it('sizes against the peak hour, not the average', () => {
    const engine = manualEngine('peak-sizing');
    engine.advanceTicks(engine.clock.ticksForDays(40));

    for (const action of offers(engine)) {
      if (action.kind !== 'contract.sign') continue;
      const definition = registry.contract(
        engine.state.contractOffers.find((o) => action.id.endsWith(o.instanceId))!.definitionId,
        'test',
      );
      const workload = registry.workload(definition.workloadId, 'test');
      const peak = peakShape(workload.hourlyDemandShape);
      if (peak <= 1.02) continue;
      // A workload peaking above its mean must be quoted less room than the
      // raw capacity would suggest.
      expect(action.freeUnits * peak).toBeLessThanOrEqual(action.servableUnits + 1e-6);
    }
  });

  it('refuses to call an offer a fit when the cooling cannot hold it', () => {
    // The desert site runs out of cooling for part of the year, which caps the
    // availability the whole fleet can promise however many racks are free.
    const engine = new SimulationEngine(registry, {
      scenarioId: 'scenario.dry_grid', campaignSeed: 'thermal-fit', autopilot: allAutopilot(false),
    });
    engine.advanceTicks(engine.clock.ticksForDays(40));

    const hall = engine.state.facilities.flatMap((f) => f.halls)[0];
    expect(hall).toBeDefined();
    const outlook = thermalOutlook(engine.context, hall!);
    expect(outlook.share01).toBeGreaterThan(0);

    for (const action of offers(engine)) {
      if (action.kind !== 'contract.sign') continue;
      const offer = engine.state.contractOffers.find((o) => action.id.endsWith(o.instanceId))!;
      // Judged on what the offer PROMISES, which its decade negotiates down.
      if (offer.slaUptime01 <= 1 - outlook.share01) continue;
      // An offer the fleet cannot serve at all fails for a different reason,
      // and says so; this test is about the cooling refusal specifically.
      if (action.servableUnits <= 0) continue;
      expect(action.fits).toBe(false);
      expect(action.tradeOff).toContain('cooling');
    }
  });
});

describe('halls and hardware are separate hands on the wheel', () => {
  /**
   * The two used to share one autopilot flag, so a player who wanted to
   * choose the racks also inherited the property decisions.
   */
  const floor = (engine: SimulationEngine) => {
    const halls = engine.state.facilities.flatMap((f) => f.halls);
    return {
      halls: halls.length,
      racks: halls.flatMap((h) => h.rackGroups).reduce((n, g) => n + g.count, 0),
    };
  };

  const withAutopilot = (seed: string, auto: Partial<Record<string, boolean>>) =>
    new SimulationEngine(registry, {
      scenarioId: 'scenario.fossil_grid',
      campaignSeed: seed,
      autopilot: { ...allAutopilot(true), ...auto } as ReturnType<typeof allAutopilot>,
    });

  it('buys no racks when the player has taken the hardware decision', () => {
    const engine = withAutopilot('halls-only', { hardware: false });
    // The campaign OPENS with a part-filled hall, which is the starting
    // position rather than anything the heuristic chose, so the test is that
    // the number does not move - not that it is zero.
    const before = floor(engine);
    engine.runYears(4);
    expect(floor(engine).racks).toBe(before.racks);
  });

  it('fills the floor it was given without building more of it', () => {
    const engine = withAutopilot('hardware-only', { halls: false });
    const before = floor(engine);
    engine.runYears(4);
    const after = floor(engine);
    expect(after.halls).toBe(before.halls);
    expect(after.racks).toBeGreaterThan(before.racks);
  });

  it('grows the site only when it holds both halves', () => {
    // The flags are not merely independent: they compound, because running
    // out of floor is the thing that makes the heuristic build more of it.
    // Holding halls alone leaves it with space it may not fill, so it builds
    // nothing further - which is why this is worth pinning.
    const run = (auto: Partial<Record<string, boolean>>) => {
      const engine = withAutopilot('compound', auto);
      const before = floor(engine);
      engine.runYears(4);
      return { before, after: floor(engine) };
    };
    const hallsOnly = run({ hardware: false });
    const both = run({});

    expect(hallsOnly.after.halls).toBe(hallsOnly.before.halls);
    expect(both.after.halls).toBeGreaterThan(both.before.halls);
    expect(both.after.racks).toBeGreaterThan(hallsOnly.after.racks);
  });
});

describe('the order of the contract board', () => {
  /**
   * The board is read top-down, and an offer list in market order made the
   * player scan every card to find the two or three worth signing.
   */
  const boardFor = (engine: SimulationEngine) =>
    actionsFor(engine).filter((action) => action.kind === 'contract.sign');

  it('puts what can be signed above what cannot, and the better rate above the worse', () => {
    const engine = new SimulationEngine(registry, {
      scenarioId: 'scenario.fossil_grid',
      campaignSeed: 'board-order',
      autopilot: { ...allAutopilot(true), contracts: false },
    });
    engine.runYears(3);

    const board = boardFor(engine);
    expect(board.length).toBeGreaterThan(1);

    // Rank each card by the same three keys the board is sorted on, and check
    // the sequence never improves as it goes down.
    const rank = (action: (typeof board)[number]) => {
      if (action.kind !== 'contract.sign') throw new Error('filtered above');
      return {
        signable: action.blocked ? 0 : 1,
        fits: action.fits ? 1 : 0,
        rate: action.annualRevenue / Math.max(1, action.computeUnits),
      };
    };
    for (let i = 1; i < board.length; i++) {
      const above = rank(board[i - 1]!);
      const below = rank(board[i]!);
      expect(above.signable).toBeGreaterThanOrEqual(below.signable);
      if (above.signable !== below.signable) continue;
      expect(above.fits).toBeGreaterThanOrEqual(below.fits);
      if (above.fits !== below.fits) continue;
      expect(above.rate).toBeGreaterThanOrEqual(below.rate);
    }
  });
});

describe('placing racks in a chosen hall', () => {
  it('offers every hall, and says why one cannot take this hardware', () => {
    const engine = manualEngine('hall-choice');
    engine.advanceTicks(engine.clock.ticksForDays(40));

    const buy = actionsFor(engine).find((action) => action.kind === 'hardware.buy');
    expect(buy).toBeDefined();
    if (buy?.kind !== 'hardware.buy') throw new Error('expected a hardware action');

    const halls = engine.state.facilities.flatMap((f) => f.halls)
      .filter((h) => h.constructionProgress01 >= 1);
    expect(buy.halls.length).toBe(halls.length);
    for (const slot of buy.halls) {
      expect(slot.racksInstalled + slot.freeSlots).toBe(slot.rackCapacity);
      if (!slot.canCool) expect(slot.blocked).toBeTruthy();
    }
  });

  it('puts the racks in the hall that was named', () => {
    const engine = manualEngine('hall-target');
    engine.advanceTicks(engine.clock.ticksForDays(40));
    // A second hall, so there is a choice to get wrong.
    const buildHall = actionsFor(engine).find((a) => a.kind === 'hall.build' && a.affordable);
    expect(buildHall).toBeDefined();
    applyAction(engine.context, engine.operator, buildHall!.id);
    engine.advanceTicks(engine.clock.ticksForDays(260));

    const buy = actionsFor(engine).find((action) => action.kind === 'hardware.buy');
    if (buy?.kind !== 'hardware.buy') throw new Error('expected a hardware action');
    const target = buy.halls.filter((slot) => slot.canCool && slot.freeSlots >= 10).at(-1);
    expect(target).toBeDefined();

    const before = countRacks(engine, target!.hallId);
    const result = applyAction(engine.context, engine.operator,
      `hardware:${target!.hallId}:${buy.hardwareId}`, 10);
    expect(result.ok).toBe(true);
    expect(countRacks(engine, target!.hallId)).toBe(before + 10);
  });

  it('says which problem blocks an order: a full hall or cooling that cannot carry it', () => {
    // The two wore one message, and a full hall is now the opening position -
    // so "no hall with cooling dense enough" was the first thing every player
    // read about a site whose cooling was perfectly adequate.
    const engine = manualEngine('blocked-reason');
    const buy = actionsFor(engine).find((a) => a.kind === 'hardware.buy');
    if (buy?.kind !== 'hardware.buy') throw new Error('expected a hardware action');

    expect(buy.spaceAvailable).toBe(0);
    expect(buy.halls.some((slot) => slot.canCool)).toBe(true);
    expect(buy.blocked).toMatch(/full/i);
    expect(buy.blocked).not.toMatch(/dense/i);
  });

  it('refuses a hall whose cooling cannot carry the density, and says so', () => {
    const engine = manualEngine('hall-refuse');
    engine.advanceTicks(engine.clock.ticksForDays(40));
    const buy = actionsFor(engine).find((action) => action.kind === 'hardware.buy');
    if (buy?.kind !== 'hardware.buy') throw new Error('expected a hardware action');

    const blocked = buy.halls.find((slot) => !slot.canCool);
    if (!blocked) return; // Nothing to refuse in this opening position.

    const result = applyAction(engine.context, engine.operator,
      `hardware:${blocked.hallId}:${buy.hardwareId}`, 10);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('cool');
  });
});

function countRacks(engine: SimulationEngine, hallId: string): number {
  const hall = engine.state.facilities.flatMap((f) => f.halls)
    .find((candidate) => candidate.instanceId === hallId);
  return hall ? hall.rackGroups.reduce((total, group) => total + group.count, 0) : 0;
}
