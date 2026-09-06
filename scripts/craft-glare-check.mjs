/**
 * That a spacecraft does not outshine the stars behind it.
 *
 * A craft too small to resolve is drawn as a point, and so is a star, so the
 * two compete directly in the same few pixels. A craft is a few metres of
 * foil; it has no business being the brightest thing in the frame.
 *
 * Two kinds of check, because neither alone is enough:
 *
 *  - the numbers the renderer works in, which are exact and repeatable, for
 *    the property that was actually wrong: a marker's brightness never fell
 *    with distance, so the further off a probe was the more it stood out
 *    against a sky that had receded;
 *
 *  - the pixels, for the thing the eye judges, from one viewpoint that proved
 *    stable. Craft pixels are isolated by rendering the same frame with craft
 *    shown and hidden and differencing, then read against the star pixels of
 *    that same frame — absolute levels would not do, since they move with
 *    exposure and with where the camera is.
 *
 * Usage: node scripts/craft-glare-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = 'shots/craft-glare';
fs.mkdirSync(OUT, { recursive: true });

// Kept in step with craft-render.js.
const MARKER_MAX_ALPHA = 0.5;
const MESH_FADE_IN = 1.2;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: 1000, height: 640, deviceScaleFactor: 1 },
});

const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('cosminova.prefs', JSON.stringify({ seenIntro: true }));
});
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
await page.evaluate(() => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.setDate(new Date('2026-03-20T17:00:00Z'));
  sv.setUiVisible(false);
  // Nothing drawn that would land on top of the points being measured.
  for (const k of ['trajectories', 'craftVectors', 'distantMarkers', 'orbits', 'grid', 'constellations']) {
    sv.setView(k, false);
  }
  for (const k of ['labelPlanets', 'labelStars', 'labelGalaxies', 'labelBlackHoles', 'labelCraft', 'labelExo']) {
    sv.setView(k, false);
  }
});

async function settleOn(target, distanceRadii, ms = 2600) {
  await page.evaluate(
    async ([t, d]) => {
      const sv = window.cosminova;
      sv.target(t, d);
      sv.controls.stopFlight();
      sv.controls.cruise = 0;
      sv.controls.zoomVelocity = 0;
      sv.controls.distanceRadii = d;
    },
    [target, distanceRadii],
  );
  await new Promise((r) => setTimeout(r, ms));
}

/* ---- what the renderer computed, exactly ---------------------------------- */

await settleOn('earth', 40);
const drawn = await page.evaluate(() => {
  const sv = window.cosminova;
  const out = [];
  for (const state of sv.craftField.list) {
    if (!state.present) continue;
    const d = sv.craftDetail(state.key);
    if (d) out.push({ key: state.key, apparent: d.apparent, alpha: d.markerAlpha, distance: d.distance });
  }
  return out;
});

check(drawn.length > 8, 'enough craft on show to judge by', `${drawn.length} craft drawn`);

const tooBright = drawn.filter((c) => c.alpha > MARKER_MAX_ALPHA + 1e-6);
check(
  tooBright.length === 0,
  'no marker is brighter than a craft on the edge of resolving',
  tooBright.length ? `${tooBright[0].key} at ${tooBright[0].alpha.toFixed(3)}` : `cap ${MARKER_MAX_ALPHA}`,
);

/*
 * Everything unresolved sits on the floor, and that is the expected result
 * rather than a shortcoming: apparent sizes out here run from 5e-4 px down to
 * 1e-10, far below anything a brightness scale could tell apart. So the floor
 * is what governs in practice, and it is the floor that has to be modest.
 */
const points = drawn.filter((c) => c.apparent < MESH_FADE_IN);
const brightest = Math.max(...points.map((c) => c.alpha));
console.log(
  `  ${points.length} craft too small to resolve, apparent ` +
    `${Math.min(...points.map((c) => c.apparent)).toExponential(1)} to ` +
    `${Math.max(...points.map((c) => c.apparent)).toExponential(1)} px, ` +
    `brightest marker ${brightest.toFixed(3)}`,
);
check(brightest <= 0.12, 'an unresolved craft is a dim dot', `brightest ${brightest.toFixed(3)}`);
// Dim, but not gone: an invisible marker is no use to someone looking for the
// craft it stands for.
check(
  Math.min(...points.map((c) => c.alpha)) > 0.02,
  'and still on the screen',
  `faintest ${Math.min(...points.map((c) => c.alpha)).toFixed(3)}`,
);

/*
 * The falloff itself, which only ever bites across the handoff. Walk one craft
 * in from far away and its marker should come up smoothly and then give way to
 * the mesh, rather than the marker being at full brightness the whole way and
 * the mesh arriving on top of it.
 *
 * Held back until after the pixels are measured. Framing a craft selects it,
 * and a selected craft is deliberately the bright one, so a frame captured
 * afterwards measures the highlight rather than an ordinary marker.
 */
