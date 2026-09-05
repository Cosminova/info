/**
 * Regional geology check.
 *
 * The claim being tested is that bodies differ structurally rather than only in
 * colour: that a flooded plain is genuinely smoother ground than the cratered
 * highland beside it, that the smoothing is regional rather than global, and that
 * two planets given different histories do not come out looking the same.
 *
 * Colour is deliberately not measured. Every body here already has its own
 * palette, so any statistic that responds to hue would pass whatever the terrain
 * was doing, which is the exact failure this is meant to catch — a recoloured
 * sphere. What is measured instead is local relief: the luminance gradient between
 * neighbouring pixels, under a low sun where slope dominates the shading. Rough
 * ground scatters light at every scale and has a large gradient nearly everywhere;
 * a lava plain has almost none.
 *
 * The comparisons are relative, each body against itself with one process removed,
 * because an absolute roughness threshold would have to be recalibrated for every
 * albedo, sun angle and exposure in the project. A ratio needs no calibration.
 *
 * Usage: node scripts/geology-check.mjs [body...]
 */
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const BASE = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Distance and phase per body. A grazing sun is essential: at full phase the disc
// is lit flat, relief of a few kilometres on a body of a few thousand disappears
// into the albedo, and the statistic below measures nothing.
const VIEWS = {
  mars: { distance: 1.22, phase: 76, rotationDays: 1.026 },
  mercury: { distance: 1.22, phase: 73, rotationDays: 58.65 },
  venus: { distance: 1.22, phase: 70, rotationDays: 243.02 },
};

const requested = process.argv.slice(2);
const BODIES = requested.length ? requested : Object.keys(VIEWS);

let failures = 0;

function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/**
 * Local relief statistics over the lit surface.
 *
 * The gradient is the sum of the forward differences in luminance across and down,
 * which is a Sobel-free stand-in for slope that costs one pass. Unlit pixels are
 * excluded: a shadowed crater floor and a lava plain are both flat black, and
 * counting the shadows would make a heavily cratered body look smooth.
 *
 * Returned as the median gradient and the lower quartile. The quartile is the
 * useful one for flooding, which does not smooth the whole body — it smooths the
 * third of it that lies below the datum, and a statistic that has to move the
 * median cannot see a third of anything.
 */
const TILE = 45;

function relief(data, width, height) {
  const lum = (x, y) => {
    const i = (y * width + x) * 3;
    return (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
  };

  // Roughness tile by tile across the disc, rather than one figure for the frame.
  //
  // A province covers a fraction of a body, so a single number over the whole view
  // averages the plains together with the highlands and lands in between — and it
  // is the difference between them that is the entire claim. Worse, one number
  // from one view is a lottery over where the camera happened to be pointing: a
  // third of a planet under lava means two thirds of views see none of it.
  //
  // Tiles answer the question directly. A provincial surface has smooth tiles and
  // rough tiles in the same frame; a body built from uniform noise has tiles that
  // all agree, however rough they are.
  const tiles = [];
  const x0 = Math.floor(width * 0.16);
  const x1 = Math.floor(width * 0.84);
  const y0 = Math.floor(height * 0.16);
  const y1 = Math.floor(height * 0.84);

  for (let ty = y0; ty + TILE < y1; ty += TILE) {
    for (let tx = x0; tx + TILE < x1; tx += TILE) {
      const gradients = [];
      let brightness = 0;
      for (let y = ty; y < ty + TILE; y++) {
        for (let x = tx; x < tx + TILE; x++) {
          const l = lum(x, y);
          // Lit ground only, and not blown out either: a saturated pixel has had
          // its gradient clipped away and would read as smooth, and a shadowed
          // crater floor is as flat and black as a lava plain.
          if (l < 0.06 || l > 0.97) continue;
          gradients.push(Math.abs(lum(x + 1, y) - l) + Math.abs(lum(x, y + 1) - l));
          brightness += l;
        }
      }
      // Tiles straddling the limb or the terminator are mostly unusable pixels.
      if (gradients.length < TILE * TILE * 0.6) continue;
      gradients.sort((a, b) => a - b);
      // Divided by the tile's own brightness, which is what makes this a measure
      // of texture rather than of illumination. An absolute gradient scales with
      // how hard the light is falling on the ground, and under the grazing sun
      // these views need that varies by an order of magnitude from the terminator
      // to the subsolar point — enough to swamp any difference in the terrain and
      // make a smooth plain in full light read as rougher than cratered ground in
      // twilight.
      const mean = brightness / gradients.length;
      tiles.push(gradients[gradients.length >> 1] / Math.max(mean, 1e-6));
    }
  }

  if (tiles.length < 12) return null;
  const sorted = [...tiles].sort((a, b) => a - b);
  const smooth = sorted[Math.floor(sorted.length * 0.1)];
  const rough = sorted[Math.floor(sorted.length * 0.9)];
  return {
    smooth,
    rough,
    median: sorted[sorted.length >> 1],
    // How much flatter the smoothest ground in view is than the roughest. This is
    // the provinciality of the surface, and it is scale-free.
    contrast: rough > 0 ? (rough - smooth) / rough : 0,
    tiles,
  };
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const settle = (frames = 30) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let count = 0;
        const tick = () => (++count > n ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames,
  );

await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setDate('2026-03-21T12:00:00Z');
  // Bloom spreads light across neighbouring pixels, which is precisely the
  // quantity being measured, and the dither pass adds a different noise field
  // every frame. Both would swamp the gradient.
  window.cosminova.setBloom(false);
  window.cosminova.setPass('dither', false);
  window.cosminova.setUiVisible(false);
});
await settle(50);

