/**
 * How far in can you actually get, standing on the ground?
 *
 * Reported as not being able to zoom into far stars from Earth. On the ground
 * the camera is pinned to the surface and its distance is rebuilt from that
 * every frame, so the only zoom that can mean anything is the field of view.
 * This drives the real wheel event rather than calling the controls directly,
 * because the thing that was broken was the wheel.
 *
 * Each step reports the field, the magnification it amounts to, and how many
 * separate points of light are on screen. That last number is the one that says
 * whether zooming is worth doing: if the sky empties out as you go in, the
 * magnification is real but there is nothing at the end of it.
 *
 * Usage: node scripts/zoom-check.mjs [steps] [target key]
 */
import sharp from 'sharp';
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const STEPS = Number(process.argv[2] ?? 60);
const TARGET = process.argv[3] ?? 'star:Vega';
const SHOT_AT = new Set([0, 12, 24, 36, 48, STEPS]);

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 720, height: 450 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.cosminova?.ready === true, { timeout: 120000 });
await page.evaluate((target) => {
  window.cosminova.setRate(0);
  window.cosminova.setUiVisible(false);
  window.cosminova.target(target, 0);
  window.cosminova.viewFromEarth(true);
}, TARGET);
await new Promise((r) => setTimeout(r, 3000));

/** Count separate bright points, so two stars pulling apart read as two. */
async function survey() {
  const png = await page.screenshot({ type: 'png' });
  const { data, info } = await sharp(png).removeAlpha().greyscale().raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const seen = new Uint8Array(width * height);
  let blobs = 0;
  let lit = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > 26) lit++;
    if (data[i] <= 26 || seen[i]) continue;
    blobs++;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop();
      const x = p % width;
      const y = (p / width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (seen[n] || data[n] <= 26) continue;
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
  }
  return { blobs, litPct: (100 * lit) / data.length, png };
}

const shots = [];
console.log(`zooming in on ${TARGET} from the ground, one wheel notch at a time:\n`);
console.log('  step  field of view   magnification   distance to it   points  on');

let previous = null;
let stuckAt = null;
let arrivedAt = null;
let everLeft = false;
for (let step = 0; step <= STEPS; step++) {
  if (step > 0) {
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      // One notch of a real mouse wheel, so the gearing being measured is the
      // gearing a person gets.
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    });
    await new Promise((r) => setTimeout(r, 240));
  }
  const now = await page.evaluate(() => ({
    fov: window.cosminova.controls.fov,
    distanceKm: window.cosminova.controls.distanceKm,
    onGround: window.cosminova.state.viewFromEarth,
    // Sitting on the surface of the thing is arriving, not being stuck.
    arrived: window.cosminova.controls.distanceRadii
      <= window.cosminova.controls.minDistanceRadii * (1 + 1e-6),
  }));
  if (!now.onGround) everLeft = true;
  if (now.arrived) arrivedAt ??= step;
  // Stuck means neither the field nor the distance moved and there is still
  // somewhere to go.
  const moved = previous === null
    || now.fov < previous.fov - 1e-12
    || now.distanceKm < previous.distanceKm * (1 - 1e-9);
  if (!moved && !now.arrived && stuckAt === null) stuckAt = { step, ...now };
  previous = now;

  if (SHOT_AT.has(step)) {
    const { blobs, litPct, png } = await survey();
    shots.push({ step, fov: now.fov, png });
    console.log(`  ${String(step).padStart(4)}  ${now.fov.toExponential(2).padStart(8)} deg   `
      + `${(58 / now.fov).toExponential(2).padStart(9)}x   `
      + `${now.distanceKm.toExponential(2).padStart(9)} km   `
      + `${String(blobs).padStart(6)}  ${now.onGround ? 'ground' : 'flying'}`
      + `  (${litPct.toFixed(2)}% lit)`);
  }
}

const composite = await Promise.all(shots.map(async (s, i) => ({
  input: await sharp(s.png).resize(360, 225).png().toBuffer(),
  left: (i % 3) * 360,
  top: Math.floor(i / 3) * 225,
})));
await sharp({
  create: { width: 1080, height: 225 * Math.ceil(shots.length / 3), channels: 3, background: '#000' },
})
  .composite(composite)
  .png()
  .toFile('shots/zoom-ladder.png');

console.log(`\n  contact sheet: shots/zoom-ladder.png`);
const problems = [];
if (stuckAt) {
  problems.push(`the wheel stopped doing anything at step ${stuckAt.step}: `
    + `${stuckAt.fov.toExponential(2)} deg, ${stuckAt.distanceKm.toExponential(2)} km out`);
}
if (!everLeft) problems.push('never got off the ground, so the zoom has a wall in it');
if (arrivedAt === null) problems.push(`never reached ${TARGET} in ${STEPS} notches`);
if (errors.length) problems.push(`console: ${[...new Set(errors)][0].slice(0, 120)}`);

console.log(problems.length
  ? `\n${problems.map((p) => `FAIL ${p}`).join('\n')}`
  : `\none unbroken scroll from a 58 deg field on the ground to the surface of `
    + `${TARGET} (arrived at notch ${arrivedAt}), never stopping on the way`);
await browser.close();
process.exit(problems.length ? 1 : 0);
