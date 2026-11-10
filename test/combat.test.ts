import { describe, expect, test } from 'vitest';
import { applyOrder, compileDb, MAX, NM, K_FREE, K_WPN, F_WFREE, O_FIRE, O_RADAR, type Sim } from '../src/sim/sim';
import { fire, hitChance } from '../src/sim/combat';
import type { TierData } from '../src/sim/types';
import { at, db, make, run, tier } from './helpers';

const hold = (s: Sim, ...ids: number[]) => { for (const i of ids) s.flags[i] &= ~F_WFREE; };
const weapons = (s: Sim) => { let n = 0; for (let i = 0; i < s.n; i++) if (s.kind[i] === K_WPN) n++; return n; };
const custom = (edit: (t: TierData) => void) => { const t = structuredClone(tier); edit(t); return compileDb(t); };
const mount = (s: Sim, u: number, id: string) => { for (let m = 0; m < NM; m++) if (s.mw[u * NM + m] === s.db.w[id]) return m; throw new Error('no mount ' + id); };

describe('weapon envelopes', () => {
  test('min and max range', () => {
    // frigate SSM: 5-100 km, surface targets
    for (const [d, code] of [[3, 5], [30, 0], [150, 5]] as const) {
      const s = run(make([at('us', 'tfrig', 0, 0), at('ussr', 'efrig', d, 0)]), 8);
      s.det[1] = 2; s.holder[1] = 0; // a track at every distance, so only the envelope decides
      expect(fire(s, 0, mount(s, 0, 'ssm'), 1)).toBe(code);
    }
  });
  test('an untracked target gives the same refusal at any range: the reason must not leak where it is', () => {
    for (const d of [3, 30, 150, 900]) {
      const s = make([at('us', 'tfrig', 0, 0), at('ussr', 'esub', d, 0, { alt: -60 })]);
      run(s, 8);
      for (const w of ['ssm', 'sam', 'gun', 'ltorp']) expect(fire(s, 0, mount(s, 0, w), 1)).toBe(4);
    }
  });
  test('target altitude band: surface, air and submerged weapons only reach their own band', () => {
    const s = make([at('us', 'tfrig', 0, 0), at('ussr', 'efrig', 30, 0), at('ussr', 'ejet', 0, 30, { alt: 5000 }), at('ussr', 'esub', 0, -3, { alt: -60 }), at('ussr', 'efrig', 3, 0)]);
    hold(s, 0, 1, 2, 3, 4);
    run(s, 8);
    s.det[0 * MAX + 3] = 2; s.holder[0 * MAX + 3] = 0; // give the frigate a sub track for this check
    expect(fire(s, 0, mount(s, 0, 'sam'), 1)).toBe(6); // SAM (5..20000 m) at a ship
    expect(fire(s, 0, mount(s, 0, 'ssm'), 2)).toBe(6); // SSM (0..0) at an aircraft
    expect(fire(s, 0, mount(s, 0, 'ltorp'), 4)).toBe(6); // ASW torpedo (-450..-5) at a ship 3 km away
    expect(fire(s, 0, mount(s, 0, 'ltorp'), 3)).toBe(0); // ... at a submarine
    expect(fire(s, 0, mount(s, 0, 'sam'), 2)).toBe(0); // SAM at the aircraft
  });
  test('no track, no shot', () => {
    const s = make([at('us', 'tsub', 0, 0), at('ussr', 'efrig', 20, 0)]);
    expect(fire(s, 0, 0, 1)).toBe(4);
  });
  test('rounds and reload: a shared launcher blocks every weapon on it', () => {
    const s = run(make([at('us', 'tfrig', 0, 0), at('ussr', 'efrig', 30, 0)]), 8);
    expect(applyOrder(s, [s.tick, O_FIRE, 0, mount(s, 0, 'ssm'), 1, 0])).toBe(0);
    expect(fire(s, 0, mount(s, 0, 'ssm'), 1)).toBe(3); // reloading
    expect(fire(s, 0, mount(s, 0, 'sam'), 1)).toBe(3); // same launcher group
    s.ammo[0 * NM + mount(s, 0, 'ssm')] = 0;
    run(s, 20);
    expect(fire(s, 0, mount(s, 0, 'ssm'), 1)).toBe(2); // empty
  });
  test('anti-radiation weapons need an emitting target; GPS weapons need a stationary one', () => {
    const s = make([at('us', 'tjet', 0, 0, { alt: 3000, loadout: 'strike' }), at('ussr', 'efrig', 20, 0, { wp: [[5, 5]] }), at('ussr', 'ebase', 0, 15)]);
    hold(s, 0, 1);
    run(s, 8);
    expect(fire(s, 0, mount(s, 0, 'jdam'), 2)).toBe(0); // base does not move
    run(s, 60);
    expect(fire(s, 0, mount(s, 0, 'jdam'), 1)).toBe(10); // ship under way
    s.flags[1] &= ~1; // enemy radar off
    expect(fire(s, 0, mount(s, 0, 'arm'), 1)).toBe(9);
    s.flags[1] |= 1;
    expect(fire(s, 0, mount(s, 0, 'arm'), 1)).toBe(0);
  });
});

