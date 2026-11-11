// Regenerates public/og.png, the 1200x630 picture shown when the game's link is shared: a Bomber Stream battle
// paused once the raid is on the plot, with the title over it. Run `npm run build` first, then
// `node scripts/og-image.mjs`. Edit the words in the overlay below if the game's name or tagline changes.
import { spawnSync } from 'node:child_process';
const EVAL = `(async () => {
  const g = window.__game, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const d = document.getElementById('dlg'); if (d.open) d.close();
  g.startScenario(g.SCENARIOS.find((s) => s.id === 'bomber-stream'), { side: 0, ai: 3, seed: 4 });
  g.setSpeed(64);
  const recs = () => { const s = g.scene.snap, out = []; if (s) for (let q = 0, p = 8; q < s[2]; q++, p += 16) out.push({ id: s[p], k: s[p + 1], side: s[p + 2], x: s[p + 4], y: s[p + 5], lvl: s[p + 10], stowed: s[p + 11] & 8 }); return out; };
  // run until the raid is on the plot: several hostile tracks, at least two of them missiles
  for (let i = 0; i < 280; i++) {
    await sleep(250);
    const h = recs().filter((r) => r.side !== 0 && r.lvl === 2);
    if (g.G.winner >= 0 || (h.length >= 7 && h.filter((r) => r.k === 5).length >= 3)) break;
  }
  g.setSpeed(0);
  await sleep(300);
  if (d.open) d.close();
  const own = recs().filter((r) => r.side === 0 && r.k === 1);
  const cx = own.reduce((a, r) => a + r.x, 0) / own.length, cy = own.reduce((a, r) => a + r.y, 0) / own.length;
  g.select(own[own.length - 1].id);
  g.view.z = 1.0; g.view.x = cx - (0.09 * 1200) / g.view.z; g.view.y = cy + 70;
  window.dispatchEvent(new Event('resize'));
  for (const id of ['bar', 'panel', 'log', 'hud', 'hint']) document.getElementById(id).style.display = 'none';
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;background:linear-gradient(90deg,rgba(7,18,29,.96) 0%,rgba(7,18,29,.9) 44%,rgba(7,18,29,0) 62%);display:flex;flex-direction:column;justify-content:center;padding:0 72px;font-family:system-ui,-apple-system,sans-serif;color:#dbe8f2';
  o.innerHTML = '<div style="font-size:26px;letter-spacing:.14em;text-transform:uppercase;color:#6fd3ff;margin-bottom:14px">Free browser game</div>' +
    '<div style="font-size:116px;font-weight:700;line-height:1">Flag Plot</div>' +
    '<div style="font-size:38px;margin-top:24px;white-space:nowrap;line-height:1.25">Cold War naval tactics on a 2D plot.<br>US Navy against the Soviet Navy.</div>' +
    '<div style="font-size:26px;margin-top:30px;color:#ffd166">No install · Works offline</div>';
  document.body.appendChild(o);
  await sleep(800);
  const h = recs().filter((r) => r.side !== 0);
  return { tick: g.G.tick, winner: g.G.winner, hostile: h.length, missiles: h.filter((r) => r.k === 5).length, own: own.length, cx, cy };
})()`;
const r = spawnSync('node', ['scripts/shot.mjs', '', 'public/og.png', '3000', '1200', '630'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, EVAL }, stdio: 'inherit' });
process.exit(r.status ?? 1);
