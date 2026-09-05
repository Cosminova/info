/**
 * Fixed views of the star field, for comparing before and against after.
 *
 * Usage: node scripts/_star-look.mjs <label> [url]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const LABEL = process.argv[2] ?? 'shot';
const URL = process.argv[3] ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots/stars');
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: 900, height: 600, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await page.evaluate(() => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.setUiVisible?.(false);
  for (const k of ['labelStars', 'labelGalaxies', 'labelPlanets', 'labelExo']) sv.setView?.(k, false);
});

// Out past Neptune and looking back into the galaxy, so the frame is sky rather
// than planet: this is the view where the star field is the whole picture.
await page.evaluate(() => {
  const sv = window.cosminova;
  sv.target('neptune', 400);
});
await new Promise((r) => setTimeout(r, 2500));

/** A few headings, so the comparison is not one lucky patch of sky. */
const VIEWS = [
  { name: 'galactic-centre', yaw: 4.65, pitch: -0.1, fov: 55 },
  { name: 'wide-field', yaw: 1.2, pitch: 0.25, fov: 70 },
  { name: 'zoomed', yaw: 4.65, pitch: -0.1, fov: 14 },
];

for (const v of VIEWS) {
  await page.evaluate((view) => {
    const sv = window.cosminova;
    sv.ui.setCameraMode('roam');
    const c = sv.controls;
    c.yaw = view.yaw;
    c.pitch = view.pitch;
    c.fov = view.fov;
  }, v);
  await new Promise((r) => setTimeout(r, 1600));
  await page.screenshot({
    path: path.join(OUT, `${v.name}-${LABEL}.jpg`),
    type: 'jpeg',
    quality: 94,
  });
}

console.log('shots in', OUT);
await browser.close();
