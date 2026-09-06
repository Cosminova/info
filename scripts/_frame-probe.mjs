/**
 * Throwaway. Sweeps framing parameters and lays the results out side by side,
 * because the site stills came back with the black holes as smudges in an empty
 * frame and both Earth shots running off the right edge, and guessing at a
 * distance one capture at a time is slower than looking at eight of them.
 *
 * Usage: node scripts/_frame-probe.mjs [hole|earth|star]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const which = process.argv[2] ?? 'hole';
const OUT = 'shots/frame';
fs.mkdirSync(OUT, { recursive: true });

const SWEEPS = {
  // distanceRadii for the hole, at the fov the hero uses.
  hole: [
    { label: 'r8', hole: { key: 'sgr-a', distanceRadii: 8 }, fov: 38 },
    { label: 'r14', hole: { key: 'sgr-a', distanceRadii: 14 }, fov: 38 },
    { label: 'r22', hole: { key: 'sgr-a', distanceRadii: 22 }, fov: 38 },
    { label: 'r32', hole: { key: 'sgr-a', distanceRadii: 32 }, fov: 38 },
    { label: 'r45', hole: { key: 'sgr-a', distanceRadii: 45 }, fov: 38 },
    { label: 'r70', hole: { key: 'sgr-a', distanceRadii: 70 }, fov: 38 },
    { label: 'm87-r22', hole: { key: 'm87-star', distanceRadii: 22 }, fov: 38 },
    { label: 'm87-r40', hole: { key: 'm87-star', distanceRadii: 40 }, fov: 38 },
  ],
  // The globe leaves the frame at high phase, so sweep distance against phase.
  earth: [
    { label: 'd3.0-p68', sun: { key: 'earth', distanceRadii: 3.0, phaseDeg: 68, tiltDeg: 10 }, detail: 'earth', fov: 44 },
    { label: 'd3.6-p68', sun: { key: 'earth', distanceRadii: 3.6, phaseDeg: 68, tiltDeg: 10 }, detail: 'earth', fov: 44 },
    { label: 'd3.6-p50', sun: { key: 'earth', distanceRadii: 3.6, phaseDeg: 50, tiltDeg: 10 }, detail: 'earth', fov: 44 },
    { label: 'd4.4-p60', sun: { key: 'earth', distanceRadii: 4.4, phaseDeg: 60, tiltDeg: 12 }, detail: 'earth', fov: 40 },
    { label: 'd4.4-p75', sun: { key: 'earth', distanceRadii: 4.4, phaseDeg: 75, tiltDeg: 12 }, detail: 'earth', fov: 40 },
    { label: 'd5.5-p85', sun: { key: 'earth', distanceRadii: 5.5, phaseDeg: 85, tiltDeg: 14 }, detail: 'earth', fov: 38 },
  ],
  // Betelgeuse came back a flat disc. Closer, and against the galaxy.
  star: [
    { label: 'bet-r3', look: { key: 'star:Betelgeuse', distanceRadii: 3 }, fov: 40 },
    { label: 'bet-r5', look: { key: 'star:Betelgeuse', distanceRadii: 5 }, fov: 34 },
    { label: 'bet-r12', look: { key: 'star:Betelgeuse', distanceRadii: 12 }, fov: 30 },
    { label: 'bet-r30', look: { key: 'star:Betelgeuse', distanceRadii: 30 }, fov: 26 },
    { label: 'sirius-r14', look: { key: 'star:Sirius', distanceRadii: 14 }, fov: 30 },
    { label: 'antares-r10', look: { key: 'star:Antares', distanceRadii: 10 }, fov: 32 },
    { label: 'rigel-r12', look: { key: 'star:Rigel', distanceRadii: 12 }, fov: 30 },
    { label: 'sun-r8', look: { key: 'sun', distanceRadii: 8 }, fov: 34 },
  ],
};

const sweep = SWEEPS[which];
if (!sweep) {
  console.error(`no sweep called ${which}`);
  process.exit(1);
}

const W = 1120;
const H = 630;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });

await page.evaluate(() => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.setDate(new Date('2026-03-20T17:00:00Z'));
  sv.setUiVisible(false);
  for (const k of ['trajectories', 'craftVectors', 'distantMarkers']) sv.setView(k, false);
  for (const k of ['labelPlanets', 'labelStars', 'labelGalaxies', 'labelBlackHoles', 'labelCraft', 'labelExo']) {
    sv.setView(k, false);
  }
  sv.setQuality?.('ultra');
});

async function settle(ms = 2200) {
  await new Promise((r) => setTimeout(r, ms));
}

const done = [];
for (const s of sweep) {
  if (s.detail) await page.evaluate((b) => window.cosminova.loadDetail(b), s.detail);
  const failed = await page.evaluate((s) => {
    const sv = window.cosminova;
    const c = sv.controls;
    c.stopFlight();
    c.cruise = 0;
    c.zoomVelocity = 0;
    if (s.hole) {
      sv.setView('blackHoles', true);
      sv.lookAtBlackHole(s.hole.key, s.hole.distanceRadii);
      c.fov = s.fov;
      return null;
    }
    if (s.sun) {
      sv.lookFromSun(s.sun.key, s.sun.distanceRadii, s.sun.phaseDeg, s.sun.tiltDeg);
      c.fov = s.fov;
      return null;
    }
    // target() returns nothing, so its result says nothing about success.
    sv.target(s.look.key, s.look.distanceRadii);
    c.stopFlight();
    c.distanceRadii = s.look.distanceRadii;
    c.fov = s.fov;
    return null;
  }, s);

  if (failed) {
    console.log(`  ${s.label.padEnd(14)} SKIPPED — ${failed}`);
    continue;
  }
  await settle();
  const file = path.join(OUT, `${which}-${s.label}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 86 });

  const { data } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  let lit = 0;
  for (const v of data) if (v > 12) lit++;
  console.log(`  ${s.label.padEnd(14)} lit ${((lit / data.length) * 100).toFixed(0).padStart(3)}%`);
  done.push({ label: s.label, file });
}

/* Sheet, labelled, so the winning parameter set is identifiable. */
const CELL_W = 373;
const CELL_H = Math.round((CELL_W * H) / W);
const cols = Math.min(4, done.length);
const rows = Math.ceil(done.length / cols);
const tiles = await Promise.all(
  done.map(async (d, i) => ({
    input: await sharp(d.file).resize(CELL_W, CELL_H).jpeg({ quality: 84 }).toBuffer(),
    left: (i % cols) * CELL_W,
    top: Math.floor(i / cols) * CELL_H,
  })),
);
const sheet = path.resolve(`shots/frame-${which}-sheet.jpg`);
await sharp({
  create: { width: cols * CELL_W, height: rows * CELL_H, channels: 3, background: { r: 8, g: 10, b: 16 } },
})
  .composite(tiles)
  .jpeg({ quality: 86 })
  .toFile(sheet);
console.log(`\n${sheet}\norder: ${done.map((d) => d.label).join(', ')}`);

await browser.close();
