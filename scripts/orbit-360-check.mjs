/**
 * Sweeps the orbit camera through a full turn of pitch and checks it stays sane.
 *
 * Reported as "when I am looking around an object it just stops when it gets to
 * the top". It did: pitch was clamped a degree short of the pole, because at the
 * pole the view direction is parallel to world up and the horizon is undefined.
 *
 * Going over the top is only an improvement if the frame survives the crossing,
 * and there are two ways for it not to. The camera can jump — a discontinuity in
 * where it ends up — or it can roll, the image spinning 180 degrees as the up
 * vector reverses under it. Both are invisible in a screenshot and obvious in
 * motion, so this measures them: the angle the view direction turns between one
 * step and the next, and the angle the up vector turns. Over a smooth sweep both
 * should stay close to the step size.
 *
 * Usage: node scripts/orbit-360-check.mjs
 */
import puppeteer from 'puppeteer-core';

const URL = 'http://127.0.0.1:5179/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const STEPS = 72;
const STEP_DEG = 360 / STEPS;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 900, height: 560 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.cosminova?.ready === true, { timeout: 120000 });
await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setUiVisible(false);
  window.cosminova.target('earth', 4);
});
await new Promise((r) => setTimeout(r, 1500));

const samples = await page.evaluate(async (steps) => {
  const sv = window.cosminova;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const pitch = (i / steps) * Math.PI * 2 - Math.PI;
    sv.controls.pitch = pitch;
    sv.controls.yaw = 0.7;
    sv.controls.pitchVelocity = 0;
    sv.controls.yawVelocity = 0;
    // One frame, so the controls rebuild the camera basis from the new pitch.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // Read the basis straight off the camera's world matrix.
    const e = sv.camera.matrixWorld.elements;
    out.push({
      pitchDeg: (pitch * 180) / Math.PI,
      // Three's camera looks down -Z.
      forward: [-e[8], -e[9], -e[10]],
      up: [e[4], e[5], e[6]],
      appliedPitch: sv.controls.pitch,
    });
  }
  return out;
}, STEPS);

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angleBetween = (a, b) => (Math.acos(Math.min(1, Math.max(-1, dot(a, b)))) * 180) / Math.PI;

let worstTurn = 0; let worstTurnAt = 0;
let worstRoll = 0; let worstRollAt = 0;
let clamped = 0;
for (let i = 1; i < samples.length; i++) {
  const turn = angleBetween(samples[i - 1].forward, samples[i].forward);
  const roll = angleBetween(samples[i - 1].up, samples[i].up);
  if (turn > worstTurn) { worstTurn = turn; worstTurnAt = samples[i].pitchDeg; }
  if (roll > worstRoll) { worstRoll = roll; worstRollAt = samples[i].pitchDeg; }
}
// Did the camera actually accept the pitch it was given, or clamp it away?
for (const s of samples) {
  // Compared modulo a full turn: pitch is wrapped into (-180, 180], so asking
  // for +180 and reading back -180 is the same angle, not a refusal.
  const applied = (s.appliedPitch * 180) / Math.PI;
  let diff = Math.abs(applied - s.pitchDeg) % 360;
  if (diff > 180) diff = 360 - diff;
  if (diff > 0.5) clamped++;
}

console.log('samples either side of the south pole:');
for (const s of samples) {
  if (Math.abs(s.pitchDeg + 90) > 11) continue;
  console.log(`  pitch ${s.pitchDeg.toFixed(0).padStart(4)}  `
    + `fwd [${s.forward.map((v) => v.toFixed(3).padStart(6)).join(' ')}]  `
    + `up [${s.up.map((v) => v.toFixed(3).padStart(6)).join(' ')}]`);
}

console.log(`\nswept ${STEPS} steps of ${STEP_DEG.toFixed(1)} degrees around the pitch circle\n`);
console.log(`  pitch values refused by a clamp: ${clamped}`);
console.log(`  largest step in view direction:  ${worstTurn.toFixed(2)} deg  `
  + `(at pitch ${worstTurnAt.toFixed(0)})`);
console.log(`  largest step in up vector:       ${worstRoll.toFixed(2)} deg  `
  + `(at pitch ${worstRollAt.toFixed(0)})`);

// A screenshot straight over the top, which used to be unreachable.
await page.evaluate(() => {
  const sv = window.cosminova;
  sv.controls.pitch = Math.PI * 0.72;
  sv.controls.yaw = 0.7;
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: 'shots/_orbit-over-the-top.png' });

await browser.close();

const failures = [];
if (clamped) failures.push(`${clamped} pitch values were clamped away`);
// Allowing generous headroom over the step size: what this is looking for is a
// jump or a flip, which show up as tens of degrees, not as rounding.
if (worstTurn > STEP_DEG * 2.5) failures.push(`view jumps ${worstTurn.toFixed(1)} deg at the pole`);
if (worstRoll > STEP_DEG * 2.5) failures.push(`view rolls ${worstRoll.toFixed(1)} deg at the pole`);
for (const e of errors.slice(0, 5)) failures.push(e);

if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('\nfull 360 pitch, no clamp, no jump, no roll');
