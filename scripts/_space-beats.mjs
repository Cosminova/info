/**
 * Candidates for the parts of the shot that are not a sunset: the supergiant,
 * and the holes.
 *
 * Usage: node scripts/_space-beats.mjs [--tag name]
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
const TAG = flag('tag', 'space');
const WIDTH = Number(flag('width', 480));
const HEIGHT = Math.round((WIDTH * 16) / 9);

const OUT = path.join(process.cwd(), 'shots', 'space');
fs.mkdirSync(OUT, { recursive: true });

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5182/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Radii are the wrong unit for a scale comparison: every star looks the same
// size eight radii out. Held at one absolute distance instead, the difference
// between the sun and a red supergiant is the whole point of the frame.
const AU = 149597870.7;
const SOLAR_RADIUS_KM = 695700;
const atDistance = (au, radiusSol) => (au * AU) / (radiusSol * SOLAR_RADIUS_KM);

const SHOTS = [
  { name: 'sun-8au', kind: 'star', key: 'sun', distanceRadii: atDistance(8, 1), fov: 34 },
  { name: 'betelgeuse-8au', kind: 'star', key: 'star:Betelgeuse', distanceRadii: atDistance(8, 712), fov: 34 },
  { name: 'sun-near', kind: 'star', key: 'sun', distanceRadii: 8, fov: 34 },
  { name: 'betelgeuse-8', kind: 'star', key: 'star:Betelgeuse', distanceRadii: 8, fov: 34 },
  { name: 'betelgeuse-4', kind: 'star', key: 'star:Betelgeuse', distanceRadii: 4, fov: 60 },
  { name: 'antares', kind: 'star', key: 'star:Antares', distanceRadii: 8, fov: 34 },
  { name: 'sgr-far', kind: 'hole', key: 'sgr-a', distanceRadii: 260, fov: 34 },
  { name: 'sgr-mid', kind: 'hole', key: 'sgr-a', distanceRadii: 90, fov: 40 },
  { name: 'sgr-near', kind: 'hole', key: 'sgr-a', distanceRadii: 26, fov: 52 },
  { name: 'cygnus', kind: 'hole', key: 'cygnus-x1', distanceRadii: 70, fov: 40 },
  { name: 'm87-mid', kind: 'hole', key: 'm87-star', distanceRadii: 90, fov: 40 },
  { name: 'm87-near', kind: 'hole', key: 'm87-star', distanceRadii: 30, fov: 52 },
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

await page.evaluate(() => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.setDate('2026-06-21T12:00:00Z');
  for (const key of ['craft', 'trajectories', 'craftVectors', 'distantMarkers']) sv.setView(key, false);
  for (const key of ['labelPlanets', 'labelStars', 'labelGalaxies', 'labelBlackHoles', 'labelCraft', 'labelExo'])
    sv.setView(key, false);
  sv.setUiVisible?.(false);
});

const made = [];
for (const shot of SHOTS) {
  const info = await page.evaluate(
    ({ kind, key, distanceRadii, fov }) => {
      const sv = window.cosminova;
      let r = null;
      if (kind === 'hole') r = sv.lookAtBlackHole(key, distanceRadii);
      else {
        sv.target(key, distanceRadii);
        sv.controls.stopFlight();
        sv.controls.distanceRadii = distanceRadii;
        r = { radiusKm: sv.stats?.().targetRadiusKm ?? null };
      }
      sv.controls.fov = fov;
      sv.controls.lookYaw = 0;
      sv.controls.lookPitch = 0;
      return r && { ...r, radiusKm: r.radiusKm ?? null };
    },
    shot,
  );

  await settle(70);
  const file = path.join(OUT, `${TAG}-${shot.name}.png`);
  await page.screenshot({ path: file });
  made.push({ name: shot.name, file });

  const { data, info: meta } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let lit = 0;
  for (let i = 0; i < data.length; i += meta.channels * 7) {
    const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
    sum += v;
    if (v > 40) lit++;
  }
  const n = Math.ceil(data.length / (meta.channels * 7));
  console.log(
    `${shot.name.padEnd(15)} mean ${(sum / n).toFixed(1).padStart(6)}  lit ${((lit / n) * 100)
      .toFixed(1)
      .padStart(5)}%  radius ${info?.radiusKm ? Math.round(info.radiusKm) : info?.rsKm ? `rs ${Math.round(info.rsKm)}` : '-'}`,
  );
}

await browser.close();

const cols = 6;
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
