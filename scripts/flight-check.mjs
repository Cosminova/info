/**
 * Checks free flight, and the controls that advertise it.
 *
 * The pad exists so that someone who never touches the keyboard can still fly
 * and someone who does can see which key they are pressing; both are asserted
 * here, along with the reconciliation that makes the pad appear when thrust
 * goes live by some other route.
 *
 * The last assertion is about the flight model rather than the interface, and
 * is the one worth keeping longest: thrust has to follow where the camera is
 * looking. If it ever goes back to closing on the target instead, the mode
 * becomes an approach control wearing the name of a flight one, and no amount
 * of pressing W will take you somewhere the target is not.
 *
 * Usage: node scripts/flight-check.mjs [url]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots/flight');
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
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

const padVisible = () =>
  page.evaluate(() => {
    const node = document.querySelector('.flight');
    if (!node) return null;
    return !node.hidden && node.getBoundingClientRect().height > 0;
  });

const state = () =>
  page.evaluate(() => {
    const c = window.cosminova.controls;
    return {
      mode: c.mode,
      pos: [c.worldPosition.x, c.worldPosition.y, c.worldPosition.z],
      flySpeed: c.flySpeed,
    };
  });

// In orbit there is nothing for thrust to do, so the pad should be absent.
check('the pad is hidden in orbit mode', (await padVisible()) === false);

// Switching to Free through the interface, the way a user does.
const clicked = await page.evaluate(() => {
  const button = [...document.querySelectorAll('.seg button, .segmented button, button')].find(
    (b) => b.textContent.trim() === 'Free',
  );
  if (!button) return false;
  button.click();
  return true;
});
check('the interface offers a Free camera mode', clicked);
await new Promise((r) => setTimeout(r, 500));
check('choosing Free reveals the pad', (await padVisible()) === true);

// The pad has to be usable with the mouse alone: that is the whole point.
const before = await state();
const box = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.flight-key')].find((n) => n.textContent.trim() === 'W');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
check('the pad has a W button', Boolean(box));

if (box) {
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 1200));
  const lit = await page.evaluate(
    () =>
      [...document.querySelectorAll('.flight-key')]
        .find((n) => n.textContent.trim() === 'W')
        ?.classList.contains('is-down') ?? false,
  );
  const during = await state();
  await page.mouse.up();

  const moved = Math.hypot(
    during.pos[0] - before.pos[0],
    during.pos[1] - before.pos[1],
    during.pos[2] - before.pos[2],
  );
  check('holding the W button shows it pressed', lit);
  check('holding the W button moves the camera', moved > 1, `${moved.toExponential(2)} km`);

  await new Promise((r) => setTimeout(r, 500));
  const after = await state();
  const drift = Math.hypot(
    after.pos[0] - during.pos[0],
    after.pos[1] - during.pos[1],
    after.pos[2] - during.pos[2],
  );
  check('releasing the button stops the camera', drift < moved * 0.2, `drifted ${drift.toExponential(2)} km`);
}

// Pressing a key should light the matching button, so the pad reads as the
// same control rather than an alternative to it.
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', bubbles: true }));
});
await new Promise((r) => setTimeout(r, 350));
const keyLit = await page.evaluate(
  () =>
    [...document.querySelectorAll('.flight-key')]
      .find((n) => n.textContent.trim() === 'D')
      ?.classList.contains('is-down') ?? false,
);
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', bubbles: true }));
});
check('pressing D on the keyboard lights the D button', keyLit);

await page.screenshot({ path: path.join(OUT, 'free-mode.jpg'), type: 'jpeg', quality: 90 });

// Back to orbit: the pad goes, and nothing is left holding thrust down.
await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Orbit');
  button?.click();
});
await new Promise((r) => setTimeout(r, 500));
check('returning to Orbit hides the pad', (await padVisible()) === false);
const stuck = await page.evaluate(() =>
  ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft'].filter((c) =>
    window.cosminova.controls.isInputDown(c),
  ),
);
check('no input is left held', stuck.length === 0, stuck.join(',') || 'none');

// And the pad should return by itself when thrust goes live another way.
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
});
await new Promise((r) => setTimeout(r, 500));
const cameBack = await padVisible();
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
});
check('thrusting from orbit brings the pad back', cameBack === true);

/*
 * Turn the view away from the target, then thrust. Flying straight at
 * something changes the distance to it by the whole distance travelled;
 * setting off at an angle changes it by less. So the ratio separates a camera
 * that goes where you look from one that merely closes on its target.
 */
await page.evaluate(() => {
  const c = window.cosminova.controls;
  c.mode = 'fly';
  c.trackTarget = false;
});
const canvas = await page.$('canvas');
const area = await canvas.boundingBox();
await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
await page.mouse.down();
await page.mouse.move(area.x + area.width / 2 + 400, area.y + area.height / 2, { steps: 20 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 400));

const aimed = await state();
const aimedAlt = await page.evaluate(() => window.cosminova.controls.altitudeKm);
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
});
await new Promise((r) => setTimeout(r, 1200));
const flown = await state();
const flownAlt = await page.evaluate(() => window.cosminova.controls.altitudeKm);
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
});

const travelled = Math.hypot(
  flown.pos[0] - aimed.pos[0],
  flown.pos[1] - aimed.pos[1],
  flown.pos[2] - aimed.pos[2],
);
const closed = Math.abs(flownAlt - aimedAlt);
const ratio = closed / (travelled || 1);
check(
  'thrust follows the view rather than the target',
  travelled > 1 && ratio < 0.95,
  `closed ${(ratio * 100).toFixed(0)}% of the distance travelled`,
);

console.log();
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(errors.length ? `\n${errors.length} console problems:` : '\nno console errors');
for (const e of errors.slice(0, 5)) console.log(`  ! ${e}`);
console.log(`\nshots in ${OUT}`);

await browser.close();
process.exit(failed || errors.length ? 1 : 0);
