import { importContent } from './src/content/importer.js';
import { SimulationEngine } from './src/sim/engine.js';
const registry = importContent('content').registry;
const e = new SimulationEngine(registry, { scenarioId: 'scenario.dry_grid', campaignSeed: 'balance-0', strategy: 'balanced' });
for (let y = 1; y <= 14; y++) {
  e.runYears(1);
  const r = e.annualReports.at(-1)!;
  const f = r.financial;
  const racks = e.state.facilities.flatMap(x=>x.halls).flatMap(h=>h.rackGroups).reduce((a,g)=>a+g.count,0);
  console.log(r.year, '| racks', String(racks).padStart(4),
    '| rev', (f.revenue/1e6).toFixed(2).padStart(6),
    '| cost', (f.cost/1e6).toFixed(2).padStart(6),
    '| cash', (f.cash/1e6).toFixed(1).padStart(6),
    '| debt', (f.debt/1e6).toFixed(1).padStart(5),
    '| rep', e.state.company.reputation.toFixed(0).padStart(3),
    '| avail', (r.reliability.availability01*100).toFixed(1),
    '| pue', (r.environment.pue??0).toFixed(2),
    '| contracts', e.state.contracts.length);
}
const k: Record<string,number> = {};
for (const d of e.state.diagnostics) k[d.kind] = (k[d.kind]??0)+1;
console.log('\ndiagnostics:', JSON.stringify(k));
