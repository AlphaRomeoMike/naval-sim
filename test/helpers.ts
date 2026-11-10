import { allocSim, resetSim, finishSetup, compileDb, step, type Sim, type Scenario, type ScnUnit, type Db } from '../src/sim/sim';
import type { TierData } from '../src/sim/types';
import fixture from './fixture.json';
import '../src/sim/all';

export const tier = fixture as unknown as TierData;
export const db: Db = compileDb(tier);

/** Scenario centred on 0,0 so 1 degree of longitude is 111.32 km and of latitude 110.57 km. */
export function scn(units: ScnUnit[], extra: Partial<Scenario> = {}): Scenario {
  return { id: 'test', name: 'test', brief: '', lon: 0, lat: 0, layerM: 100, minutes: 600, timeoutWinner: 'us', units, ...extra };
}
/** A scenario unit placed at x,y kilometres from the centre. */
export function at(side: 'us' | 'ussr', type: string, x: number, y: number, extra: Partial<ScnUnit> = {}): ScnUnit {
  return { side, type, lon: x / 111.32, lat: y / 110.57, ...extra };
}
export function make(units: ScnUnit[], seed = 1, ai = 0, extra: Partial<Scenario> = {}, d: Db = db): Sim {
  const s = resetSim(allocSim(), d, scn(units, extra), seed);
  s.aiSides = ai;
  finishSetup(s);
  return s;
}
export function run(s: Sim, ticks: number): Sim { for (let i = 0; i < ticks; i++) step(s); return s; }
