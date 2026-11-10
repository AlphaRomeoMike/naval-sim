// Enemy AI: patrol, detect, attack, evade, return to base. Weapon release itself is the doctrine in combat.ts;
// this module decides where units go, what they switch on, and when aircraft launch and come home.
// It is part of the deterministic sim (never logged) and uses only what its side knows: a track's position,
// a bearing-only contact's bearing from the sensor that holds it (never its range), and last tracked positions.
import {
  type Sim, MAX, NM, NWP, CELL, GW, HALF, KTS,
  K_FREE, K_SHIP, K_SUB, K_AIR, K_BASE, K_WPN, K_BUOY, F_ACTIVE, F_STOWED, F_RTB, F_LOOP, F_AI, D_DECK, D_PROP,
  hooks, canEngage,
} from './sim';
import { launch, rtb, dropBuoy } from './air';

export const A_PATROL = 0, A_ATTACK = 1, A_EVADE = 2;
const EVADE_TICKS = 600; // 5 minutes
const TORP_ALARM_KM = 12;
const SUB_HUNT_KM = 40;
const IDLE_TICKS = 1200; // an aircraft with nothing to do for 10 minutes goes home
const SEARCH_TICKS = 7200; // a lost target is looked for at its last tracked position for up to an hour

// Doubles that cross function calls live in typed arrays: a double argument, return value or module-level `let`
// is boxed on the heap when the call is not inlined.
const P = new Float64Array(2); // go-to point
const R = new Float64Array(2); // [0] distance squared from scan() or reach from reachFor(); [1] search radius for scan()
const Q = new Float64Array(4); // scratch: a contact's known position, a direction, a target altitude, a best distance
/** Send unit i to the point in P. */
function go(s: Sim, i: number): void {
  const x = P[0], y = P[1];
  s.wpN[i] = 1; s.flags[i] &= ~F_LOOP;
  s.wpX[i * NWP] = x < -HALF + 1 ? -HALF + 1 : x > HALF - 1 ? HALF - 1 : x;
  s.wpY[i * NWP] = y < -HALF + 1 ? -HALF + 1 : y > HALF - 1 ? HALF - 1 : y;
}
function resumePatrol(s: Sim, i: number): void {
  const n = s.pwN[i];
  for (let w = 0; w < n; w++) { s.wpX[i * NWP + w] = s.pwX[i * NWP + w]; s.wpY[i * NWP + w] = s.pwY[i * NWP + w]; }
  s.wpN[i] = n;
  if (n > 0) s.flags[i] |= F_LOOP;
  s.ordSpd[i] = s.pSpd[i]; s.ordAlt[i] = s.pAlt[i];
  s.ai[i] = A_PATROL; // s.tgt is kept: the last target can still be searched for
}

/** Longest weapon of unit i, with rounds left, whose altitude band reaches target t. Written to R[0]. */
function reachFor(s: Sim, i: number, t: number): void {
  Q[2] = s.kind[t] === K_SHIP || s.kind[t] === K_BASE ? 0 : s.alt[t];
  R[0] = 0;
  for (let m = 0; m < NM; m++) {
    const wi = s.mw[i * NM + m];
    if (wi < 0 || s.ammo[i * NM + m] === 0) continue;
    const d = s.db.weapons[wi].d;
    if (Q[2] >= d.altMin && Q[2] <= d.altMax && d.maxKm > R[0]) R[0] = d.maxKm;
  }
}

/** True if unit i has a weapon with rounds left for that kind of target (a submarine, or something on the surface). */
function armedFor(s: Sim, i: number, kind: number): boolean {
  for (let m = 0; m < NM; m++) {
    const wi = s.mw[i * NM + m];
    if (wi < 0 || s.ammo[i * NM + m] === 0) continue;
    const d = s.db.weapons[wi].d;
    if (kind === K_SUB ? d.altMin < 0 : d.altMin <= 0 && d.altMax >= 0) return true;
  }
  return false;
}

// search result index (a small integer: not boxed)
let found = -1;

/**
 * Scan the grid around unit i for hostile surface/subsurface entities its side knows about.
 * mode 0: nearest torpedo; 1: nearest submarine contact (bearing or track); 2: most valuable tracked ship,
 * submarine or base this unit has a weapon for (nearest breaks ties); 3: nearest bearing-only ship or submarine;
 * 4: nearest pinging sonobuoy. The search radius is read from R[1].
 * Result in `found` (-1 if none), distance squared in R[0].
 * A bearing-only contact has no range, so the distance used for it is the distance to the sensor that holds it.
 */
