/**
 * Guards the fix for the white marks reported around the Magellanic Clouds.
 *
 * A galaxy billboard paints invented field stars by hashing a grid across the
 * quad. The grid used to have a fixed 260 cells, so it grew with the disc:
 * from inside a galaxy, where the billboard covers the sky, every lit cell
 * came out as a hard white slab a dozen pixels across, all tilted the same way
 * because they inherit the disc's position angle. Cells are sized in pixels
 * now, and they hand over to the host-star particle layer as you close in.
 *
 * A mark is counted by that signature: bright, small, hard edged, and flat
 * grey right through. A star is a core with a gradient and does not score.
 *
 * Two halves, because either one alone can be passed by a mistake. The marks
 * must be gone from the vantages that showed them, and the galaxy layer must
 * still be drawing something at each one — a fix that simply stopped drawing
 * galaxies would report zero marks and be worse than the fault.
 *
 * Usage: node scripts/galaxy-slab-check.mjs
 */
import sharp from 'sharp';
import puppeteer from 'puppeteer-core';

const URL = process.env.URL ?? 'http://127.0.0.1:5179/index.html?home=0';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Vantages inside the invented systems that galaxies host, with the number of
// marks each showed before the fix.
const VANTAGES = [
  ['LMC system', 'star:Large Magellanic Cloud beta', 12, 83],
  ['SMC system', 'star:Small Magellanic Cloud beta', 12, 15],
  ['Andromeda system', 'star:Andromeda alpha', 12, 6],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 1024, height: 640 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.cosminova?.ready === true, { timeout: 180000 });
await page.evaluate(() => { window.cosminova.setRate(0); window.cosminova.setUiVisible(false); });

/** Flat bright slabs in one frame, and how much light the frame carries. */
async function frame(tag) {
  const png = await page.screenshot({ type: 'png' });
  if (tag) await sharp(png).toFile(`shots/_slab-${tag}.png`);
  const { data, info } = await sharp(png).removeAlpha().greyscale().raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const seen = new Uint8Array(width * height);
  const stack = [];
  let slabs = 0;
  let bright = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > 150) bright++;
    if (seen[i] || data[i] < 150) continue;
    const px = [];
    let x0 = width; let x1 = 0; let y0 = height; let y1 = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      px.push(data[j]);
      const x = j % width;
      const y = (j - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const k = ny * width + nx;
        if (seen[k] || data[k] < 150) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    const n = px.length;
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const fill = n / (w * h);
    const mean = px.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(px.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    if (n >= 18 && n <= 900 && fill >= 0.33 && fill <= 0.85 && sd <= 26) slabs++;
  }
  return { slabs, bright };
}

const setGalaxies = (on) => page.evaluate((v) => {
  window.cosminova.scene.traverse((o) => {
    if (o.geometry?.attributes?.iAxisU) o.visible = v;
  });
}, on);

let bad = 0;
for (const [label, key, radii, before] of VANTAGES) {
  await page.evaluate((t, r) => window.cosminova.target(t, r), key, radii);
  await new Promise((r) => setTimeout(r, 3200));

  const shown = await frame(label.replace(/ /g, '-'));
  await setGalaxies(false);
  await new Promise((r) => setTimeout(r, 600));
  const withoutGalaxies = await frame(null);
  await setGalaxies(true);
  await new Promise((r) => setTimeout(r, 400));

  // Whatever the galaxy layer contributes, it is no longer slabs, and it is
  // still contributing: the frame goes darker without it.
  const clean = shown.slabs <= 2;
  const drawing = shown.bright > withoutGalaxies.bright;
  if (!clean || !drawing) bad++;
  console.log(`${clean && drawing ? 'ok  ' : 'FAIL'} ${label.padEnd(18)} `
    + `${String(shown.slabs).padStart(3)} slabs (was ${String(before).padStart(3)}), `
    + `galaxy layer adds ${shown.bright - withoutGalaxies.bright} bright pixels`);
}

if (errors.length) console.log(`\nerrors: ${[...new Set(errors)].slice(0, 4).join(' | ')}`);
console.log(bad ? `\n${bad} problem(s)` : '\nall good');
process.exitCode = bad ? 1 : 0;
await browser.close();
