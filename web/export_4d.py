"""Export a 4DAnyone 4DGS model (.npz) into a compact streamable file for the web 4D player (4d.html).

Each 4D Gaussian is conditioned on time in closed form (same maths as fdanyone evaluate_conditional):
    position(t) = mu + v * (t - t0)
    opacity(t)  = opacity * exp(-0.5 * ((t - t0) / sigma_t)^2)
    covariance  = conditional 3x3 spatial covariance (time independent, stored as log-scales + quaternion)
so the browser can render any instant (and in-between frames) from a single download.

Records are sorted by the time each Gaussian first becomes visible, so a player can start before the download
ends: the header's "progress" table says up to which time the scene is complete after N records.

File layout (little endian):
    "S4D1" | u32 header_len | header JSON (utf-8, padded with spaces to 4 bytes) | count * record
record (stride = 30 + sh bytes):
    u16 x3  mean, quantized in header.bbox            f16 x3  velocity (m/s)
    u16     t0, quantized in header.trange            f16     sigma_t (s)
    f16 x3  log scales (m)                            i8 x4   rotation quaternion w,x,y,z (/127)
    u8 x4   base colour rgb (SH band 0 + 0.5) and peak opacity
    i8 x 3*((d+1)^2-1)  SH bands 1..d, coefficient-major (c0.rgb, c1.rgb, ...), value = q / 127 * header.sh_scale
World: 4DAnyone's, Y up, metres (training units * space_scale).

Usage: python export_4d.py --npz latest.npz --out model.s4d [--sh 3] [--min-opacity 0.004]
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

C0 = 0.28209479177387814


def normalize(q):
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def rotation4(left, right):
    a, b, c, d = normalize(left).T
    p, q, r, s = normalize(right).T
    lmat = np.stack((a, -b, -c, -d, b, a, -d, c, c, d, a, -b, d, -c, b, a), -1).reshape(-1, 4, 4)
    rmat = np.stack((p, q, r, s, -q, p, -s, r, -r, s, p, -q, -s, -r, q, p), -1).reshape(-1, 4, 4)
    return lmat @ rmat


def conditional(log_scale, log_time_scale, left, right):
    scale = np.exp(np.concatenate((log_scale, log_time_scale), -1))
    factor = rotation4(left, right) * scale[:, None, :]
    full = factor @ factor.transpose(0, 2, 1)
    temporal = full[:, 3, 3:]
    cross = full[:, :3, 3]
    velocity = cross / temporal
    spatial = full[:, :3, :3] - cross[:, :, None] * velocity[:, None, :]
    return spatial, velocity, temporal


def matrix_to_quat_wxyz(m):
    t = np.trace(m, axis1=1, axis2=2)
    q = np.empty((len(m), 4))
    q[:, 0] = np.sqrt(np.maximum(0, 1 + t)) / 2
    q[:, 1] = np.copysign(np.sqrt(np.maximum(0, 1 + m[:, 0, 0] - m[:, 1, 1] - m[:, 2, 2])) / 2, m[:, 2, 1] - m[:, 1, 2])
    q[:, 2] = np.copysign(np.sqrt(np.maximum(0, 1 - m[:, 0, 0] + m[:, 1, 1] - m[:, 2, 2])) / 2, m[:, 0, 2] - m[:, 2, 0])
    q[:, 3] = np.copysign(np.sqrt(np.maximum(0, 1 - m[:, 0, 0] - m[:, 1, 1] + m[:, 2, 2])) / 2, m[:, 1, 0] - m[:, 0, 1])
    return normalize(q)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--npz", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--sh", type=int, default=3, choices=[0, 1, 2, 3], help="SH degree to keep (default 3)")
    ap.add_argument("--min-opacity", type=float, default=1 / 255, help="drop Gaussians never brighter than this")
    ap.add_argument("--quat", choices=["i8", "i16"], default="i16", help="quaternion encoding (v2)")
    ap.add_argument("--color", choices=["u8", "f16"], default="f16", help="base colour: clamped u8 rgb, or raw f16 SH DC (v2)")
    ap.add_argument("--sh-scale", choices=["global", "band"], default="band", help="int8 SH dequantisation scale (v2)")
    ap.add_argument("--v1", action="store_true", help="write the original S4D1 layout")
    a = ap.parse_args()
    if a.v1:
        a.quat, a.color, a.sh_scale = "i8", "u8", "global"

    z = np.load(a.npz, allow_pickle=False)
    meta = json.loads(z["metadata"].tobytes().decode())
    times = np.asarray(meta["times"], dtype=np.float64)
    fps = float(meta["fps"])
    s = float(meta["config"]["space_scale"])
    g = {k: z[k].astype(np.float64) for k in ("xyz", "time", "scale", "time_scale", "left", "right", "opacity", "dc", "sh")}
    total = len(g["xyz"])

    spatial, velocity, variance = conditional(g["scale"], g["time_scale"], g["left"], g["right"])
    mu = g["xyz"] * s
    vel = velocity * s
    cov = spatial * s * s
    t0 = g["time"][:, 0]
    sig = np.sqrt(variance[:, 0])
    op = 1 / (1 + np.exp(-g["opacity"][:, 0]))

    # Visible window. Training renders a Gaussian only while its temporal marginal exp(-dt^2/2var) exceeds
    # config.marginal_threshold (0.05), and only where opacity(t) > 1/255.
    marginal = float(meta["config"].get("marginal_threshold", 0.0))
    half = sig * np.sqrt(2 * np.log(np.maximum(op / a.min_opacity, 1.0)))
    if marginal > 0 and not a.v1:
        half = np.minimum(half, sig * np.sqrt(2 * np.log(1 / marginal)))
    t_start, t_end = t0 - half, t0 + half
    keep = (op > a.min_opacity) & (t_end >= times[0]) & (t_start <= times[-1]) & np.all(np.isfinite(cov.reshape(total, -1)), 1)
    order = np.argsort(t_start[keep], kind="stable")
    idx = np.flatnonzero(keep)[order]
    n = len(idx)
    mu, vel, cov, t0, sig, op, t_start = mu[idx], vel[idx], cov[idx], t0[idx], sig[idx], op[idx], t_start[idx]

    evals, evecs = np.linalg.eigh(cov)
    evals = np.maximum(evals, 1e-14)
    evecs[np.linalg.det(evecs) < 0, :, 0] *= -1
    quat = matrix_to_quat_wxyz(evecs)
    quat[quat[:, 0] < 0] *= -1
    log_scale = 0.5 * np.log(evals)

    base = 0.5 + C0 * g["dc"][idx, 0, :]                        # SH band 0 colour, before the final clamp
    k = (a.sh + 1) ** 2 - 1
    sh = g["sh"][idx, :k, :]                                    # (n, k, 3)
    bands = [slice(0, 3), slice(3, 8), slice(8, 15)][:a.sh]
    if a.sh_scale == "global":
        sh_scales = [float(np.percentile(np.abs(sh), 99.9))] * a.sh if k else []
    else:
        sh_scales = [float(np.percentile(np.abs(sh[:, b]), 99.9)) for b in bands]
    sh_q = np.zeros((n, k, 3), np.int8)
    for b, sc in zip(bands, sh_scales):
        sh_q[:, b] = np.clip(np.round(sh[:, b] / max(sc, 1e-9) * 127), -127, 127)
    sh_q = sh_q.reshape(n, k * 3)

    lo, hi = mu.min(0), mu.max(0)
    tlo, thi = float(t0.min()), float(t0.max())
    q16 = lambda x, l, h: np.clip(np.round((x - l) / np.maximum(h - l, 1e-9) * 65535), 0, 65535).astype("<u2")

    qmax = 127 if a.quat == "i8" else 32767
    fields = [("mu", "<u2", 3), ("t0", "<u2"), ("v", "<f2", 3), ("sig", "<f2"), ("ls", "<f2", 3),
              ("q", "i1" if a.quat == "i8" else "<i2", 4)]
    fields += [("rgba", "u1", 4)] if a.color == "u8" else [("dc", "<f2", 3), ("op", "u1"), ("pad", "u1")]
    fields += [("sh", "i1", k * 3)]
    rec = np.dtype(fields)
    out = np.zeros(n, rec)
    out["mu"] = q16(mu, lo, hi)
    out["t0"] = q16(t0, tlo, thi)
    out["v"] = vel
    out["sig"] = np.minimum(sig, 6e4)
    out["ls"] = log_scale
    out["q"] = np.clip(np.round(quat * qmax), -qmax, qmax)
    if a.color == "u8":
        out["rgba"][:, :3] = np.round(np.clip(base, 0, 1) * 255)
        out["rgba"][:, 3] = np.round(op * 255)
    else:
        out["dc"] = base
        out["op"] = np.round(op * 255)
    if k:
        out["sh"] = sh_q

    # Framing: robust box of the opaque Gaussians; home camera = the first input camera.
    solid = op > 0.5
    plo, phi = np.percentile(mu[solid], 1, 0), np.percentile(mu[solid], 99, 0)
    center = (plo + phi) / 2
    radius = float(np.max(phi - plo) / 2)
    cam = meta["cameras"][0]
    w2c = np.asarray(cam["w2c"], dtype=np.float64)
    c2w = np.linalg.inv(w2c)
    eye = c2w[:3, 3]                       # camera poses are already in metres (only Gaussians use training units)
    fy = float(np.asarray(cam["K"])[1][1])
    fov_y = math.degrees(2 * math.atan(cam["height"] / (2 * fy)))

    # Streaming table: after `count` records the scene is complete for every t < time.
    progress = []
    step = max(1, n // 256)
    for c in list(range(step, n, step)) + [n]:
        progress.append([int(c), float(t_start[c]) if c < n else float("inf")])

    cameras = [{"name": c.get("name"), "K": np.asarray(c["K"]).tolist(), "w2c": np.asarray(c["w2c"]).tolist(),
                "width": c["width"], "height": c["height"]} for c in meta["cameras"]]
    header = {
        "format": "s4d/1" if a.v1 else "s4d/2", "count": int(n), "stride": int(rec.itemsize), "sh_degree": a.sh,
        "sh_scale": sh_scales[0] if sh_scales else 0.0, "sh_scales": sh_scales,
        "enc": {"quat": a.quat, "color": a.color}, "marginal_threshold": 0.0 if a.v1 else marginal,
        "cameras": cameras,
        "fps": fps, "times": [float(times[0]), float(times[-1])], "frames": len(times),
        "bbox": [lo.tolist(), hi.tolist()], "trange": [tlo, thi],
        "center": center.tolist(), "radius": radius, "up": [0, 1, 0],
        "home": {"eye": eye.tolist(), "target": center.tolist(), "fov_y": fov_y, "name": cam.get("name")},
        "progress": [[c, (t if math.isfinite(t) else None)] for c, t in progress],
        "source": {"npz": a.npz.name, "step": meta.get("step"), "gaussians_total": total},
    }
    hb = json.dumps(header, separators=(",", ":")).encode()
    hb += b" " * (-len(hb) % 4)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    with a.out.open("wb") as f:
        f.write(b"S4D1" if a.v1 else b"S4D2")
        f.write(np.uint32(len(hb)).tobytes())
        f.write(hb)
        f.write(out.tobytes())
    first_frame = int(np.searchsorted(t_start, times[0], side="right"))
    print(json.dumps({"out": str(a.out), "gaussians": n, "dropped": total - n, "stride": rec.itemsize, "sh_degree": a.sh,
                      "mb": round(a.out.stat().st_size / 2**20, 2), "records_needed_for_first_frame": first_frame,
                      "radius": round(radius, 3), "center": np.round(center, 3).tolist(), "home_camera": cam.get("name"),
                      "fov_y": round(fov_y, 1)}, indent=1))


if __name__ == "__main__":
    main()