function scan(s: Sim, i: number, mode: number): void {
  const r = R[1], x = s.x[i], y = s.y[i], sd = s.side[i], base = sd * MAX, cs = s.cellStart;
  let cx0 = ((x - r + HALF) / CELL) | 0, cx1 = ((x + r + HALF) / CELL) | 0;
  let cy0 = ((y - r + HALF) / CELL) | 0, cy1 = ((y + r + HALF) / CELL) | 0;
  if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0; if (cx1 >= GW) cx1 = GW - 1; if (cy1 >= GW) cy1 = GW - 1;
  let best = -1, bv = -1;
  Q[3] = r * r; // best distance so far
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let p = cs[cy * GW + cx0], e = cs[cy * GW + cx1 + 1]; p < e; p++) {
      const t = s.cellItems[p], k = s.kind[t], lvl = s.det[base + t];
      if (s.side[t] === sd || lvl === 0) continue;
      if (mode === 0 ? k !== K_WPN : mode === 1 ? k !== K_SUB : mode === 2 ? lvl < 2 || (k !== K_SHIP && k !== K_SUB && k !== K_BASE)
        : mode === 3 ? lvl !== 1 || (k !== K_SHIP && k !== K_SUB) : k !== K_BUOY) continue;
      if (lvl === 2) { Q[0] = s.x[t]; Q[1] = s.y[t]; }
      else {
        const h = s.holder[base + t];
        if (h < 0 || s.kind[h] === K_FREE) continue;
        Q[0] = s.x[h]; Q[1] = s.y[h];
      }
      const ex = Q[0] - x, ey = Q[1] - y, d2 = ex * ex + ey * ey;
      if (d2 > r * r) continue;
      let v = 0;
      if (mode === 2) { reachFor(s, i, t); if (R[0] === 0) continue; v = s.db.units[s.def[t]].d.hp; } // nothing aboard can hit it
      if (v > bv || (v === bv && d2 < Q[3])) { Q[3] = d2; bv = v; best = t; }
    }
  }
  found = best; R[0] = Q[3];
}

/** Nearest tracked hostile aircraft within R[1] km of unit i (missiles only if no aircraft). */
function scanAir(s: Sim, i: number): void {
  const r = R[1], sd = s.side[i], base = sd * MAX, a = sd === 0 ? s.airN : 0, b = sd === 0 ? MAX : s.airN0;
  let best = -1, bestIsAir = false;
  Q[3] = r * r;
  for (let q = a; q < b; q++) {
    const t = s.airList[q];
    if (s.det[base + t] < 2) continue;
    const ex = s.x[t] - s.x[i], ey = s.y[t] - s.y[i], d2 = ex * ex + ey * ey, isAir = s.kind[t] === K_AIR;
    if (d2 > r * r || (bestIsAir && !isAir)) continue;
    if (d2 < Q[3] || (isAir && !bestIsAir)) { Q[3] = d2; best = t; bestIsAir = isAir; }
  }
  found = best; R[0] = Q[3];
}

/**
 * Unit direction that leads unit i away from contact t, as the side knows it, into Q[0], Q[1].
 * A track gives it directly; a bearing gives the line from the holding sensor through the contact.
 */
function awayFrom(s: Sim, i: number, t: number): void {
  const c = s.side[i] * MAX + t;
  let h = s.det[c] === 2 ? i : s.holder[c];
  if (h < 0 || s.kind[h] === K_FREE) h = i;
  const ex = s.x[h] - s.x[t], ey = s.y[h] - s.y[t], d = Math.sqrt(ex * ex + ey * ey) + 1e-9;
  Q[0] = ex / d; Q[1] = ey / d;
}

