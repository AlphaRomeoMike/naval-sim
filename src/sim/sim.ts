// Simulation core: struct-of-arrays state, movement, spatial grid, detection, orders, snapshot.
// Pure TypeScript with no DOM access so it runs in the Web Worker and in Node tests.
// No trigonometry anywhere in here: only + - * / sqrt, so replays are bit-identical across engines.
import type { TierData, UnitDef, WeaponDef, BuoyDef } from './types';

export const MAX = 2048; // entity slots
export const NM = 8; // weapon mounts per entity
export const NPD = 4; // point-defence systems per entity
export const NWP = 8; // waypoints per entity
export const DT = 0.5; // seconds per sim step
export const CELL = 20; // km per grid cell
export const GW = 128; // grid cells per side
export const HALF = (CELL * GW) / 2; // world half-extent in km
export const KTS = 0.000514444; // km/s per knot

export const K_FREE = 0, K_SHIP = 1, K_SUB = 2, K_AIR = 3, K_BASE = 4, K_WPN = 5, K_BUOY = 6;
export const F_RADAR = 1, F_ACTIVE = 2, F_WFREE = 4, F_STOWED = 8, F_RTB = 16, F_LOOP = 32, F_CHAN = 64, F_AI = 128;
export const D_SENSORS = 1, D_PROP = 2, D_WEAPONS = 4, D_DECK = 8;

// order kinds: [tick, kind, unit, a, b, c]
export const O_MOVE = 1, O_ADDWP = 2, O_SPEED = 3, O_ALT = 4, O_RADAR = 5, O_SONAR = 6, O_FIRE = 7,
  O_LAUNCH = 8, O_RTB = 9, O_BUOY = 10, O_WFREE = 11, O_STOP = 12, O_FIT = 13;

// events: [kind, a, b, c]
export const E_CONTACT = 1, E_LOST = 2, E_LAUNCH = 3, E_HIT = 4, E_MISS = 5, E_KILL = 6, E_PD = 7,
  E_AGROUND = 8, E_AIROP = 9, E_BINGO = 10, E_BUOY = 11, E_DISABLED = 12, E_END = 13, E_NOGUIDE = 14;

const TMA_S = 180; // seconds of continuous passive hold before a bearing becomes a track
const NOISE_MAX = 1.5; // upper bound of any target noise factor, for query radius
const SURF_H = 60; // tallest surface target, for query radius
const MEMORY_TICKS = 1200; // lost contacts stay on the plot for 10 minutes

/** Radar / radio horizon in km for two heights in metres. */
export function horizonKm(h1: number, h2: number): number {
  return 4.12 * (Math.sqrt(h1 > 0 ? h1 : 0) + Math.sqrt(h2 > 0 ? h2 : 0));
}

/** d2 (km squared) is inside the horizon for two heights. Returns a boolean so hot callers never box a double. */
export function inHorizon(h1: number, h2: number, d2: number): boolean {
  const h = 4.12 * (Math.sqrt(h1 > 0 ? h1 : 0) + Math.sqrt(h2 > 0 ? h2 : 0));
  return d2 <= h * h;
}

// ---------- compiled database ----------
export interface CSonar { passiveKm: number; activeKm: number; towed: boolean }
export interface CMount { w: number; n: number; reload: number; l: number }
export interface CPd { name: string; min: number; max: number; interval: number; pHit: number }
export interface CUnit {
  id: string; d: UnitDef; kind: number; side: number; maxKmps: number; cruiseKmps: number;
  son: CSonar[]; activeKm: number; airKm: number; surfKm: number; mounts: CMount[]; pd: CPd[];
  loadouts: { name: string; items: { w: number; n: number }[] }[]; buoys: number[]; hosts: string[];
}
export interface CWeapon { id: string; d: WeaponDef; kmps: number; chan: boolean }
export interface CBuoy { id: string; d: BuoyDef; son: CSonar[] }
export interface Db {
  units: CUnit[]; weapons: CWeapon[]; buoys: CBuoy[];
  u: Record<string, number>; w: Record<string, number>; b: Record<string, number>; pingMax: number;
}

export function compileDb(...tiers: TierData[]): Db {
  const db: Db = { units: [], weapons: [], buoys: [], u: {}, w: {}, b: {}, pingMax: 0 };
  for (const t of tiers) {
    for (const id in t.weapons) {
      const d = t.weapons[id];
      db.w[id] = db.weapons.length;
      db.weapons.push({ id, d, kmps: d.kts * KTS, chan: d.seeker === 'sarh' || d.seeker === 'cmd' });
    }
    for (const id in t.buoys) {
      const d = t.buoys[id];
      db.b[id] = db.buoys.length;
      db.buoys.push({ id, d, son: [{ passiveKm: d.passiveKm, activeKm: d.activeKm, towed: false }] });
    }
  }
  const need = (m: Record<string, number>, id: string): number => {
    if (!(id in m)) throw new Error('unknown id ' + id);
    return m[id];
  };
  for (const t of tiers) {
    for (const id in t.units) {
      const d = t.units[id];
      const son = (d.sonar || []).map((s) => ({ passiveKm: s.passiveKm, activeKm: s.activeKm, towed: !!s.towed }));
      const activeKm = son.reduce((m, s) => Math.max(m, s.activeKm), 0);
      db.u[id] = db.units.length;
      db.units.push({
        id, d, side: d.side === 'us' ? 0 : 1,
        kind: d.cls === 'ship' ? K_SHIP : d.cls === 'sub' ? K_SUB : d.cls === 'base' ? K_BASE : K_AIR,
        maxKmps: d.kts * KTS, cruiseKmps: d.cruiseKts * KTS, son, activeKm,
        airKm: d.radar ? d.radar.airKm : 0, surfKm: d.radar ? d.radar.surfKm : 0,
        mounts: d.mounts.slice(0, NM).map((m) => ({ w: need(db.w, m.w), n: m.n, reload: Math.ceil(m.reloadS / DT), l: m.l ?? -1 })),
        pd: d.pd.slice(0, NPD).map((p) => ({ name: p.name, min: p.minKm, max: p.maxKm, interval: Math.ceil(p.intervalS / DT), pHit: p.pHit })),
        loadouts: Object.keys(d.loadouts || {}).map((name) => ({
          name, items: d.loadouts![name].slice(0, NM).map((i) => ({ w: need(db.w, i.w), n: i.n })),
        })),
        buoys: [], hosts: d.hosts || [],
      });
      db.pingMax = Math.max(db.pingMax, activeKm * 1.5);
    }
  }
  for (const b of db.buoys) db.pingMax = Math.max(db.pingMax, b.d.activeKm * 1.5);
  for (const u of db.units) {
    u.buoys = db.buoys.map((b) => (u.d.buoys && u.d.buoys[b.id]) || 0);
  }
  return db;
}

// ---------- scenario ----------
export interface ScnAir { type: string; n: number; loadout?: string }
export interface ScnUnit {
  side: 'us' | 'ussr'; type: string; name?: string; lon: number; lat: number;
  alt?: number; kts?: number; wp?: [number, number][]; air?: ScnAir[]; obj?: boolean; loadout?: string;
  hp?: number; // starts damaged, with this many hit points (never more than the type has)
}
export interface Scenario {
  id: string; name: string; brief: string; lon: number; lat: number;
  layerM: number; minutes: number; timeoutWinner: 'us' | 'ussr'; units: ScnUnit[]; // minutes 0 = no time limit
  tutorial?: string[];
}

