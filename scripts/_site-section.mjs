/**
 * Captures one section of the landing page at full resolution.
 *
 * The whole-page capture scales everything down far enough that a section
 * which is merely low contrast looks identical to one that failed to render.
 * This scrolls a named element into view and shoots the viewport instead.
 *
 * Usage: node scripts/_site-section.mjs '#data'
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const SELECTOR = process.argv[2] ?? '#data';
const URL = process.env.SITE_URL ?? 'http://127.0.0.1:4600/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots/site');
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });

await page.evaluate(async (sel) => {
  document.querySelector(sel)?.scrollIntoView({ block: 'start', behavior: 'instant' });
  await new Promise((r) => setTimeout(r, 900));
}, SELECTOR);

const state = await page.evaluate((sel) => {
  const node = document.querySelector(sel);
  if (!node) return { found: false };
  const box = node.getBoundingClientRect();
  const reveals = [...node.querySelectorAll('.reveal')].map((el) => ({
    armed: el.classList.contains('is-armed'),
    shown: el.classList.contains('is-in'),
    opacity: getComputedStyle(el).opacity,
    text: (el.textContent ?? '').trim().slice(0, 40),
  }));
  return { found: true, height: Math.round(box.height), reveals };
}, SELECTOR);

console.log(JSON.stringify(state, null, 2));

const file = path.join(OUT, `section${SELECTOR.replace(/[^a-z0-9]/gi, '-')}.jpg`);
await page.screenshot({ path: file, type: 'jpeg', quality: 90 });
console.log(`\n${file}`);

await browser.close();
