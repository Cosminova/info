/** Visual/runtime check for Gliese's layered ground materials.
 * COSMINOVA_URL=http://127.0.0.1:5179/ OUT=... node scripts/check-gliese-ground.mjs
 * Writes actual rendered views; it does not infer visual quality from build success.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const out = path.resolve(process.env.OUT ?? 'work/gliese-ground');
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 1280, height: 800 }, timeout: 120000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const shot = name => page.screenshot({ path: path.join(out, `${name}.png`) });
const timings = {};
try {
  await page.goto(process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/?home=0', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.cosminova?.ready', { timeout: 180000 });
  await page.evaluate(() => {
    const s = window.cosminova;
    s.setRate(0); s.setDate(new Date('2026-03-20T17:00:00Z'));
    s.setUiVisible(false); s.setQuality('ultra');
    for (const k of ['trajectories', 'craftVectors', 'distantMarkers', 'labelPlanets', 'labelStars', 'labelGalaxies', 'labelBlackHoles', 'labelCraft', 'labelExo']) s.setView(k, false);
    s.standAt('exo:gliese-12-b', { sunElevationDeg: 18, altitudeKm: 0.12, viewElevationDeg: -6, fov: 65 });
  });
  await wait(7000);
  await page.evaluate(() => { const c = window.cosminova.controls; c.startWalk(); c.walkPitch = -0.22; });
  await wait(6000);
  const materials = await page.evaluate(() => {
    const p = window.cosminova.exoSystem.get('exo:gliese-12-b').planet;
    const u = p.material.uniforms;
    return { relief: u.uGroundRelief.value, toneWidth: u.uGroundTone.value.image.width,
      normalWidth: u.uGroundNormal.value.image.width, ground: window.cosminova.controls.walkGroundKm };
  });
  assert.equal(materials.relief, 1);
  assert.ok(materials.toneWidth >= 1024 && materials.normalWidth >= 1024, 'Photo materials must finish loading');
  assert.ok(Number.isFinite(materials.ground));
  await shot('gliese-ground');
  await page.evaluate(() => { const c = window.cosminova.controls; c.walkEyeKm = 0.12; c.walkPitch = -0.18; });
  await wait(2000); await shot('gliese-landscape');
  await page.evaluate(() => { const c = window.cosminova.controls; c.walkEyeKm = 0.0017; c.walkPitch = -0.6; });
  await wait(2000); await shot('gliese-closeup');
  const before = await page.evaluate(() => window.cosminova.controls.walkLocal.toArray());
  await page.evaluate(() => window.cosminova.controls.setInput('KeyW', true));
  await wait(1500);
  await page.evaluate(() => window.cosminova.controls.setInput('KeyW', false));
  const after = await page.evaluate(() => ({ p: window.cosminova.controls.walkLocal.toArray(), mode: window.cosminova.controls.mode, ground: window.cosminova.controls.walkGroundKm }));
  assert.equal(after.mode, 'walk'); assert.ok(Number.isFinite(after.ground));
  assert.ok(after.p.some((v, i) => Math.abs(v - before[i]) > 1e-9), 'Walking must move the camera');
  for (const quality of ['ultra', 'high', 'medium']) {
    await page.evaluate(q => window.cosminova.setQuality(q), quality); await wait(1500);
    timings[quality] = await page.evaluate(() => new Promise(resolve => {
      const samples = []; let last = performance.now();
      function frame(now) { samples.push(now - last); last = now;
        if (samples.length < 30) requestAnimationFrame(frame);
        else resolve(+samples.sort((a, b) => a - b)[15].toFixed(1));
      } requestAnimationFrame(frame);
    }));
    await shot(`gliese-${quality}`);
  }
  await page.evaluate(() => { const s = window.cosminova; s.setQuality('high'); s.controls.stopWalk(); s.standAt('moon', { sunElevationDeg: 20, altitudeKm: 0.1, viewElevationDeg: -5 }); });
  await wait(3000);
  await page.evaluate(() => { window.cosminova.controls.startWalk(); window.cosminova.controls.walkPitch = -0.25; });
  await wait(3000); await shot('moon-regression');
  assert.deepEqual(errors, [], 'Browser and GLSL compilation must be error-free');
  const result = { materials, movement: after, medianFrameMs: timings, errors };
  fs.writeFileSync(path.join(out, 'validation.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
