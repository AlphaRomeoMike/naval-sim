// Page controller: loads data, runs the worker, handles pointer/keyboard input and schedules drawing.
import { decodeLand, project, type Land, type Projected } from './map';
import { drawLand, drawUnits, type View, type Scene } from './render';
import {
  compileDb, allocSim, resetSim, finishSetup, step, SNAP_HDR, SNAP_REC, DT, HALF, K_WPN, K_BUOY, F_STOWED,
  O_MOVE, O_ADDWP, type Db, type Scenario, type Save, type Info,
} from './sim/sim';
import type { TierData } from './sim/types';
import './sim/all';
import { SCENARIOS, stress } from './scenarios';
import { decodeGrayPng } from './sim/depth';
import { initStore, ownedTiers, refreshStoreDialog, store } from './store';
import { initUi, renderPanel, logEvents, showMenu, showResult, onKey, tutorialTick, notify, resetUi } from './ui';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const landC = $<HTMLCanvasElement>('land'), mapC = $<HTMLCanvasElement>('map');
const lctx = landC.getContext('2d', { alpha: false })!, mctx = mapC.getContext('2d')!;

export const view: View = { x: 0, y: 0, z: 0.5, w: 0, h: 0, dpr: 1 };
export const scene: Scene = {
  snap: null, side: 0, sel: -1, tgt: -1, selGen: 0, tgtGen: 0, info: null, names: [], rings: [],
  unitName: (d) => (G.db && G.db.units[d] ? G.db.units[d].d.name : 'Contact'),
  weaponName: (d) => (G.db && G.db.weapons[d] ? G.db.weapons[d].d.name : ''),
  label: (id) => G.labels[id] || '',
};
/** Shared game state for the UI modules. */
export const G = {
  tiers: [] as TierData[], db: null as Db | null, scn: null as Scenario | null, labels: {} as Record<number, string>,
  speed: 1, paused: true, seed: 1, ai: 2, fit: {} as Record<number, string>, live: false, winner: -1, tick: 0, endTick: 0,
  moveMode: false, cursor: null as { x: number; y: number } | null, lastDeny: '', lastHash: 0,
};
let land: Land | null = null, proj: Projected | null = null;
let landDirty = true, raf = 0, lastDraw = 0;

export const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

// ---------- drawing: only when something changed, at most 30 fps, never while hidden ----------
export function invalidate(landToo = false): void {
  if (landToo) landDirty = true;
  if (!raf && !document.hidden) raf = requestAnimationFrame(draw);
}
function draw(t: number): void {
  raf = 0;
  if (t - lastDraw < 33) { raf = requestAnimationFrame(draw); return; }
  lastDraw = t;
  if (landDirty) { drawLand(lctx, view, proj); landDirty = false; }
  drawUnits(mctx, view, scene);
  if (G.cursor) {
    const sx = (G.cursor.x - view.x) * view.z + view.w / 2, sy = view.h / 2 - (G.cursor.y - view.y) * view.z;
    mctx.strokeStyle = '#ffd166'; mctx.beginPath();
    mctx.moveTo(sx - 10, sy); mctx.lineTo(sx + 10, sy); mctx.moveTo(sx, sy - 10); mctx.lineTo(sx, sy + 10); mctx.stroke();
  }
}
function resize(): void {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.w = window.innerWidth; view.h = window.innerHeight;
  for (const c of [landC, mapC]) { c.width = Math.round(view.w * view.dpr); c.height = Math.round(view.h * view.dpr); }
  invalidate(true);
}
function clampView(): void {
  view.z = Math.min(60, Math.max(Math.min(view.w, view.h) / (2.2 * HALF), view.z));
  view.x = Math.max(-HALF, Math.min(HALF, view.x)); view.y = Math.max(-HALF, Math.min(HALF, view.y));
}
export function zoomAt(f: number, sx = view.w / 2, sy = view.h / 2): void {
  const wx = view.x + (sx - view.w / 2) / view.z, wy = view.y - (sy - view.h / 2) / view.z;
  view.z *= f; clampView();
  view.x = wx - (sx - view.w / 2) / view.z; view.y = wy + (sy - view.h / 2) / view.z;
  clampView(); invalidate(true);
}
export function pan(dx: number, dy: number): void { view.x += dx / view.z; view.y += dy / view.z; clampView(); invalidate(true); }
export function centerOn(id: number): void {
  const p = find(id);
  if (p >= 0) { view.x = scene.snap![p + 4]; view.y = scene.snap![p + 5]; clampView(); invalidate(true); }
}
/** Offset of entity id in the current snapshot, or -1. */
export function find(id: number): number {
  const s = scene.snap;
  if (!s) return -1;
  for (let q = 0, p = SNAP_HDR; q < s[2]; q++, p += SNAP_REC) if (s[p] === id) return p;
  return -1;
}

