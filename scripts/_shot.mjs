/**
 * Screenshot helper: `node scripts/_shot.mjs out.png 'js to run'` with the UI
 * left visible unless the script hides it.
 */
import puppeteer from 'puppeteer-core';

const [out, script = '', waitMs = '3500', ui = 'off'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.goto(process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5182/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await page.evaluate(() => window.cosminova.setRate(0));
if (ui === 'off') await page.evaluate(() => window.cosminova.setUiVisible(false));
if (script) await page.evaluate(script);
await new Promise((r) => setTimeout(r, Number(waitMs)));
await page.screenshot({ path: out });
console.log(JSON.stringify(await page.evaluate(() => window.cosminova.stats())));
await browser.close();