describe('semi-active guidance', () => {
  test('a ship can guide only as many semi-active missiles as it has fire-control channels', () => {
    const d = custom((t) => { t.units.tfrig.mounts[0].reloadS = 1; });
    const s = make([at('us', 'tfrig', 0, 0), at('ussr', 'ejet', 30, 0, { alt: 5000 }), at('ussr', 'ejet', 0, 30, { alt: 5000 }), at('ussr', 'ejet', -30, 0, { alt: 5000 })], 1, 0, {}, d);
    hold(s, 0);
    run(s, 8);
    const m = mount(s, 0, 'sam');
    expect(fire(s, 0, m, 1)).toBe(0);
    run(s, 4);
    expect(fire(s, 0, m, 2)).toBe(0);
    run(s, 4);
    expect(s.fcUsed[0]).toBe(2);
    expect(fire(s, 0, m, 3)).toBe(7); // both channels busy for the whole flight
    run(s, 200); // both missiles arrive (base chance 1 in the fixture)
    expect(s.fcUsed[0]).toBe(0);
    expect(s.kind[1]).toBe(K_FREE);
    expect(fire(s, 0, m, 3)).toBe(0);
  });
  test('the missile is lost if the launcher stops illuminating; fire-and-forget weapons are not', () => {
    const s = make([at('us', 'tfrig', 0, 0), at('ussr', 'ejet', 35, 0, { alt: 5000 }), at('ussr', 'efrig', 30, 5)]);
    hold(s, 0, 1, 2);
    run(s, 8);
    s.pdReady.fill(1e9); // no point defence in this test
    expect(fire(s, 0, mount(s, 0, 'sam'), 1)).toBe(0);
    run(s, 20);
    expect(fire(s, 0, mount(s, 0, 'ssm'), 2)).toBe(0);
    expect(weapons(s)).toBe(2);
    applyOrder(s, [s.tick, O_RADAR, 0, 0, 0, 0]);
    run(s, 2);
    expect(weapons(s)).toBe(1); // the SAM is gone, the active-radar SSM flies on
    expect(s.fcUsed[0]).toBe(0);
    run(s, 400);
    expect(s.hp[2]).toBe(40); // SSM hit for 60 of 100
    expect(s.kind[1]).not.toBe(K_FREE); // the aircraft survived
  });
});

