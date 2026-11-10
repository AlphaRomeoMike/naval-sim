// Milestone 5: both sides run by the AI, every free scenario, to the end.
import { describe, expect, test } from 'vitest';
import { compileDb, step, MAX, K_FREE, K_WPN, K_BUOY, K_AIR, K_SUB, F_STOWED, F_RTB, F_ACTIVE, F_LOOP, E_LAUNCH, type Sim } from '../src/sim/sim';
import type { TierData } from '../src/sim/types';
import { A_ATTACK, A_EVADE, A_PATROL } from '../src/sim/ai';
import { SCENARIOS, stress } from '../src/scenarios';
import { fire } from '../src/sim/combat';
import { at, make, run, tier } from './helpers';
import { free, start } from './real';

function sane(s: Sim): void {
  for (let i = 0; i < s.n; i++) {
    if (s.kind[i] === K_FREE) continue;
    if (!Number.isFinite(s.x[i]) || !Number.isFinite(s.y[i]) || !Number.isFinite(s.alt[i])) throw new Error(`unit ${i} has a non-finite position at tick ${s.tick}`);
    if (s.fcUsed[i] > 8 || s.engaged[i] > 64) throw new Error(`unit ${i} counter runaway at tick ${s.tick}`);
  }
}

describe('AI versus AI', () => {
  test('every free scenario runs to the end with both sides on AI', async () => {
    for (const scn of SCENARIOS) {
      const out: string[] = [];
      for (let seed = 1; seed <= 5; seed++) {
        const s = await start(scn, seed, 3);
        while (s.winner < 0) { step(s); if ((s.tick & 255) === 0) sane(s); }
        sane(s);
        expect(s.tick).toBeLessThanOrEqual(s.endTick + 4);
        out.push(`${['US', 'USSR', 'draw'][s.winner]}@${Math.round(s.tick / 120)}min`);
      }
      console.log(`${scn.name}: ${out.join(' ')}`);
    }
  });
  test('a 500-unit AI battle steps for two game hours without a fault', async () => {
    const s = await start(stress(free, 500, 7), 7, 3);
    let weapons = 0, sorties = 0;
    for (let i = 0; i < 14400 && s.winner < 0; i++) {
      step(s);
      if ((s.tick & 255) === 0) { sane(s); for (let j = 0; j < s.n; j++) { if (s.kind[j] === K_WPN) weapons++; if (s.kind[j] === K_AIR && s.flags[j] & F_RTB) sorties++; } }
    }
    expect(weapons).toBeGreaterThan(0);
    expect(s.n).toBeLessThanOrEqual(MAX);
    void sorties; void K_BUOY;
  });
});

const dist = (s: Sim, a: number, b: number) => Math.hypot(s.x[a] - s.x[b], s.y[a] - s.y[b]);
/** Entity ids that launched a weapon, read from the event queue (the tests never drain it). */
const shooters = (s: Sim) => { const r = new Set<number>(); for (let e = 0; e < s.evN; e++) if ((s.ev[e * 4] & 255) === E_LAUNCH) r.add(s.ev[e * 4 + 1]); return r; };
const custom = (edit: (t: TierData) => void) => { const t = structuredClone(tier); edit(t); return compileDb(t); };

