// Simulation worker: owns the Sim, paces fixed 0.5 s steps against real time, applies and logs orders,
// and posts fog-of-war snapshots to the page through two ping-ponged transferable buffers.
import {
  allocSim, resetSim, finishSetup, step, applyOrder, replay, writeSnapshot, compileDb, describe, hash,
  SNAP_LEN, DT, type Db, type Scenario, type Save,
} from './sim/sim';
import type { TierData } from './sim/types';
import './sim/all';
import { decodeGrayPng, type DepthMap } from './sim/depth';

const s = allocSim();
const pool: ArrayBuffer[] = [new ArrayBuffer(SNAP_LEN * 4), new ArrayBuffer(SNAP_LEN * 4)];
const times = new Float32Array(8192); // step durations in ms, for the perf script
let tn = 0, db: Db | null = null, depthP: Promise<DepthMap | null> | null = null, starts = 0, dirty = false;
let live = false, speed = 1, paused = true, acc = 0, last = 0, lastInfo = -1e9; // -1e9 = send the unit card with the next snapshot, whatever the clock says
let nodepth = false, side = 0, ai = 0, seed = 0, fit: Record<number, string> = {}, log: number[][] = [], sel = -1;
const MAX_STEPS = 16; // per 33 ms slice; 64x needs ~4.3

interface StartMsg { t: 'start'; tiers: TierData[]; scn: Scenario; seed: number; side: number; ai: number; fit: Record<number, string>; save?: Save; depthUrl: string }

function loadDepth(url: string): Promise<DepthMap | null> {
  // one shared load; a failure is reported and retried on the next start
  return (depthP ??= fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }).then(decodeGrayPng)
    .catch((e) => { depthP = null; postMessage({ t: 'warn', msg: 'Depth map unavailable; treating all water as deep. ' + e }); return null; }));
}

async function start(m: StartMsg): Promise<void> {
  const mine = ++starts;
  live = false;
  const depth = await loadDepth(m.depthUrl);
  if (mine !== starts) return; // a newer start arrived while the depth map was loading
  // A battle replays only with the depth data it was played with.
  if (m.save && !m.save.nodepth && !depth) { postMessage({ t: 'warn', msg: 'This save needs the depth map, which could not be loaded. Reconnect and try again.', fatal: true }); return; }
  nodepth = m.save ? !!m.save.nodepth : !depth;
  db = compileDb(...m.tiers);
  s.depth = nodepth ? null : depth!.data; s.dw = nodepth ? 0 : depth!.w; s.dh = nodepth ? 0 : depth!.h;
  side = m.side; ai = m.ai; seed = m.seed; fit = m.fit || {};
  if (m.save) { replay(s, db, m.scn, m.save); log = m.save.orders.slice(); }
  else { resetSim(s, db, m.scn, seed, fit); s.aiSides = ai; finishSetup(s); log = []; }
  acc = 0; last = performance.now(); tn = 0; live = true; // pause state is whatever the page last asked for
  const labels: Record<number, string> = {};
  for (let i = 0; i < s.n; i++) if (s.side[i] === side && s.label[i]) labels[i] = s.names[s.label[i] - 1];
  postMessage({ t: 'ready', labels, tick: s.tick });
  post();
}

function post(): void {
  const b = pool.pop();
  if (!b) { dirty = true; return; } // the page still holds both buffers: post as soon as one comes back
  dirty = false;
  writeSnapshot(s, side, new Float32Array(b));
  postMessage({ t: 'snap', b }, [b]);
  const now = performance.now();
  if (sel >= 0 && now - lastInfo > 200) { lastInfo = now; postMessage({ t: 'info', info: describe(s, sel, side) }); }
}

setInterval(() => {
  const now = performance.now();
  if (live && !paused && s.winner < 0) {
    acc += ((now - last) / 1000) * speed;
    let n = 0;
    while (acc >= DT && n < MAX_STEPS && s.winner < 0) {
      const t0 = performance.now();
      step(s);
      times[tn++ & 8191] = performance.now() - t0;
      acc -= DT; n++;
    }
    if (acc > DT * MAX_STEPS) acc = 0; // fell behind: drop the backlog instead of spiralling
    if (n) post();
  }
  last = now;
}, 33);

onmessage = (e: MessageEvent) => {
  const m = e.data;
  switch (m.t) {
    case 'start': start(m); break;
    case 'buf': pool.push(m.b); if (dirty && live) post(); break;
    case 'speed': speed = m.x; break;
    case 'pause': paused = m.on; last = performance.now(); break;
    case 'sel': sel = m.id; lastInfo = -1e9; if (live) postMessage({ t: 'info', info: sel >= 0 ? describe(s, sel, side) : null }); break;
    case 'order': {
      if (!live || s.winner >= 0) break;
      const o = [s.tick, ...m.o] as number[];
      if (s.side[o[2]] !== side) break; // only the player's own units take orders
      const r = applyOrder(s, o);
      if (r === 0) log.push(o); else postMessage({ t: 'deny', r, o });
      lastInfo = -1e9;
      post();
      break;
    }
    case 'save':
      postMessage({ t: 'save', save: { v: 1, scn: s.scn.id, seed, side, ai, tick: s.tick, fit, orders: log, ...(nodepth ? { nodepth: true } : {}) } as Save, hash: hash(s) });
      break;
    case 'perf': {
      if (m.reset) { tn = 0; break; } // drop warm-up samples
      const n = Math.min(tn, 8192), a = Array.from(times.subarray(0, n)).sort((x, y) => x - y);
      const q = (p: number) => (n ? a[Math.min(n - 1, Math.floor(n * p))] : 0);
      postMessage({ t: 'perf', steps: tn, mean: n ? a.reduce((x, y) => x + y, 0) / n : 0, p95: q(0.95), p99: q(0.99), max: n ? a[n - 1] : 0, tick: s.tick, ents: s.n });
      break;
    }
  }
};
