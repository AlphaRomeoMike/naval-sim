// Data schema for tier files (public/data/free.json, server/packs/*.json).
// All numbers are GAME VALUES: static simplifications of public figures, not real performance data.

export type Seeker =
  | 'sarh' // semi-active radar: needs a fire-control channel on the launcher for the whole flight
  | 'cmd' // command guidance: also holds a fire-control channel
  | 'arh' // active radar, fire-and-forget
  | 'ir' // infrared, fire-and-forget
  | 'arm' // anti-radiation: target radar must be emitting
  | 'acoustic' // torpedo homing
  | 'inertial' // flies to the aim point fixed at launch (use with radiusKm)
  | 'laser'
  | 'gps' // only usable against stationary targets
  | 'none'; // guns, unguided bombs, rockets

export type Profile =
  | 'skim' // sea-skimming cruise at 10 m
  | 'high' // high-altitude cruise (cruiseM), dives in the last 20 km
  | 'direct' // flies straight at the target's altitude (SAM / AAM)
  | 'torp' // runs underwater
  | 'bomb' // falls from the releasing aircraft
  | 'gun'; // resolved instantly, no projectile entity

export interface WeaponDef {
  name: string; // designation shown in game (no manufacturer trademarks)
  minKm: number;
  maxKm: number;
  kts: number; // weapon speed in knots (ignored for profile 'gun')
  seeker: Seeker;
  profile: Profile;
  cruiseM?: number; // cruise altitude for profile 'high' (default 12000)
  altMin: number; // target altitude band in metres: <0 submerged, 0 surface, >0 airborne
  altMax: number;
  pHit: number; // base hit chance 0..1
  dmg: number; // hit points removed on a hit
  radiusKm?: number; // area effect radius (e.g. SUBROC)
  src: string; // URL the values were derived from
}

export interface RadarDef {
  name: string;
  airKm: number; // static range against airborne targets (still limited by radar horizon)
  surfKm: number; // static range against surface targets (still limited by radar horizon)
}

export interface SonarDef {
  name: string;
  passiveKm: number; // base passive range against a target with noise factor 1; 0 = none
  activeKm: number; // active range; 0 = none
  towed?: boolean; // towed array / VDS: listens from below the thermocline
}

export interface MountDef {
  w: string; // weapon id
  n: number; // rounds carried
  reloadS: number; // seconds between shots
  l?: number; // launcher group: mounts sharing a number share one reload timer (Mk 13, torpedo tubes)
}

export interface PdDef {
  name: string; // point-defence system: one shot per intervalS at each missile inside the envelope
  minKm: number;
  maxKm: number;
  intervalS: number;
  pHit: number;
}

export interface UnitDef {
  name: string; // designation, e.g. "FFG-7 (short hull)"
  side: 'us' | 'ussr';
  cls: 'ship' | 'sub' | 'air' | 'helo' | 'base';
  role: string; // swap group for the fit-out screen: frigate | helo | fighter | sub | surface | bomber | carrier | base | merchant
  hp: number; // ships/subs: round(full-load tons / 40); aircraft: 10; base: 400
  kts: number; // max speed
  cruiseKts: number;
  heightM: number; // ships/bases: antenna height for radar horizon and radio; aircraft: 0 (altitude is used)
  noise: number; // passive-sonar signature factor at max speed (1 = average warship, 0.3 = quiet sub, 0 = aircraft)
  minAltM?: number; // aircraft only: altitude caps
  maxAltM?: number;
  fuelMin?: number; // aircraft only: endurance in minutes at cruise
  turnMin?: number; // aircraft only: deck turnaround in minutes
  maxDepthM?: number; // subs only
  radar?: RadarDef;
  sonar?: SonarDef[];
  fc: number; // fire-control channels for sarh/cmd weapons
  link: boolean; // datalink: can pass and receive third-party targeting within radio range
  chaff: number; // multiplier on incoming radar/IR-guided hit chance (1 = no decoys, 0.7 = good decoys)
  jam: number; // multiplier on incoming radar-guided hit chance (1 = no jammer)
  nixie: number; // multiplier on incoming acoustic torpedo hit chance (1 = no torpedo decoy)
  mounts: MountDef[]; // ships/subs/bases: fixed weapons (max 8). Aircraft: leave empty, use loadouts
  pd: PdDef[]; // max 4
  deck?: { slots: number; launchS: number }; // aircraft capacity and seconds between launches
  hosts?: string[]; // aircraft only: unit ids this airframe may operate from
  carries?: string[]; // ships/bases: extra aircraft ids that may embark here (lets a paid ship host a free aircraft)
  loadouts?: Record<string, { w: string; n: number }[]>; // aircraft only: named loadouts (max 8 entries each)
  buoys?: Record<string, number>; // aircraft only: sonobuoy stock by buoy id
  src: string; // URL the values were derived from
}

export interface BuoyDef {
  name: string;
  passiveKm: number; // 0 for active-only buoys
  activeKm: number; // 0 for passive buoys
  lifeMin: number;
  src: string;
}

export interface TierData {
  note: string; // must say these are game values
  weapons: Record<string, WeaponDef>;
  buoys: Record<string, BuoyDef>;
  units: Record<string, UnitDef>;
}
