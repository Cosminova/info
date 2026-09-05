/**
 * Why does Betelgeuse render cream instead of orange?
 *
 * The photosphere shader multiplies its colour uniform and adds nothing white,
 * so if the disc comes out desaturated the loss is downstream. This reports,
 * for each star, the colour the uniform was given and the colour actually on
 * screen at the centre of the disc, with bloom on and off — bloom is additive
 * and a disc that fills the frame blooms onto itself, which is the one effect
 * that would wash a big star and spare a small one.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots/star-colour');
const W = 600;
const H = 600;
fs.mkdirSync(OUT, { recursive: true });

const STARS = [
  ['sun', 8],
  ['star:Betelgeuse', 8],
  ['star:Antares', 8],
  ['star:Rigel', 8],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  ! page', e.message));

const settle = (n) =>
  page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        let c = 0;
        const tick = () => (++c >= frames ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });
await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setUiVisible(false);
});
await settle(10);

/** sRGB encode a linear value, for comparing a uniform against a screenshot. */
const encode = (v) =>
  Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));

/** Mean colour of a small patch at the centre of the frame. */
function centre(raw) {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = H / 2 - 20; y < H / 2 + 20; y++) {
    for (let x = W / 2 - 20; x < W / 2 + 20; x++) {
      const i = (y * W + x) * 3;
      sum[0] += raw[i];
      sum[1] += raw[i + 1];
      sum[2] += raw[i + 2];
      n++;
    }
  }
  return sum.map((v) => Math.round(v / n));
}

/** How far a colour is from grey: 0 is white, 1 is fully saturated. */
const sat = ([r, g, b]) => {
  const max = Math.max(r, g, b);
  return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
};

console.log(
  'star            uniform (linear)      wanted      bloom on      bloom off     sat on/off',
);
console.log('-'.repeat(96));

for (const [key, radii] of STARS) {
  const info = await page.evaluate(
    ({ k, d }) => {
      const sv = window.cosminova;
      sv.target(k, d);
      sv.controls.stopFlight();
      sv.controls.distanceRadii = d;
      sv.controls.fov = 34;
      const p = sv.starProfileFor?.(k) ?? null;
      return { profile: p };
    },
    { k: key, d: radii },
  );
  await settle(40);

  const shots = {};
  for (const bloom of [true, false]) {
    await page.evaluate((on) => window.cosminova.setView('bloom', on), bloom);
    await settle(12);
    const file = path.join(OUT, `${key.replace(/[^a-z0-9]/gi, '-')}-${bloom ? 'on' : 'off'}.png`);
    await page.screenshot({ path: file });
    shots[bloom ? 'on' : 'off'] = centre(await sharp(file).removeAlpha().raw().toBuffer());
  }

  const prof = info.profile;
  const uniform = prof ? prof.colour.map((v) => v.toFixed(3)).join(',') : 'n/a';
  const wanted = prof ? prof.colour.map(encode).join(',') : 'n/a';
  console.log(
    `${key.padEnd(16)}${uniform.padEnd(22)}${wanted.padEnd(12)}` +
      `${shots.on.join(',').padEnd(14)}${shots.off.join(',').padEnd(14)}` +
      `${sat(shots.on).toFixed(2)} / ${sat(shots.off).toFixed(2)}`,
  );
}

console.log(`\nshots in ${OUT}`);
await browser.close();
