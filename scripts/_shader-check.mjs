// Boots the app, walks a few bodies, and fails loudly on any shader compile or
// link error. Three reports those through console.error, so a silent black
// planet in a screenshot is otherwise the only symptom.
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://127.0.0.1:5180/index.html';
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--window-size=1400,900',
  ],
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();

const errors = [];
page.on('console', (msg) => {
  if (msg.type() !== 'error' && msg.type() !== 'warning') return;
  const text = msg.text();
  if (/shader|glsl|program|uniform|webgl|compile/i.test(text)) errors.push(text.slice(0, 900));
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`.slice(0, 500)));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
await new Promise((r) => setTimeout(r, 1500));

const stops = ['moon', 'mars', 'mercury', 'earth', 'jupiter'];
for (const key of stops) {
  await page.evaluate((k) => window.cosminova.lookFromSun(k, 2.4), key);
  await new Promise((r) => setTimeout(r, 1500));
}

await browser.close();
console.log(JSON.stringify({ errorCount: errors.length, errors: errors.slice(0, 8) }, null, 2));
process.exit(errors.length ? 1 : 0);
