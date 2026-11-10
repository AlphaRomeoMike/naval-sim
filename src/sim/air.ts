// Aircraft and helicopter operations: launch, fuel, recovery, sonobuoys.
import {
  type Sim, NWP, DT, K_FREE, K_SHIP, K_AIR, K_BASE, K_BUOY, F_STOWED, F_RTB, F_ACTIVE, F_LOOP, D_DECK,
  O_LAUNCH, O_RTB, O_BUOY, E_AIROP, E_BINGO, E_BUOY, hooks, addOrderHandler, spawn, free, emit, arm, depthAt,
} from './sim';

const RECOVER_KM = 1.5;

function deckOk(s: Sim, i: number, v: number): boolean {
  const k = s.kind[v];
  if ((k !== K_SHIP && k !== K_BASE) || s.side[v] !== s.side[i] || s.dis[v] & D_DECK) return false;
  const a = s.db.units[s.def[i]], u = s.db.units[s.def[v]];
  if (!u.d.deck || !(a.hosts.includes(u.id) || (u.d.carries || []).includes(a.id))) return false;
  if (s.host[i] === v && s.hostGen[i] === s.gen[v]) return true; // its own spot is kept for it
  let used = 0; // a diversion needs a free spot: count everything that already calls this deck home
  for (let j = 0; j < s.n; j++) if (s.kind[j] === K_AIR && s.host[j] === v && s.hostGen[j] === s.gen[v]) used++;
  return used < u.d.deck.slots;
}

/** Nearest friendly deck this airframe may use (its own host first), or -1. */
export function findDeck(s: Sim, i: number): number {
  const h = s.host[i];
  if (h >= 0 && s.gen[h] === s.hostGen[i] && deckOk(s, i, h)) return h;
  let best = -1, bd = Infinity;
  for (let v = 0; v < s.n; v++) {
    if (!deckOk(s, i, v)) continue;
    const ex = s.x[v] - s.x[i], ey = s.y[v] - s.y[i], d2 = ex * ex + ey * ey;
    if (d2 < bd) { bd = d2; best = v; }
  }
  return best;
}

export function launch(s: Sim, j: number, lo: number): number {
  if (s.kind[j] !== K_AIR || !(s.flags[j] & F_STOWED)) return 1;
  const h = s.host[j];
  if (h < 0 || s.kind[h] === K_FREE || s.gen[h] !== s.hostGen[j]) return 1;
  if (s.dis[h] & D_DECK) return 13;
  if (s.busy[h] > s.tick) return 14;
  if (s.busy[j] > s.tick) return 15;
  const u = s.db.units[s.def[j]], deck = s.db.units[s.def[h]].d.deck;
  if (Number.isInteger(lo) && lo >= 0 && lo < u.loadouts.length) arm(s, j, lo); else arm(s, j, s.lo[j]); // anything else: the default
  s.flags[j] &= ~(F_STOWED | F_RTB | F_LOOP);
  s.x[j] = s.x[h]; s.y[j] = s.y[h]; s.wpN[j] = 0;
  s.alt[j] = u.d.minAltM || 15;
  s.ordAlt[j] = u.d.cls === 'helo' ? 150 : Math.min(u.d.maxAltM || 3000, 3000);
  s.spd[j] = u.cruiseKmps; s.ordSpd[j] = u.cruiseKmps;
  s.fuel[j] = (u.d.fuelMin || 120) * 60;
  s.busy[h] = s.tick + Math.ceil((deck ? deck.launchS : 60) / DT);
  emit(s, E_AIROP, 1 << s.side[j], j, 0, 0);
  return 0;
}

export function rtb(s: Sim, i: number): number {
  if (s.kind[i] !== K_AIR || s.flags[i] & F_STOWED) return 11;
  const h = findDeck(s, i);
  if (h < 0) return 17;
  s.host[i] = h; s.hostGen[i] = s.gen[h];
  s.flags[i] = (s.flags[i] | F_RTB) & ~F_LOOP;
  return 0;
}

