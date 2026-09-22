import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = '/home/user/DatacenterTycoon/web';
const server = http.createServer((req, res) => {
  const f = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  try { const b = fs.readFileSync(f);
    res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
    res.end(b);
  } catch { res.writeHead(404); res.end('no'); }
});
await new Promise(r => server.listen(4331, r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error' && !/ERR_CERT/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
await page.goto('http://127.0.0.1:4331/');
await page.waitForTimeout(1200);
console.log('scenarios on setup:', await page.evaluate(() => [...document.querySelectorAll('.scen .nm, .scenario .nm, [data-scenario]')].map(n=>n.textContent).join(' | ') || 'n/a'));
await page.evaluate(() => { const b=[...document.querySelectorAll('button')].find(x=>/start|begin|run/i.test(x.textContent)); if(b)b.click(); });
await page.waitForTimeout(2500);
console.log('clock:', await page.evaluate(() => document.getElementById('clock-date')?.textContent + ' / ' + document.getElementById('clock-sub')?.textContent));
for (let i=0;i<8;i++){ await page.evaluate(()=>document.getElementById('next-year').click()); await page.waitForTimeout(1800); }
console.log('clock after 8y:', await page.evaluate(() => document.getElementById('clock-date')?.textContent));
await page.evaluate(() => { const t=[...document.querySelectorAll('button')].find(x=>/^site$|^fleet$/i.test(x.textContent.trim())); if(t)t.click(); });
await page.waitForTimeout(700);
console.log('floor hint:', await page.evaluate(() => document.getElementById('floor-hint')?.textContent));
console.log('plans:', await page.evaluate(() => document.querySelectorAll('.hallplan').length));
console.log('rack cells:', await page.evaluate(() => document.querySelectorAll('.rack').length));
console.log('first plan text:', await page.evaluate(() => document.querySelector('.hallplan')?.innerText.slice(0,300)));
console.log('errors:', errors.length ? errors.join(' | ') : 'none');
await page.screenshot({ path: '/tmp/claude-0/-home-user-DatacenterTycoon/6087588b-d9c6-5ab4-9919-b4494593486b/scratchpad/floor.png', fullPage: true });
await browser.close(); server.close();
