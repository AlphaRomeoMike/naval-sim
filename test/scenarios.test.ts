// The three free scenarios: valid with free data only, and winnable by a scripted US player.
// The scripts only use what the US side can see (its own units and its tracks).
import { describe, expect, test } from 'vitest';
import {
  applyOrder, depthAt, step, MAX, NM, K_AIR, K_SUB, K_SHIP, K_FREE, K_WPN, F_STOWED, F_RTB,
  O_MOVE, O_SPEED, O_ALT, O_SONAR, O_FIRE, O_LAUNCH, O_RTB, O_BUOY, type Sim, type Scenario,
} from '../src/sim/sim';
import { SCENARIOS } from '../src/scenarios';
import { free, freeDb, start } from './real';

const byId = (id: string) => SCENARIOS.find((s) => s.id === id)!;
const ord = (s: Sim, kind: number, unit: number, a = 0, b = 0, c = 0) => applyOrder(s, [s.tick, kind, unit, a, b, c]);
const alive = (s: Sim, i: number) => s.kind[i] !== K_FREE;
const airborne = (s: Sim, i: number) => s.kind[i] === K_AIR && !(s.flags[i] & F_STOWED);
const dist = (s: Sim, a: number, b: number) => Math.hypot(s.x[a] - s.x[b], s.y[a] - s.y[b]);
const mountOf = (s: Sim, u: number, id: string) => { for (let m = 0; m < NM; m++) if (s.mw[u * NM + m] === s.db.w[id] && s.ammo[u * NM + m] > 0) return m; return -1; };
/** Nearest hostile the US side holds a track on, of the given kinds. */
function nearestTrack(s: Sim, from: number, kinds: number[]): number {
  let best = -1, bd = Infinity;
  for (let t = 0; t < s.n; t++) {
    if (s.side[t] === 1 && kinds.includes(s.kind[t]) && s.det[t] === 2) { const d = dist(s, from, t); if (d < bd) { bd = d; best = t; } }
  }
  return best;
}
type Script = (s: Sim) => void;
async function play(scn: Scenario, seed: number, script: Script): Promise<number> {
  const s = await start(scn, seed, 2); // the Soviet side is run by the game; the US side by the script
  while (s.winner < 0) { script(s); step(s); }
  return s.winner;
}
async function winRate(scn: Scenario, script: () => Script, seeds = 10): Promise<number> {
  let wins = 0;
  for (let seed = 1; seed <= seeds; seed++) if ((await play(scn, seed, script())) === 0) wins++;
  return wins;
}
/** Scripted wins against the wins of a US player who gives no orders at all, over the same seeds. */
async function versusIdle(scn: Scenario, script: () => Script): Promise<{ wins: number; idle: number }> {
  const wins = await winRate(scn, script), idle = await winRate(scn, () => () => {});
  console.log(`${scn.name}: scripted US player won ${wins} of 10 seeds; a US player who gives no orders wins ${idle} of 10`);
  return { wins, idle };
}

