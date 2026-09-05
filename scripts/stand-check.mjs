/**
 * Checks that standAt puts the sun where it says it does.
 *
 * The framing it produces is worked out from geometry rather than dialled in by
 * eye, so it is worth confirming against the finished camera: the sun's real
 * elevation above the horizon, and how far off centre it lands in frame. Both
 * should come back as asked for, on any world, around any star.
 *
 * Usage: node scripts/stand-check.mjs
 */
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5182/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const CASES = [
  { body: 'earth', sunElevationDeg: 8, altitudeKm: 2 },
  { body: 'earth', sunElevationDeg: 0, altitudeKm: 2 },
  { body: 'earth', sunElevationDeg: -4, altitudeKm: 2 },
  { body: 'earth', sunElevationDeg: 0, altitudeKm: 2, azimuthDeg: 40 },
  { body: 'earth', sunElevationDeg: 0, altitudeKm: 2, viewElevationDeg: 12 },
  { body: 'mars', sunElevationDeg: 1, altitudeKm: 1.5 },
  { body: 'titan', sunElevationDeg: 3, altitudeKm: 3 },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  defaultViewport: { width: 640, height: 480 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 300)));
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

await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setDate('2026-06-21T12:00:00Z');
});

console.log('body    asked                          sun elev   off-axis   horizon   ok');
let bad = 0;

for (const c of CASES) {
  await page.evaluate((opts) => {
    const { body, ...rest } = opts;
    window.cosminova.standAt(body, rest);
  }, c);
  await settle(20);

  const got = await page.evaluate((body) => {
    const sv = window.cosminova;
    // The camera sits at the scene origin and the world is placed around it, so
    // the body's own km-scale coordinates are the ones to measure in.
    const eye = sv.controls.worldPosition;
    const centre = sv.universe.get(body).position;
    const sun = sv.universe.get('sun').position;

    const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const norm = (a) => {
      const l = Math.sqrt(dot(a, a));
      return [a[0] / l, a[1] / l, a[2] / l];
    };
    const clamp1 = (v) => Math.max(-1, Math.min(1, v));

    // Third basis column of the camera's world matrix, negated: three points
    // cameras down their own -Z.
    const e = sv.camera.matrixWorld.elements;
    const f = norm([-e[8], -e[9], -e[10]]);
    const up = norm(sub(eye, centre));
    const toSun = norm(sub(sun, eye));
    const deg = 180 / Math.PI;
    return {
      sunElev: Math.asin(clamp1(dot(up, toSun))) * deg,
      offAxis: Math.acos(clamp1(dot(f, toSun))) * deg,
      viewElev: Math.asin(clamp1(dot(up, f))) * deg,
      altitudeKm:
        Math.sqrt(dot(sub(eye, centre), sub(eye, centre))) - sv.planets.get(body).radius,
    };
  }, c.body);

  // Angle between the view axis and the sun: the view sits at its own elevation
  // and this far round in azimuth, and the sun sits at its elevation dead ahead.
  const rad = Math.PI / 180;
  const vel = (c.viewElevationDeg ?? 0) * rad;
  const az = (c.azimuthDeg ?? 0) * rad;
  const sel = c.sunElevationDeg * rad;
  const wantOff =
    Math.acos(
      Math.max(-1, Math.min(1, Math.cos(vel) * Math.cos(sel) * Math.cos(az) + Math.sin(vel) * Math.sin(sel))),
    ) / rad;
  const elevOk = Math.abs(got.sunElev - c.sunElevationDeg) < 0.6;
  const viewOk = Math.abs(got.viewElev - (c.viewElevationDeg ?? 0)) < 0.6;
  const offOk = Math.abs(got.offAxis - wantOff) < 1.5;
  const ok = elevOk && viewOk && offOk;
  if (!ok) bad++;

  const asked = `elev ${String(c.sunElevationDeg).padStart(3)} alt ${c.altitudeKm} az ${String(
    c.azimuthDeg ?? 0,
  ).padStart(3)} vel ${String(c.viewElevationDeg ?? 0).padStart(3)}`;
  console.log(
    `${c.body.padEnd(7)} ${asked.padEnd(30)} ${got.sunElev.toFixed(2).padStart(8)}   ${got.offAxis
      .toFixed(2)
      .padStart(8)}   ${got.viewElev.toFixed(2).padStart(7)}   ${ok ? 'yes' : 'NO'}`,
  );
}

console.log(bad ? `\n${bad} case(s) wrong` : '\nall cases framed as asked');
await browser.close();
process.exit(bad ? 1 : 0);
