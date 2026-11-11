// Data rules from the brief: sources, references, tier separation, and the fact-checked exclusions.
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { compileDb } from '../src/sim/sim';
import type { TierData } from '../src/sim/types';

const load = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as TierData;
const free = load('public/data/free.json');
// The paid tiers are premium assets kept outside git (premium/). Their checks run where the files exist.
const PREMIUM = existsSync('premium/packs/us-late.json') && existsSync('premium/packs/ussr-late.json');
const empty: TierData = { note: 'game values', weapons: {}, buoys: {}, units: {} };
const us = PREMIUM ? load('premium/packs/us-late.json') : empty, su = PREMIUM ? load('premium/packs/ussr-late.json') : empty;
const TRADEMARKS = /tomcat|hornet|seahawk|seasprite|phantom/i;
const strip = (t: TierData) => JSON.stringify(t, (k, v) => (k === 'src' ? undefined : v)); // URLs are exempt

describe('repository', () => {
  test('nothing private is tracked by git', () => {
    const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    // This repository is public, so tracked files are an allow-list, not a block-list: a new file has to be
    // added here on purpose. Data files are named one by one; code is allowed by folder and extension.
    const ALLOWED = new RegExp('^(' + [
      '\\.env\\.example', '\\.gitignore', 'README\\.md', 'index\\.html', 'package(-lock)?\\.json', 'tsconfig\\.json', 'vite\\.config\\.ts',
      '\\.github/workflows/deploy\\.yml', 'data-src/(us|ussr)-free\\.json',
      'public/(data/free\\.json|icon\\.svg|manifest\\.webmanifest|og\\.png|robots\\.txt|sitemap\\.xml|google[0-9a-f]+\\.html|map/(depth\\.png|land-50m\\.json)|voice/[a-z]+/[\\w-]+\\.m4a)',
      'scripts/[\\w-]+\\.(mjs|ts)', 'src/(sim/)?[\\w-]+\\.ts', 'test/([\\w-]+(\\.test)?\\.ts|fixture\\.json)',
    ].join('|') + ')$');
    expect(tracked.filter((f) => !ALLOWED.test(f))).toEqual([]);
    // the free tier holds exactly the free roster, so a paid unit cannot ride along inside an allowed file
    expect(Object.keys(free.units).sort()).toEqual(['airbase', 'cv', 'f4j', 'ffg7e', 'foxtrot', 'kashin', 'krivak1', 'merchant', 'permit', 'sh2f', 'sturgeon', 'tu16', 'victor1']);
    // and no tracked file carries a paid unit's data: the paid ids never appear as JSON keys with a body
    if (PREMIUM) {
      const ids = [...Object.keys(us.units), ...Object.keys(su.units)];
      for (const f of tracked.filter((x) => /\.json$/.test(x) && existsSync(x))) {
        const text = readFileSync(f, 'utf8');
        for (const id of ids) expect(new RegExp(`"${id}"\\s*:\\s*\\{`).test(text), `${f} holds data for ${id}`).toBe(false);
      }
    }
  });
});

