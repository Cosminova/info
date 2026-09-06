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
    // Instant, not smooth. The page sets scroll-behavior: smooth, so a plain
    // scrollTo animates and the capture lands somewhere mid-page.
    window.scrollTo({ top: 0, behavior: 'instant' });
    await new Promise((r) => setTimeout(r, 400));
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
  const wins = [...document.querySelectorAll('a[data-download="windows"]')];
  const mac = [...document.querySelectorAll('button.btn')].find((b) =>
    b.textContent.toLowerCase().includes('macos'),
  );
  return {
    windowsHrefs: wins.map((a) => a.getAttribute('href')),
    macDisabled: mac ? mac.disabled : null,
    macIsButton: mac ? mac.tagName === 'BUTTON' : null,
    macHasHref: mac ? mac.hasAttribute('href') : null,
  };
});

/*
 * Every Windows button has to go straight at the installer.
 *
 * Checking the href merely contains "releases" is what this used to do, and it
 * would have passed a link to the releases page, a link that only scrolls down
 * the page, and a link naming an asset that no longer exists. All three are
 * the bug: someone clicks Download and does not get a download.
 */
const EXPECTED = 'https://github.com/Cosminova/info/releases/latest/download/Cosminova-Setup.exe';

check(
  'both Windows buttons exist and download the installer directly',
  buttons.windowsHrefs.length === 2 && buttons.windowsHrefs.every((h) => h === EXPECTED),
  buttons.windowsHrefs.join(' , ') || 'none found',
);

/*
 * And the link has to actually resolve to a file. This is the failure mode the
 * version-less asset name exists to prevent, and it is invisible from the
 * markup: the href stays valid-looking forever while GitHub starts returning a
 * 404 the moment the asset it names stops existing.
 *
 * Content-Disposition is checked too, because a 200 that renders as a page is
 * still "took me to GitHub" from the visitor's side.
 */
try {
  const head = await fetch(EXPECTED, { method: 'HEAD', redirect: 'follow' });
  const disposition = head.headers.get('content-disposition') ?? '';
  const megabytes = Number(head.headers.get('content-length') ?? 0) / 1024 / 1024;
  check(
    'the installer link resolves to a downloadable file',
    head.ok && disposition.includes('attachment'),
    `http ${head.status}, ${disposition || 'no content-disposition'}, ${megabytes.toFixed(0)} MB`,
  );
} catch (error) {
  // Offline is not a finding about the page, so it is reported rather than
  // failed — a green run that only means "no network" would be worse.
  console.log(`skip  the installer link resolves  ${error.message}`);
}
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
