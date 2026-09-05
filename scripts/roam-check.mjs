/**
 * Checks the roaming camera, which is the one mode with no target.
 *
 * Every other mode holds the camera as a bearing and a distance from a body
 * and rebuilds its position from them every frame. That is what made "free
 * flight" still a flight *around something*: the body's motion was inherited,
 * the distance was clamped, and thrust only ever edited the bearing. Roaming
 * makes the position the state instead, so the assertions worth keeping are
 * the ones that would catch it quietly becoming an orbit again — that thrust
 * goes where the camera looks, that the view can turn the whole way round, and
 * above all that a moving target does not tow the camera along behind it.
 *
 * Usage: node scripts/roam-check.mjs [url]
 */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await page.evaluate(() => window.cosminova.setRate(0));
await new Promise((r) => setTimeout(r, 600));

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const state = () =>
  page.evaluate(() => {
    const c = window.cosminova.controls;
    return {
      mode: c.mode,
      pos: [c.worldPosition.x, c.worldPosition.y, c.worldPosition.z],
      fwd: [c._forward.x, c._forward.y, c._forward.z],
      yaw: c.yaw,
      distanceRadii: c.distanceRadii,
      flySpeed: c.flySpeed,
      anchor: c.roamOriginKey,
      referenceKm: c.roamReferenceKm,
      target: c.targetKey,
    };
  });

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v) => Math.hypot(v[0], v[1], v[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Hold a key for a number of animation frames. */
async function thrust(code, frames = 40) {
  await page.evaluate((c) => window.cosminova.controls.setInput(c, true), code);
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  }
  await page.evaluate((c) => window.cosminova.controls.setInput(c, false), code);
}

// Start somewhere ordinary: orbiting Earth.
await page.evaluate(() => window.cosminova.target('earth', 6));
await new Promise((r) => setTimeout(r, 900));

// --------------------------------------------------------- entering the mode
const before = await state();
const entered = await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === 'Roam',
  );
  if (!button) return false;
  button.click();
  return true;
});
check('a Roam control exists in the interface', entered);
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
const after = await state();

check('clicking it puts the camera in roam mode', after.mode === 'roam', `mode=${after.mode}`);

// The mode change must be felt, not seen: position and heading carry over.
const moved = len(sub(after.pos, before.pos));
const scale = Math.max(len(before.pos), 1);
check(
  'entering roam does not move the camera',
  moved / scale < 1e-6,
  `moved ${moved.toExponential(2)} km of ${scale.toExponential(2)}`,
);
check(
  'entering roam does not swing the view',
  dot(after.fwd, before.fwd) > 0.9995,
  `heading dot ${dot(after.fwd, before.fwd).toFixed(6)}`,
);

// ------------------------------------------------------- thrust follows view
// Turn well away from the target first, so that closing on it and flying where
// the camera points are clearly different outcomes.
await page.evaluate(() => {
  const c = window.cosminova.controls;
  c.yaw += Math.PI / 2;
});
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));

const preThrust = await state();
await thrust('KeyW', 45);
const postThrust = await state();

const travel = sub(postThrust.pos, preThrust.pos);
const travelled = len(travel);
check('pressing W moves the camera', travelled > 0, `${travelled.toExponential(2)} km`);

// Straight along the heading it had, which is what "not around a planet" means.
const alignment = travelled > 0 ? dot(travel, preThrust.fwd) / travelled : 0;
check(
  'thrust goes straight along the heading, not around the body',
  alignment > 0.999,
  `alignment ${alignment.toFixed(5)}`,
);

