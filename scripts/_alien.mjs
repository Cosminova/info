/**
 * Sunset candidates, on this world and others.
 *
 * One frame per line of the shot list, at the sun elevation asked for, plus a
 * contact sheet to choose from. The point is to see the sky each star actually
 * makes: the same air lit by a 2500 K red dwarf and by the sun are not the same
 * colour, and no amount of guessing at parameters substitutes for looking.
 *
 * Usage: node scripts/_alien.mjs [--tag name] [--width 480]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const TAG = flag('tag', 'alien');
const WIDTH = Number(flag('width', 480));
const HEIGHT = Math.round((WIDTH * 16) / 9);

const OUT = path.join(process.cwd(), 'shots', 'alien');
fs.mkdirSync(OUT, { recursive: true });

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5182/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** fov is wide for a landscape; viewElevation lifts the horizon down the frame. */
const SHOTS = [
  { name: 'earth-golden', body: 'earth', sunElevationDeg: 7, altitudeKm: 2.5, viewElevationDeg: 9, fov: 62 },
  { name: 'earth-set', body: 'earth', sunElevationDeg: 0.5, altitudeKm: 2.5, viewElevationDeg: 8, fov: 62 },
  { name: 'earth-dusk', body: 'earth', sunElevationDeg: -4, altitudeKm: 2.5, viewElevationDeg: 8, fov: 62 },
  { name: 'earth-side', body: 'earth', sunElevationDeg: 1, altitudeKm: 2.5, azimuthDeg: 55, viewElevationDeg: 8, fov: 62 },
  { name: 'mars-set', body: 'mars', sunElevationDeg: 1, altitudeKm: 4, viewElevationDeg: 8, fov: 62 },
  { name: 'mars-dusk', body: 'mars', sunElevationDeg: -3, altitudeKm: 4, viewElevationDeg: 8, fov: 62 },
  // Above the relief, not just above the reference sphere. These worlds carry
  // kilometres of procedural terrain and a camera under it sees the inside of
  // the ground, which reads as a lattice of patch walls across the sky.
  { name: 'titan-set', body: 'titan', sunElevationDeg: 2, altitudeKm: 12, viewElevationDeg: 8, fov: 62 },
  { name: 'venus-set', body: 'venus', sunElevationDeg: 2, altitudeKm: 8, viewElevationDeg: 8, fov: 62 },
  {
    name: 'trappist-set',
    body: 'exo:trappist-1-e',
    sunElevationDeg: 0.5,
    altitudeKm: 10,
    viewElevationDeg: 10,
    fov: 62,
  },
  {
    name: 'trappist-high',
    body: 'exo:trappist-1-e',
    sunElevationDeg: 14,
    altitudeKm: 10,
    viewElevationDeg: 12,
    fov: 62,
  },
  {
    name: 'proxima-set',
    body: 'exo:proxima-cen-b',
    sunElevationDeg: 0.5,
    altitudeKm: 10,
    viewElevationDeg: 10,
    fov: 62,
  },
  {
    name: 'taucet-set',
    body: 'exo:tau-cet-f',
    sunElevationDeg: 1,
    altitudeKm: 10,
    viewElevationDeg: 9,
    fov: 62,
  },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
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

// Overlays off: trajectory ribbons and markers cut across a landscape, and the
// interface is not part of the picture.
await page.evaluate(() => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.setDate('2026-06-21T12:00:00Z');
  for (const key of ['craft', 'trajectories', 'craftVectors', 'distantMarkers']) sv.setView(key, false);
  for (const key of ['labelPlanets', 'labelStars', 'labelGalaxies', 'labelBlackHoles', 'labelCraft', 'labelExo'])
    sv.setView(key, false);
  sv.hideInterface?.(true);
  document.getElementById('ui-root')?.style.setProperty('display', 'none');
  document.getElementById('label-layer')?.style.setProperty('display', 'none');
});

const made = [];
for (const shot of SHOTS) {
  const { name, body, ...opts } = shot;

  // An exoplanet's system has to be resident before there is anything to stand
  // on, and that is a fetch plus a build.
  if (body.startsWith('exo:')) {
    await page.evaluate((key) => window.cosminova.target(key), body);
    await page.waitForFunction(
      (key) => Boolean(window.cosminova.exoSystemHas?.(key) ?? window.cosminova.standAt(key, {})),
      { timeout: 60000 },
      body,
    ).catch(() => {});
    await settle(30);
  }

  const placed = await page.evaluate(
    ({ key, options }) => {
      const sv = window.cosminova;
      const r = sv.standAt(key, options);
      return r;
    },
    { key: body, options: opts },
  );

  if (!placed) {
    console.log(`${name.padEnd(16)} SKIPPED (could not stand on ${body})`);
    continue;
  }

  await page.evaluate((key) => window.cosminova.loadDetail(key.replace(/^exo:/, '')), body);
  // Terrain has to reach its final subdivision before the shot. Half-built, the
  // skirts that hide the cracks between levels are kilometres tall, and from a
  // low camera they stand up across the ground as a lattice of walls.
  await settle(Number(flag('settle', 110)));
  // The frame loop owns sky visibility and the look offsets ease, so the
  // framing is reasserted after everything has settled.
  await page.evaluate(
    ({ key, options }) => window.cosminova.standAt(key, options),
    { key: body, options: opts },
  );
  await settle(4);

  const file = path.join(OUT, `${TAG}-${name}.png`);
  await page.screenshot({ path: file });
  made.push({ name, file });

  // Read the colour back off the written frame: the drawing buffer has already
  // been presented by the time a query would run, and comes back empty.
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const band = (fromTop, toTop) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    const y0 = Math.round(info.height * fromTop);
    const y1 = Math.round(info.height * toTop);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < info.width; x += 3) {
        const i = (y * info.width + x) * info.channels;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
    }
    return n ? [r / n, g / n, b / n].map(Math.round) : [0, 0, 0];
  };
  const high = band(0.08, 0.28);
  const low = band(0.42, 0.55);

  console.log(
    `${name.padEnd(16)} sky ${String(high).padEnd(14)} horizon ${String(low).padEnd(14)} ground ${(placed.groundKm ?? 0)
      .toFixed(2)
      .padStart(7)}km  star ${placed.star}`,
  );
}

await browser.close();

if (made.length) {
  const cols = Math.min(made.length, 6);
  const rows = Math.ceil(made.length / cols);
  const tw = 220;
  const th = Math.round((tw * HEIGHT) / WIDTH);
  const tiles = await Promise.all(
    made.map(async (m, i) => ({
      input: await sharp(m.file).resize(tw, th, { fit: 'fill' }).png().toBuffer(),
      left: (i % cols) * tw,
      top: Math.floor(i / cols) * th,
    })),
  );
  const sheet = path.join(OUT, `sheet-${TAG}.png`);
  await sharp({
    create: { width: cols * tw, height: rows * th, channels: 3, background: { r: 10, g: 10, b: 14 } },
  })
    .composite(tiles)
    .png()
    .toFile(sheet);
  console.log(`\nsheet: ${sheet}`);
  console.log(made.map((m, i) => `${i + 1}. ${m.name}`).join('   '));
}
