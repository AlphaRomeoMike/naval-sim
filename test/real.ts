// Loads the shipped free-tier data and depth map for scenario tests.
import { readFileSync } from 'node:fs';
import { allocSim, compileDb, finishSetup, resetSim, type Db, type Scenario, type Sim } from '../src/sim/sim';
import { decodeGrayPng, type DepthMap } from '../src/sim/depth';
import type { TierData } from '../src/sim/types';
import '../src/sim/all';

export const free = JSON.parse(readFileSync('public/data/free.json', 'utf8')) as TierData;
export const freeDb: Db = compileDb(free);
let depth: DepthMap | null = null;
export async function depthMap(): Promise<DepthMap> {
  if (!depth) { const b = readFileSync('public/map/depth.png'); depth = await decodeGrayPng(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); }
  return depth;
}
/** Start a scenario exactly as the game worker does. */
export async function start(scn: Scenario, seed: number, ai: number, db: Db = freeDb, fit?: Record<number, string>): Promise<Sim> {
  const s = allocSim(), d = await depthMap();
  s.depth = d.data; s.dw = d.w; s.dh = d.h;
  resetSim(s, db, scn, seed, fit);
  s.aiSides = ai;
  finishSetup(s);
  return s;
}
