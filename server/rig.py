"""Cut a character image into puppet layers from segmentation masks.

stdin JSON: {"image": path, "outDir": path, "prefix": str, "items": [{"label", "box_2d": [y0,x0,y1,x1] (0-1000), "mask": base64 png}]}
Writes <prefix>-body.png and <prefix>-<part>.png (full-canvas size, so layers line up with zero offset math)
and prints JSON: {"width", "height", "body", "parts": [{name, file, pivot: [x, y] in px, box: [x0, y0, x1, y1], area}]}

The pivot of a part is where it touches the rest of the body (e.g. the wing's shoulder joint):
the centroid of part pixels that border body pixels. Parts are drawn behind the body when they sit
mostly behind it (wings, tail) and in front otherwise; the caller decides with the "z" hint.
"""
import base64
import io
import json
import os
import re
import sys

import numpy as np
from PIL import Image
from scipy import ndimage


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "part"


def main():
    args = json.loads(sys.stdin.read())
    img = Image.open(args["image"]).convert("RGBA")
    W, H = img.size
    px = np.asarray(img).astype(np.uint8)
    alpha = px[..., 3].astype(np.float32) / 255.0
    solid = alpha > 0.1

    def box_px(b):
        y0, x0, y1, x1 = b
        return int(x0 / 1000 * W), int(y0 / 1000 * H), max(int(x0 / 1000 * W) + 1, int(x1 / 1000 * W)), max(int(y0 / 1000 * H) + 1, int(y1 / 1000 * H))

    # "context" items are body regions that must NOT move (torso, arms, legs); they guide GrabCut only.
    context = [box_px(it["box_2d"]) for it in args["items"] if it.get("role") == "context"]
    part_items = [it for it in args["items"] if it.get("role") != "context"]

    def grabcut(it):
        """Mask for a part from its box alone: GrabCut seeded with the box and the other regions' boxes."""
        import cv2
        x0, y0, x1, y1 = box_px(it["box_2d"])
        scale = min(1.0, 480 / max(W, H))
        sw, sh = max(1, int(W * scale)), max(1, int(H * scale))
        comp = (px[..., :3].astype(np.float32) * alpha[..., None] + 128 * (1 - alpha[..., None])).astype(np.uint8)
        small = cv2.resize(cv2.cvtColor(comp, cv2.COLOR_RGB2BGR), (sw, sh), interpolation=cv2.INTER_AREA)
        S = lambda v: int(v * scale)
        gc = np.full((sh, sw), cv2.GC_BGD, np.uint8)
        gc[S(y0):S(y1), S(x0):S(x1)] = cv2.GC_PR_FGD
        others = [box_px(o["box_2d"]) for o in part_items if o is not it] + context
        core = np.zeros((sh, sw), bool)
        core[S(y0):S(y1), S(x0):S(x1)] = True
        for (a0, b0, a1, b1) in others:
            region = np.zeros((sh, sw), bool)
            region[S(b0):S(b1), S(a0):S(a1)] = True
            # Inside another region but outside this part's box: definitely not this part.
            gc[region & ~core] = cv2.GC_BGD
            gc[region & core] = cv2.GC_PR_BGD
            core &= ~region
        # The part's box minus every other region is almost surely the part itself.
        core = ndimage.binary_erosion(core, iterations=2)
        gc[core] = cv2.GC_FGD
        small_alpha = cv2.resize(alpha, (sw, sh), interpolation=cv2.INTER_AREA)
        gc[small_alpha < 0.1] = cv2.GC_BGD
        if not (gc == cv2.GC_FGD).any() and not (gc == cv2.GC_PR_FGD).any():
            return None
        bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
        try:
            cv2.grabCut(small, gc, None, bgd, fgd, 4, cv2.GC_INIT_WITH_MASK)
        except cv2.error:
            return None
        fg = ((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD)).astype(np.uint8) * 255
        return cv2.resize(fg, (W, H), interpolation=cv2.INTER_LINEAR) > 127

    masks = []
    for it in part_items:
        b64 = re.sub(r"^data:image/\w+;base64,", "", it.get("mask") or "")
        if len(b64) < 100:
            part = grabcut(it)
            if part is None:
                continue
            part = part & solid
            part = ndimage.binary_opening(part, iterations=2)
            lab, n = ndimage.label(part)
            if n > 1:
                sizes = ndimage.sum(part, lab, range(1, n + 1))
                part = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= sizes.max() * 0.15])
            if part.sum() >= 50:
                masks.append((it["label"], part))
            continue
    for it in part_items:
        y0, x0, y1, x1 = it["box_2d"]
        bx0, by0 = int(x0 / 1000 * W), int(y0 / 1000 * H)
        bx1, by1 = max(bx0 + 1, int(x1 / 1000 * W)), max(by0 + 1, int(y1 / 1000 * H))
        b64 = re.sub(r"^data:image/\w+;base64,", "", it.get("mask") or "")
        if len(b64) < 100:
            continue  # handled by GrabCut above
        try:
            m = Image.open(io.BytesIO(base64.b64decode(b64 + "=" * (-len(b64) % 4)))).convert("L").resize((bx1 - bx0, by1 - by0), Image.Resampling.BILINEAR)
        except Exception:
            continue  # a broken mask from the model: skip it, the caller can retry
        full = np.zeros((H, W), np.float32)
        full[by0:by1, bx0:bx1] = np.asarray(m, np.float32) / 255.0
        part = (full > 0.5) & solid
        # Clean up: drop speckles, fill small holes, keep the main blob(s).
        part = ndimage.binary_opening(part, iterations=1)
        part = ndimage.binary_fill_holes(part)
        lab, n = ndimage.label(part)
        if n > 1:
            sizes = ndimage.sum(part, lab, range(1, n + 1))
            keep = [i + 1 for i, s in enumerate(sizes) if s >= sizes.max() * 0.15]
            part = np.isin(lab, keep)
        if part.sum() < 50:
            continue
        masks.append((it["label"], part))

    taken = np.zeros((H, W), bool)
    parts_out = []
    os.makedirs(args["outDir"], exist_ok=True)
    prefix = args["prefix"]
    for label, part in masks:
        part = part & ~taken  # first label wins on overlaps
        taken |= part
        masks_dict = part
        parts_out.append((label, masks_dict))

    body = solid & ~taken
    # Slivers left on the body layer (edges of a moving part the mask missed) would stay behind as
    # specks when the part moves: hand each small detached island to the part it touches.
    lab, n = ndimage.label(body)
    if n > 1:
        sizes = ndimage.sum(body, lab, range(1, n + 1))
        big = sizes.max()
        grown = [(i, ndimage.binary_dilation(m, iterations=3)) for i, (_, m) in enumerate(parts_out)]
        for k, size in enumerate(sizes, start=1):
            if size >= big * 0.03:
                continue
            island = lab == k
            owner = next((i for i, g in grown if (g & island).any()), None)
            if owner is not None:
                label, m = parts_out[owner]
                parts_out[owner] = (label, m | island)
            body &= ~island
    # Soft edges: feather a 1px seam so cuts don't look jagged.
    def save(mask, name):
        a = ndimage.gaussian_filter(mask.astype(np.float32), 0.7)
        out = px.copy()
        out[..., 3] = (np.minimum(a, 1.0) * px[..., 3]).astype(np.uint8)
        f = f"{prefix}-{name}.png"
        Image.fromarray(out, "RGBA").save(os.path.join(args["outDir"], f), optimize=True)
        return f

    result = {"width": W, "height": H, "body": save(body, "body"), "parts": []}
    body_grown = ndimage.binary_dilation(body, iterations=6)
    # Body centre: the torso box if we have one (most reliable), else the body mask centroid.
    torso = [box_px(it["box_2d"]) for it in args["items"] if it.get("role") == "context" and re.search(r"torso|chest|body|badan", it["label"], re.I)]
    if torso:
        a0, b0, a1, b1 = torso[0]
        centre = np.array([(a0 + a1) / 2, (b0 + b1) / 2])
    else:
        by, bx = np.nonzero(body)
        centre = np.array([bx.mean(), by.mean()]) if len(bx) else np.array([W / 2, H / 2])
    for label, mask in parts_out:
        ys, xs = np.nonzero(mask)
        contact = mask & body_grown
        if contact.sum() >= 10:
            cy, cx = np.nonzero(contact)
            # A part hinges where it meets the core of the body (shoulder, hip, neck), not where it merely
            # touches a limb: keep the contact points nearest the body centre.
            d = (cx - centre[0]) ** 2 + (cy - centre[1]) ** 2
            if re.search(r"wing|sayap", label, re.I):
                # Wings hinge high, at the shoulder blade: nearest third, then its upper half.
                near = d <= np.percentile(d, 35)
                cy, cx = cy[near], cx[near]
                top = cy <= np.median(cy)
                cy, cx = cy[top], cx[top]
            else:
                near = d <= np.percentile(d, 20)
                cy, cx = cy[near], cx[near]
            pivot = [float(cx.mean()), float(cy.mean())]
        else:
            # Not touching the body: use the point of the part closest to the body's centre.
            d = (xs - centre[0]) ** 2 + (ys - centre[1]) ** 2
            i = int(d.argmin())
            pivot = [float(xs[i]), float(ys[i])]
        result["parts"].append({
            "name": label,
            "file": save(mask, slug(label)),
            "pivot": [round(pivot[0], 1), round(pivot[1], 1)],
            "box": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
            "area": int(mask.sum()),
        })
    print(json.dumps(result))


