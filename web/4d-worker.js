// Sort worker for the 4D player. Keeps the time-dependent parameters of every Gaussian received so far and,
// on request, returns the indices of the Gaussians visible at time t, nearest first (front-to-back blending).
//   in:  { type: 'append', mu, t0, v, inv, op }               (Float32Arrays for a block of records)
//        { type: 'sort', view (16 floats, column major), time, id }
//   out: { type: 'sorted', indices (Uint32Array), count, id, time }
let n = 0, cap = 0;
let mu, t0, v, inv, op;            // inv = 1 / sigma_t
let depth, keys, counts, order;

function grow(need) {
  if (need <= cap) return;
  const c = Math.max(need, cap * 2, 65536);
  const re = (a, k) => { const b = new Float32Array(c * k); if (a) b.set(a.subarray(0, n * k)); return b; };
  mu = re(mu, 3); v = re(v, 3); t0 = re(t0, 1); inv = re(inv, 1); op = re(op, 1);
  depth = new Float32Array(c); keys = new Uint32Array(c); order = new Uint32Array(c);
  cap = c;
}

const BINS = 65536;
counts = new Uint32Array(BINS);
const MIN_ALPHA = 1 / 255;
let marginal = 0;   // training's temporal cutoff (header.marginal_threshold)

function sort(view, time) {
  // camera-space depth (OpenGL: camera looks down -Z, so depth = -(row 2 . p))
  const r0 = -view[2], r1 = -view[6], r2 = -view[10], r3 = -view[14];
  let m = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const dt = time - t0[i], x = dt * inv[i], mg = Math.exp(-0.5 * x * x);
    if (mg < marginal || op[i] * mg < MIN_ALPHA) continue;
    const j = i * 3;
    const d = r0 * (mu[j] + v[j] * dt) + r1 * (mu[j + 1] + v[j + 1] * dt) + r2 * (mu[j + 2] + v[j + 2] * dt) + r3;
    if (d < 0.02) continue;                 // behind / too close to the camera
    keys[m] = i; depth[m] = d; m++;
    if (d < lo) lo = d; if (d > hi) hi = d;
  }
  // 16-bit counting sort on depth, ascending (nearest first)
  counts.fill(0);
  const scale = (BINS - 1) / Math.max(hi - lo, 1e-6);
  for (let k = 0; k < m; k++) { const b = ((depth[k] - lo) * scale) | 0; depth[k] = b; counts[b]++; }
  for (let b = 1; b < BINS; b++) counts[b] += counts[b - 1];
  const out = new Uint32Array(m);
  for (let k = m - 1; k >= 0; k--) out[--counts[depth[k]]] = keys[k];
  return out;
}

onmessage = (e) => {
  const d = e.data;
  if (d.type === 'config') {
    marginal = d.marginal;
  } else if (d.type === 'append') {
    const k = d.t0.length;
    grow(n + k);
    mu.set(d.mu, n * 3); v.set(d.v, n * 3); t0.set(d.t0, n); inv.set(d.inv, n); op.set(d.op, n);
    n += k;
  } else if (d.type === 'sort') {
    const indices = sort(d.view, d.time);
    postMessage({ type: 'sorted', indices, count: indices.length, id: d.id, time: d.time, total: n }, [indices.buffer]);
  }
};
