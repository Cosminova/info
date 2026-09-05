/**
 * What the five pixels beyond the half Moon's terminator actually are.
 *
 * The terminator check measures the share of the scan's light that falls on the
 * unlit side. It is written to tolerate a star sitting on the line — a star
 * carries little energy — but brighter stars change that arithmetic, so this
 * reports where the light beyond the centre column is and how it is spread. A
 * sunlit patch is contiguous and attached to the disc; a star is one or two
 * isolated pixels in otherwise empty sky.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const BASE = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = 'shots/term-debug';

await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--hide-scrollbars', '--mute-audio', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

const settle = (frames = 45) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let c = 0;
        const tick = () => (++c > n ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames,
  );

await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
await settle(20);
await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setDate('2026-03-21T12:00:00Z');
});
await settle(60);
await page.evaluate(() => {
  window.cosminova.setBloom(false);
  window.cosminova.setUiVisible(false);
});
await settle();

// Phase 90 is the real case. Phase 20 is the control: a nearly fully lit disc
// has light well past its own centre column, so the bounded metric has to flag
// it. If it does not, the test has been narrowed into something that cannot fail.
const phase = Number(process.argv[2] ?? 90);

await page.evaluate((p) => window.cosminova.lookFromSun('moon', 3, p, 0), phase);
await settle();

const shot = await page.screenshot({ encoding: 'binary' });
await writeFile(`${OUT}/moon-${phase}.png`, shot);
const { data, info } = await sharp(shot).greyscale().raw().toBuffer({ resolveWithObject: true });
const frame = { data, width: info.width, height: info.height };

const threshold = 0.08;
const y = Math.round(frame.height / 2);
const scan = Array.from({ length: frame.width }, (_, x) => frame.data[y * frame.width + x] / 255);

// Diameter, the same way the check finds it: the tallest run of lit pixels.
let diameter = 0;
for (let x = 0; x < frame.width; x++) {
  let run = 0;
  let best = 0;
  for (let yy = 0; yy < frame.height; yy++) {
    if (frame.data[yy * frame.width + x] / 255 > threshold) best = Math.max(best, ++run);
    else run = 0;
  }
  diameter = Math.max(diameter, best);
}

const centre = Math.round(frame.width / 2);
const margin = Math.round(diameter * 0.03);
const cutoff = centre + margin;
const limb = centre + Math.round(diameter / 2);

let litEnergy = 0;
const beyond = [];
scan.forEach((l, x) => {
  if (l <= threshold || x > limb) return;
  litEnergy += l;
  if (x > cutoff) beyond.push({ x, level: Number(l.toFixed(4)) });
});

const share = beyond.reduce((s, b) => s + b.level, 0) / litEnergy;
console.log(`phase ${phase}: diameter ${diameter} px, centre ${centre}, cutoff x>${cutoff}, limb x<=${limb}`);
console.log(`lit energy ${litEnergy.toFixed(2)}`);
console.log(`beyond: ${beyond.length} px, share ${(share * 100).toFixed(3)}%  =>  ${litEnergy > 20 && share < 0.005 ? 'PASSES' : 'FAILS'}`);
console.log('beyond pixels:', JSON.stringify(beyond));

// Contiguity: a sunlit patch is a run of adjacent columns, a star is isolated.
const runs = [];
for (const b of beyond) {
  const last = runs.at(-1);
  if (last && b.x === last.end + 1) last.end = b.x;
  else runs.push({ start: b.x, end: b.x });
}
console.log('runs beyond:', JSON.stringify(runs.map((r) => ({ ...r, width: r.end - r.start + 1 }))));

// And whether the disc even reaches those columns: if the surrounding rows are
// empty sky, the light is not on the Moon at all.
for (const r of runs) {
  const x = r.start;
  const colAbove = [];
  for (let yy = y - 6; yy <= y + 6; yy++) colAbove.push(Number((frame.data[yy * frame.width + x] / 255).toFixed(3)));
  console.log(`column ${x} vertical neighbourhood:`, JSON.stringify(colAbove));
}

await browser.close();
