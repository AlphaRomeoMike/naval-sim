// DOM side of the game: unit card, event log, dialogs and the keyboard map.
import {
  SNAP_HDR, SNAP_REC, K_SHIP, K_SUB, K_AIR, K_BASE, K_WPN, K_BUOY, F_RADAR, F_ACTIVE, F_WFREE, F_STOWED, F_RTB,
  D_SENSORS, D_PROP, D_WEAPONS, D_DECK,
  O_SPEED, O_ALT, O_RADAR, O_SONAR, O_WFREE, O_STOP, O_FIRE, O_LAUNCH, O_RTB, O_BUOY,
  E_CONTACT, E_LOST, E_LAUNCH, E_HIT, E_MISS, E_KILL, E_PD, E_AGROUND, E_AIROP, E_BINGO, E_BUOY, E_DISABLED, E_END, E_NOGUIDE,
  type Save,
} from './sim/sim';
import { G, scene, view, order, select, setTarget, setSpeed, startScenario, requestSave, invalidate, pan, zoomAt, centerOn, find, moveTo } from './main';
import { SCENARIOS } from './scenarios';
import { showStore } from './store';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const SPEEDS = [0, 1, 2, 4, 8, 16, 32, 64];
const KIND: Record<number, string> = { [K_SHIP]: 'surface ship', [K_SUB]: 'submarine', [K_AIR]: 'aircraft', [K_BASE]: 'base', [K_WPN]: 'weapon', [K_BUOY]: 'buoy' };
const DENY: Record<number, string> = {
  1: 'Order not possible.', 2: 'No rounds left.', 3: 'Still reloading.', 4: 'No firing solution: this unit needs its own track or a datalinked one.',
  5: 'Target is outside the weapon\'s range.', 6: 'This weapon cannot reach the target\'s altitude or depth.', 7: 'All fire-control channels are busy.',
  8: 'Weapons are disabled by damage.', 9: 'Target radar is not emitting.', 10: 'GPS weapons need a stationary target.', 11: 'Aircraft is not airborne.',
  12: 'Target is below this unit\'s radar horizon.', 13: 'Flight deck is disabled.', 14: 'Deck is busy; wait for the launch interval.',
  15: 'Aircraft is still being turned around.', 16: 'No buoys of that type left.', 17: 'No deck available to recover on.',
};
let buoyDeep = false, lastHtml = '', pointerOnPanel = false, pendingHtml: string | null = null, dlgPaused = false;

export function initUi(): void {
  $('speed').innerHTML = SPEEDS.map((s) => `<button data-s="${s}" aria-label="${s ? s + ' times speed' : 'Pause'}">${s ? s + '×' : '⏸'}</button>`).join('');
  $('speed').addEventListener('click', (e) => { const s = (e.target as HTMLElement).dataset.s; if (s !== undefined) setSpeed(Number(s)); });
  $('menuBtn').addEventListener('click', showMenu);
  // After a mouse or touch press (detail > 0; a keyboard activation has 0) hand the keyboard back to the map,
  // or Space and Enter would press that button again instead of pausing or setting a course.
  document.addEventListener('click', (e) => { if (e.detail && (e.target as HTMLElement).closest('#bar button, #panel button')) $('map').focus(); });
  // A dialog pauses a running battle; closing it (button or Esc) resumes, unless it was reopened or a new battle began.
  const dlg = $<HTMLDialogElement>('dlg');
  dlg.addEventListener('close', () => { if (dlg.open) return; if (dlgPaused && G.live && G.paused) setSpeed(G.speed); dlgPaused = false; });
  const panel = $('panel');
  panel.addEventListener('pointerdown', () => { pointerOnPanel = true; });
  const release = () => { pointerOnPanel = false; if (pendingHtml !== null) setPanel(pendingHtml); };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release); // a touch that turned into a scroll
  panel.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (b) act(b.dataset.act!, Number(b.dataset.v ?? 0), b);
  });
  panel.addEventListener('change', (e) => {
    const t = e.target as HTMLSelectElement;
    if (t.dataset.lo !== undefined) loadoutPick[Number(t.dataset.lo)] = Number(t.value);
  });
}

