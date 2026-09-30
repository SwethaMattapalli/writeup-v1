#!/usr/bin/env python3
"""Generate WriteUp installer / tray icons."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT_DIRS = [
    ROOT / "app" / "buildResources",
    ROOT / "app" / "electron",
]


def rounded_rect(draw, xy, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    pad = max(2, size // 16)
    radius = size * 0.28
    bg = (28, 28, 46, 255)
    accent = (167, 139, 250, 255)
    ink = (229, 231, 235, 255)

    rounded_rect(
        draw,
        [pad, pad, size - pad - 1, size - pad - 1],
        radius=radius,
        fill=bg,
        outline=accent,
        width=max(2, size // 36),
    )

    # Fountain-pen nib pointing up-right (writing mark)
    cx, cy = size * 0.50, size * 0.54
    s = size * 0.28
    nib = [
        (cx - s * 0.55, cy + s * 0.70),
        (cx - s * 0.15, cy - s * 0.85),
        (cx + s * 0.05, cy - s * 0.55),
        (cx - s * 0.22, cy + s * 0.78),
    ]
    draw.polygon(nib, fill=accent)

    # Pen body
    body = [
        (cx - s * 0.08, cy - s * 0.50),
        (cx + s * 0.62, cy - s * 1.05),
        (cx + s * 0.78, cy - s * 0.82),
        (cx + s * 0.08, cy - s * 0.28),
    ]
    draw.polygon(body, fill=ink)

    # Small stroke under the nib
    sw = max(2, size // 48)
    draw.line(
        [(cx - s * 0.72, cy + s * 0.92), (cx + s * 0.10, cy + s * 0.92)],
        fill=accent,
        width=sw,
    )
    return img


def main():
    icon = make_icon(1024)
    # Slight blur on alpha edges looks cleaner at small sizes after downsample
    icon = icon.filter(ImageFilter.SMOOTH)
    for dest in OUT_DIRS:
        dest.mkdir(parents=True, exist_ok=True)
        path = dest / "icon.png"
        icon.save(path, "PNG")
        print(f"wrote {path}")

    tray = icon.resize((256, 256), Image.Resampling.LANCZOS)
    tray_path = ROOT / "app" / "electron" / "icon.png"
    tray.save(tray_path, "PNG")

    # ICO for Windows tray / installer fallback
    ico_path = ROOT / "app" / "buildResources" / "icon.ico"
    icon.save(
        ico_path,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"wrote {ico_path}")


if __name__ == "__main__":
    main()
