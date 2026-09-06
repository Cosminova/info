/**
 * Throwaway. Shoots the hero on every slide.
 *
 * The hero cross-fades through eight pictures behind fixed white text, so a
 * single capture only proves that one of them works. The one that breaks the
 * title will be whichever is brightest behind it, and that is not knowable by
 * reading the CSS.
 *
 * Also measures the luminance of the band the title actually occupies, since
 * "looks fine" and "is above the contrast floor" are different claims.
 *
 * Usage: node scripts/_hero-proof.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.env.SITE_URL ?? 'http://127.0.0.1:4600/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = 'shots/hero';
fs.mkdirSync(OUT, { recursive: true });

const W = 1440;
const H = 900;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(m.text());
});

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });

const count = await page.$$eval('.hero__dot', (d) => d.length);
if (!count) {
  console.error('no slideshow dots — the hero script did not run');
  await browser.close();
  process.exit(1);
}
console.log(`${count} slides\n`);

/** Box the title and lede occupy, as a fraction of the frame. */
const band = await page.evaluate(() => {
  const t = document.querySelector('.hero__title').getBoundingClientRect();
  const l = document.querySelector('.hero__lede').getBoundingClientRect();
  return {
    top: Math.round(t.top),
    bottom: Math.round(l.bottom),
    left: Math.round(Math.min(t.left, l.left)),
    right: Math.round(Math.max(t.right, l.right)),
  };
});

const done = [];
for (let i = 0; i < count; i++) {
  // Clicking a dot also stops the rotation, so the frame cannot change under
  // the screenshot.
  await page.evaluate((n) => document.querySelectorAll('.hero__dot')[n].click(), i);
  // The crossfade is 1.4s.
  await new Promise((r) => setTimeout(r, 1900));

  const label = await page.$eval('.hero__caption-title', (el) => el.textContent.trim());
  const file = path.join(OUT, `slide-${i}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 88 });

  /*
   * How bright is the picture behind the words? Measured with the text hidden,
   * because measuring it with the text in place mostly measures the text: the
   * title is white, it is a fixed fraction of the band, and it reported the
   * same bright share on all eight slides no matter what was behind it.
   */
  await page.evaluate(() => {
    document.querySelector('.hero__body').style.visibility = 'hidden';
  });
  const bare = await page.screenshot({ type: 'png' });
  await page.evaluate(() => {
    document.querySelector('.hero__body').style.visibility = '';
  });

  const { data, info } = await sharp(bare)
    .extract({
      left: band.left,
      top: band.top,
      width: band.right - band.left,
      height: band.bottom - band.top,
    })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  let hot = 0;
  for (const v of data) {
    sum += v;
    if (v > 150) hot++;
  }
  const mean = sum / data.length;
  const hotShare = hot / (info.width * info.height);
  // Anything above about a third of the text band being bright is where white
  // type starts to dissolve into the picture even with a shadow under it.
  const verdict = hotShare > 0.33 ? '  ← text band too bright' : '';
  console.log(
    `  ${String(i).padStart(2)} ${label.padEnd(24)} band mean ${mean.toFixed(0).padStart(3)}` +
      `   bright ${(hotShare * 100).toFixed(0).padStart(3)}%${verdict}`,
  );
  done.push({ file, label });
}

const CELL_W = 480;
const CELL_H = Math.round((CELL_W * H) / W);
const cols = 4;
const rows = Math.ceil(done.length / cols);
const tiles = await Promise.all(
  done.map(async (d, i) => ({
    input: await sharp(d.file).resize(CELL_W, CELL_H).jpeg({ quality: 84 }).toBuffer(),
    left: (i % cols) * CELL_W,
    top: Math.floor(i / cols) * CELL_H,
  })),
);
const sheet = path.resolve('shots/hero-sheet.jpg');
await sharp({
  create: { width: cols * CELL_W, height: rows * CELL_H, channels: 3, background: { r: 8, g: 10, b: 16 } },
})
  .composite(tiles)
  .jpeg({ quality: 86 })
  .toFile(sheet);

console.log(`\n${sheet}`);
console.log(problems.length ? `\n${problems.length} console problems:` : '\nno console errors');
for (const p of problems.slice(0, 5)) console.log(`  ! ${p}`);

await browser.close();
