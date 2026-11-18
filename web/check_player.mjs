// Headless check of the player: opens it in Edge/Chrome via the DevTools protocol, waits, prints console
// messages and exceptions, and saves a screenshot.
//   node check_player.mjs <url> <screenshot.png> [waitSeconds=20]
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [url = 'http://127.0.0.1:8080/', out = 'player.png', wait = '20'] = process.argv.slice(2);
const browsers = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const exe = browsers.find((b) => fs.existsSync(b));
const profile = fs.mkdtempSync(`${process.env.TEMP}/player-check-`);
const port = 9333;
try { await fetch(`http://127.0.0.1:${port}/json/version`); console.error(`port ${port} already in use (stale browser?)`); process.exit(1); } catch { /* free */ }
const proc = spawn(exe, [`--headless=new`, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,800', '--use-angle=d3d11', '--ignore-gpu-blocklist', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50 && !targets; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(200); }
}
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve) => { pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })); });
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') console.log(`[console.${m.params.type}]`, m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') console.log('[exception]', m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === 'Log.entryAdded') console.log(`[log.${m.params.entry.level}]`, m.params.entry.text, m.params.entry.url ?? '');
});
await send('Runtime.enable'); await send('Log.enable');
// THROTTLE_MBPS=40 node check_player.mjs ...  -> emulate a 40 Mbit/s connection
if (process.env.THROTTLE_MBPS) {
  await send('Network.enable');
  const bps = Number(process.env.THROTTLE_MBPS) * 1e6 / 8;
  await send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: bps, uploadThroughput: bps });
}
// SAMPLES=4 -> also print the page status every few seconds while waiting
const samples = Number(process.env.SAMPLES ?? 0);
await send('Page.navigate', { url });
// RUN_JS="..." -> evaluated on the page 3 s after load (e.g. to click something before the screenshot)
if (process.env.RUN_JS) { await sleep(3000); const r = await send('Runtime.evaluate', { expression: process.env.RUN_JS, awaitPromise: true, returnByValue: true }); console.log('[run_js]', JSON.stringify(r.result?.value ?? r.result?.description ?? null)); }
const status = `document.getElementById('time')?.textContent + ' | ' + document.getElementById('loadText')?.textContent + ' | ' + document.getElementById('subtitle')?.textContent`;
for (let k = 0; k < samples; k++) {
  await sleep(Number(wait) * 1000 / (samples + 1));
  const r = await send('Runtime.evaluate', { expression: status, returnByValue: true });
  console.log(`[t+${(Number(wait) * (k + 1) / (samples + 1)).toFixed(0)}s]`, r.result.value);
}
await sleep(samples ? Number(wait) * 1000 / (samples + 1) : Number(wait) * 1000);
const stats = await send('Runtime.evaluate', { expression: `document.getElementById('time')?.textContent + ' | ' + document.getElementById('loadText')?.textContent + ' | ' + document.getElementById('subtitle')?.textContent + ' | gl=' + !!document.querySelector('canvas').getContext` , returnByValue: true });
console.log('[page]', stats.result.value);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('[screenshot]', out);
ws.close();
// Edge/Chrome spawn child processes: kill the whole tree, or the next run attaches to this stale browser.
if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
else proc.kill();