// ---------- worker messages ----------
export function send(m: unknown): void { worker.postMessage(m); }
export function order(kind: number, unit: number, a = 0, b = 0, c = 0): void { send({ t: 'order', o: [kind, unit, a, b, c] }); }
export function setSpeed(x: number): void {
  if (x === 0) G.paused = true; else { G.paused = false; G.speed = x; send({ t: 'speed', x }); }
  send({ t: 'pause', on: G.paused });
  for (const b of $('speed').children) b.classList.toggle('on', Number((b as HTMLElement).dataset.s) === (G.paused ? 0 : G.speed));
}
export function select(id: number): void {
  const p = id >= 0 ? find(id) : -1;
  scene.sel = p >= 0 ? id : -1; scene.selGen = p >= 0 ? scene.snap![p + 12] : 0; scene.info = null;
  G.lastDeny = '';
  if (scene.sel < 0) scene.tgt = -1;
  send({ t: 'sel', id: scene.sel });
  renderPanel(); invalidate();
}
export function setTarget(id: number): void {
  const p = id >= 0 ? find(id) : -1;
  scene.tgt = p >= 0 ? id : -1; scene.tgtGen = p >= 0 ? scene.snap![p + 12] : 0;
  renderPanel(); invalidate();
}
let pendingSave: ((s: Save) => void) | null = null, pendingPerf: ((p: unknown) => void) | null = null;
export function requestSave(): Promise<Save> { return new Promise((r) => { pendingSave = r; send({ t: 'save' }); }); }

worker.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.t === 'snap') {
    if (scene.snap) { const b = scene.snap.buffer as ArrayBuffer; worker.postMessage({ t: 'buf', b }, [b]); } // transfer the previous buffer back, no copy
    const s = (scene.snap = new Float32Array(m.b));
    G.tick = s[0]; G.endTick = s[4];
    if (fitPending) { fitPending = false; fitView(s); }
    // a slot is reused after a kill: the generation tells the selected unit from whatever took its place
    const ps = scene.sel >= 0 ? find(scene.sel) : -1, pt = scene.tgt >= 0 ? find(scene.tgt) : -1;
    if (scene.sel >= 0 && (ps < 0 || s[ps + 12] !== scene.selGen)) select(-1);
    if (scene.tgt >= 0 && (pt < 0 || s[pt + 12] !== scene.tgtGen)) setTarget(-1);
    updateClock();
    logEvents(s);
    tutorialTick();
    if (s[1] >= 0 && G.winner < 0) { G.winner = s[1]; showResult(G.winner); }
    invalidate();
  } else if (m.t === 'ready') {
    G.labels = m.labels; G.live = true; G.winner = -1;
    scene.sel = -1; scene.tgt = -1;
    $('scnName').textContent = G.scn!.name;
    renderPanel();
  } else if (m.t === 'info') { scene.info = m.info as Info | null; renderPanel(); invalidate(); }
  else if (m.t === 'save') { G.lastHash = m.hash; pendingSave?.(m.save); pendingSave = null; }
  else if (m.t === 'perf') { pendingPerf?.(m); pendingPerf = null; }
  else if (m.t === 'deny') { G.lastDeny = m.r; renderPanel(); }
  else if (m.t === 'warn') { console.warn(m.msg); notify(m.msg); if (m.fatal) showMenu(); }
};
worker.onerror = (e) => console.error('worker error', e.message);