function thinkSurface(s: Sim, i: number): void {
  const u = s.db.units[s.def[i]], k = s.kind[i];
  // evade: a torpedo in the water nearby beats everything else
  R[1] = TORP_ALARM_KM; scan(s, i, 0);
  if (found >= 0 && !(s.dis[i] & D_PROP)) {
    awayFrom(s, i, found);
    P[0] = s.x[i] + Q[0] * 30; P[1] = s.y[i] + Q[1] * 30; go(s, i); // run straight away from it
    s.ordSpd[i] = u.maxKmps;
    if (k === K_SUB) s.ordAlt[i] = s.alt[i] > -s.layer ? -(s.layer + 60) : -40; // and cross the layer
    else if (u.activeKm > 0) s.flags[i] |= F_ACTIVE; // a torpedo means a submarine: start pinging for it
    s.ai[i] = A_EVADE; s.aiT[i] = s.tick + EVADE_TICKS;
    return;
  }
  if (k === K_SUB && s.ai[i] !== A_EVADE) {
    // a submarine that has just fired is loud, and one being pinged by a buoy has been found: either way clear
    // the datum on a new heading and change layer
    let moveOff = s.busy[i] > s.tick;
    if (moveOff) {
      const t = s.tgt[i], c = s.side[i] * MAX + t;
      if (t >= 0 && s.gen[t] === s.tgtGen[i] && s.lastT[c] >= 0) { // away from where the target was last tracked
        const ex = s.x[i] - s.lastX[c], ey = s.y[i] - s.lastY[c], d = Math.sqrt(ex * ex + ey * ey) + 1e-9;
        Q[0] = ex / d; Q[1] = ey / d;
      } else { Q[0] = -s.dy[i]; Q[1] = s.dx[i]; } // no fix to work from: turn ninety degrees
    } else {
      R[1] = 20; scan(s, i, 4);
      if (found >= 0) { moveOff = true; awayFrom(s, i, found); }
    }
    if (moveOff) {
      P[0] = s.x[i] + Q[0] * 6 - Q[1] * 6; P[1] = s.y[i] + Q[1] * 6 + Q[0] * 6; go(s, i);
      s.ordSpd[i] = Math.min(u.maxKmps, 14 * KTS);
      s.ordAlt[i] = s.alt[i] > -s.layer ? -(s.layer + 60) : -40;
      s.ai[i] = A_EVADE; s.aiT[i] = s.tick + EVADE_TICKS / 2;
      return;
    }
  }
  if (s.ai[i] === A_EVADE) { if (s.tick < s.aiT[i]) return; resumePatrol(s, i); }
  // sensors: ships go active when a submarine is about, and listen otherwise; submarines never ping
  if (k === K_SHIP && u.activeKm > 0) {
    R[1] = SUB_HUNT_KM; scan(s, i, 1);
    if (found >= 0) s.flags[i] |= F_ACTIVE; else s.flags[i] &= ~F_ACTIVE;
  }
  const r = s.suR[i];
  if (r > 0) {
    // attack: close on the most valuable tracked target this unit can actually hit, to half that weapon's range
    R[1] = Math.max(r * 1.5, 60); scan(s, i, 2);
    if (found >= 0) {
      const t = found, d2 = R[0];
      reachFor(s, i, t);
      const want = R[0] * 0.5;
      if (d2 > want * want) {
        P[0] = s.x[t]; P[1] = s.y[t]; go(s, i);
        s.ordSpd[i] = k === K_SUB ? Math.min(u.maxKmps, 12 * KTS) : u.maxKmps * 0.8;
      } else if (k === K_SUB) s.wpN[i] = 0; // in position: stop and stay quiet
      s.ai[i] = A_ATTACK; s.tgt[i] = t; s.tgtGen[i] = s.gen[t];
      return;
    }
    // investigate: nothing tracked, but this unit's own sensors hold a bearing on something it is armed for,
    // so run down the bearing to firm it up
    R[1] = 90; scan(s, i, 3);
    if (found >= 0 && s.holder[s.side[i] * MAX + found] === i && armedFor(s, i, s.kind[found])) {
      const t = found, ex = s.x[t] - s.x[i], ey = s.y[t] - s.y[i], d = Math.sqrt(ex * ex + ey * ey) + 1e-9;
      P[0] = s.x[i] + (ex / d) * 12; P[1] = s.y[i] + (ey / d) * 12; go(s, i); // 12 km along the bearing; range is unknown
      s.ordSpd[i] = k === K_SUB ? Math.min(u.maxKmps, 10 * KTS) : u.cruiseKmps;
      s.ai[i] = A_ATTACK; s.tgt[i] = t; s.tgtGen[i] = s.gen[t];
      return;
    }
    // search: something this unit is armed for has dropped off the plot (a ship dead in the water is nearly
    // silent), so go to where it was last tracked. Uses the side's own record of lost contacts, never a true position.
    let lt = -1;
    Q[3] = 1e12;
    for (let q = s.side[i] * 8, e = q + 8; q < e; q++) {
      const t = s.lostId[q];
      if (t < 0 || s.gen[t] !== s.lostGen[q] || (s.kind[t] !== K_SHIP && s.kind[t] !== K_SUB)) continue;
      const c = s.side[i] * MAX + t;
      if (s.det[c] !== 0 || s.lastT[c] < 0 || s.tick - s.lastT[c] >= SEARCH_TICKS || !armedFor(s, i, s.kind[t])) continue;
      const ex = s.lastX[c] - s.x[i], ey = s.lastY[c] - s.y[i], d2 = ex * ex + ey * ey;
      if (d2 < Q[3] && d2 < 60 * 60) { Q[3] = d2; lt = t; } // the nearest datum within 60 km
    }
    if (lt >= 0) {
      const c = s.side[i] * MAX + lt;
      if (Q[3] > 4) { P[0] = s.lastX[c]; P[1] = s.lastY[c]; go(s, i); s.ordSpd[i] = k === K_SUB ? Math.min(u.maxKmps, 8 * KTS) : u.cruiseKmps; }
      else s.wpN[i] = 0; // on the datum: stop and listen
      s.ai[i] = A_ATTACK; s.tgt[i] = lt; s.tgtGen[i] = s.gen[lt];
      return;
    }
  }
  s.tgt[i] = -1;
  // back to the patrol route: after an attack, or if the route was dropped (a ship stops when it meets shoal water)
  if (s.ai[i] === A_ATTACK || (s.wpN[i] === 0 && s.pwN[i] > 0)) resumePatrol(s, i);
}