// ---------- unit card ----------
const loadoutPick: Record<number, number> = {};
/** Forget per-battle UI choices. */
export function resetUi(): void { for (const k in loadoutPick) delete loadoutPick[k]; lastHtml = ''; buoyDeep = false; tutCourse = tutClock = tutFired = false; dlgPaused = false; }
/** One line in the on-screen log, for messages that are not sim events. */
export function notify(text: string): void { line(text, 'warn'); }
function setPanel(html: string): void {
  const panel = $('panel');
  if (pointerOnPanel) { pendingHtml = html; return; } // never swap buttons out from under a press
  pendingHtml = null;
  if (html === lastHtml) return;
  lastHtml = html;
  const key = (document.activeElement as HTMLElement | null)?.dataset?.k;
  panel.hidden = !html;
  panel.innerHTML = html;
  if (key) ((panel.querySelector(`[data-k="${key}"]`) as HTMLElement | null) ?? $('map')).focus(); // never leave focus on nothing
}

function distTo(id: number): number {
  const a = find(scene.sel), b = find(id);
  if (a < 0 || b < 0 || !scene.snap || scene.snap[b + 10] < 2) return -1;
  return Math.hypot(scene.snap[a + 4] - scene.snap[b + 4], scene.snap[a + 5] - scene.snap[b + 5]);
}

