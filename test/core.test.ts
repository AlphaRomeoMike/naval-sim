import { describe, expect, test } from 'vitest';
import {
  allocSim, applyOrder, finishSetup, hash, replay, resetSim, step, MAX, KTS, SCRATCH, K_FREE, K_WPN, K_BUOY,
  O_MOVE, O_ADDWP, O_SPEED, O_ALT, O_RADAR, O_SONAR, O_WFREE, O_STOP, O_FIRE, O_LAUNCH, O_RTB, O_BUOY, type Save, type Sim,
} from '../src/sim/sim';
import { stress } from '../src/scenarios';
import { at, db, make, run, tier } from './helpers';

describe('movement', () => {
  test('a ship reaches its waypoint at the ordered speed', () => {
    const s = make([at('us', 'tfrig', 0, 0)]);
    applyOrder(s, [0, O_MOVE, 0, 10, 0, 0]);
    applyOrder(s, [0, O_SPEED, 0, 30, 0, 0]);
    run(s, 1200); // 10 minutes at 30 kts = 9.26 km, minus a little for acceleration
    expect(s.x[0]).toBeGreaterThan(8.5);
    expect(s.x[0]).toBeLessThan(9.3);
    run(s, 400);
    expect(s.x[0]).toBe(10);
    expect(s.spd[0]).toBe(0);
  });
  test('altitude and depth orders are clamped to the airframe and hull limits', () => {
    const s = make([at('us', 'tjet', 0, 0), at('us', 'tsub', 5, 0)]);
    applyOrder(s, [0, O_ALT, 0, 99999, 0, 0]);
    applyOrder(s, [0, O_ALT, 1, -5000, 0, 0]);
    expect(s.ordAlt[0]).toBe(15000);
    expect(s.ordAlt[1]).toBe(-400);
  });
});

/** First entity at or after `from` that passes the test (or `from` itself, which then makes an invalid order). */
function pick(a: Sim, from: number, ok: (i: number) => boolean): number {
  for (let q = 0; q < a.n; q++) { const i = (from + q) % a.n; if (ok(i)) return i; }
  return from;
}

/** A fire order for unit u at the first hostile track at or after index `from` that one of its mounts accepts. */
function fireOrder(a: Sim, u: number, from: number): number[] {
  const sd = a.side[u];
  for (let q = 0; q < a.n; q++) {
    const t = (from + q) % a.n;
    if (a.kind[t] === K_FREE || a.side[t] === sd || a.det[sd * MAX + t] < 2) continue;
    for (let m = 0; m < 8; m++) {
      if (a.mw[u * 8 + m] < 0 || a.ammo[u * 8 + m] === 0 || a.ready[u * 8 + m] > a.tick) continue;
      const w = a.db.weapons[a.mw[u * 8 + m]].d, d = Math.hypot(a.x[t] - a.x[u], a.y[t] - a.y[u]);
      if (d >= w.minKm && d <= w.maxKm) return [a.tick, O_FIRE, u, m, t, 0];
    }
  }
  return [a.tick, O_FIRE, u, 0, from, 0];
}

