/**
 * The mark where it actually has to work: in the header, at real size.
 *
 * A logo that proofs well on a contact sheet can still fail beside the
 * wordmark, which is the only place on the page it appears. This crops the
 * header at 1x and at 3x so the shape can be judged against the type it sits
 * next to.
 */

import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const URL = process.env.SITE_URL ?? 'http://127.0.0.1:4600/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = 'shots/logo';
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
});

const page = await browser.newPage();

for (const scale of [1, 3]) {
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: scale });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  const brand = await page.$('.nav__brand');
  await brand.screenshot({ path: `${OUT}/header-${scale}x.png` });
  console.log(`header-${scale}x.png`);
}

await browser.close();
