"""Slice a 4DAnyone 4DGS model (.npz) at one frame into a standard static 3DGS PLY.

Mirrors fdanyone/reconstruction/gaussian.py (evaluate_conditional) at time t:
    position  = xyz + velocity * (t - time)
    opacity   = sigmoid(opacity) * exp(-0.5 * (t - time)^2 / temporal_variance)
    covariance = conditional 3x3 spatial covariance (time independent)
    then scaled from training units back to metres by config.space_scale (positions x s, covariance x s^2)
    colour    = same SH coefficients (identical basis/sign convention to standard 3DGS)
The result is written as an INRIA-style PLY (f_dc, f_rest, opacity logit, log scales, wxyz quaternion),
optionally rotated 180 deg about X into LichtFeld's Y-down world (default, same as prepare_frame.py).

Usage: python fourdgs_to_ply.py --npz <latest.npz> --out <frame.ply> [--frame 0] [--min-opacity 0.004] [--keep-y-up]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

C0 = 0.28209479177387814
Y_UP_TO_Y_DOWN = np.diag([1.0, -1.0, -1.0])


def normalize(q: np.ndarray) -> np.ndarray:
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def rotation4(left: np.ndarray, right: np.ndarray) -> np.ndarray:
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


def sh_basis(d: np.ndarray) -> np.ndarray:
    """The 16 real SH basis values used by fdanyone (and INRIA 3DGS) for unit directions d (N,3)."""
    x, y, z = d.T
    return np.stack([
        np.full_like(x, C0),
        -0.4886025119029199 * y, 0.4886025119029199 * z, -0.4886025119029199 * x,
        1.0925484305920792 * x * y, -1.0925484305920792 * y * z, 0.31539156525252005 * (2 * z * z - x * x - y * y),
        -1.0925484305920792 * x * z, 0.5462742152960396 * (x * x - y * y),
        -0.5900435899266435 * y * (3 * x * x - y * y), 2.890611442640554 * x * y * z,
        -0.4570457994644658 * y * (4 * z * z - x * x - y * y), 0.3731763325901154 * z * (2 * z * z - 3 * x * x - 3 * y * y),
        -0.4570457994644658 * x * (4 * z * z - x * x - y * y), 1.445305721320277 * z * (x * x - y * y),
        -0.5900435899266435 * x * (x * x - 3 * y * y),
    ], -1)


def sh_signs_for(world: np.ndarray) -> np.ndarray:
    """Per-coefficient sign so that rotated SH reproduces the original colours (world must map each basis to +/- itself)."""
    d = normalize(np.random.default_rng(0).normal(size=(64, 3)))
    ratio = sh_basis(d @ world.T) / sh_basis(d)
    signs = np.sign(np.median(ratio, 0))
    assert np.allclose(ratio, signs, atol=1e-6), "world transform does not map SH bases to +/- themselves"
    return signs


def matrix_to_quat_wxyz(R: np.ndarray) -> np.ndarray:
    m = R
    t = np.trace(m, axis1=1, axis2=2)
    q = np.empty((len(m), 4))
    w = np.sqrt(np.maximum(0, 1 + t)) / 2
    x = np.sqrt(np.maximum(0, 1 + m[:, 0, 0] - m[:, 1, 1] - m[:, 2, 2])) / 2
    y = np.sqrt(np.maximum(0, 1 - m[:, 0, 0] + m[:, 1, 1] - m[:, 2, 2])) / 2
    z = np.sqrt(np.maximum(0, 1 - m[:, 0, 0] - m[:, 1, 1] + m[:, 2, 2])) / 2
    q[:, 0] = w
    q[:, 1] = np.copysign(x, m[:, 2, 1] - m[:, 1, 2])
    q[:, 2] = np.copysign(y, m[:, 0, 2] - m[:, 2, 0])
    q[:, 3] = np.copysign(z, m[:, 1, 0] - m[:, 0, 1])
    return normalize(q)


def write_ply(path: Path, cols: dict[str, np.ndarray]) -> None:
    names = list(cols)
    data = np.stack([cols[n].astype(np.float32) for n in names], 1)
    header = "ply\nformat binary_little_endian 1.0\n" f"element vertex {len(data)}\n"
    header += "".join(f"property float {n}\n" for n in names) + "end_header\n"
    with path.open("wb") as f:
        f.write(header.encode())
        f.write(np.ascontiguousarray(data, dtype="<f4").tobytes())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--npz", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--frame", type=int, default=0, help="frame index into the model's time list (default 0)")
    ap.add_argument("--min-opacity", type=float, default=1 / 255, help="drop Gaussians fainter than this at t")
    ap.add_argument("--keep-y-up", action="store_true", help="keep 4DAnyone's Y-up world")
    a = ap.parse_args()

    z = np.load(a.npz, allow_pickle=False)
    meta = json.loads(z["metadata"].tobytes().decode())
    times, degree = meta["times"], meta["degree"]
    if not 0 <= a.frame < len(times):
        raise SystemExit(f"frame {a.frame} outside 0..{len(times) - 1}")
    t = float(times[a.frame])
    g = {k: z[k].astype(np.float64) for k in ("xyz", "time", "scale", "time_scale", "left", "right", "opacity", "dc", "sh")}

    spatial, velocity, variance = conditional(g["scale"], g["time_scale"], g["left"], g["right"])
    dt = t - g["time"]
    opacity = (1 / (1 + np.exp(-g["opacity"])) * np.exp(-0.5 * dt * dt / variance))[:, 0]
    keep = opacity > a.min_opacity
    xyz = (g["xyz"] + velocity * dt)[keep]
    cov = spatial[keep]
    opacity = opacity[keep]
    coeffs = np.concatenate((g["dc"], g["sh"][:, :15]), 1)[keep]          # (N,16,3)
    if degree < 3:
        coeffs[:, (degree + 1) ** 2:] = 0                                  # inactive bands

    # The model lives in training units (world / space_scale); cameras' translations are divided the same way.
    s = float(meta["config"]["space_scale"])
    xyz = xyz * s
    cov = cov * s * s

    world = np.eye(3) if a.keep_y_up else Y_UP_TO_Y_DOWN
    xyz = xyz @ world.T
    cov = world @ cov @ world.T
    coeffs = coeffs * sh_signs_for(world)[None, :, None]

    evals, evecs = np.linalg.eigh(cov)
    evals = np.maximum(evals, 1e-12)
    evecs[np.linalg.det(evecs) < 0, :, 0] *= -1                             # proper rotations only
    quat = matrix_to_quat_wxyz(evecs)
    log_scale = 0.5 * np.log(evals)
    op = np.clip(opacity, 1e-6, 1 - 1e-6)

    cols = {"x": xyz[:, 0], "y": xyz[:, 1], "z": xyz[:, 2],
            "nx": np.zeros(len(xyz)), "ny": np.zeros(len(xyz)), "nz": np.zeros(len(xyz))}
    for c in range(3):
        cols[f"f_dc_{c}"] = coeffs[:, 0, c]
    rest = coeffs[:, 1:, :].transpose(0, 2, 1).reshape(len(xyz), -1)      # channel-major, as INRIA 3DGS
    for i in range(rest.shape[1]):
        cols[f"f_rest_{i}"] = rest[:, i]
    cols["opacity"] = np.log(op / (1 - op))
    for i in range(3):
        cols[f"scale_{i}"] = log_scale[:, i]
    for i in range(4):
        cols[f"rot_{i}"] = quat[:, i]

    a.out.parent.mkdir(parents=True, exist_ok=True)
    write_ply(a.out, cols)
    print(json.dumps({"npz": str(a.npz), "frame": a.frame, "time_s": t, "sh_degree": degree, "space_scale": s,
                      "gaussians_total": int(len(keep)), "gaussians_at_t": int(keep.sum()),
                      "opaque_gt_0.5": int((opacity > 0.5).sum()), "world": "Y-up" if a.keep_y_up else "Y-down",
                      "out": str(a.out)}, indent=2))


if __name__ == "__main__":
    main()
