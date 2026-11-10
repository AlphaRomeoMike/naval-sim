// Weapons: launch checks, flight, point defence, the terminal roll, damage, and automatic weapon release.
import {
  type Sim, MAX, NM, NPD, NWP, DT, CELL, GW, HALF,
  K_FREE, K_SHIP, K_SUB, K_AIR, K_BASE, K_WPN, K_BUOY, F_RADAR, F_WFREE, F_STOWED, F_CHAN, F_AI,
  D_SENSORS, D_PROP, D_WEAPONS, D_DECK, O_FIRE, E_LAUNCH, E_HIT, E_MISS, E_KILL, E_PD, E_DISABLED, E_NOGUIDE,
  hooks, addOrderHandler, spawn, free, emit, canEngage, reach, hit, pick, CH,
} from './sim';

const AIR_RELOAD = 4; // steps between releases from an aircraft
const TRANSIENT = 60; // steps a submarine stays loud after firing
const TORP_DOCTRINE = 0.6; // the AI holds torpedoes until inside this fraction of their range
const DIVE_KM = 20; // 'high' profile weapons dive over the last 20 km
const DEFEND_KM = 100; // ships look for inbound air threats within this distance
const MAX_ON_TARGET = 2; // interceptors the automatic defence keeps in flight against one air target
const MAX_SALVO = 12; // upper bound for an offensive salvo against one target

const H = new Float64Array(1); // scratch: a height fed by both a typed array and an object field would be boxed as a local
/** Radar line of sight between two entities (aircraft and weapons use their altitude, ships their mast height). */
export function los(s: Sim, a: number, b: number): boolean {
  const ka = s.kind[a], kb = s.kind[b], ex = s.x[b] - s.x[a], ey = s.y[b] - s.y[a];
  H[0] = ka === K_AIR || ka === K_WPN ? s.alt[a] : ka === K_BUOY ? 1 : s.db.units[s.def[a]].d.heightM;
  const ra = Math.sqrt(H[0] > 0 ? H[0] : 0);
  H[0] = kb === K_AIR || kb === K_WPN ? s.alt[b] : kb === K_BUOY ? 1 : s.db.units[s.def[b]].d.heightM;
  const hz = 4.12 * (ra + Math.sqrt(H[0] > 0 ? H[0] : 0)); // same formula as horizonKm(), inline
  return ex * ex + ey * ey <= hz * hz;
}

/**
 * Try to fire mount m of unit u at target t. Returns 0 on launch, else a reason code
 * (the text for each code lives in ui.ts DENY).
 */
export function fire(s: Sim, u: number, m: number, t: number): number {
  const ku = s.kind[u];
  if (ku === K_FREE || ku === K_WPN || ku === K_BUOY || m < 0 || m >= NM) return 1;
  if (s.flags[u] & F_STOWED) return 11;
  if (s.dis[u] & D_WEAPONS) return 8;
  const o = u * NM + m, wi = s.mw[o];
  if (wi < 0) return 1;
  if (s.ammo[o] === 0) return 2;
  if (s.ready[o] > s.tick) return 3;
  const kt = s.kind[t];
  if (t < 0 || t >= MAX || kt === K_FREE || kt === K_BUOY || s.side[t] === s.side[u] || s.flags[t] & F_STOWED) return 1;
  // No track, no answer: the range and altitude checks below must not leak where an undetected unit is.
  if (s.det[s.side[u] * MAX + t] < 2) return 4;
  const w = s.db.weapons[wi], d = w.d, ud = s.db.units[s.def[u]];
  const ex = s.x[t] - s.x[u], ey = s.y[t] - s.y[u], d2 = ex * ex + ey * ey;
  if (d2 < d.minKm * d.minKm || d2 > d.maxKm * d.maxKm) return 5;
  const ta = kt === K_SHIP || kt === K_BASE ? 0 : s.alt[t];
  if (ta < d.altMin || ta > d.altMax || (kt === K_WPN && ta <= 0)) return 6;
  if (!canEngage(s, u, t)) return 4;
  if (w.chan) {
    if (s.fcUsed[u] >= ud.d.fc) return 7;
    if (!(s.flags[u] & F_RADAR) || s.dis[u] & D_SENSORS || !ud.d.radar || !los(s, u, t)) return 12;
  } else if (d.seeker === 'arm') {
    if (kt === K_WPN || !(s.flags[t] & F_RADAR) || s.dis[t] & D_SENSORS || !s.db.units[s.def[t]].d.radar) return 9;
  } else if (d.seeker === 'gps' && s.spd[t] > 0.001) return 10;

  // release (the weapon entity is created first, so a full entity table rejects the order without spending anything)
  const sd = s.side[u], other = 1 - sd;
  let i = -1;
  if (d.profile !== 'gun') {
    const start = d.profile === 'skim' ? 10 : d.profile === 'high' ? d.cruiseM || 12000 : d.profile === 'torp' ? Math.min(-5, s.alt[u]) : Math.max(10, s.alt[u]);
    i = spawn(s, K_WPN, sd, wi, s.x[u], s.y[u], start);
    if (i < 0) return 1;
  }
  s.ammo[o]--;
  if (s.ammo[o] === 0) reach(s, u);
  if (ku === K_SUB) s.busy[u] = s.tick + TRANSIENT; // heard by passive sonar for the next 30 s
  const cm = ku === K_AIR ? null : ud.mounts[m];
  const reload = cm ? cm.reload : AIR_RELOAD;
  s.ready[o] = s.tick + reload;
  if (cm && cm.l >= 0) for (let q = 0; q < ud.mounts.length; q++) if (ud.mounts[q].l === cm.l) s.ready[u * NM + q] = s.tick + reload;
  emit(s, E_LAUNCH, (1 << sd) | (s.det[other * MAX + u] === 2 ? 1 << other : 0), u, wi, sd);
  if (i < 0) { resolve(s, wi, t, sd); return 0; } // guns resolve at once
  s.tgt[i] = t; s.tgtGen[i] = s.gen[t]; s.host[i] = u; s.hostGen[i] = s.gen[u];
  s.spd[i] = w.kmps; s.fuel[i] = d.maxKm * 1.15;
  s.wpX[i * NWP] = s.x[t]; s.wpY[i * NWP] = s.y[t]; // aim point for inertial weapons
  s.engaged[t]++;
  if (w.chan) { s.flags[i] = F_CHAN; s.fcUsed[u]++; }
  return 0;
}