export function renderPanel(): void {
  tutorialTick();
  const i = scene.info;
  if (!i || scene.sel < 0 || !G.db) { setPanel(''); return; }
  const btn = (act: string, v: number, label: string, on = false, dis = false, title = '') =>
    `<button data-act="${act}" data-v="${v}" data-k="${act}${act === 'radar' || act === 'sonar' || act === 'wfree' ? '' : v}"${on ? ' class="on" aria-pressed="true"' : ''}${dis ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
  let h = `<h2>${esc(i.name)}</h2>`;
  if (!i.own) {
    h += `<div class="kv">${i.level === 2 ? 'Hostile track' : i.level === 1 ? 'Bearing only' : 'Last known position'} · ${KIND[i.kind]}</div>`;
    if (i.level === 2) h += `<div class="kv"><b>${i.kts.toFixed(0)}</b> kts · ${i.alt < 0 ? 'depth <b>' + (-i.alt).toFixed(0) : 'altitude <b>' + i.alt.toFixed(0)}</b> m</div>`;
    setPanel(h);
    return;
  }
  const u = G.db.units[G.db.u[i.type]], d = u.d, air = i.kind === K_AIR, sub = i.kind === K_SUB, stowed = (i.flags & F_STOWED) !== 0;
  h += `<div class="kv">${esc(d.name)} · <b>${i.kts.toFixed(0)}</b> kts` +
    (air ? ` · alt <b>${i.alt.toFixed(0)}</b> m · fuel <b>${i.fuelMin.toFixed(0)}</b> min` : sub ? ` · depth <b>${(-i.alt).toFixed(0)}</b> m` : '') +
    (air ? '' : ` · sea floor ${i.depth.toFixed(0)} m`) + `</div>`;
  h += `<div class="hpbar" role="img" aria-label="Hull ${Math.round((100 * i.hp) / i.maxHp)} percent"><i style="width:${Math.max(0, (100 * i.hp) / i.maxHp)}%"></i></div>`;
  const dis = [[D_SENSORS, 'sensors'], [D_PROP, 'propulsion'], [D_WEAPONS, 'weapons'], [D_DECK, 'flight deck']].filter((x) => i.dis & (x[0] as number)).map((x) => x[1]);
  if (dis.length) h += `<div class="kv bad">Disabled: ${dis.join(', ')}</div>`;
  if (G.lastDeny) h += `<div class="kv bad" role="alert">${esc(DENY[Number(G.lastDeny)] || DENY[1])}</div>`;
  if (stowed) { h += `<div class="kv">On deck. Select the ship to launch.</div>`; setPanel(h); return; }
  if (i.kind !== K_BASE) {
    h += `<h3>Helm</h3><div class="row">`;
    const sp = air && d.cls === 'air' ? [d.cruiseKts, d.kts] : [0, Math.round(d.kts / 3), d.cruiseKts, d.kts];
    const names = air && d.cls === 'air' ? ['Cruise', 'Full'] : ['Stop', 'Slow', 'Cruise', 'Full'];
    sp.forEach((k, n) => { h += btn('spd', k, names[n], Math.abs(i.ordKts - k) < 0.5); });
    h += btn('move', 0, 'Set course (W)', G.moveMode) + btn('halt', 0, 'Clear course') + `</div>`;
    if (air) {
      const alts = [...new Set([i.minAlt, 300, 1500, 6000, i.maxAlt].filter((a) => a >= i.minAlt && a <= i.maxAlt))];
      h += `<div class="row" style="margin-top:4px">` + alts.map((a) => btn('alt', a, a + ' m', Math.abs(i.ordAlt - a) < 1)).join('') + btn('rtb', 0, 'Return (B)', (i.flags & F_RTB) !== 0) + `</div>`;
    } else if (sub) {
      const L = G.scn!.layerM, ds = [[-15, 'Periscope'], [-(L - 30), 'Above layer'], [-(L + 50), 'Below layer'], [i.maxAlt, 'Deep']] as [number, string][];
      h += `<div class="row" style="margin-top:4px">` + ds.map((x) => btn('alt', x[0], x[1], Math.abs(i.ordAlt - x[0]) < 1)).join('') + `</div><div class="kv">Thermocline at ${L} m</div>`;
    }
  }
  h += `<h3>Sensors and doctrine</h3><div class="row">`;
  if (i.hasRadar) h += btn('radar', i.flags & F_RADAR ? 0 : 1, 'Radar (R)', (i.flags & F_RADAR) !== 0);
  if (i.hasActive) h += btn('sonar', i.flags & F_ACTIVE ? 0 : 1, 'Active sonar (O)', (i.flags & F_ACTIVE) !== 0);
  h += btn('wfree', i.flags & F_WFREE ? 0 : 1, 'Auto-defend (F)', (i.flags & F_WFREE) !== 0, false, 'Engage incoming missiles and aircraft automatically') + `</div>`;
  if (i.mounts.length) {
    const td = scene.tgt >= 0 ? distTo(scene.tgt) : -1;
    h += `<h3>Weapons${i.fc ? ` · channels ${i.fcUsed}/${i.fc}` : ''}</h3>`;
    h += `<div class="kv">${scene.tgt >= 0 ? `Target: <b>${esc(scene.unitName(scene.snap![find(scene.tgt) + 3]))}</b>${td >= 0 ? ` at <b>${td.toFixed(1)}</b> km` : ''}` : 'Pick a hostile track on the map as the target.'}</div>`;
    i.mounts.forEach((m, n) => {
      const ok = scene.tgt >= 0 && m.ammo > 0 && m.readyS === 0 && td >= m.minKm && td <= m.maxKm;
      h += `<div class="w"><span>${esc(m.name)} ×${m.ammo}<small>${m.minKm}–${m.maxKm} km${m.readyS ? ` · ready in ${Math.ceil(m.readyS)} s` : ''}</small></span>${btn('fire', m.m, `Fire (${n + 1})`, false, !ok)}</div>`;
    });
  }
  if (i.pd.length) h += `<div class="kv">Point defence: ${i.pd.map(esc).join(', ')}</div>`;
  if (i.buoys.length) {
    h += `<h3>Sonobuoys</h3><div class="row">` + i.buoys.map((b) => btn('buoy', b.b, `${esc(b.name)} ×${b.n}`, false, b.n === 0)).join('') +
      btn('deep', 0, buoyDeep ? 'Set: below layer' : 'Set: above layer', buoyDeep) + `</div>`;
  }
  if (i.hangar.length) {
    h += `<h3>Aircraft</h3>`;
    for (const a of i.hangar) {
      const lo = loadoutPick[a.id] ?? a.lo;
      const st = !a.stowed ? 'airborne' : a.readyS > 0 ? `ready in ${Math.ceil(a.readyS / 60)} min` : 'ready';
      h += `<div class="w"><span>${esc(a.name)}<small>${st}</small></span>`;
      if (a.stowed) {
        h += `<select data-lo="${a.id}" data-k="lo${a.id}" aria-label="Loadout for ${esc(a.name)}">${a.loadouts.map((l, n) => `<option value="${n}"${n === lo ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>` +
          btn('launch', a.id, 'Launch', false, a.readyS > 0);
      } else h += btn('pick', a.id, 'Select');
      h += `</div>`;
    }
  }
  setPanel(h);
}

function act(a: string, v: number, el: HTMLElement): void {
  const id = scene.sel;
  G.lastDeny = '';
  switch (a) {
    case 'spd': order(O_SPEED, id, v); break;
    case 'alt': order(O_ALT, id, v); break;
    case 'halt': order(O_STOP, id); break;
    case 'move': G.moveMode = !G.moveMode; G.cursor = null; renderPanel(); break;
    case 'radar': order(O_RADAR, id, v); break;
    case 'sonar': order(O_SONAR, id, v); break;
    case 'wfree': order(O_WFREE, id, v); break;
    case 'fire': if (scene.tgt >= 0) order(O_FIRE, id, v, scene.tgt); break;
    case 'rtb': order(O_RTB, id); break;
    case 'buoy': order(O_BUOY, id, v, buoyDeep ? 1 : 0); break;
    case 'deep': buoyDeep = !buoyDeep; renderPanel(); break;
    case 'launch': order(O_LAUNCH, v, loadoutPick[v] ?? Number((el.parentElement!.querySelector('select') as HTMLSelectElement).value)); break;
    case 'pick': select(v); centerOn(v); break;
  }
}