def debug():
    """Render each part tinted over the body with its joint marked, for checking the cut."""
    from PIL import ImageDraw
    a = json.loads(sys.stdin.read())
    body = Image.open(os.path.join(a["outDir"], a["body"])).convert("RGBA")
    W, H = body.size
    canvas = Image.new("RGBA", (W, H), (24, 30, 48, 255))
    canvas.alpha_composite(body)
    tints = [(255, 90, 60), (60, 200, 255), (255, 210, 60), (140, 255, 120), (230, 120, 255)]
    for i, p in enumerate(a["parts"]):
        part = Image.open(os.path.join(a["outDir"], p["file"])).convert("RGBA")
        tint = Image.new("RGBA", (W, H), tints[i % len(tints)] + (0,))
        tint.putalpha(part.getchannel("A").point(lambda v: int(v * 0.55)))
        canvas.alpha_composite(part)
        canvas.alpha_composite(tint)
    d = ImageDraw.Draw(canvas)
    r = max(6, W // 120)
    for p in a["parts"]:
        x, y = p["pivot"]
        d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, 255), outline=(0, 0, 0, 255), width=3)
        d.text((x + r + 4, y - r), p["name"], fill=(255, 255, 255, 255))
    canvas.convert("RGB").resize((W // 2, H // 2)).save(a["out"])
    print(json.dumps({"ok": True}))


if __name__ == "__main__":
    if "--debug" in sys.argv:
        debug()
    else:
        main()