/** Drop the first buoy type of the wanted kind (active or passive). Returns true if one went into the water. */
function buoy(s: Sim, i: number, active: boolean, deep: number): boolean {
  for (let b = 0; b < 4 && b < s.db.buoys.length; b++) {
    const d = s.db.buoys[b].d;
    if ((active ? d.activeKm > 0 : d.passiveKm > 0) && dropBuoy(s, i, b, deep) === 0) return true;
  }
  return false;
}

function thinkAir(s: Sim, i: number): void {
  if (s.flags[i] & F_RTB) return;
  const u = s.db.units[s.def[i]], role = u.d.role;
  const buoyLeft = s.buoyN[i * 4] + s.buoyN[i * 4 + 1] + s.buoyN[i * 4 + 2] + s.buoyN[i * 4 + 3];
  if (s.aaR[i] === 0 && s.suR[i] === 0) { // winchester: go home to rearm
    if (rtb(s, i) !== 0) s.wpN[i] = 0;
    return;
  }
  if (role === 'helo') {
    R[1] = 80; scan(s, i, 1);
    if (found >= 0) {
      const t = found, lvl = s.det[s.side[i] * MAX + t];
      s.ai[i] = A_ATTACK; s.tgt[i] = t; s.tgtGen[i] = s.gen[t]; s.aiT[i] = s.tick;
      if (lvl === 2) {
        P[0] = s.x[t] + 1.5; P[1] = s.y[t]; go(s, i); // stand off 1.5 km; the doctrine drops the torpedo once in range
        // Someone else's track is not a firing solution without datalink: ping to get a hold of its own.
        // The depth alternates, since a track gives position, not which side of the layer.
        const ex = s.x[t] - s.x[i], ey = s.y[t] - s.y[i];
        if (ex * ex + ey * ey < 9 && s.tick >= s.busy[i] && !canEngage(s, i, t) && buoy(s, i, true, buoyLeft & 1)) s.busy[i] = s.tick + 360;
        return;
      }
      const h = s.holder[s.side[i] * MAX + t];
      if (h < 0 || s.kind[h] === K_FREE) return;
      // bearing only: go two kilometres down the bearing from the sensor that hears it and ping
      const ex = s.x[t] - s.x[h], ey = s.y[t] - s.y[h], d = Math.sqrt(ex * ex + ey * ey) + 1e-9;
      P[0] = s.x[h] + (ex / d) * 2; P[1] = s.y[h] + (ey / d) * 2; go(s, i);
      const qx = s.x[i] - P[0], qy = s.y[i] - P[1];
      if (qx * qx + qy * qy < 1 && s.tick >= s.busy[i] && buoy(s, i, true, buoyLeft & 1)) s.busy[i] = s.tick + 600;
      return;
    }
    // no contact: screen 12 km ahead of the mother ship, seeding passive buoys every four minutes
    const h = s.host[i];
    if (h >= 0 && s.kind[h] !== K_FREE && s.gen[h] === s.hostGen[i]) {
      P[0] = s.x[h] + s.dx[h] * 12; P[1] = s.y[h] + s.dy[h] * 12; go(s, i);
      if (buoyLeft > 0 && s.tick >= s.busy[i] && buoy(s, i, false, (s.tick >> 9) & 1)) s.busy[i] = s.tick + 480;
    }
    return;
  }
  // strike: fly at the most valuable tracked surface target it can hit until inside 85% of weapon range
  const r = s.suR[i];
  if (r > 0) {
    R[1] = Math.max(r * 1.3, 150); scan(s, i, 2);
    if (found >= 0) {
      const t = found, d2 = R[0];
      s.ai[i] = A_ATTACK; s.tgt[i] = t; s.tgtGen[i] = s.gen[t]; s.aiT[i] = s.tick;
      reachFor(s, i, t);
      if (d2 > R[0] * R[0] * 0.72) { P[0] = s.x[t]; P[1] = s.y[t]; go(s, i); s.ordSpd[i] = u.cruiseKmps; }
      return;
    }
  }
  // air-to-air: run down the nearest tracked hostile aircraft, missiles if there are no aircraft
  if (s.aaR[i] > 0) {
    R[1] = 450; scanAir(s, i);
    if (found >= 0) {
      const t = found;
      s.ai[i] = A_ATTACK; s.tgt[i] = t; s.tgtGen[i] = s.gen[t]; s.aiT[i] = s.tick;
      P[0] = s.x[t]; P[1] = s.y[t]; go(s, i);
      s.ordSpd[i] = u.maxKmps;
      R[0] = s.alt[t]; // clamp to the airframe, through scratch so nothing is boxed
      R[1] = u.d.minAltM || 60; if (R[0] < R[1]) R[0] = R[1];
      R[1] = u.d.maxAltM || 10000; if (R[0] > R[1]) R[0] = R[1];
      s.ordAlt[i] = R[0];
      return;
    }
  }
  if (s.ai[i] === A_ATTACK) { resumePatrol(s, i); s.aiT[i] = s.tick; }
  else if (s.pwN[i] === 0 && s.tick - s.aiT[i] > IDLE_TICKS) rtb(s, i); // nothing to do: go home
}