// ---------- event log ----------
function line(text: string, cls: string): void {
  const log = $('log'), li = document.createElement('li');
  li.textContent = text; li.className = cls;
  log.appendChild(li);
  while (log.children.length > 7) log.firstElementChild!.remove();
}
export function logEvents(s: Float32Array): void {
  const ne = s[3];
  if (!ne || !G.db) return;
  const me = scene.side, nm = (id: number) => G.labels[id] || 'Unit', un = (d: number) => G.db!.units[d]?.d.name || 'contact', wn = (d: number) => G.db!.weapons[d]?.d.name || 'weapon';
  // a target code is side << 16 | 0x8000 if it is a weapon | unit or weapon index
  const who = (a: number, c: number) => (c & 0x8000 ? wn(c & 0x7fff) : c >> 16 === me ? nm(a) : un(c & 0x7fff));
  for (let e = 0, p = SNAP_HDR + s[2] * SNAP_REC; e < ne; e++, p += 4) {
    const k = s[p], a = s[p + 1], b = s[p + 2], c = s[p + 3];
    switch (k) {
      case E_CONTACT: line(`New contact: ${KIND[c]}${b === 1 ? ' (bearing only)' : ''}`, 'foe'); break;
      case E_LOST: line(`Contact lost: ${KIND[c]}`, ''); break;
      case E_AGROUND: line(`${nm(a)} stopped: land or shoal water ahead`, 'warn'); break;
      case E_LAUNCH: line(c === me ? `${nm(a)} fired ${wn(b)}` : `Hostile launch detected: ${wn(b)}`, c === me ? 'own' : 'foe'); break;
      case E_HIT: line(`${wn(b)} ${c & 0x8000 ? 'shot down' : 'hit'} ${who(a, c)}`, c >> 16 === me ? 'foe' : 'own'); break;
      case E_MISS: line(`${wn(b)} missed ${who(a, c)}`, ''); break;
      case E_KILL: line(`${c >> 16 === me ? nm(a) : un(c & 0xffff)} destroyed`, c >> 16 === me ? 'foe' : 'own'); break;
      case E_PD: line(`${c >> 16 === me ? nm(a) + ' point defence' : 'Enemy point defence'} shot down ${wn(b)}`, c >> 16 === me ? 'own' : ''); break;
      case E_DISABLED: line(`${nm(a)}: ${['sensors', 'propulsion', 'weapons', 'flight deck'][b]} disabled`, 'warn'); break;
      case E_NOGUIDE: line(`${wn(b)} lost guidance`, ''); break;
      case E_AIROP: line(`${nm(a)} ${['launched', 'recovered', 'ditched: out of fuel'][b]}`, b === 2 ? 'warn' : 'own'); break;
      case E_BINGO: line(`${nm(a)} is low on fuel and returning`, 'warn'); break;
      case E_BUOY: line(`${nm(a)} dropped a ${G.db.buoys[b]?.d.name || 'buoy'}`, 'own'); break;
      case E_END: break;
    }
  }
}

// ---------- dialogs ----------
/** Put keyboard focus on the dialog's main control. Replacing a dialog's content drops focus, and the
 *  autofocus attribute only works when the dialog is first opened. */
export function focusDialog(d: HTMLElement): void {
  (d.querySelector('[autofocus]') as HTMLElement | null || d.querySelector('button:not([disabled]), input, select') as HTMLElement | null)?.focus();
}
function dialog(html: string): HTMLDialogElement {
  const d = $<HTMLDialogElement>('dlg');
  delete d.dataset.view; d.onchange = null;
  d.innerHTML = html;
  if (!d.open) {
    if (G.live && !G.paused && G.winner < 0) { dlgPaused = true; setSpeed(0); } // the battle waits while a dialog is up
    d.showModal();
  }
  focusDialog(d);
  return d;
}
export function closeDialog(): void { const d = $<HTMLDialogElement>('dlg'); if (d.open) d.close(); $('map').focus(); }

