import { describe, expect, test } from 'vitest';
import {
  applyOrder, canEngage, compileDb, holds, step, MAX, NM, KTS, K_FREE, K_BUOY, K_AIR, F_STOWED, F_RTB, F_WFREE, D_DECK,
  O_LAUNCH, O_RTB, O_BUOY, O_ALT, O_MOVE, O_SPEED, O_FIRE, type Sim,
} from '../src/sim/sim';
import { fire } from '../src/sim/combat';
import { SCENARIOS } from '../src/scenarios';
import type { TierData } from '../src/sim/types';
import { at, db, make, run, tier } from './helpers';
import { freeDb, start } from './real';

const ord = (s: Sim, kind: number, unit: number, a = 0, b = 0, c = 0) => applyOrder(s, [s.tick, kind, unit, a, b, c]);
const stowed = (s: Sim, i: number) => (s.flags[i] & F_STOWED) !== 0;
const det = (s: Sim, side: number, i: number) => s.det[side * MAX + i];
const buoys = (s: Sim) => { const r: number[] = []; for (let i = 0; i < s.n; i++) if (s.kind[i] === K_BUOY) r.push(i); return r; };
/** A submarine creeping along at `kts` so passive sensors have something to hear. */
function creep(s: Sim, i: number, kts: number): void { s.spd[i] = kts * KTS; s.ordSpd[i] = kts * KTS; s.wpN[i] = 1; s.wpX[i * 8] = s.x[i] + 400; s.wpY[i * 8] = s.y[i]; }
const carrier = (...air: { type: string; n: number; loadout?: string }[]) => at('us', 'tfrig', 0, 0, { air });

describe('launch and recovery', () => {
  test('aircraft start on deck, launch one per deck interval, and come back to be turned around', () => {
    const s = make([carrier({ type: 'thelo', n: 2, loadout: 'asw' })]);
    expect(stowed(s, 1) && stowed(s, 2)).toBe(true);
    expect(ord(s, O_LAUNCH, 1, -1)).toBe(0);
    expect(stowed(s, 1)).toBe(false);
    expect(ord(s, O_LAUNCH, 2, -1)).toBe(14); // deck busy for 60 s
    run(s, 121);
    expect(ord(s, O_LAUNCH, 2, -1)).toBe(0);
    ord(s, O_MOVE, 1, 20, 0);
    run(s, 800);
    expect(s.x[1]).toBeCloseTo(20, 3);
    expect(ord(s, O_RTB, 1)).toBe(0);
    run(s, 800);
    expect(stowed(s, 1)).toBe(true);
    expect(ord(s, O_LAUNCH, 1, -1)).toBe(15); // 20 minute turnaround
    run(s, 20 * 120);
    expect(ord(s, O_LAUNCH, 1, -1)).toBe(0);
    expect(s.fuel[1]).toBe(150 * 60); // refuelled
  });
  test('a disabled flight deck stops launches and recoveries', () => {
    const s = make([carrier({ type: 'thelo', n: 2 })]);
    ord(s, O_LAUNCH, 1, -1);
    s.dis[0] |= D_DECK;
    expect(ord(s, O_LAUNCH, 2, -1)).toBe(13);
    expect(ord(s, O_RTB, 1)).toBe(17); // nowhere to land
    run(s, 400);
    expect(stowed(s, 1)).toBe(false);
  });
  test('low fuel sends the aircraft home on its own; with no deck it ditches when the fuel is gone', () => {
    const s = make([carrier({ type: 'thelo', n: 1 })]);
    ord(s, O_LAUNCH, 1, -1);
    ord(s, O_MOVE, 1, 60, 0);
    s.fuel[1] = 25 * 60; // 25 minutes left, 60 km (15 min) from home once it arrives
    run(s, 3000);
    expect(stowed(s, 1)).toBe(true); // came back by itself
    const lost = make([at('us', 'thelo', 0, 0, { alt: 150 })]);
    lost.fuel[0] = 60;
    run(lost, 200);
    expect(lost.kind[0]).toBe(K_FREE);
  });
});

