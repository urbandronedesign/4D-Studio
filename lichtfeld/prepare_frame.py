"""Turn one time-frame of a 4DAnyone/4DGS build into a static COLMAP dataset for LichtFeld Studio.

Input  (written by reconstruct.py):  <run>/data/{cameras.json, images/<cam>/<frame>.jpg, fmasks/<cam>/<frame>.png}
                                     <run>/initialization/<frame>.npy   (carved points, world coords)
Output:                              <out>/images/cam_XX.png            (RGBA, alpha = foreground mask)
                                     <out>/sparse/0/{cameras,images,points3D}.bin   (COLMAP binary, PINHOLE)
                                     <out>/init_points.ply              (same points, for --init if wanted)
                                     <out>/dataset.json                 (provenance)

Usage: python prepare_frame.py --run <4dgs run dir> --out <dataset dir> [--frame 000000] [--no-alpha]
"""
from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import cv2
import numpy as np

PINHOLE = 1  # COLMAP camera model id

# 4DAnyone's world is Y-up; COLMAP / LichtFeld expect a Y-down world.
# Rotate the whole scene 180 deg about X (y -> -y, z -> -z): a proper rotation, no mirroring.
Y_UP_TO_Y_DOWN = np.diag([1.0, -1.0, -1.0, 1.0])


def rotmat_to_qvec(R: np.ndarray) -> np.ndarray:
    """COLMAP-style rotation matrix -> (qw, qx, qy, qz)."""
    Rxx, Ryx, Rzx, Rxy, Ryy, Rzy, Rxz, Ryz, Rzz = R.flat
    K = np.array([
        [Rxx - Ryy - Rzz, 0, 0, 0],
        [Ryx + Rxy, Ryy - Rxx - Rzz, 0, 0],
        [Rzx + Rxz, Rzy + Ryz, Rzz - Rxx - Ryy, 0],
        [Ryz - Rzy, Rzx - Rxz, Rxy - Ryx, Rxx + Ryy + Rzz],
    ]) / 3.0
    w, V = np.linalg.eigh(K)
    q = V[[3, 0, 1, 2], np.argmax(w)]
    return -q if q[0] < 0 else q


def write_cameras_bin(path: Path, cams: list[tuple[int, int, int, tuple[float, float, float, float]]]) -> None:
    with path.open("wb") as f:
        f.write(struct.pack("<Q", len(cams)))
        for cam_id, w, h, params in cams:
            f.write(struct.pack("<iiQQ", cam_id, PINHOLE, w, h))
            f.write(struct.pack("<4d", *params))


def write_images_bin(path: Path, images: list[tuple[int, np.ndarray, np.ndarray, int, str]]) -> None:
    with path.open("wb") as f:
        f.write(struct.pack("<Q", len(images)))
        for img_id, q, t, cam_id, name in images:
            f.write(struct.pack("<i4d3di", img_id, *q, *t, cam_id))
            f.write(name.encode() + b"\x00")
            f.write(struct.pack("<Q", 0))  # no 2D observations


def write_points3d_bin(path: Path, xyz: np.ndarray, rgb: np.ndarray) -> None:
    with path.open("wb") as f:
        f.write(struct.pack("<Q", len(xyz)))
        for i, (p, c) in enumerate(zip(xyz, rgb), start=1):
            f.write(struct.pack("<Q3d3BdQ", i, *map(float, p), *map(int, c), 0.0, 0))


