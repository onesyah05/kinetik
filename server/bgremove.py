"""Remove a flat background from a generated illustration and save an RGBA PNG.

Usage: python bgremove.py <in> <out> [--trim]
Prints JSON: {"ok", "removed": fraction of pixels made transparent, "reason"?}

How it works: the background colour is estimated from the image border. Pixels close to that colour
AND connected to the border become transparent (so similar colours inside the subject survive).
Edges get a soft alpha and the background colour is un-blended from them to avoid halos.
"""
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage


def remove(src, dst, trim):
    img = Image.open(src)
    if img.mode == "RGBA":
        a = np.asarray(img)[..., 3]
        if (a < 250).mean() > 0.02:  # already transparent: only clear leftover chroma-green pockets
            px = np.asarray(img).astype(np.float32)
            rgb_ = px[..., :3]
            green = (rgb_[..., 1] > 170) & (rgb_[..., 0] < 110) & (rgb_[..., 2] < 110) & (px[..., 3] > 0)
            green = ndimage.binary_opening(green, iterations=1)
            green = ndimage.binary_dilation(green, iterations=1) & (rgb_[..., 1] > rgb_[..., 0] + 40) & (rgb_[..., 1] > rgb_[..., 2] + 40)
            if green.any():
                px[..., 3] = np.where(green, 0, px[..., 3])
                img = Image.fromarray(px.astype(np.uint8), "RGBA")
            img.save(dst)
            return {"ok": True, "removed": float((np.asarray(img)[..., 3] < 128).mean()), "reason": f"cleaned {int(green.sum())} green pixels"}
    rgb = np.asarray(img.convert("RGB")).astype(np.float32)
    h, w, _ = rgb.shape
    band = max(2, int(min(h, w) * 0.02))
    border = np.concatenate([
        rgb[:band].reshape(-1, 3), rgb[-band:].reshape(-1, 3),
        rgb[:, :band].reshape(-1, 3), rgb[:, -band:].reshape(-1, 3),
    ])
    bg = np.median(border, axis=0)
    spread = np.median(np.linalg.norm(border - bg, axis=1))
    if spread > 30:
        return {"ok": False, "removed": 0.0, "reason": "background is not a flat colour; regenerate on a plain solid background"}

    dist = np.linalg.norm(rgb - bg, axis=2)
    lo, hi = 18.0 + spread, 60.0 + spread  # fully background below lo, fully subject above hi
    candidate = dist < hi
    labels, _ = ndimage.label(candidate)
    edge_labels = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    edge_labels = edge_labels[edge_labels > 0]
    connected = np.isin(labels, edge_labels)

    # A chroma-key backdrop (saturated green or magenta) never belongs to the subject, so also remove
    # pockets of it that are enclosed by the subject (e.g. the gap between an arm and the body).
    r_, g_, b_ = bg
    chroma = (g_ > 150 and r_ < 110 and b_ < 110) or (r_ > 150 and b_ > 150 and g_ < 110)
    if chroma:
        pockets = candidate & (dist < (lo + hi) / 2)
        pockets = ndimage.binary_opening(pockets, iterations=1)  # ignore single stray pixels
        grown = ndimage.binary_dilation(pockets, iterations=2) & candidate
        connected = connected | grown

    alpha = np.ones((h, w), np.float32)
    ramp = np.clip((dist - lo) / (hi - lo), 0, 1)
    alpha[connected] = ramp[connected]
    # Close small pin-holes in the subject and soften the outline slightly.
    solid = ndimage.binary_fill_holes(alpha > 0.5)
    alpha = np.where(solid & (alpha < 0.5) & ~connected, 1.0, alpha)
    alpha = ndimage.gaussian_filter(alpha, 0.6)

    # Un-blend the background colour from semi-transparent edge pixels (removes halos).
    a3 = alpha[..., None]
    safe = np.maximum(a3, 1e-3)
    fg = np.clip((rgb - (1 - a3) * bg) / safe, 0, 255)
    fg = np.where(a3 > 0.98, rgb, fg)

    if chroma and g_ > r_:
        # Despill only along the cut-out edges, so real greens inside the subject are untouched.
        edge = ndimage.binary_dilation(alpha < 0.99, iterations=3) & (alpha > 0.02)
        limit = np.maximum(fg[..., 0], fg[..., 2]) + 8
        fg[..., 1] = np.where(edge, np.minimum(fg[..., 1], limit), fg[..., 1])
    out = np.dstack([fg, alpha * 255]).astype(np.uint8)
    im = Image.fromarray(out, "RGBA")
    if trim:
        bbox = im.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
        if bbox:
            pad = int(max(h, w) * 0.02)
            l, t, r, b = bbox
            im = im.crop((max(0, l - pad), max(0, t - pad), min(w, r + pad), min(h, b + pad)))
    im.save(dst, optimize=True)
    return {"ok": True, "removed": float((alpha < 0.5).mean())}


if __name__ == "__main__":
    a = sys.argv[1:]
    print(json.dumps(remove(a[0], a[1], "--trim" in a)))