async function rampCheck() {
// The pixel pass leaves craft switched off, and a craft that is not drawn
// records nothing to read back.
await page.evaluate(() => window.cosminova.setView('craft', true));
const ramp = await page.evaluate(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const sample = async (radii) => {
    window.cosminova.lookAtCraft('iss', radii);
    for (let i = 0; i < 6; i++) await frame();
    const d = window.cosminova.craftDetail('iss');
    return { radii, apparent: d.apparent, alpha: d.markerAlpha, meshFade: d.meshFade };
  };
  const out = [];
  for (const r of [400000, 40000, 4000, 1200, 600, 300, 60]) out.push(await sample(r));
  return out;
});
console.log('\n  ISS, coming in:');
for (const s of ramp) {
  console.log(
    `    ${String(s.radii).padStart(6)} radii  ${s.apparent.toFixed(3).padStart(9)} px` +
      `  marker ${s.alpha.toFixed(3)}  mesh ${s.meshFade.toFixed(2)}`,
  );
}
const rising = ramp.filter((s) => s.meshFade < 0.01);
let backwards = 0;
for (let i = 1; i < rising.length; i++) {
  if (rising[i].alpha < rising[i - 1].alpha - 1e-6) backwards++;
}
check(
  backwards === 0 && rising[rising.length - 1].alpha > rising[0].alpha + 0.01,
  'the marker brightens as the craft is approached',
  `${rising[0].alpha.toFixed(3)} to ${rising[rising.length - 1].alpha.toFixed(3)} over ${rising.length} steps`,
);
check(
  ramp[ramp.length - 1].meshFade > 0.99 && ramp[ramp.length - 1].alpha < 0.01,
  'and gives way to the mesh at the end',
  `mesh ${ramp[ramp.length - 1].meshFade.toFixed(2)}, marker ${ramp[ramp.length - 1].alpha.toFixed(3)}`,
);
}

/* ---- and what it looks like ----------------------------------------------- */

/** Per-pixel brightness as the strongest channel rather than a luma mix: a
    marker is tinted, and a blue one would otherwise read as dimmer than an
    amber one of the same intensity. */
async function levels(buffer) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * info.channels;
    out[i] = Math.max(data[o], data[o + 1], data[o + 2]);
  }
  return out;
}
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);

/*
 * Earth from 40 radii and nowhere else. Views further out were tried and
 * dropped: their craft pixel counts swung between about a hundred and about
 * ten thousand across identical runs, so any verdict from them was a coin
 * toss. This one repeats to within a few pixels.
 *
 * Worth knowing what this does and does not buy. Run against the old constant
 * brightness it still passes here — craft came 68 against a bright star's 136
 * from this particular spot — because the glare showed itself further out,
 * which is exactly where the frame stopped being repeatable. So this is a
 * guard against craft blowing out a frame and a picture to look at, and the
 * numbers above are what actually catch the fault coming back.
 */
await page.evaluate(() => window.cosminova.setView('craft', true));
await new Promise((r) => setTimeout(r, 900));
const withCraft = await page.screenshot({ type: 'png' });
await page.evaluate(() => window.cosminova.setView('craft', false));
await new Promise((r) => setTimeout(r, 900));
const without = await page.screenshot({ type: 'png' });
fs.writeFileSync(path.join(OUT, 'earth-40-craft.png'), withCraft);
fs.writeFileSync(path.join(OUT, 'earth-40-bare.png'), without);

const a = await levels(withCraft);
const b = await levels(without);
const craftPx = [];
const starPx = [];
for (let i = 0; i < a.length; i++) {
  // Craft: what appeared when they were switched on. Stars: lit pixels of the
  // bare frame, less anything a craft later covered, so a marker sitting on a
  // star cannot be counted as one.
  if (a[i] - b[i] > 6) craftPx.push(a[i]);
  else if (b[i] > 6) starPx.push(b[i]);
}
craftPx.sort((x, y) => x - y);
starPx.sort((x, y) => x - y);

if (!craftPx.length) {
  check(false, 'craft are on screen at all', 'no pixels changed when craft were switched on');
} else {
  const craftTypical = pct(craftPx, 0.9);
  const starBright = pct(starPx, 0.99);
  console.log(
    `\nEarth from 40 radii — ${craftPx.length} craft px, ${starPx.length} star px\n` +
      `  craft: peak ${craftPx[craftPx.length - 1]}, 90th ${craftTypical}\n` +
      `  stars: peak ${starPx[starPx.length - 1]}, 99th ${starBright}, median ${pct(starPx, 0.5)}`,
  );
  check(
    craftTypical <= starBright,
    'craft sit within the star field rather than above it',
    `craft 90th ${craftTypical} against star 99th ${starBright}`,
  );
}

await rampCheck();

console.log(`\nframes in ${path.resolve(OUT)}`);
console.log(failures ? `\n${failures} failed` : '\nall passed');

await browser.close();
process.exit(failures ? 1 : 0);
