/**
 * Throwaway. Captures a whole element, however tall, and downscales it to
 * something readable.
 *
 * The sibling _site-section.mjs shoots one viewport, which is the right tool
 * for checking contrast but useless for judging a seven-row alternating
 * layout: only the first row is ever in frame.
 *
 * Usage: node scripts/_site-el.mjs '#features' [width]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const SELECTOR = process.argv[2] ?? '#features';
const OUT_W = Number(process.argv[3] ?? 900);
const URL = process.env.SITE_URL ?? 'http://127.0.0.1:4600/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots/site');
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: Number(process.env.VIEWPORT_W ?? 1440), height: 1000, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });

/*
 * The reveal animation starts elements transparent and only arms them once
 * they intersect. An element screenshot scrolls to the element but does not
 * wait for that, so rows below the fold capture mid-fade or fully invisible.
 * Forcing them in is more reliable than sleeping and hoping.
 */
await page.evaluate(() => {
  for (const el of document.querySelectorAll('.reveal')) el.classList.add('is-in');
});
// Lazy images below the fold need a pass through the viewport before they will
// decode at all.
await page.evaluate(async () => {
  const step = innerHeight * 0.8;
  for (let y = 0; y < document.body.scrollHeight; y += step) {
    scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  scrollTo(0, 0);
});
/*
 * Waits for decoding, but only for images that have been given a src and only
 * for so long. The hero slides deliberately carry data-src and no src until
 * their turn comes, and decode() on one of those never settles — which hung
 * this script for three minutes until the CDP timeout killed it.
 */
await page.evaluate(async () => {
  const pending = [...document.images]
    .filter((i) => i.currentSrc && !i.complete)
    .map((i) => i.decode().catch(() => {}));
  await Promise.race([
    Promise.all(pending),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
});
await new Promise((r) => setTimeout(r, 600));

/* The header is fixed, so a beyond-viewport capture paints it across the
   middle of whatever is being shot. Not a page bug, but it does obscure a row. */
await page.evaluate(() => {
  const nav = document.getElementById('nav');
  if (nav) nav.style.display = 'none';
});

const el = await page.$(SELECTOR);
if (!el) {
  console.error(`no ${SELECTOR}`);
  await browser.close();
  process.exit(1);
}

const raw = await el.screenshot({ type: 'png', captureBeyondViewport: true });
const meta = await sharp(raw).metadata();
const file = path.join(OUT, `el${SELECTOR.replace(/[^a-z0-9]/gi, '-')}.jpg`);
await sharp(raw)
  .resize(OUT_W)
  .jpeg({ quality: 82 })
  .toFile(file);

console.log(`${SELECTOR}  ${meta.width}x${meta.height} → ${OUT_W}px wide`);
console.log(file);

await browser.close();
