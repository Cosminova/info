/**
 * Which way the scene moves when you drag.
 *
 * Asserting the sign of a yaw variable would only restate the code. What
 * matters is where the pixels go, so this drags across a body and measures the
 * direction the image actually shifted, by finding the horizontal offset that
 * best lines the after-frame up with the before-frame.
 *
 * The convention: a drag carries the scene with it, the way a finger turns a
 * globe. Pull left and what you are looking at goes left; pull up and it goes
 * up. Turning the camera instead — so the scene slides the opposite way — is
 * the other convention and the opposite sign.
 *
 * Both axes are measured, because the fault this check exists to catch was not
 * a wrong sign but a mismatched pair: the vertical carried the scene while the
 * horizontal turned the camera, and a drag across a planet came out feeling
 * like one axis was inverted.
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
 * The shift, in pixels, that best maps `before` onto `after` along one axis.
 *
 * Positive means the image moved right, or down. Works on a brightness profile
 * — one number per column, or per row — rather than the full raster: a rotation
 * about the target is close enough to a translation over a small drag, and a
 * profile is both cheap and immune to the fine per-pixel noise a renderer
 * produces between frames.
 */
async function shift(before, after, axis = 'x') {
  const profile = async (buf) => {
    const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    const lanes = new Float64Array(axis === 'x' ? info.width : info.height);
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) lanes[axis === 'x' ? x : y] += data[y * info.width + x];
    }
    // Mean-centred, so the correlation below measures shape rather than
    // overall brightness.
    const mean = lanes.reduce((a, b) => a + b, 0) / lanes.length;
    for (let i = 0; i < lanes.length; i++) lanes[i] -= mean;
    return lanes;
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
async function drag(dx, dy, name) {
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
    await page.mouse.move(midX + (dx * i) / steps, midY + (dy * i) / steps);
    await new Promise((r) => setTimeout(r, 16));
  }
  await page.mouse.up({ button: 'left' });

  // Long enough for the release coast to damp out, so the measurement is of
  // where the view settled rather than mid-glide.
  await new Promise((r) => setTimeout(r, 1600));
  const after = await page.screenshot({ type: 'png' });

  fs.writeFileSync(path.join(OUT, `${name}-before.png`), before);
  fs.writeFileSync(path.join(OUT, `${name}-after.png`), after);
  return { x: await shift(before, after, 'x'), y: await shift(before, after, 'y') };
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

const mode = await page.evaluate(() => window.cosminova.controls.mode);
console.log(`\n  framed in ${mode} mode\n`);

const left = await drag(-260, 0, 'drag-left');
console.log(`  drag left  260 px   scene moved ${left.x > 0 ? '+' : ''}${left.x} px across`);
check(left.x < -40, 'dragging left takes the scene left with it', `${left.x} px`);

const right = await drag(260, 0, 'drag-right');
console.log(`  drag right 260 px   scene moved ${right.x > 0 ? '+' : ''}${right.x} px across`);
check(right.x > 40, 'dragging right takes the scene right with it', `${right.x} px`);

check(
  Math.sign(left.x) !== Math.sign(right.x),
  'the two directions are opposites',
  `${left.x} px against ${right.x} px`,
);

// The vertical axis, which is the half that decides whether a drag feels
// consistent. It has always taken the scene with the hand; the horizontal used
// to turn the camera instead, and the mismatch read as an inverted axis.
const up = await drag(0, -240, 'drag-up');
console.log(`  drag up    240 px   scene moved ${up.y > 0 ? '+' : ''}${up.y} px down`);
check(up.y < -30, 'dragging up takes the scene up with it', `${up.y} px`);

const down = await drag(0, 240, 'drag-down');
console.log(`  drag down  240 px   scene moved ${down.y > 0 ? '+' : ''}${down.y} px down`);
check(down.y > 30, 'dragging down takes the scene down with it', `${down.y} px`);

// A left drag and an up drag both go negative — left and up — so the two axes
// agree and a diagonal drag cannot come out feeling inverted on one of them.
check(
  Math.sign(left.x) === Math.sign(up.y),
  'both axes follow the hand, so a diagonal drag cannot feel inverted',
  `${left.x} px across on a left drag, ${up.y} px down on an up drag`,
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
  const beforeYaw = c.yaw;
  at('pointerdown', 600);
  for (let i = 1; i <= 8; i++) at('pointermove', 600 - i * 20);
  // Where the drag itself took yaw, which is what the coast has to continue.
  const turned = c.yaw - beforeYaw;
  at('pointerup', 440);
  return { velocity: c.yawVelocity, turned };
});
// Compared against the drag rather than against a fixed sign, so this keeps
// its meaning if the convention is ever turned round again.
check(
  coast.turned !== 0 && Math.sign(coast.velocity) === Math.sign(coast.turned),
  'the release coast continues the drag rather than reversing it',
  `yaw moved ${coast.turned.toFixed(5)} during the drag, `
    + `yawVelocity ${coast.velocity.toFixed(5)} after it`,
);

check(problems.length === 0, 'no page errors', problems.slice(0, 2).join(' | '));

console.log(`\nframes in ${path.resolve(OUT)}`);
console.log(failures ? `\n${failures} failed` : '\nall passed');

await browser.close();
process.exit(failures ? 1 : 0);
