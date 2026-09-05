/**
 * Scenic probe: candidate frames for the alien-skies video.
 *
 * Renders each candidate at video aspect, reports exposure, and lays the set
 * out as a contact sheet. Picking shots by eye is the point — the numbers only
 * say whether a frame is black or blown, not whether it is worth watching.
 *
 * Usage: node scripts/_scenic.mjs [scene ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5182/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots/scenic');
fs.mkdirSync(OUT, { recursive: true });

const W = 540;
const H = 960;

/**
 * Each scene returns whatever it wants reported alongside the frame. Anything
 * that has to load — an exoplanet system, a body's terrain — is asked for here
 * and waited on outside.
 */
const SCENES = {
  // Reference: does the atmosphere shell render from inside it? Everything
  // about an alien sunset depends on the answer.
  earthSunset: (api) => {
    api.setDate('2026-06-21T12:00:00Z');
    api.target('sun', 12);
    api.viewFromEarth(true);
    api.controls.fov = 62;
    return { note: 'ground, sun 8.6 deg up' };
  },
  earthSunsetTight: (api) => {
    api.setDate('2026-06-21T12:00:00Z');
    api.target('sun', 12);
    api.viewFromEarth(true);
    api.controls.fov = 24;
    return { note: 'ground, sun tight' };
  },
  earthLimbTwilight: (api) => {
    api.setDate('2026-06-21T12:00:00Z');
    api.lookFromSun('earth', 1.02, 96, 4);
    api.controls.autoCenter = false;
    api.controls.lookPitch = 1.35;
    return { note: 'low orbit, terminator limb' };
  },

  // Betelgeuse. The catalogue carries luminosity and spectral type, so whatever
  // radius the app gives it is worth reading back before framing anything.
  betelgeuseFar: (api) => {
    const r = api.resolveWorld('star:Betelgeuse');
    api.target('star:Betelgeuse', 6, { yaw: 0.4, pitch: 0.1 });
    api.controls.fov = 58;
    return { radiusKm: r?.radius, kind: r?.kind };
  },
  betelgeuseNear: (api) => {
    api.target('star:Betelgeuse', 1.9, { yaw: 0.4, pitch: 0.08 });
    api.controls.fov = 58;
    return {};
  },
  betelgeuseFill: (api) => {
    api.target('star:Betelgeuse', 1.35, { yaw: 0.4, pitch: 0.05 });
    api.controls.fov = 62;
    return {};
  },
  sunForScale: (api) => {
    api.target('sun', 6, { yaw: 0.4, pitch: 0.1 });
    api.controls.fov = 58;
    return {};
  },

  // Black holes, at the distances where the lensed arc reads.
  sgrAWide: (api) => {
    const r = api.lookAtBlackHole('bh:sgr-a', 60);
    api.controls.fov = 58;
    return r;
  },
  sgrAClose: (api) => {
    const r = api.lookAtBlackHole('bh:sgr-a', 22);
    api.controls.fov = 58;
    return r;
  },
  sgrAVeryClose: (api) => {
    const r = api.lookAtBlackHole('bh:sgr-a', 11);
    api.controls.fov = 70;
    return r;
  },
  cygnusX1: (api) => {
    const r = api.lookAtBlackHole('bh:cygnus-x1', 26);
    api.controls.fov = 58;
    return r;
  },
  m87: (api) => {
    const r = api.lookAtBlackHole('bh:m87-star', 30);
    api.controls.fov = 58;
    return r;
  },

  // Alien skies. Station mode only stands on Earth, so these approximate a
  // surface view: a few kilometres up at the terminator, pitched to the horizon.
  cnc55e: (api) => {
    const r = api.lookAtExo('exo:55-cnc-e', 1.0006, 90, 0);
    api.controls.autoCenter = false;
    api.controls.lookPitch = 1.42;
    api.controls.fov = 70;
    return { ...r, planet: '55 Cnc e' };
  },
  cnc55eYawA: (api) => {
    api.lookAtExo('exo:55-cnc-e', 1.0006, 90, 0);
    api.controls.autoCenter = false;
    api.controls.lookPitch = 1.42;
    api.controls.lookYaw = 1.5708;
    api.controls.fov = 70;
    return {};
  },
  cnc55eYawB: (api) => {
    api.lookAtExo('exo:55-cnc-e', 1.0006, 90, 0);
    api.controls.autoCenter = false;
    api.controls.lookPitch = 1.42;
    api.controls.lookYaw = -1.5708;
    api.controls.fov = 70;
    return {};
  },
  cnc55eOrbit: (api) => {
    const r = api.lookAtExo('exo:55-cnc-e', 2.2, 105, 10);
    api.controls.fov = 58;
    return r;
  },
  trappist1e: (api) => {
    const r = api.lookAtExo('exo:trappist-1-e', 1.0006, 90, 0);
    api.controls.autoCenter = false;
    api.controls.lookPitch = 1.42;
    api.controls.fov = 70;
    return { ...r, planet: 'TRAPPIST-1 e' };
  },
  trappist1eOrbit: (api) => {
    const r = api.lookAtExo('exo:trappist-1-e', 2.4, 100, 12);
    api.controls.fov = 58;
    return r;
  },
  trappist1bOrbit: (api) => {
    const r = api.lookAtExo('exo:trappist-1-b', 2.4, 100, 12);
    api.controls.fov = 58;
    return r;
  },
  proximaB: (api) => {
    const r = api.lookAtExo('exo:proxima-cen-b', 2.4, 100, 12);
    api.controls.fov = 58;
    return r;
  },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENES);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    `--window-size=${W},${H}`,
  ],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});

