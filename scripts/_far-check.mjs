/**
 * Why the camera is not where it was told to be.
 *
 * Placing it thousands of radii from the sun straight after standing on a
 * planet round another star put a galaxy on screen instead, so this reports
 * what the controls accepted against what was asked for.
 *
 * Usage: node scripts/_far-check.mjs
 */
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5182/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  defaultViewport: { width: 480, height: 854 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });

const settle = (n) =>
  page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        let count = 0;
        const tick = () => (++count > frames ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );

const AU = 149597870.7;
const wanted = (13 * AU) / 695700;

const report = async (label) => {
  const r = await page.evaluate(() => {
    const sv = window.cosminova;
    const c = sv.controls;
    const eye = c.worldPosition;
    const sun = sv.universe.get('sun').position;
    const d = Math.hypot(eye.x - sun.x, eye.y - sun.y, eye.z - sun.z);
    return {
      target: c.targetKey,
      distanceRadii: c.distanceRadii,
      max: c.maxDistanceRadii,
      min: c.minDistanceRadii,
      targetRadius: c.targetRadius,
      auFromSun: d / 149597870.7,
      fov: c.fov,
      earthView: c.earthView,
      riding: Boolean(c.riding),
    };
  });
  console.log(
    `${label.padEnd(22)} target ${String(r.target).padEnd(20)} radii ${r.distanceRadii.toFixed(1).padStart(10)}` +
      `  clamp [${r.min}, ${r.max}]  targetRadius ${r.targetRadius.toFixed(0).padStart(9)}  ${r.auFromSun.toFixed(2)} AU from sun`,
  );
  return r;
};

console.log(`asked for ${wanted.toFixed(1)} radii of the sun (13 AU)\n`);

await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setDate('2026-06-21T17:00:00.000Z');
});

await page.evaluate((radii) => window.cosminova.target('sun', radii), wanted);
await settle(20);
await report('target sun direct');

await page.evaluate((radii) => {
  window.cosminova.controls.stopFlight();
  window.cosminova.controls.distanceRadii = radii;
}, wanted);
await settle(10);
await report('after forcing radii');

// Now the path the video takes: away at another star first.
await page.evaluate(() => window.cosminova.target('exo:proxima-cen-b'));
await page.waitForFunction(
  () => Boolean(window.cosminova.standAt('exo:proxima-cen-b', { sunElevationDeg: 4, altitudeKm: 10 })),
  { timeout: 90000 },
);
await settle(30);
await report('standing on proxima b');

await page.evaluate((radii) => {
  const sv = window.cosminova;
  sv.target('sun', radii);
  sv.controls.stopFlight();
  sv.controls.distanceRadii = radii;
}, wanted);
await settle(30);
await report('back to the sun');

await browser.close();
