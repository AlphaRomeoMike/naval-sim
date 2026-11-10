// Decoder for the 8-bit greyscale depth PNG. Hand-rolled (40 lines) so the worker and Node tests read
// exactly the same bytes; canvas decoding can colour-manage and would not be bit-identical everywhere.

export interface DepthMap { w: number; h: number; data: Uint8Array }

export async function decodeGrayPng(buf: ArrayBuffer): Promise<DepthMap> {
  const dv = new DataView(buf);
  let p = 8, w = 0, h = 0;
  const idat: Uint8Array[] = [];
  while (p < buf.byteLength) {
    const len = dv.getUint32(p), type = dv.getUint32(p + 4);
    if (type === 0x49484452) { // IHDR
      w = dv.getUint32(p + 8); h = dv.getUint32(p + 12);
      if (dv.getUint8(p + 16) !== 8 || dv.getUint8(p + 17) !== 0 || dv.getUint8(p + 20) !== 0) {
        throw new Error('depth PNG must be 8-bit greyscale, non-interlaced');
      }
    } else if (type === 0x49444154) idat.push(new Uint8Array(buf, p + 8, len)); // IDAT
    p += 12 + len;
  }
  const stream = new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  if (raw.length !== (w + 1) * h) throw new Error('depth PNG is truncated');
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w + 1)], ri = y * (w + 1) + 1, oi = y * w;
    for (let x = 0; x < w; x++) {
      const a = x ? out[oi + x - 1] : 0, b = y ? out[oi - w + x] : 0, c = x && y ? out[oi - w + x - 1] : 0;
      let v = raw[ri + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[oi + x] = v;
    }
  }
  return { w, h, data: out };
}
