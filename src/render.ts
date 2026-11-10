// Canvas 2D drawing. Two stacked canvases: land (redrawn only when the view changes) and units.
import { SNAP_HDR, SNAP_REC, K_SHIP, K_SUB, K_AIR, K_BASE, K_WPN, K_BUOY, HALF, F_STOWED } from './sim/sim';
import type { Projected } from './map';
import type { Info } from './sim/sim';

export interface View { x: number; y: number; z: number; w: number; h: number; dpr: number }

const OCEAN = '#0b1c2c', LAND = '#26343c', COAST = '#44596a', GRID = 'rgba(120,160,190,0.10)';
export const OWN = '#6fd3ff', FOE = '#ff7a66', DIM = 'rgba(200,220,235,0.55)';

export function drawLand(c: CanvasRenderingContext2D, v: View, land: Projected | null): void {
  const { w, h, z } = v;
  c.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  c.fillStyle = OCEAN;
  c.fillRect(0, 0, w, h);
  const x0 = v.x - w / 2 / z, x1 = v.x + w / 2 / z, y0 = v.y - h / 2 / z, y1 = v.y + h / 2 / z;
  if (land) {
    c.beginPath();
    for (let r = 0; r < land.rings; r++) {
      const b = r * 4;
      if (land.bbox[b] > x1 || land.bbox[b + 2] < x0 || land.bbox[b + 1] > y1 || land.bbox[b + 3] < y0) continue;
      let lx = -1e9, ly = -1e9;
      for (let i = land.start[r], e = land.start[r + 1]; i < e; i++) {
        const sx = (land.xy[i * 2] - v.x) * z + w / 2, sy = h / 2 - (land.xy[i * 2 + 1] - v.y) * z;
        if (lx === -1e9) c.moveTo(sx, sy);
        else if (Math.abs(sx - lx) + Math.abs(sy - ly) < 1 && i < e - 1) continue; // sub-pixel: skip
        else c.lineTo(sx, sy);
        lx = sx; ly = sy;
      }
    }
    c.fillStyle = LAND;
    c.fill('evenodd');
    c.strokeStyle = COAST;
    c.lineWidth = 1;
    c.stroke();
  }
  // 100 km grid and the edge of the play area
  const stepKm = z > 2 ? 10 : z > 0.4 ? 100 : 500;
  c.strokeStyle = GRID;
  c.beginPath();
  for (let gx = Math.ceil(x0 / stepKm) * stepKm; gx <= x1; gx += stepKm) { const sx = (gx - v.x) * z + w / 2; c.moveTo(sx, 0); c.lineTo(sx, h); }
  for (let gy = Math.ceil(y0 / stepKm) * stepKm; gy <= y1; gy += stepKm) { const sy = h / 2 - (gy - v.y) * z; c.moveTo(0, sy); c.lineTo(w, sy); }
  c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.25)';
  c.setLineDash([6, 6]);
  c.strokeRect((-HALF - v.x) * z + w / 2, h / 2 - (HALF - v.y) * z, 2 * HALF * z, 2 * HALF * z);
  c.setLineDash([]);
  // scale bar
  const bar = stepKm * z;
  c.fillStyle = DIM;
  c.fillRect(12, h - 18, bar, 2);
  c.font = '11px system-ui, sans-serif';
  c.fillText(stepKm + ' km', 12, h - 24);
}

function symbol(c: CanvasRenderingContext2D, k: number, hostile: boolean, x: number, y: number, r: number): void {
  c.beginPath();
  if (k === K_WPN) { c.moveTo(x, y - r * 0.5); c.lineTo(x + r * 0.5, y + r * 0.5); c.lineTo(x - r * 0.5, y + r * 0.5); c.closePath(); return; }
  if (k === K_BUOY) { c.rect(x - 2.5, y - 2.5, 5, 5); return; }
  if (k === K_BASE) { c.rect(x - r, y - r, 2 * r, 2 * r); return; }
  if (hostile) {
    // diamond; air = top half, sub = bottom half
    if (k === K_AIR) { c.moveTo(x - r, y + r * 0.3); c.lineTo(x, y - r); c.lineTo(x + r, y + r * 0.3); }
    else if (k === K_SUB) { c.moveTo(x - r, y - r * 0.3); c.lineTo(x, y + r); c.lineTo(x + r, y - r * 0.3); }
    else { c.moveTo(x, y - r); c.lineTo(x + r, y); c.lineTo(x, y + r); c.lineTo(x - r, y); c.closePath(); }
  } else if (k === K_AIR) c.arc(x, y + r * 0.3, r, Math.PI, 0);
  else if (k === K_SUB) c.arc(x, y - r * 0.3, r, 0, Math.PI);
  else c.arc(x, y, r, 0, Math.PI * 2);
}

