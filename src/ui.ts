// DOM side of the game: unit card, event log, dialogs and the keyboard map.
import {
  SNAP_HDR, SNAP_REC, KTS, K_SHIP, K_SUB, K_AIR, K_BASE, K_WPN, K_BUOY, F_RADAR, F_ACTIVE, F_WFREE, F_STOWED, F_RTB,
  D_SENSORS, D_PROP, D_WEAPONS, D_DECK,
  O_SPEED, O_ALT, O_RADAR, O_SONAR, O_WFREE, O_STOP, O_FIRE, O_LAUNCH, O_RTB, O_BUOY, O_JOIN, O_FORM, FORMS,
  E_CONTACT, E_LOST, E_LAUNCH, E_HIT, E_MISS, E_KILL, E_PD, E_AGROUND, E_AIROP, E_BINGO, E_BUOY, E_DISABLED, E_END, E_NOGUIDE,
  type Save, type Info, type CUnit,
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
let buoyDeep = false, lastHtml = '', pointerOnPanel = false, pendingHtml: string | null = null, dlgPaused = false, flightSize = 1;

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
  panel.addEventListener('pointerdown', (e) => { pointerOnPanel = true; lastPointer = e.pointerType; });
  const ringOf = (t: EventTarget | null) => ((t as HTMLElement | null)?.closest?.('[data-ring]') as HTMLElement | null)?.dataset.ring || '';
  panel.addEventListener('pointerover', (e) => showRing(ringOf(e.target), ringPin));
  panel.addEventListener('pointerleave', () => showRing('', ringPin));
  panel.addEventListener('focusin', (e) => showRing(ringHover, ringOf(e.target))); // keyboard: the row whose button has the focus
  panel.addEventListener('focusout', (e) => { if (!panel.contains(e.relatedTarget as Node | null)) showRing(ringHover, ''); });
  const release = () => { pointerOnPanel = false; if (pendingHtml !== null) setPanel(pendingHtml); };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release); // a touch that turned into a scroll
  panel.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (b) act(b.dataset.act!, Number(b.dataset.v ?? 0), b);
    // a finger cannot hover: a tap on a row (not on its button or list) keeps its circles up until the next tap
    else if (lastPointer === 'touch' && ringOf(e.target) && !(e.target as HTMLElement).closest('select')) showRing('', ringPin === ringOf(e.target) ? '' : ringOf(e.target));
  });
  panel.addEventListener('change', (e) => {
    const t = e.target as HTMLSelectElement;
    if (t.dataset.lo !== undefined) { loadoutPick[Number(t.dataset.lo)] = Number(t.value); renderPanel(); } // the line under the row lists the new loadout
    else if (t.dataset.k === 'flight') { flightSize = Number(t.value); renderPanel(); }
  });
  initMenu();
}

// ---------- unit card ----------
const loadoutPick: Record<number, number> = {};
/** Forget per-battle UI choices. */
export function resetUi(): void { for (const k in loadoutPick) delete loadoutPick[k]; lastHtml = ''; buoyDeep = false; ringHover = ringPin = ''; tutCourse = tutClock = tutFired = false; dlgPaused = false; flightSize = 1; closeMenu(false); }
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

/** What a weapon can be fired at, in words. */
const versus = (m: { altMin: number; altMax: number }) => [m.altMax > 0 && 'air', m.altMin <= 0 && m.altMax >= 0 && 'surface', m.altMin < 0 && 'submarines'].filter(Boolean).join(', ');
/** A weapon's range in words: "5–140 km", or "16 km" when it has no minimum. */
const span = (w: { minKm: number; maxKm: number }) => (w.minKm > 0 ? `${w.minKm}–${w.maxKm} km` : `${w.maxKm} km`);
/**
 * How far an aircraft type can fly out at cruise speed and still get back, in km to the nearest ten. It is the
 * distance at which the sim sends it home: fuel left under the time home plus a quarter, plus two minutes.
 */
