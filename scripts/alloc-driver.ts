// Driver for test/alloc.test.ts. It is bundled the way the game is (one module scope) and run on its own,
// because allocation depends on how V8 compiles the code and the test runner's module wrapping changes that.
// Prints one JSON line: bytes allocated per sim step in a 500-unit battle, with the top allocating functions.
import { readFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { allocSim, compileDb, finishSetup, resetSim, step } from '../src/sim/sim';
import { decodeGrayPng } from '../src/sim/depth';
import { stress } from '../src/scenarios';
import '../src/sim/all';

interface Node { callFrame: { functionName: string; lineNumber: number }; selfSize: number; children: Node[] }
const free = JSON.parse(readFileSync('public/data/free.json', 'utf8'));
const png = readFileSync('public/map/depth.png');
const depth = await decodeGrayPng(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer);
const s = allocSim();
s.depth = depth.data; s.dw = depth.w; s.dh = depth.h;
const db = compileDb(free);
const battle = (seed: number): void => { resetSim(s, db, stress(free, 500, seed), seed); s.aiSides = 3; finishSetup(s); };

// Warm-up on a battle of its own, so the JIT has seen every path (opening salvos, kills, aircraft recovery).
battle(3);
for (let i = 0; i < 12000; i++) step(s);

const session = new Session();
session.connect();
const post = <T>(m: string, p?: object) => new Promise<T>((res, rej) => session.post(m, p, (e: Error | null, r: unknown) => (e ? rej(e) : res(r as T))));
await post('HeapProfiler.enable');
const N = 4000, runs: { seed: number; bytesPerStep: number; top: string[] }[] = [];
// Then three fresh battles, each measured from its first step: the heaviest part of a battle is its opening.
for (const seed of [7, 11, 23]) {
  battle(seed);
  await post('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let i = 0; i < N; i++) step(s);
  const { profile } = await post<{ profile: { head: Node } }>('HeapProfiler.getSamplingProfile');
  await post('HeapProfiler.stopSampling');
  const sites = new Map<string, number>();
  let total = 0;
  const walk = (n: Node): void => {
    if (n.selfSize && n.callFrame.functionName && n.callFrame.functionName !== 'post') { total += n.selfSize; sites.set(n.callFrame.functionName, (sites.get(n.callFrame.functionName) || 0) + n.selfSize); }
    n.children.forEach(walk);
  };
  walk(profile.head);
  runs.push({ seed, bytesPerStep: total / N, top: [...sites.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${(v / N).toFixed(1)} B/step ${k}`) });
}
let live = 0;
for (let i = 0; i < s.n; i++) if (s.kind[i] !== 0) live++;
console.log(JSON.stringify({ worst: Math.max(...runs.map((r) => r.bytesPerStep)), steps: N, liveEntities: live, runs }));
process.exit(0);
