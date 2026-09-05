/**
 * Checks the landing page renders, at a desktop and a phone width.
 *
 * Screenshots for the eye, plus the few assertions worth making mechanically:
 * that nothing 404s, that the console is clean, that the Windows button points
 * somewhere real, and that the macOS button is genuinely inert rather than
 * merely styled to look it.
 *
 * Usage: node scripts/site-check.mjs   (expects a server on SITE_URL)
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const URL = process.env.SITE_URL ?? 'http://127.0.0.1:4600/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots/site');
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
});

const problems = [];
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
page.on('response', (r) => {
  if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`);
});

const results = [];
const check = (name, ok, detail = '') =>
  results.push({ name, ok, detail });

for (const [label, width, height] of [
  ['desktop', 1440, 900],
  ['phone', 414, 896],
]) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  // The reveal animations run on scroll and the gallery images are lazy, so the
  // page is walked to the bottom before capture. Without this everything below
  // the fold shoots as black boxes: transparent from the reveal that never
  // fired, and undecoded from the loading attribute.
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.6;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 300));
  });

  // Walking the page starts the lazy loads but does not finish them, and a
  // full-page capture will happily record a half-decoded image.
  await page.evaluate(
    () =>
      Promise.all(
        [...document.images].map((img) =>
          img.complete
            ? img.decode().catch(() => {})
            : new Promise((resolve) => {
                img.addEventListener('load', resolve, { once: true });
                img.addEventListener('error', resolve, { once: true });
              }),
        ),
      ),
  );
  await new Promise((r) => setTimeout(r, 250));

  await page.screenshot({
    path: path.join(OUT, `${label}-fold.jpg`),
    type: 'jpeg',
    quality: 88,
  });
  await page.screenshot({
    path: path.join(OUT, `${label}-full.jpg`),
    type: 'jpeg',
    quality: 82,
    fullPage: true,
  });
  console.log(`  ${label} captured (${width}x${height})`);
}

// The two buttons, which are the point of the page.
const buttons = await page.evaluate(() => {
  const win = document.querySelector('a[data-download="windows"][href^="http"]');
  const mac = [...document.querySelectorAll('button.btn')].find((b) =>
    b.textContent.toLowerCase().includes('macos'),
  );
  return {
    windowsHref: win?.getAttribute('href') ?? null,
    macDisabled: mac ? mac.disabled : null,
    macIsButton: mac ? mac.tagName === 'BUTTON' : null,
    macHasHref: mac ? mac.hasAttribute('href') : null,
  };
});

check(
  'the Windows button points at a release',
  /github\.com\/.+\/releases/.test(buttons.windowsHref ?? ''),
  buttons.windowsHref ?? 'no href found',
);
check('the macOS button is disabled', buttons.macDisabled === true);
check(
  'the macOS button cannot navigate',
  buttons.macIsButton === true && buttons.macHasHref === false,
  'it is a <button> with no href',
);

// The app has to actually be reachable at the subpath the page links to.
const app = await page.goto(new global.URL('app/index.html', URL).href, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
check('the app is served at /app/', app?.status() === 200, `http ${app?.status()}`);

console.log();
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.name}${r.detail ? `  ${r.detail}` : ''}`);
}

// Chrome reports a benign autoplay rejection on some setups; the page handles
// it, so it is not counted against the run.
const real = problems.filter((p) => !/play\(\) (request|failed)/i.test(p));
console.log(real.length ? `\n${real.length} console/network problems:` : '\nno console or network errors');
for (const p of real.slice(0, 8)) console.log(`  ! ${p}`);

console.log(`\nshots in ${OUT}`);
await browser.close();
process.exit(failed || real.length ? 1 : 0);