export function showMenu(): void {
  const hasSave = !!localStorage.getItem('save');
  const d = dialog(`<h1>Flag Plot</h1><p>A light Cold War naval tactics game. Pick a scenario.</p>
    <div class="list">${SCENARIOS.map((s, n) => ({ s, n })).sort((a, b) => Number(b.s.id === 'tutorial') - Number(a.s.id === 'tutorial'))
      .map(({ s, n }) => `<button data-scn="${n}"><b>${esc(s.name)}</b><small>${esc(s.brief.split('\n')[0])}</small></button>`).join('')}</div>
    <div class="foot">
      <button data-m="save"${G.live ? '' : ' disabled'}>Save game</button><button data-m="load"${hasSave ? '' : ' disabled'}>Load game</button>
      <button data-m="store">Unit packs</button><button data-m="help">Help</button><button data-m="about">Credits</button>
      ${G.live ? '<button data-m="close">Resume</button>' : ''}</div>`);
  d.onclick = async (e) => {
    const t = (e.target as HTMLElement).closest('button');
    if (!t) return;
    if (t.dataset.scn !== undefined) showBrief(Number(t.dataset.scn));
    else if (t.dataset.m === 'save') { localStorage.setItem('save', JSON.stringify(await requestSave())); closeDialog(); line('Game saved', 'own'); }
    else if (t.dataset.m === 'load') loadGame();
    else if (t.dataset.m === 'help') showHelp();
    else if (t.dataset.m === 'about') showAbout();
    else if (t.dataset.m === 'store') showStore(showMenu);
    else if (t.dataset.m === 'close') closeDialog();
  };
}

export function loadGame(): void {
  const raw = localStorage.getItem('save');
  if (!raw) return;
  const save = JSON.parse(raw) as Save, scn = SCENARIOS.find((s) => s.id === save.scn);
  if (!scn) { line('Saved scenario is not available', 'warn'); return; }
  // A save replays exactly only with the units it was played with. If a fitted unit's pack is no longer on this
  // device (refund, cleared storage), refuse rather than quietly swap in other units.
  const have = new Set(G.tiers.flatMap((t) => Object.keys(t.units)));
  if (Object.values(save.fit || {}).some((id) => !have.has(id))) {
    closeDialog(); showMenu();
    line('This save uses units from a pack that is not unlocked on this device. Restore the pack to load it.', 'warn');
    return;
  }
  closeDialog();
  startScenario(scn, { side: save.side, ai: save.ai, seed: save.seed, fit: save.fit, save });
  line('Game loaded', 'own');
}

function showBrief(n: number): void {
  const scn = SCENARIOS[n], db = G.db || null;
  let side = 0;
  const fit: Record<number, string> = {};
  const render = () => {
    // fit-out: the player's own slots may be swapped for owned units of the same role; the enemy never changes
    let slots = '', slot = 0;
    const all = G.tiers.flatMap((t) => Object.entries(t.units));
    const row = (type: string, host?: string) => {
      const cur = all.find((x) => x[0] === type)![1];
      const hostDef = host ? all.find((x) => x[0] === host)![1] : null;
      const opts = all.filter((x) => x[1].side === cur.side && x[1].role === cur.role && (!host || (x[1].hosts || []).includes(host) || (hostDef!.carries || []).includes(x[0])));
      const my = slot++;
      if ((cur.side === 'us' ? 0 : 1) !== side || opts.length < 2) return;
      slots += `<label class="kv" style="display:block;margin:4px 0">${esc(cur.name)} → <select data-slot="${my}">${opts.map((o) => `<option value="${esc(o[0])}"${(fit[my] || type) === o[0] ? ' selected' : ''}>${esc(o[1].name)}</option>`).join('')}</select></label>`;
    };
    for (const u of scn.units) { const t = fit[slot] || u.type; row(u.type); for (const a of u.air || []) row(a.type, t); }
    const tut = scn.id === 'tutorial';
    const d = dialog(`<h1>${esc(scn.name)}</h1>${scn.brief.split('\n').map((p) => `<p>${esc(p)}</p>`).join('')}
      ${tut ? '' : `<h2>Play as</h2><div class="row" style="display:flex;gap:6px"><button data-side="0"${side === 0 ? ' class="on"' : ''}>US Navy</button><button data-side="1"${side === 1 ? ' class="on"' : ''}>Soviet Navy</button></div>`}
      ${slots && !tut ? `<h2>Fit out</h2>${slots}` : ''}
      <div class="foot"><button data-m="back">Back</button><button data-m="go" autofocus>Start</button></div>`);
    d.onclick = (e) => {
      const t = (e.target as HTMLElement).closest('button');
      if (!t) return;
      if (t.dataset.side !== undefined) { side = Number(t.dataset.side); for (const k in fit) delete fit[k]; render(); ($('dlg').querySelector(`[data-side="${side}"]`) as HTMLElement).focus(); }
      else if (t.dataset.m === 'back') showMenu();
      else if (t.dataset.m === 'go') {
        closeDialog();
        // Paused, no enemy AI: the hints set the pace. A fixed seed so every first battle goes the same way
        // (with this one a lone first Harpoon gets through the Krivak's guns and hits; test/scenarios.test.ts).
        if (scn.id === 'tutorial') startScenario(scn, { side: 0, ai: 0, seed: 2 });
        else { startScenario(scn, { side, fit }); setSpeed(1); }
      }
    };
    d.onchange = (e) => { const t = e.target as HTMLSelectElement; if (t.dataset.slot !== undefined) { fit[Number(t.dataset.slot)] = t.value; render(); ($('dlg').querySelector(`[data-slot="${t.dataset.slot}"]`) as HTMLElement | null)?.focus(); } };
  };
  void db;
  render();
}

