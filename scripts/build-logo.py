#!/usr/bin/env python3
"""
Prayer Dome — official logo renderer (real-logo mode)
=====================================================

Uses the authoritative Prayer Dome mark committed as ``assets/logo-master.png`` at the
repository root (3264 px, transparent) and derives the canonical asset set:

    assets/logo.png        512 px  (site, certificate, PWA 512, OG)
    assets/logo-192.png    192 px  (PWA)
    assets/logo-256.png    256 px  (guide PDF cover banner)
    assets/logo-badge-256.png 256 px (PDF banner badge)
    assets/logo-source.png 1024 px (square trimmed source)
    assets/logo-maskable-192.png / -512.png (PWA maskable, padded on white)
    mobile/app-icon.png   1024 px  (Capacitor)
    android/app/src/main/res/mipmap-*/ic_launcher*.png  (legacy densities)
    android/app/src/main/res/mipmap-*/ic_launcher_foreground.png (adaptive 108dp)

The source artwork is *never* procedurally redrawn; it is cropped to its
non-transparent bounds, padded to a square, and scaled with high-quality
Lanczos.  This guarantees the mark is identical everywhere — on pages,
certificates, PDFs, the Play Store listing and the share card.

Run:

    pip install pillow
    python3 scripts/build-logo.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "logo-master.png"

# Target sizes
WANTED = [
    (ROOT / "assets" / "logo.png", 512),
    (ROOT / "assets" / "logo-192.png", 192),
    (ROOT / "assets" / "logo-256.png", 256),
    (ROOT / "assets" / "logo-badge-256.png", 256),
    (ROOT / "assets" / "logo-source.png", 1024),
    (ROOT / "mobile" / "app-icon.png", 1024),
]

ANDROID = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

# Android adaptive icons are 108dp canvases. Only the middle ~66dp is guaranteed
# to be visible after an OEM mask (circle, squircle, teardrop …), so the mark is
# drawn at 58% and kept away from the edges.
ADAPTIVE = {
    "mipmap-mdpi": 108,
    "mipmap-hdpi": 162,
    "mipmap-xhdpi": 216,
    "mipmap-xxhdpi": 324,
    "mipmap-xxxhdpi": 432,
}


def padded_mark(square, size, ratio, background):
    canvas = Image.new("RGBA", (size, size), background)
    inner = max(1, int(size * ratio))
    mark = square.resize((inner, inner), Image.LANCZOS)
    canvas.paste(mark, ((size - inner) // 2, (size - inner) // 2), mark)
    return canvas


def load_square():
    im = Image.open(SRC).convert("RGBA")
    alpha = im.split()[3]
    bbox = alpha.getbbox()
    if bbox is None:
        raise SystemExit("source logo appears fully transparent")
    cropped = im.crop(bbox)
    w, h = cropped.size
    pad = int(max(w, h) * 0.08)
    new_w, new_h = w + 2 * pad, h + 2 * pad
    side = max(new_w, new_h)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(cropped, ((side - w) // 2, (side - h) // 2), cropped)
    return square


def main():
    if not SRC.exists():
        raise SystemExit(f"missing {SRC} — commit the real logo as assets/logo-master.png first")
    square = load_square()
    print(f"source square {square.size} from {SRC}")

    for out, px in WANTED:
        out.parent.mkdir(parents=True, exist_ok=True)
        resized = square.resize((px, px), Image.LANCZOS)
        resized.save(out, optimize=True)
        print(f"wrote {out.relative_to(ROOT)} {resized.size} ({out.stat().st_size} bytes)")

    # PWA maskable icons: a transparent logo would lose its edge labels under
    # Android's mask, so the real mark sits on the white brand field with a
    # safe 16% margin on every side.
    for px in (192, 512):
        out = ROOT / "assets" / f"logo-maskable-{px}.png"
        padded_mark(square, px, 0.68, (255, 255, 255, 255)).convert("RGB").save(out, optimize=True)
        print(f"wrote {out.relative_to(ROOT)} {px}")

    for folder, dim in ANDROID.items():
        base = ROOT / "android" / "app" / "src" / "main" / "res" / folder
        base.mkdir(parents=True, exist_ok=True)
        icon = square.resize((dim, dim), Image.LANCZOS)
        for name in ("ic_launcher.png", "ic_launcher_round.png"):
            out = base / name
            icon.save(out, optimize=True)
            print(f"wrote {out.relative_to(ROOT)} {dim}")

    for folder, dim in ADAPTIVE.items():
        base = ROOT / "android" / "app" / "src" / "main" / "res" / folder
        base.mkdir(parents=True, exist_ok=True)
        foreground = padded_mark(square, dim, 0.58, (0, 0, 0, 0))
        out = base / "ic_launcher_foreground.png"
        foreground.save(out, optimize=True)
        print(f"wrote {out.relative_to(ROOT)} {dim} (adaptive)")

    # The share card (og-image) is built separately — it composes the same
    # square onto a branded 1200×630 canvas — so we leave it untouched here.

    print("done — the real Prayer Dome mark is now everywhere.")


if __name__ == "__main__":
    main()
