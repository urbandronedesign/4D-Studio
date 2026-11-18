"""Render a poster for a 4D model: the front training camera at the middle frame, transparent background,
cropped to the subject. Written next to the web models as poster.webp (and poster.png).
Usage (in the fdanyone container, PYTHONPATH=/app): python poster.py <model.npz> <out_dir> [--camera 00] [--height 720]
"""
import argparse
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from fdanyone.reconstruction.checkpoint import load_render_model
from fdanyone.reconstruction.rasterizer import Camera, render


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("npz")
    ap.add_argument("out", type=Path)
    ap.add_argument("--camera", default=None, help="camera name (default: the first)")
    ap.add_argument("--height", type=int, default=720)
    a = ap.parse_args()
    meta, model = load_render_model(a.npz)
    cfg = meta["config"]
    cams = meta["cameras"]
    cam = next((c for c in cams if c["name"] == a.camera), cams[0])
    t = float(meta["times"][len(meta["times"]) // 2])
    with torch.no_grad():
        c = Camera(cam, "cuda", far=cfg["far"], image_scale=1.0, near=cfg["near"], space_scale=cfg["space_scale"])
        image, alpha, _ = render(model, c, t, marginal_threshold=cfg["marginal_threshold"])
    rgb = image.clamp(0, 1).permute(1, 2, 0).cpu().numpy()
    al = alpha.clamp(0, 1)[0].cpu().numpy()
    straight = np.where(al[..., None] > 1e-4, rgb / np.maximum(al[..., None], 1e-4), 0).clip(0, 1)
    rgba = (np.concatenate((straight, al[..., None]), -1) * 255 + 0.5).astype(np.uint8)
    ys, xs = np.nonzero(al > 0.05)
    h, w = al.shape
    if len(ys):                                   # crop to the subject with a margin, keep 3:4 portrait framing
        cy, cx = (ys.min() + ys.max()) / 2, (xs.min() + xs.max()) / 2
        bh = (ys.max() - ys.min()) * 1.12
        bw = max((xs.max() - xs.min()) * 1.12, bh * 0.75)
        bh = max(bh, bw / 0.75)
        y0, y1 = int(max(0, cy - bh / 2)), int(min(h, cy + bh / 2))
        x0, x1 = int(max(0, cx - bw / 2)), int(min(w, cx + bw / 2))
        rgba = rgba[y0:y1, x0:x1]
    im = Image.fromarray(rgba, "RGBA")
    scale = a.height / im.height
    im = im.resize((max(1, round(im.width * scale)), a.height), Image.LANCZOS)
    a.out.mkdir(parents=True, exist_ok=True)
    im.save(a.out / "poster.webp", quality=88)
    im.save(a.out / "poster.png", optimize=True)
    print(f"poster: {a.out / 'poster.webp'} {im.size}")


if __name__ == "__main__":
    main()
