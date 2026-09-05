/**
 * How high do you have to stand on an exoplanet before the terrain stops
 * showing through the sky?
 *
 * The relief on these procedurally generated worlds runs to tens of kilometres,
 * and a camera inside it looks out through the undersides of the terrain
 * patches — a lit lattice hanging above the horizon, invisible against a bright
 * sky and obvious against a dark one. The height needed depends on where the
 * standing point lands, which moves with the sun elevation, so it is measured
 * rather than assumed: the tell is lit structure high in the frame, where only
 * sky belongs.
 *
 * Usage: node scripts/_exo-altitude.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots/exo-altitude');
const W = 700;
const H = 875;

const WORLDS = [
  { key: 'exo:trappist-1-e', detail: 'trappist-1-e', sun: 1 },
  { key: 'exo:proxima-cen-b', detail: 'proxima-cen-b', sun: 0.5 },
];
const ALTITUDES = [10, 25, 45, 70];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  ! page', e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
await page.evaluate(() => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.setUiVisible(false);
  for (const k of ['craft', 'trajectories', 'craftVectors', 'distantMarkers']) sv.setView(k, false);
  for (const k of ['labelPlanets', 'labelStars', 'labelExo', 'labelGalaxies']) sv.setView(k, false);
});

async function settle(minMs = 4000, maxMs = 30000) {
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

/**
 * Lit fraction of the top quarter of the frame. Sky at this sun elevation is a
 * dim gradient; terrain patches catching the star are far brighter and hard
 * edged, so a high count here means the camera is under the ground.
 */
function litHigh(raw) {
  let lit = 0;
  let n = 0;
  for (let y = Math.floor(H * 0.02); y < Math.floor(H * 0.26); y++) {
    for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 3;
      n++;
      if (raw[i] + raw[i + 1] + raw[i + 2] > 110) lit++;
    }
  }
  return lit / n;
}

console.log('world              alt      lit high in frame');
console.log('-'.repeat(50));

for (const world of WORLDS) {
  await page.evaluate((k) => window.cosminova.target(k), world.key);
  await page.waitForFunction(
    (k) => Boolean(window.cosminova.standAt(k, { sunElevationDeg: 2, altitudeKm: 20 })),
    { timeout: 120000 },
    world.key,
  );
  await page.evaluate((b) => window.cosminova.loadDetail(b), world.detail);

  for (const altitudeKm of ALTITUDES) {
    await page.evaluate(
      ({ k, sun, alt }) => {
        window.cosminova.controls.stopFlight();
        window.cosminova.standAt(k, {
          sunElevationDeg: sun,
          altitudeKm: alt,
          viewElevationDeg: 8,
          fov: 58,
        });
      },
      { k: world.key, sun: world.sun, alt: altitudeKm },
    );
    await settle();

    const short = world.key.replace('exo:', '');
    const file = path.join(OUT, `${short}-${String(altitudeKm).padStart(3, '0')}km.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 90 });
    const frac = litHigh(await sharp(file).removeAlpha().raw().toBuffer());
    console.log(
      `${short.padEnd(18)} ${String(altitudeKm).padStart(3)} km   ` +
        `${(frac * 100).toFixed(2).padStart(6)}%  ${frac < 0.005 ? 'clean' : 'terrain showing'}`,
    );
  }
}

console.log(`\nshots in ${OUT}`);
await browser.close();
