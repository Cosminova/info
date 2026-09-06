/**
 * Choosing the terminator's fullness.
 *
 * The arc directions are settled: the outer limb bends left (sweep 0) so the
 * lit edge is on the left. What is left is how much of the disc is lit, which
 * is the difference between a planet with a dark side and a fingernail. Two
 * families are compared — the terminator bowing into the dark half, and into
 * the lit half — at poster size and at favicon size, because a shape that
 * survives 32 px is the only one worth shipping.
 */

import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';

const OUT = 'shots/logo-try';
await mkdir(OUT, { recursive: true });

const svg = ({ termSweep, termRx, label }) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="lit" x1="0.13" y1="0.42" x2="0.68" y2="0.60">
      <stop offset="0"    stop-color="#F2FBFF"/>
      <stop offset="0.10" stop-color="#B6E9FF"/>
      <stop offset="0.34" stop-color="#70D4FF"/>
      <stop offset="0.70" stop-color="#3690CC"/>
      <stop offset="1"    stop-color="#123049"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" fill="#090C14"/>
  <circle cx="32" cy="32" r="24" fill="none" stroke="#22323F" stroke-width="1.4"/>
  <path d="M 32 8 A 24 24 0 0 0 32 56 A ${termRx} 24 0 0 ${termSweep} 32 8 Z"
        fill="url(#lit)"/>
  <text x="2" y="62" font-size="5" fill="#6b7a8d">${label}</text>
</svg>`;

const candidates = [];
// termSweep 0 bows the terminator into the dark half (a fuller, gibbous disc).
for (const termRx of [24, 18, 12, 6]) candidates.push({ termSweep: 0, termRx, label: `full rx${termRx}` });
// termSweep 1 bows it into the lit half (a leaner crescent).
for (const termRx of [4, 8, 14, 20]) candidates.push({ termSweep: 1, termRx, label: `lean rx${termRx}` });

const sheet = async (size, cell, file) => {
  const tiles = await Promise.all(
    candidates.map(async (c, i) => {
      let img = sharp(Buffer.from(svg(c))).resize(size, size);
      if (size < cell) img = img.resize(cell, cell, { kernel: 'nearest' });
      return { input: await img.png().toBuffer(), left: (i % 4) * cell, top: Math.floor(i / 4) * cell };
    }),
  );
  await sharp({
    create: { width: 4 * cell, height: cell * Math.ceil(candidates.length / 4), channels: 3, background: { r: 9, g: 12, b: 20 } },
  })
    .composite(tiles)
    .png()
    .toFile(`${OUT}/${file}`);
};

await sheet(220, 220, 'fullness.png');
await sheet(32, 160, 'fullness-32.png');
console.log(`${candidates.length} candidates in ${OUT}`);
