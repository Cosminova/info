/**
 * Confirms the dither pass is live: with time paused the scene is static, so
 * two consecutive frames would be byte-identical without it, and differ by
 * about one 8-bit level with it.
 *
 * Usage: node scripts/dither-check.mjs [url]
 */
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.argv[2] ?? process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5178/sky.html';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  defaultViewport: { width: 900, height: 600 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });

await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setDate('2026-08-27T19:55:00');
});
await new Promise((r) => setTimeout(r, 1500));

const frames = [];
for (let i = 0; i < 2; i++) {
  frames.push(await page.screenshot({ encoding: 'binary' }));
  await new Promise((r) => setTimeout(r, 220));
}
await browser.close();

const region = { left: 260, top: 110, width: 240, height: 90 };
const pixels = await Promise.all(
  frames.map((buffer) =>
    sharp(buffer).extract(region).greyscale().raw().toBuffer({ resolveWithObject: true }),
  ),
);

const [a, b] = pixels.map((p) => p.data);
let changed = 0;
let sum = 0;
for (let i = 0; i < a.length; i++) {
  const d = Math.abs(a[i] - b[i]);
  if (d) changed++;
  sum += d;
}
const fraction = changed / a.length;
console.log(
  `pixels differing between frames: ${(fraction * 100).toFixed(1)}%  ` +
    `mean difference ${(sum / a.length).toFixed(3)} levels`,
);
console.log(fraction > 0.1 ? 'dither active' : 'DITHER NOT DETECTED');
process.exit(fraction > 0.1 ? 0 : 1);
