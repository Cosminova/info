/**
 * The still images the website is built from.
 *
 * These are the same compositions the film uses, captured without the caption
 * layer and at a gallery aspect rather than a phone one, so the site is not
 * showing frames with burnt-in subtitles across the bottom. Kept as a script
 * rather than a folder of exported images because the shots are camera states:
 * if the sky or the star colours change, the site should be able to catch up by
 * being run again.
 *
 * Usage: node scripts/site-stills.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('site/assets/shots');
// 4:5 — tall enough to keep the sense of standing under a sky, short enough to
// tile in a grid without each image needing its own scroll.
const W = 1000;
const H = 1250;

fs.mkdirSync(OUT, { recursive: true });

/**
 * Each shot is either a place to stand or a thing to look at, matching the
 * beats in scripts/render-video.mjs.
 */
const SHOTS = [
  {
    name: 'earth-sunset',
    stand: { body: 'earth', sunElevationDeg: 0.5, altitudeKm: 2.5, viewElevationDeg: 7, fov: 58 },
    detail: 'earth',
  },
  {
    name: 'earth-dusk',
    stand: { body: 'earth', sunElevationDeg: -3.2, altitudeKm: 2.5, viewElevationDeg: 4, fov: 55 },
    detail: 'earth',
  },
  {
    name: 'mars-sunset',
    stand: { body: 'mars', sunElevationDeg: -0.5, altitudeKm: 4, viewElevationDeg: 6, fov: 58 },
    detail: 'mars',
  },
  // Stood on from far higher than the solar system worlds, and the reason is the
  // relief. This surface is invented rather than measured, and the procedural
  // terrain runs to tens of kilometres; from anywhere close to it the frame
  // fills with the undersides of the terrain patches, a lit lattice above the
  // horizon. It fades as the horizon drops away, and 70 km is where it stops
  // showing — see scripts/_exo-altitude.mjs. Proxima b was framed the same way
  // and is not here: it needed more height still before its lattice cleared,
  // and at that point it was the same picture as this one.
  {
    name: 'trappist-1e',
    stand: { body: 'exo:trappist-1-e', sunElevationDeg: 1, altitudeKm: 70, viewElevationDeg: 8, fov: 58 },
    exo: 'exo:trappist-1-e',
    detail: 'trappist-1-e',
  },
  { name: 'the-sun', look: { key: 'sun', distanceRadii: 8, fov: 34 } },
  { name: 'betelgeuse', look: { key: 'star:Betelgeuse', distanceRadii: 7, fov: 34 } },
  { name: 'sagittarius-a', hole: { key: 'sgr-a', distanceRadii: 130, fov: 38 } },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(m.text());
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });

await page.evaluate(() => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.setDate(new Date('2026-03-20T17:00:00Z'));
  sv.setUiVisible(false);
  // Navigation aids: useful in the app, clutter in a photograph.
  for (const key of ['craft', 'trajectories', 'craftVectors', 'distantMarkers']) sv.setView(key, false);
  for (const key of ['labelPlanets', 'labelStars', 'labelGalaxies', 'labelBlackHoles', 'labelCraft', 'labelExo']) {
    sv.setView(key, false);
  }
  sv.setQuality?.('ultra') ?? sv.quality?.setPreset?.('ultra');
});

/**
 * Terrain arrives over several frames and textures upgrade behind it, so a
 * capture taken on arrival records the low-detail version. Waits for the patch
 * count to stop moving.
 */
async function settle({ minMs = 2500, maxMs = 30000 } = {}) {
  const started = Date.now();
  let last = -1;
  let stable = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 60));
    const patches = await page.evaluate(() => window.cosminova.stats().patches);
    if (patches === last) stable++;
    else {
      stable = 0;
      last = patches;
    }
    const waited = Date.now() - started;
    if (stable >= 3 && waited >= minMs) return;
    if (waited >= maxMs) return;
  }
}

for (const shot of SHOTS) {
  if (shot.exo) {
    // Built on demand, so it has to be asked for and waited on before there is
    // a surface to stand on.
    await page.evaluate((key) => window.cosminova.target(key), shot.exo);
    await page.waitForFunction(
      (key) => Boolean(window.cosminova.standAt(key, { sunElevationDeg: 2, altitudeKm: 10 })),
      { timeout: 120000 },
      shot.exo,
    );
  }
  if (shot.detail) await page.evaluate((b) => window.cosminova.loadDetail(b), shot.detail);

  await page.evaluate((s) => {
    const sv = window.cosminova;
    const c = sv.controls;
    c.stopFlight();
    c.cruise = 0;
    c.zoomVelocity = 0;
    c.yawVelocity = 0;
    c.pitchVelocity = 0;

    if (s.stand) {
      const { body, ...options } = s.stand;
      sv.standAt(body, options);
      return;
    }
    if (s.hole) {
      sv.setView('blackHoles', true);
      sv.lookAtBlackHole(s.hole.key, s.hole.distanceRadii);
      c.fov = s.hole.fov;
      return;
    }
    sv.target(s.look.key, s.look.distanceRadii);
    c.stopFlight();
    c.distanceRadii = s.look.distanceRadii;
    c.fov = s.look.fov;
  }, shot);

  await settle(shot.stand ? { minMs: 5000, maxMs: 45000 } : {});

  const file = path.join(OUT, `${shot.name}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 92 });
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`  ${shot.name.padEnd(16)} ${kb.padStart(5)} KB`);
}

console.log(problems.length ? `\n${problems.length} console problems:` : '\nno console errors');
for (const p of problems.slice(0, 5)) console.log(`  ! ${p}`);
console.log(`\nstills in ${OUT}`);

await browser.close();