describe('altitude caps and loadouts', () => {
  test('altitude orders are clamped to the airframe', () => {
    const s = make([carrier({ type: 'thelo', n: 1 }, { type: 'tjet', n: 1 })]);
    ord(s, O_LAUNCH, 1, -1);
    ord(s, O_ALT, 1, 9000);
    expect(s.ordAlt[1]).toBe(3000); // helicopter ceiling
    ord(s, O_ALT, 1, 1);
    expect(s.ordAlt[1]).toBe(15); // and floor
    run(s, 400);
    expect(s.alt[1]).toBe(15);
  });
  test('the chosen loadout is what the aircraft carries, and it is restored after recovery', () => {
    const s = make([carrier({ type: 'tjet', n: 1, loadout: 'cap' })]);
    const names = (i: number) => { const r: string[] = []; for (let m = 0; m < NM; m++) if (s.mw[i * NM + m] >= 0) r.push(`${s.db.weapons[s.mw[i * NM + m]].id}x${s.ammo[i * NM + m]}`); return r; };
    expect(names(1)).toEqual(['aamx4']); // scenario default
    const strike = s.db.units[s.db.u.tjet].loadouts.findIndex((l) => l.name === 'strike');
    expect(ord(s, O_LAUNCH, 1, strike)).toBe(0);
    expect(names(1)).toEqual(['bombx4', 'armx2', 'jdamx2']);
    s.ammo[1 * NM] = 0;
    ord(s, O_RTB, 1);
    run(s, 300);
    expect(stowed(s, 1)).toBe(true);
    expect(names(1)).toEqual(['bombx4', 'armx2', 'jdamx2']);
  });
});

describe('sonobuoys', () => {
  const field = (extra: Partial<TierData['units'][string]> = {}) => {
    const t = structuredClone(tier);
    Object.assign(t.units.thelo, extra);
    // helicopter over a quiet patch of sea, enemy sub 1.5 km east doing 8 kts at 60 m (noise factor 0.3125)
    const s = make([at('us', 'thelo', 0, 0, { alt: 150 }), at('ussr', 'esub', 1.5, 0, { alt: -60 }), at('us', 'tfrig', -30, 0)], 1, 0, {}, compileDb(t));
    creep(s, 1, 8);
    s.flags[0] &= ~1; s.flags[2] &= ~1; // radars off: buoys only
    return s;
  };
  test('DIFAR is passive and gives a bearing; DICASS is active and gives a track', () => {
    const s = field();
    expect(ord(s, O_BUOY, 0, db.b.difar, 0)).toBe(0);
    expect(s.buoyN[0 * 4 + db.b.difar]).toBe(9);
    run(s, 8);
    expect(det(s, 0, 1)).toBe(1); // 8 km x 0.31 = 2.5 km reach, sub at 1.5 km: heard, bearing only
    expect(s.kind[s.holder[1]]).toBe(K_BUOY);
    expect(ord(s, O_BUOY, 0, db.b.dicass, 0)).toBe(0);
    run(s, 8);
    expect(det(s, 0, 1)).toBe(2); // inside the 4 km active range
  });
  test('two bearings from two buoys cross into a track', () => {
    const s = field();
    ord(s, O_BUOY, 0, db.b.difar, 0);
    s.y[0] = 1.5; // move the helicopter and drop a second DIFAR
    ord(s, O_BUOY, 0, db.b.difar, 0);
    run(s, 8);
    expect(det(s, 0, 1)).toBe(2);
  });
  test('a buoy reports only while its aircraft is in radio range', () => {
    const s = field();
    ord(s, O_BUOY, 0, db.b.dicass, 0);
    run(s, 8);
    expect(det(s, 0, 1)).toBe(2);
    // radio horizon at 150 m altitude to a buoy antenna at 1 m: 4.12 x (12.2 + 1) = 54.6 km
    s.x[0] = -53; run(s, 8);
    expect(det(s, 0, 1)).toBe(2);
    s.x[0] = -57; run(s, 8);
    expect(det(s, 0, 1)).toBe(0);
    ord(s, O_ALT, 0, 1500); run(s, 200); // climbing extends the horizon: 4.12 x (38.7 + 1) = 163 km
    expect(det(s, 0, 1)).toBe(2);
  });
  test('a buoy set below the layer hears a deep submarine at full range, a shallow one at half', () => {
    const mk = (deep: number) => {
      const s = field();
      s.alt[1] = -200; s.ordAlt[1] = -200; s.x[1] = 3; // deep sub, 3 km from the buoy
      ord(s, O_BUOY, 0, db.b.dicass, deep);
      return run(s, 8);
    };
    expect(det(mk(1), 0, 1)).toBe(2); // same side of the layer: 4 km
    expect(det(mk(0), 0, 1)).toBe(0); // across it: 2 km
  });
  test('buoys run out, and they expire', () => {
    const s = field();
    for (let i = 0; i < 5; i++) expect(ord(s, O_BUOY, 0, db.b.dicass, 0)).toBe(0);
    expect(ord(s, O_BUOY, 0, db.b.dicass, 0)).toBe(16);
    expect(buoys(s).length).toBe(5);
    s.fuel[0] = 1e9;
    run(s, 45 * 120 + 2); // DICASS life 45 min
    expect(buoys(s).length).toBe(0);
  });
  test('datalink: a ship can fire on a helicopter\'s buoy track only if the helicopter is datalinked and in radio range', () => {
    const shot = (link: boolean) => {
      const s = field({ link });
      s.x[2] = -6; // frigate 7.5 km from the sub: inside its light torpedo range, outside its own sonar's reach
      ord(s, O_BUOY, 0, db.b.dicass, 0);
      run(s, 8);
      return { s, track: det(s, 0, 1), ship: canEngage(s, 2, 1), helo: canEngage(s, 0, 1) };
    };
    const off = shot(false), on = shot(true);
    expect(off.track).toBe(2);
    expect(off.helo).toBe(true); // its own buoys
    expect(off.ship).toBe(false); // no datalink: the frigate has no firing solution
    expect(on.ship).toBe(true);
    on.s.x[0] = 60; on.s.alt[0] = 30; run(on.s, 8); // helicopter flies off low: 4.12 x (5.5 + 5) = 43 km radio horizon to the ship
    expect(canEngage(on.s, 2, 1)).toBe(false);
    void fire; void O_FIRE; void O_SPEED; void F_RTB; void F_WFREE; void K_AIR; void step;
  });
});