/** Take a weapon entity out of the world, releasing its fire-control channel and its claim on the target. */
function remove(s: Sim, i: number): void {
  const h = s.host[i], t = s.tgt[i];
  if (s.flags[i] & F_CHAN && s.kind[h] !== K_FREE && s.gen[h] === s.hostGen[i] && s.fcUsed[h] > 0) s.fcUsed[h]--;
  if (t >= 0 && s.kind[t] !== K_FREE && s.gen[t] === s.tgtGen[i] && s.engaged[t] > 0) s.engaged[t]--;
  free(s, i);
}

export function kill(s: Sim, t: number): void {
  emit(s, E_KILL, 3, t, 0, (s.side[t] << 16) | s.def[t]);
  const g = s.gen[t];
  free(s, t);
  for (let j = 0; j < s.n; j++) { // aircraft still on its deck go down with it
    if (s.kind[j] === K_AIR && s.flags[j] & F_STOWED && s.host[j] === t && s.hostGen[j] === g) free(s, j);
  }
}

/** Event payload for a target: side, a flag for weapon targets, and the unit or weapon index. */
function tgtCode(s: Sim, t: number): number {
  return (s.side[t] << 16) | (s.kind[t] === K_WPN ? 0x8000 : 0) | s.def[t];
}

/** Remove hit points and disable one rolled subsystem (sensors, propulsion, weapons, flight deck). */
export function damage(s: Sim, t: number, wi: number): void {
  emit(s, E_HIT, 3, t, wi, tgtCode(s, t));
  if (s.kind[t] === K_WPN) { remove(s, t); return; } // an intercepted missile
  const sd = s.side[t], u = s.db.units[s.def[t]];
  s.hp[t] -= s.db.weapons[wi].d.dmg;
  // roll among the subsystems this unit has and that still work
  const have = (u.d.radar || u.son.length ? D_SENSORS : 0) | (u.maxKmps > 0 ? D_PROP : 0) | (u.mounts.length || u.pd.length || u.loadouts.length ? D_WEAPONS : 0) | (u.d.deck ? D_DECK : 0);
  const left = have & ~s.dis[t];
  let n = 0;
  for (let b = 1; b <= 8; b <<= 1) if (left & b) n++;
  let nth = n ? pick(s, n) : 0, bit = 0;
  for (let b = 1; b <= 8; b <<= 1) if (left & b && nth-- === 0) bit = b;
  if (s.hp[t] <= 0) { kill(s, t); return; }
  if (bit) {
    s.dis[t] |= bit;
    emit(s, E_DISABLED, 1 << sd, t, bit === 1 ? 0 : bit === 2 ? 1 : bit === 4 ? 2 : 3, 0);
  }
}

