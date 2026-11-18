"""Inspect a trained splat PLY against its COLMAP dataset: placement, orientation, floaters.

Usage: python inspect_splat.py --ply <splat.ply> --dataset <dataset dir> --out <dir>
Writes density projections (front/side/top PNG) and prints a JSON report.
"""
from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import cv2
import numpy as np


def read_ply(path: Path) -> dict[str, np.ndarray]:
    with path.open("rb") as f:
        header = []
        while (line := f.readline().decode().strip()) != "end_header":
            header.append(line)
        n = next(int(l.split()[2]) for l in header if l.startswith("element vertex"))
        props = [l.split()[2] for l in header if l.startswith("property float")]
        assert len(props) == sum(l.startswith("property") for l in header), "only float props supported"
        arr = np.fromfile(f, dtype="<f4", count=n * len(props)).reshape(n, len(props))
    return {p: arr[:, i] for i, p in enumerate(props)}


def read_camera_centers(images_bin: Path) -> np.ndarray:
    data = images_bin.read_bytes()
    n = struct.unpack_from("<Q", data, 0)[0]; off = 8; centers = []
    for _ in range(n):
        _, qw, qx, qy, qz, tx, ty, tz, _ = struct.unpack_from("<i4d3di", data, off); off += 64
        off = data.index(b"\x00", off) + 1
        npts = struct.unpack_from("<Q", data, off)[0]; off += 8 + npts * 24
        R = np.array([
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy)],
            [2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qw * qx)],
            [2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), 1 - 2 * (qx * qx + qy * qy)],
        ])
        centers.append(-R.T @ np.array([tx, ty, tz]))
    return np.array(centers)


def density(xy: np.ndarray, w: np.ndarray, lo: np.ndarray, hi: np.ndarray, px: int = 512) -> np.ndarray:
    scale = (px - 1) / (hi - lo).max()
    ij = ((xy - lo) * scale).astype(int)
    size = np.ceil((hi - lo) * scale).astype(int) + 1
    img = np.zeros((size[1], size[0]))
    ok = (ij >= 0).all(1) & (ij[:, 0] < size[0]) & (ij[:, 1] < size[1])
    np.add.at(img, (ij[ok, 1], ij[ok, 0]), w[ok])
    img = np.log1p(img); img = (255 * img / max(img.max(), 1e-9)).astype(np.uint8)
    return cv2.applyColorMap(img, cv2.COLORMAP_INFERNO)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ply", required=True, type=Path)
    ap.add_argument("--dataset", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)

    v = read_ply(a.ply)
    xyz = np.c_[v["x"], v["y"], v["z"]].astype(np.float64)
    opa = 1 / (1 + np.exp(-v["opacity"].astype(np.float64)))
    scl = np.exp(np.c_[v["scale_0"], v["scale_1"], v["scale_2"]]).max(1)
    cams = read_camera_centers(a.dataset / "sparse/0/images.bin")

    solid = opa > 0.5
    core = xyz[solid]
    med = np.median(core, 0)
    # floaters: far from the body's robust extent
    lo_b, hi_b = np.percentile(core, 0.5, 0), np.percentile(core, 99.5, 0)
    margin = 0.05 * (hi_b - lo_b).max()
    inside = ((xyz >= lo_b - margin) & (xyz <= hi_b + margin)).all(1)

    # principal axes of the opaque body
    c = core - core.mean(0)
    evals, evecs = np.linalg.eigh(np.cov(c.T))
    long_axis = evecs[:, np.argmax(evals)]
    long_axis *= np.sign(long_axis[np.argmax(np.abs(long_axis))])

    # camera rig: ring centre and ring normal per pitch layer (cameras grouped by height)
    rig_c = cams.mean(0)
    _, _, vt = np.linalg.svd(cams - rig_c)
    ring_normal = vt[2] * np.sign(vt[2][1])
    up_tilt = np.degrees(np.arccos(abs(ring_normal @ np.array([0, 1, 0]))))

    rep = {
        "splats": int(len(xyz)),
        "opaque_gt_0.5": int(solid.sum()),
        "near_transparent_lt_0.05": int((opa < 0.05).sum()),
        "outside_body_box": int((~inside).sum()),
        "outside_body_box_opaque": int((~inside & solid).sum()),
        "body_bbox_min": lo_b.round(3).tolist(), "body_bbox_max": hi_b.round(3).tolist(),
        "body_size_xyz_m": (hi_b - lo_b).round(3).tolist(),
        "body_median": med.round(3).tolist(),
        "body_long_axis": long_axis.round(3).tolist(),
        "body_long_axis_tilt_from_Y_deg": round(float(np.degrees(np.arccos(abs(long_axis[1])))), 2),
        "feet_level_y_max": round(float(hi_b[1]), 3), "head_level_y_min": round(float(lo_b[1]), 3),
        "camera_rig_center": rig_c.round(3).tolist(),
        "camera_ring_normal": ring_normal.round(4).tolist(),
        "camera_ring_tilt_from_Y_deg": round(float(up_tilt), 3),
        "camera_radius_mean": round(float(np.linalg.norm((cams - rig_c)[:, [0, 2]], axis=1).mean()), 3),
        "max_splat_extent_p99": round(float(np.percentile(scl, 99)), 4),
    }
    print(json.dumps(rep, indent=2))

    lo, hi = lo_b - 0.15, hi_b + 0.15
    w = opa
    views = {"front_XY": [0, 1], "side_ZY": [2, 1], "top_XZ": [0, 2]}
    for name, (i, j) in views.items():
        img = density(xyz[:, [i, j]], w, lo[[i, j]], hi[[i, j]])
        # mark world origin projection and the axes' zero lines
        s = (512 - 1) / (hi[[i, j]] - lo[[i, j]]).max()
        o = ((-lo[[i, j]]) * s).astype(int)
        if 0 <= o[0] < img.shape[1]: cv2.line(img, (o[0], 0), (o[0], img.shape[0] - 1), (0, 255, 0), 1)
        if 0 <= o[1] < img.shape[0]: cv2.line(img, (0, o[1]), (img.shape[1] - 1, o[1]), (0, 255, 0), 1)
        cv2.putText(img, name, (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        cv2.imwrite(str(a.out / f"{name}.png"), img)
    (a.out / "report.json").write_text(json.dumps(rep, indent=2))


if __name__ == "__main__":
    main()