describe('hit rolls and damage', () => {
  test('terminal chance = base chance x decoy and jamming factors for the seeker type', () => {
    const d = custom((t) => {
      Object.assign(t.units.efrig, { chaff: 0.8, jam: 0.9, nixie: 0.7 });
      for (const w of ['ssm', 'sam', 'aam', 'torp', 'gun', 'arm']) t.weapons[w].pHit = 0.5;
    });
    const s = make([at('us', 'tfrig', 0, 0), at('ussr', 'efrig', 30, 0)], 1, 0, {}, d);
    expect(hitChance(s, d.w.ssm, 1)).toBeCloseTo(0.5 * 0.8 * 0.9, 9); // active radar: chaff and jamming
    expect(hitChance(s, d.w.sam, 1)).toBeCloseTo(0.5 * 0.8 * 0.9, 9); // semi-active radar
    expect(hitChance(s, d.w.aam, 1)).toBeCloseTo(0.5 * 0.8, 9); // infrared: decoys only
    expect(hitChance(s, d.w.torp, 1)).toBeCloseTo(0.5 * 0.7, 9); // acoustic: torpedo decoy
    expect(hitChance(s, d.w.gun, 1)).toBeCloseTo(0.5, 9); // unguided
    expect(hitChance(s, d.w.arm, 1)).toBeCloseTo(0.5, 9); // anti-radiation
  });
  test('one roll per shot: the hit rate matches the chance', () => {
    const d = custom((t) => { t.weapons.gun.pHit = 0.3; t.weapons.gun.dmg = 1; t.units.efrig.hp = 1e6; });
    const s = run(make([at('us', 'tfrig', 0, 0), at('ussr', 'efrig', 10, 0)], 7, 0, {}, d), 8);
    const m = mount(s, 0, 'gun'), N = 4000;
    for (let i = 0; i < N; i++) { s.ready[m] = 0; s.ammo[m] = 5; expect(fire(s, 0, m, 1)).toBe(0); }
    const hits = 1e6 - s.hp[1];
    expect(hits / N).toBeGreaterThan(0.27);
    expect(hits / N).toBeLessThan(0.33);
  });
  test('a hit removes hit points and disables exactly one subsystem; enough damage sinks the ship', () => {
    const s = make([at('us', 'tfrig', 0, 0), at('ussr', 'efrig', 30, 0)]);
    hold(s, 1);
    run(s, 8);
    s.pdReady.fill(1e9); // no point defence in this test
    fire(s, 0, mount(s, 0, 'ssm'), 1);
    run(s, 300);
    expect(s.hp[1]).toBe(40);
    expect([1, 2, 4, 8]).toContain(s.dis[1]);
    fire(s, 0, mount(s, 0, 'ssm'), 1);
    run(s, 300);
    expect(s.kind[1]).toBe(K_FREE);
  });
  test('an area weapon rolls against everything in its band inside the radius', () => {
    const s = make([at('us', 'tsub', 0, 0, { alt: -150 }), at('ussr', 'esub', 20, 0, { alt: -150 }), at('ussr', 'esub', 23, 0, { alt: -150 }), at('ussr', 'esub', 30, 0, { alt: -150 }), at('ussr', 'efrig', 21, 1)]);
    hold(s, 4); // or the frigate shoots the rocket down
    for (const t of [1, 2, 3]) { s.det[t] = 2; s.holder[t] = 0; }
    expect(fire(s, 0, mount(s, 0, 'nuke'), 1)).toBe(0);
    run(s, 200);
    expect(s.kind[1]).toBe(K_FREE); // aim point
    expect(s.kind[2]).toBe(K_FREE); // 3 km away, inside the 5 km radius
    expect(s.kind[3]).not.toBe(K_FREE); // 10 km away
    expect(s.hp[4]).toBe(100); // surface ship is outside the weapon's depth band
  });
});

