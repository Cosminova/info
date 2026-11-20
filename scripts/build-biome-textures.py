"""Pack CC0 ambientCG Grass004 and Ground054 2K JPG archives.
Usage: python3 scripts/build-biome-textures.py grass.zip sand.zip
Requires Pillow. Source URLs and license: public/textures/ground/BIOME-CREDITS.md.
"""
import sys
from pathlib import Path
from zipfile import ZipFile
from io import BytesIO
from PIL import Image
out = Path(__file__).resolve().parent.parent / 'public/textures/ground'
normals = []
for name, archive in zip(['grass', 'sand'], sys.argv[1:3]):
    with ZipFile(archive) as source:
        for kind in ['Color', 'NormalGL']:
            filename = next(f for f in source.namelist() if f.endswith('_' + kind + '.jpg'))
            image = Image.open(BytesIO(source.read(filename))).convert('RGB')
            if kind == 'Color':
                image.save(out / f'biome-{name}.webp', quality=94, method=6)
            else:
                normals.append(image)
r, g, _ = normals[0].split()
b, a, _ = normals[1].split()
Image.merge('RGBA', (r, g, b, a)).save(out / 'biome-normal.webp', lossless=True, method=6)