describe('rules found in review', () => {
  test('a missile does not follow an aircraft onto its deck', () => {
    const s = make([at('us', 'tfrig', 0, 0), at('ussr', 'ebase', 30, 0, { air: [{ type: 'ejet', n: 1, loadout: 'asm' }] })]);
    s.flags[0] &= ~F_WFREE;
    ord(s, O_LAUNCH, 2, -1);
    run(s, 8);
    const m = [0, 1, 2, 3].find((q) => s.db.weapons[s.mw[q]]?.id === 'sam')!;
    expect(fire(s, 0, m, 2)).toBe(0);
    run(s, 4);
    s.flags[2] |= F_STOWED; s.alt[2] = 0; // it lands while the missile is in flight
    run(s, 100);
    expect(s.kind[2]).toBe(K_AIR); // alive, on the ground
    expect(s.fcUsed[0]).toBe(0); // and the missile and its channel are gone
  });
  test('a bearing alone is not a firing solution on someone else\'s track, but a held bearing becomes one', () => {
    // helicopter (no datalink) holds the submarine with an active buoy; the frigate 2 km away only hears it
    const t = structuredClone(tier);
    const s = make([at('us', 'thelo', 0, 0, { alt: 150 }), at('ussr', 'esub', 1.5, 0, { alt: -60 }), at('us', 'tfrig', 3.4, 0)], 1, 0, {}, compileDb(t));
    creep(s, 1, 8);
    s.flags[0] &= ~1; s.flags[2] &= ~1;
    ord(s, O_BUOY, 0, db.b.dicass, 0);
    run(s, 8);
    expect(det(s, 0, 1)).toBe(2);
    expect(canEngage(s, 0, 1)).toBe(true); // the helicopter: its own buoy
    expect(canEngage(s, 2, 1)).toBe(false); // the frigate: a bearing of its own, but the fix is not its own
    for (const b of buoys(s)) s.fuel[b] = 0.4; // the buoy dies; now only the frigate's passive sonar holds the contact
    s.x[1] = 1.5; creep(s, 1, 8);
    run(s, 8);
    expect(det(s, 0, 1)).toBe(1);
    for (let i = 0; i < 400; i++) { s.x[1] = 1.5; step(s); } // 200 s of holding the bearing: target motion analysis
    expect(det(s, 0, 1)).toBe(2);
    expect(canEngage(s, 2, 1)).toBe(true);
  });
  test('an active buoy gives itself away to passive sonar out to 1.5x its range, as a bearing', () => {
    const mk = (d: number) => {
      const s = make([at('us', 'thelo', 0, 0, { alt: 150 }), at('ussr', 'esub', d, 0, { alt: -60 })]);
      s.flags[0] &= ~1;
      ord(s, O_BUOY, 0, db.b.dicass, 0);
      run(s, 8);
      const b = buoys(s)[0];
      return s.det[MAX + b];
    };
    expect(mk(5.5)).toBe(1); // DICASS active range 4 km, heard to 6 km
    expect(mk(6.5)).toBe(0);
    const passive = make([at('us', 'thelo', 0, 0, { alt: 150 }), at('ussr', 'esub', 2, 0, { alt: -60 })]);
    ord(passive, O_BUOY, 0, db.b.difar, 0);
    run(passive, 8);
    expect(passive.det[MAX + buoys(passive)[0]]).toBe(0); // a passive buoy makes no sound
  });
  test('a buoy\'s depth setting uses the sea under the aircraft', async () => {
    // Gap Barrier's waters are over 2 km deep: a buoy set below the 100 m layer must end up below it
    const s = await start(SCENARIOS.find((x) => x.id === 'gap-barrier')!, 1, 0, freeDb);
    ord(s, O_LAUNCH, 3, -1);
    run(s, 4);
    s.floor[3] = 60; // even if the cached value (from the ship's position at launch) says shoal water
    ord(s, O_BUOY, 3, s.db.b.dicass, 1);
    expect(s.alt[buoys(s)[0]]).toBe(-150);
  });
  test('a loadout index that is not a whole number falls back to the default loadout', () => {
    const s = make([carrier({ type: 'tjet', n: 1, loadout: 'cap' })]);
    expect(ord(s, O_LAUNCH, 1, 0.5)).toBe(0);
    expect(s.ammo[1 * NM]).toBe(4); // the default 'cap' loadout, not an unarmed aircraft
  });
});