describe('point defence', () => {
  const duel = (pd: number, seed: number) => {
    const d = custom((t) => { t.units.efrig.pd[0].pHit = pd; t.units.efrig.mounts = []; });
    const s = run(make([at('us', 'tfrig', 0, 0), at('ussr', 'efrig', 20, 0)], seed, 0, {}, d), 8);
    fire(s, 0, mount(s, 0, 'ssm'), 1);
    run(s, 200);
    return s.hp[1] < 100; // true if the missile got through
  };
  test('a certain point-defence shot always stops the missile; a hopeless one never does', () => {
    expect(duel(1, 1)).toBe(false);
    expect(duel(0, 1)).toBe(true);
  });
  test('one shot per reaction interval while the missile is inside the envelope', () => {
    // envelope 0.3-2 km, interval 4 s, missile 500 kts: 6.6 s inside -> exactly two shots.
    // At 0.5 per shot the missile should get through 25% of the time.
    let through = 0;
    const N = 600;
    for (let seed = 1; seed <= N; seed++) if (duel(0.5, seed * 7919)) through++;
    expect(through / N).toBeGreaterThan(0.19);
    expect(through / N).toBeLessThan(0.31);
  });
});

describe('entity table', () => {
  test('a launch refused because the table is full spends nothing', () => {
    const s = make([at('us', 'tfrig', 0, 0), at('ussr', 'efrig', 30, 0)]);
    hold(s, 0, 1);
    run(s, 8);
    for (let i = 0; i < MAX; i++) if (s.kind[i] === K_FREE) s.kind[i] = 6; // fill every slot with a dummy buoy
    s.n = MAX;
    const m = mount(s, 0, 'ssm'), before = s.ammo[m];
    expect(fire(s, 0, m, 1)).toBe(1);
    expect(s.ammo[m]).toBe(before);
    expect(s.ready[m]).toBe(0);
    expect(s.engaged[1]).toBe(0);
  });
});

describe('subsystem damage', () => {
  test('the rolled subsystem is one the unit has and that still works', () => {
    // a submarine has no flight deck: over many hits only sensors, propulsion and weapons are ever disabled
    const d = custom((t) => { t.units.esub.hp = 1e6; t.weapons.torp.dmg = 1; });
    const s = make([at('us', 'tsub', 0, 0, { alt: -50 }), at('ussr', 'esub', 5, 0, { alt: -50 })], 5, 0, {}, d);
    s.det[1] = 2; s.holder[1] = 0;
    const m = mount(s, 0, 'torp');
    for (let i = 0; i < 3; i++) { s.ready[m] = 0; expect(fire(s, 0, m, 1)).toBe(0); s.det[1] = 2; s.holder[1] = 0; run(s, 600); s.det[1] = 2; s.holder[1] = 0; }
    expect(s.dis[1]).toBe(1 | 2 | 4); // three hits, three different working subsystems, never the deck
  });
});

describe('automatic defence', () => {
  test('defensive fire is aimed at anti-ship weapons only, never at the other side\'s interceptors', () => {
    const s = run(make([at('us', 'tfrig', 0, 0), at('ussr', 'efrig', 30, 0)]), 8);
    s.pdReady.fill(1e9);
    fire(s, 1, mount(s, 1, 'ssm'), 0);
    let wrong = 0;
    for (let i = 0; i < 400; i++) {
      run(s, 1);
      for (let w = 0; w < s.n; w++) if (s.kind[w] === K_WPN && s.tgt[w] >= 0 && s.kind[s.tgt[w]] === K_WPN && s.db.weapons[s.def[s.tgt[w]]].d.altMin > 0) wrong++;
    }
    expect(wrong).toBe(0);
  });
  test('a weapons-free ship engages an inbound missile with its SAMs', () => {
    const s = run(make([at('us', 'tfrig', 0, 0), at('ussr', 'efrig', 30, 0)]), 8);
    s.pdReady.fill(1e9);
    fire(s, 1, mount(s, 1, 'ssm'), 0); // enemy SSM at the US frigate; fixture SAM base chance is 1
    run(s, 400);
    expect(s.hp[0]).toBe(100);
    expect(weapons(s)).toBe(0);
    void db;
  });
});