const page = await browser.newPage();
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));

const settle = (frames) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let count = 0;
        const tick = () => (++count > n ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames,
  );

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });
await settle(10);
// Chrome will not start audio without a gesture and the panels are in the way
// of every frame.
await page.evaluate(() => {
  window.cosminova.setRate(0);
  document.body.classList.add('cinema');
  for (const el of document.querySelectorAll('.panel, #hud, .toolbar, #legend, footer'))
    el.style.display = 'none';
});

const made = [];
for (const name of names) {
  const scene = SCENES[name];
  if (!scene) {
    console.error(`unknown scene: ${name}`);
    continue;
  }
  let info = null;
  try {
    info = await page.evaluate(`(${scene.toString()})(window.cosminova)`);
  } catch (error) {
    console.log(`${name.padEnd(16)} APPLY FAILED ${error.message.slice(0, 120)}`);
    continue;
  }
  // Systems and terrain both stream; 90 frames is past the exoplanet load and
  // the LOD ramp.
  await settle(90);

  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  const stats = await page.evaluate(() => window.cosminova.stats());

  const { data, info: meta } = await sharp(file)
    .resize(180, 320, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  let max = 0;
  let lit = 0;
  let blown = 0;
  const count = meta.width * meta.height;
  for (let i = 0; i < count; i++) {
    const o = i * meta.channels;
    const luma = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    sum += luma;
    if (luma > max) max = luma;
    if (luma > 4) lit++;
    if (luma > 250) blown++;
  }
  made.push({ name, file });
  console.log(
    `${name.padEnd(16)} mean=${(sum / count).toFixed(1).padEnd(6)} max=${String(max).padEnd(4)}` +
      ` lit=${((lit / count) * 100).toFixed(0).padEnd(3)}% blown=${((blown / count) * 100).toFixed(0).padEnd(3)}%` +
      ` alt=${stats.altitudeKm < 1e4 ? `${stats.altitudeKm.toFixed(1)}km` : `${(stats.altitudeKm / 1.496e8).toFixed(2)}AU`}`.padEnd(
        16,
      ) +
      ` fov=${stats.fov?.toFixed?.(2) ?? '-'}` +
      (info ? ` ${JSON.stringify(info).slice(0, 90)}` : ''),
  );
}

// Contact sheet, six across, so the whole set can be judged in one look.
if (made.length) {
  const cols = Math.min(6, made.length);
  const rows = Math.ceil(made.length / cols);
  const tw = 240;
  const th = Math.round((tw * H) / W);
  const tiles = await Promise.all(
    made.map(async (m, i) => ({
      input: await sharp(m.file).resize(tw, th, { fit: 'fill' }).png().toBuffer(),
      left: (i % cols) * tw,
      top: Math.floor(i / cols) * th,
    })),
  );
  const sheet = path.join(OUT, 'sheet.png');
  await sharp({
    create: {
      width: cols * tw,
      height: rows * th,
      channels: 3,
      background: { r: 12, g: 12, b: 16 },
    },
  })
    .composite(tiles)
    .png()
    .toFile(sheet);
  console.log(`\nsheet: ${sheet}`);
  console.log(made.map((m, i) => `${i + 1}. ${m.name}`).join('  '));
}

await browser.close();
if (problems.length) {
  console.error('\nPROBLEMS');
  for (const p of [...new Set(problems)].slice(0, 12)) console.error(`  ${p}`);
}