export function showResult(w: number): void {
  const me = scene.side;
  const d = dialog(`<h1>${w === 2 ? 'Draw' : w === me ? 'Victory' : 'Defeat'}</h1><p>${w === 2 ? 'Both sides lost their objectives.' : w === me ? 'You achieved the objective.' : 'The enemy achieved their objective.'}</p>
    <div class="foot"><button data-m="view">View the map</button><button data-m="menu" autofocus>Menu</button></div>`);
  d.onclick = (e) => { const m = ((e.target as HTMLElement).closest('button') as HTMLElement | null)?.dataset.m; if (m === 'menu') showMenu(); else if (m === 'view') closeDialog(); };
}

const KEYS: [string, string][] = [
  ['Arrow keys', 'Pan the map (move the course cursor while setting a course)'], ['+ / −', 'Zoom'], ['Space', 'Pause / resume'], [', / .', 'Slower / faster time'],
  ['N / P', 'Next / previous own unit'], ['T / Shift+T', 'Next / previous hostile track as target'], ['I', 'Show the targeted contact (N returns to your units)'], ['C', 'Centre on the selected unit'],
  ['W, then arrows, Enter', 'Set course with the cursor (Shift+Enter adds a waypoint, Esc cancels)'], ['Delete', 'Clear the course (stop)'], ['S / X', 'Speed up / down'], ['A / Z', 'Climb or come shallower / descend or go deeper'],
  ['R / O / F', 'Radar / active sonar / auto-defend on or off'], ['1 – 8', 'Fire weapon 1–8 at the target'], ['L', 'Launch the next ready aircraft'], ['B', 'Aircraft: return to its deck'],
  ['D / E / V', 'Drop sonobuoy type 1 / 2 / 3 (hold Shift to set it below the layer)'], ['Q / Y', 'Quick save / quick load'], ['M', 'Menu'], ['H or ?', 'This help'], ['Esc', 'Close a dialog or clear the selection'],
];
export function showHelp(): void {
  const d = dialog(`<h1>How to play</h1>
    <p><b>Mouse:</b> click one of your units to select it, click a hostile track to target it, right-click the sea to set a course (Shift adds a waypoint), drag to pan, wheel to zoom.</p>
    <p><b>Touch:</b> tap to select or target, press and hold the sea to set a course, drag to pan, pinch to zoom.</p>
    <p>New here? Start with <b>Tutorial: First Watch</b> in the menu. The game also works offline once it has loaded.</p>
    <h2>Keyboard</h2><table class="keys">${KEYS.map((k) => `<tr><td><kbd>${esc(k[0])}</kbd></td><td>${esc(k[1])}</td></tr>`).join('')}</table>
    <div class="foot"><button data-m="x" autofocus>Close</button></div>`);
  d.onclick = (e) => { if ((e.target as HTMLElement).closest('button')) (G.live ? closeDialog : showMenu)(); };
}
function showAbout(): void {
  const d = dialog(`<h1>Credits</h1>
    <p>Coastlines: made with <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a> 1:50m land (public domain), via the world-atlas TopoJSON build.</p>
    <p>Sea depth: derived from the GEBCO_2021 Grid, GEBCO Compilation Group (2021), doi:10.5285/c6612cbe-50b3-0cff-e053-6c86abc09f8f. Not for navigation.</p>
    <p>All unit and weapon numbers are simplified game values derived from public sources. They are not real performance data.</p>
    <div class="foot"><button data-m="x" autofocus>Close</button></div>`);
  d.onclick = (e) => { if ((e.target as HTMLElement).closest('button')) showMenu(); };
}

