// Built-in scenarios. All places, orders of battle and briefings are original to this game.
import type { Scenario, ScnUnit } from './sim/sim';
import type { TierData } from './sim/types';

/** Synthetic load test: n units split between the sides, each on a random patrol loop. */
export function stress(tier: TierData, n: number, seed: number): Scenario {
  let a = seed | 0;
  const r = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ids = Object.keys(tier.units).filter((id) => tier.units[id].cls !== 'base' && tier.units[id].role !== 'merchant');
  const us = ids.filter((id) => tier.units[id].side === 'us'), su = ids.filter((id) => tier.units[id].side === 'ussr');
  const units: ScnUnit[] = [];
  const lon0 = -30, lat0 = 45, span = 5; // open Atlantic, roughly 800 x 1100 km
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 'ussr' : 'us', pool = side === 'us' ? us : su, type = pool[(r() * pool.length) | 0];
    const p = (): [number, number] => [lon0 + (r() - 0.5) * 2 * span, lat0 + (r() - 0.5) * 2 * span];
    const [lon, lat] = p();
    units.push({ side, type, lon, lat, wp: [p(), p(), p()] });
  }
  return { id: 'stress', name: 'Load test', brief: `${n} units on random patrols.`, lon: lon0, lat: lat0, layerM: 100, minutes: 600, timeoutWinner: 'us', units };
}

/** n bombers in line abreast across a north-east approach, so their missiles arrive together. */
const tu16 = (n: number, lon: number, lat: number, loadout: string, tag: string): ScnUnit[] =>
  Array.from({ length: n }, (_, i) => ({
    side: 'ussr' as const, type: 'tu16', name: `Tu-16 ${tag} ${i + 1}`,
    lon: lon - 0.169 * (i - (n - 1) / 2), lat: lat + 0.119 * (i - (n - 1) / 2),
    alt: 10000, kts: 430, loadout, obj: true, wp: [[5.5, 68.3], [33, 69]] as [number, number][],
  }));

export const SCENARIOS: Scenario[] = [
  {
    id: 'gap-barrier', name: 'Gap Barrier', lon: -18, lat: 61, layerM: 100, minutes: 180, timeoutWinner: 'us',
    brief: 'Two cargo ships are crossing the Iceland Basin eastbound with one frigate as escort. Intelligence puts a diesel boat on the route and a nuclear boat closing from the north-east.\n' +
      'US Navy: keep at least one cargo ship afloat for three hours, or sink both submarines. Your frigate carries one SH-2F with sonobuoys and Mk 46 torpedoes.\n' +
      'Soviet Navy: sink both cargo ships before they are clear.',
    units: [
      { side: 'us', type: 'merchant', name: 'Cargo ship 1', lon: -19.0, lat: 61.0, kts: 13, obj: true, wp: [[-14.5, 61.0], [-14.5, 61.05]] },
      { side: 'us', type: 'merchant', name: 'Cargo ship 2', lon: -19.06, lat: 60.97, kts: 13, obj: true, wp: [[-14.5, 60.97], [-14.5, 61.02]] },
      { side: 'us', type: 'ffg7e', name: 'Escort', lon: -18.88, lat: 61.0, kts: 14, wp: [[-14.4, 61.0], [-14.4, 61.05]], air: [{ type: 'sh2f', n: 1, loadout: 'asw' }] },
      { side: 'ussr', type: 'foxtrot', name: 'Foxtrot', lon: -18.25, lat: 61.06, alt: -60, kts: 5, obj: true, wp: [[-18.25, 60.94], [-18.25, 61.06]] },
      { side: 'ussr', type: 'victor1', name: 'Victor I', lon: -17.6, lat: 61.35, alt: -150, kts: 12, obj: true, wp: [[-18.3, 61.02], [-17.9, 60.95]] },
    ],
  },
  {
    id: 'bomber-stream', name: 'Bomber Stream', lon: 4, lat: 68, layerM: 80, minutes: 90, timeoutWinner: 'us',
    brief: 'A carrier and one frigate are alone in the Norwegian Sea. Twelve missile-carrying Tu-16s are inbound from the north-east: eight with the fast, high-flying AS-6, then four with AS-5.\n' +
      'US Navy: the carrier must still be afloat after 90 minutes. Get F-4s off the deck and out along the threat axis; the frigate\'s SM-1MR and the carrier\'s RIM-7E are the last line.\n' +
      'Soviet Navy: sink the carrier. Bombers can land at the airbase to rearm.',
    units: [
      { side: 'us', type: 'cv', name: 'Carrier', lon: 4, lat: 68, kts: 18, obj: true, wp: [[2.5, 67.6], [4, 68]], air: [{ type: 'f4j', n: 8, loadout: 'cap-7f' }] },
      { side: 'us', type: 'ffg7e', name: 'Escort', lon: 4.2, lat: 68.06, kts: 18, wp: [[2.7, 67.66], [4.2, 68.06]], air: [{ type: 'sh2f', n: 1, loadout: 'asw' }] },
      { side: 'ussr', type: 'airbase', name: 'Northern airbase', lon: 33, lat: 69 },
      ...tu16(8, 15.99, 70.44, 'as6', 'Red'), ...tu16(4, 17.26, 70.7, 'as5', 'Blue'),
    ],
  },
  {
    id: 'deep-shadow', name: 'Deep Shadow', lon: 158, lat: 47, layerM: 120, minutes: 180, timeoutWinner: 'ussr',
    brief: 'A Soviet destroyer and frigate are running south-west through deep water east of the Kurils. Two US attack submarines are waiting on their track.\n' +
      'US Navy: sink both warships inside three hours. Listen passively, hold a contact long enough for a firing solution, and remember the Krivak\'s SS-N-14 outranges your torpedoes.\n' +
      'Soviet Navy: get at least one ship through, or sink both submarines.',
    units: [
      { side: 'us', type: 'sturgeon', name: 'Sturgeon', lon: 157.7, lat: 46.75, alt: -90, kts: 5, obj: true },
      { side: 'us', type: 'permit', name: 'Permit', lon: 158.25, lat: 46.6, alt: -150, kts: 5, obj: true },
      { side: 'ussr', type: 'kashin', name: 'Kashin', lon: 158.6, lat: 47.35, kts: 16, obj: true, wp: [[157.2, 46.3], [156.4, 45.9]] },
      { side: 'ussr', type: 'krivak1', name: 'Krivak I', lon: 158.68, lat: 47.3, kts: 16, obj: true, wp: [[157.28, 46.25], [156.48, 45.85]] },
    ],
  },
  {
    id: 'tutorial', name: 'Tutorial: First Watch', lon: -30, lat: 45, layerM: 100, minutes: 90, timeoutWinner: 'ussr',
    brief: 'A ten-minute guided first battle. You command one frigate in the open Atlantic; a lone Soviet frigate is somewhere to the east.\n' +
      'The yellow box at the top tells you what to do next. Everything can be done with the mouse, by touch, or with the keyboard alone.',
    units: [
      { side: 'us', type: 'ffg7e', name: 'Your frigate', lon: -30, lat: 45, kts: 20, obj: true, air: [{ type: 'sh2f', n: 1, loadout: 'asw' }] },
      { side: 'ussr', type: 'krivak1', name: 'Krivak I', lon: -29.39, lat: 45, kts: 8, obj: true, wp: [[-30.2, 45.0], [-29.39, 45.0]] },
    ],
  },
];
