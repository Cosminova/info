import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync('shots/diag', { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--hide-scrollbars', '--mute-audio', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 700 });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${BASE}sky.html`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
const settle = (n) => page.evaluate((k) => new Promise((r) => {
  let c = 0; const tick = () => (++c > k ? r() : requestAnimationFrame(tick)); requestAnimationFrame(tick);
}), n);
await settle(30);

// The total lunar eclipse of 3 March 2026, seen from Sydney where the Moon is
// high at greatest eclipse.
await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setLocation(-33.87, 151.21);
  window.cosminova.setUiVisible(false);
});

for (const [name, when] of [
  ['before', '2026-03-03T09:00:00Z'],
  ['partial', '2026-03-03T11:00:00Z'],
  ['total', '2026-03-03T11:34:00Z'],
]) {
  await page.evaluate((w) => {
    window.cosminova.setDate(w);
    window.cosminova.lookAtBody('moon', 1.2);
  }, when);
  await settle(90);
  const info = await page.evaluate(() => {
    const p = window.cosminova.resolved?.planets?.get('moon');
    const u = p?.material.uniforms;
    return {
      resolved: Boolean(p?.group.visible),
      occulterRadius: u?.uOcculter.value.w ?? null,
      shine: u?.uShine.value ?? null,
      sunAngular: u?.uSunAngular.value ?? null,
    };
  });
  await page.screenshot({ path: `shots/diag/eclipse-${name}.png` });
  console.log(name, JSON.stringify(info));
}
await browser.close();