/** The one terminal roll: base chance x the target's decoy / jamming factors for this seeker. */
export function hitChance(s: Sim, wi: number, t: number): number {
  const d = s.db.weapons[wi].d;
  if (s.kind[t] === K_WPN) return d.pHit;
  const u = s.db.units[s.def[t]].d, k = d.seeker;
  return d.pHit * (k === 'sarh' || k === 'cmd' || k === 'arh' ? u.chaff * u.jam : k === 'ir' ? u.chaff : k === 'acoustic' ? u.nixie : 1);
}

function resolve(s: Sim, wi: number, t: number, bySide: number): void {
  // same rule as hitChance(), written into the roll's scratch slot so no double crosses a call
  const d = s.db.weapons[wi].d, k = d.seeker;
  CH[0] = d.pHit;
  if (s.kind[t] !== K_WPN) {
    const u = s.db.units[s.def[t]].d;
    if (k === 'sarh' || k === 'cmd' || k === 'arh') CH[0] *= u.chaff * u.jam; else if (k === 'ir') CH[0] *= u.chaff; else if (k === 'acoustic') CH[0] *= u.nixie;
  }
  if (hit(s)) damage(s, t, wi);
  else emit(s, E_MISS, 1 << bySide, t, wi, tgtCode(s, t));
}

/** Area weapons: one roll against everything in the altitude band inside the radius, either side. */
function burst(s: Sim, wi: number, x: number, y: number, bySide: number): void {
  const d = s.db.weapons[wi].d, r = d.radiusKm || 0, r2 = r * r;
  for (let t = 0; t < s.n; t++) {
    const k = s.kind[t];
    if (k !== K_SHIP && k !== K_SUB && k !== K_AIR) continue;
    if (s.flags[t] & F_STOWED) continue;
    const a = k === K_SHIP ? 0 : s.alt[t];
    if (a < d.altMin || a > d.altMax) continue;
    const ex = s.x[t] - x, ey = s.y[t] - y;
    if (ex * ex + ey * ey <= r2) resolve(s, wi, t, bySide);
  }
}

/** One step of a weapon in flight. */
function fly(s: Sim, i: number): void {
  const wi = s.def[i], w = s.db.weapons[wi], d = w.d, t = s.tgt[i], sd = s.side[i];
  const inertial = d.seeker === 'inertial';
  // the target is lost if it is gone, or has landed (a missile does not follow an aircraft onto its deck)
  const live = t >= 0 && s.kind[t] !== K_FREE && s.gen[t] === s.tgtGen[i] && !(s.kind[t] === K_AIR && s.flags[t] & F_STOWED);
  if (!live && !inertial) { remove(s, i); return; }
  if (s.flags[i] & F_CHAN) {
    // semi-active and command guidance: the launcher must keep illuminating for the whole flight
    const h = s.host[i];
    let ok = s.kind[h] !== K_FREE && s.gen[h] === s.hostGen[i] && !(s.dis[h] & (D_SENSORS | D_WEAPONS)) && (s.flags[h] & F_RADAR) !== 0;
    if (ok) ok = los(s, h, t);
    if (!ok) { emit(s, E_NOGUIDE, 1 << sd, i, wi, 0); remove(s, i); return; }
  } else if (d.seeker === 'arm' && (!(s.flags[t] & F_RADAR) || s.dis[t] & D_SENSORS)) {
    emit(s, E_NOGUIDE, 1 << sd, i, wi, 0); remove(s, i); return; // the emitter shut down
  }
  const ax = inertial ? s.wpX[i * NWP] : s.x[t], ay = inertial ? s.wpY[i * NWP] : s.y[t];
  const ex = ax - s.x[i], ey = ay - s.y[i], dist = Math.sqrt(ex * ex + ey * ey), stepKm = s.spd[i] * DT;
  const p = d.profile;
  const missile = p === 'skim' || p === 'high' || p === 'direct';
  if (missile && live && !inertial) {
    // point defence of the ship under attack: one shot per reaction interval while inside the envelope
    const kt = s.kind[t];
    if ((kt === K_SHIP || kt === K_BASE) && !(s.dis[t] & D_WEAPONS)) {
      const pd = s.db.units[s.def[t]].pd;
      for (let q = 0; q < pd.length; q++) {
        const c = pd[q];
        if (dist < c.min || dist > c.max || s.pdReady[t * NPD + q] > s.tick) continue;
        s.pdReady[t * NPD + q] = s.tick + c.interval;
        CH[0] = c.pHit;
        if (hit(s)) { emit(s, E_PD, 3, t, wi, (s.side[t] << 16) | q); remove(s, i); return; }
      }
    }
  }
  if (dist <= stepKm) {
    s.x[i] = ax; s.y[i] = ay;
    if (d.radiusKm) burst(s, wi, ax, ay, sd); else resolve(s, wi, t, sd);
    if (s.kind[i] === K_WPN) remove(s, i);
    return;
  }
  const ux = ex / dist, uy = ey / dist;
  s.dx[i] = ux; s.dy[i] = uy;
  s.x[i] += ux * stepKm; s.y[i] += uy * stepKm;
  if ((s.fuel[i] -= stepKm) <= 0) { remove(s, i); return; } // ran out of range
  const ta = live ? (s.kind[t] === K_SHIP || s.kind[t] === K_BASE ? 0 : s.alt[t]) : 0;
  if (p === 'high') { const c = d.cruiseM || 12000; s.alt[i] = dist < DIVE_KM ? Math.max(10, (c * dist) / DIVE_KM) : c; }
  else if (p === 'direct') { const a = s.alt[i] + ((ta - s.alt[i]) * stepKm) / dist; s.alt[i] = a < 5 ? 5 : a; }
  else if (p === 'torp') s.alt[i] = ta < -5 ? ta : -5;
  else if (p === 'bomb') { const a = s.alt[i] * (1 - stepKm / dist); s.alt[i] = a < 1 ? 1 : a; }
}

