/**
 * Balance harness.
 *
 * The design target, set by the person this is for: a competent operator turns
 * profitable in about year 3 and has cleared its debt by about year 10. This
 * runs every scenario across several seeds and reports whether that happens,
 * so tuning is measured rather than argued about.
 *
 *   npx tsx scripts/balance.mjs [--seeds 4] [--scenario id] [--years N]
 */
import { importContent } from '../src/content/importer.js';
import { SimulationEngine } from '../src/sim/engine.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : fallback;
};
const SEEDS = Number(opt('seeds', 3));
const ONLY = opt('scenario', null);
const YEARS = opt('years', null);

const { registry } = importContent('content');
const scenarios = ONLY ? [ONLY] : [
  'scenario.dry_grid', 'scenario.urban_colo', 'scenario.cold_cloud', 'scenario.fossil_grid',
];

function runOne(scenarioId, seed) {
  const scenario = registry.scenario(scenarioId, 'balance');
  const years = YEARS ? Number(YEARS) : scenario.durationYears;
  const engine = new SimulationEngine(registry, { scenarioId, campaignSeed: seed, strategy: 'balanced' });

  let profitableYear = null;
  let debtClearYear = null;
  let peakRacks = 0;
  let peakMw = 0;
  const track = [];

  for (let y = 1; y <= years; y += 1) {
    engine.runYears(1);
    const report = engine.annualReports.at(-1);
    if (!report) break;
    const racks = engine.state.facilities.flatMap((f) => f.halls)
      .flatMap((h) => h.rackGroups).reduce((n, g) => n + g.count, 0);
    peakRacks = Math.max(peakRacks, racks);
    peakMw = Math.max(peakMw, report.capacity.itCapacityMw);

    // "Profitable" means it stayed profitable, not that it grazed zero once.
    if (report.financial.operatingProfit > 0) {
      if (profitableYear === null) profitableYear = y;
    } else {
      profitableYear = null;
    }
    if (debtClearYear === null && engine.state.company.debt < 1000) debtClearYear = y;

    track.push({ y, racks, mw: report.capacity.itCapacityMw,
      rev: report.financial.revenue, profit: report.financial.operatingProfit,
      cash: engine.state.company.cash, debt: engine.state.company.debt });
  }

  const last = engine.annualReports.at(-1);
  return {
    profitableYear, debtClearYear, peakRacks, peakMw, years, track,
    finalRacks: track.at(-1)?.racks ?? 0,
    finalMw: last?.capacity.itCapacityMw ?? 0,
    targetMw: scenario.targetCapacityMw,
    rating: engine.state.annualScores.at(-1)?.rating ?? '-',
    alive: (track.at(-1)?.racks ?? 0) > 0,
  };
}

const rows = [];
for (const scenarioId of scenarios) {
  for (let s = 0; s < SEEDS; s += 1) {
    const seed = `balance-${s}`;
    const r = runOne(scenarioId, seed);
    rows.push({ scenarioId, seed, ...r });
    const name = scenarioId.replace('scenario.', '').padEnd(12);
    console.log(
      `${name} ${seed}  profit y${String(r.profitableYear ?? '-').padStart(2)}`
      + `  debtClear y${String(r.debtClearYear ?? '-').padStart(2)}`
      + `  peak ${String(r.peakRacks).padStart(5)} racks`
      + `  final ${String(r.finalRacks).padStart(5)} racks`
      + `  ${r.finalMw.toFixed(1).padStart(5)}/${r.targetMw} MW`
      + `  ${r.alive ? 'alive' : 'DEAD '}  ${r.rating}`,
    );
  }
}

const withProfit = rows.filter((r) => r.profitableYear !== null);
const withDebtClear = rows.filter((r) => r.debtClearYear !== null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log('\n--- against the target: profitable ~y3, debt clear ~y10 ---');
console.log(`profitable in     ${withProfit.length}/${rows.length} runs, mean year `
  + `${mean(withProfit.map((r) => r.profitableYear)).toFixed(1)}`);
console.log(`debt cleared in   ${withDebtClear.length}/${rows.length} runs, mean year `
  + `${mean(withDebtClear.map((r) => r.debtClearYear)).toFixed(1)}`);
console.log(`still alive       ${rows.filter((r) => r.alive).length}/${rows.length}`);
console.log(`hit MW target     ${rows.filter((r) => r.finalMw >= r.targetMw).length}/${rows.length}`);