// ---------- keyboard ----------
function cycle(own: boolean, dir: number): void {
  const s = scene.snap;
  if (!s) return;
  const ids: number[] = [];
  for (let q = 0, p = SNAP_HDR; q < s[2]; q++, p += SNAP_REC) {
    const k = s[p + 1], mine = s[p + 2] === scene.side;
    if (k === K_WPN || k === K_BUOY || s[p + 11] & F_STOWED) continue;
    if (own ? mine : !mine && s[p + 10] === 2) ids.push(s[p]);
  }
  if (!ids.length) return;
  const cur = ids.indexOf(own ? scene.sel : scene.tgt);
  const id = ids[(cur + dir + ids.length) % ids.length];
  if (own) { select(id); centerOn(id); } else setTarget(id);
}

export function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement, dlg = $<HTMLDialogElement>('dlg');
  if (dlg.open) return; // dialogs use native keyboard handling (Tab, Enter, Esc)
  if (t.tagName === 'SELECT' || t.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return; // let buttons activate
  const i = scene.info && scene.info.own && scene.sel >= 0 ? scene.info : null, id = scene.sel, k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const step = e.shiftKey ? 240 : 60;
  let used = true;
  if (G.cursor && k.startsWith('Arrow')) {
    const d = (e.shiftKey ? 100 : 20) / view.z;
    if (k === 'ArrowLeft') G.cursor.x -= d; else if (k === 'ArrowRight') G.cursor.x += d; else if (k === 'ArrowUp') G.cursor.y += d; else G.cursor.y -= d;
    invalidate();
  } else if (k === 'ArrowLeft') pan(-step, 0); else if (k === 'ArrowRight') pan(step, 0); else if (k === 'ArrowUp') pan(0, step); else if (k === 'ArrowDown') pan(0, -step);
  else if (k === '+' || k === '=') zoomAt(1.25); else if (k === '-' || k === '_') zoomAt(0.8);
  else if (k === ' ') setSpeed(G.paused ? G.speed : 0);
  else if (k === ',' || k === '.') { const n = SPEEDS.indexOf(G.paused ? 0 : G.speed) + (k === '.' ? 1 : -1); setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, n))]); }
  else if (k === 'n') cycle(true, 1); else if (k === 'p') cycle(true, -1);
  else if (k === 't') cycle(false, e.shiftKey ? -1 : 1);
  else if (k === 'c') centerOn(id);
  else if (k === 'i' && scene.tgt >= 0) { const t = scene.tgt; select(t); centerOn(t); } // look at the targeted contact's card
  else if (k === 'm') showMenu(); else if (k === 'h' || k === '?') showHelp();
  else if (k === 'q' && G.live) requestSave().then((s) => { localStorage.setItem('save', JSON.stringify(s)); line('Game saved', 'own'); });
  else if (k === 'y') { if (!G.live || G.winner >= 0 || !localStorage.getItem('save') || confirm('Load the saved game? The battle in progress will be lost.')) loadGame(); }
  else if (k === 'Escape') { if (G.cursor || G.moveMode) { G.cursor = null; G.moveMode = false; renderPanel(); invalidate(); } else select(-1); }
  else if (i) {
    const p = find(id), s = scene.snap!;
    if (k === 'w') { G.cursor = { x: s[p + 4], y: s[p + 5] }; invalidate(); }
    else if (k === 'Enter' && G.cursor) moveTo(G.cursor.x, G.cursor.y, e.shiftKey);
    else if (k === 'Delete' || k === 'Backspace') order(O_STOP, id);
    else if (k === 's' || k === 'x') order(O_SPEED, id, Math.max(0, i.ordKts + (k === 's' ? 1 : -1) * (i.kind === K_AIR ? 50 : 5)));
    else if (k === 'a' || k === 'z') order(O_ALT, id, i.ordAlt + (k === 'a' ? 1 : -1) * (i.kind === K_AIR ? 500 : 50));
    else if (k === 'r') order(O_RADAR, id, i.flags & F_RADAR ? 0 : 1);
    else if (k === 'o') order(O_SONAR, id, i.flags & F_ACTIVE ? 0 : 1);
    else if (k === 'f') order(O_WFREE, id, i.flags & F_WFREE ? 0 : 1);
    else if (k >= '1' && k <= '8') { const m = i.mounts[Number(k) - 1]; if (m && scene.tgt >= 0) { G.lastDeny = ''; order(O_FIRE, id, m.m, scene.tgt); } }
    else if (k === 'l') { const a = i.hangar.find((x) => x.stowed && x.readyS === 0); if (a) order(O_LAUNCH, a.id, loadoutPick[a.id] ?? a.lo); }
    else if (k === 'b') order(O_RTB, id);
    else if (k === 'd' || k === 'e' || k === 'v') { const b = i.buoys[k === 'd' ? 0 : k === 'e' ? 1 : 2]; if (b) order(O_BUOY, id, b.b, e.shiftKey ? 1 : 0); }
    else used = false;
  } else used = false;
  if (used) e.preventDefault();
}

