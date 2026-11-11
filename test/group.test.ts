import { describe, expect, test } from 'vitest';
import { applyOrder, describe as info, leaderOf, writeSnapshot, K_AIR, KTS, SNAP_HDR, SNAP_LEN, SNAP_REC, F_STOWED, F_RTB, O_MOVE, O_SPEED, O_ALT, O_JOIN, O_FORM, O_LAUNCH, O_RTB, O_STOP, type Sim } from '../src/sim/sim';
import { at, make, run } from './helpers';

const ord = (s: Sim, k: number, u: number, a = 0, b = 0, c = 0) => applyOrder(s, [s.tick, k, u, a, b, c]);
const dist = (s: Sim, a: number, b: number) => Math.hypot(s.x[a] - s.x[b], s.y[a] - s.y[b]);

describe('formations', () => {
  test('followers take their places beside the leader and hold its speed', () => {
    const s = make([at('us', 'tfrig', 0, 0), at('us', 'tfrig', -6, 3), at('us', 'tfrig', -9, -5)]);
    expect(ord(s, O_JOIN, 1, 0)).toBe(0);
    expect(ord(s, O_JOIN, 2, 0)).toBe(0);
    ord(s, O_MOVE, 0, 200, 0); // due east
    ord(s, O_SPEED, 0, 15);
    run(s, 4000);
    // line abreast: 4 km on either beam, level with the leader (east is +x, so "right" is south)
    expect(s.x[1]).toBeCloseTo(s.x[0], 0); expect(s.y[1]).toBeCloseTo(-4, 0);
    expect(s.x[2]).toBeCloseTo(s.x[0], 0); expect(s.y[2]).toBeCloseTo(4, 0);
    expect(Math.abs(s.spd[1] - s.spd[0]) / KTS).toBeLessThan(0.5); // in place: the leader's speed, not flank
    // column: one behind the other
    expect(ord(s, O_FORM, 2, 1)).toBe(0); // given to a follower, it reaches the leader
    expect(s.form[0]).toBe(1);
    run(s, 4000);
    expect(s.y[1]).toBeCloseTo(0, 0); expect(s.x[0] - s.x[1]).toBeCloseTo(4, 0);
    expect(s.y[2]).toBeCloseTo(0, 0); expect(s.x[0] - s.x[2]).toBeCloseTo(8, 0);
    // wedge: back and out
    ord(s, O_FORM, 0, 2);
    run(s, 4000);
    expect(s.x[0] - s.x[1]).toBeCloseTo(4, 0); expect(s.y[1]).toBeCloseTo(-4, 0);
    expect(s.x[0] - s.x[2]).toBeCloseTo(4, 0); expect(s.y[2]).toBeCloseTo(4, 0);
  });

  test('helm orders to a follower steer the whole formation; leaving frees one unit', () => {
    const s = make([at('us', 'tsub', 0, 0), at('us', 'tsub', -5, 0), at('us', 'tsub', -5, 5)]);
    ord(s, O_JOIN, 1, 0); ord(s, O_JOIN, 2, 0);
    expect(ord(s, O_MOVE, 2, 0, 100)).toBe(0);
    expect(s.wpY[0]).toBe(100); // the leader got the course
    ord(s, O_SPEED, 1, 9);
    expect(s.ordSpd[0]).toBeCloseTo(9 * KTS, 6);
    ord(s, O_ALT, 1, -200);
    expect([s.ordAlt[0], s.ordAlt[1], s.ordAlt[2]]).toEqual([-200, -200, -200]);
    expect(info(s, 1, 0)!.lead).toBe(0);
    expect(info(s, 0, 0)!.followers).toBe(2);
    expect(ord(s, O_JOIN, 1, -1)).toBe(0); // leave
    run(s, 4);
    expect(leaderOf(s, 1)).toBe(-1);
    expect(s.slot[2]).toBe(1); // the one left moves up
    expect(s.wpN[0]).toBe(1); // the leader keeps its course
    ord(s, O_STOP, 2);
    expect(s.wpN[0]).toBe(0);
    ord(s, O_JOIN, 0, -1); // the leader dismisses the rest
    expect(leaderOf(s, 2)).toBe(-1);
  });

  test('only like units on one side form up, and never in a circle', () => {
    const s = make([at('us', 'tfrig', 0, 0), at('us', 'tsub', 5, 0), at('ussr', 'efrig', 300, 0), at('us', 'tfrig', 5, 5), at('us', 'tjet', 0, 9), at('us', 'thelo', 0, 12)]);
    expect(ord(s, O_JOIN, 1, 0)).toBe(1); // a submarine on a ship
    expect(ord(s, O_JOIN, 0, 2)).toBe(1); // the enemy
    expect(ord(s, O_JOIN, 0, 0)).toBe(1); // itself
    expect(ord(s, O_JOIN, 5, 4)).toBe(1); // a helicopter on a jet
    expect(ord(s, O_JOIN, 3, 0)).toBe(0);
    expect(ord(s, O_JOIN, 0, 3)).toBe(1); // its own follower
    expect(ord(s, O_FORM, 0, 3)).toBe(1); // no such shape
  });

  test('a follower whose leader is sunk carries on alone at cruise speed', () => {
    const s = make([at('us', 'tfrig', 0, 0), at('us', 'tfrig', -30, 0)]);
    ord(s, O_JOIN, 1, 0);
    ord(s, O_MOVE, 0, 300, 0);
    run(s, 20);
    expect(s.ordSpd[1]).toBeCloseTo(s.db.units[s.def[1]].maxKmps, 6); // far behind: catching up
    s.kind[0] = 0; s.gen[0]++; // the leader is lost
    run(s, 2);
    expect(s.lead[1]).toBe(0);
    expect(s.ordSpd[1]).toBeCloseTo(s.db.units[s.def[1]].cruiseKmps, 6);
  });
});

