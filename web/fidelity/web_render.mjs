// Render training cameras with the web player (4d.html?eval) in headless Edge and save the PNGs.
//   node web_render.mjs <player url incl. ?eval&file=...> <out dir> <prefix> [cams=00,12,24,36] [frames=0,40,80,120]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [url, out, prefix, cams = '00,12,24,36', frames = '0,40,80,120'] = process.argv.slice(2);
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((b) => fs.existsSync(b));
const port = 9334;
const profile = fs.mkdtempSync(`${process.env.TEMP}/fidelity-`);
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=800,800',
  '--use-angle=d3d11', '--ignore-gpu-blocklist', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = () => (process.platform === 'win32' ? spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }) : proc.kill());
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve) => { pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') console.log('[exception]', m.params.exceptionDetails.exception?.description);
  });
  await send('Runtime.enable');
  await send('Page.navigate', { url });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result;
  for (let i = 0; i < 240; i++) { if ((await evaluate('window.evalReady?.() ?? false')).value) break; await sleep(500); }
  fs.mkdirSync(out, { recursive: true });
  for (const c of cams.split(',')) for (const f of frames.split(',').map(Number)) {
    const r = await evaluate(`Promise.race([evalRender('${c}', ${f}).catch((e) => 'ERR ' + (e?.stack ?? e)),
      new Promise((ok) => setTimeout(() => ok('ERR timeout ' + JSON.stringify(window.__evalDebug ?? null)), 20000))])`);
    if (typeof r.value === 'string' && r.value.startsWith('ERR')) { console.log(c, f, r.value); continue; }
    if (typeof r.value !== 'string') { console.log('failed', c, f, JSON.stringify(r)); continue; }
    const file = path.join(out, `${prefix}_${c}_${String(f).padStart(3, '0')}.png`);
    fs.writeFileSync(file, Buffer.from(r.value.split(',')[1], 'base64'));
  }
  console.log('rendered', prefix);
  ws.close();
} finally { kill(); }
