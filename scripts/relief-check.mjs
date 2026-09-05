/**
 * Is close-range ground actually flat, or is it just lit from behind the camera?
 *
 * Reported as terrain rendering flat from low altitude. The first screenshot of
 * it was taken with the sun 38 degrees off the view direction, which is very
 * nearly front-lit, and front-lit relief has no visible shading and casts every
 * shadow behind the thing making it. So a flat-looking frame there does not
 * distinguish between the shader drawing no relief and the relief being there
 * and unlit.
 *
 * Grazing light is what separates them. This renders the same ground across a
 * sweep of sun angles and measures how much local contrast the image has — the
 * spread of each pixel against the average of its neighbourhood, which responds
 * to relief shading and ignores the flat colour of the ground. Real relief gets
 * markedly stronger as the sun drops; a painted texture does not change.
 *
 * Usage: node scripts/relief-check.mjs [body]
 */
import sharp from 'sharp';
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BODY = process.argv[2] ?? 'mars';
const PHASES = [20, 45, 70, 88];
const W = 900;
const H = 620;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: W, height: H },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.cosminova?.ready === true, { timeout: 120000 });
await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setUiVisible(false);
});

/**
 * Local contrast: the root-mean-square difference between each pixel and a
 * blurred copy of the image. Insensitive to the overall brightness and to broad
 * gradients across the frame, which is what makes it a measure of surface
 * texture rather than of how lit the scene is.
 */
async function contrast() {
  const png = await page.screenshot({ type: 'png' });
  const base = sharp(png).removeAlpha().greyscale();
  const { data, info } = await base.raw().toBuffer({ resolveWithObject: true });
  const blurred = await sharp(png).removeAlpha().greyscale().blur(4).raw().toBuffer();
  let sum = 0;
  let sumSq = 0;
  let mean = 0;
  for (let i = 0; i < data.length; i++) {
    const d = data[i] - blurred[i];
    sum += d;
    sumSq += d * d;
    mean += data[i];
  }
  const n = data.length;
  return {
    rms: Math.sqrt(sumSq / n - (sum / n) ** 2),
    mean: mean / n,
    width: info.width,
  };
}

console.log(`${BODY} from just above the surface, sun swung from behind the `
  + `camera round to grazing:\n`);
console.log('  phase   local contrast   mean brightness   terrain state');

const rows = [];
for (const phase of PHASES) {
  await page.evaluate((b, p) => window.cosminova.lookFromSun(b, 1.004, p, 4), BODY, phase);
  await new Promise((r) => setTimeout(r, 6500));
  const c = await contrast();
  const st = await page.evaluate(() => {
    const s = window.cosminova.stats();
    return {
      patches: s.patches,
      craterOctaves: s.craterOctaves,
      hasDem: s.hasDem,
      hasNormal: s.hasNormal,
      detail: +window.cosminova.quality.terrainDetail.toFixed(2),
      micro: window.cosminova.quality.microDetail,
      shadows: window.cosminova.state.terrainShadows,
      altitudeKm: +s.altitudeKm.toFixed(1),
    };
  });
  rows.push({ phase, ...c, ...st });
  console.log(`  ${String(phase).padStart(3)}\u00b0  ${c.rms.toFixed(2).padStart(10)}  `
    + `${c.mean.toFixed(1).padStart(14)}   `
    + `patches ${st.patches}, octaves ${st.craterOctaves}, `
    + `dem ${st.hasDem}, micro ${st.micro}, shadows ${st.shadows}`);
  await page.screenshot({ path: `shots/_relief-${BODY}-${phase}.png` });
}

await browser.close();

// Front-lit is the baseline and the strongest frame of the sweep is the signal,
// rather than the last frame. Contrast has to fall again once the sun reaches the
// terminator, because there is no light left to shade anything with: the darkest
// frames here average 4 of 255, and an unlit surface has no contrast whatever its
// shape. Reading the end of the sweep as the answer therefore scores a body that
// went dark the same as one that is genuinely flat. Frames too dark to carry the
// measurement are held out of it rather than dragging the verdict down.
// Both ends of the comparison have to come from frames with light in them. The
// baseline is the most front-lit of those rather than the first frame outright:
// an irregular body can be underground at the altitude asked for, since that is
// set in reference radii and a body like Phobos stands half a radius above its
// own reference sphere along the long axis, so the frame comes back as empty sky.
// Measuring a lit peak against an unlit baseline reports a large ratio for a body
// that was never photographed, which is worse than reporting nothing.
const LIT_FLOOR = 12;
const usable = rows.filter((r) => r.mean >= LIT_FLOOR);
const dark = rows.filter((r) => r.mean < LIT_FLOOR).map((r) => `${r.phase}\u00b0`);
if (dark.length) console.log(`\n  too dark to measure, held out: ${dark.join(', ')}`);
if (usable.length < 2) {
  console.log(`\n  only ${usable.length} frame(s) had light in them, which is not `
    + 'enough to tell relief from flat ground: try a higher altitude, or a body '
    + 'whose figure is closer to a sphere');
} else {
  const base = usable[0];
  const peak = usable.reduce((a, r) => (r.rms > a.rms ? r : a), usable[0]);
  console.log(`\n  contrast at ${base.phase}\u00b0, the most front-lit frame `
    + `with light in it: ${base.rms.toFixed(2)}`);
  console.log(`  strongest lit frame at ${peak.phase}\u00b0: ${peak.rms.toFixed(2)}`);
  const ratio = peak.rms / Math.max(base.rms, 0.001);
  console.log(`  ratio: ${ratio.toFixed(2)}x`);
  if (ratio > 1.5) {
    console.log('\n  relief responds to the sun angle, so geometry is there and lit');
  } else {
    console.log('\n  contrast barely moves with the sun: the ground is drawing flat');
  }
}
if (errors.length) {
  console.log('\n  errors:');
  for (const e of [...new Set(errors)].slice(0, 5)) console.log(`    ${e}`);
}