describe('launching a flight', () => {
  // unit 0 is the deck; 1..3 are its aircraft
  // a US ship far out of sight keeps the battle going, so nothing is revealed to side 0
  const deck = () => make([at('ussr', 'ebase', 0, 0, { air: [{ type: 'ejet', n: 3 }] }), at('us', 'tfrig', 400, 0)]);

  test('aircraft ordered up as a flight wait for the deck, then form on the leader', () => {
    const s = deck();
    expect(ord(s, O_LAUNCH, 1, -1, 2)).toBe(0); // leader: its own id + 1
    expect(ord(s, O_LAUNCH, 2, -1, 2)).toBe(0); // deck busy, but a flight member queues instead of being refused
    expect(ord(s, O_LAUNCH, 3, -1, 2)).toBe(0);
    expect(ord(s, O_LAUNCH, 2, -1)).toBe(14); // a plain launch is still refused while the deck is busy
    expect(s.flags[2] & F_STOWED).toBeTruthy();
    expect(info(s, 0, 1)!.hangar.map((h) => h.queued)).toEqual([false, true, true]);
    run(s, 2 * 60 * 2 + 10); // two launch intervals of 60 s
    expect([1, 2, 3].every((j) => !(s.flags[j] & F_STOWED))).toBe(true);
    expect([leaderOf(s, 2), leaderOf(s, 3)]).toEqual([1, 1]);
    ord(s, O_MOVE, 1, 0, 300);
    run(s, 1200);
    expect(dist(s, 1, 2)).toBeCloseTo(4, 0);
    expect(dist(s, 1, 3)).toBeCloseTo(4, 0);
    // the page sees who leads whom, and each unit's speed and fuel
    const buf = new Float32Array(SNAP_LEN);
    writeSnapshot(s, 1, buf);
    const rec = (id: number) => { for (let q = 0, p = SNAP_HDR; q < buf[2]; q++, p += SNAP_REC) if (buf[p] === id) return p; return -1; };
    expect(buf[rec(2) + 15]).toBe(1);
    expect(buf[rec(1) + 15]).toBe(-1);
    expect(buf[rec(2) + 13]).toBeCloseTo(s.spd[2] / KTS, 3);
    expect(buf[rec(2) + 14]).toBeGreaterThan(0);
    // the other side's snapshot gives none of that away for an untracked unit
    writeSnapshot(s, 0, buf);
    expect(rec(2) < 0 || (buf[rec(2) + 15] === -1 && buf[rec(2) + 14] === 0)).toBe(true);
  });

  test('a leader sent home takes the flight with it; a follower sent home goes alone', () => {
    const s = deck();
    ord(s, O_LAUNCH, 1, -1, 2); ord(s, O_LAUNCH, 2, -1, 2); ord(s, O_LAUNCH, 3, -1, 2);
    run(s, 300);
    ord(s, O_MOVE, 1, 0, 200);
    run(s, 600);
    expect(ord(s, O_RTB, 3)).toBe(0);
    run(s, 2);
    expect(leaderOf(s, 3)).toBe(-1);
    expect(leaderOf(s, 2)).toBe(1);
    expect(s.flags[1] & F_RTB).toBe(0);
    expect(ord(s, O_RTB, 1)).toBe(0);
    expect(s.flags[2] & F_RTB).toBeTruthy();
    run(s, 4000);
    expect([1, 2, 3].every((j) => s.kind[j] === K_AIR && (s.flags[j] & F_STOWED) !== 0)).toBe(true);
    expect([s.lead[2], s.lead[3]]).toEqual([0, 0]);
  });
});
