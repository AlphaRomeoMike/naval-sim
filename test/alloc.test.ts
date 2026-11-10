// "Nothing allocated per tick": sample the heap while a busy 500-unit battle steps and add up what was allocated.
// Measured on a production-style bundle run on its own (see scripts/alloc-driver.ts for why).
import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIMIT = 400; // bytes per step, worst of three 500-unit battles from tick 0 (measured 20 to 160 depending on how V8 compiles the run)

// Skipped on CI runners: like the perf script, the number depends on the machine and the V8 build.
test.skipIf(!!process.env.CI)('the sim step allocates (almost) nothing on the JS heap', () => {
  const out = mkdtempSync(join(tmpdir(), 'alloc-'));
  execFileSync('npx', ['vite', 'build', '--ssr', 'scripts/alloc-driver.ts', '--outDir', out, '--logLevel', 'error'], { stdio: 'pipe' });
  const r = JSON.parse(execFileSync('node', [join(out, 'alloc-driver.js')], { encoding: 'utf8' }).trim().split('\n').pop()!);
  console.log(`sim allocation, worst of ${r.runs.length} battles measured from their first step: ${r.worst.toFixed(1)} bytes per step\n` +
    r.runs.map((x: { seed: number; bytesPerStep: number; top: string[] }) => `  seed ${x.seed}: ${x.bytesPerStep.toFixed(1)} B/step (${x.top.join(', ')})`).join('\n'));
  expect(r.liveEntities).toBeGreaterThan(300);
  // What this can and cannot promise: the sim creates no objects, arrays or closures per step, and code V8 has
  // optimised allocates nothing. Code V8 has not yet optimised boxes its floating-point temporaries, so a
  // battle's rarely-run paths (one unit's decision every 8 s, a launch) show up as tens of bytes per step, at
  // times low hundreds. A per-step allocation in a hot loop shows as kilobytes: 1.3 KB and
  // 5.6 KB per step were both caught by this test.
  expect(r.worst).toBeLessThan(LIMIT);
});