// ------------------------------------------------------------ turning freely
// The other modes steer with look offsets clamped to a cone; roaming must be
// able to turn round and look back at where it came from.
// Level first: turning through half a circle only reverses the heading exactly
// when there is no pitch on it, since pitch is the component yaw leaves alone.
const spun = await page.evaluate(async () => {
  const c = window.cosminova.controls;
  c.pitch = 0;
  await new Promise((r) => requestAnimationFrame(() => r()));
  const start = [c._forward.x, c._forward.y, c._forward.z];
  c.yaw += Math.PI;
  return start;
});
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
const turned = await state();
check(
  'the view can turn the whole way round',
  dot(turned.fwd, spun) < -0.99,
  `heading dot ${dot(turned.fwd, spun).toFixed(4)}`,
);

// ------------------------------------------------------- no tow from a target
// The point of the mode. Run time forward with no input at all: the selected
// body sweeps along its orbit, and a tethered camera would be carried with it.
await page.evaluate(() => {
  const sv = window.cosminova;
  // Somewhere with no body nearby, so the anchor is the star rather than a
  // planet whose motion the camera is meant to share.
  sv.controls.roamOffset.set(4e7, 1.2e7, 4e7);
  sv.setRate(0);
});
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
const stillA = await state();
await page.evaluate(() => window.cosminova.setRate(86400 * 20));
await new Promise((r) => setTimeout(r, 1400));
await page.evaluate(() => window.cosminova.setRate(0));
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
const stillB = await state();

const drift = len(sub(stillB.pos, stillA.pos));
// Earth covers millions of kilometres in twenty days; the camera should have
// stayed where it was to within a rounding of the star's own drift.
check(
  'a moving target does not tow the roaming camera',
  drift < 1e5,
  `drifted ${drift.toExponential(2)} km while the target moved on`,
);
check(
  'the camera anchors to something rather than floating free of precision',
  Boolean(stillB.anchor),
  `anchor=${stillB.anchor}`,
);

// ------------------------------------------------------------- wheel throttle
const speedBefore = (await state()).flySpeed;
const distBefore = (await state()).distanceRadii;
await page.evaluate(() => window.cosminova.controls.zoomBy(-0.8));
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
const afterWheel = await state();
check(
  'the wheel sets speed while roaming',
  afterWheel.flySpeed > speedBefore * 1.2,
  `${speedBefore.toFixed(3)} -> ${afterWheel.flySpeed.toFixed(3)}`,
);
check(
  'the wheel does not secretly move the camera instead',
  Math.abs(afterWheel.distanceRadii - distBefore) / Math.max(distBefore, 1) < 0.05,
  `distanceRadii ${distBefore.toFixed(1)} -> ${afterWheel.distanceRadii.toFixed(1)}`,
);

// --------------------------------------------------------------- speed scales
// Proportional to whatever is nearest, which is what keeps one control usable
// from a landing approach to an interstellar crossing.
const farReference = (await state()).referenceKm;
// Back to low orbit and let go again, so the nearest body is a few thousand
// kilometres away rather than a hundred million.
await page.evaluate(() => {
  const sv = window.cosminova;
  sv.ui.setCameraMode('orbit');
  sv.target('earth', 2.4);
});
await new Promise((r) => setTimeout(r, 900));
await page.evaluate(() => window.cosminova.ui.setCameraMode('roam'));
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
}
const nearReference = (await state()).referenceKm;
check(
  'speed is measured against the nearest body, so it falls as you close in',
  nearReference < farReference / 10,
  `${farReference.toExponential(2)} km out -> ${nearReference.toExponential(2)} km in`,
);

// ------------------------------------------------------------- leaving cleanly
const leftPos = (await state()).pos;
const left = await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === 'Orbit',
  );
  if (!button) return false;
  button.click();
  return true;
});
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
const back = await state();
check('leaving roam returns to orbit', left && back.mode === 'orbit', `mode=${back.mode}`);
const jump = len(sub(back.pos, leftPos));
check(
  'leaving roam does not throw the camera across the system',
  jump / Math.max(len(leftPos), 1) < 0.02,
  `jumped ${jump.toExponential(2)} km`,
);

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log('');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);

await browser.close();
process.exit(failed ? 1 : 0);
