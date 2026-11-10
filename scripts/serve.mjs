// Tiny static file server for the built game (dist/), shared by the perf and end-to-end scripts.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

/** Serve `dir` on a free localhost port. `isolate` adds COOP/COEP so timers have 5 us resolution. */
export async function serve(dir, { isolate = false, port = 0, mounts = {} } = {}) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const mount = Object.keys(mounts).find((m) => path.startsWith(m)); // e.g. { '/__packs/': 'server/packs' }
    let p = mount ? join(mounts[mount], path.slice(mount.length)) : join(dir, path);
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (!(mount ? p.startsWith(mounts[mount]) : p.startsWith(dir)) || !existsSync(p)) { res.writeHead(404).end(); return; }
    const head = { 'content-type': TYPES[extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache' };
    if (isolate) Object.assign(head, { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' });
    res.writeHead(200, head).end(readFileSync(p));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}