describe('unit data', () => {
  test('every unit, weapon and buoy cites a source URL and the file says the numbers are game values', () => {
    for (const t of [free, us, su]) {
      expect(t.note).toMatch(/game values/i);
      for (const group of [t.units, t.weapons, t.buoys]) for (const [id, e] of Object.entries(group)) expect((e as { src: string }).src, id).toMatch(/^https:\/\//);
    }
  });
  test('all references resolve, and each pack loads on top of the free tier', () => {
    for (const pack of [[], [us], [su], [us, su]]) {
      const db = compileDb(free, ...pack);
      for (const u of db.units) {
        for (const h of u.hosts) expect(db.u[h], `${u.id} host ${h}`).toBeDefined();
        for (const c of u.d.carries || []) expect(db.u[c], `${u.id} carries ${c}`).toBeDefined();
        for (const b of Object.keys(u.d.buoys || {})) expect(db.b[b], `${u.id} buoy ${b}`).toBeDefined();
        expect(u.d.mounts.length).toBeLessThanOrEqual(8);
        expect(u.d.pd.length).toBeLessThanOrEqual(4);
      }
    }
  });
  test('the free tier contains no paid unit, weapon or buoy, by id or by name', () => {
    const text = JSON.stringify(free);
    for (const pack of [us, su]) {
      for (const group of [pack.units, pack.weapons, pack.buoys]) for (const [id, e] of Object.entries(group)) {
        expect(free.units[id] || free.weapons[id] || free.buoys[id], id).toBeUndefined();
        expect(text.includes(`"${id}"`), `free data mentions paid id ${id}`).toBe(false);
        expect(text.includes(`"${(e as { name: string }).name}"`), `free data mentions ${(e as { name: string }).name}`).toBe(false);
      }
    }
  });
  test('free roster matches the brief', () => {
    const has = (t: TierData, ...ids: string[]) => ids.forEach((id) => expect(t.units[id], id).toBeDefined());
    has(free, 'ffg7e', 'sh2f', 'f4j', 'permit', 'sturgeon', 'kashin', 'krivak1', 'foxtrot', 'victor1', 'tu16');
    const lo = (t: TierData, id: string) => Object.values(t.units[id].loadouts || {}).flat().map((i) => i.w);
    const mounts = (t: TierData, id: string) => t.units[id].mounts.map((m) => m.w);
    expect(mounts(free, 'ffg7e')).toEqual(expect.arrayContaining(['sm1mr', 'harpoon', 'mk75']));
    expect(free.units.ffg7e.fc).toBe(2);
    expect(free.units.ffg7e.deck!.slots).toBe(1);
    expect(free.units.ffg7e.sonar!.some((s) => s.towed)).toBe(false);
    expect(Object.keys(free.units.sh2f.buoys!).sort()).toEqual(['dicass', 'difar']);
    expect(new Set(lo(free, 'f4j'))).toEqual(new Set(['aim7e', 'aim7f', 'aim9h', 'agm45', 'mk82', 'mk83', 'mk84']));
    expect(mounts(free, 'permit')).toEqual(expect.arrayContaining(['mk48', 'mk37', 'subroc']));
    expect(mounts(free, 'sturgeon')).toEqual(expect.arrayContaining(['mk48', 'mk37', 'subroc', 'harpoon']));
    expect(new Set(lo(free, 'tu16'))).toEqual(new Set(['as5', 'as6']));
  });
  test.skipIf(!PREMIUM)('paid roster matches the brief (needs premium/)', () => {
    const has = (t: TierData, ...ids: string[]) => ids.forEach((id) => expect(t.units[id], id).toBeDefined());
    has(us, 'ffg7l', 'ffgup', 'sh60b', 'f14a', 'fa18c', 'la2', 'la688i');
    has(su, 'sovremenny', 'slava', 'akula', 'tu22m3');
    const lo = (t: TierData, id: string) => Object.values(t.units[id].loadouts || {}).flat().map((i) => i.w);
    const mounts = (t: TierData, id: string) => t.units[id].mounts.map((m) => m.w);
    expect(us.units.ffg7l.sonar!.some((s) => s.towed)).toBe(true);
    expect(us.units.ffg7l.deck!.slots).toBe(2);
    expect(us.units.ffg7l.pd.some((p) => /phalanx/i.test(p.name))).toBe(true);
    expect(mounts(us, 'ffgup')).toEqual(expect.arrayContaining(['sm2mr', 'essm']));
    expect(us.units.ffgup.name).toMatch(/Adelaide/);
    expect(Object.keys(us.units.sh60b.buoys!).sort()).toEqual(['dicass', 'difar', 'vlad']);
    expect(us.units.sh60b.link).toBe(true);
    expect(new Set(lo(us, 'sh60b'))).toEqual(new Set(['mk46', 'mk50', 'penguin']));
    expect(new Set(lo(us, 'f14a'))).toEqual(new Set(['aim54a', 'aim7m', 'aim9m']));
    expect(new Set(lo(us, 'fa18c'))).toEqual(new Set(['aim120', 'agm88', 'agm84', 'gbu10', 'gbu12', 'gbu16', 'gbu31', 'gbu32', 'gbu38']));
    for (const id of ['la2', 'la688i']) {
      expect(mounts(us, id)).toEqual(expect.arrayContaining(['mk48adcap', 'harpoon', 'tasm', 'tlam']));
      expect(us.units[id].mounts.filter((m) => m.w === 'tasm' || m.w === 'tlam').reduce((n, m) => n + m.n, 0)).toBe(12); // 12 VLS cells
      expect(us.units[id].sonar!.some((s) => s.towed)).toBe(true);
    }
    expect(new Set(lo(su, 'tu22m3'))).toEqual(new Set(['as4']));
  });
  test('fact-checked exclusions: no AIM-120 on the F-14, no AIM-47, no GBU-34, no RAM on a Perry', () => {
    const all = JSON.stringify([free, us, su]);
    expect(all).not.toMatch(/aim-?47|gbu-?34/i);
    if (PREMIUM) expect(JSON.stringify(us.units.f14a)).not.toMatch(/aim-?120/i);
    for (const id of ['ffg7e', 'ffg7l', 'ffgup']) if (free.units[id] || us.units[id]) expect(JSON.stringify((free.units[id] || us.units[id]))).not.toMatch(/\bram\b|rim-?116/i);
  });
  test('no manufacturer trademarks in any name', () => {
    for (const t of [free, us, su]) expect(strip(t)).not.toMatch(TRADEMARKS);
  });
});
