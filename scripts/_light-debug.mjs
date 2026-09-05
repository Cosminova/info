/**
 * What the lighting check actually sees.
 *
 * The night-side assertions started reporting a day side and a night side that
 * were both a flat mid grey, identical to five decimal places across seven
 * bodies. A number that does not vary with the body cannot be coming from the
 * body, so this saves the two frames the check samples and reports the same
 * statistics it does, to find out what is in front of the camera.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const BASE = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = 'shots/light-debug';

await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--hide-scrollbars', '--mute-audio', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

const settle = (frames = 45) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let c = 0;
        const tick = () => (++c > n ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames,
  );

await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
await settle(20);
await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setDate('2026-03-21T12:00:00Z');
});
await settle(60);
await page.evaluate(() => {
  window.cosminova.setBloom(false);
  window.cosminova.setUiVisible(false);
});
await settle();

/** The state the check never inspects: where the camera ended up, and in what mode. */
const cameraState = () =>
  page.evaluate(() => {
    const c = window.cosminova.controls;
    const cam = window.cosminova.camera;
    return {
      mode: c?.mode ?? '(none)',
      roaming: c?.roaming ?? null,
      targetKey: c?.targetKey,
      distanceRadii: c?.distanceRadii,
      cameraPos: cam.position.toArray().map((v) => Number(v.toFixed(2))),
      distanceToTargetKm: (() => {
        try {
          const p = window.cosminova.planets.get(c.targetKey);
          return Number(cam.position.distanceTo(p.group.position).toFixed(2));
        } catch {
          return null;
        }
      })(),
      radiusKm: (() => {
        try {
          return window.cosminova.planets.get(c.targetKey).radiusKm;
        } catch {
          return null;
        }
      })(),
    };
  });

const CLOSE = 1.6;
for (const key of ['earth', 'moon']) {
  for (const [label, phase] of [['day', 12], ['night', 172]]) {
    await page.evaluate((k, d, p) => window.cosminova.lookFromSun(k, d, p, 0), key, CLOSE, phase);
    if (label === 'night') await page.evaluate((k) => window.cosminova.setUniform(k, 'uShine', 0), key);
    await settle();
    const shot = await page.screenshot({ type: 'png' });
    await writeFile(`${OUT}/${key}-${label}.png`, shot);
    console.log(`${key} ${label}`, JSON.stringify(await cameraState()));
  }
}

console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