describe('milestone 4 check', () => {
  test('an SH-2F finds and sinks a Foxtrot using buoys alone', async () => {
    // Real free-tier data. The frigate keeps radar and active sonar off and stays 27 km or more away, so every detection
    // comes from the helicopter's buoys; the script only uses what the US side is told (bearing, then track).
    const scn = {
      ...SCENARIOS.find((x) => x.id === 'gap-barrier')!, id: 'buoys-only', minutes: 240, units: [
        { side: 'us' as const, type: 'ffg7e', name: 'Mother', lon: -18.5, lat: 60.75, air: [{ type: 'sh2f', n: 1, loadout: 'asw' }] }, // 27 km west and south of the sub's whole track
        { side: 'ussr' as const, type: 'foxtrot', name: 'Foxtrot', lon: -18, lat: 61.36, alt: -60, kts: 6, obj: true, wp: [[-18, 60.8], [-18, 61.36]] as [number, number][] },
      ],
    };
    const hunt = async (seed: number) => {
    const s = await start(scn, seed, 2, freeDb);
    const FFG = 0, HELO = 1, SUB = 2, difar = s.db.b.difar, dicass = s.db.b.dicass, mk46 = s.db.w.mk46;
    s.flags[FFG] &= ~1; // radar off
    const line: [number, number][] = Array.from({ length: 10 }, (_, i) => [(i - 4.5) * 3.2, 27] as [number, number]); // east-west DIFAR line across the reported track
    let leg = 0, byBuoyOnly = true, sorties = 0, pinged = -1e9, drops = 0;
    // Dead reckoning uses the briefed course (south at about 6 knots, 0.0031 km/s), not a measured one: a boat
    // that hears an active buoy runs, so anything measured after the first ping is its evasion, not its transit.
    const lastFix = { x: 0, y: 0, t: -1 }, v = { x: 0, y: -0.0031 };
    let pings = 0;
    while (s.kind[SUB] !== K_FREE && s.tick < 240 * 120) {
      if (s.tick % 10 === 0) {
        const lvl = det(s, 0, SUB);
        if (lvl > 0 && s.kind[s.holder[SUB]] !== K_BUOY) byBuoyOnly = false;
        if (holds(s, FFG, SUB)) byBuoyOnly = false; // the frigate's own sensors must never contribute, even as a second holder
        if (lvl === 2) {
          lastFix.x = s.x[SUB]; lastFix.y = s.y[SUB]; lastFix.t = s.tick;
        }
        if (stowed(s, HELO)) { if (ord(s, O_LAUNCH, HELO, -1) === 0) sorties++; }
        else if (!(s.flags[HELO] & F_RTB)) {
          let torp = -1;
          for (let m = 0; m < NM; m++) if (s.mw[HELO * NM + m] === mk46 && s.ammo[HELO * NM + m] > 0) torp = m;
          if (torp < 0) ord(s, O_RTB, HELO); // out of torpedoes: rearm
          else if (lvl === 2) { // a track: fly to it and drop
            ord(s, O_MOVE, HELO, s.x[SUB] + 1.5, s.y[SUB]); // stand off 1.5 km: the Mk 46 needs 0.5 km to arm
            const d = Math.hypot(s.x[HELO] - s.x[SUB], s.y[HELO] - s.y[SUB]);
            if (d > 0.7 && d < 4 && ord(s, O_FIRE, HELO, torp, SUB) === 0) drops++;
          } else if (lvl === 1 && s.tick - pinged > 600) { // a bearing: go to the buoy that hears it and ping 1.5 km down the bearing
            const b = s.holder[SUB], ex = s.x[SUB] - s.x[b], ey = s.y[SUB] - s.y[b], d = Math.hypot(ex, ey) || 1;
            const px = s.x[b] + (ex / d) * 1.5, py = s.y[b] + (ey / d) * 1.5;
            ord(s, O_MOVE, HELO, px, py);
            if (Math.hypot(s.x[HELO] - px, s.y[HELO] - py) < 0.3 && ord(s, O_BUOY, HELO, dicass, 0) === 0) pinged = s.tick;
          } else if (leg < line.length) { // lay the passive line
            ord(s, O_MOVE, HELO, line[leg][0], line[leg][1]);
            if (Math.hypot(s.x[HELO] - line[leg][0], s.y[HELO] - line[leg][1]) < 0.3 && ord(s, O_BUOY, HELO, difar, 0) === 0) leg++;
          } else if (lastFix.t >= 0) { // lost it: ping where dead reckoning from the old track says it should be now
            const px = lastFix.x + v.x * (s.tick - lastFix.t), py = lastFix.y + v.y * (s.tick - lastFix.t);
            ord(s, O_MOVE, HELO, px, py);
            // alternate shallow and deep pings: a boat that has been attacked may have gone under the layer
            if (s.tick - pinged > 360 && Math.hypot(s.x[HELO] - px, s.y[HELO] - py) < 0.3 && ord(s, O_BUOY, HELO, dicass, pings & 1) === 0) { pinged = s.tick; pings++; }
          } else ord(s, O_MOVE, HELO, 0, 27); // wait over the middle of the line
        }
      }
      step(s);
    }
    run(s, 8); // let the victory check run
    return { s, sunk: s.kind[SUB] === K_FREE, byBuoyOnly, sorties, leg, drops, minutes: Math.round(s.tick / 120) };
    };
    const r = await hunt(1);
    let wins = 0, clean = 0;
    for (let seed = 1; seed <= 10; seed++) { const h = await hunt(seed); if (h.sunk) wins++; if (h.byBuoyOnly) clean++; }
    console.log(`SH-2F vs Foxtrot (seed 1): ${r.sunk ? 'sunk' : 'NOT sunk'} at ${r.minutes} min, ${r.sorties} sortie(s), ${r.leg} DIFAR laid, ${r.drops} torpedoes dropped; over seeds 1-10 the script sinks it ${wins} times`);
    expect(clean).toBe(10); // in every run, every detection came from a buoy
    expect(r.sunk).toBe(true);
    expect(r.byBuoyOnly).toBe(true);
    expect(r.s.winner).toBe(0);
    expect(wins).toBeGreaterThanOrEqual(7);
  });
});
