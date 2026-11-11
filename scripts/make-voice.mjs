// Generates the voice callout clips into public/voice/<station>/<id>.m4a with macOS `say`.
// Usage: node scripts/make-voice.mjs   (macOS only; re-run after editing the lists below)
// Pacing: urgent alert words at 200 wpm, detail at 160 wpm, digits at 220 wpm. A game callout chains clips:
//   air/vampire + air/bearing + air/2 + air/7 + air/0  ->  "Vampire vampire vampire, bearing two seven zero"
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';

const URGENT = 200, DETAIL = 160, DIGIT = 220; // digits read fast so a bearing does not drag
const OUT = new URL('../public/voice/', import.meta.url).pathname;

// station -> voice. Each station also gets "bearing", "range", "miles" and the digits 0-9.
const VOICES = { air: 'Daniel', sonar: 'Ralph', ew: 'Rocko (English (US))', conn: 'Daniel' };

// [station, id, rate, text]
const PHRASES = [
  // air warfare / radar
  ['air', 'vampire', URGENT, 'Vampire vampire vampire'],
  ['air', 'bandit', URGENT, 'Bandit bandit'],
  ['air', 'bogey', DETAIL, 'New air contact, bogey'],
  ['air', 'surface-contact', DETAIL, 'New surface contact'],
  ['air', 'splash', URGENT, 'Splash'],
  ['air', 'contact-lost', DETAIL, 'Radar contact lost'],
  ['air', 'missile-away', DETAIL, 'Missile away'],
  ['air', 'hostile-launch', URGENT, 'Hostile launch detected'],
  ['air', 'bingo', DETAIL, 'Aircraft bingo fuel, returning to base'],
  // sonar
  ['sonar', 'torpedo', URGENT, 'Torpedo torpedo torpedo'],
  ['sonar', 'torpedo-in-water', URGENT, 'Torpedo in the water!'],
  ['sonar', 'conn-sonar', URGENT, 'Conn, Sonar'],
  ['sonar', 'sonar-contact', DETAIL, 'New sonar contact'],
  ['sonar', 'contact-lost', DETAIL, 'Sonar contact lost'],
  ['sonar', 'torpedo-away', DETAIL, 'Torpedo away'],
  ['sonar', 'high-speed-screws', DETAIL, 'High speed screws, closing'],
  // electronic warfare
  ['ew', 'spike', URGENT, 'Spike spike'],
  ['ew', 'radar-lock', DETAIL, 'Fire control radar'],
  // conn / commander replies, played when the player acts
  ['conn', 'aye', URGENT, 'Conn, aye'],
  ['conn', 'flank', DETAIL, 'All ahead flank'],
  ['conn', 'countermeasures', DETAIL, 'Launch countermeasures'],
  ['conn', 'weapons-free', DETAIL, 'Weapons free'],
  ['conn', 'hit', URGENT, 'We have been hit!'],
  ['conn', 'aground', URGENT, 'Shoal water ahead, all stop'],
  ['conn', 'target-destroyed', DETAIL, 'Target destroyed'],
];

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
for (const st of Object.keys(VOICES)) {
  PHRASES.push([st, 'bearing', DETAIL, 'bearing'], [st, 'range', DETAIL, 'range'], [st, 'miles', DETAIL, 'miles']);
  DIGITS.forEach((w, d) => PHRASES.push([st, String(d), DIGIT, w]));
}

if (process.platform !== 'darwin') { console.error('make-voice needs macOS `say`.'); process.exit(1); }
rmSync(OUT, { recursive: true, force: true }); // stale clips from removed phrases would otherwise linger

for (const [st, id, rate, text] of PHRASES) {
  if (!VOICES[st]) throw new Error(`no voice for station ${st}`);
  mkdirSync(OUT + st, { recursive: true });
  execFileSync('say', ['-v', VOICES[st], '--file-format=m4af', '--data-format=aac', '-o', `${OUT}${st}/${id}.m4a`, `[[rate ${rate}]] ${text}`]);
  process.stdout.write('.');
}

const made = Object.keys(VOICES).reduce((n, st) => n + readdirSync(OUT + st).length, 0);
if (made !== PHRASES.length) throw new Error(`expected ${PHRASES.length} clips, made ${made}`); // a duplicate id overwrote another
console.log(`\n${made} clips in public/voice/`);
