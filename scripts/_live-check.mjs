/**
 * Loads the deployed app and waits for the renderer to actually come up.
 *
 * A 200 on /app/ only proves the HTML was served. This is the check that the
 * data files, textures and shaders all resolved from their published paths and
 * the scene reached a ready state — the failure mode worth catching is a build
 * that serves fine and renders nothing.
 *
 * Usage: node scripts/_live-check.mjs [url]
 */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'https://cosminova.github.io/info/app/index.html';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: 1280, height: 800 },
});

const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('response', (r) => {
  if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`);
});

console.log(`loading ${URL}`);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });

const stats = await page.evaluate(() => window.cosminova.stats());
console.log('renderer reached ready');
console.log(`  ${JSON.stringify(stats)}`);

await page.screenshot({ path: 'shots/site/live-app.jpg', type: 'jpeg', quality: 88 });

console.log(problems.length ? `  ${problems.length} problems:` : '  no page errors, no failed requests');
for (const p of problems.slice(0, 5)) console.log(`    ! ${p}`);

await browser.close();
process.exit(problems.length ? 1 : 0);
