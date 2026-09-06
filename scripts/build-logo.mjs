/**
 * The mark, and every size the page and the platforms ask for.
 *
 * The identity is one specific picture: a lensed accretion disc seen at an
 * angle, twin jets on the polar axis, the horizon understated at the centre
 * rather than announced. It lives at brand/black-hole.jpg and everything here
 * is a crop or a downscale of it — there is no redrawn or vectorised variant,
 * because a redraw is a different picture wearing the same description.
 *
 * That has one real cost, and it is worth stating plainly: at 16 px the
 * filaments average into an orange smudge with a diagonal through it. It reads
 * as a glowing disc with a jet, which is the right silhouette, but it is not
 * crisp the way a flat vector glyph would be. The proof sheet at the bottom of
 * this file shows exactly what a tab will draw, so that trade is visible
 * rather than assumed.
 *
 * A tighter crop on the disc was tried and is worse: it fills the frame with
 * the bright core and loses the ellipse entirely, so the whole frame is what
 * gets used at every size.
 *
 * Usage: node scripts/build-logo.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const OUT = path.resolve('site/assets');
const APP = path.resolve('public');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(APP, { recursive: true });

/*
 * The master. Kept outside site/ because build-site.mjs publishes that folder
 * wholesale, and a 200 KB source image nothing links to has no business being
 * served.
 */
const MASTER = path.resolve('brand/black-hole.jpg');
if (!fs.existsSync(MASTER)) {
  console.error(`no master render at ${MASTER}`);
  process.exit(1);
}

/** Reports what was written, so a run is auditable at a glance. */
const wrote = (label, file) =>
  console.log(`  ${label.padEnd(30)} ${(fs.statSync(file).size / 1024).toFixed(1).padStart(6)} KB`);

/* ---------------------------------------------------------------- squares */

/*
 * Square icons, straight from the frame. No background tile: the render is
 * already almost entirely black at the corners, so it seats itself on a dark
 * tab strip and on a light one reads as a dark tile, which is fine.
 */
const SQUARES = [
  // 16 as well as 32, so a tab strip downscales from the size it wants rather
  // than halving a 32 with its own filter.
  { file: 'icon-16.png', size: 16 },
  { file: 'icon-32.png', size: 32 },
  // Home screen. There is no web manifest, so the 192 and 512 that used to be
  // written here were never referenced by anything — half a megabyte of PNG
  // published for nobody. If a manifest ever lands, add them back with it.
  { file: 'icon-180.png', size: 180 },
  // The header mark. Drawn at 22 px, so 64 covers it to nearly 3x. A 128 was
  // tried and costs 35 KB against 9 — real money on the critical path, since
  // this one is in the stylesheet and so is fetched before first paint, for a
  // sharpness nothing can resolve at this size.
  { file: 'logo.png', size: 64 },
];

for (const { file, size } of SQUARES) {
  const target = path.join(OUT, file);
  await sharp(MASTER).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toFile(target);
  wrote(file, target);
}

/* The app ships its own icon from public/, written here from the same master
   so the landing page and the thing it links to cannot wear different marks. */
const appIcon = path.join(APP, 'favicon.png');
await sharp(MASTER).resize(64, 64, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toFile(appIcon);
wrote('public/favicon.png', appIcon);

/* -------------------------------------------------------------- the card */

/*
 * 1200x630 is what the crawlers expect. A square render cropped to it loses
 * the jet tips, so the crop takes the middle band — where the core, the disc
 * and both jet roots all sit.
 */
const og = path.join(OUT, 'og.jpg');
await sharp(MASTER).resize(1200, 630, { fit: 'cover', position: 'centre' }).jpeg({ quality: 88 }).toFile(og);
wrote('og.jpg', og);

/* ------------------------------------------------------------- retiring */

/* The hand-drawn vector mark this replaced, and the crescent before it. Removed
   rather than left lying around for something to pick up by accident. */
for (const stale of [
  path.join(OUT, 'favicon.svg'),
  path.join(OUT, 'logo.svg'),
  path.join(OUT, 'logo-small.svg'),
  path.join(OUT, 'icon-192.png'),
  path.join(OUT, 'icon-512.png'),
  path.join(APP, 'favicon.svg'),
]) {
  if (fs.existsSync(stale)) {
    fs.rmSync(stale);
    console.log(`  removed ${path.relative(process.cwd(), stale)}`);
  }
}

/* ----------------------------------------------------------------- proof */

/**
 * Downscale, then magnify with no smoothing, so the sheet shows the pixels a
 * tab would actually draw.
 *
 * Encoded between the two resizes deliberately. Sharp collapses a pipeline to
 * a single resize, so `.resize(16).resize(200)` renders straight to 200 and
 * the small size is never exercised — which makes every candidate look like it
 * survives a favicon.
 */
async function pixels(size, cell) {
  const shrunk = await sharp(MASTER).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer();
  return sharp(shrunk).resize(cell, cell, { kernel: 'nearest' }).png().toBuffer();
}

const PROOF = 'shots/logo';
fs.mkdirSync(PROOF, { recursive: true });
const SIZES = [16, 24, 32, 48, 128];
const CELL = 200;
const tiles = await Promise.all(
  SIZES.map(async (s, i) => ({ input: await pixels(s, CELL), left: i * CELL, top: 0 })),
);
tiles.push({
  input: await sharp(MASTER).resize(CELL, CELL).png().toBuffer(),
  left: SIZES.length * CELL,
  top: 0,
});

await sharp({
  create: { width: (SIZES.length + 1) * CELL, height: CELL, channels: 3, background: { r: 5, g: 7, b: 12 } },
})
  .composite(tiles)
  .png()
  .toFile(`${PROOF}/proof.png`);
console.log(`\nproof at ${SIZES.join(', ')} px, then the master: ${path.resolve(PROOF, 'proof.png')}`);
