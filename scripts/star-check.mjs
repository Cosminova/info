/**
 * That a star you have visited does not come with you.
 *
 * A star gets a real sphere only while it is the target; every other star is
 * drawn by the deep field as a point. The sphere is positioned as an offset
 * from an origin that moves with the camera, so one that stops being updated
 * keeps its last offset and thereby stops holding a fixed point in space and
 * starts tracking the camera. Visit Betelgeuse, fly to Mars, and a 712 solar
 * radius sphere arrives too and sits in the sky behind Mars.
 *
 * Tested by difference rather than by eye: the same destination is framed on a
 * clean load and again after a detour through a star, and the two frames have
 * to match. That way the check knows nothing about how the fix works and would
 * still catch the symptom if it came back by another route.
 *
 * Run against several stars, since the bug was never specific to one.
 *
 * Usage: node scripts/star-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = 'shots/star';
fs.mkdirSync(OUT, { recursive: true });

/* Bright giants, because a small dim star leaves too little on screen for a
   difference to mean anything. Betelgeuse is the one that was reported. */
const STARS = ['star:Betelgeuse', 'star:Antares', 'star:Rigel'];
const AFTER = 'mars';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: 1000, height: 640, deviceScaleFactor: 1 },
});

/** A page with the clock stopped, the UI hidden and the intro already seen. */
async function openPage() {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('cosminova.prefs', JSON.stringify({ seenIntro: true }));
  });
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
  });
  return page;
}

/** Frames a body and lets the terrain and textures catch up before capturing. */
async function settleOn(page, key, distanceRadii) {
  await page.evaluate(
    async ([k, d]) => {
      const sv = window.cosminova;
      sv.target(k, d);
      sv.controls.stopFlight();
      sv.controls.cruise = 0;
      sv.controls.zoomVelocity = 0;
      sv.controls.distanceRadii = d;
    },
    [key, distanceRadii],
  );
  await new Promise((r) => setTimeout(r, 2600));
}

/** Mean level and the share of pixels carrying anything. */
async function levels(buffer) {
  const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let lit = 0;
  for (const v of data) {
    sum += v;
    if (v > 24) lit++;
  }
  return { mean: sum / data.length, lit: lit / (info.width * info.height) };
}

/* The control: Mars on a clean load, never having been near a star. */
const clean = await openPage();
await settleOn(clean, AFTER, 3.2);
const control = await clean.screenshot({ type: 'png' });
fs.writeFileSync(path.join(OUT, 'control.png'), control);
const base = await levels(control);
console.log(`control: ${AFTER} on a clean load — mean ${base.mean.toFixed(1)}, lit ${(base.lit * 100).toFixed(1)}%\n`);
await clean.close();

for (const star of STARS) {
  const page = await openPage();
  const name = star.replace(/[^a-z0-9]/gi, '-').toLowerCase();

  // Out to the star, then in close, which is what leaves the sphere sitting
  // near the camera's origin.
  await settleOn(page, star, 6);
  await settleOn(page, star, 1.6);
  const atStar = await page.screenshot({ type: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}-at.png`), atStar);
  const near = await levels(atStar);
  // If the star never rendered, the rest of the run proves nothing.
  check(near.lit > 0.05, `${star} is actually on screen when visited`, `lit ${(near.lit * 100).toFixed(1)}%`);

  // And away again.
  await settleOn(page, AFTER, 3.2);
  const after = await page.screenshot({ type: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}-after.png`), after);
  const left = await levels(after);

  const meanDrift = Math.abs(left.mean - base.mean);
  const litDrift = Math.abs(left.lit - base.lit);
  console.log(
    `  after ${star}: mean ${left.mean.toFixed(1)} (${meanDrift >= 0 ? '+' : ''}${(left.mean - base.mean).toFixed(1)})` +
      `, lit ${(left.lit * 100).toFixed(1)}% (${((left.lit - base.lit) * 100).toFixed(1)})`,
  );
  // Frames are not bit-identical — the starfield twinkles and terrain streams
  // in — so this is a tolerance, set well below what a star filling part of
  // the frame would add.
  check(
    meanDrift < 3 && litDrift < 0.03,
    `${AFTER} looks the same after visiting ${star}`,
    `mean drift ${meanDrift.toFixed(2)}, lit drift ${(litDrift * 100).toFixed(2)}pp`,
  );

  /*
   * And the direct question, in case a future change makes the sphere cheap to
   * leave in the frame somewhere harmless: is it still being drawn at all?
   */
  const stillDrawn = await page.evaluate((key) => {
    let found = null;
    window.cosminova.scene.traverse((node) => {
      if (node.name === key) found = { visible: node.visible };
    });
    return found;
  }, star);
  check(
    stillDrawn !== null && stillDrawn.visible === false,
    `${star}'s sphere is hidden once it is not the target`,
    stillDrawn === null ? 'no group found for it' : `visible ${stillDrawn.visible}`,
  );

  /*
   * And back again. Hiding a star must not be a one-way door: this second
   * visit runs through the cached mesh rather than a freshly built one, so it
   * is a different path from the first and the one a heavier-handed fix
   * (disposing the mesh, say) would break.
   */
  await settleOn(page, star, 1.6);
  const again = await page.screenshot({ type: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}-again.png`), again);
  const back = await levels(again);
  check(
    Math.abs(back.lit - near.lit) < 0.05,
    `${star} comes back when revisited`,
    `lit ${(back.lit * 100).toFixed(1)}% against ${(near.lit * 100).toFixed(1)}% first time`,
  );

  await page.close();
}

console.log(`\nframes in ${path.resolve(OUT)}`);
console.log(failures ? `\n${failures} failed` : '\nall passed');

await browser.close();
process.exit(failures ? 1 : 0);
