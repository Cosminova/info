/**
 * Is Ceres's over-oblate silhouette the sky shells, or its terrain?
 *
 * The shape check measures the rendered outline against the axes the body was
 * built from, and Ceres comes out rounder on one axis than its axes allow. Two
 * things could widen a silhouette: a sky shell drawn around the body with depth
 * testing off, which is new here, or terrain relief standing off the reference
 * ellipsoid, which is not. So the outline is measured twice, once with every
 * sky-like mesh forced off, and the two are compared. Identical means the sky
 * is not involved and the relief is.
 */
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots/ceres');
const S = 900;
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: S, height: S, deviceScaleFactor: 1 },
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
  // A star field behind the body would be counted as part of it.
  for (const v of ['stars', 'galaxies', 'milkyWay', 'labelPlanets', 'distantMarkers']) {
    window.cosminova.setView(v, false);
  }
});
await settle(10);

await page.evaluate(() => {
  const sv = window.cosminova;
  sv.target('ceres', 2.2);
  sv.controls.stopFlight();
  sv.controls.distanceRadii = 2.2;
});
await page.evaluate(() => window.cosminova.loadDetail('ceres'));
await settle(80);

/** Sky-like meshes, and whether anything above them in the tree is hidden. */
const skyCount = await page.evaluate(() => {
  let n = 0;
  window.cosminova.scene.traverse((o) => {
    const u = o.material?.uniforms;
    if (!u) return;
    if ('uRayleigh' in u || 'uSkyBrightness' in u || 'uInscatter' in u) {
      let effective = o.visible;
      for (let p = o.parent; p && effective; p = p.parent) effective = p.visible;
      if (effective) n++;
    }
  });
  return n;
});
console.log(`sky-like meshes actually reaching the screen: ${skyCount}`);

/** Width and height of everything brighter than the background. */
function outline(raw) {
  let minX = S;
  let maxX = -1;
  let minY = S;
  let maxY = -1;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 3;
      if (raw[i] + raw[i + 1] + raw[i + 2] < 24) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  return { w, h, ratio: Math.max(w, h) / Math.min(w, h) };
}

async function measure(label, hideSky) {
  await page.evaluate((hide) => {
    window.cosminova.scene.traverse((o) => {
      const u = o.material?.uniforms;
      if (!u) return;
      if ('uRayleigh' in u || 'uSkyBrightness' in u || 'uInscatter' in u) {
        if (hide) {
          o.userData.__wasVisible = o.visible;
          o.visible = false;
        } else if ('__wasVisible' in o.userData) {
          o.visible = o.userData.__wasVisible;
        }
      }
    });
  }, hideSky);
  await settle(20);

  const file = path.join(OUT, `${label}.png`);
  await page.screenshot({ path: file });
  const o = outline(await sharp(file).removeAlpha().raw().toBuffer());
  console.log(`${label.padEnd(12)} ${o.w}x${o.h} px   outline ratio ${o.ratio.toFixed(4)}`);
  return o.ratio;
}

const withSky = await measure('with-sky', false);
const noSky = await measure('no-sky', true);

console.log(
  `\n${Math.abs(withSky - noSky) < 0.002
    ? 'identical with the sky off: the outline is terrain relief, not the sky shells'
    : 'the sky shells change the outline — this one is mine to fix'}`,
);
console.log(`shape check expects 1.0788, ceiling 1.0812; it measured 1.1365`);
console.log(`shots in ${OUT}`);

await browser.close();