// ---------- automatic weapon release ----------
/**
 * Fire the first mount of u that can engage t. Returns true if something was launched.
 * Offensive salvos are sized to the target: enough hits to sink it, plus two.
 */
function engage(s: Sim, u: number, t: number, offence: boolean): boolean {
  const ex = s.x[t] - s.x[u], ey = s.y[t] - s.y[u], d2 = ex * ex + ey * ey;
  for (let m = 0; m < NM; m++) {
    const o = u * NM + m;
    if (s.mw[o] < 0 || s.ammo[o] === 0 || s.ready[o] > s.tick) continue;
    const d = s.db.weapons[s.mw[o]].d;
    if (d.profile === 'torp') { const r = d.maxKm * TORP_DOCTRINE; if (d2 > r * r) continue; }
    if (offence && d.profile !== 'gun') {
      const need = Math.ceil(s.db.units[s.def[t]].d.hp / d.dmg) + 2; // from the class, not this hull's damage state
      if (s.engaged[t] >= (need < MAX_SALVO ? need : MAX_SALVO)) continue;
    }
    if (fire(s, u, m, t) === 0) return true;
  }
  return false;
}

/**
 * Runs every 4 steps. Defence: every weapons-free unit shoots at tracked hostile aircraft and missiles in reach.
 * Offence: AI-controlled units also shoot at tracked ships, submarines and bases (a quarter of them per run).
 */
