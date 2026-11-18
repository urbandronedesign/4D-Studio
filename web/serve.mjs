// Static server for the 4D SOG player. No dependencies.
//   node serve.mjs <sequence dir> [port=8080] [host=127.0.0.1]
// Serves index.html (next to this file), the frame_*.sog files from <sequence dir>, and /frames.json:
// a manifest built from the directory on every request (so frames appear while a sequence is still training).
// The manifest is also written into <sequence dir> so the folder + index.html can be hosted as plain static files.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [dirArg = '.', portArg = '8080', host = '127.0.0.1'] = process.argv.slice(2);
const dir = path.resolve(dirArg);
const port = Number(portArg);
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.sog': 'application/octet-stream', '.webp': 'image/webp', '.css': 'text/css' };

// Read one entry of a zip (SOG bundles are zips of webp + meta.json).
function zipEntry(file, name) {
  const b = fs.readFileSync(file);
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error(`${file} is not a zip`);
  let p = b.readUInt32LE(e + 16);
  for (let i = 0, n = b.readUInt16LE(e + 10); i < n; i++) {
    const method = b.readUInt16LE(p + 10), size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28), extra = b.readUInt16LE(p + 30), comment = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    if (b.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      const data = b.subarray(start, start + size);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extra + comment;
  }
  throw new Error(`${name} not found in ${file}`);
}

// Manifest for the sequence folder (sub = '') or a lighter version in a subfolder (sub = 'sh0', 'sh1', ...).
const VARIANT = /^[\w-]+$/;
function manifest(sub = '') {
  const folder = path.join(dir, sub);
  const frames = fs.readdirSync(folder).filter((f) => /^frame_\d+\.sog$/.test(f)).sort();
  const variants = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && VARIANT.test(d.name) && fs.readdirSync(path.join(dir, d.name)).some((f) => f.endsWith('.sog')))
    .map((d) => d.name);
  let center = [0, 0, 0], radius = 1;
  if (frames.length) {
    // SOG stores means as sign(x)*log(1+|x|); its mins/maxs are in that space.
    const meta = JSON.parse(zipEntry(path.join(folder, frames[0]), 'meta.json'));
    const inv = (v) => Math.sign(v) * (Math.exp(Math.abs(v)) - 1);
    const lo = meta.means.mins.map(inv), hi = meta.means.maxs.map(inv);
    center = lo.map((l, i) => (l + hi[i]) / 2);
    radius = Math.max(...hi.map((h, i) => h - lo[i])) / 2;
  }
  let fps = 25;
  try {
    const m = path.join(dir, '..', '..', '..', '4dgs', path.basename(dir), 'data', 'metadata.json');
    fps = Number(JSON.parse(fs.readFileSync(m, 'utf8')).fps) || 25;
  } catch { /* not next to a 4DGS run: keep 25 */ }
  const sizes = frames.map((f) => fs.statSync(path.join(folder, f)).size);
  const avgMB = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length / 1048576 : 0;
  return { run: path.basename(dir), quality: sub || 'full', variants: ['full', ...variants],
    fps, frames, sizes, avgMB, center, radius, coords: 'y-down' };
}

// 4D models (*.s4d from export_4d.py) in the served folder, with their gzip sizes when a .gz sits next to them.
function models() {
  const files = fs.readdirSync(dir).filter((f) => /\.s4d$/.test(f)).sort();
  const list = files.map((f) => {
    const gz = path.join(dir, f + '.gz');
    return { file: f, sh: Number(f.match(/_sh(\d)/)?.[1] ?? 3), bytes: fs.statSync(path.join(dir, f)).size,
             gz: fs.existsSync(gz) ? fs.statSync(gz).size : undefined };
  });
  return { run: path.basename(dir), models: list };
}
const PAGES = new Set(['/index.html', '/4d.html', '/4d-worker.js']);

const quiet = process.env.QUIET === '1';
const throttle = Number(process.env.THROTTLE_MBPS ?? 0) * 1e6 / 8;   // bytes per second, 0 = off
http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!quiet) res.on('finish', () => console.log(`${new Date().toISOString().slice(11, 19)} ${res.statusCode} ${url}`));
  try {
    const mf = url.match(/^\/(?:([\w-]+)\/)?frames\.json$/);
    if (mf) {
      const sub = mf[1] ?? '';
      if (sub && !fs.existsSync(path.join(dir, sub))) { res.writeHead(404); return res.end(); }
      const body = JSON.stringify(manifest(sub), null, 1);
      fs.writeFileSync(path.join(dir, sub, 'frames.json'), body);
      res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    if (url === '/models.json') {
      const body = JSON.stringify(models(), null, 1);
      fs.writeFileSync(path.join(dir, 'models.json'), body);
      res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    // '/' opens the 4D player when the folder holds .s4d models, else the SOG sequence player.
    const page = url === '/' ? (fs.readdirSync(dir).some((f) => f.endsWith('.s4d')) ? '/4d.html' : '/index.html') : url;
    const isPage = PAGES.has(page);
    let file = isPage ? path.join(here, page.slice(1)) : path.join(dir, url);
    if (!isPage && !file.startsWith(dir + path.sep)) { res.writeHead(403); return res.end(); }
    const headers = { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': /\.(sog|s4d)$/.test(file) ? 'max-age=3600' : 'no-store' };
    // Precompressed model: send file.gz with Content-Encoding (the browser inflates it while streaming).
    if (file.endsWith('.s4d') && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && fs.existsSync(file + '.gz')) {
      file += '.gz'; headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding';
    }
    headers['Content-Length'] = fs.statSync(file).size;
    res.writeHead(200, headers);
    if (throttle && /\.(sog|s4d|gz)$/.test(file)) {
      // THROTTLE_MBPS=40 -> pace model downloads like a 40 Mbit/s connection (for testing streaming)
      const src = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
      const t0 = Date.now(); let sent = 0;
      src.on('data', (chunk) => {
        sent += chunk.length; res.write(chunk);
        const wait = sent / throttle * 1000 - (Date.now() - t0);
        if (wait > 0) { src.pause(); setTimeout(() => src.resume(), wait); }
      });
      src.on('end', () => res.end());
      req.on('close', () => src.destroy());
      return;
    }
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
    res.end(String(err.message));
  }
}).listen(port, host, () => {
  const m = manifest();
  console.log(`4D SOG player: http://${host}:${port}/  (${m.frames.length} frames from ${dir}, ${m.fps} fps)`);
});