// ---------- state ----------
export interface Sim {
  db: Db; scn: Scenario; tick: number; seed: number; n: number; winner: number; endTick: number;
  layer: number; kx: number; ky: number; lon0: number; lat0: number;
  depth: Uint8Array | null; dw: number; dh: number;
  aiSides: number; // bitmask of sides driven by the AI
  kind: Uint8Array; side: Uint8Array; def: Uint16Array; gen: Uint16Array; flags: Uint8Array; dis: Uint8Array;
  x: Float64Array; y: Float64Array; alt: Float32Array; ordAlt: Float32Array;
  dx: Float32Array; dy: Float32Array; spd: Float32Array; ordSpd: Float32Array; hp: Float32Array;
  wpN: Uint8Array; wpX: Float32Array; wpY: Float32Array;
  tgt: Int16Array; tgtGen: Uint16Array; host: Int16Array; hostGen: Uint16Array; fuel: Float32Array;
  mw: Int16Array; ammo: Uint16Array; ready: Int32Array; pdReady: Int32Array; busy: Int32Array;
  fcUsed: Uint8Array; engaged: Uint8Array; buoyN: Uint8Array; obj: Uint8Array;
  ai: Uint8Array; aiT: Int32Array; label: Uint16Array;
  det: Uint8Array; pend: Uint8Array; pasN: Uint8Array; holdT: Float32Array;
  lastX: Float32Array; lastY: Float32Array; lastT: Int32Array; holder: Int16Array; linkHolder: Int16Array;
  cellStart: Int16Array; cellItems: Int16Array; cellOf: Int16Array; airList: Int16Array; airN0: number; airN: number;
  ev: Int32Array; evN: number; hashView: Uint32Array; hashViewY: Uint32Array; names: string[];
  objN0: number; objN1: number; lo: Uint8Array; linkT: Int32Array; floor: Float32Array;
  aaR: Float32Array; suR: Float32Array; suD: Float32Array; // weapon reach per unit, see reach()
  pwX: Float32Array; pwY: Float32Array; pwN: Uint8Array; pSpd: Float32Array; pAlt: Float32Array; // patrol route the AI returns to
  pfix: Uint8Array; // per side and target: the track comes from passive bearings (cross-fix or target motion analysis)
  lostId: Int16Array; lostGen: Uint16Array; lostN: Uint8Array; // per side: the last 8 ships or submarines that dropped off the plot
}

export function allocSim(): Sim {
  const x = new Float64Array(MAX), y = new Float64Array(MAX);
  return {
    db: null as unknown as Db, scn: null as unknown as Scenario, tick: 0, seed: 0, n: 0, winner: -1, endTick: 0,
    layer: 100, kx: 1, ky: 1, lon0: 0, lat0: 0, depth: null, dw: 0, dh: 0, aiSides: 0,
    kind: new Uint8Array(MAX), side: new Uint8Array(MAX), def: new Uint16Array(MAX), gen: new Uint16Array(MAX),
    flags: new Uint8Array(MAX), dis: new Uint8Array(MAX), x, y,
    alt: new Float32Array(MAX), ordAlt: new Float32Array(MAX), dx: new Float32Array(MAX), dy: new Float32Array(MAX),
    spd: new Float32Array(MAX), ordSpd: new Float32Array(MAX), hp: new Float32Array(MAX),
    wpN: new Uint8Array(MAX), wpX: new Float32Array(MAX * NWP), wpY: new Float32Array(MAX * NWP),
    tgt: new Int16Array(MAX), tgtGen: new Uint16Array(MAX), host: new Int16Array(MAX), hostGen: new Uint16Array(MAX),
    fuel: new Float32Array(MAX), mw: new Int16Array(MAX * NM), ammo: new Uint16Array(MAX * NM),
    ready: new Int32Array(MAX * NM), pdReady: new Int32Array(MAX * NPD), busy: new Int32Array(MAX),
    fcUsed: new Uint8Array(MAX), engaged: new Uint8Array(MAX), buoyN: new Uint8Array(MAX * 4), obj: new Uint8Array(MAX),
    ai: new Uint8Array(MAX), aiT: new Int32Array(MAX), label: new Uint16Array(MAX),
    det: new Uint8Array(MAX * 2), pend: new Uint8Array(MAX * 2), pasN: new Uint8Array(MAX * 2),
    holdT: new Float32Array(MAX * 2), lastX: new Float32Array(MAX * 2), lastY: new Float32Array(MAX * 2),
    lastT: new Int32Array(MAX * 2), holder: new Int16Array(MAX * 2), linkHolder: new Int16Array(MAX * 2),
    cellStart: new Int16Array(GW * GW + 2), cellItems: new Int16Array(MAX), cellOf: new Int16Array(MAX),
    airList: new Int16Array(MAX), airN0: 0, airN: 0,
    ev: new Int32Array(4 * 256), evN: 0, hashView: new Uint32Array(x.buffer), hashViewY: new Uint32Array(y.buffer), names: [],
    objN0: 0, objN1: 0, lo: new Uint8Array(MAX), linkT: new Int32Array(MAX * 2), floor: new Float32Array(MAX),
    aaR: new Float32Array(MAX), suR: new Float32Array(MAX), suD: new Float32Array(MAX),
    pwX: new Float32Array(MAX * NWP), pwY: new Float32Array(MAX * NWP), pwN: new Uint8Array(MAX), pSpd: new Float32Array(MAX), pAlt: new Float32Array(MAX),
    pfix: new Uint8Array(MAX * 2),
    lostId: new Int16Array(16), lostGen: new Uint16Array(16), lostN: new Uint8Array(2),
  };
}