function updateClock(): void {
  const t = Math.floor(G.tick * DT), left = Math.max(0, Math.floor((G.endTick - G.tick) * DT));
  const f = (v: number) => `${String(Math.floor(v / 3600)).padStart(2, '0')}:${String(Math.floor(v / 60) % 60).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  $('clock').textContent = `${f(t)}  (−${f(left)})`;
}

/** Frame the player's own units when a battle starts. */
let fitPending = false;
function fitView(s: Float32Array): void {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let q = 0, p = SNAP_HDR; q < s[2]; q++, p += SNAP_REC) {
    if (s[p + 10] !== 3 || s[p + 2] !== scene.side) continue;
    x0 = Math.min(x0, s[p + 4]); x1 = Math.max(x1, s[p + 4]); y0 = Math.min(y0, s[p + 5]); y1 = Math.max(y1, s[p + 5]);
  }
  if (x1 < x0) return;
  view.x = (x0 + x1) / 2; view.y = (y0 + y1) / 2;
  view.z = Math.min(view.w, view.h) / Math.max(120, Math.max(x1 - x0, y1 - y0) * 2.2);
  clampView(); invalidate(true);
}

// ---------- scenario start ----------
export function startScenario(scn: Scenario, opts: { side?: number; ai?: number; seed?: number; fit?: Record<number, string>; save?: Save } = {}): void {
  G.scn = scn; G.db = compileDb(...G.tiers); G.live = false; G.winner = -1;
  scene.side = opts.side ?? 0;
  G.ai = opts.ai ?? (scene.side === 0 ? 2 : 1);
  G.seed = opts.seed ?? ((Math.random() * 0x7fffffff) | 0);
  G.fit = opts.fit || {};
  if (land) proj = project(land, scn.lon, scn.lat, proj || undefined);
  view.x = 0; view.y = 0; view.z = Math.min(view.w, view.h) / 900; clampView();
  $('log').textContent = '';
  resetUi();
  fitPending = true;
  send({ t: 'start', tiers: G.tiers, scn, seed: G.seed, side: scene.side, ai: G.ai, fit: G.fit, save: opts.save, depthUrl: new URL('map/depth.png', location.href).href });
  setSpeed(0);
  invalidate(true);
}

// ---------- pointer input ----------
const pts = new Map<number, { x: number; y: number }>();
let dragged = false, downAt = 0, pinch = 0, longPress = 0;
function pick(sx: number, sy: number): number {
  const s = scene.snap;
  if (!s) return -1;
  let best = -1, bd = 18 * 18;
  for (let q = 0, p = SNAP_HDR; q < s[2]; q++, p += SNAP_REC) {
    if (s[p + 10] === 1 || s[p + 1] === K_WPN || s[p + 1] === K_BUOY || s[p + 11] & F_STOWED) continue;
    const dx = (s[p + 4] - view.x) * view.z + view.w / 2 - sx, dy = view.h / 2 - (s[p + 5] - view.y) * view.z - sy;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = s[p]; }
  }
  return best;
}
export function moveTo(wx: number, wy: number, append: boolean): void {
  if (scene.sel < 0 || !scene.info || !scene.info.own) return;
  order(append ? O_ADDWP : O_MOVE, scene.sel, wx, wy);
  G.moveMode = false; G.cursor = null;
  renderPanel();
}
function click(sx: number, sy: number, alt: boolean, shift: boolean): void {
  const wx = view.x + (sx - view.w / 2) / view.z, wy = view.y - (sy - view.h / 2) / view.z;
  if (alt || G.moveMode) { moveTo(wx, wy, shift); return; }
  const id = pick(sx, sy);
  if (id < 0) return;
  const p = find(id), own = scene.snap![p + 10] === 3 && scene.snap![p + 2] === scene.side;
  if (own || scene.sel < 0 || !scene.info?.own) select(id);
  else setTarget(id);
}
mapC.addEventListener('pointerdown', (e) => {
  mapC.setPointerCapture(e.pointerId);
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  dragged = false; downAt = performance.now(); pinch = 0;
  clearTimeout(longPress);
  if (e.pointerType === 'touch' && pts.size === 1) {
    const x = e.clientX, y = e.clientY;
    longPress = window.setTimeout(() => { if (!dragged && pts.size === 1) { dragged = true; click(x, y, true, false); } }, 550);
  }
});
mapC.addEventListener('pointermove', (e) => {
  const p = pts.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  if (pts.size === 1) {
    if (!dragged && Math.abs(dx) + Math.abs(dy) < 6) return;
    dragged = true;
    p.x = e.clientX; p.y = e.clientY;
    pan(-dx, dy);
  } else if (pts.size === 2) {
    p.x = e.clientX; p.y = e.clientY;
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch) zoomAt(d / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
    pinch = d; dragged = true;
  }
});
const up = (e: PointerEvent) => {
  if (!pts.delete(e.pointerId)) return;
  clearTimeout(longPress);
  if (!dragged && e.type === 'pointerup' && performance.now() - downAt < 550) click(e.clientX, e.clientY, e.button === 2, e.shiftKey);
  pinch = 0;
};
mapC.addEventListener('pointerup', up);
mapC.addEventListener('pointercancel', up);
mapC.addEventListener('contextmenu', (e) => e.preventDefault());
mapC.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX, e.clientY); }, { passive: false });
window.addEventListener('resize', resize);
window.addEventListener('keydown', onKey);
let autoPaused = false;
document.addEventListener('visibilitychange', () => {
  // hidden: stop drawing (no rAF is requested) and hold the simulation
  if (document.hidden) { autoPaused = !G.paused; if (autoPaused) send({ t: 'pause', on: true }); }
  else { if (autoPaused) send({ t: 'pause', on: false }); invalidate(true); }
});

let stressAgain: (seed: number) => void = () => {};

// ---------- boot ----------
async function boot(): Promise<void> {
  resize();
  initUi();
  const [free, topo] = await Promise.all([
    fetch('data/free.json').then((r) => r.json() as Promise<TierData>),
    fetch('map/land-50m.json').then((r) => r.json()).catch(() => null),
  ]);
  G.tiers = [free];
  // owned packs load from this device's storage first (so they work offline), then refresh from the worker
  await initStore(() => { G.tiers = [free, ...ownedTiers()]; refreshStoreDialog(); });
  if (topo) land = decodeLand(topo);
  const n = Number(params.get('stress'));
  if (n > 0) {
    // Load-test hook for scripts/perf.mjs, which can also serve the paid packs at __packs/ to measure with
    // every unit in the game. A hosted build has no such path, so this loads nothing there.
    for (const id of (params.get('packs') || '').split(',').filter(Boolean)) {
      const t = await fetch(`__packs/${id}.json`).then((r) => (r.ok ? (r.json() as Promise<TierData>) : null)).catch(() => null);
      if (t) G.tiers.push(t);
    }
    const all: TierData = { note: '', weapons: {}, buoys: {}, units: Object.assign({}, ...G.tiers.map((t) => t.units)) };
    stressAgain = (seed: number) => { startScenario(stress(all, n, seed), { ai: 3, seed }); setSpeed(Number(params.get('speed')) || 64); send({ t: 'perf', reset: true }); };
    stressAgain(Number(params.get('seed')) || 3);
  } else showMenu();
}
boot();
// offline play: the service worker (generated at build time) pre-caches the game; not used by the dev server
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('offline cache unavailable', e));

// handle for the automated scripts (perf, purchase flow) and for debugging
(window as unknown as { __game: unknown }).__game = {
  G, scene, view, send, order, select, setTarget, setSpeed, startScenario, requestSave, SCENARIOS, store,
  perf: () => new Promise((r) => { pendingPerf = r; send({ t: 'perf' }); }),
  perfReset: () => send({ t: 'perf', reset: true }),
  // start a fresh load-test battle (JIT already warm) so the perf script can measure one from its first step
  stressAgain: (seed: number) => stressAgain(seed),
  // the same sim code on the page's main thread, so the perf script can time it under real CDP CPU throttling
  bench: async (units: number, steps: number) => {
    const s = allocSim();
    const d = await decodeGrayPng(await (await fetch('map/depth.png')).arrayBuffer());
    s.depth = d.data; s.dw = d.w; s.dh = d.h;
    const all: TierData = { note: '', weapons: {}, buoys: {}, units: Object.assign({}, ...G.tiers.map((t) => t.units)) };
    const db = compileDb(...G.tiers);
    // warm the JIT on a battle of its own, then time a fresh battle from its first step (the opening is the heaviest part)
    resetSim(s, db, stress(all, units, 3), 3); s.aiSides = 3; finishSetup(s);
    for (let i = 0; i < 3000; i++) step(s);
    resetSim(s, db, stress(all, units, 7), 7);
    s.aiSides = 3; finishSetup(s);
    const t = new Float32Array(steps);
    for (let i = 0; i < steps; i++) { const t0 = performance.now(); step(s); t[i] = performance.now() - t0; }
    const a = Array.from(t).sort((x, y) => x - y);
    return { mean: a.reduce((x, y) => x + y, 0) / steps, p99: a[Math.floor(steps * 0.99)], max: a[steps - 1], ents: s.n, tick: s.tick };
  },
};
