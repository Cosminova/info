/**
 * The mark, and every size the page and the platforms ask for.
 *
 * The identity is a lensed black hole: a tilted torus of plasma with twin jets
 * on the polar axis, and the horizon itself understated at the centre rather
 * than announced — which is what it looks like when the disc is bright enough
 * to see, and the reason the reference for this is M87* rather than a diagram.
 *
 * It has to exist at two scales, and they cannot be the same artwork:
 *
 *   brand   The full render, for the header, the hero and the social card.
 *           Painterly, hundreds of filaments, jets crossing the frame.
 *   icon    A vector reduction for a browser tab. At 16 px the filaments alias
 *           into a smear and the jets vanish, so the mark keeps only what still
 *           reads at that size: the diagonal of the jets, the ellipse of the
 *           torus, a hot core and a dark centre.
 *
 * Both come from here so they cannot drift apart, and so the palette lives in
 * one place.
 *
 * Usage: node scripts/build-logo.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const OUT = path.resolve('site/assets');

/*
 * The master render, kept in the repo so every derived size is reproducible —
 * but outside site/, because build-site.mjs publishes that folder wholesale
 * and a 400 KB source image nothing links to has no business being served.
 */
const BRAND = path.resolve('brand');
fs.mkdirSync(BRAND, { recursive: true });

const SOURCE =
  process.env.BLACK_HOLE_SOURCE ??
  '/Users/grantsu/.cursor/projects/Users-grantsu-Drop/assets/bh-m87-c.png';
const MASTER = path.join(BRAND, 'black-hole.jpg');

/* ------------------------------------------------------------------ palette */

const HOT = '#FFFBF2';
const CORE = '#FFE9B8';
const GOLD = '#FFB04A';
const ORANGE = '#F5761B';
const SCARLET = '#D62A0C';
const CRIMSON = '#7E1206';
const INK = '#090C14';

/* -------------------------------------------------------------- brand sizes */

if (fs.existsSync(SOURCE)) {
  // Stored as a high quality JPEG rather than the 1.4 MB PNG: everything below
  // is derived from it by downscaling, and at q95 the difference is invisible
  // while the repo stays a tenth of the weight.
  await sharp(SOURCE).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(MASTER);
} else if (!fs.existsSync(MASTER)) {
  console.error(`no master render: ${SOURCE} is missing and ${MASTER} does not exist yet`);
  process.exit(1);
}

/*
 * The social card. 1200x630 is what the crawlers expect, and a square render
 * cropped to it loses the jet tips, so the disc is centred and the crop takes
 * the middle band — where the core, the torus and both jet roots all sit.
 */
const og = path.join(OUT, 'og.jpg');
await sharp(MASTER)
  .resize(1200, 630, { fit: 'cover', position: 'centre' })
  .jpeg({ quality: 86 })
  .toFile(og);
console.log(`  og.jpg${' '.repeat(23)} ${(fs.statSync(og).size / 1024).toFixed(0).padStart(5)} KB`);

/* ---------------------------------------------------------------- the icon */

// Centre, and the tilt of the disc. The jets run perpendicular to it, which is
// what puts them on the opposite diagonal.
const C = 32;
const TILT = -32;
const JET = TILT + 90;

/**
 * The vector reduction.
 *
 * @param {object} [o]
 * @param {boolean} [o.tile]  paint the dark rounded background, for a favicon or
 *                            a touch icon that cannot rely on the page behind it
 * @param {boolean} [o.fine]  include the detail that only survives above about
 *                            48 px: the second torus band and the jet taper
 */