export interface Scene {
  snap: Float32Array | null; side: number; sel: number; tgt: number; selGen: number; tgtGen: number; info: Info | null;
  names: string[]; unitName: (def: number) => string; weaponName: (def: number) => string; label: (id: number) => string;
  rings: number[]; // km radii to draw around the selected unit
}

export function drawUnits(c: CanvasRenderingContext2D, v: View, sc: Scene): void {
  const { w, h, z } = v;
  c.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const s = sc.snap;
  if (!s) return;
  const n = s[2];
  c.font = '11px system-ui, sans-serif';
  c.lineWidth = 1.5;
  const X = (x: number) => (x - v.x) * z + w / 2, Y = (y: number) => h / 2 - (y - v.y) * z;
  for (let q = 0, p = SNAP_HDR; q < n; q++, p += SNAP_REC) {
    const id = s[p], k = s[p + 1], lvl = s[p + 10];
    if (s[p + 11] & F_STOWED) continue;
    const hostile = s[p + 2] !== sc.side;
    const col = hostile ? FOE : OWN;
    const sx = X(s[p + 4]), sy = Y(s[p + 5]);
    if (lvl === 1) {
      // bearing-only: a dashed line from the sensor along the bearing, no range
      const len = 80 * z;
      c.strokeStyle = col; c.setLineDash([5, 5]);
      c.beginPath(); c.moveTo(sx, sy); c.lineTo(sx + s[p + 6] * len, sy - s[p + 7] * len); c.stroke();
      c.setLineDash([]);
      if (id === sc.sel || id === sc.tgt) { c.fillStyle = col; c.fillText('bearing only', sx + s[p + 6] * len + 4, sy - s[p + 7] * len); }
      continue;
    }
    if (sx < -20 || sy < -20 || sx > w + 20 || sy > h + 20) continue;
    const r = k === K_WPN ? 5 : 7;
    c.globalAlpha = lvl === 0 ? 0.4 : 1;
    c.strokeStyle = col;
    symbol(c, k, hostile, sx, sy, r);
    if (k === K_WPN || k === K_BUOY) { c.fillStyle = col; c.fill(); } else c.stroke();
    if (k !== K_WPN && k !== K_BUOY && k !== K_BASE && lvl > 0) {
      c.beginPath(); c.moveTo(sx, sy); c.lineTo(sx + s[p + 6] * 14, sy - s[p + 7] * 14); c.stroke();
    }
    if (id === sc.sel || id === sc.tgt) {
      c.strokeStyle = id === sc.sel ? '#fff' : '#ffd166';
      c.beginPath(); c.arc(sx, sy, r + 5, 0, Math.PI * 2); c.stroke();
    }
    if (z > 0.25 && k !== K_WPN && k !== K_BUOY) {
      c.fillStyle = col;
      c.fillText(lvl === 3 ? sc.label(id) : lvl === 2 ? sc.unitName(s[p + 3]) : 'last known', sx + r + 4, sy + 4);
    } else if (z > 1.5 && k === K_WPN && lvl === 3) { c.fillStyle = col; c.fillText(sc.weaponName(s[p + 3]), sx + 8, sy + 4); }
    c.globalAlpha = 1;
    if (id === sc.sel && lvl === 3) {
      c.strokeStyle = 'rgba(255,255,255,0.22)';
      for (const km of sc.rings) { c.beginPath(); c.arc(sx, sy, km * z, 0, Math.PI * 2); c.stroke(); }
      const wp = sc.info && sc.info.id === id ? sc.info.wp : null;
      if (wp && wp.length) {
        c.strokeStyle = 'rgba(111,211,255,0.6)'; c.setLineDash([3, 4]);
        c.beginPath(); c.moveTo(sx, sy);
        for (let i = 0; i < wp.length; i += 2) c.lineTo(X(wp[i]), Y(wp[i + 1]));
        c.stroke(); c.setLineDash([]);
      }
    }
  }
}
