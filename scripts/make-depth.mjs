// Build public/map/depth.png from a GEBCO grid exported as ESRI ASCII (see README "Map data").
// usage: node scripts/make-depth.mjs <gebco.asc> <out.png>
// Encoding: 0 = land, otherwise v = clamp(round(255 * sqrt(depth_m / 11000)), 6, 255); decode depth = (v/255)^2 * 11000.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const [src, out] = process.argv.slice(2);
const text = readFileSync(src, 'latin1');
const hdr = {};
let pos = 0;
for (let i = 0; i < 6; i++) {
  const nl = text.indexOf('\n', pos);
  const [k, v] = text.slice(pos, nl).trim().split(/\s+/);
  hdr[k.toLowerCase()] = Number(v);
  pos = nl + 1;
}
const w = hdr.ncols, h = hdr.nrows;
const px = new Uint8Array(w * h);
let n = 0, num = 0, neg = false, inNum = false;
for (let i = pos; i <= text.length; i++) {
  const c = i < text.length ? text.charCodeAt(i) : 32;
  if (c === 45) { neg = true; inNum = true; }
  else if (c >= 48 && c <= 57) { num = num * 10 + (c - 48); inNum = true; }
  else if (c === 46) { while (i + 1 < text.length && text.charCodeAt(i + 1) >= 48 && text.charCodeAt(i + 1) <= 57) i++; }
  else if (inNum) {
    const elev = neg ? -num : num;
    px[n++] = elev >= 0 ? 0 : Math.max(6, Math.min(255, Math.round(255 * Math.sqrt(-elev / 11000))));
    num = 0; neg = false; inNum = false;
  }
}
if (n !== w * h) throw new Error(`expected ${w * h} cells, got ${n}`);

// PNG scanlines with the per-row filter (none/sub/up/paeth) that gives the smallest absolute sum
const raw = new Uint8Array((w + 1) * h), cand = [0, 1, 2, 4].map(() => new Uint8Array(w));
for (let y = 0; y < h; y++) {
  let best = 0, bestSum = Infinity;
  cand.forEach((buf, ci) => {
    const f = [0, 1, 2, 4][ci];
    let sum = 0;
    for (let x = 0; x < w; x++) {
      const v = px[y * w + x], a = x ? px[y * w + x - 1] : 0, b = y ? px[(y - 1) * w + x] : 0, c = x && y ? px[(y - 1) * w + x - 1] : 0;
      let pr = 0;
      if (f === 1) pr = a; else if (f === 2) pr = b;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      const d = (v - pr) & 255;
      buf[x] = d; sum += d < 128 ? d : 256 - d;
    }
    if (sum < bestSum) { bestSum = sum; best = ci; }
  });
  raw[y * (w + 1)] = [0, 1, 2, 4][best];
  raw.set(cand[best], y * (w + 1) + 1);
}
const chunk = (type, data) => {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); Buffer.from(data).copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
const text2 = 'Source\0Derived from the GEBCO_2021 Grid, GEBCO Compilation Group (2021), doi:10.5285/c6612cbe-50b3-0cff-e053-6c86abc09f8f';
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from(text2, 'latin1')),
  chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(out, png);
console.log(`${out}: ${w}x${h}, ${png.length} bytes, land ${(100 * px.filter((v) => v === 0).length / px.length).toFixed(1)}%`);
