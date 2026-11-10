// Assemble the shipped data files from the researched per-side, per-tier sources.
//   public/data/free.json          free tier, both sides  -> part of the free build, from data-src/
//   premium/packs/us-late.json     paid tier, US          -> only if premium/data-src/ exists (it is not in git)
//   premium/packs/ussr-late.json   paid tier, Soviet      -> uploaded to the worker's D1 with `npm run packs:upload`
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const load = (p) => JSON.parse(readFileSync(root + p, 'utf8'));
const note = 'Game values: simplified static numbers derived from the public pages in each src field. Not real performance data.';
const merge = (...t) => ({ note, weapons: Object.assign({}, ...t.map((x) => x.weapons)), buoys: Object.assign({}, ...t.map((x) => x.buoys)), units: Object.assign({}, ...t.map((x) => x.units)) });
mkdirSync(`${root}public/data`, { recursive: true });
writeFileSync(`${root}public/data/free.json`, JSON.stringify(merge(load('data-src/us-free.json'), load('data-src/ussr-free.json'))));
console.log('wrote public/data/free.json');
if (existsSync(`${root}premium/data-src/us-paid.json`)) {
  mkdirSync(`${root}premium/packs`, { recursive: true });
  writeFileSync(`${root}premium/packs/us-late.json`, JSON.stringify(merge(load('premium/data-src/us-paid.json'))));
  writeFileSync(`${root}premium/packs/ussr-late.json`, JSON.stringify(merge(load('premium/data-src/ussr-paid.json'))));
  console.log('wrote premium/packs/us-late.json, premium/packs/ussr-late.json');
} else console.log('premium/data-src/ not present: paid packs not built (the free game does not need them)');