describe('AI behaviour', () => {
  test('patrol: with nothing in sight an AI ship keeps walking its route, both ends', () => {
    const s = make([at('ussr', 'efrig', 0, 0, { wp: [[0.05, 0], [0, 0]], kts: 20 })], 1, 2); // 5.6 km east and back
    let east = false, back = false;
    for (let i = 0; i < 3000; i++) { step(s); if (s.x[0] > 5.4) east = true; if (east && s.x[0] < 0.2) back = true; }
    expect(east && back).toBe(true);
    expect(s.ai[0]).toBe(A_PATROL);
  });
  test('detect and attack: an AI ship leaves its patrol, closes on a tracked enemy it can hit, and fires', () => {
    // its SSM reaches 40 km in this database, so it should close from 38 km to half that before holding off
    const d = custom((t) => { t.weapons.ssm.maxKm = 40; t.units.tmerch.hp = 5000; });
    const s = make([at('ussr', 'efrig', 0, 0, { wp: [[0, 0.2], [0, 0]], kts: 12 }), at('us', 'tmerch', 38, 0)], 1, 2, {}, d);
    run(s, 40);
    expect(s.ai[0]).toBe(A_ATTACK);
    expect(s.tgt[0]).toBe(1);
    run(s, 300);
    expect(s.dx[0]).toBeGreaterThan(0.9); // heading east at the target, not along its north-south patrol
    run(s, 3000);
    expect(dist(s, 0, 1)).toBeLessThan(21); // closed to half weapon range
    expect(dist(s, 0, 1)).toBeGreaterThan(15); // and no closer
    expect(shooters(s).has(0)).toBe(true);
    expect(s.hp[1]).toBeLessThan(5000); // hit by its SSMs
  });
  test('an AI unit does not chase a target none of its weapons can hit', () => {
    // the frigate has no anti-submarine weapon in this database; the submarine is tracked by its active sonar
    const d = custom((t) => { t.units.efrig.sonar![0].passiveKm = 40; }); // good ears, so it hears the submarine and goes active
    const s = make([at('ussr', 'efrig', 0, 0), at('us', 'tsub', 3, 0, { alt: -50, kts: 12, wp: [[0.027, 0.01], [0.027, -0.01]] })], 1, 2, {}, d);
    s.spd[1] = 12 * 0.000514444;
    run(s, 300);
    expect(s.det[MAX + 1]).toBe(2); // it does hold the track
    expect(s.ai[0]).toBe(A_PATROL);
    expect(s.spd[0]).toBe(0); // and stays where it was instead of driving onto it
  });
  test('evade, then back to patrol: an AI submarine runs from a torpedo, crosses the layer, and later resumes its route and depth', () => {
    const d = custom((t) => { t.weapons.torp.pHit = 0; }); // the torpedo will miss, so the submarine lives to resume
    const s = make([at('ussr', 'esub', 0, 0, { alt: -50, kts: 5, wp: [[0, 0.05], [0, 0]] }), at('us', 'tsub', 6, 0, { alt: -50 })], 3, 2, {}, d);
    s.det[0] = 2; s.holder[0] = 1;
    expect(fire(s, 1, 0, 0)).toBe(0);
    run(s, 60);
    expect(s.ai[0]).toBe(A_EVADE);
    expect(s.ordAlt[0]).toBeLessThan(-100); // below the 100 m layer
    expect(s.dx[0]).toBeLessThan(-0.7); // heading west, directly away from the shooter to the east
    expect(s.spd[0]).toBeGreaterThan(5 * 0.000514444);
    run(s, 1400); // the torpedo has missed and the evasion timer has run out
    expect(s.ai[0]).toBe(A_PATROL);
    expect(s.ordAlt[0]).toBe(-50);
    expect(s.wpN[0]).toBe(2);
    expect(s.flags[0] & F_LOOP).toBeTruthy();
  });
  test('ships go active when a submarine is about, and go quiet again when it is gone', () => {
    const s = make([at('ussr', 'efrig', 0, 0), at('us', 'tsub', 1, 0, { alt: -50, kts: 12, wp: [[1, 1]] })], 1, 2); // 1 km: inside the frigate's passive reach
    s.spd[1] = 12 * 0.000514444;
    expect(s.flags[0] & F_ACTIVE).toBe(0);
    run(s, 80);
    expect(s.flags[0] & F_ACTIVE).toBeTruthy();
    s.x[1] = 400; // the submarine is somewhere else entirely
    run(s, 80);
    expect(s.flags[0] & F_ACTIVE).toBe(0);
  });
  test('a ship under torpedo attack starts pinging', () => {
    const d = custom((t) => { t.weapons.torp.pHit = 0; });
    const s = make([at('ussr', 'efrig', 0, 0), at('us', 'tsub', 9, 0, { alt: -150 })], 1, 2, {}, d);
    s.det[0] = 2; s.holder[0] = 1;
    fire(s, 1, 0, 0);
    run(s, 320); // the torpedo comes inside the frigate's hearing (5 km x 1.2) after about two minutes
    expect(s.ai[0]).toBe(A_EVADE);
    expect(s.dx[0]).toBeLessThan(-0.7); // running west, away from it
    expect(s.flags[0] & F_ACTIVE).toBeTruthy();
  });
  test('return to base: an AI bomber launches at a track, fires, lands, and is turned around', () => {
    // a Soviet frigate tracks a US merchant 150 km from the base; the base launches its bomber at the track
    const s = make([at('ussr', 'ebase', 0, 0, { air: [{ type: 'ejet', n: 1, loadout: 'asm' }] }), at('us', 'tmerch', 150, 0), at('ussr', 'efrig', 120, 0)], 1, 2);
    run(s, 60);
    expect(s.flags[1] & F_STOWED).toBe(0); // launched to strike
    let fired = false, landed = false;
    for (let i = 0; i < 8000 && !landed; i++) {
      step(s);
      if (s.kind[1] === K_AIR && s.ammo[1 * 8] === 0) fired = true;
      landed = fired && (s.flags[1] & F_STOWED) !== 0;
    }
    expect(fired).toBe(true); // released both missiles
    expect(landed).toBe(true);
    expect(s.ammo[1 * 8]).toBe(2); // rearmed on the ground
    expect(s.busy[1]).toBeGreaterThan(s.tick); // and in turnaround
  });
  test('decks: a carrier launches a fighter at an inbound bomber, and the fighter engages it', () => {
    const d = custom((t) => { t.units.tfrig.mounts = []; }); // no SAMs on the ship, so only the fighter can shoot
    const s = make([at('us', 'tfrig', 0, 0, { air: [{ type: 'tjet', n: 1, loadout: 'cap' }] }), at('ussr', 'ejet', 220, 0, { alt: 5000, kts: 430, wp: [[0, 0]] })], 1, 1, {}, d);
    run(s, 80);
    expect(s.flags[1] & F_STOWED).toBe(0); // scrambled
    let killed = false;
    for (let i = 0; i < 3000 && !killed; i++) { step(s); killed = s.kind[2] === K_FREE; }
    expect(shooters(s).has(1)).toBe(true);
    expect(killed).toBe(true);
  });
  test('helicopters: an AI frigate keeps one up as a screen; it pings a bearing, gets its own hold, and drops on the submarine', () => {
    // the submarine sits 14 km ahead, beyond the frigate's own torpedoes and sonar; only the helicopter can reach it
    const d = custom((t) => { t.units.tfrig.mounts = []; t.units.esub.hp = 60; });
    const s = make([at('us', 'tfrig', 0, 0, { kts: 6, wp: [[0.5, 0]], air: [{ type: 'thelo', n: 1, loadout: 'asw' }] }), at('ussr', 'esub', 13, 0.3, { alt: -60, kts: 16, wp: [[0.117, -0.02], [0.117, 0.02]] })], 2, 1, {}, d);
    s.spd[2] = 16 * 0.000514444;
    run(s, 40);
    expect(s.flags[1] & F_STOWED).toBe(0); // the screen is up without any contact
    let buoys = 0, sunk = false;
    for (let i = 0; i < 9000 && !sunk; i++) { step(s); sunk = s.kind[2] === K_FREE; }
    for (let i = 0; i < s.n; i++) if (s.kind[i] === K_BUOY) buoys++;
    expect(buoys).toBeGreaterThan(0);
    expect(shooters(s).has(1)).toBe(true); // the helicopter dropped a torpedo
    expect(sunk).toBe(true);
    void K_SUB; void F_RTB; void fire;
  });
});
