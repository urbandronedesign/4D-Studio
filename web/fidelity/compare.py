"""Compare web renders against the gsplat reference renders (both RGBA PNG, straight alpha).
Colours are compared premultiplied (i.e. composited on black). Reports PSNR over the subject's bounding region.
Usage: python compare.py <eval dir> <prefix> [<prefix> ...]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def load(p):
    a = np.asarray(Image.open(p).convert("RGBA"), dtype=np.float64) / 255
    return a[..., :3] * a[..., 3:], a[..., 3]


def psnr(a, b):
    mse = np.mean((a - b) ** 2)
    return 99.0 if mse == 0 else 10 * np.log10(1 / mse)


root = Path(sys.argv[1])
for prefix in sys.argv[2:]:
    rows = []
    for ref in sorted(root.glob("ref_*.png")):
        web = root / ref.name.replace("ref_", f"{prefix}_", 1)
        if not web.exists():
            continue
        rr, ra = load(ref)
        wr, wa = load(web)
        # region: where either image has coverage, dilated to a box (so empty background does not inflate PSNR)
        ys, xs = np.nonzero((ra > 0.02) | (wa > 0.02))
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        rows.append((psnr(rr[y0:y1, x0:x1], wr[y0:y1, x0:x1]), psnr(ra[y0:y1, x0:x1], wa[y0:y1, x0:x1])))
    if rows:
        r = np.array(rows)
        print(f"{prefix:>14}: RGB PSNR {r[:, 0].mean():6.2f} dB (min {r[:, 0].min():5.2f})   alpha PSNR {r[:, 1].mean():6.2f} dB   n={len(rows)}")
