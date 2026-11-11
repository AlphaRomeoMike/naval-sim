// Spoken callouts: clips in public/voice/<station>/<id>.m4a (made by scripts/make-voice.mjs), played back to back.
const q: string[][] = [];
const cache = new Map<string, HTMLAudioElement>();
let gen = 0, playing = false, cur: HTMLAudioElement | null = null, done: (() => void) | null = null;
let on = (() => { try { return localStorage.getItem('voice') !== '0'; } catch { return true; } })();

function clip(c: string): HTMLAudioElement {
  let a = cache.get(c);
  if (!a) { a = new Audio(`voice/${c}.m4a`); a.preload = 'auto'; cache.set(c, a); }
  return a;
}
function play(a: HTMLAudioElement): Promise<void> {
  return new Promise((r) => {
    cur = a; done = r; a.currentTime = 0;
    a.onended = () => r(); a.onerror = () => r();
    a.play().catch(() => r()); // blocked before the first click, or a missing clip: skip it
  });
}
async function run(): Promise<void> {
  if (playing) return;
  playing = true;
  while (q.length) { const g = gen; for (const c of q.shift()!) { if (g !== gen) break; await play(clip(c)); } }
  playing = false; cur = null;
}

/** Queue a callout. Urgent ones go next; routine ones are dropped while a backlog builds up (fast time). */
export function say(clips: string[], urgent = false): void {
  if (!on) return;
  if (urgent) q.unshift(clips); else if (q.length < 2) q.push(clips); else return;
  run();
}
/** "bearing two seven zero" in the station's voice; nothing when the bearing is unknown (deg < 0). */
export function bearing(station: string, deg: number): string[] {
  return deg < 0 ? [] : [`${station}/bearing`, ...String(deg).padStart(3, '0').split('').map((d) => `${station}/${d}`)];
}
export function hush(): void { gen++; q.length = 0; cur?.pause(); done?.(); } // a paused clip never ends: release the player
export function toggleVoice(): boolean {
  on = !on;
  try { localStorage.setItem('voice', on ? '1' : '0'); } catch { /* private mode: setting lasts this visit */ }
  if (!on) hush();
  return on;
}
