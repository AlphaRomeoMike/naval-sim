// Natural Earth 1:50m land (TopoJSON) decoded once into flat typed arrays, then projected per scenario.
// Hand-decoded (no topojson-client): the file holds one MultiPolygon, so decoding is ~30 lines.

export interface Land { lonlat: Float32Array; start: Int32Array; rings: number }
export interface Projected { xy: Float32Array; start: Int32Array; bbox: Float32Array; rings: number }

interface Topo {
  transform: { scale: [number, number]; translate: [number, number] };
  arcs: [number, number][][];
  objects: { land: { geometries: { type: string; arcs: number[][][] | number[][] }[] } };
}

export function decodeLand(topo: Topo): Land {
  const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
  const rings: number[][] = [];
  for (const g of topo.objects.land.geometries) {
    const polys = (g.type === 'Polygon' ? [g.arcs] : g.arcs) as number[][][];
    for (const poly of polys) for (const ring of poly) rings.push(ring);
  }
  let total = 0;
  for (const r of rings) for (const a of r) total += topo.arcs[a < 0 ? ~a : a].length;
  const lonlat = new Float32Array(total * 2), start = new Int32Array(rings.length + 1);
  let p = 0;
  rings.forEach((ring, ri) => {
    start[ri] = p / 2;
    for (const a of ring) {
      const arc = topo.arcs[a < 0 ? ~a : a], from = p;
      let x = 0, y = 0;
      for (const d of arc) { x += d[0]; y += d[1]; lonlat[p++] = x * sx + tx; lonlat[p++] = y * sy + ty; }
      if (a < 0) { // reversed arc: flip the points just written
        for (let i = from, j = p - 2; i < j; i += 2, j -= 2) {
          const tx2 = lonlat[i], ty2 = lonlat[i + 1];
          lonlat[i] = lonlat[j]; lonlat[i + 1] = lonlat[j + 1]; lonlat[j] = tx2; lonlat[j + 1] = ty2;
        }
      }
    }
  });
  start[rings.length] = p / 2;
  return { lonlat, start, rings: rings.length };
}

/**
 * Project to the scenario's flat km plane (same formula as the sim). Longitude is unwrapped along each ring so
 * a ring that crosses the antimeridian stays in one piece, then the ring is moved by whole turns to the copy
 * nearest the scenario centre.
 */
export function project(land: Land, lon0: number, lat0: number, out?: Projected): Projected {
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.57;
  const o = out || { xy: new Float32Array(land.lonlat.length), start: land.start, bbox: new Float32Array(land.rings * 4), rings: land.rings };
  for (let r = 0; r < land.rings; r++) {
    const from = land.start[r], to = land.start[r + 1];
    let prev = 0, lo = 1e9, hi = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = from; i < to; i++) {
      let dl = land.lonlat[i * 2] - lon0;
      if (i === from) { if (dl > 180) dl -= 360; else if (dl < -180) dl += 360; }
      else { while (dl - prev > 180) dl -= 360; while (dl - prev < -180) dl += 360; }
      prev = dl;
      const y = (land.lonlat[i * 2 + 1] - lat0) * ky;
      o.xy[i * 2] = dl; o.xy[i * 2 + 1] = y;
      if (dl < lo) lo = dl; if (dl > hi) hi = dl; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const shift = -360 * Math.round((lo + hi) / 2 / 360);
    for (let i = from; i < to; i++) o.xy[i * 2] = (o.xy[i * 2] + shift) * kx;
    o.bbox[r * 4] = (lo + shift) * kx; o.bbox[r * 4 + 1] = y0; o.bbox[r * 4 + 2] = (hi + shift) * kx; o.bbox[r * 4 + 3] = y1;
  }
  return o;
}
