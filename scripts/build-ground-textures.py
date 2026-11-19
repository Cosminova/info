"""
Packs two photo-scanned materials from ambientCG (CC0) into the pair of
textures the terrain shader reads for ground underfoot:

  ground-tone.webp    R ground brightness, G rock brightness,
                      B ground height,     A rock height
  ground-normal.webp  RG ground normal,    BA rock normal (OpenGL, y up)

Brightness is luminance over its own mean, halved, so 0.5 is "as bright as
the planet's own colour here" and each world keeps its palette.

  python3 scripts/build-ground-textures.py /path/to/Ground110 /path/to/Rock051
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

SIZE = 1024
OUT = Path(__file__).resolve().parent.parent / 'public' / 'textures' / 'ground'


def load(folder, kind):
    folder = Path(folder)
    path = next(folder.glob(f'*_{kind}.jpg'))
    return np.asarray(Image.open(path).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS), dtype=np.float32) / 255


def tone(folder):
    rgb = load(folder, 'Color')
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    return np.clip(lum / lum.mean() * 0.5, 0, 1)


def main(ground, rock):
    OUT.mkdir(parents=True, exist_ok=True)
    height = lambda f: load(f, 'Displacement')[..., 0]
    packed = np.stack([tone(ground), tone(rock), height(ground), height(rock)], -1)
    Image.fromarray((packed * 255 + 0.5).astype(np.uint8)).save(OUT / 'ground-tone.webp', quality=90, method=6)
    ng, nr = load(ground, 'NormalGL'), load(rock, 'NormalGL')
    normals = np.stack([ng[..., 0], ng[..., 1], nr[..., 0], nr[..., 1]], -1)
    Image.fromarray((normals * 255 + 0.5).astype(np.uint8)).save(OUT / 'ground-normal.webp', quality=92, method=6)


if __name__ == '__main__':
    main(*sys.argv[1:3])