/** Launch decisions for a ship or base with aircraft on deck: at most one launch per call. */
function deckOps(s: Sim, h: number): void {
  if (s.dis[h] & D_DECK || s.busy[h] > s.tick) return;
  let wantFighter = -1, wantStrike = -1, wantHelo = -1, heloUp = false; // -1 = not evaluated yet, 0 no, 1 yes
  for (let j = 0; j < s.n; j++) {
    if (s.kind[j] !== K_AIR || s.host[j] !== h || s.hostGen[j] !== s.gen[h]) continue;
    const role = s.db.units[s.def[j]].d.role;
    if (!(s.flags[j] & F_STOWED)) { if (role === 'helo') heloUp = true; continue; }
    if (s.busy[j] > s.tick) continue;
    let need = false;
    if (role === 'helo') {
      if (wantHelo < 0) { R[1] = 80; scan(s, h, 1); wantHelo = found >= 0 ? 1 : 0; }
      // one helicopter is kept up as a screen; more go up when a submarine is about
      need = wantHelo === 1 || (!heloUp && s.kind[h] === K_SHIP);
      if (need) heloUp = true;
    } else if (s.aaR[j] > 0 && s.suR[j] === 0) {
      if (wantFighter < 0) { R[1] = 450; scanAir(s, h); wantFighter = found >= 0 ? 1 : 0; }
      need = wantFighter === 1;
    } else {
      // Strike aircraft go when a ship or base they can hit is tracked. scan() ranks by what the asker can hit,
      // so it is asked as the aircraft (a stowed aircraft sits at its host's position).
      if (wantStrike < 0) { R[1] = 900; scan(s, j, 2); wantStrike = found >= 0 && s.kind[found] !== K_SUB ? 1 : 0; }
      need = wantStrike === 1;
    }
    if (need && launch(s, j, -1) === 0) { s.ai[j] = A_PATROL; s.aiT[j] = s.tick; s.pwN[j] = 0; s.pSpd[j] = s.ordSpd[j]; s.pAlt[j] = s.ordAlt[j]; return; }
  }
}

/** Runs every step on one sixteenth of the units: each AI unit thinks once every 16 steps (8 s). */
function ai(s: Sim): void {
  for (let i = s.tick & 15; i < s.n; i += 16) {
    if (!(s.flags[i] & F_AI)) continue;
    const k = s.kind[i];
    if (k === K_FREE || k === K_WPN || k === K_BUOY || s.flags[i] & F_STOWED) continue;
    if ((k === K_SHIP || k === K_BASE) && s.db.units[s.def[i]].d.deck) deckOps(s, i);
    if (k === K_AIR) thinkAir(s, i); else if (k !== K_BASE) thinkSurface(s, i);
  }
}

hooks.ai = ai;