/**
 * Renders one body with a set of uniform overrides and returns its relief
 * statistics. Overrides are applied after the camera move, since placing the
 * camera clears them.
 */
async function measure(key, overrides, { date, tilt }) {
  const view = VIEWS[key];
  await page.evaluate(
    (k, d, p, o, when, t) => {
      window.cosminova.setDate(when);
      window.cosminova.lookFromSun(k, d, p, t);
      for (const [name, value] of Object.entries(o)) {
        window.cosminova.setUniform(k, name, value);
      }
    },
    key,
    view.distance,
    view.phase,
    overrides,
    date,
    tilt,
  );
  await settle(30);
  const shot = await page.screenshot({ type: 'png' });
  const { data, info } = await sharp(shot).removeAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  return relief(data, info.width, info.height);
}

const GEOLOGY_OFF = {
  uCrustRelief: 0,
  uFloodCoverage: 0,
  uRiftCoverage: 0,
  uVolcanoCoverage: 0,
};

/**
 * Longitudes to sample, as dates spread across a rotation.
 *
 * One close view cannot say anything about a process covering a sixth of a planet:
 * the camera is over an arbitrary spot and most likely not over the plains at all.
 * Averaging over the whole body would be just as blind, because the average of
 * smooth ground and rough ground is neither.
 *
 * What actually has to be shown is that the body has both. So the body is sampled
 * in several places, and the statistic is how much of it is anomalously flat —
 * which is the definition of a provincial surface, and is exactly what a body built
 * from uniform noise cannot produce.
 *
 * Latitude is varied along with longitude. The crust field runs at hemisphere
 * scale, so one close view sees the inside of a single province and nothing else;
 * sampling a row of longitudes at one latitude can therefore miss a body's plains
 * completely, and for Mercury it did, reporting three per cent plains on a planet
 * that is a quarter covered in them.
 */
const TILTS = [-46, 12, 52, -18, 34, -34, 24, -8];
const START = Date.UTC(2026, 2, 21);

/**
 * Views spread over one full rotation of the body, at varied latitudes.
 *
 * The rotation period has to come from the body. Stepping through a day and a half
 * of dates covers Mars more than once but turns Mercury through eight degrees and
 * Venus through two — so every sample lands on the same ground, and a planet a
 * quarter covered in plains reports three per cent of them because none of its
 * views ever reached a province. That is what the first version of this check did.
 */
