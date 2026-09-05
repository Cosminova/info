/**
 * Is close-range terrain flat because the shader draws it flat, or because the
 * adaptive governor turned the detail down to hold the frame rate?
 *
 * Diagnostic only: it renders the same patch of ground at each quality preset
 * and reports the image's own contrast, so the two explanations can be told
 * apart by looking instead of argued about. Nothing here changes what the app
 * ships with.
 */
import puppeteer from 'puppeteer-core';

const b = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 900, height: 700 },
});
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5182/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await p.evaluate(() => { window.cosminova.setRate(0); window.cosminova.setUiVisible(false); });

for (const preset of ['low', 'medium', 'ultra']) {
  await p.evaluate((q) => window.cosminova.quality.setPreset(q), preset);
  await p.evaluate(() => window.cosminova.lookFromSun('mars', 1.004, 38, 4));
  await new Promise((r) => setTimeout(r, 6500));
  const state = await p.evaluate(() => ({
    detail: +window.cosminova.quality.terrainDetail.toFixed(2),
    scale: +window.cosminova.quality.renderScale.toFixed(2),
    micro: window.cosminova.quality.microDetail,
    shadows: window.cosminova.state.terrainShadows,
  }));
  const out = `/tmp/relief-mars-${preset}.png`;
  await p.screenshot({ path: out });
  console.log(preset.padEnd(7), JSON.stringify(state), out);
}
await b.close();
