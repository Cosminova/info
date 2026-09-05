/**
 * Find the exposure and saturation that make a red supergiant read as orange.
 *
 * The disc is washed out by the filmic tone curve, not by bloom: the colour
 * handed to the shader has its red channel already past one, and the curve
 * compresses the brightest channel hardest, which pulls the hue towards cream.
 * There are only two dials that matter — how far up the curve the disc sits,
 * and how saturated it is before it gets there — so both are swept and the
 * rendered result measured, rather than reasoned about.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots/star-tune');
const W = 420;
const H = 420;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const KEY = process.env.STAR ?? 'star:Betelgeuse';
const INTENSITIES = [0.18, 0.26, 0.36, 0.50];
const SATURATIONS = [1.0, 1.5, 2.0];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  ! page', e.message));

const settle = (n) =>
  page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        let c = 0;
        const tick = () => (++c >= frames ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });
await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setUiVisible(false);
});
await settle(10);

const base = await page.evaluate(
  ({ key }) => {
    const sv = window.cosminova;
    sv.target(key, 8);
    sv.controls.stopFlight();
    sv.controls.distanceRadii = 8;
    sv.controls.fov = 34;
    return sv.starProfileFor(key);
  },
  { key: KEY },
);
await settle(40);

console.log(`${KEY}: ${Math.round(base.teff)} K, ${base.radiusSol.toFixed(0)} Rsol`);
console.log(`shipping now: intensity ${base.intensity.toFixed(3)}, colour ${base.colour.map((v) => v.toFixed(3)).join(',')}\n`);

/**
 * Push a linear colour away from its own luminance. Saturating in linear light
 * keeps the hue; doing it after the tone curve would just stretch the clipping.
 */
function saturate([r, g, b], s) {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [y + (r - y) * s, y + (g - y) * s, y + (b - y) * s].map((v) => Math.max(v, 0));
}

function centre(raw) {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = H / 2 - 30; y < H / 2 + 30; y++) {
    for (let x = W / 2 - 30; x < W / 2 + 30; x++) {
      const i = (y * W + x) * 3;
      sum[0] += raw[i];
      sum[1] += raw[i + 1];
      sum[2] += raw[i + 2];
      n++;
    }
  }
  return sum.map((v) => Math.round(v / n));
}

const sat = ([r, g, b]) => {
  const max = Math.max(r, g, b);
  return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
};

console.log('intensity  sat-in   colour in (linear)     on screen      sat   reads as');
console.log('-'.repeat(84));

const tiles = [];
for (const s of SATURATIONS) {
  for (const intensity of INTENSITIES) {
    const colour = saturate(base.colour, s);
    const ok = await page.evaluate(
      ({ key, col, inten }) => {
        let mesh = null;
        window.cosminova.scene.traverse((o) => {
          if (o.name === key) mesh = o;
        });
        if (!mesh) return false;
        for (const child of mesh.children) {
          const u = child.material?.uniforms;
          if (!u?.uColour) continue;
          u.uColour.value.setRGB(col[0], col[1], col[2]);
          // The corona is a fraction of the photosphere, as it is built.
          u.uIntensity.value = u.uDiscFraction ? inten * 0.22 : inten;
        }
        return true;
      },
      { key: KEY, col: colour, inten: intensity },
    );
    if (!ok) throw new Error(`could not reach the mesh for ${KEY}`);
    await settle(12);

    const name = `s${s.toFixed(1)}-i${intensity.toFixed(2)}`;
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    tiles.push(file);
    const px = centre(await sharp(file).removeAlpha().raw().toBuffer());
    const [r, g, b] = px;
    const reads =
      sat(px) < 0.2 ? 'cream' : sat(px) < 0.32 ? 'pale orange' : sat(px) < 0.5 ? 'orange' : 'deep orange';
    console.log(
      `${intensity.toFixed(2).padStart(9)}  ${s.toFixed(1).padStart(6)}   ` +
        `${colour.map((v) => v.toFixed(2)).join(',').padEnd(22)}` +
        `${`${r},${g},${b}`.padEnd(15)}${sat(px).toFixed(2)}   ${reads}`,
    );
  }
}

fs.writeFileSync(path.join(OUT, 'order.txt'), tiles.join('\n'));
console.log(`\nshots in ${OUT}`);
await browser.close();
