/**
 * What does an exoplanet actually look like, and how bright is it?
 *
 * Shoots a few of them from orbit and measures the disc: mean level, how much
 * of it is clipped to white, and how much variation there is across the
 * surface. A planet that reads as a star is either blown out — most of the
 * disc at full white — or flat, with almost no variation for the eye to read
 * as surface. The two have different causes and different fixes, so they are
 * measured separately.
 *
 * Usage: node scripts/_exo-look.mjs [url]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.argv[2] ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots/exo-look');
const W = 720;
const H = 720;

// A hot giant close in, a temperate rocky world, and a cool one, so the
// comparison spans the range rather than one complaint.
const TARGETS = [
  'exo:toi-150-01',
  'exo:trappist-1-e',
  'exo:proxima-cen-b',
  'exo:kepler-452-b',
];

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

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await page.evaluate(() => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.setUiVisible(false);
  for (const k of ['craft', 'trajectories', 'craftVectors', 'distantMarkers']) sv.setView(k, false);
  for (const k of ['labelPlanets', 'labelStars', 'labelExo', 'labelGalaxies']) sv.setView(k, false);
});

async function settle(minMs = 3000, maxMs = 25000) {
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

/** Mean, clipped fraction and spread over the pixels that are not background. */
function discStats(raw) {
  let sum = 0;
  let clipped = 0;
  let lit = 0;
  const values = [];
  for (let i = 0; i < raw.length; i += 3) {
    const r = raw[i];
    const g = raw[i + 1];
    const b = raw[i + 2];
    const v = (r + g + b) / 3;
    // Anything well above the star field counts as the body.
    if (v < 26) continue;
    lit++;
    sum += v;
    if (r > 250 && g > 250 && b > 250) clipped++;
    if (values.length < 40000) values.push(v);
  }
  if (!lit) return null;
  const mean = sum / lit;
  values.sort((a, b) => a - b);
  const p10 = values[Math.floor(values.length * 0.1)] ?? 0;
  const p90 = values[Math.floor(values.length * 0.9)] ?? 0;
  return {
    coverage: lit / (raw.length / 3),
    mean,
    clipped: clipped / lit,
    spread: p90 - p10,
  };
}

console.log('body                 coverage    mean   clipped   spread');
console.log('-'.repeat(62));

for (const key of TARGETS) {
  // target() loads the host system; lookAtExo can only frame it once resident.
  await page.evaluate((k) => window.cosminova.target(k), key);
  const framed = await page
    .waitForFunction(
      (k) => {
        const sv = window.cosminova;
        return Boolean(sv.exoSystem && sv.exoSystem.get(k)) ? sv.lookAtExo(k, 2.8, 38, 12) : false;
      },
      { timeout: 90000, polling: 250 },
      key,
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  if (!framed) {
    console.log(`${key.replace('exo:', '').padEnd(20)} could not be framed`);
    continue;
  }
  await settle();

  const file = path.join(OUT, `${key.replace('exo:', '')}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 92 });
  const stats = discStats(await sharp(file).removeAlpha().raw().toBuffer());
  if (!stats) {
    console.log(`${key.replace('exo:', '').padEnd(20)} nothing lit in frame`);
    continue;
  }
  console.log(
    `${key.replace('exo:', '').padEnd(20)} ${(stats.coverage * 100).toFixed(1).padStart(6)}% ` +
      `${stats.mean.toFixed(0).padStart(6)} ` +
      `${(stats.clipped * 100).toFixed(1).padStart(7)}% ` +
      `${stats.spread.toFixed(0).padStart(7)}`,
  );
}

console.log(`\nshots in ${OUT}`);
await browser.close();
