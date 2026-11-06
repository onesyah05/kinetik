"""Slice an animation sprite sheet into aligned frames.

stdin JSON: {"sheet": path, "cols", "rows", "outDir", "prefix", "preview": path}
Every cell is cut, cleaned, and aligned on the character's feet (bottom-centre anchor) so the body
does not jitter between frames. All frames share one canvas size.
Prints JSON: {"width", "height", "frames": [file...], "anchor": [x, y]}.
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage


def main():
    a = json.loads(sys.stdin.read())
    sheet = Image.open(a["sheet"]).convert("RGBA")
    W, H = sheet.size
    cols, rows = int(a["cols"]), int(a["rows"])
    cw, ch = W // cols, H // rows
    cells = []
    for r in range(rows):
        for c in range(cols):
            cell = np.asarray(sheet.crop((c * cw, r * ch, (c + 1) * cw, (r + 1) * ch))).copy()
            alpha = cell[..., 3] > 24
            # Keep the main figure (drop specks and bits of neighbouring cells at the edges).
            lab, n = ndimage.label(ndimage.binary_closing(alpha, iterations=2))
            if n == 0:
                continue
            sizes = ndimage.sum(alpha, lab, range(1, n + 1))
            keep = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= sizes.max() * 0.04])
            cell[..., 3] = np.where(keep, cell[..., 3], 0)
            ys, xs = np.nonzero(cell[..., 3] > 24)
            if len(ys) < 100:
                continue
            # Anchor: feet. Bottom-most rows of the figure, centred on the pixels there.
            bottom = ys.max()
            band = ys >= bottom - max(4, int((bottom - ys.min()) * 0.12))
            anchor = (float(np.median(xs[band])), float(bottom))
            cells.append((cell, (xs.min(), ys.min(), xs.max(), ys.max()), anchor))

    if not cells:
        print(json.dumps({"error": "no frames found in the sheet"}))
        return

    # Shared canvas: big enough for every frame once aligned on the anchor.
    left = max(an[0] - bb[0] for _, bb, an in cells)
    right = max(bb[2] - an[0] for _, bb, an in cells)
    top = max(an[1] - bb[1] for _, bb, an in cells)
    bottom = max(bb[3] - an[1] for _, bb, an in cells)
    pad = 8
    CW, CH = int(left + right) + pad * 2 + 1, int(top + bottom) + pad * 2 + 1
    ax, ay = left + pad, top + pad

    os.makedirs(a["outDir"], exist_ok=True)
    files = []
    imgs = []
    for i, (cell, bb, an) in enumerate(cells):
        canvas = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
        canvas.alpha_composite(Image.fromarray(cell, "RGBA"), (int(round(ax - an[0])), int(round(ay - an[1]))))
        f = f"{a['prefix']}-{i + 1:02d}.png"
        canvas.save(os.path.join(a["outDir"], f), optimize=True)
        files.append(f)
        imgs.append(canvas)

    if a.get("preview"):
        # Contact strip on a dark background for checking consistency.
        scale = min(1.0, 260 / CH)
        tw, th = max(1, int(CW * scale)), max(1, int(CH * scale))
        strip = Image.new("RGB", (tw * len(imgs) + 8 * (len(imgs) + 1), th + 16), (20, 26, 44))
        for i, im in enumerate(imgs):
            strip.paste(im.resize((tw, th)), (8 + i * (tw + 8), 8), im.resize((tw, th)))
        os.makedirs(os.path.dirname(a["preview"]), exist_ok=True)
        strip.save(a["preview"])

    print(json.dumps({"width": CW, "height": CH, "frames": files, "anchor": [round(ax, 1), round(ay, 1)]}))


if __name__ == "__main__":
    main()