const reachKm = (d: { cruiseKts: number; fuelMin?: number }) => Math.round((d.cruiseKts * KTS * ((d.fuelMin || 120) * 60 - 120)) / 2.25 / 10) * 10;
/** What one of an aircraft type's loadouts carries, with every weapon's range, so it can be read before the launch. */
function arms(u: CUnit, lo: number): string {
  const L = u.loadouts[lo];
  return L && L.items.length ? L.items.map((it) => { const w = G.db!.weapons[it.w].d; return `${it.n}× ${esc(w.name)} (${versus(w)}, ${span(w)})`; }).join(', ') : 'No weapons';
}
// Range circles are drawn only for the card row being pointed at (or tapped on a touch screen, or holding the
// keyboard focus): 'w' + a mount number for a weapon, 'a' + a unit id for an aircraft type. ringFor is the unit they belong to.
let ringHover = '', ringPin = '', ringFor = -1, lastPointer = '';
/** The circles for that row: a weapon's maximum range and, dashed, its minimum; or how far an aircraft type can fly and return. */
export function ringsOf(i: Info | null): { km: number; label: string; style: number }[] {
  const key = ringHover || ringPin;
  if (!i || !i.own || !G.db || !key || ringFor !== i.id) return [];
  if (key[0] === 'w') {
    const m = i.mounts.find((x) => x.m === Number(key.slice(1)));
    if (!m) return [];
    const out = [{ km: m.maxKm, style: 0, label: `${m.name} · ${span(m)}` }];
    if (m.minKm > 0) out.push({ km: m.minKm, style: 1, label: `${m.name} · not inside ${m.minKm} km` });
    return out;
  }
  const u = G.db.units[G.db.u[key.slice(1)]];
  return u ? [{ km: reachKm(u.d), style: 2, label: `${u.d.name} · can fly ${reachKm(u.d)} km out and still get back` }] : [];
}
function showRing(hover: string, pin: string): void {
  if (hover === ringHover && pin === ringPin && ringFor === scene.sel) return;
  ringHover = hover; ringPin = pin; ringFor = scene.sel;
  scene.rings = ringsOf(scene.info);
  invalidate();
}
/** The speed choices for a unit type: [knots, name]. Jets cannot fly slowly. */
function speeds(d: { cls: string; kts: number; cruiseKts: number }): [number, string][] {
  return d.cls === 'air' ? [[d.cruiseKts, 'Cruise'], [d.kts, 'Full']] : [[0, 'Stop'], [Math.round(d.kts / 3), 'Slow'], [d.cruiseKts, 'Cruise'], [d.kts, 'Full']];
}
/** One line at the bottom of the screen saying what the mouse does right now. */
function hud(): void {
  const i = scene.info, own = !!i && i.own && scene.sel >= 0;
  const t = !G.live || G.winner >= 0 ? ''
    : G.cursor ? 'Move the cursor with the arrow keys. Enter sets the course (Shift+Enter adds a waypoint). Esc cancels.'
    : G.moveMode ? 'Click the sea to set the course (Shift adds a waypoint). Esc cancels.'
    : !own ? 'Click one of your units (blue) to select it. Right-click it for its speed and formation menu. Press H for help.'
    : `Right-click the sea to set a course, or a unit for its menu. Click a red contact to target it.${scene.tgt >= 0 ? ' Fire from the unit card or with keys 1–8.' : ''}`;
  const el = $('hud');
  if (el.textContent !== t) el.textContent = t;
}