describe('free scenarios', () => {
  test('use only free-tier units and start every unit in deep enough water', async () => {
    expect(SCENARIOS.filter((x) => x.id !== 'tutorial').length).toBeGreaterThanOrEqual(3);
    for (const scn of SCENARIOS) {
      for (const u of scn.units) {
        expect(free.units[u.type], `${scn.id}: ${u.type}`).toBeDefined();
        for (const a of u.air || []) expect(free.units[a.type], `${scn.id}: ${a.type}`).toBeDefined();
      }
      const s = await start(scn, 1, 3);
      for (let i = 0; i < s.n; i++) {
        if (s.kind[i] === K_SHIP) expect(depthAt(s, s.x[i], s.y[i]), `${scn.id} unit ${i}`).toBeGreaterThan(30);
        if (s.kind[i] === K_SUB) expect(depthAt(s, s.x[i], s.y[i]), `${scn.id} unit ${i}`).toBeGreaterThan(-s.alt[i] + 20);
      }
      for (const u of scn.units) for (const p of u.wp || []) {
        if (free.units[u.type].cls === 'ship' || free.units[u.type].cls === 'sub') {
          expect(depthAt(s, (p[0] - scn.lon) * s.kx, (p[1] - scn.lat) * s.ky), `${scn.id} waypoint of ${u.type}`).toBeGreaterThan(30);
        }
      }
    }
    void freeDb; void MAX;
  });

  test('Gap Barrier can be won: a leapfrogging active-buoy screen ahead of the convoy, then torpedo attacks', async () => {
    // units: 0,1 cargo ships, 2 frigate, 3 SH-2F, 4 Foxtrot, 5 Victor I. The script knows the briefing and its own
    // side's picture only: it screens the water ahead of the convoy, not the submarines' actual positions.
    const script = (): Script => {
      const FFG = 2, HELO = 3;
      let pings = 0, pingAt = 0;
      return (s) => {
        if (s.tick === 0) ord(s, O_SONAR, FFG, 1);
        if (s.tick % 20 !== 0) return;
        const dicass = s.db.b.dicass;
        // frigate: shoot any submarine track inside Mk 46 range
        const ft = alive(s, FFG) ? nearestTrack(s, FFG, [K_SUB]) : -1;
        if (ft >= 0 && dist(s, FFG, ft) < 10.5) { const m = mountOf(s, FFG, 'mk46'); if (m >= 0) ord(s, O_FIRE, FFG, m, ft); }
        if (!alive(s, HELO)) return;
        if (s.flags[HELO] & F_STOWED) { if (alive(s, FFG)) ord(s, O_LAUNCH, HELO, -1); return; }
        if (s.flags[HELO] & F_RTB) return;
        const torp = mountOf(s, HELO, 'mk46');
        if (torp < 0 || s.buoyN[HELO * 4 + dicass] === 0) { ord(s, O_RTB, HELO); return; } // empty: go home, rearm, come back
        const t = nearestTrack(s, HELO, [K_SUB]);
        if (t >= 0) { // prosecute the track from 1.5 km (the Mk 46 needs 0.5 km to arm)
          ord(s, O_MOVE, HELO, s.x[t] + 1.5, s.y[t]);
          const d = dist(s, HELO, t);
          if (d > 0.7 && d < 4) ord(s, O_FIRE, HELO, torp, t);
          return;
        }
        // screen: 14 km ahead of the lead cargo ship on its eastward track, alternating sides and depths
        const lead = alive(s, 0) ? 0 : 1;
        const px = s.x[lead] + 14, py = s.y[lead] + (pings & 1 ? -4 : 4);
        ord(s, O_MOVE, HELO, px, py);
        if (s.tick >= pingAt && Math.hypot(s.x[HELO] - px, s.y[HELO] - py) < 1 && ord(s, O_BUOY, HELO, dicass, (pings >> 1) & 1) === 0) {
          pings++; pingAt = s.tick + 6 * 120; // one every six minutes
        }
      };
    };
    const r = await versusIdle(byId('gap-barrier'), script);
    expect(r.wins).toBeGreaterThanOrEqual(6);
    expect(r.wins).toBeGreaterThan(r.idle);
  });

  test('Bomber Stream can be won: F-4s out along the threat axis', async () => {
    // units: 0 carrier, 1-8 F-4J/S, 9 frigate, 10 SH-2F, 11 airbase, 12-23 Tu-16
    const script = (): Script => (s) => {
      for (let f = 1; f <= 8; f++) {
        if (!alive(s, f)) continue;
        if (s.flags[f] & F_STOWED) { if (s.tick < 1200) ord(s, O_LAUNCH, f, -1); continue; } // first wave only
        if ((s.tick + f) % 20 !== 0 || s.flags[f] & F_RTB) continue;
        if (mountOf(s, f, 'aim7f') < 0 && mountOf(s, f, 'aim9h') < 0) { ord(s, O_RTB, f); continue; }
        ord(s, O_SPEED, f, 1280); ord(s, O_ALT, f, 9000);
        let t = nearestTrack(s, f, [K_AIR]);
        if (t < 0) t = nearestTrack(s, f, [K_WPN]);
        if (t >= 0) ord(s, O_MOVE, f, s.x[t], s.y[t]); else ord(s, O_MOVE, f, 260, 140); // north-east of the carrier, as briefed
      }
    };
    const r = await versusIdle(byId('bomber-stream'), script);
    expect(r.wins).toBeGreaterThanOrEqual(9);
    expect(r.wins).toBeGreaterThan(r.idle);
  });

  test('Deep Shadow can be won: close the briefed track, fire on a solution', async () => {
    // units: 0 Sturgeon, 1 Permit, 2 Kashin, 3 Krivak I. Every shot is an ordinary fire order on a held track.
    const script = (): Script => (s) => {
      if (s.tick === 0) { ord(s, O_MOVE, 0, 5, -5); ord(s, O_SPEED, 0, 8); ord(s, O_MOVE, 1, 12, -14); ord(s, O_SPEED, 1, 8); }
      if (s.tick % 20 !== 0) return;
      for (const sub of [0, 1]) {
        if (!alive(s, sub)) continue;
        const t = nearestTrack(s, sub, [K_SHIP]);
        if (t < 0) continue;
        const d = dist(s, sub, t), harpoon = mountOf(s, sub, 'harpoon'), mk48 = mountOf(s, sub, 'mk48');
        if (harpoon >= 0 && d > 6) ord(s, O_FIRE, sub, harpoon, t);
        else if (mk48 >= 0 && d < 22) ord(s, O_FIRE, sub, mk48, t); // inside 60% of torpedo range, so it cannot be outrun
      }
    };
    const r = await versusIdle(byId('deep-shadow'), script);
    expect(r.wins).toBeGreaterThanOrEqual(6);
    expect(r.wins).toBeGreaterThan(r.idle);
  });
});

describe('tutorial', () => {
  // units: 0 the player's frigate, 1 its SH-2F (on deck), 2 the Krivak. Started as the game starts it: no AI, seed 2.
  const tut = byId('tutorial');
  test('cannot be lost by waiting or sailing away: the Krivak is tracked from the start and there is no time limit', async () => {
    const s = await start(tut, 2, 0);
    for (let i = 0; i < 40; i++) step(s);
    expect(s.det[2]).toBe(2); // a US track within 20 s, without moving
    ord(s, O_MOVE, 0, -400, 300); // then steam off to the north-west for twelve hours
    for (let i = 0; i < 12 * 3600 * 2; i++) step(s);
    expect(s.winner).toBe(-1);
  });
  test('a lone Harpoon fired from where the player starts sinks the Krivak', async () => {
    const s = await start(tut, 2, 0);
    for (let i = 0; i < 40; i++) step(s);
    expect(ord(s, O_FIRE, 0, mountOf(s, 0, 'harpoon'), 2)).toBe(0);
    for (let i = 0; i < 2000 && s.winner < 0; i++) step(s);
    expect(s.winner).toBe(0);
  });
  test('with every Harpoon withheld, the gun alone sinks her from inside 16 km, whatever the seed', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = await start(tut, seed, 0);
      ord(s, O_MOVE, 0, s.x[2] - 10, s.y[2]);
      for (let i = 0; i < 20000 && s.winner < 0; i++) { if (dist(s, 0, 2) < 15) ord(s, O_FIRE, 0, mountOf(s, 0, 'mk75'), 2); step(s); }
      expect(s.winner, `seed ${seed}`).toBe(0);
    }
  });
});
