// 4D app server: upload a video, turn it into a streamable 4D Gaussian model, play it. No dependencies.
//   node server.mjs [port=7870] [host=127.0.0.1]
// Jobs run one at a time in the fdanyone Docker container (see pipeline.sh) and are kept in <FDA_DATA>/app/jobs.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');                         // repository root
// FDA_DATA (the host folder mounted at /app/data in the container) comes from the environment or docker/.env
const fromEnvFile = (key) => {
  try { return fs.readFileSync(path.join(ROOT, 'docker', '.env'), 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm'))?.[1]; }
  catch { return undefined; }
};
const DATA_ROOT = process.env.FDA_DATA ?? fromEnvFile('FDA_DATA');
if (!DATA_ROOT) { console.error('FDA_DATA is not set: run setup.ps1 or create docker/.env (see docker/.env.example)'); process.exit(1); }
const DATA = path.resolve(DATA_ROOT);
const WEB = path.join(ROOT, 'web');
const DOCKER = path.join(ROOT, 'docker');
const UPLOADS = path.join(DATA, 'source', 'uploads');
const STATE = path.join(DATA, 'app', 'jobs.json');
const [portArg = '7870', host = '127.0.0.1'] = process.argv.slice(2);

const PRESETS = {
  fast: { label: 'Fast', views: 12, vpl: 6, pitches: '[0,30]', steps: 20000, minutes: 45, weights: [0.3, 0.65] },
  best: { label: 'Best', views: 48, vpl: 16, pitches: '[-10,15,35]', steps: 100000, minutes: 190, weights: [0.24, 0.73] },
};

// ---------- job state ----------------------------------------------------------------------------------
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(path.dirname(STATE), { recursive: true });
let jobs = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : [];
const save = () => fs.writeFileSync(STATE, JSON.stringify(jobs, null, 1));
const READONLY = process.env.FDA_READONLY === '1';   // test instance: never starts, stops or saves jobs
// Jobs run in detached containers that write their own log, so the app can restart without touching them.
// On start-up a running job is re-adopted if its container still exists; otherwise its outcome is read from disk.
const container = (j) => `fdanyone-${j.run}`;
function containerState(j) {
  const r = spawnSync('docker', ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', container(j)], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;                       // no such container
  const [status, code] = r.stdout.trim().split(' ');
  return { status, code: Number(code) };
}
const modelReady = (j) => {
  const f = path.join(DATA, 'web', j.run, 'model_sh3.s4d');
  return fs.existsSync(f) && (!j.started || fs.statSync(f).mtimeMs >= Date.parse(j.started) - 60000);
};
let pendingAdopt = READONLY ? [] : jobs.filter((j) => j.status === 'running');
if (!READONLY) save();

const slug = (s) => s.toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'clip';
const newId = () => Math.random().toString(36).slice(2, 6);
const logOf = (j) => path.join(DATA, `${j.run}.log`);
const now = () => new Date().toISOString();

// ---------- progress from the logs -------------------------------------------------------------------------
function tailText(file, bytes = 65536) {
  try {
    const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size, len = Math.min(bytes, size);
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}
// Stages shown in the UI: 0 queued, 1 body tracking, 2 views, 3 4D fit, 4 packaging, 5 ready.
function progress(j) {
  const r = progressRaw(j);
  const step = j.status === 'done' ? 5 : j.status === 'queued' ? 0
    : /Packaging/.test(r.stage) ? 4 : /Fitting|4D fit/.test(r.stage) ? 3 : /Generating/.test(r.stage) ? 2 : 1;
  return { ...r, step };
}
function progressRaw(j) {
  const p = PRESETS[j.preset], [wViews, wFit] = p.weights;
  if (j.status === 'done') return { pct: 100, stage: 'Ready' };
  if (j.status === 'queued') return { pct: 0, stage: j.note ?? 'Waiting for the GPU' };
  if (j.status !== 'running') return { pct: j.pct ?? 0, stage: j.error ?? j.status };
  const log = tailText(logOf(j)).replace(/\x1b\[[0-9;]*m/g, '');
  // stages are also read from files on disk, so progress survives a log that stopped updating
  const newer = (f) => { try { return fs.statSync(f).mtimeMs >= Date.parse(j.started ?? 0) - 60000; } catch { return false; } };
  if (/START web export/.test(log) || newer(path.join(DATA, 'web', j.run))) return { pct: 99, stage: 'Packaging for the web' };
  if (/START 4DGS fit/.test(log) || newer(path.join(DATA, '4dgs', j.run, 'train.jsonl'))) {
    let step = 0;
    const jl = tailText(path.join(DATA, '4dgs', j.run, 'train.jsonl'), 4096).trim().split('\n').pop();
    try { step = JSON.parse(jl).step ?? 0; } catch { /* not started */ }
    const f = Math.min(1, step / p.steps);
    return { pct: Math.round(100 * (wViews + wFit * f)), stage: step ? `Fitting 4D Gaussians · ${Math.round(f * 100)}%` : 'Preparing the 4D fit' };
  }
  const m = [...log.split(/[\r\n]/).join('\n').matchAll(/Generate (\d+) target views:\s+(\d+)%/g)].pop();
  if (m) return { pct: Math.round(100 * wViews * (0.15 + 0.85 * Number(m[2]) / 100)), stage: `Generating ${m[1]} views · ${m[2]}%` };
  return { pct: 1, stage: 'Tracking the body' };
}
function lastError(j) {
  const lines = tailText(logOf(j)).replace(/\x1b\[[0-9;]*m/g, '').split(/[\r\n]+/).filter(Boolean);
  const e = [...lines].reverse().find((l) => /^(error|\w*Error)\b|Error:|Exception:/.test(l.trim()));
  return (e ?? lines.at(-1) ?? 'failed').trim().slice(0, 240);
}

// ---------- runner (one job at a time) ---------------------------------------------------------------------
let active = null;   // { job }
function gzipModels(run) {
  const dir = path.join(DATA, 'web', run);
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.s4d'))) {
    const src = path.join(dir, f);
    fs.writeFileSync(src + '.gz', zlib.gzipSync(fs.readFileSync(src), { level: 9 }));
  }
}
function pump() {
  if (active || READONLY) return;
  const j = jobs.find((x) => x.status === 'queued');
  if (!j) return;
  const p = PRESETS[j.preset];
  j.status = 'running'; j.started = now(); delete j.note; delete j.error; save();
  spawnSync('docker', ['rm', '-f', container(j)], { windowsHide: true });           // leftover from an earlier attempt
  const src = j.src ?? `data/source/uploads/${j.file}`;
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  // run a private copy: bash reads scripts lazily, so editing pipeline.sh must not affect a running job
  const cmd = `cp /app/appsrc/pipeline.sh /tmp/pipeline.sh && bash /tmp/pipeline.sh ${q(src)} ${q(j.run)} ${p.vpl} ${q(p.pitches)} ${p.steps}`
    + ` >> ${q(`data/${j.run}.log`)} 2>&1`;
  const args = ['compose', 'run', '-d', '-T', '--name', container(j),
    '-v', `${WEB.replace(/\\/g, '/')}:/app/web:ro`, '-v', `${HERE.replace(/\\/g, '/')}:/app/appsrc:ro`,
    'fdanyone', 'bash', '-c', cmd];
  const r = spawnSync('docker', args, { cwd: DOCKER, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) { j.status = 'failed'; j.error = `could not start Docker: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`; save(); return; }
  active = { job: j };
}
// Called every few seconds: notice when the active container has finished (or vanished) and record the outcome.
function watch() {
  for (const j of pendingAdopt.splice(0)) {             // jobs that were running when the app (re)started
    if (!active && containerState(j)?.status === 'running') active = { job: j };
    else if (!containerState(j)) finish(j, modelReady(j) ? 0 : 1);
    else finish(j, containerState(j).code);
  }
  if (!active) return pump();
  const j = active.job, st = containerState(j);
  if (st?.status === 'running' || st?.status === 'created') return;
  finish(j, st ? st.code : (modelReady(j) ? 0 : 1));
}
function finish(j, code) {
  if (active?.job === j) active = null;
  spawnSync('docker', ['rm', '-f', container(j)], { windowsHide: true });
  if (j.status === 'cancelled') { save(); return pump(); }
  if (code === 0 && modelReady(j)) {
    try { gzipModels(j.run); j.status = 'done'; j.finished = now(); }
    catch (e) { j.status = 'failed'; j.error = `export: ${e.message}`; }
  } else {
    j.pct = progress({ ...j, status: 'running' }).pct; j.status = 'failed'; j.error = lastError(j);
  }
  save(); pump();
}
if (!READONLY) setInterval(watch, 4000);

// Background: gzip any model that has no .gz yet (models exported outside the app), one at a time.
async function precompress() {
  const root = path.join(DATA, 'web');
  if (!fs.existsSync(root)) return;
  for (const d of fs.readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    for (const f of fs.readdirSync(path.join(root, d.name)).filter((x) => x.endsWith('.s4d'))) {
      const src = path.join(root, d.name, f);
      if (fs.existsSync(src + '.gz')) continue;
      const data = await fs.promises.readFile(src);
      const gz = await new Promise((ok, fail) => zlib.gzip(data, { level: 9 }, (e, r) => (e ? fail(e) : ok(r))));
      await fs.promises.writeFile(src + '.gz.tmp', gz);
      await fs.promises.rename(src + '.gz.tmp', src + '.gz');
    }
  }
}

// Finished runs made outside the app (e.g. full48b) also show up in the library.
function library() {
  const known = new Set(jobs.map((j) => j.run));
  const dir = path.join(DATA, 'web');
  const extra = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !known.has(d.name) && fs.readdirSync(path.join(dir, d.name)).some((f) => f.endsWith('.s4d')))
    .map((d) => ({ id: d.name, run: d.name, status: 'done', preset: 'best', external: true,
      example: d.name.startsWith('ex-'), name: d.name.replace(/^ex-/, ''),
      finished: fs.statSync(path.join(dir, d.name)).mtime.toISOString() })) : [];
  const videoOf = (j) => j.src ? `/media/${j.src.split('/').slice(-2).map(encodeURIComponent).join('/')}`
    : j.file ? `/media/uploads/${encodeURIComponent(j.file)}` : null;
  const posterOf = (j) => {
    if (fs.existsSync(path.join(DATA, 'web', j.run, 'poster.webp'))) return `/play/${encodeURIComponent(j.run)}/poster.webp`;
    const ex = j.src && j.src.includes('/pexels/') ? path.basename(j.src).replace(/\.[^.]+$/, '') : null;   // example clip still
    return ex && fs.existsSync(path.join(POSTERS, ex + '.jpg')) ? `/examples/${encodeURIComponent(ex)}.jpg` : null;
  };
  return [...jobs, ...extra].map((j) => ({ ...j, title: displayName(j), ...progress(j), eta: eta(j), video: videoOf(j),
    poster: posterOf(j), cutout: fs.existsSync(path.join(DATA, 'web', j.run, 'poster.webp')), info: modelInfo(j.run) }))
    .sort((a, b) => {   // in progress first, then your captures (newest first), then the bundled examples
      const rank = (j) => (j.status === 'running' ? 0 : j.status === 'queued' ? 1 : j.example ? 3 : 2);
      return rank(a) - rank(b) || (b.created ?? b.finished ?? '').localeCompare(a.created ?? a.finished ?? '');
    });
}
// Human-friendly names: a user-set title, else the file / example name without the run suffix.
// Drops camera-file noise ("uhd", "3840", "2160", "24fps", "(1)") but keeps a leading clip number.
const pretty = (s) => {
  const words = s.replace(/^ex-/, '').replace(/\(\d+\)/g, ' ').split(/[-_\s]+/).filter(Boolean);
  const keep = words.filter((w, k) => k === 0 || !/^(uhd|fhd|hd|sd|4k|8k|\d+fps|\d+p|\d{1,4}|copy|final|v\d+)$/i.test(w));
  return keep.join(' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()) || s;
};
function displayName(j) {
  if (j.title) return j.title;
  if (j.external) return pretty(j.run);
  return pretty(String(j.name ?? j.run).replace(/\.[^.]+$/, ''));
}
// Model facts from the .s4d header (cached by file mtime): duration, frames, fps, Gaussians, download size.
const infoCache = new Map();
function modelInfo(run) {
  const dir = path.join(DATA, 'web', run), file = path.join(dir, 'model_sh3.s4d');
  if (!fs.existsSync(file)) return null;
  const key = `${file}:${fs.statSync(file).mtimeMs}`;
  if (infoCache.has(key)) return infoCache.get(key);
  let info = null;
  try {
    const fd = fs.openSync(file, 'r'), head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    const hl = head.readUInt32LE(4), hb = Buffer.alloc(hl);
    fs.readSync(fd, hb, 0, hl, 8); fs.closeSync(fd);
    const h = JSON.parse(hb.toString('utf8'));
    const gz = fs.existsSync(file + '.gz') ? fs.statSync(file + '.gz').size : fs.statSync(file).size;
    info = { frames: h.frames, fps: h.fps, seconds: +(h.frames / h.fps).toFixed(2), gaussians: h.count, mb: +(gz / 1048576).toFixed(1) };
  } catch { /* unreadable */ }
  infoCache.set(key, info);
  return info;
}
function eta(j) {
  if (j.status !== 'running' || !j.started) return null;
  const pct = progress(j).pct, mins = (Date.now() - Date.parse(j.started)) / 60000;
  return pct > 3 ? Math.round(mins / pct * (100 - pct)) : PRESETS[j.preset].minutes;
}

// ---------- example input clips (the 4DAnyone Pexels excerpts) ------------------------------------------------
const EXAMPLES_SRC = path.join(DATA, 'source', 'pexels');
const POSTERS = path.join(DATA, 'app', 'examples');
// Clips where the whole body, feet included, stays in frame (checked by eye). They give the best 4D results.
const FULL_BODY = new Set(JSON.parse(fs.existsSync(path.join(HERE, 'examples.json'))
  ? fs.readFileSync(path.join(HERE, 'examples.json'), 'utf8') : '{"full_body":[]}').full_body);
function examples() {
  if (!fs.existsSync(EXAMPLES_SRC)) return [];
  return fs.readdirSync(EXAMPLES_SRC).filter((f) => /\.mp4$/i.test(f)).sort().map((f) => {
    const base = f.replace(/\.[^.]+$/, '');
    return { clip: f, id: base.split(/[-_]/)[0], fullBody: FULL_BODY.has(base.split(/[-_]/)[0]), video: `/media/pexels/${encodeURIComponent(f)}`,
             poster: fs.existsSync(path.join(POSTERS, base + '.jpg')) ? `/examples/${encodeURIComponent(base)}.jpg` : null };
  }).sort((a, b) => Number(b.fullBody) - Number(a.fullBody));
}

// ---------- HTTP -------------------------------------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.s4d': 'application/octet-stream' };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
function sendFile(req, res, file, cache = 'no-store') {
  const headers = { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache };
  if (file.endsWith('.s4d') && !fs.existsSync(file + '.gz')) {     // models exported outside the app: compress once
    fs.writeFileSync(file + '.gz', zlib.gzipSync(fs.readFileSync(file), { level: 9 }));
  }
  if (file.endsWith('.s4d') && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && fs.existsSync(file + '.gz')) {
    file += '.gz'; headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding';
  }
  headers['Content-Length'] = fs.statSync(file).size;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}
function models(run) {
  const dir = path.join(DATA, 'web', run);
  return { run, models: fs.readdirSync(dir).filter((f) => f.endsWith('.s4d')).sort().reverse().map((f) => ({
    file: f, sh: Number(f.match(/_sh(\d)/)?.[1] ?? 3), bytes: fs.statSync(path.join(dir, f)).size,
    gz: fs.existsSync(path.join(dir, f + '.gz')) ? fs.statSync(path.join(dir, f + '.gz')).size : undefined })) };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === '/' || p === '/index.html') return sendFile(req, res, path.join(HERE, 'index.html'));
    if (p === '/api/jobs' && req.method === 'GET') {
      const all = library();
      const busy = all.find((j) => j.status === 'running');
      return json(res, 200, { jobs: all, presets: PRESETS,
        gpu: busy ? { id: busy.id, title: busy.title, pct: busy.pct, stage: busy.stage } : null,
        queued: all.filter((j) => j.status === 'queued').length });
    }
    if (p === '/api/examples' && req.method === 'GET') return json(res, 200, { examples: examples() });
    const poster = p.match(/^\/examples\/([\w.-]+\.jpg)$/);
    if (poster && fs.existsSync(path.join(POSTERS, poster[1]))) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
      return fs.createReadStream(path.join(POSTERS, poster[1])).pipe(res);
    }
    const media = p.match(/^\/media\/(pexels|uploads)\/([\w.-]+\.(?:mp4|mov|webm|mkv|avi|m4v))$/i);
    if (media) {                                                 // source videos, with Range support for seeking
      const file = path.join(DATA, 'source', media[1], media[2]);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'no such video' });
      const size = fs.statSync(file).size;
      const type = { '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska' }[path.extname(file).toLowerCase()] ?? 'video/mp4';
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range) {
        const start = range[1] ? Number(range[1]) : size - Number(range[2]);
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(file).pipe(res);
    }
    if (p === '/api/start' && req.method === 'POST') {          // start a job from an example clip (no upload)
      const ex = examples().find((e) => e.clip === url.searchParams.get('clip'));
      if (!ex) return json(res, 404, { error: 'no such example' });
      const preset = PRESETS[url.searchParams.get('preset')] ? url.searchParams.get('preset') : 'fast';
      const id = newId(), run = `ex${ex.id}-${id}`;
      const job = { id, run, name: `Example ${ex.id}`, src: `data/source/pexels/${ex.clip}`, preset, status: 'queued', created: now() };
      jobs.push(job); save(); pump();
      return json(res, 200, { job });
    }
    if (p === '/api/upload' && req.method === 'POST') {
      const name = String(url.searchParams.get('name') ?? 'clip.mp4');
      const preset = PRESETS[url.searchParams.get('preset')] ? url.searchParams.get('preset') : 'fast';
      const ext = (path.extname(name).toLowerCase().match(/^\.(mp4|mov|webm|mkv|avi|m4v)$/) ?? ['.mp4'])[0];
      const id = newId(), run = `${slug(name)}-${id}`, file = `${run}${ext}`;
      const dst = path.join(UPLOADS, file);
      await new Promise((ok, fail) => { const w = fs.createWriteStream(dst); req.pipe(w); w.on('finish', ok); w.on('error', fail); req.on('error', fail); });
      const job = { id, run, name: name.slice(0, 80), file, preset, status: 'queued', created: now(), bytes: fs.statSync(dst).size };
      jobs.push(job); save(); pump();
      return json(res, 200, { job });
    }
    const ren = p.match(/^\/api\/jobs\/([\w-]+)\/rename$/);
    if (ren && req.method === 'POST') {                        // body: { title }
      let body = ''; for await (const c of req) body += c;
      const title = String(JSON.parse(body || '{}').title ?? '').trim().slice(0, 80);
      let j = jobs.find((x) => x.id === ren[1]);
      if (!j) {                                                // a library entry made outside the app: adopt it
        const ext = library().find((x) => x.id === ren[1] && x.external);
        if (!ext) return json(res, 404, { error: 'no such job' });
        j = { id: ext.id, run: ext.run, name: ext.name, status: 'done', preset: 'best', external: true, example: ext.example, finished: ext.finished };
        jobs.push(j);
      }
      if (title) j.title = title; else delete j.title;
      save();
      return json(res, 200, { ok: true });
    }
    const act = p.match(/^\/api\/jobs\/([\w-]+)\/(cancel|retry|remove)$/);
    if (act && req.method === 'POST') {
      const j = jobs.find((x) => x.id === act[1]);
      if (!j) return json(res, 404, { error: 'no such job' });
      if (act[2] === 'cancel' && ['queued', 'running'].includes(j.status)) {
        const wasRunning = j.status === 'running';
        j.status = 'cancelled'; save();
        if (wasRunning) spawn('docker', ['stop', '-t', '5', container(j)], { stdio: 'ignore', windowsHide: true });
      } else if (act[2] === 'retry' && ['failed', 'cancelled'].includes(j.status)) {
        j.status = 'queued'; delete j.error; save(); pump();
      } else if (act[2] === 'remove' && ['failed', 'cancelled', 'done'].includes(j.status)) {
        jobs = jobs.filter((x) => x !== j); save();      // forgets the job; files on disk are kept
      }
      return json(res, 200, { ok: true });
    }
    const play = p.match(/^\/play\/([\w-]+)\/(.*)$/);
    if (play) {
      const [, run, rest] = play;
      const dir = path.join(DATA, 'web', run);
      if (!fs.existsSync(dir)) return json(res, 404, { error: 'no such run' });
      if (rest === '' || rest === 'index.html') return sendFile(req, res, path.join(WEB, '4d.html'));
      if (rest === '4d-worker.js') return sendFile(req, res, path.join(WEB, '4d-worker.js'));
      if (rest === 'models.json') {
        const entry = library().find((x) => x.run === run);
        return json(res, 200, { ...models(run), title: entry?.title ?? pretty(run), info: entry?.info ?? null });
      }
      if (/^poster\.(webp|png)$/.test(rest) && fs.existsSync(path.join(dir, rest))) {
        res.writeHead(200, { 'Content-Type': rest.endsWith('webp') ? 'image/webp' : 'image/png', 'Cache-Control': 'max-age=300' });
        return fs.createReadStream(path.join(dir, rest)).pipe(res);
      }
      if (/^[\w.-]+\.s4d$/.test(rest) && fs.existsSync(path.join(dir, rest))) return sendFile(req, res, path.join(dir, rest), 'max-age=3600');
    }
    if (/^\/play\/[\w-]+$/.test(p)) { res.writeHead(302, { Location: p + '/' }); return res.end(); }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: String(err.message ?? err) });
  }
}).listen(Number(portArg), host, () => {
  console.log(`4D app: http://${host}:${portArg}/   (data: ${DATA})`);
  if (!READONLY) watch();
  if (!READONLY) precompress();
});