export function renderPanel(): void {
  tutorialTick();
  if (menuId >= 0) { if (menuId !== scene.sel) closeMenu(false); else drawMenu(); }
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
    (air ? ` · alt <b>${i.alt.toFixed(0)}</b> m · fuel <b>${i.fuelMin.toFixed(0)}</b> min, about <b>${Math.round((i.fuelMin * 60 * d.cruiseKts * KTS) / 10) * 10}</b> km of flying at cruise speed` : sub ? ` · depth <b>${(-i.alt).toFixed(0)}</b> m` : '') +
    (air ? '' : ` · sea floor ${i.depth.toFixed(0)} m`) + `</div>`;
  h += `<div class="hpbar" role="img" aria-label="Hull ${Math.round((100 * i.hp) / i.maxHp)} percent"><i style="width:${Math.max(0, (100 * i.hp) / i.maxHp)}%"></i></div>`;
  const dis = [[D_SENSORS, 'sensors'], [D_PROP, 'propulsion'], [D_WEAPONS, 'weapons'], [D_DECK, 'flight deck']].filter((x) => i.dis & (x[0] as number)).map((x) => x[1]);
  if (dis.length) h += `<div class="kv bad">Disabled: ${dis.join(', ')}</div>`;
  if (G.lastDeny) h += `<div class="kv bad" role="alert">${esc(DENY[Number(G.lastDeny)] || DENY[1])}</div>`;
  if (stowed) { h += `<div class="kv">On deck. Select the ship to launch.</div>`; setPanel(h); return; }
  if (i.kind !== K_BASE) {
    h += `<h3>Helm</h3><div class="row">`;
    for (const [k, name] of speeds(d)) h += btn('spd', k, name, Math.abs(i.ordKts - k) < 0.5, false, `${k} knots`);
    h += btn('move', 0, 'Set course (W)', G.moveMode) + btn('halt', 0, 'Clear course') + `</div>`;
    if (air) {
      const alts = [...new Set([i.minAlt, 300, 1500, 6000, i.maxAlt].filter((a) => a >= i.minAlt && a <= i.maxAlt))];
      h += `<div class="row" style="margin-top:4px">` + alts.map((a) => btn('alt', a, a + ' m', Math.abs(i.ordAlt - a) < 1)).join('') + btn('rtb', 0, 'Return (B)', (i.flags & F_RTB) !== 0) + `</div>`;
    } else if (sub) {
      const L = G.scn!.layerM, ds = [[-15, 'Periscope'], [-(L - 30), 'Above layer'], [-(L + 50), 'Below layer'], [i.maxAlt, 'Deep']] as [number, string][];
      h += `<div class="row" style="margin-top:4px">` + ds.map((x) => btn('alt', x[0], x[1], Math.abs(i.ordAlt - x[0]) < 1)).join('') + `</div><div class="kv">Thermocline at ${L} m</div>`;
    }
  }
  if (i.lead >= 0 || i.followers > 0) {
    h += `<h3>Formation</h3><div class="kv">${i.lead >= 0 ? `Following <b>${esc(i.leadName)}</b>` : `Leading <b>${i.followers}</b> ${i.followers === 1 ? 'unit' : 'units'}`}. Course, speed and ${air ? 'altitude' : sub ? 'depth' : 'stop'} orders steer the whole formation.</div><div class="row" style="margin-top:4px">` +
      FORMS.map((f, n) => btn('form', n, f, i.form === n)).join('') + btn('leave', 0, i.lead >= 0 ? 'Leave formation' : 'Dismiss formation') + `</div>`;
  }
  h += `<h3>Sensors and doctrine</h3><div class="row">`;
  if (i.hasRadar) h += btn('radar', i.flags & F_RADAR ? 0 : 1, 'Radar (R)', (i.flags & F_RADAR) !== 0);
  if (i.hasActive) h += btn('sonar', i.flags & F_ACTIVE ? 0 : 1, 'Active sonar (O)', (i.flags & F_ACTIVE) !== 0);
  h += btn('wfree', i.flags & F_WFREE ? 0 : 1, 'Auto-defend (F)', (i.flags & F_WFREE) !== 0, false, 'Engage incoming missiles and aircraft automatically') + `</div>`;
  if (i.mounts.length) {
    const td = scene.tgt >= 0 ? distTo(scene.tgt) : -1;
    h += `<h3>Weapons${i.fc ? ` · channels ${i.fcUsed}/${i.fc}` : ''}</h3>`;
    h += `<div class="kv">Point at a weapon to see its range on the map.</div><div class="kv">${scene.tgt >= 0 ? `Target: <b>${esc(scene.unitName(scene.snap![find(scene.tgt) + 3]))}</b>${td >= 0 ? ` at <b>${td.toFixed(1)}</b> km` : ''}` : 'Pick a hostile track on the map as the target.'}</div>`;
    i.mounts.forEach((m, n) => {
      const ok = scene.tgt >= 0 && m.ammo > 0 && m.readyS === 0 && td >= m.minKm && td <= m.maxKm;
      h += `<div class="w" data-ring="w${m.m}"><span>${esc(m.name)} ×${m.ammo}<small>against ${versus(m)} · ${span(m)}${m.readyS ? ` · ready in ${Math.ceil(m.readyS)} s` : ''}</small></span>${btn('fire', m.m, `Fire (${n + 1})`, false, !ok)}</div>`;
    });
  }
  if (i.pd.length) h += `<div class="kv">Point defence: ${i.pd.map(esc).join(', ')}</div>`;
  if (i.buoys.length) {
    h += `<h3>Sonobuoys</h3><div class="row">` + i.buoys.map((b) => btn('buoy', b.b, `${esc(b.name)} ×${b.n}`, false, b.n === 0)).join('') +
      btn('deep', 0, buoyDeep ? 'Set: below layer' : 'Set: above layer', buoyDeep) + `</div>`;
  }
  if (i.hangar.length) {
    h += `<h3>Aircraft</h3><label class="kv" style="display:block;margin-bottom:4px">Launch sends up <select data-k="flight" aria-label="Aircraft per launch">` +
      [1, 2, 3, 4].map((n) => `<option value="${n}"${n === flightSize ? ' selected' : ''}>${n === 1 ? 'one aircraft' : `a flight of ${n}`}</option>`).join('') +
      `</select>${flightSize > 1 ? '<br>The others are the next ready aircraft of the same type. They take the same loadout, launch one after another and follow the first.' : ''}</label>`;
    let type = '';
    for (const a of i.hangar) {
      const lo = loadoutPick[a.id] ?? a.lo, cu = G.db.units[G.db.u[a.type]];
      if (a.type !== type) { // once per aircraft type: how far it can go
        type = a.type;
        h += `<div class="kv" data-ring="a${esc(a.type)}" style="margin-top:6px"><b>${esc(cu.d.name)}</b> can fly <b>${reachKm(cu.d)}</b> km out and still get back (${cu.d.fuelMin || 120} min of fuel at ${cu.d.cruiseKts} kts). Point here to see that on the map.</div>`;
      }
      const st = !a.stowed ? 'airborne' : a.queued ? 'waiting for the deck' : a.readyS > 0 ? `ready in ${Math.ceil(a.readyS / 60)} min` : 'ready';
      h += `<div class="w" data-ring="a${esc(a.type)}"><span>${esc(a.name)}<small>${st}</small></span>`;
      if (a.stowed) {
        h += `<select data-lo="${a.id}" data-k="lo${a.id}" aria-label="Loadout for ${esc(a.name)}">${a.loadouts.map((l, n) => `<option value="${n}"${n === lo ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>` +
          btn('launch', a.id, 'Launch', false, a.readyS > 0 || a.queued);
      } else h += btn('pick', a.id, 'Select');
      h += `</div>`;
      if (a.stowed) h += `<div class="kv" style="margin-bottom:4px">Carries ${arms(cu, lo)}</div>`; // what the chosen loadout is, before it goes
    }
  }
  setPanel(h);
}

/** Launch aircraft id from the selected deck, with the next ready ones of its type if a flight is asked for. */
function launchFlight(i: Info, id: number, lo: number): void {
  const type = i.hangar.find((h) => h.id === id)?.type;
  const mates = i.hangar.filter((h) => h.id !== id && h.type === type && h.stowed && !h.queued && h.readyS === 0).slice(0, flightSize - 1);
  // the third number is the flight leader's id + 1: such a launch waits for a busy deck instead of being refused
  order(O_LAUNCH, id, lo, id + 1);
  for (const m of mates) order(O_LAUNCH, m.id, lo, id + 1);
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
    case 'launch': if (scene.info) launchFlight(scene.info, v, loadoutPick[v] ?? Number((el.parentElement!.querySelector('select') as HTMLSelectElement).value)); break;
    case 'form': order(O_FORM, id, v); break;
    case 'leave': order(O_JOIN, id, -1); break;
    case 'pick': select(v); centerOn(v); break;
  }
}

// ---------- unit menu: right-click or long press on one of your units, or G ----------
let menuId = -1, menuFrom = -1, menuHtml = '';
/** Open the menu for own unit id at a screen position. The unit becomes the selection, so its card shows too. */
export function unitMenu(id: number, sx: number, sy: number): void {
  const p = find(id), s = scene.snap;
  if (p < 0 || !s || !G.db || G.winner >= 0 || s[p + 10] !== 3 || s[p + 2] !== scene.side) return;
  menuFrom = scene.sel !== id && scene.info?.own ? scene.sel : -1; // the unit selected before: it may be told to follow this one
  if (scene.sel !== id) select(id);
  menuId = id; menuHtml = '';
  drawMenu();
  const m = $('ctx');
  if (m.hidden) { menuId = -1; return; } // nothing to offer (a base)
  m.style.left = Math.max(8, Math.min(sx + 12, view.w - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(sy + 12, view.h - m.offsetHeight - 8)) + 'px';
  (m.querySelector('button') as HTMLElement).focus();
}
function closeMenu(focusMap = true): void {
  const m = $('ctx'), had = m.contains(document.activeElement);
  menuId = -1; m.hidden = true;
  if (had && focusMap) $('map').focus();
}
/** Build the menu from the snapshot, plus the unit card's data once it has arrived (for the ticks on current choices). */
function drawMenu(): void {
  const m = $('ctx'), p = find(menuId), s = scene.snap!;
  if (p < 0 || !G.db) { closeMenu(); return; }
  const d = G.db.units[s[p + 3]].d, i = scene.info && scene.info.id === menuId ? scene.info : null;
  const lead = s[p + 15];
  let followers = 0;
  for (let q = 0, r = SNAP_HDR; q < s[2]; q++, r += SNAP_REC) if (s[r + 15] === menuId) followers++;
  // a choice among several carries a tick (on = true or false); a plain action has none (on left out)
  const item = (a: string, v: number, label: string, on?: boolean) => `<button role="${on === undefined ? 'menuitem' : `menuitemradio" aria-checked="${on}`}" data-a="${a}" data-v="${v}">${on ? '✓ ' : ''}${label}</button>`;
  let h = `<b>${esc(G.labels[menuId] || d.name)}</b>`;
  if (s[p + 1] !== K_BASE) {
    h += `<h3>Speed${lead >= 0 ? ' of the formation' : ''}</h3>` + speeds(d).map(([k, name]) => item('spd', k, `${name} · ${k} kts`, !!i && Math.abs(i.ordKts - k) < 0.5)).join('');
    if (lead >= 0 || followers) {
      h += `<h3>Formation</h3><small>${lead >= 0 ? `Following ${esc(G.labels[lead] || 'its leader')}` : `Leading ${followers} ${followers === 1 ? 'unit' : 'units'}`}</small>` +
        FORMS.map((f, n) => item('form', n, f, !!i && i.form === n)).join('') + item('leave', 0, lead >= 0 ? 'Leave formation' : 'Dismiss formation');
    }
    // the unit that was selected before may fall in on this one, if they are the same kind of unit
    const q = menuFrom >= 0 ? find(menuFrom) : -1;
    if (q >= 0 && s[q + 15] !== menuId && s[q + 1] === s[p + 1] && G.db.units[s[q + 3]].d.cls === d.cls && !(s[q + 11] & F_STOWED)) {
      h += `<h3>Form up</h3>` + item('join', menuFrom, `${esc(G.labels[menuFrom] || 'The other unit')} follows this unit`);
    }
  }
  if (h === menuHtml) return;
  const n = [...m.querySelectorAll('button')].indexOf(document.activeElement as HTMLButtonElement); // keep the keyboard's place across a redraw
  menuHtml = h; m.innerHTML = h; m.hidden = !h.includes('<button');
  if (n >= 0) (m.querySelectorAll('button')[n] as HTMLElement | undefined)?.focus();
}
function initMenu(): void {
  const m = $('ctx');
  m.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button'), id = menuId;
    if (!b || id < 0) return;
    const a = b.dataset.a, v = Number(b.dataset.v);
    closeMenu();
    if (a === 'spd') order(O_SPEED, id, v);
    else if (a === 'form') order(O_FORM, id, v);
    else if (a === 'leave') order(O_JOIN, id, -1);
    else if (a === 'join') order(O_JOIN, v, id);
  });
  m.addEventListener('keydown', (e) => {
    const items = [...m.querySelectorAll('button')] as HTMLElement[], n = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') items[(n + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    else if (e.key === 'Escape' || e.key === 'Tab') closeMenu();
    else return; // Enter and Space press the item; any other key is a game key
    e.preventDefault(); e.stopPropagation();
  });
  // a press anywhere else puts the menu away, and still does whatever it would have done
  document.addEventListener('pointerdown', (e) => { if (menuId >= 0 && !(e.target as HTMLElement).closest('#ctx')) closeMenu(false); });
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
  closeMenu(false);
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
  ['R / O / F', 'Radar / active sonar / auto-defend on or off'], ['1 – 8', 'Fire weapon 1–8 at the target'], ['L', 'Launch the next ready aircraft (or flight)'], ['B', 'Aircraft: return to its deck (a leader takes its formation)'], ['G', 'Unit menu: speed and formation (arrows, Enter, Esc)'],
  ['D / E / V', 'Drop sonobuoy type 1 / 2 / 3 (hold Shift to set it below the layer)'], ['Q / Y', 'Quick save / quick load'], ['M', 'Menu'], ['H or ?', 'This help'], ['Esc', 'Close a dialog or clear the selection'],
];
export function showHelp(): void {
  const d = dialog(`<h1>How to play</h1>
    <p><b>Mouse:</b> click one of your units to select it, click a hostile track to target it, right-click the sea to set a course (Shift adds a waypoint), right-click one of your units for its speed and formation menu, drag to pan, wheel to zoom.</p>
    <p><b>Touch:</b> tap to select or target, press and hold the sea to set a course, press and hold one of your units for its menu, drag to pan, pinch to zoom.</p>
    <p><b>On the map:</b> each unit shows its speed, its height or depth, and for your own its fuel and damage. Point at a weapon on the unit card (on a touch screen, tap it) and the map shows its maximum range as a circle and, dashed, the minimum range it cannot fire inside. Point at an aircraft on a ship's or base's card and a blue circle shows how far it can fly out and still get back. The card also lists what every aircraft carries, with ranges, before you launch it.</p>
    <p><b>Formations:</b> pick a flight of 2 to 4 on a ship's or base's card and Launch sends them up to follow the first. To group units already out, select the one that should follow, right-click the one that should lead, and choose Form up. Orders to any member steer the whole formation.</p>
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
    if (k === 'w') { G.cursor = { x: s[p + 4], y: s[p + 5] }; invalidate(); renderPanel(); }
    else if (k === 'Enter' && G.cursor) moveTo(G.cursor.x, G.cursor.y, e.shiftKey);
    else if (k === 'Delete' || k === 'Backspace') order(O_STOP, id);
    else if (k === 's' || k === 'x') order(O_SPEED, id, Math.max(0, i.ordKts + (k === 's' ? 1 : -1) * (i.kind === K_AIR ? 50 : 5)));
    else if (k === 'a' || k === 'z') order(O_ALT, id, i.ordAlt + (k === 'a' ? 1 : -1) * (i.kind === K_AIR ? 500 : 50));
    else if (k === 'r') order(O_RADAR, id, i.flags & F_RADAR ? 0 : 1);
    else if (k === 'o') order(O_SONAR, id, i.flags & F_ACTIVE ? 0 : 1);
    else if (k === 'f') order(O_WFREE, id, i.flags & F_WFREE ? 0 : 1);
    else if (k >= '1' && k <= '8') { const m = i.mounts[Number(k) - 1]; if (m && scene.tgt >= 0) { G.lastDeny = ''; order(O_FIRE, id, m.m, scene.tgt); } }
    else if (k === 'l') { const a = i.hangar.find((x) => x.stowed && !x.queued && x.readyS === 0); if (a) launchFlight(i, a.id, loadoutPick[a.id] ?? a.lo); }
    else if (k === 'g' || k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) unitMenu(id, (s[p + 4] - view.x) * view.z + view.w / 2, view.h / 2 - (s[p + 5] - view.y) * view.z);
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
  hud(); // the bottom hint line rides along: it changes at the same moments
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