def write_ply(path: Path, xyz: np.ndarray, rgb: np.ndarray) -> None:
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {len(xyz)}\n"
        "property float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
    )
    rec = np.empty(len(xyz), dtype=[("p", "<f4", 3), ("c", "u1", 3)])
    rec["p"], rec["c"] = xyz, rgb
    with path.open("wb") as f:
        f.write(header.encode())
        f.write(rec.tobytes())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True, type=Path, help="4DGS run dir (contains data/ and initialization/)")
    ap.add_argument("--out", required=True, type=Path, help="output dataset dir")
    ap.add_argument("--frame", default="000000", help="frame id (default 000000 = first frame)")
    ap.add_argument("--no-alpha", action="store_true", help="write plain RGB images (keep generated background)")
    ap.add_argument("--keep-y-up", action="store_true", help="keep 4DAnyone's Y-up world (appears upside down in LichtFeld)")
    ap.add_argument("--exclude", default="", help="comma-separated camera ids to leave out (e.g. inconsistent views)")
    args = ap.parse_args()
    excluded = {int(c) for c in args.exclude.split(",") if c.strip()}
    world = np.eye(4) if args.keep_y_up else Y_UP_TO_Y_DOWN

    data = args.run / "data"
    meta = json.loads((data / "cameras.json").read_text())
    assert meta["camera_frame"]["name"] == "opencv_camera", "expected OpenCV camera convention"
    cams = [c for c in meta["cameras"] if int(c["camera_id"]) not in excluded]

    img_dir = args.out / "images"
    sparse = args.out / "sparse" / "0"
    mask_dir = args.out.parent / f"{args.out.name}_evalmasks"   # outside the dataset so training never picks it up
    for d in (img_dir, sparse, mask_dir):
        d.mkdir(parents=True, exist_ok=True)
    for stale in img_dir.glob("cam_*.png"):                       # a rebuild with --exclude must not keep old views
        stale.unlink()

    colmap_cams, colmap_imgs = [], []
    views = []  # for point colouring: (K, w2c, image_bgr, mask)
    for i, cam in enumerate(cams):
        cid = int(cam["camera_id"])
        sub = f"{cid:02d}"
        bgr = cv2.imread(str(data / "images" / sub / f"{args.frame}.jpg"), cv2.IMREAD_COLOR)
        mask = cv2.imread(str(data / "fmasks" / sub / f"{args.frame}.png"), cv2.IMREAD_GRAYSCALE)
        if bgr is None or mask is None:
            raise SystemExit(f"missing image or mask for camera {sub}, frame {args.frame}")
        name = f"cam_{sub}.png"
        out_img = bgr if args.no_alpha else np.dstack([bgr, mask])
        cv2.imwrite(str(img_dir / name), out_img)
        cv2.imwrite(str(mask_dir / name), mask)

        K = np.asarray(cam["K"], dtype=np.float64)
        w2c = np.linalg.inv(world @ np.asarray(cam["camera_to_world"], dtype=np.float64))
        h, w = bgr.shape[:2]
        assert (w, h) == (cam["image_width"], cam["image_height"])
        colmap_cams.append((i + 1, w, h, (K[0, 0], K[1, 1], K[0, 2], K[1, 2])))
        colmap_imgs.append((i + 1, rotmat_to_qvec(w2c[:3, :3]), w2c[:3, 3], i + 1, name))
        views.append((K, w2c, bgr, mask))

    # Initial points: carved occupancy points for this frame, coloured by averaging
    # their projections into every view where they land on the foreground mask.
    xyz = np.load(args.run / "initialization" / f"{args.frame}.npy").astype(np.float64) @ world[:3, :3].T
    acc = np.zeros((len(xyz), 3)); cnt = np.zeros(len(xyz))
    hom = np.c_[xyz, np.ones(len(xyz))]
    for K, w2c, bgr, mask in views:
        pc = (w2c @ hom.T).T[:, :3]
        front = pc[:, 2] > 1e-6
        uv = (K @ pc.T).T
        u = np.round(uv[:, 0] / np.where(front, uv[:, 2], 1)).astype(int)
        v = np.round(uv[:, 1] / np.where(front, uv[:, 2], 1)).astype(int)
        h, w = mask.shape
        ok = front & (u >= 0) & (u < w) & (v >= 0) & (v < h)
        ok[ok] &= mask[v[ok], u[ok]] > 127
        acc[ok] += bgr[v[ok], u[ok], ::-1]
        cnt[ok] += 1
    rgb = np.where(cnt[:, None] > 0, acc / np.maximum(cnt, 1)[:, None], 128).clip(0, 255).astype(np.uint8)

    write_cameras_bin(sparse / "cameras.bin", colmap_cams)
    write_images_bin(sparse / "images.bin", colmap_imgs)
    write_points3d_bin(sparse / "points3D.bin", xyz, rgb)
    write_ply(args.out / "init_points.ply", xyz.astype(np.float32), rgb)

    info = {
        "source_run": str(args.run), "frame": args.frame, "views": len(cams), "excluded": sorted(excluded),
        "image_size": [colmap_cams[0][1], colmap_cams[0][2]], "alpha_mask": not args.no_alpha,
        "init_points": int(len(xyz)), "init_points_coloured": int((cnt > 0).sum()),
        "world_frame": meta.get("world_frame"),
        "world_transform": "none (Y-up)" if args.keep_y_up else "rot180 about X (Y-down, Z-back)",
    }
    (args.out / "dataset.json").write_text(json.dumps(info, indent=2))
    print(json.dumps(info, indent=2))


if __name__ == "__main__":
    main()
