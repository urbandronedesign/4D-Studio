"""Reference renders of a 4DAnyone .npz with the training rasterizer (gsplat), for checking the web renderer.

Writes premultiplied-on-black RGB + alpha PNGs: <out>/ref_<cam>_<frame>.png (RGBA, straight alpha).
Usage: python ref_render.py --npz latest.npz --out dir --cams 00,12,24,36 --frames 0,40,80,120
"""
import argparse
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from fdanyone.reconstruction.checkpoint import load_render_model
from fdanyone.reconstruction.rasterizer import Camera, render


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--npz", required=True)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--cams", default="00,12,24,36")
    ap.add_argument("--frames", default="0,40,80,120")
    a = ap.parse_args()
    meta, model = load_render_model(a.npz)
    cfg = meta["config"]
    cams = {c["name"]: c for c in meta["cameras"]}
    a.out.mkdir(parents=True, exist_ok=True)
    done = []
    with torch.no_grad():
        for name in a.cams.split(","):
            cam = Camera(cams[name], "cuda", far=cfg["far"], image_scale=1.0, near=cfg["near"], space_scale=cfg["space_scale"])
            for f in map(int, a.frames.split(",")):
                image, alpha, _ = render(model, cam, float(meta["times"][f]), marginal_threshold=cfg["marginal_threshold"])
                rgb = image.clamp(0, 1).permute(1, 2, 0).cpu().numpy()           # premultiplied on black
                al = alpha.clamp(0, 1)[0].cpu().numpy()
                straight = np.where(al[..., None] > 1e-6, rgb / np.maximum(al[..., None], 1e-6), 0).clip(0, 1)
                rgba = np.concatenate((straight, al[..., None]), -1)
                path = a.out / f"ref_{name}_{f:03d}.png"
                Image.fromarray((rgba * 255 + 0.5).astype(np.uint8)).save(path)
                done.append(path.name)
    print(json.dumps({"written": done}))


if __name__ == "__main__":
    main()
