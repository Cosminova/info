/**
 * Which way the scene moves when you drag.
 *
 * Asserting the sign of a yaw variable would only restate the code. What
 * matters is where the pixels go, so this drags across a body and measures the
 * direction the image actually shifted, by finding the horizontal offset that
 * best lines the after-frame up with the before-frame.
 *
 * The convention, for orbit drags: the camera turns like a head turns. Pull
 * the mouse left and the view swings left, so the scene slides right. Dragging
 * the scene along with the hand is the other convention and the opposite sign;
 * this is the one the app chose, and the point of this check is that a later
 * refactor cannot quietly swap it back.
 *
 * Usage: node scripts/drag-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = 'shots/drag';
fs.mkdirSync(OUT, { recursive: true });

const W = 1200;
const H = 760;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));

// The first-run card sits over the middle of the screen, which is exactly
// where these drags start.
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

/**
 * The horizontal shift, in pixels, that best maps `before` onto `after`.
 *
 * Positive means the image moved right. Works on a column-brightness profile
 * rather than the full raster: a rotation about the target is close enough to a
 * horizontal translation over a small drag, and one number per column is both
 * cheap and immune to the fine per-pixel noise a renderer produces between
 * frames.
 */
async function shift(before, after) {
  const profile = async (buf) => {
    const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    const columns = new Float64Array(info.width);
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) columns[x] += data[y * info.width + x];
    }
    // Mean-centred, so the correlation below measures shape rather than
    // overall brightness.
    const mean = columns.reduce((a, b) => a + b, 0) / columns.length;
    for (let x = 0; x < columns.length; x++) columns[x] -= mean;
    return columns;
  };

  const a = await profile(before);
  const b = await profile(after);
  const LIMIT = 220;
  let best = 0;
  let bestScore = -Infinity;
  for (let offset = -LIMIT; offset <= LIMIT; offset++) {
    let score = 0;
    let n = 0;
    for (let x = 0; x < a.length; x++) {
      const j = x + offset;
      if (j < 0 || j >= b.length) continue;
      score += a[x] * b[j];
      n++;
    }
    if (n < a.length * 0.5) continue;
    score /= n;
    if (score > bestScore) {
      bestScore = score;
      best = offset;
    }
  }
  return best;
}

/** Drags across the middle of the canvas and returns how far the scene moved. */
async function drag(dx, name) {
  const midX = Math.round(W / 2);
  const midY = Math.round(H / 2);

  await page.evaluate(() => {
    const c = window.cosminova.controls;
    c.stopFlight();
    c.cruise = 0;
    c.zoomVelocity = 0;
    c.yawVelocity = 0;
    c.pitchVelocity = 0;
  });
  await new Promise((r) => setTimeout(r, 900));
  const before = await page.screenshot({ type: 'png' });

  await page.mouse.move(midX, midY);
  await page.mouse.down({ button: 'left' });
  // In steps: one jump produces a single large pointermove, which is not how a
  // hand moves and interacts differently with the coasting on release.
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(midX + (dx * i) / steps, midY);
    await new Promise((r) => setTimeout(r, 16));
  }
  await page.mouse.up({ button: 'left' });

  // Long enough for the release coast to damp out, so the measurement is of
  // where the view settled rather than mid-glide.
  await new Promise((r) => setTimeout(r, 1600));
  const after = await page.screenshot({ type: 'png' });

  fs.writeFileSync(path.join(OUT, `${name}-before.png`), before);
  fs.writeFileSync(path.join(OUT, `${name}-after.png`), after);
  return shift(before, after);
}

/* Jupiter: banded, high contrast, and wide enough to fill the frame with
   features that survive being reduced to a column profile. */
await page.evaluate(async () => {
  const sv = window.cosminova;
  await sv.loadDetail('jupiter');
  sv.lookFromSun('jupiter', 3.4, 40, 8);
  sv.controls.fov = 40;
});
await new Promise((r) => setTimeout(r, 3500));

const left = await drag(-260, 'drag-left');
console.log(`\n  drag left  260 px   scene moved ${left > 0 ? '+' : ''}${left} px`);
check(left > 40, 'dragging left moves the scene right', `${left} px`);

const right = await drag(260, 'drag-right');
console.log(`  drag right 260 px   scene moved ${right > 0 ? '+' : ''}${right} px`);
check(right < -40, 'dragging right moves the scene left', `${right} px`);

check(
  Math.sign(left) !== Math.sign(right),
  'the two directions are opposites',
  `${left} px against ${right} px`,
);

/*
 * The coast after release must carry on the way the drag was going. This is
 * the failure a sign flip invites: turn the drag round and leave the inertia
 * alone, and the view snaps back the moment the button comes up.
 */
const coast = await page.evaluate(async () => {
  const c = window.cosminova.controls;
  c.yawVelocity = 0;
  c.pitchVelocity = 0;
  const dom = document.querySelector('canvas');
  const at = (type, x) =>
    dom.dispatchEvent(
      new PointerEvent(type, { pointerId: 1, clientX: x, clientY: 380, button: 0, bubbles: true }),
    );
  at('pointerdown', 600);
  for (let i = 1; i <= 8; i++) at('pointermove', 600 - i * 20);
  const beforeYaw = c.yaw;
  at('pointerup', 440);
  return { velocity: c.yawVelocity, beforeYaw };
});
check(
  Math.sign(coast.velocity) === -1,
  'the release coast continues the drag rather than reversing it',
  `yawVelocity ${coast.velocity.toFixed(5)} after a leftward drag`,
);

check(problems.length === 0, 'no page errors', problems.slice(0, 2).join(' | '));

console.log(`\nframes in ${path.resolve(OUT)}`);
console.log(failures ? `\n${failures} failed` : '\nall passed');

await browser.close();
process.exit(failures ? 1 : 0);