/** mulberry32 */
export function rnd(s: Sim): number {
  let t = (s.seed = (s.seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Scratch for hit(): the chance to roll against. A double passed as an argument would be boxed. */
export const CH = new Float64Array(1);
/** One PRNG draw: true with probability CH[0]. Works on a 24-bit integer so no number is boxed. */
export function hit(s: Sim): boolean {
  let t = (s.seed = (s.seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 8 < CH[0] * 16777216;
}
/** One PRNG draw: an integer in 0..n-1 (n up to 255). */
export function pick(s: Sim, n: number): number {
  let t = (s.seed = (s.seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (((t ^ (t >>> 14)) >>> 16) * n) >>> 16;
}

/** Queue an event for the UI. mask: bit 0 = side 0 may see it, bit 1 = side 1. */
export function emit(s: Sim, k: number, mask: number, a: number, b: number, c: number): void {
  if (s.evN >= 256) return;
  const o = s.evN++ * 4;
  s.ev[o] = k | (mask << 8); s.ev[o + 1] = a; s.ev[o + 2] = b; s.ev[o + 3] = c;
}

/** Sea depth in metres at a world position; 0 = land. Without a depth map everything is deep water. */
export function depthAt(s: Sim, x: number, y: number): number {
  if (!s.depth) return 3000;
  let px = Math.floor(((s.lon0 + x / s.kx + 180) / 360) * s.dw) % s.dw;
  if (px < 0) px += s.dw;
  let py = Math.floor(((90 - (s.lat0 + y / s.ky)) / 180) * s.dh);
  if (py < 0) py = 0; else if (py >= s.dh) py = s.dh - 1;
  const v = s.depth[py * s.dw + px] / 255;
  return v * v * 11000;
}

/**
 * Refresh unit i's cached sea floor and look 16 steps ahead along its heading. Returns true if the water ahead is
 * too shallow for it. Takes an index and returns a boolean: double arguments or results would be boxed per call.
 */
function probe(s: Sim, i: number): boolean {
  if (!s.depth) { s.floor[i] = 3000; return false; }
  const reach = s.spd[i] * DT * 16, dw = s.dw, dh = s.dh;
  for (let pass = 0; pass < 2; pass++) {
    const x = pass ? s.x[i] + s.dx[i] * reach : s.x[i], y = pass ? s.y[i] + s.dy[i] * reach : s.y[i];
    let px = Math.floor(((s.lon0 + x / s.kx + 180) / 360) * dw) % dw;
    if (px < 0) px += dw;
    let py = Math.floor(((90 - (s.lat0 + y / s.ky)) / 180) * dh);
    if (py < 0) py = 0; else if (py >= dh) py = dh - 1;
    const v = s.depth[py * dw + px] / 255, d = v * v * 11000;
    if (pass === 0) s.floor[i] = d; else return d < (s.kind[i] === K_SUB ? 30 : 5);
  }
  return false;
}

export function spawn(s: Sim, kind: number, side: number, def: number, x: number, y: number, alt: number): number {
  let i = 0;
  while (i < MAX && s.kind[i] !== K_FREE) i++;
  if (i >= MAX) return -1;
  if (i >= s.n) s.n = i + 1;
  s.kind[i] = kind; s.side[i] = side; s.def[i] = def; s.flags[i] = 0; s.dis[i] = 0;
  s.x[i] = x; s.y[i] = y; s.alt[i] = alt; s.ordAlt[i] = alt; s.dx[i] = 0; s.dy[i] = 1;
  s.spd[i] = 0; s.ordSpd[i] = 0; s.hp[i] = 1; s.wpN[i] = 0; s.tgt[i] = -1; s.host[i] = -1; s.fuel[i] = 0;
  s.pwN[i] = 0; s.pSpd[i] = 0; s.pAlt[i] = alt; s.floor[i] = depthAt(s, x, y); s.aaR[i] = 0; s.suR[i] = 0; s.suD[i] = 1; s.busy[i] = 0; s.fcUsed[i] = 0; s.engaged[i] = 0; s.obj[i] = 0; s.ai[i] = 0; s.aiT[i] = 0; s.label[i] = 0;
  for (let m = 0; m < NM; m++) { s.mw[i * NM + m] = -1; s.ammo[i * NM + m] = 0; s.ready[i * NM + m] = 0; }
  for (let m = 0; m < NPD; m++) s.pdReady[i * NPD + m] = 0;
  for (let m = 0; m < 4; m++) s.buoyN[i * 4 + m] = 0;
  for (let sd = 0; sd < 2; sd++) {
    const c = sd * MAX + i;
    s.det[c] = 0; s.pend[c] = 0; s.pasN[c] = 0; s.holdT[c] = 0; s.lastT[c] = -1; s.holder[c] = -1; s.linkHolder[c] = -1; s.linkT[c] = -1000;
  }
  return i;
}

export function free(s: Sim, i: number): void {
  s.kind[i] = K_FREE;
  s.gen[i]++;
  while (s.n > 0 && s.kind[s.n - 1] === K_FREE) s.n--;
}

/**
 * Refresh a unit's weapon reach: longest anti-air weapon, longest surface / anti-submarine weapon and its largest
 * damage, counting only mounts with rounds left. Kept as state so the automatic doctrine can reject on distance alone.
 */
export function reach(s: Sim, u: number): void {
  let a = 0, r = 0, dm = 1;
  for (let m = 0; m < NM; m++) {
    const wi = s.mw[u * NM + m];
    if (wi < 0 || s.ammo[u * NM + m] === 0) continue;
    const d = s.db.weapons[wi].d;
    if (d.altMax > 0 && d.maxKm > a) a = d.maxKm;
    if (d.altMin <= 0) { if (d.maxKm > r) r = d.maxKm; if (d.dmg > dm) dm = d.dmg; }
  }
  s.aaR[u] = a; s.suR[u] = r; s.suD[u] = dm;
}

function spawnUnit(s: Sim, ui: number, x: number, y: number, alt: number): number {
  const u = s.db.units[ui];
  const i = spawn(s, u.kind, u.side, ui, x, y, alt);
  if (i < 0) return i;
  s.hp[i] = u.d.hp;
  s.flags[i] = F_RADAR | F_WFREE;
  s.ordSpd[i] = u.cruiseKmps;
  for (let m = 0; m < u.mounts.length; m++) { s.mw[i * NM + m] = u.mounts[m].w; s.ammo[i * NM + m] = u.mounts[m].n; }
  for (let b = 0; b < u.buoys.length && b < 4; b++) s.buoyN[i * 4 + b] = u.buoys[b];
  reach(s, i);
  return i;
}

/** Load an aircraft's weapons from one of its named loadouts. */
export function arm(s: Sim, i: number, lo: number): void {
  const u = s.db.units[s.def[i]], L = u.loadouts[lo];
  for (let m = 0; m < NM; m++) {
    const it = L && L.items[m];
    s.mw[i * NM + m] = it ? it.w : -1; s.ammo[i * NM + m] = it ? it.n : 0; s.ready[i * NM + m] = 0;
  }
  s.lo[i] = lo;
  for (let b = 0; b < u.buoys.length && b < 4; b++) s.buoyN[i * 4 + b] = u.buoys[b];
  reach(s, i);
}

/** A fit-out swap is allowed only for the same side and role (and a deck the airframe can use). */
function fitted(db: Db, fit: Record<number, string> | undefined, slot: number, type: string, host?: string): string {
  const f = fit && fit[slot];
  if (!f || db.u[f] === undefined || db.u[type] === undefined) return type;
  const a = db.units[db.u[f]].d, b = db.units[db.u[type]].d;
  if (a.side !== b.side || a.role !== b.role) return type;
  if (host && !(a.hosts || []).includes(host) && !(db.units[db.u[host]].d.carries || []).includes(f)) return type;
  return f;
}

export function resetSim(s: Sim, db: Db, scn: Scenario, seed: number, fit?: Record<number, string>): Sim {
  s.db = db; s.scn = scn; s.tick = 0; s.seed = seed | 0; s.n = 0; s.winner = -1; s.evN = 0; s.aiSides = 0;
  s.endTick = scn.minutes > 0 ? Math.round((scn.minutes * 60) / DT) : 0x7fffffff;
  s.layer = scn.layerM; s.lon0 = scn.lon; s.lat0 = scn.lat;
  // one-off projection constant; rounded so engines whose cos() differs in the last bit still agree exactly
  s.kx = Math.round(111.32 * Math.cos((scn.lat * Math.PI) / 180) * 1e6) / 1e6;
  s.ky = 110.57;
  // Wipe every state array, so a reused Sim starts from exactly the same bytes as a fresh one.
  for (const key of Object.keys(s) as (keyof Sim)[]) {
    const v = s[key];
    if (ArrayBuffer.isView(v) && key !== 'depth' && key !== 'hashView' && key !== 'hashViewY') (v as Uint8Array).fill(0);
  }
  s.names.length = 0;
  s.lostId.fill(-1);
  let slot = 0;
  for (const su of scn.units) {
    const type = fitted(db, fit, slot++, su.type);
    const ui = db.u[type];
    if (ui === undefined) throw new Error('scenario unit type not loaded: ' + type);
    const u = db.units[ui];
    const x = clampW((su.lon - scn.lon) * s.kx), y = clampW((su.lat - scn.lat) * s.ky);
    const alt = su.alt ?? (u.kind === K_SUB ? -50 : u.kind === K_AIR ? Math.min(u.d.maxAltM || 3000, 3000) : 0);
    const i = spawnUnit(s, ui, x, y, alt);
    s.label[i] = s.names.push(su.name || u.d.name);
    s.obj[i] = su.obj ? 1 : 0;
    if (su.hp !== undefined && su.hp < s.hp[i]) s.hp[i] = su.hp;
    if (su.kts !== undefined) s.ordSpd[i] = Math.min(su.kts * KTS, u.maxKmps);
    if (su.wp) {
      s.flags[i] |= F_LOOP;
      for (const p of su.wp.slice(0, NWP)) addWp(s, i, clampW((p[0] - scn.lon) * s.kx), clampW((p[1] - scn.lat) * s.ky));
    }
    if (u.kind === K_AIR) {
      s.fuel[i] = (u.d.fuelMin || 120) * 60;
      arm(s, i, Math.max(0, u.loadouts.findIndex((l) => l.name === su.loadout)));
    }
    for (const a of su.air || []) {
      const atype = fitted(db, fit, slot++, a.type, type);
      const ai = db.u[atype];
      if (ai === undefined) throw new Error('scenario unit type not loaded: ' + atype);
      for (let k = 0; k < a.n; k++) {
        const j = spawnUnit(s, ai, x, y, 0);
        s.flags[j] |= F_STOWED;
        s.host[j] = i; s.hostGen[j] = s.gen[i];
        s.label[j] = s.names.push(db.units[ai].d.name + ' ' + (k + 1));
        arm(s, j, Math.max(0, db.units[ai].loadouts.findIndex((l) => l.name === a.loadout))); // default loadout
      }
    }
  }
  return s;
}

// ---------- movement ----------
function addWp(s: Sim, i: number, x: number, y: number): void {
  const n = s.wpN[i];
  if (n >= NWP) return;
  s.wpX[i * NWP + n] = x; s.wpY[i * NWP + n] = y; s.wpN[i] = n + 1;
}

function clampW(v: number): number { return v < -HALF + 1 ? -HALF + 1 : v > HALF - 1 ? HALF - 1 : v; }

// hooks filled in by combat.ts / air.ts / ai.ts so the core stays small and has no import cycles
export const hooks = {
  weapon: (_s: Sim, _i: number): void => {},
  air: (_s: Sim, _i: number): void => {},
  auto: (_s: Sim): void => {},
  ai: (_s: Sim): void => {},
};

const MV = new Float64Array(6); // scratch for move(): wanted speed, speed, next x, next y, wanted altitude, altitude limit
function move(s: Sim): void {
  const n = s.n;
  for (let i = 0; i < n; i++) {
    const k = s.kind[i];
    if (k === K_FREE || k === K_BASE) continue;
    if (k === K_WPN) { hooks.weapon(s, i); continue; }
    if (k === K_BUOY) { if ((s.fuel[i] -= DT) <= 0) free(s, i); continue; }
    if (s.flags[i] & F_STOWED) { const h = s.host[i]; s.x[i] = s.x[h]; s.y[i] = s.y[h]; continue; }
    const u = s.db.units[s.def[i]];
    if (k === K_AIR) { hooks.air(s, i); if (s.kind[i] === K_FREE || s.flags[i] & F_STOWED) continue; }
    // Branch-assigned doubles go through the MV scratch array, not locals (see the note at OB[7] in test()).
    MV[0] = s.wpN[i] > 0 || k === K_AIR ? s.ordSpd[i] : 0; // aircraft without a waypoint orbit in place
    MV[5] = s.dis[i] & D_PROP ? 0 : u.maxKmps;
    if (MV[0] > MV[5]) MV[0] = MV[5];
    const want = MV[0];
    const acc = k === K_AIR ? 0.01 : 0.0003; // km/s per step
    MV[1] = s.spd[i];
    if (MV[1] < want) { MV[1] += acc; if (MV[1] > want) MV[1] = want; } else { MV[1] -= acc * 2; if (MV[1] < want) MV[1] = want; }
    const v = MV[1];
    s.spd[i] = v;
    if (v > 0 && s.wpN[i] > 0) {
      const o = i * NWP;
      const ex = s.wpX[o] - s.x[i], ey = s.wpY[o] - s.y[i];
      const d = Math.sqrt(ex * ex + ey * ey), stepKm = v * DT;
      if (d <= stepKm) {
        MV[2] = s.wpX[o]; MV[3] = s.wpY[o];
        const wn = s.wpN[i];
        const fx = s.wpX[o], fy = s.wpY[o];
        for (let w = 1; w < wn; w++) { s.wpX[o + w - 1] = s.wpX[o + w]; s.wpY[o + w - 1] = s.wpY[o + w]; }
        if (s.flags[i] & F_LOOP) { s.wpX[o + wn - 1] = fx; s.wpY[o + wn - 1] = fy; } else s.wpN[i] = wn - 1;
      } else {
        const ux = ex / d, uy = ey / d;
        s.dx[i] = ux; s.dy[i] = uy;
        MV[2] = s.x[i] + ux * stepKm; MV[3] = s.y[i] + uy * stepKm;
      }
      const nx = MV[2], ny = MV[3], ox = s.x[i], oy = s.y[i];
      s.x[i] = nx < -HALF + 1 ? -HALF + 1 : nx > HALF - 1 ? HALF - 1 : nx;
      s.y[i] = ny < -HALF + 1 ? -HALF + 1 : ny > HALF - 1 ? HALF - 1 : ny;
      // The depth image is sampled once every 16 steps per unit (its pixels are ~18 km), 16 steps ahead.
      if (k !== K_AIR && (i & 15) === (s.tick & 15) && probe(s, i)) {
        s.wpN[i] = 0; s.spd[i] = 0; // shortcut: ships stop at the coast, no pathfinding; route around land by hand
        emit(s, E_AGROUND, 1 << s.side[i], i, 0, 0);
        s.x[i] = ox; s.y[i] = oy;
      }
    }
    MV[4] = s.ordAlt[i];
    if (k === K_SUB) {
      MV[5] = -(u.d.maxDepthM || 300);
      if (MV[4] < MV[5]) MV[4] = MV[5];
      MV[5] = -(s.floor[i] - 20);
      if (MV[4] < MV[5]) MV[4] = MV[5];
      if (MV[4] > -15) MV[4] = -15;
    }
    const want2 = MV[4], a = s.alt[i];
    if (a !== want2) {
      const r = k === K_AIR ? 25 : 1; // metres per step
      s.alt[i] = a < want2 ? (a + r > want2 ? want2 : a + r) : a - r < want2 ? want2 : a - r;
    }
  }
}

// ---------- spatial grid ----------
function buildGrid(s: Sim): void {
  const cs = s.cellStart, n = s.n, nc = GW * GW;
  cs.fill(0);
  let a0 = 0, a1 = MAX;
  for (let i = 0; i < n; i++) {
    const k = s.kind[i];
    // buoys are not targets, except that an active one can be heard pinging
    if (k === K_FREE || (k === K_BUOY && !(s.flags[i] & F_ACTIVE)) || s.flags[i] & F_STOWED) { s.cellOf[i] = -1; continue; }
    if (s.alt[i] > 0) {
      // airborne entities go to a compact per-side list instead of the grid
      if (s.side[i] === 0) s.airList[a0++] = i; else s.airList[--a1] = i;
      s.cellOf[i] = -1;
      continue;
    }
    const c = ((((s.y[i] + HALF) / CELL) | 0) * GW + (((s.x[i] + HALF) / CELL) | 0)) | 0;
    s.cellOf[i] = c;
    cs[c + 1]++;
  }
  s.airN0 = a0; s.airN = a1;
  // counts -> starts, with the running sum in a local (a memory-carried prefix sum is 5x slower)
  let acc = 0;
  for (let c = 1; c <= nc; c++) { const k = cs[c]; cs[c] = acc; acc += k; } // cs[c+1] = start of cell c
  for (let i = 0; i < n; i++) { const c = s.cellOf[i]; if (c >= 0) s.cellItems[cs[c + 1]++] = i; }
  // now cell c spans cellItems[cs[c] .. cs[c+1])
}

// ---------- detection ----------
// Observer scratch state (module-level so nothing is allocated per sweep).
// Doubles live in one Float64Array: a module-level `let` holding a double is boxed and reallocated on every write.
const OB = new Float64Array(8); // 0 x, 1 y, 2 height, 3 air range, 4 surface range, 5 sonar radius squared, 6 query radius, 7 target noise
let oI = 0, oSide = 0, oActive = false, oSon: CSonar[] = [], oBelow = false, oDeepWater = false, oLink = -1;

/** Load observer o into scratch state. Leaves the grid query radius in km in OB[6] (0 = cannot sense). */
function prep(s: Sim, o: number): void {
  const k = s.kind[o];
  oI = o; oSide = s.side[o]; OB[0] = s.x[o]; OB[1] = s.y[o];
  OB[3] = 0; OB[4] = 0; OB[5] = 0; OB[6] = 0; oSon = NOSON; oActive = false; oLink = -1;
  if (s.dis[o] & D_SENSORS) return;
  if (k === K_BUOY) {
    const h = s.host[o];
    // a buoy reports only while its aircraft is alive, airborne and inside radio range
    if (s.kind[h] !== K_AIR || s.gen[h] !== s.hostGen[o] || s.flags[h] & F_STOWED) return;
    const ex = s.x[h] - OB[0], ey = s.y[h] - OB[1], hr = 4.12 * (Math.sqrt(s.alt[h] > 0 ? s.alt[h] : 0) + 1); // radio horizon to a 1 m antenna
    if (ex * ex + ey * ey > hr * hr) return;
    const b = s.db.buoys[s.def[o]];
    oSon = b.son; oActive = b.d.activeKm > 0; oBelow = s.alt[o] < -s.layer;
    if (s.db.units[s.def[h]].d.link) oLink = h;
    let r = b.d.passiveKm * NOISE_MAX;
    if (b.d.activeKm > r) r = b.d.activeKm;
    if (b.d.passiveKm > 0 && s.db.pingMax > r) r = s.db.pingMax;
    OB[5] = r * r; OB[6] = r;
    return;
  }
  const u = s.db.units[s.def[o]];
  if (u.d.link) oLink = o;
  if (s.flags[o] & F_RADAR && u.d.radar) {
    OB[2] = k === K_AIR ? s.alt[o] : u.d.heightM;
    OB[3] = u.airKm; OB[4] = u.surfKm;
    OB[6] = 4.12 * (Math.sqrt(OB[2]) + Math.sqrt(SURF_H)); // horizon to the tallest surface target
    if (OB[4] < OB[6]) OB[6] = OB[4];
  }
  if (u.son.length && k !== K_AIR) {
    oSon = u.son; oActive = (s.flags[o] & F_ACTIVE) !== 0;
    oBelow = k === K_SUB && s.alt[o] < -s.layer;
    // a ship's towed array hangs below the layer where the water is deep enough; a submarine's is at its own depth
    oDeepWater = k === K_SHIP ? s.floor[o] > s.layer + 50 : oBelow;
    let sr = 0;
    for (let q = 0; q < oSon.length; q++) {
      const sn = oSon[q], pr = sn.passiveKm * NOISE_MAX;
      if (pr > sr) sr = pr;
      if (oActive && sn.activeKm > sr) sr = sn.activeKm;
      if (sn.passiveKm > 0 && s.db.pingMax > sr) sr = s.db.pingMax;
    }
    OB[5] = sr * sr;
    if (sr > OB[6]) OB[6] = sr;
  }
}
const NOSON: CSonar[] = [];

/** Noise factor of a target for passive sonar: rises with speed. */
export function noiseOf(s: Sim, t: number): number {
  const k = s.kind[t];
  if (k === K_WPN) return 1.2;
  if (k === K_SUB && s.busy[t] > s.tick) return NOISE_MAX; // launch transient: a submarine that just fired is loud
  const u = s.db.units[s.def[t]];
  return u.maxKmps > 0 ? u.d.noise * (0.25 + (0.75 * s.spd[t]) / u.maxKmps) : 0;
}

/** Detection level of target t for the prepared observer: 0 none, 1 bearing only, 2 track. */
function test(s: Sim, t: number): number {
  const k = s.kind[t];
  const ex = s.x[t] - OB[0], ey = s.y[t] - OB[1];
  const d2 = ex * ex + ey * ey, ta = s.alt[t];
  if (k === K_BUOY) {
    // an active buoy is a pinger: passive sonar hears it, as a bearing, out to 1.5x its active range
    const pr = s.db.buoys[s.def[t]].d.activeKm * 1.5, tBelow = ta < -s.layer;
    for (let q = 0; q < oSon.length; q++) {
      const sn = oSon[q];
      if (sn.passiveKm <= 0) continue;
      const r = (sn.towed ? oDeepWater : oBelow) !== tBelow ? pr * 0.5 : pr;
      if (d2 <= r * r) return 1;
    }
    return 0;
  }
  if (ta > 0 || k === K_SHIP) {
    let r = ta > 0 ? OB[3] : OB[4];
    if (k === K_WPN) r *= 0.5; // small radar target
    if (d2 <= r * r) { // static range first: most pairs fail here and never pay for the square roots
      // radar horizon, written out here: a call with double arguments would box them whenever it is not inlined
      const th = ta > 0 ? ta : s.db.units[s.def[t]].d.heightM, hz = 4.12 * (Math.sqrt(OB[2]) + Math.sqrt(th > 0 ? th : 0));
      if (d2 <= hz * hz) return 2;
    }
    if (ta > 0) return 0;
  }
  let lvl = 0;
  const ns = oSon.length;
  if (ns && k !== K_AIR && k !== K_BASE && d2 <= OB[5]) {
    const tBelow = ta < -s.layer;
    // Same rule as noiseOf(), inline. The value goes through OB[7] rather than a local assigned in three branches:
    // V8 kept that local as a tagged value and boxed the computed double on every pass (1.3 KB per step).
    OB[7] = 1.2;
    if (k !== K_WPN) {
      if (k === K_SUB && s.busy[t] > s.tick) OB[7] = NOISE_MAX;
      else { const tu = s.db.units[s.def[t]]; OB[7] = tu.maxKmps > 0 ? tu.d.noise * (0.25 + (0.75 * s.spd[t]) / tu.maxKmps) : 0; }
    }
    const nf = OB[7];
    const ping = k !== K_WPN && s.flags[t] & F_ACTIVE ? s.db.units[s.def[t]].activeKm * 1.5 : 0;
    for (let q = 0; q < ns; q++) {
      const sn = oSon[q];
      const below = sn.towed ? oDeepWater : oBelow;
      const f = below !== tBelow ? 0.5 : 1; // across the thermocline
      if (oActive && sn.activeKm > 0) { const r = sn.activeKm * f; if (d2 <= r * r) return 2; }
      if (sn.passiveKm > 0 && lvl === 0) {
        let r = sn.passiveKm * nf * f;
        const pr = ping * f; // an active pinger gives itself away out to 1.5x its range
        if (pr > r) r = pr;
        if (d2 <= r * r) lvl = 1;
      }
    }
  }
  return lvl;
}

function note(s: Sim, t: number, lvl: number): void {
  const c = oSide * MAX + t;
  if (lvl >= s.pend[c]) { s.pend[c] = lvl; s.holder[c] = oI; }
  if (lvl === 1) s.pasN[c]++;
  if (oLink >= 0) { s.linkHolder[c] = oLink; s.linkT[c] = s.tick; }
}

function sweep(s: Sim): void {
  const n = s.n, phase = s.tick & 3;
  for (let o = phase; o < n; o += 4) {
    const k = s.kind[o];
    if (k === K_FREE || k === K_WPN || s.flags[o] & F_STOWED) continue;
    prep(s, o);
    const r = OB[6], oX = OB[0], oY = OB[1], oAir = OB[3];
    // A target already tracked this cycle needs no second look, unless this observer could add a datalink holder.
    const base = oSide * MAX, cyc = s.tick - phase, pend = s.pend, linkT = s.linkT, link = oLink >= 0;
    if (oAir > 0) {
      const a = oSide === 0 ? s.airN : 0, b = oSide === 0 ? MAX : s.airN0;
      for (let q = a; q < b; q++) {
        const t = s.airList[q];
        if (pend[base + t] === 2 && (!link || linkT[base + t] >= cyc)) continue;
        const l = test(s, t);
        if (l) note(s, t, l);
      }
    }
    if (r <= 0) continue;
    let cx0 = ((oX - r + HALF) / CELL) | 0, cx1 = ((oX + r + HALF) / CELL) | 0;
    let cy0 = ((oY - r + HALF) / CELL) | 0, cy1 = ((oY + r + HALF) / CELL) | 0;
    if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0; if (cx1 >= GW) cx1 = GW - 1; if (cy1 >= GW) cy1 = GW - 1;
    const cs = s.cellStart;
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * GW;
      const from = cs[row + cx0], to = cs[row + cx1 + 1];
      for (let q = from; q < to; q++) {
        const t = s.cellItems[q];
        if (s.side[t] === oSide || (pend[base + t] === 2 && (!link || linkT[base + t] >= cyc))) continue;
        const l = test(s, t);
        if (l) note(s, t, l);
      }
    }
  }
}

function commit(s: Sim): void {
  const n = s.n;
  for (let sd = 0; sd < 2; sd++) {
    const base = sd * MAX;
    for (let i = 0; i < n; i++) {
      const c = base + i;
      if (s.kind[i] === K_FREE || s.side[i] === sd) { s.pend[c] = 0; s.pasN[c] = 0; s.det[c] = 0; continue; }
      let p = s.kind[i] === K_BASE ? 2 : s.pend[c]; // fixed installations are always known
      if (p === 1) {
        s.holdT[c] += DT * 4;
        if (s.kind[i] === K_BUOY) s.holdT[c] = 0; // a ping gives a bearing to the buoy, never a track
        else if (s.pasN[c] >= 2 || s.holdT[c] >= TMA_S) p = 2; // cross-fix or target motion analysis
      } else if (p === 0) { s.holdT[c] = 0; s.holder[c] = -1; s.linkHolder[c] = -1; }
      // a unit that only has a bearing may still shoot if the side's fix is itself made of bearings
      s.pfix[c] = p > 0 && (s.pasN[c] >= 2 || s.holdT[c] >= TMA_S) ? 1 : 0;
      const was = s.det[c];
      if (p === 2) { s.lastX[c] = s.x[i]; s.lastY[c] = s.y[i]; s.lastT[c] = s.tick; }
      if (p !== was && s.kind[i] !== K_WPN) {
        if (was === 0) emit(s, E_CONTACT, 1 << sd, i, p, s.kind[i]);
        else if (p === 0) {
          emit(s, E_LOST, 1 << sd, i, 0, s.kind[i]);
          if (s.lastT[c] >= 0 && (s.kind[i] === K_SHIP || s.kind[i] === K_SUB)) { // it was tracked at some point: remember the datum for the AI's searches
            const q = sd * 8 + (s.lostN[sd]++ & 7);
            s.lostId[q] = i; s.lostGen[q] = s.gen[i];
          }
        }
      }
      s.det[c] = p; s.pend[c] = 0; s.pasN[c] = 0;
    }
  }
}

/** True if unit u currently senses target t itself, or through its own sonobuoys. */
export function holds(s: Sim, u: number, t: number): boolean {
  const pf = s.pfix[s.side[u] * MAX + t] === 1; // own bearing + a passive fix (cross-fix, or held long enough) is a solution
  prep(s, u);
  if (OB[6] > 0 || OB[3] > 0) { const l = test(s, t); if (l === 2 || (l === 1 && pf)) return true; }
  if (s.kind[u] !== K_AIR) return false;
  for (let b = 0; b < s.n; b++) {
    if (s.kind[b] !== K_BUOY || s.host[b] !== u || s.hostGen[b] !== s.gen[u]) continue;
    prep(s, b);
    if (OB[6] > 0) { const l = test(s, t); if (l === 2 || (l === 1 && pf)) return true; }
  }
  return false;
}

/** Firing-solution rule: own hold, or a datalinked holder within radio range of a datalinked shooter. */
export function canEngage(s: Sim, u: number, t: number): boolean {
  const c = s.side[u] * MAX + t;
  if (s.det[c] < 2) return false;
  if (s.kind[t] === K_BASE || s.holder[c] === u) return true;
  const lh = s.linkHolder[c];
  if (lh >= 0 && lh !== u && s.tick - s.linkT[c] <= 8 && s.kind[lh] !== K_FREE && s.kind[lh] !== K_WPN && s.kind[lh] !== K_BUOY && s.db.units[s.def[u]].d.link) {
    const ex = s.x[lh] - s.x[u], ey = s.y[lh] - s.y[u];
    // heights go through OB[7]: a local fed by both a typed array and an object field gets boxed
    OB[7] = s.kind[u] === K_AIR ? s.alt[u] : s.db.units[s.def[u]].d.heightM;
    const hz1 = Math.sqrt(OB[7] > 0 ? OB[7] : 0);
    OB[7] = s.kind[lh] === K_AIR ? s.alt[lh] : s.db.units[s.def[lh]].d.heightM;
    const hz = 4.12 * (hz1 + Math.sqrt(OB[7] > 0 ? OB[7] : 0));
    if (ex * ex + ey * ey <= hz * hz) return true;
  }
  if (holds(s, u, t)) return true;
  if (!s.db.units[s.def[u]].d.link) return false;
  // slow path, only when the recorded holder is out of radio range: any other datalinked friend in range that holds it
  const sd = s.side[u];
  OB[7] = s.kind[u] === K_AIR ? s.alt[u] : s.db.units[s.def[u]].d.heightM;
  const rs = 4.12 * (Math.sqrt(OB[7] > 0 ? OB[7] : 0) + Math.sqrt(SURF_H)), cs = s.cellStart;
  let cx0 = ((s.x[u] - rs + HALF) / CELL) | 0, cx1 = ((s.x[u] + rs + HALF) / CELL) | 0;
  let cy0 = ((s.y[u] - rs + HALF) / CELL) | 0, cy1 = ((s.y[u] + rs + HALF) / CELL) | 0;
  if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0; if (cx1 >= GW) cx1 = GW - 1; if (cy1 >= GW) cy1 = GW - 1;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let p = cs[cy * GW + cx0], e = cs[cy * GW + cx1 + 1]; p < e; p++) if (relays(s, u, s.cellItems[p], t)) return true;
  }
  const a = sd === 0 ? 0 : s.airN, b = sd === 0 ? s.airN0 : MAX;
  for (let p = a; p < b; p++) if (relays(s, u, s.airList[p], t)) return true;
  return false;
}
/** True if v is a datalinked friend of u inside radio range that itself holds t. (Indices only: double arguments to a call that is not inlined get boxed.) */
function relays(s: Sim, u: number, v: number, t: number): boolean {
  const k = s.kind[v];
  if (v === u || s.side[v] !== s.side[u] || (k !== K_SHIP && k !== K_AIR && k !== K_BASE)) return false;
  const d = s.db.units[s.def[v]].d;
  if (!d.link) return false;
  const ex = s.x[v] - s.x[u], ey = s.y[v] - s.y[u];
  OB[7] = s.kind[u] === K_AIR ? s.alt[u] : s.db.units[s.def[u]].d.heightM;
  const h1 = Math.sqrt(OB[7] > 0 ? OB[7] : 0);
  OB[7] = k === K_AIR ? s.alt[v] : d.heightM;
  const hz = 4.12 * (h1 + Math.sqrt(OB[7] > 0 ? OB[7] : 0));
  return ex * ex + ey * ey <= hz * hz && holds(s, v, t);
}

// ---------- victory ----------
function checkEnd(s: Sim): void {
  if (s.winner >= 0) return;
  let alive0 = 0, alive1 = 0, any0 = 0, any1 = 0;
  for (let i = 0; i < s.n; i++) {
    const k = s.kind[i];
    if (k !== K_SHIP && k !== K_SUB && k !== K_BASE && k !== K_AIR) continue;
    if (s.side[i] === 0) { any0++; if (s.obj[i]) alive0++; } else { any1++; if (s.obj[i]) alive1++; }
  }
  // a side loses when its objective units are gone (or everything, if it has none flagged)
  const lost0 = s.objN0 > 0 ? alive0 === 0 : any0 === 0, lost1 = s.objN1 > 0 ? alive1 === 0 : any1 === 0;
  if (lost0 || lost1) s.winner = lost0 && lost1 ? 2 : lost0 ? 1 : 0;
  else if (s.tick >= s.endTick) s.winner = s.scn.timeoutWinner === 'us' ? 0 : 1;
  if (s.winner >= 0) emit(s, E_END, 3, s.winner, 0, 0);
}

/** Internal phases, exported for tests and profiling. */
export const phases = { move, buildGrid, sweep, commit };

export function step(s: Sim): void {
  move(s);
  buildGrid(s);
  sweep(s);
  if ((s.tick & 3) === 3) { commit(s); checkEnd(s); }
  // weapon release and AI run every step, each on a slice of the units, so no step carries all of it
  hooks.auto(s);
  hooks.ai(s);
  s.tick++;
}

// ---------- orders ----------
/** Apply one order [tick, kind, unit, a, b, c]. Returns 0 if accepted, else a reason code. */
export function applyOrder(s: Sim, o: number[]): number {
  const k = o[1], i = o[2];
  if (!(i >= 0 && i < MAX) || s.kind[i] === K_FREE || s.kind[i] === K_WPN || s.kind[i] === K_BUOY) return 1;
  if (!Number.isFinite(o[3] ?? 0) || !Number.isFinite(o[4] ?? 0) || !Number.isFinite(o[5] ?? 0)) return 1;
  const u = s.db.units[s.def[i]];
  switch (k) {
    case O_MOVE: s.wpN[i] = 0; s.flags[i] &= ~(F_LOOP | F_RTB); addWp(s, i, clampW(o[3]), clampW(o[4])); return 0;
    case O_ADDWP: addWp(s, i, clampW(o[3]), clampW(o[4])); return 0;
    case O_STOP: s.wpN[i] = 0; s.flags[i] &= ~(F_LOOP | F_RTB); return 0;
    case O_SPEED: {
      const min = u.d.cls === 'air' ? u.cruiseKmps * 0.6 : 0;
      const v = o[3] * KTS;
      s.ordSpd[i] = v < min ? min : v > u.maxKmps ? u.maxKmps : v;
      return 0;
    }
    case O_ALT: {
      let a = o[3];
      if (u.kind === K_AIR) { const lo = u.d.minAltM || 15, hi = u.d.maxAltM || 10000; a = a < lo ? lo : a > hi ? hi : a; }
      else if (u.kind === K_SUB) { const lim = -(u.d.maxDepthM || 300); a = a > -15 ? -15 : a < lim ? lim : a; }
      else return 1;
      s.ordAlt[i] = a;
      return 0;
    }
    case O_RADAR: if (o[3]) s.flags[i] |= F_RADAR; else s.flags[i] &= ~F_RADAR; return 0;
    case O_SONAR: if (o[3] && u.activeKm > 0) s.flags[i] |= F_ACTIVE; else s.flags[i] &= ~F_ACTIVE; return 0;
    case O_WFREE: if (o[3]) s.flags[i] |= F_WFREE; else s.flags[i] &= ~F_WFREE; return 0;
    default: { const h = handlers[k]; return h ? h(s, o) : 1; }
  }
}
/** Orders implemented by other modules (fire, launch, recover, buoy) register here. */
const handlers: ((s: Sim, o: number[]) => number)[] = [];
export function addOrderHandler(kind: number, f: (s: Sim, o: number[]) => number): void { handlers[kind] = f; }

// ---------- save / replay ----------
export interface Save { v: 1; scn: string; seed: number; side: number; ai: number; tick: number; fit: Record<number, string>; orders: number[][]; nodepth?: boolean }

/** Rebuild a battle from scenario + seed + order log. */
export function replay(s: Sim, db: Db, scn: Scenario, save: Save): Sim {
  resetSim(s, db, scn, save.seed, save.fit);
  s.aiSides = save.ai;
  finishSetup(s);
  let q = 0;
  const ord = save.orders;
  while (s.tick < save.tick) {
    while (q < ord.length && ord[q][0] <= s.tick) applyOrder(s, ord[q++]);
    step(s);
  }
  while (q < ord.length && ord[q][0] <= s.tick) applyOrder(s, ord[q++]); // orders given at the moment of the save
  s.evN = 0; // events from the replayed past are not news
  return s;
}

/** Call once after resetSim and after choosing aiSides. */
export function finishSetup(s: Sim): void {
  s.objN0 = 0; s.objN1 = 0;
  for (let i = 0; i < s.n; i++) {
    if (s.obj[i]) { if (s.side[i] === 0) s.objN0++; else s.objN1++; }
    if (s.aiSides & (1 << s.side[i])) s.flags[i] |= F_AI;
    // remember the scenario's route, speed and depth so the AI can come back to them after an attack or an evasion
    s.pwN[i] = s.wpN[i]; s.pSpd[i] = s.ordSpd[i]; s.pAlt[i] = s.ordAlt[i];
    for (let w = 0; w < s.wpN[i]; w++) { s.pwX[i * NWP + w] = s.wpX[i * NWP + w]; s.pwY[i * NWP + w] = s.wpY[i * NWP + w]; }
  }
}

/** FNV-1a over every state array (not the per-step scratch: grid, air list, event queue). */
export function hash(s: Sim): number {
  let h = 0x811c9dc5 ^ s.tick;
  h = Math.imul(h ^ s.seed, 0x01000193); h = Math.imul(h ^ s.n, 0x01000193); h = Math.imul(h ^ s.winner, 0x01000193);
  for (const key of Object.keys(s) as (keyof Sim)[]) {
    const v = s[key];
    if (!ArrayBuffer.isView(v) || SCRATCH.has(key)) continue;
    const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193);
  }
  return h >>> 0;
}
/** Sim fields that are rebuilt every step or are views of other fields: not part of the state. */
export const SCRATCH: Set<string> = new Set(['depth', 'ev', 'cellStart', 'cellItems', 'cellOf', 'airList', 'hashView', 'hashViewY']);

// ---------- snapshot for the UI ----------
export const SNAP_HDR = 8, SNAP_REC = 13;
export const SNAP_LEN = SNAP_HDR + MAX * SNAP_REC + 256 * 4;

/**
 * Write what `side` is allowed to see into buf. Header: tick, winner, count, evCount, endTick.
 * Record: id, kind, side, def, x, y, dx, dy, alt, hpFrac, level(0 ghost,1 bearing,2 track,3 own), flags|dis<<8,
 * generation (so the page can tell a reused slot from the unit it had selected).
 * Bearing-only contacts carry the holder's position and a unit direction, never the range.
 */
export function writeSnapshot(s: Sim, side: number, buf: Float32Array): void {
  let p = SNAP_HDR, count = 0;
  const base = side * MAX;
  for (let i = 0; i < s.n; i++) {
    const k = s.kind[i];
    if (k === K_FREE) continue;
    const own = s.side[i] === side || s.winner >= 0;
    const lvl = own ? 3 : s.det[base + i];
    if (!own && lvl === 0 && (k === K_WPN || s.lastT[base + i] < 0 || s.tick - s.lastT[base + i] > MEMORY_TICKS)) continue;
    if (k === K_BUOY && !own && lvl === 0) continue;
    let x = s.x[i], y = s.y[i], dx = s.dx[i], dy = s.dy[i], alt = s.alt[i], hp = 1, def = s.def[i];
    if (lvl === 0) { x = s.lastX[base + i]; y = s.lastY[base + i]; dx = 0; dy = 0; alt = 0; }
    else if (lvl === 1 || (k === K_BUOY && !own)) {
      const h = s.holder[base + i];
      if (h < 0 || s.kind[h] === K_FREE) continue;
      const ex = x - s.x[h], ey = y - s.y[h], d = Math.sqrt(ex * ex + ey * ey) || 1;
      x = s.x[h]; y = s.y[h]; dx = ex / d; dy = ey / d; alt = 0; def = 0xffff;
    }
    if (own && k !== K_WPN && k !== K_BUOY) hp = s.hp[i] / s.db.units[def].d.hp;
    buf[p] = i; buf[p + 1] = k; buf[p + 2] = s.side[i]; buf[p + 3] = def; buf[p + 4] = x; buf[p + 5] = y;
    buf[p + 6] = dx; buf[p + 7] = dy; buf[p + 8] = alt; buf[p + 9] = hp; buf[p + 10] = k === K_BUOY && !own ? 1 : lvl;
    buf[p + 11] = own ? s.flags[i] | (s.dis[i] << 8) : 0;
    buf[p + 12] = s.gen[i];
    p += SNAP_REC; count++;
  }
  let ne = 0;
  for (let e = 0; e < s.evN; e++) {
    const k = s.ev[e * 4];
    if (!((k >> (8 + side)) & 1) && s.winner < 0) continue; // not this side's business
    buf[p] = k & 255; buf[p + 1] = s.ev[e * 4 + 1]; buf[p + 2] = s.ev[e * 4 + 2]; buf[p + 3] = s.ev[e * 4 + 3];
    p += 4; ne++;
  }
  buf[0] = s.tick; buf[1] = s.winner; buf[2] = count; buf[3] = ne; buf[4] = s.endTick;
  s.evN = 0;
}

// ---------- unit detail for the side panel (allocates; called a few times a second, never per tick) ----------
export interface Info {
  id: number; own: boolean; name: string; type: string; cls: string; kind: number; level: number;
  hp: number; maxHp: number; dis: number; flags: number; kts: number; ordKts: number; maxKts: number;
  alt: number; ordAlt: number; minAlt: number; maxAlt: number; fuelMin: number; wp: number[]; host: number;
  fc: number; fcUsed: number; hasRadar: boolean; hasActive: boolean; depth: number;
  mounts: { m: number; w: number; name: string; ammo: number; readyS: number; minKm: number; maxKm: number; altMin: number; altMax: number }[];
  pd: string[]; buoys: { b: number; name: string; n: number }[];
  hangar: { id: number; name: string; type: string; stowed: boolean; readyS: number; lo: number; loadouts: string[] }[];
}

export function describe(s: Sim, i: number, side: number): Info | null {
  const k = s.kind[i];
  if (k === K_FREE || k === K_WPN || k === K_BUOY) return null;
  const u = s.db.units[s.def[i]], own = s.side[i] === side || s.winner >= 0, lvl = own ? 3 : s.det[side * MAX + i];
  if (!own) {
    // the other side's units: only what a contact reveals, and nothing at all for an unknown unit
    const c = side * MAX + i, known = lvl === 2 || (s.lastT[c] >= 0 && s.tick - s.lastT[c] <= MEMORY_TICKS);
    if (lvl === 0 && !known) return null;
    return {
      id: i, own: false, name: known ? u.d.name : 'Unknown contact', type: known ? u.id : '', cls: known ? u.d.cls : '', kind: k, level: lvl,
      hp: 0, maxHp: 0, dis: 0, flags: 0, kts: lvl === 2 ? s.spd[i] / KTS : 0, ordKts: 0, maxKts: 0, alt: lvl === 2 ? s.alt[i] : 0, ordAlt: 0,
      minAlt: 0, maxAlt: 0, fuelMin: 0, wp: [], host: -1, fc: 0, fcUsed: 0, hasRadar: false, hasActive: false, depth: 0, mounts: [], pd: [], buoys: [], hangar: [],
    };
  }
  const info: Info = {
    id: i, own, name: own ? s.names[s.label[i] - 1] || u.d.name : lvl === 2 ? u.d.name : 'Unknown contact',
    type: own || lvl === 2 ? u.id : '', cls: u.d.cls, kind: k, level: lvl,
    hp: own ? s.hp[i] : 0, maxHp: u.d.hp, dis: own ? s.dis[i] : 0, flags: own ? s.flags[i] : 0,
    kts: own || lvl === 2 ? s.spd[i] / KTS : 0, ordKts: s.ordSpd[i] / KTS, maxKts: u.d.kts,
    alt: own || lvl === 2 ? s.alt[i] : 0, ordAlt: s.ordAlt[i], minAlt: u.d.minAltM || 0,
    maxAlt: k === K_SUB ? -(u.d.maxDepthM || 300) : u.d.maxAltM || 0, fuelMin: s.fuel[i] / 60, wp: [], host: s.host[i],
    fc: u.d.fc, fcUsed: s.fcUsed[i], hasRadar: !!u.d.radar, hasActive: u.activeKm > 0, depth: s.floor[i],
    mounts: [], pd: [], buoys: [], hangar: [],
  };
  if (!own) return info;
  for (let w = 0; w < s.wpN[i]; w++) info.wp.push(s.wpX[i * NWP + w], s.wpY[i * NWP + w]);
  for (let m = 0; m < NM; m++) {
    const w = s.mw[i * NM + m];
    if (w < 0) continue;
    const d = s.db.weapons[w].d;
    info.mounts.push({ m, w, name: d.name, ammo: s.ammo[i * NM + m], readyS: Math.max(0, (s.ready[i * NM + m] - s.tick) * DT), minKm: d.minKm, maxKm: d.maxKm, altMin: d.altMin, altMax: d.altMax });
  }
  info.pd = u.pd.map((p) => p.name);
  if (k === K_AIR) s.db.buoys.forEach((b, bi) => { if (bi < 4 && (u.buoys[bi] || s.buoyN[i * 4 + bi])) info.buoys.push({ b: bi, name: b.d.name, n: s.buoyN[i * 4 + bi] }); });
  for (let j = 0; j < s.n; j++) {
    if (s.kind[j] === K_AIR && s.host[j] === i && s.hostGen[j] === s.gen[i] && s.side[j] === s.side[i]) {
      const a = s.db.units[s.def[j]];
      info.hangar.push({ id: j, name: s.names[s.label[j] - 1] || a.d.name, type: a.id, stowed: (s.flags[j] & F_STOWED) !== 0, readyS: Math.max(0, (s.busy[j] - s.tick) * DT), lo: s.lo[j], loadouts: a.loadouts.map((l) => l.name) });
    }
  }
  return info;
}
