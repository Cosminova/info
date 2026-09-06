/**
 * The start screen, and the three hosts that have to disagree about it.
 *
 * A cover over the whole viewport is a dangerous thing to add to this app,
 * because almost everything in scripts/ works by loading the explorer in
 * headless Chrome, waiting for `window.cosminova.ready` and then photographing
 * or clicking the scene. Anything left in front of that turns the store
 * screenshots, the site stills and every interaction check into a picture of a
 * start screen — and it would do it quietly, since all of those scripts would
 * still pass their own assertions about a page that had loaded fine.
 *
 * So the last case here is the important one. The first two are the feature;
 * the third is the reason the feature is allowed to exist.
 *
 * Usage: node scripts/home-check.mjs [url]      (serve dist/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = process.argv[2] ?? process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'shots', 'home');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
});

/**
 * `hosted` is what makes a visitor: every script here is automated, and the
 * start screen hides from automation on purpose, so to see what a person sees
 * the one signal separating them has to be put back.
 */
async function load({ viewport, ua, shell = null, hosted = false }) {
  const page = await browser.newPage();
  const errors = [];
  const fetched = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('request', (r) => {
    if (/\/home\/[^/]+\.jpg/.test(r.url())) fetched.push(r.url().split('/').pop());
  });
  if (ua) await page.setUserAgent(ua);
  await page.setViewport(viewport);
  if (hosted) {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
  }
  if (shell) {
    await page.evaluateOnNewDocument((s) => {
      window.cosminovaShell = s;
    }, shell);
  }
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  return { page, errors, fetched };
}

const state = (page) =>
  page.evaluate(() => {
    const root = document.getElementById('home');
    const backdrop = document.getElementById('home-backdrop');
    const button = document.getElementById('home-start');
    const box = root?.getBoundingClientRect();
    return {
      present: Boolean(root),
      covers: box ? box.width >= window.innerWidth && box.height >= window.innerHeight : false,
      ready: Boolean(root?.classList.contains('is-ready')),
      backdropLoaded: Boolean(backdrop?.classList.contains('is-loaded')),
      backdropImage: backdrop ? getComputedStyle(backdrop).backgroundImage.slice(0, 60) : '',
      label: button?.textContent.trim() ?? '',
      disabled: button?.disabled ?? null,
      // Built hidden at startup and revealed later, so presence in the DOM says
      // nothing about whether anyone is being shown it.
      intro: (() => {
        const card = document.querySelector('.intro');
        return Boolean(card) && !card.hidden;
      })(),
    };
  });

// ------------------------------------------------- a visitor, on a desktop
console.log('\na visitor in a browser');
{
  const { page, errors, fetched } = await load({
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    hosted: true,
  });

  // Before the app is ready: the screen is up and says what it is waiting for.
  await page.waitForSelector('#home', { timeout: 30000 });
  const waiting = await state(page);
  check('the start screen is up before the app has loaded', waiting.present && waiting.covers);
  check(
    'it does not offer to start while there is nowhere to go',
    waiting.disabled === true && !waiting.ready,
    `button reads "${waiting.label}"`,
  );

  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
  await page.waitForFunction("document.getElementById('home')?.classList.contains('is-ready')", {
    timeout: 30000,
  });
  const armed = await state(page);
  check('a backdrop decoded and faded in', armed.backdropLoaded, armed.backdropImage);
  check(
    'exactly one of the three backdrops was fetched',
    fetched.length === 1,
    fetched.join(', ') || 'none',
  );
  check('it invites a click on a machine with a pointer', armed.label === 'Click to start', armed.label);
  check('the welcome card is not raised behind it', !armed.intro);
  await page.screenshot({ path: path.join(OUT, 'desktop.png') });

  // The gesture.
  await page.click('#home');
  await new Promise((r) => setTimeout(r, 1400));
  const after = await state(page);
  check('clicking takes the screen away', !after.present);
  check('and the first visit gets its welcome card then, not before', after.intro);
  check('nothing went wrong', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.screenshot({ path: path.join(OUT, 'desktop-after.png') });
  await page.close();
}

// --------------------------------------------------------- a visitor, on a phone
console.log('\na visitor on a phone');
{
  const { page, errors } = await load({
    viewport: { width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    hosted: true,
  });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
  await page.waitForFunction("document.getElementById('home')?.classList.contains('is-ready')", {
    timeout: 30000,
  });
  const armed = await state(page);
  check('the screen fits a phone and covers it', armed.present && armed.covers);
  check('it asks for a tap rather than a click', armed.label === 'Tap to start', armed.label);
  await page.screenshot({ path: path.join(OUT, 'phone.png') });

  await page.tap('#home');
  await new Promise((r) => setTimeout(r, 1400));
  check('tapping takes it away', !(await state(page)).present);
  check('nothing went wrong', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ the iOS app
console.log('\ninside the iOS app');
{
  const { page, errors } = await load({
    viewport: { width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    shell: { shell: 'ios', deviceClass: 'phone' },
    hosted: true,
  });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
  const inside = await state(page);
  // It launched from an icon. Being asked to start is a door in the middle of a room.
  check('an app that launched from an icon is not asked to start', !inside.present);
  check('nothing went wrong', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// ------------------------------------------------------------- a capture script
console.log('\na capture script, which is every other file in scripts/');
{
  // Deliberately not `hosted`: this is exactly how site-stills, store-shots,
  // ui-check and the rest arrive, and none of them know this screen exists.
  const { page, errors, fetched } = await load({
    viewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
  });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
  const seen = await state(page);
  check('automation is handed the scene, not a start screen', !seen.present);
  check('and is not made to download a backdrop for it', fetched.length === 0, fetched.join(', '));
  check('nothing went wrong', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`shots in ${path.relative(ROOT, OUT)}`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL  ${f.name}  ${f.detail}`);
  process.exit(1);
}
