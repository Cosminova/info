// A/B the low-altitude exoplanet view with the cloud deck and the atmosphere
// shell knocked out in turn, so whichever is washing the surface out is named
// rather than guessed at.
import puppeteer from 'puppeteer-core';

const b = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 1024, height: 640 },
});
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5182/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await p.evaluate(() => { window.cosminova.setRate(0); window.cosminova.setUiVisible(false); });
await p.evaluate(() => window.cosminova.target('star:TRAPPIST-1', 12));
await new Promise((r) => setTimeout(r, 3000));

const key = 'exo:trappist-1-d';
await p.evaluate((k) => window.cosminova.lookAtExo(k, 1.06), key);
await new Promise((r) => setTimeout(r, 4500));

const cases = [
  ['all', () => {}],
  ['nocloud', () => { window.__u.uCloudCover.value = 0; }],
  ['noair', () => { window.__air.visible = false; }],
  ['neither', () => { window.__u.uCloudCover.value = 0; window.__air.visible = false; }],
];

await p.evaluate((k) => {
  const item = window.cosminova.exoSystem.planets.find((i) => i.spec.key === k);
  window.__u = item.planet.material.uniforms;
  window.__air = item.planet.atmosphere;
  window.__hold = { cloud: window.__u.uCloudCover.value, air: !!item.planet.atmosphere?.visible };
}, key);

for (const [tag, mutate] of cases) {
  await p.evaluate(() => {
    window.__u.uCloudCover.value = window.__hold.cloud;
    if (window.__air) window.__air.visible = window.__hold.air;
  });
  await p.evaluate(mutate);
  await new Promise((r) => setTimeout(r, 1500));
  const out = `/tmp/ab-${tag}.png`;
  await p.screenshot({ path: out });
  const mean = await p.evaluate(() => {
    const c = document.querySelector('canvas');
    return { w: c.width, h: c.height };
  });
  console.log(tag, out, JSON.stringify(mean));
}
await b.close();
