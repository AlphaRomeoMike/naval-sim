import { describe, expect, test } from 'vitest';
import { applyOrder, horizonKm, noiseOf, MAX, KTS, O_SONAR, O_RADAR, O_ALT, F_ACTIVE } from '../src/sim/sim';
import { at, make, run } from './helpers';

const det = (s: ReturnType<typeof make>, side: number, i: number) => s.det[side * MAX + i];

describe('radar horizon', () => {
  test('formula: d_km = 4.12 x (sqrt(h_sensor) + sqrt(h_target))', () => {
    expect(horizonKm(25, 25)).toBeCloseTo(41.2, 6);
    expect(horizonKm(100, 0)).toBeCloseTo(41.2, 6);
    expect(horizonKm(10000, 16)).toBeCloseTo(4.12 * 104, 6);
    expect(horizonKm(0, 0)).toBe(0);
  });
  test('a ship radar sees a ship inside the horizon but not beyond it, whatever its static range', () => {
    // both masts 25 m -> horizon 41.2 km; the radar's static surface range is 60 km
    const near = run(make([at('us', 'tfrig', 0, 0), at('ussr', 'efrig', 40, 0)]), 8);
    const far = run(make([at('us', 'tfrig', 0, 0), at('ussr', 'efrig', 43, 0)]), 8);
    expect(det(near, 0, 1)).toBe(2);
    expect(det(far, 0, 1)).toBe(0);
  });
  test('a high aircraft is seen far beyond the surface horizon, limited by static range', () => {
    // bomber at 10 km altitude: horizon 4.12 x (5 + 100) = 432 km; static air range 300 km
    const inRange = run(make([at('us', 'tfrig', 0, 0), at('ussr', 'ejet', 290, 0, { alt: 10000 })]), 8);
    const out = run(make([at('us', 'tfrig', 0, 0), at('ussr', 'ejet', 310, 0, { alt: 10000 })]), 8);
    expect(det(inRange, 0, 1)).toBe(2);
    expect(det(out, 0, 1)).toBe(0);
    // the same bomber at 100 m is under the horizon at 100 km: 4.12 x (5 + 10) = 61.8 km
    const low = run(make([at('us', 'tfrig', 0, 0), at('ussr', 'ejet', 100, 0, { alt: 100 })]), 8);
    expect(det(low, 0, 1)).toBe(0);
  });
  test('radar off means no radar contacts', () => {
    const s = make([at('us', 'tfrig', 0, 0), at('ussr', 'efrig', 30, 0)]);
    applyOrder(s, [0, O_RADAR, 0, 0, 0, 0]);
    run(s, 8);
    expect(det(s, 0, 1)).toBe(0);
  });
});

describe('sonar', () => {
  test('passive range = base range x target noise factor, and noise rises with speed', () => {
    // US sub passive base 45 km. Enemy sub noise 0.5, 16 kts max.
    const s = make([at('us', 'tsub', 0, 0), at('ussr', 'esub', 10, 0)]);
    expect(noiseOf(s, 1)).toBeCloseTo(0.5 * 0.25, 6); // stopped: 45 x 0.125 = 5.6 km -> not heard at 10 km
    run(s, 8);
    expect(det(s, 0, 1)).toBe(0);
    s.spd[1] = 8 * KTS; s.wpN[1] = 1; s.wpX[1 * 8] = 10; s.wpY[1 * 8] = 500; s.ordSpd[1] = 8 * KTS;
    expect(noiseOf(s, 1)).toBeCloseTo(0.5 * (0.25 + 0.75 * 0.5), 6); // 8 of 16 kts: 45 x 0.3125 = 14 km -> heard
    run(s, 8);
    expect(det(s, 0, 1)).toBe(1); // passive gives a bearing, not a track
  });
  test('range is halved across the thermocline', () => {
    const mk = (depth: number) => {
      const s = make([at('us', 'tsub', 0, 0, { alt: -50 }), at('ussr', 'esub', 10, 0, { alt: depth })]);
      s.spd[1] = 8 * KTS; s.wpN[1] = 1; s.wpX[8] = 10; s.wpY[8] = 500; s.ordSpd[1] = 8 * KTS;
      return run(s, 8);
    };
    expect(det(mk(-50), 0, 1)).toBe(1); // same side of the 100 m layer: 14 km
    expect(det(mk(-200), 0, 1)).toBe(0); // across it: 7 km
  });
  test('active sonar gives a track, and gives the pinger away out to 1.5x its range', () => {
    // enemy frigate active range 10 km, stopped (passive range against it: 45 x 0.25 = 11 km)
    const s = make([at('us', 'tsub', 0, 0, { alt: -50 }), at('ussr', 'efrig', 14, 0)]);
    run(s, 8);
    expect(det(s, 0, 1)).toBe(0); // quiet and beyond 11 km
    applyOrder(s, [s.tick, O_SONAR, 1, 1, 0, 0]);
    expect(s.flags[1] & F_ACTIVE).toBeTruthy();
    run(s, 8);
    expect(det(s, 0, 1)).toBe(1); // pinging: heard out to 15 km
    expect(det(s, 1, 0)).toBe(0); // but 14 km is beyond its own 10 km active range
    const close = make([at('us', 'tsub', 0, 0, { alt: -50 }), at('ussr', 'efrig', 9, 0)]);
    applyOrder(close, [0, O_SONAR, 1, 1, 0, 0]);
    run(close, 8);
    expect(det(close, 1, 0)).toBe(2); // inside active range: a track
  });
  test('a bearing becomes a track by cross-fix, or after 180 s of target motion analysis', () => {
    const mover = (units: ReturnType<typeof at>[]) => {
      const s = make(units);
      const e = units.length - 1;
      s.spd[e] = 8 * KTS; s.wpN[e] = 1; s.wpX[e * 8] = 500; s.wpY[e * 8] = 3; s.ordSpd[e] = 8 * KTS;
      return s;
    };
    const one = mover([at('us', 'tsub', 0, 0, { alt: -50 }), at('ussr', 'esub', 0, 3, { alt: -50 })]);
    run(one, 8);
    expect(det(one, 0, 1)).toBe(1);
    run(one, 400); // 200 s later
    expect(det(one, 0, 1)).toBe(2);
    const two = mover([at('us', 'tsub', 0, 0, { alt: -50 }), at('us', 'tsub', 0, 6, { alt: -50 }), at('ussr', 'esub', 0, 3, { alt: -50 })]);
    run(two, 8);
    expect(det(two, 0, 2)).toBe(2); // two bearings cross
  });
  test('a towed array listens from below the layer', () => {
    // deep enemy sub at 20 km doing 16 kts (noise 0.5): hull sonar 8 x 0.5 x 0.5 = 2 km; towed 60 x 0.5 = 30 km
    const mk = (type: string) => {
      const s = make([at('us', type, 0, 0), at('ussr', 'esub', 20, 0, { alt: -200 })]);
      applyOrder(s, [0, O_RADAR, 0, 0, 0, 0]);
      s.spd[1] = 16 * KTS; s.wpN[1] = 1; s.wpX[8] = 20; s.wpY[8] = 500; s.ordSpd[1] = 16 * KTS;
      return run(s, 8);
    };
    expect(det(mk('tfrig'), 0, 1)).toBe(0);
    expect(det(mk('tfrig2'), 0, 1)).toBe(1);
    void O_ALT;
  });
});
