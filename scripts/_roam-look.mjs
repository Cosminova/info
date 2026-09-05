/** Eyeball roam mode: is the sky the right way up, and does thrust go somewhere? */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots/roam');
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: 1000, height: 640, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await page.evaluate(() => window.cosminova.setRate(0));

await page.evaluate(() => window.cosminova.target('earth', 3.2));
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: path.join(OUT, '1-orbit.jpg'), type: 'jpeg', quality: 90 });

await page.evaluate(() => window.cosminova.ui.setCameraMode('roam'));
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: path.join(OUT, '2-roam-entered.jpg'), type: 'jpeg', quality: 90 });

// Turn to put Earth off to one side, then fly past it.
await page.evaluate(() => {
  window.cosminova.controls.yaw += 0.6;
});
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: path.join(OUT, '3-roam-turned.jpg'), type: 'jpeg', quality: 90 });

await page.evaluate(() => window.cosminova.controls.setInput('KeyW', true));
await new Promise((r) => setTimeout(r, 1600));
await page.evaluate(() => window.cosminova.controls.setInput('KeyW', false));
await new Promise((r) => setTimeout(r, 1400));
await page.screenshot({ path: path.join(OUT, '4-roam-flown.jpg'), type: 'jpeg', quality: 90 });

console.log('shots in', OUT);
await browser.close();