// ---------- tutorial ----------
/** True if any record in the current snapshot passes the test (p is the record's offset). */
function anySnap(test: (s: Float32Array, p: number) => boolean): boolean {
  const s = scene.snap;
  if (!s) return false;
  for (let q = 0, p = SNAP_HDR; q < s[2]; q++, p += SNAP_REC) if (test(s, p)) return true;
  return false;
}
const ownWeaponFlying = () => anySnap((s, p) => s[p + 1] === K_WPN && s[p + 2] === scene.side);
const myShip = () => (scene.sel >= 0 && scene.info && scene.info.own ? scene.info : null);
const TUTORIAL: { text: string | (() => string); done: () => boolean }[] = [
  { text: 'Select your frigate: click its blue circle, tap it, or press N.', done: () => !!myShip() },
  { text: 'Set a course to the east: right-click the sea to the right of your ship (touch: press and hold), or press W, move the cursor right with the arrow keys, then Enter.', done: () => tutCourse },
  { text: 'Time is paused. Start the clock and speed it up: press . a few times, or use the buttons at the top right (8× is a good pace).', done: () => tutClock },
  { text: 'Your radar sees ships out to the horizon, about 40 km. Wait for a hostile track (a red diamond) to appear. If none does, you have sailed away from it: the enemy lies 30 km east of where you started.', done: () => anySnap((s, p) => s[p + 2] !== scene.side && s[p + 10] === 2 && s[p + 1] === K_SHIP) },
  { text: 'Contact. Make it your target: click the red diamond, or press T.', done: () => scene.tgt >= 0 },
  { text: 'Fire a Harpoon (weapon 2, range 5 to 140 km): press 2, or the Fire button on the unit card.', done: () => tutFired },
  {
    // the frigate's weapon 2 is the Harpoon; when they are gone the gun can still finish the job
    text: () => (myShip()!.mounts[1]?.ammo === 0 && !ownWeaponFlying()
      ? 'Out of Harpoons. Close to within 16 km of the Krivak and fire the 76 mm gun (weapon 3: press 3 or its Fire button) until she sinks.'
      : 'Missile away. It may be shot down or decoyed, so fire again if it misses. Sink the Krivak to finish.'),
    done: () => G.winner >= 0,
  },
];
let tutCourse = false, tutClock = false, tutFired = false; // things done once; everything else is read from the current state
/** Show the tutorial hint for the first step that is not done. Called on every snapshot and whenever the selection changes. */
export function tutorialTick(): void {
  const hint = $('hint');
  if (!G.scn || G.scn.id !== 'tutorial' || !G.live || G.winner >= 0) { hint.hidden = true; return; }
  const i = myShip(), p = i ? find(scene.sel) : -1;
  if (i && p >= 0 && i.wp.length >= 2 && i.wp[i.wp.length - 2] > scene.snap![p + 4]) tutCourse = true; // last waypoint lies to the east
  if (!G.paused && G.speed >= 2) tutClock = true;
  if (ownWeaponFlying()) tutFired = true;
  // The first step not yet done, so undoing something (clearing the selection, losing the contact) brings its hint back.
  let n = 0;
  while (n < TUTORIAL.length - 1 && TUTORIAL[n].done()) n++;
  const t = TUTORIAL[n].text, text = `Step ${n + 1} of ${TUTORIAL.length}. ${typeof t === 'string' ? t : t()}`;
  if (hint.textContent !== text) hint.textContent = text; // only touch the DOM (and screen readers) on a change
  hint.hidden = false;
}
