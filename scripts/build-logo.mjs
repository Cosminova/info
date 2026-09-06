/**
 * The mark, and every size the page and the platforms ask for.
 *
 * One shape, defined once here: a sphere lit from the left, with the lit limb
 * running bright at the edge and falling to nothing at the terminator, and the
 * unlit half described only by a faint outline. It is the same thing the
 * renderer spends most of its effort on — a real terminator on a real sphere —
 * which is the argument for it being the logo.
 *
 * The terminator is very slightly bowed rather than straight. At a phase angle
 * of exactly ninety degrees it would project to a straight line, and a straight
 * line reads as a shape cut in half rather than as a sphere; a few pixels of
 * curvature is what puts the ball back.
 *
 * Generated rather than drawn by hand so the favicon, the touch icon and the
 * nav mark cannot drift apart, and so the tint lives in one constant.
 *
 * Usage: node scripts/build-logo.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const OUT = path.resolve('site/assets');
fs.mkdirSync(OUT, { recursive: true });

/** The app's own accent, so the site and the thing it advertises agree. */
const LIT = {
  hot: '#F2FBFF',
  bright: '#B6E9FF',
  accent: '#70D4FF',
  mid: '#3690CC',
  fall: '#123049',
};
const INK = '#090C14';
const LIMB_DARK = '#22323F';

// Centre and radius in a 64 unit box. The disc is deliberately not full-bleed:
// a touch icon gets rounded by the platform and a mark needs air around it.
const C = 32;
const R = 24;
// Half-width of the terminator ellipse. Small bows it gently into the lit half,
// which lands the lit fraction just under a half — see scripts/_logo-try.mjs.
const TERM_RX = 4;

const crescent = `M ${C} ${C - R} A ${R} ${R} 0 0 0 ${C} ${C + R} A ${TERM_RX} ${R} 0 0 1 ${C} ${C - R} Z`;

const gradient = `
    <linearGradient id="lit" x1="0.13" y1="0.42" x2="0.68" y2="0.60">
      <stop offset="0" stop-color="${LIT.hot}"/>
      <stop offset="0.10" stop-color="${LIT.bright}"/>
      <stop offset="0.34" stop-color="${LIT.accent}"/>
      <stop offset="0.70" stop-color="${LIT.mid}"/>
      <stop offset="1" stop-color="${LIT.fall}"/>
    </linearGradient>`;

/**
 * @param {object} [o]
 * @param {boolean} [o.tile]  paint the dark rounded background, for a favicon
 *                            or a touch icon that cannot rely on the page
 * @param {boolean} [o.glow]  add the bloom around the lit limb. Left off for
 *                            the smallest raster, where a blur only smears the
 *                            one edge that has to stay crisp.
 */
function mark({ tile = false, glow = true } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>${gradient}${
    glow
      ? `
    <filter id="bloom" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="2.4"/>
    </filter>`
      : ''
  }
  </defs>
${tile ? `  <rect width="64" height="64" rx="14" fill="${INK}"/>\n` : ''}\
  <circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${LIMB_DARK}" stroke-width="1.4"/>
${glow ? `  <path d="${crescent}" fill="${LIT.accent}" opacity="0.45" filter="url(#bloom)"/>\n` : ''}\
  <path d="${crescent}" fill="url(#lit)"/>
</svg>
`;
}

/* The mark on its own, for the page to place on whatever it likes. */
const logo = mark({ tile: false, glow: true });
fs.writeFileSync(path.join(OUT, 'logo.svg'), logo);

/* And on its tile, for a browser tab and a home screen. */
const tiled = mark({ tile: true, glow: true });
fs.writeFileSync(path.join(OUT, 'favicon.svg'), tiled);

/*
 * The app ships its own favicon from public/, and it used to be an unrelated
 * scatter of dots. Written from the same source here so the landing page and
 * the thing it links to cannot end up wearing different marks.
 */
const APP = path.resolve('public');
fs.mkdirSync(APP, { recursive: true });
fs.writeFileSync(path.join(APP, 'favicon.svg'), tiled);

/*
 * Rasters. A tab favicon is drawn at 16 and 32 and the blur costs more than it
 * gives at that size, so the small ones come from the unblurred shape.
 */
const RASTERS = [
  { file: 'icon-32.png', size: 32, source: mark({ tile: true, glow: false }) },
  { file: 'icon-180.png', size: 180, source: tiled },
  { file: 'icon-192.png', size: 192, source: tiled },
  { file: 'icon-512.png', size: 512, source: tiled },
];

for (const { file, size, source } of RASTERS) {
  const target = path.join(OUT, file);
  await sharp(Buffer.from(source), { density: Math.ceil((size / 64) * 96) })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(target);
  console.log(`  ${file.padEnd(14)} ${(fs.statSync(target).size / 1024).toFixed(1).padStart(6)} KB`);
}

console.log(`  logo.svg       ${(fs.statSync(path.join(OUT, 'logo.svg')).size / 1024).toFixed(1).padStart(6)} KB`);
console.log(`  favicon.svg    ${(fs.statSync(path.join(OUT, 'favicon.svg')).size / 1024).toFixed(1).padStart(6)} KB`);
console.log(`  public/favicon.svg (the app's own, same source)`);

/* A proof sheet, because a logo is only correct if it looks correct. */
const PROOF = 'shots/logo';
fs.mkdirSync(PROOF, { recursive: true });
const sizes = [16, 32, 48, 128, 256];
const tiles = await Promise.all(
  sizes.map(async (s, i) => ({
    input: await sharp(Buffer.from(s <= 32 ? mark({ tile: true, glow: false }) : tiled), { density: 400 })
      .resize(s, s)
      .resize(256, 256, { kernel: 'nearest' })
      .png()
      .toBuffer(),
    left: i * 256,
    top: 0,
  })),
);
await sharp({ create: { width: sizes.length * 256, height: 256, channels: 3, background: { r: 5, g: 7, b: 12 } } })
  .composite(tiles)
  .png()
  .toFile(`${PROOF}/proof.png`);
console.log(`\nproof at ${sizes.join(', ')} px: ${path.resolve(PROOF, 'proof.png')}`);
