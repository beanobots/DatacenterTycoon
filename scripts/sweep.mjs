/**
 * Sweeps balance knobs against the design target in ONE process.
 *
 * The first version shelled out to the harness per value, and npx start-up
 * cost more than the simulation did. Content is re-imported from disk each
 * time, which is all the isolation a sweep needs.
 *
 *   npx tsx scripts/sweep.mjs contractPriceScale 1.0 1.6 2.2
 */
import fs from 'node:fs';
import { importContent } from '../src/content/importer.js';
import { SimulationEngine } from '../src/sim/engine.js';

const PROFILE = 'content/profiles/balance.default.json';
const [key, ...values] = process.argv.slice(2);
if (!key || values.length === 0) {
  console.error('usage: sweep.mjs <balanceKey> <value>...');
  process.exit(1);
}

const SCENARIOS = [
  'scenario.dry_grid', 'scenario.urban_colo', 'scenario.cold_cloud', 'scenario.fossil_grid',
];
const SEEDS = ['balance-0', 'balance-1'];
const YEARS = Number(process.env.SWEEP_YEARS ?? 12);
const original = fs.readFileSync(PROFILE, 'utf8');

/** Runs one campaign and reports it against the target. */
function evaluate(registry, scenarioId, seed) {
  const engine = new SimulationEngine(registry, { scenarioId, campaignSeed: seed, strategy: 'balanced' });
  const openingDebt = Math.max(1, engine.state.company.debt);
  let profitable = null;
  let deleveraged = null;
  let profitYears = 0;
  for (let y = 1; y <= YEARS; y += 1) {
    engine.runYears(1);
    const report = engine.annualReports.at(-1);
    if (!report) continue;
    if (report.financial.operatingProfit > 0) {
      profitYears += 1;
      if (profitable === null) profitable = y;
    } else profitable = null;

    // "Debt at zero" is the wrong test for an operator that BORROWS TO GROW -
    // a healthy one carries debt for ever and should. This is the year it has
    // paid off most of the loan it STARTED with, which is what "cleared its
    // debt" means for a business that is still building.
    if (deleveraged === null && engine.state.company.debt < openingDebt * 0.2) {
      deleveraged = y;
    }
  }
  const racks = engine.state.facilities.flatMap((f) => f.halls)
    .flatMap((h) => h.rackGroups).reduce((n, g) => n + g.count, 0);
  const last = engine.annualReports.at(-1);
  return {
    profitable, deleveraged, racks, profitYears,
    mw: last?.capacity.itCapacityMw ?? 0,
    margin: last?.financial.operatingMargin01 ?? 0,
    alive: racks > 0,
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

try {
  for (const raw of values) {
    const d = JSON.parse(original);
    d[key] = Number(raw);
    fs.writeFileSync(PROFILE, JSON.stringify(d, null, 2) + '\n');
    const { registry } = importContent('content');

    const runs = [];
    for (const scenarioId of SCENARIOS) {
      for (const seed of SEEDS) runs.push(evaluate(registry, scenarioId, seed));
    }
    const profit = runs.filter((r) => r.profitable !== null);
    const debt = runs.filter((r) => r.deleveraged !== null);
    console.log(
      `${key}=${String(raw).padStart(5)}`
      + `  profitable ${String(profit.length).padStart(2)}/${runs.length}`
      + ` @y${mean(profit.map((r) => r.profitable)).toFixed(1).padStart(4)}`
      + `  deleveraged ${String(debt.length).padStart(2)}/${runs.length}`
      + ` @y${mean(debt.map((r) => r.deleveraged)).toFixed(1).padStart(4)}`
      + `  alive ${runs.filter((r) => r.alive).length}/${runs.length}`
      + `  meanRacks ${mean(runs.map((r) => r.racks)).toFixed(0).padStart(5)}`
      + `  meanMW ${mean(runs.map((r) => r.mw)).toFixed(1).padStart(5)}`
      + `  profitYrs ${(mean(runs.map((r) => r.profitYears)) / YEARS * 100).toFixed(0).padStart(3)}%`,
    );
  }
} finally {
  fs.writeFileSync(PROFILE, original);
  console.log('\n(profile restored)');
}