describe('save and load', () => {
  test('a battle replayed from seed plus orders ends in exactly the same state', () => {
    // 120 random units plus two decks with aircraft, both sides on the AI, the player slot swapped by fit-out
    const base = stress(tier, 120, 5);
    const units = [
      ...base.units,
      { side: 'us' as const, type: 'tfrig', lon: base.lon + 0.3, lat: base.lat, air: [{ type: 'thelo', n: 2 }, { type: 'tjet', n: 1, loadout: 'strike' }] },
      { side: 'ussr' as const, type: 'ebase', lon: base.lon - 2, lat: base.lat + 1, air: [{ type: 'ejet', n: 3, loadout: 'asm' }] },
    ];
    const fit = { [units.length - 2 + 0]: 'tfrig2' }; // slot of the US deck ship: same role, different unit
    const scn = { ...base, units };
    const a = resetSim(allocSim(), db, scn, 4242, fit);
    a.aiSides = 3; finishSetup(a);
    // a scripted player issuing every kind of order, valid or not, across the whole battle
    let r = 99;
    const rnd = () => { r = (Math.imul(r, 1103515245) + 12345) | 0; return ((r >>> 8) & 0xffff) / 0x10000; };
    const KINDS = [O_MOVE, O_ADDWP, O_SPEED, O_ALT, O_RADAR, O_SONAR, O_WFREE, O_STOP, O_FIRE, O_FIRE, O_LAUNCH, O_RTB, O_BUOY];
    const orders: number[][] = [], used = new Set<number>();
    const TICKS = 4000, MID = 1500;
    let midHash = 0, midSave: Save | null = null;
    for (let t = 0; t < TICKS; t++) {
      if (t === MID) { midHash = hash(a); midSave = { v: 1, scn: 'test', seed: 4242, side: 0, ai: 3, tick: a.tick, fit, orders: orders.map((o) => o.slice()) }; }
      for (let q = 0; q < 2; q++) {
        const u = (rnd() * a.n) | 0, k = KINDS[(rnd() * KINDS.length) | 0];
        const o = k === O_MOVE || k === O_ADDWP ? [a.tick, k, u, (rnd() - 0.5) * 600, (rnd() - 0.5) * 600, 0]
          : k === O_SPEED ? [a.tick, k, u, rnd() * 40, 0, 0]
          : k === O_ALT ? [a.tick, k, u, (rnd() - 0.3) * 5000, 0, 0]
          : k === O_FIRE ? fireOrder(a, u, (rnd() * a.n) | 0)
          : k === O_LAUNCH ? [a.tick, k, pick(a, u, (i) => a.kind[i] === 3 && (a.flags[i] & 8) !== 0), (rnd() * 3) | 0, 0, 0]
          : k === O_RTB ? [a.tick, k, pick(a, u, (i) => a.kind[i] === 3 && !(a.flags[i] & 8)), 0, 0, 0]
          : k === O_BUOY ? [a.tick, k, pick(a, u, (i) => a.kind[i] === 3 && !(a.flags[i] & 8) && a.buoyN[i * 4] > 0), (rnd() * 2) | 0, (rnd() * 2) | 0, 0]
          : [a.tick, k, u, rnd() < 0.5 ? 1 : 0, 0, 0];
        if (applyOrder(a, o) === 0) { orders.push(o); used.add(k); }
      }
      step(a);
    }
    expect(orders.length).toBeGreaterThan(1000);
    for (const k of KINDS) expect(used.has(k), `order kind ${k} was exercised`).toBe(true);
    const same = (x: Sim, y: Sim) => {
      for (const key of Object.keys(x) as (keyof Sim)[]) {
        const va = x[key], vb = y[key];
        if (!ArrayBuffer.isView(va) || SCRATCH.has(key)) continue;
        const ua = new Uint8Array(va.buffer, va.byteOffset, va.byteLength), ub = new Uint8Array((vb as typeof va).buffer, (vb as typeof va).byteOffset, va.byteLength);
        let diff = -1;
        for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) { diff = i; break; }
        expect(`${key}:${diff}`).toBe(`${key}:-1`); // every state array, byte for byte
      }
      expect(y.tick).toBe(x.tick); expect(y.seed).toBe(x.seed); expect(y.n).toBe(x.n); expect(y.winner).toBe(x.winner);
    };
    // the end state, replayed into a fresh Sim from a save that went through JSON
    const save: Save = { v: 1, scn: 'test', seed: 4242, side: 0, ai: 3, tick: a.tick, fit, orders };
    const b = replay(allocSim(), db, scn, JSON.parse(JSON.stringify(save)));
    expect(hash(b)).toBe(hash(a));
    same(a, b);
    // a mid-battle save (weapons in flight, aircraft airborne), replayed into a Sim that already held another battle
    const c = replay(b, db, scn, midSave!);
    expect(hash(c)).toBe(midHash);
    // carrying on from the loaded save with the same later orders reaches the same end
    let q = orders.findIndex((o) => o[0] >= MID);
    if (q < 0) q = orders.length;
    while (c.tick < TICKS) { while (q < orders.length && orders[q][0] <= c.tick) applyOrder(c, orders[q++]); step(c); }
    expect(hash(c)).toBe(hash(a));
    same(a, c);
    // a different seed is a different battle
    const d = replay(allocSim(), db, scn, { ...save, seed: 1 });
    expect(hash(d)).not.toBe(hash(a));
  });
});

describe('entity slots', () => {
  test('state never exceeds the pre-allocated 2,048 slots', () => {
    const s = make(stress(tier, 300, 1).units, 1, 3);
    run(s, 2000);
    let live = 0;
    for (let i = 0; i < MAX; i++) if (s.kind[i] !== K_FREE) live++;
    expect(s.n).toBeLessThanOrEqual(MAX);
    expect(live).toBeGreaterThan(0);
    expect(s.x.length).toBe(MAX);
    void KTS; void K_WPN; void K_BUOY;
  });
});
