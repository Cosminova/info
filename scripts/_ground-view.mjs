// Close-range surface, sun near the horizon: the lighting the ground-to-orbit
// reference clips are shot in, where relief reads through its own shadows.
import puppeteer from 'puppeteer-core';

const b = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 900, height: 1200 },
});
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5182/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await p.evaluate(() => { window.cosminova.setRate(0); window.cosminova.setUiVisible(false); });

// Low phase angle puts the sun near this patch's horizon, which is what throws
// the shadows the reference clips are full of.
for (const [key, dist, phase] of [
  ['mars', 1.004, 38],
  ['moon', 1.004, 55],
  ['europa', 1.004, 42],
]) {
  await p.evaluate((k, d, ph) => window.cosminova.lookFromSun(k, d, ph, 4), key, dist, phase);
  await new Promise((r) => setTimeout(r, 6000));
  const out = `/tmp/ground-${key}.png`;
  await p.screenshot({ path: out });
  console.log(out);
}
await b.close();