export function dropBuoy(s: Sim, i: number, b: number, deep: number): number {
  if (s.kind[i] !== K_AIR || s.flags[i] & F_STOWED) return 11;
  if (b < 0 || b >= 4 || b >= s.db.buoys.length || s.buoyN[i * 4 + b] === 0) return 16;
  const d = s.db.buoys[b].d;
  const want = deep ? s.layer + 50 : 20, floor = depthAt(s, s.x[i], s.y[i]) - 5; // the sea under the aircraft, not under its ship
  const j = spawn(s, K_BUOY, s.side[i], b, s.x[i], s.y[i], -(want < floor ? want : floor > 1 ? floor : 1));
  if (j < 0) return 1;
  s.buoyN[i * 4 + b]--;
  s.host[j] = i; s.hostGen[j] = s.gen[i];
  s.fuel[j] = d.lifeMin * 60;
  if (d.activeKm > 0) s.flags[j] = F_ACTIVE;
  emit(s, E_BUOY, 1 << s.side[i], i, b, 0);
  return 0;
}

/** Per-step upkeep of one airborne aircraft: fuel, bingo, flying home, landing. */
function upkeep(s: Sim, i: number): void {
  const u = s.db.units[s.def[i]];
  if ((s.fuel[i] -= s.spd[i] > u.cruiseKmps * 1.1 ? DT * 2 : DT) <= 0) {
    emit(s, E_AIROP, 1 << s.side[i], i, 2, 0);
    free(s, i);
    return;
  }
  const check = (i & 63) === (s.tick & 63); // fuel state and decks are re-checked every 32 s
  if (!(s.flags[i] & F_RTB)) {
    if (!check) return;
    const h = findDeck(s, i);
    if (h < 0) return;
    const ex = s.x[h] - s.x[i], ey = s.y[h] - s.y[i];
    // bingo: time home at cruise speed plus a quarter, plus two minutes
    if (s.fuel[i] < (Math.sqrt(ex * ex + ey * ey) / u.cruiseKmps) * 1.25 + 120) {
      s.host[i] = h; s.hostGen[i] = s.gen[h];
      s.flags[i] = (s.flags[i] | F_RTB) & ~F_LOOP;
      emit(s, E_BINGO, 1 << s.side[i], i, 0, 0);
    }
    return;
  }
  let h = s.host[i];
  if (h < 0 || s.kind[h] === K_FREE || s.gen[h] !== s.hostGen[i] || s.dis[h] & D_DECK) {
    if (!check) return;
    h = findDeck(s, i);
    if (h < 0) { s.wpN[i] = 0; return; } // nowhere to land: orbit and keep looking
    s.host[i] = h; s.hostGen[i] = s.gen[h];
  }
  const ex = s.x[h] - s.x[i], ey = s.y[h] - s.y[i];
  if (ex * ex + ey * ey <= RECOVER_KM * RECOVER_KM) {
    s.flags[i] = (s.flags[i] | F_STOWED) & ~F_RTB;
    s.alt[i] = 0; s.spd[i] = 0; s.wpN[i] = 0; s.tgt[i] = -1;
    s.busy[i] = s.tick + Math.ceil(((u.d.turnMin || 20) * 60) / DT);
    arm(s, i, s.lo[i]); // refuelled, rearmed and restocked with buoys for the next launch
    emit(s, E_AIROP, 1 << s.side[i], i, 1, 0);
    return;
  }
  s.wpX[i * NWP] = s.x[h]; s.wpY[i * NWP] = s.y[h]; s.wpN[i] = 1;
  if (s.ordSpd[i] < u.cruiseKmps) s.ordSpd[i] = u.cruiseKmps;
}

hooks.air = upkeep;
addOrderHandler(O_LAUNCH, (s, o) => launch(s, o[2], o[3]));
addOrderHandler(O_RTB, (s, o) => rtb(s, o[2]));
addOrderHandler(O_BUOY, (s, o) => dropBuoy(s, o[2], o[3], o[4]));
