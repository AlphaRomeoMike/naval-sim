// End-to-end checks in headless Chrome against the built game: npm run e2e
// Each check drives the real page (menus, keyboard, worker) and prints PASS or FAIL.
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { serve } from './serve.mjs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = new URL('..', import.meta.url).pathname;
if (!process.argv.includes('--no-build')) {
  if (spawnSync('npx', ['vite', 'build'], { cwd: root, stdio: 'inherit' }).status !== 0) process.exit(1);
}
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const server = await serve(root + 'dist');
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'] });
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(query = '') {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push('console: ' + m.text()); });
  await page.goto(server.url + query);
  await page.waitForFunction(() => window.__game && window.__game.G.tiers.length > 0, { timeout: 30000 });
  return page;
}
const g = (page, fn, ...args) => page.evaluate(fn, ...args);
const live = (page) => page.waitForFunction(() => window.__game.G.live && window.__game.scene.snap, { timeout: 30000 });
async function check(name, fn) {
  if (only && !name.startsWith(only)) return;
  const t0 = Date.now();
  try { const note = await fn(); results.push([true, name, note || '']); }
  catch (e) { results.push([false, name, String(e.message || e).split('\n')[0]]); }
  console.log(`${results.at(-1)[0] ? 'PASS' : 'FAIL'}  ${name}  ${results.at(-1)[2]}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
/** Start a scenario through the real menu: scenario button, then Start. */
async function startFromMenu(page, index, side = 0) {
  await page.waitForSelector('#dlg[open] button[data-scn]');
  await page.click(`#dlg button[data-scn="${index}"]`);
  await page.waitForSelector('#dlg button[data-m="go"]');
  if (side) await page.click(`#dlg button[data-side="${side}"]`);
  await page.click('#dlg button[data-m="go"]');
  await live(page);
}

await check('boot: menu lists the free scenarios, no errors', async () => {
  const page = await open();
  await page.waitForSelector('#dlg[open] button[data-scn]');
  const n = await page.$$eval('#dlg button[data-scn]', (b) => b.length);
  assert(n >= 3, `only ${n} scenarios listed`);
  assert(page.errors.length === 0, page.errors.join('; '));
  await page.close();
  return `${n} scenarios`;
});

await check('keyboard: select, set course, change speed, pause', async () => {
  const page = await open();
  await startFromMenu(page, 2);
  await page.focus('#map');
  await page.keyboard.press('n');
  await page.waitForFunction(() => window.__game.scene.info && window.__game.scene.info.own);
  const before = await g(page, () => ({ kts: window.__game.scene.info.ordKts, wp: window.__game.scene.info.wp.length }));
  await page.keyboard.press('w');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.keyboard.press('s');
  await page.waitForFunction((b) => { const i = window.__game.scene.info; return i && i.wp.length === 2 && i.ordKts > b.kts; }, { timeout: 5000 }, before);
  const paused0 = await g(page, () => window.__game.G.paused);
  await page.keyboard.press('Space');
  const paused1 = await g(page, () => window.__game.G.paused);
  assert(paused0 !== paused1, 'Space did not toggle pause');
  assert(page.errors.length === 0, page.errors.join('; '));
  await page.close();
});

await check('save and load: the reloaded battle has the same state hash', async () => {
  const page = await open();
  await startFromMenu(page, 2);
  await page.focus('#map');
  await page.keyboard.press('n');
  await page.waitForFunction(() => window.__game.scene.info && window.__game.scene.info.own);
  await g(page, () => { const G = window.__game; G.order(1, G.scene.sel, 20, -10); G.setSpeed(64); }); // a course order, then run
  await page.waitForFunction(() => window.__game.G.tick > 1500, { timeout: 60000 });
  await g(page, () => window.__game.setSpeed(0));
  await sleep(300);
  await g(page, () => { const G = window.__game; G.order(3, G.scene.sel, 12); }); // an order given while paused, at the save tick
  await sleep(200);
  await page.keyboard.press('q'); // quick save
  await page.waitForFunction(() => localStorage.getItem('save') && window.__game.G.lastHash, { timeout: 5000 });
  const a = await g(page, () => ({ hash: window.__game.G.lastHash, tick: JSON.parse(localStorage.getItem('save')).tick, orders: JSON.parse(localStorage.getItem('save')).orders.length }));
  await g(page, () => { window.__game.G.live = false; window.__game.G.lastHash = 0; });
  await page.keyboard.press('y'); // quick load: replays seed + orders in the worker
  await live(page);
  const b = await g(page, async () => { const s = await window.__game.requestSave(); return { hash: window.__game.G.lastHash, tick: s.tick }; });
  assert(a.tick === b.tick, `tick ${a.tick} vs ${b.tick}`);
  assert(a.hash === b.hash, `hash ${a.hash} vs ${b.hash}`);
  assert(page.errors.length === 0, page.errors.join('; '));
  await page.close();
  return `tick ${a.tick}, ${a.orders} orders, hash ${a.hash}`;
});

await check('aircraft: launch from the unit card, drop a buoy, order it home (keyboard)', async () => {
  const page = await open();
  await startFromMenu(page, 0); // Gap Barrier: frigate with one SH-2F
  await g(page, () => { const G = window.__game; G.select(2); }); // the frigate
  await page.waitForFunction(() => window.__game.scene.info && window.__game.scene.info.hangar.length === 1);
  await page.click('#panel button[data-act="launch"]');
  await g(page, () => window.__game.setSpeed(8));
  await page.waitForFunction(() => window.__game.scene.info && window.__game.scene.info.hangar[0] && !window.__game.scene.info.hangar[0].stowed, { timeout: 10000 });
  await page.click('#panel button[data-act="pick"]'); // select the helicopter
  await page.waitForFunction(() => window.__game.scene.info && window.__game.scene.info.buoys.length === 2);
  await page.focus('#map');
  await page.keyboard.press('d'); // first buoy type
  await page.waitForFunction(() => window.__game.scene.info.buoys[0].n === 9, { timeout: 5000 });
  await page.keyboard.press('b'); // return to the deck
  await page.waitForFunction(() => (window.__game.scene.info.flags & 16) !== 0, { timeout: 5000 });
  assert(page.errors.length === 0, page.errors.join('; '));
  await page.close();
});

await check('AI versus AI: a battle runs to the end at 64x with no errors', async () => {
  const page = await open();
  await page.waitForSelector('#dlg[open]');
  // Bomber Stream (90 game minutes: carrier, fighters, twelve bombers), both sides run by the AI
  await g(page, () => { const G = window.__game; document.getElementById('dlg').close(); G.startScenario(G.SCENARIOS[1], { ai: 3, seed: 5 }); G.setSpeed(64); });
  await page.waitForFunction(() => window.__game.G.winner >= 0, { timeout: 240000, polling: 500 });
  const r = await g(page, async () => { const G = window.__game; const p = await G.perf(); return { winner: G.G.winner, tick: G.G.tick, steps: p.steps, mean: p.mean }; });
  assert(r.tick > 1000, `ended at tick ${r.tick}`);
  assert(page.errors.length === 0, page.errors.join('; '));
  await page.close();
  return `${['US', 'USSR', 'draw'][r.winner]} won at game minute ${Math.round(r.tick / 120)}, ${r.steps} steps, mean step ${r.mean.toFixed(3)} ms`;
});

await check('tutorial: played from the menu to victory with the keyboard alone', async () => {
  const page = await open();
  const hint = () => page.$eval('#hint', (h) => (h.hidden ? '' : h.textContent));
  const step = async (n) => {
    try { await page.waitForFunction((k) => { const h = document.getElementById('hint'); return !h.hidden && h.textContent.startsWith('Step ' + k + ' '); }, { timeout: 60000 }, n); }
    catch { throw new Error(`never reached step ${n}; hint was "${(await hint()).slice(0, 60)}", focus on ${await page.evaluate(() => document.activeElement.tagName)}`); }
  };
  await page.waitForSelector('#dlg[open] button[data-scn]');
  // the menu opens with focus on its first entry, the tutorial; Enter opens the briefing, Enter again starts it
  assert((await page.evaluate(() => document.activeElement.textContent)).includes('Tutorial'), 'menu focus is not on the tutorial');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#dlg button[data-m="go"]');
  await page.keyboard.press('Enter');
  await live(page);
  await step(1);
  await page.keyboard.press('n'); // select the frigate
  await step(2);
  await page.keyboard.press('w'); // course cursor, moved east with the arrow keys
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await step(3);
  for (let i = 0; i < 7; i++) await page.keyboard.press('.'); // run the clock up to 64x
  await step(5); // step 4 (wait for the contact) passes on its own
  await page.keyboard.press('t'); // target the contact
  await step(6);
  const seen = [1, 2, 3, 4, 5, 6];
  // fire weapon 2 (Harpoon); again whenever none is in flight, until the Krivak is sunk
  for (let i = 0; i < 60 && (await g(page, () => window.__game.G.winner)) < 0; i++) {
    const flying = await g(page, () => { const s = window.__game.scene.snap; let n = 0; for (let q = 0, p = 8; q < s[2]; q++, p += 13) if (s[p + 1] === 5 && s[p + 2] === 0) n++; return n; });
    if (!flying) await page.keyboard.press('2');
    if ((await hint()).startsWith('Step 7')) seen[6] = 7;
    await sleep(1000);
  }
  const r = await g(page, () => ({ winner: window.__game.G.winner, title: document.querySelector('#dlg[open] h1')?.textContent, hintHidden: document.getElementById('hint').hidden }));
  assert(r.winner === 0 && r.title === 'Victory', `winner ${r.winner}, dialog "${r.title}"`);
  assert(seen[6] === 7, 'never reached step 7');
  assert(r.hintHidden, 'hint still shown after the battle');
  assert(page.errors.length === 0, page.errors.join('; '));
  await page.close();
  return 'all 7 steps, no pointer input';
});

await check('offline: after one visit the game loads and plays with the network off', async () => {
  const page = await open();
  // wait until the service worker controls the page and has the whole game cached
  await page.waitForFunction(async () => {
    if (!navigator.serviceWorker.controller) return false;
    const keys = await caches.keys();
    if (!keys.length) return false;
    const have = (await (await caches.open(keys[0])).keys()).map((r) => new URL(r.url).pathname);
    return ['/data/free.json', '/map/depth.png', '/map/land-50m.json', '/index.html'].every((f) => have.includes(f)) && have.some((f) => /worker.*\.js$/.test(f));
  }, { timeout: 30000, polling: 250 });
  const cached = await g(page, async () => (await (await caches.open((await caches.keys())[0])).keys()).length);
  await page.setOfflineMode(true);
  const warnings = [];
  page.on('console', (m) => { if (m.type() === 'warn' || m.type() === 'error') warnings.push(m.text()); });
  await page.reload();
  await page.waitForFunction(() => window.__game && window.__game.G.tiers.length > 0, { timeout: 30000 });
  await startFromMenu(page, 0);
  await g(page, () => window.__game.setSpeed(64));
  await page.waitForFunction(() => window.__game.G.tick > 600, { timeout: 30000 });
  const ok = await g(page, async () => { const p = await window.__game.perf(); return { tick: p.tick, online: navigator.onLine }; });
  assert(ok.online === false, 'browser still thinks it is online');
  assert(!warnings.some((w) => /depth map|Failed to load|ERR_INTERNET/i.test(w)), 'offline run logged: ' + warnings.join(' | '));
  assert(page.errors.length === 0, page.errors.join('; '));
  await page.setOfflineMode(false);
  await page.close();
  return `${cached} files cached, battle reached tick ${ok.tick} offline`;
});

await browser.close();
await server.close();
const failed = results.filter((r) => !r[0]).length;
console.log(`\n${results.length - failed} of ${results.length} end-to-end checks passed`);
process.exit(failed ? 1 : 0);