function auto(s: Sim): void {
  const cs = s.cellStart, n = s.n, aaR = s.aaR, suR = s.suR, suD = s.suD, slot = s.tick & 3;
  // defence: walk the hostile airborne lists (a quarter of the threats each step), find defenders near each
  for (let sd = 0; sd < 2; sd++) {
    const a = sd === 0 ? s.airN : 0, b = sd === 0 ? MAX : s.airN0; // threats to side sd
    const fa = sd === 0 ? 0 : s.airN, fb = sd === 0 ? s.airN0 : MAX; // side sd's own aircraft
    const base = sd * MAX;
    for (let q = a; q < b; q++) {
      const t = s.airList[q];
      if ((t & 3) !== slot || s.det[base + t] < 2 || s.engaged[t] >= MAX_ON_TARGET || s.kind[t] === K_FREE) continue;
      if (s.kind[t] === K_WPN) {
        // only weapons that attack ships and bases are threats: not bombs, and never another side's SAMs or AAMs
        const wd = s.db.weapons[s.def[t]].d;
        if (wd.profile === 'bomb' || wd.altMin > 0) continue;
      }
      const tx = s.x[t], ty = s.y[t];
      let cx0 = ((tx - DEFEND_KM + HALF) / CELL) | 0, cx1 = ((tx + DEFEND_KM + HALF) / CELL) | 0;
      let cy0 = ((ty - DEFEND_KM + HALF) / CELL) | 0, cy1 = ((ty + DEFEND_KM + HALF) / CELL) | 0;
      if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0; if (cx1 >= GW) cx1 = GW - 1; if (cy1 >= GW) cy1 = GW - 1;
      for (let cy = cy0; cy <= cy1 && s.engaged[t] < MAX_ON_TARGET; cy++) {
        const row = cy * GW;
        for (let p = cs[row + cx0], e = cs[row + cx1 + 1]; p < e && s.engaged[t] < MAX_ON_TARGET; p++) {
          const u = s.cellItems[p], r = aaR[u];
          if (r <= 0 || s.side[u] !== sd || !(s.flags[u] & F_WFREE) || s.dis[u] & D_WEAPONS) continue;
          const ex = s.x[u] - tx, ey = s.y[u] - ty;
          if (ex * ex + ey * ey <= r * r) engage(s, u, t, false);
        }
      }
      // friendly aircraft are not in the grid: walk their compact list
      for (let p = fa; p < fb && s.engaged[t] < MAX_ON_TARGET; p++) {
        const u = s.airList[p], r = aaR[u];
        if (r <= 0 || !(s.flags[u] & F_WFREE) || s.kind[u] !== K_AIR) continue;
        const ex = s.x[u] - tx, ey = s.y[u] - ty;
        if (ex * ex + ey * ey <= r * r) engage(s, u, t, false);
      }
    }
  }
  // offence, AI units only: each unit looks for a target once every 16 steps (8 s)
  for (let u = s.tick & 15; u < n; u += 16) {
    const r = suR[u];
    if (r <= 0 || !(s.flags[u] & F_AI) || s.flags[u] & F_STOWED || s.dis[u] & D_WEAPONS) continue;
    const dmg = suD[u], ux = s.x[u], uy = s.y[u], sd = s.side[u], base = sd * MAX;
    let cx0 = ((ux - r + HALF) / CELL) | 0, cx1 = ((ux + r + HALF) / CELL) | 0;
    let cy0 = ((uy - r + HALF) / CELL) | 0, cy1 = ((uy + r + HALF) / CELL) | 0;
    if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0; if (cx1 >= GW) cx1 = GW - 1; if (cy1 >= GW) cy1 = GW - 1;
    // Rank the tracked targets this unit has a weapon for and that are not already saturated: most valuable
    // first, nearest breaking ties. Two picks are kept so one refusal (no firing solution) does not silence it.
    let best = -1, bd = r * r, bv = -1, second = -1, sv = -1;
    for (let cy = cy0; cy <= cy1; cy++) {
      const row = cy * GW;
      for (let p = cs[row + cx0], e = cs[row + cx1 + 1]; p < e; p++) {
        const t = s.cellItems[p], kt = s.kind[t];
        if (s.side[t] === sd || s.det[base + t] < 2 || kt === K_WPN || kt === K_BUOY) continue;
        const hp = s.db.units[s.def[t]].d.hp, need = Math.ceil(hp / dmg) + 2;
        if (s.engaged[t] >= (need < MAX_SALVO ? need : MAX_SALVO)) continue;
        const ex = s.x[t] - ux, ey = s.y[t] - uy, d2 = ex * ex + ey * ey;
        if (d2 > r * r || !canHit(s, u, t, d2)) continue;
        if (hp > bv || (hp === bv && d2 < bd)) { second = best; sv = bv; bd = d2; bv = hp; best = t; }
        else if (hp > sv) { second = t; sv = hp; }
      }
    }
    if (best >= 0 && !engage(s, u, best, true) && second >= 0) engage(s, u, second, true);
  }
}

/** True if some mount of u, with rounds and ready, covers target t's altitude and its distance (d2 in km squared). */
function canHit(s: Sim, u: number, t: number, d2: number): boolean {
  const kt = s.kind[t];
  for (let m = 0; m < NM; m++) {
    const o = u * NM + m;
    if (s.mw[o] < 0 || s.ammo[o] === 0 || s.ready[o] > s.tick) continue;
    const d = s.db.weapons[s.mw[o]].d;
    H[0] = kt === K_SHIP || kt === K_BASE ? 0 : s.alt[t];
    if (H[0] < d.altMin || H[0] > d.altMax || d2 < d.minKm * d.minKm) continue;
    H[0] = d.profile === 'torp' ? d.maxKm * TORP_DOCTRINE : d.maxKm;
    if (d2 <= H[0] * H[0]) return true;
  }
  return false;
}

hooks.weapon = fly;
hooks.auto = auto;
addOrderHandler(O_FIRE, (s, o) => fire(s, o[2], o[3], o[4]));
