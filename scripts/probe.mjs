/**
 * One-off inspector: loads the app and dumps whatever expression you pass, so
 * shader and buffer state can be checked without adding permanent debug UI.
 *
 * Usage: node scripts/probe.mjs "expression using window.cosminova"
 */
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const expression = process.argv[2] ?? 'Object.keys(window.cosminova)';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  defaultViewport: { width: 1200, height: 800 },
});
const page = await browser.newPage();
page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });
await page.evaluate(
  () =>
    new Promise((resolve) => {
      let n = 0;
      const tick = () => (++n > 30 ? resolve() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    }),
);

const result = await page.evaluate(
  `(async () => { try { return JSON.stringify(await (${expression}), null, 1); } catch (e) { return 'ERROR ' + e.message; } })()`,
);
console.log(result);

const shot = process.argv[3];
if (shot) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const tick = () => (++n > 40 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
  );
  await page.screenshot({ path: shot });
  console.log(`wrote ${shot}`);
}
await browser.close();
