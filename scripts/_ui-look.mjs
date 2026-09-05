/** Screenshots of the interface: first run, and the panels once dismissed. */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://127.0.0.1:5179/';
const OUT = path.resolve('shots/ui');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: 1360, height: 860, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await new Promise((r) => setTimeout(r, 2200));
await page.screenshot({ path: path.join(OUT, '1-first-run.jpg'), type: 'jpeg', quality: 92 });

// Dismiss, and see the labelled rail.
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.intro button')].find((x) => x.textContent.includes('know my way'));
  b?.click();
});
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: path.join(OUT, '2-rail-labelled.jpg'), type: 'jpeg', quality: 92 });

// The object panel's action row.
await page.evaluate(() => window.cosminova.target('mars', 4));
await new Promise((r) => setTimeout(r, 2600));
await page.screenshot({ path: path.join(OUT, '3-object-actions.jpg'), type: 'jpeg', quality: 92 });

// Help.
await page.evaluate(() => window.cosminova.ui.toggleDialog('help', true));
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: path.join(OUT, '4-help.jpg'), type: 'jpeg', quality: 92 });

console.log('errors:', errors.length ? errors.slice(0, 4) : 'none');
console.log('shots in', OUT);
await browser.close();
