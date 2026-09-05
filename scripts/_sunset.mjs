/**
 * Sunset probe: a low camera at the terminator, sweeping the sun's height
 * against one sky parameter, laid out as a contact sheet.
 *
 * Phase is the angle between the camera and the sun as seen from the body, so
 * ninety degrees puts the camera over the terminator and the sun on its
 * horizon: sunrise or sunset, depending on which way the world turns.
 *
 * Usage:
 *   node scripts/_sunset.mjs [body] [--exo] [--phases 60,84,88,94]
 *                            [--sweep brightness|hdiv|mie|pitch] [--values 12,26,48]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BODY = args[0] && !args[0].startsWith('--') ? args[0] : 'earth';
const PHASES = option('phases', '55,80,88,94').split(',').map(Number);
const SWEEP = option('sweep', 'brightness');
const VALUES = option('values', '14,26,48').split(',').map(Number);
const PITCH = Number(option('pitch', 1.45));
const ALTITUDE = Number(option('altitude', 0.0006));
const FOV = Number(option('fov', 70));
const EXO = args.includes('--exo');
const TAG = option('tag', `${BODY.replace(/[^a-z0-9]+/gi, '')}-${SWEEP}`);

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5182/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots/sunset');
fs.mkdirSync(OUT, { recursive: true });

const W = 480;
const H = 854;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new', '--hide-scrollbars', '--mute-audio', '--no-sandbox',
    '--enable-unsafe-swiftshader', '--use-gl=angle', `--window-size=${W},${H}`,
  ],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 200));
});

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

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });
await settle(10);

// A clean frame. The trajectory lines are the loud ones: from a surface, a few
// dozen interplanetary tracks read as a wireframe cage over the whole sky.
await page.evaluate(() => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.setDate('2026-06-21T12:00:00Z');
  sv.setUiVisible(false);
  sv.setQuality('ultra');
  for (const key of ['craft', 'trajectories', 'craftVectors', 'distantMarkers']) sv.setView(key, false);
  for (const key of ['labelPlanets', 'labelStars', 'labelGalaxies', 'labelBlackHoles', 'labelCraft', 'labelExo']) {
    sv.setView(key, false);
  }
});

if (EXO) {
  await page.evaluate((key) => window.cosminova.target(key, 4), BODY);
  await settle(90);
}

const bodyKey = BODY.replace(/^exo:/, '');
const made = [];
for (const phase of PHASES) {
  for (const value of VALUES) {
    const info = await page.evaluate(
      ({ body, ph, pitch, alt, fov, exo, sweep, val }) => {
        const sv = window.cosminova;
        const framed = exo ? sv.lookAtExo(body, 1 + alt, ph, 0) : sv.lookFromSun(body, 1 + alt, ph, 0);
        if (!framed) return { framed: false };
        const c = sv.controls;
        c.autoCenter = false;
        c.lookYaw = 0;
        c.lookPitch = sweep === 'pitch' ? val : pitch;
        c.fov = fov;

        // The planet object, whichever list it is in.
        const planet = sv.planets.get(body.replace(/^exo:/, ''))
          ?? sv.exoSystem?.planets.find((p) => p.spec.key === body)?.planet;
        if (!planet?.skyUniforms) return { framed: true, sky: false };
        const u = planet.skyUniforms;
        if (sweep === 'brightness') planet.skyInscatterMaterial.uniforms.uBrightness.value = val;
        if (sweep === 'mie') u.uMie.value = planet._baseMie ?? (planet._baseMie = u.uMie.value), u.uMie.value = planet._baseMie * val;
        if (sweep === 'hdiv') {
          const thickness = u.uShellRadius.value - u.uRadius.value;
          u.uScaleHeight.value = thickness / val;
          u.uMieHeight.value = thickness / val / 4;
        }
        return {
          framed: true,
          sky: planet.sky.visible,
          scaleHeight: u.uScaleHeight.value,
          brightness: planet.skyInscatterMaterial.uniforms.uBrightness.value,
          sunIntensity: planet.skyInscatterMaterial.uniforms.uSunIntensity.value,
        };
      },
      { body: BODY, ph: phase, pitch: PITCH, alt: ALTITUDE, fov: FOV, exo: EXO, sweep: SWEEP, val: value },
    );
    if (!info.framed) {
      console.log(`phase ${phase} ${SWEEP} ${value}: framing failed`);
      continue;
    }
    await page.evaluate((key) => window.cosminova.loadDetail(key), bodyKey);
    await settle(90);

    const name = `${TAG}-p${phase}-v${String(value).replace('.', '')}`;
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });

    const { data, info: meta } = await sharp(file).resize(120, 214, { fit: 'fill' }).raw()
      .toBuffer({ resolveWithObject: true });
    let sum = 0;
    let top = 0;
    const count = meta.width * meta.height;
    const rgbTop = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      const o = i * meta.channels;
      sum += 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
      if (i < count / 4) {
        top += 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
        rgbTop[0] += data[o];
        rgbTop[1] += data[o + 1];
        rgbTop[2] += data[o + 2];
      }
    }
    const q = count / 4;
    made.push({ name, file });
    console.log(
      `p${String(phase).padEnd(4)} ${SWEEP}=${String(value).padEnd(5)}` +
        ` mean=${(sum / count).toFixed(1).padEnd(6)} sky=${(top / q).toFixed(1).padEnd(6)}` +
        ` skyRGB=${rgbTop.map((v) => (v / q).toFixed(0).padStart(3)).join(',')}` +
        ` H=${info.scaleHeight?.toFixed(1) ?? '-'}km on=${info.sky}`,
    );
  }
}

if (made.length) {
  const cols = VALUES.length;
  const rows = Math.ceil(made.length / cols);
  const tw = 230;
  const th = Math.round((tw * H) / W);
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
  }).composite(tiles).png().toFile(sheet);
  console.log(`\nsheet: ${sheet}`);
  console.log(`columns = ${SWEEP} ${VALUES.join(', ')};  rows = phase ${PHASES.join(', ')}`);
}

await browser.close();