function viewsFor(key) {
  const { rotationDays } = VIEWS[key];
  return TILTS.map((tilt, i) => ({
    tilt,
    date: new Date(START + (rotationDays * 86400000 * i) / TILTS.length).toISOString(),
  }));
}

async function survey(key, overrides) {
  const contrasts = [];
  const tiles = [];
  for (const view of viewsFor(key)) {
    const stats = await measure(key, overrides, view);
    if (!stats) continue;
    contrasts.push(stats.contrast);
    tiles.push(...stats.tiles);
  }
  if (contrasts.length < 3) return null;
  const sorted = [...tiles].sort((a, b) => a - b);
  return {
    // The median frame rather than the best one. Taking the maximum would let a
    // single lucky view carry the whole result.
    contrast: median(contrasts),
    roughness: sorted[sorted.length >> 1],
    tiles: sorted,
    frames: contrasts.length,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

const summary = [];

for (const key of BODIES) {
  if (!VIEWS[key]) {
    console.log(`skip  ${key}: no view defined`);
    continue;
  }
  console.log(`\n${key}`);

  const withGeology = await survey(key, {});
  const withoutGeology = await survey(key, GEOLOGY_OFF);

  if (!withGeology || !withoutGeology) {
    check(`${key}: enough lit surface to measure`, false, 'too few usable pixels');
    continue;
  }

  console.log(
    `  across ${withGeology.frames} views:` +
      ` tile contrast ${(withGeology.contrast * 100).toFixed(0)}% with geology,` +
      ` ${(withoutGeology.contrast * 100).toFixed(0)}% without`,
  );

  // A body with provinces has smooth ground in some places and rough ground in
  // others. One built from uniform noise looks the same wherever you point the
  // camera, which is the failure being tested for.
  check(
    `${key}: the surface is provincial rather than uniform`,
    withGeology.contrast > 0.25,
    `smoothest ground in view is ${(withGeology.contrast * 100).toFixed(0)}%` +
      ' flatter than the roughest',
  );

  // And that variation has to come from the geology rather than from the crater
  // field happening to be patchy. With every regional process removed the same
  // survey should be markedly more uniform.
  // How much of the body is anomalously flat, against a threshold set by the same
  // body without its geology.
  //
  // Not the flattest patch, which was the obvious choice and the wrong one: on a
  // surface saturated with craters the flattest ground is the floor of a large
  // crater, which is genuinely as flat as a lava plain. Mercury, with the highest
  // crater density here, therefore showed no improvement at all while plainly
  // having gained plains. What flooding changes is how much flat ground there is,
  // not how flat the flattest is.
  const threshold = withoutGeology.roughness * 0.5;
  const share = (survey) => survey.tiles.filter((t) => t < threshold).length / survey.tiles.length;
  const flatWith = share(withGeology);
  const flatWithout = share(withoutGeology);
  check(
    `${key}: the geology creates flat ground that is not otherwise there`,
    flatWith > flatWithout + 0.06,
    `${(flatWith * 100).toFixed(0)}% of the surface is plains against` +
      ` ${(flatWithout * 100).toFixed(0)}% without geology`,
  );

  summary.push({ key, roughness: withGeology.roughness, contrast: withGeology.contrast });
}

// Different histories have to give different surfaces. Two planets whose relief
// statistics agree to within a few per cent are the same terrain in two palettes,
// however different the parameters that produced them looked.
if (summary.length >= 2) {
  console.log('');
  const values = summary.map((s) => s.roughness);
  const spread = (Math.max(...values) - Math.min(...values)) / Math.max(...values);
  check(
    'bodies differ structurally, not just in colour',
    spread > 0.15,
    `${summary.map((s) => `${s.key} ${s.roughness.toFixed(4)}`).join(', ')}` +
      ` — spread ${(spread * 100).toFixed(0)}%`,
  );
}

check('no console errors during the geology checks', errors.length === 0, errors[0] ?? '');

await browser.close();

console.log(
  failures === 0
    ? `\ngeology reads as geology on ${summary.length} bodies`
    : `\n${failures} geology checks failed`,
);
process.exit(failures === 0 ? 0 : 1);