function icon({ tile = false, fine = true } = {}) {
  const discRx = fine ? 25 : 23;
  const discRy = fine ? 9.5 : 10.5;
  // Everything the coarse variant does is a trade against averaging. A tab
  // draws this at 16 px, where each pixel is four units of the viewBox: a
  // 3 unit horizon lands inside one pixel and comes out as grey rather than
  // black, and a 1 unit jet disappears entirely. So the horizon grows, the
  // jets thicken, and the second torus band is dropped rather than being
  // smeared into the first.
  const horizon = fine ? 2.9 : 5;
  const jetHalf = fine ? 1.5 : 2.6;
  const jetCore = fine ? 0.45 : 1.1;
  const bandW = fine ? 5.5 : 7.5;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <!-- Outward through the disc: white-hot at the core to crimson at the rim. -->
    <linearGradient id="torus" x1="0" y1="0.5" x2="1" y2="0.5">
      <stop offset="0"    stop-color="${CRIMSON}"/>
      <stop offset="0.18" stop-color="${SCARLET}"/>
      <stop offset="0.42" stop-color="${ORANGE}"/>
      <stop offset="0.58" stop-color="${GOLD}"/>
      <stop offset="0.82" stop-color="${SCARLET}"/>
      <stop offset="1"    stop-color="${CRIMSON}"/>
    </linearGradient>
    <radialGradient id="core" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0"    stop-color="${HOT}"/>
      <stop offset="0.34" stop-color="${CORE}"/>
      <stop offset="0.62" stop-color="${GOLD}" stop-opacity="0.85"/>
      <stop offset="1"    stop-color="${ORANGE}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="beam" x1="0.5" y1="0" x2="0.5" y2="1">
      <stop offset="0"    stop-color="${SCARLET}" stop-opacity="0"/>
      <stop offset="0.28" stop-color="${GOLD}" stop-opacity="0.9"/>
      <stop offset="0.5"  stop-color="${HOT}"/>
      <stop offset="0.72" stop-color="${GOLD}" stop-opacity="0.9"/>
      <stop offset="1"    stop-color="${SCARLET}" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0.3"  stop-color="${ORANGE}" stop-opacity="0.42"/>
      <stop offset="1"    stop-color="${ORANGE}" stop-opacity="0"/>
    </radialGradient>
  </defs>

${tile ? `  <rect width="64" height="64" rx="14" fill="${INK}"/>\n` : ''}\
  <circle cx="${C}" cy="${C}" r="30" fill="url(#glow)"/>

  <!-- The jets, on the polar axis. Drawn before the core so they read as
       emerging from behind it, and tapered because a collimated beam that is
       the same width along its whole length reads as a drawn line. -->
  <g transform="rotate(${JET} ${C} ${C})">
    <path d="M ${C - jetHalf} 2 L ${C + jetHalf} 2 L ${C + jetHalf * 0.45} ${C} L ${C - jetHalf * 0.45} ${C} Z" fill="url(#beam)"/>
    <path d="M ${C - jetHalf} 62 L ${C + jetHalf} 62 L ${C + jetHalf * 0.45} ${C} L ${C - jetHalf * 0.45} ${C} Z" fill="url(#beam)"/>
    <rect x="${C - jetCore}" y="3" width="${jetCore * 2}" height="58" fill="url(#beam)"/>
  </g>

  <!-- The torus, tilted. The far half first, then the core, then the near half
       over the top of it: that overlap is the whole of the depth cue. -->
  <g transform="rotate(${TILT} ${C} ${C})">
    <ellipse cx="${C}" cy="${C}" rx="${discRx}" ry="${discRy}" fill="none"
             stroke="url(#torus)" stroke-width="${bandW}" opacity="0.55"/>
${
  fine
    ? `    <ellipse cx="${C}" cy="${C}" rx="${discRx - 6}" ry="${discRy - 3}" fill="none"
             stroke="url(#torus)" stroke-width="3.4" opacity="0.8"/>\n`
    : ''
}\
  </g>

  <ellipse cx="${C}" cy="${C}" rx="${fine ? 11 : 10}" ry="${fine ? 11 : 10}" fill="url(#core)"/>

  <!-- Understated on purpose: bright enough around it that the horizon is a
       hint of dark at the heart of the light rather than a hole punched in it. -->
  <circle cx="${C}" cy="${C}" r="${horizon}" fill="#000" opacity="${fine ? 0.92 : 1}"/>

  <g transform="rotate(${TILT} ${C} ${C})">
    <path d="M ${C - discRx} ${C} A ${discRx} ${discRy} 0 0 0 ${C + discRx} ${C}"
          fill="none" stroke="url(#torus)" stroke-width="${bandW}" stroke-linecap="round"/>
  </g>
</svg>
`;
}

const flat = icon({ tile: false, fine: true });
fs.writeFileSync(path.join(OUT, 'logo.svg'), flat);

const tiled = icon({ tile: true, fine: true });
fs.writeFileSync(path.join(OUT, 'favicon.svg'), tiled);

/*
 * The header draws the mark around 20 px, which is favicon territory rather
 * than logo territory, so it gets the coarse geometry without the tile behind
 * it. Same reduction as the 32 px raster, just still resolution independent.
 */
fs.writeFileSync(path.join(OUT, 'logo-small.svg'), icon({ tile: false, fine: false }));

/*
 * The app ships its own favicon from public/, and it used to be an unrelated
 * scatter of dots. Written from the same source here so the landing page and
 * the thing it links to cannot end up wearing different marks.
 */
const APP = path.resolve('public');
fs.mkdirSync(APP, { recursive: true });
fs.writeFileSync(path.join(APP, 'favicon.svg'), tiled);

/* The coarse variant exists for the rasters a tab actually draws. */
const coarse = icon({ tile: true, fine: false });

const RASTERS = [
  { file: 'icon-32.png', size: 32, source: coarse },
  { file: 'icon-180.png', size: 180, source: tiled },
  { file: 'icon-192.png', size: 192, source: tiled },
  { file: 'icon-512.png', size: 512, source: tiled },
];

for (const { file, size, source } of RASTERS) {
  const target = path.join(OUT, file);
  await sharp(Buffer.from(source), { density: 900 }).resize(size, size).png({ compressionLevel: 9 }).toFile(target);
  console.log(`  ${file.padEnd(28)} ${(fs.statSync(target).size / 1024).toFixed(1).padStart(5)} KB`);
}

console.log(`  logo.svg${' '.repeat(20)} ${(fs.statSync(path.join(OUT, 'logo.svg')).size / 1024).toFixed(1).padStart(5)} KB`);
console.log(`  favicon.svg${' '.repeat(17)} ${(fs.statSync(path.join(OUT, 'favicon.svg')).size / 1024).toFixed(1).padStart(5)} KB`);
console.log(`  public/favicon.svg (the app's own, same source)`);

/* ----------------------------------------------------------------- proofing */

/**
 * Downscale, then magnify with no smoothing, so the sheet shows the pixels a
 * tab would actually draw.
 *
 * Encoded between the two resizes deliberately. Sharp collapses a pipeline to a
 * single resize, so `.resize(16).resize(200)` renders straight to 200 and the
 * small size is never exercised at all — which makes every candidate look like
 * it survives a favicon.
 */
async function pixels(source, size, cell) {
  const shrunk = await sharp(source, { density: 900 }).resize(size, size, { kernel: 'lanczos3' }).png().toBuffer();
  return sharp(shrunk).resize(cell, cell, { kernel: 'nearest' }).png().toBuffer();
}

const PROOF = 'shots/logo';
fs.mkdirSync(PROOF, { recursive: true });
const SIZES = [16, 24, 32, 48, 128];
const CELL = 200;
const tiles = await Promise.all(
  SIZES.map(async (s, i) => ({
    input: await pixels(Buffer.from(s <= 32 ? coarse : tiled), s, CELL),
    left: i * CELL,
    top: 0,
  })),
);
tiles.push({ input: await sharp(MASTER).resize(CELL, CELL).png().toBuffer(), left: SIZES.length * CELL, top: 0 });

await sharp({ create: { width: (SIZES.length + 1) * CELL, height: CELL, channels: 3, background: { r: 5, g: 7, b: 12 } } })
  .composite(tiles)
  .png()
  .toFile(`${PROOF}/proof.png`);
console.log(`\nproof at ${SIZES.join(', ')} px, then the brand render: ${path.resolve(PROOF, 'proof.png')}`);
