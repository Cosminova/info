/**
 * The screenshots the Mac App Store listing is built from.
 *
 * Same idea as site-stills.mjs and the same camera vocabulary, with three
 * things the store asks for that the website does not:
 *
 *   - An exact pixel size. Apple accepts 1280x800, 1440x900, 2560x1600 and
 *     2880x1800 and nothing else, and a file one pixel out is refused on
 *     upload. 2880x1800 is the retina option, so it is the one worth shooting.
 *   - A caption per frame. Nobody reads the description; they swipe the
 *     gallery. Each frame therefore has to make one claim on its own, in a
 *     handful of words, over a picture that demonstrates it.
 *   - No interface. The panels are how the app is used but they are not what
 *     it looks like, and at gallery size they turn into grey speckle. The
 *     captions carry the features instead.
 *
 * The compositions are lifted from the website's own stills rather than found
 * again, because those were already swept for the framing that reads (see
 * scripts/_frame-probe.mjs). What is tuned here is only the crop: these are
 * 16:10 where the hero images are 16:9.
 *
 * Usage: node scripts/store-shots.mjs [name ...]
 *        COSMINOVA_URL=http://127.0.0.1:5179/ (a server must be running)
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** One of Apple's four accepted Mac sizes. Not negotiable, and not resized after. */
const WIDTH = 2880;
const HEIGHT = 1800;

const OUT = path.resolve('shots/store');

/**
 * Order matters more than it looks: the store shows the first two frames in
 * search results and on the product page before anyone scrolls, so the two
 * strongest claims go first and the rest support them.
 *
 * `caption` is capped at five words by the check below. It is a limit worth
 * keeping — the frame is the argument, and the words are only there to say
 * which argument it is.
 */
const SHOTS = [
  {
    name: '1-saturn',
    caption: 'Fly to any world',
    sun: { key: 'saturn', distanceRadii: 4.2, phaseDeg: 45, tiltDeg: 26 },
    detail: 'saturn',
    fov: 40,
  },
  {
    name: '2-moon',
    caption: 'Measured relief, real craters',
    // Low orbit at a grazing sun rather than stood on the surface. Standing on
    // it was the obvious choice and it photographs badly: from half a kilometre
    // up the horizon is close, most of the frame is unlit ground, and the
    // shadows that show the relief is measured fall outside the crop. From 1.06
    // radii the terminator crosses the whole frame and every crater in it is
    // raking. See the try-moon-high variant in the history for the other one.
    sun: { key: 'moon', distanceRadii: 1.06, phaseDeg: 62, tiltDeg: 8 },
    detail: 'moon',
    fov: 44,
  },
  {
    name: '3-black-hole',
    caption: 'Watch gravity bend light',
    hole: { key: 'm87-star', distanceRadii: 30 },
    fov: 38,
  },
  {
    name: '4-earth-sunset',
    caption: 'Stand under any sky',
    stand: { body: 'earth', sunElevationDeg: 0.5, altitudeKm: 2.5, viewElevationDeg: 7 },
    detail: 'earth',
    fov: 58,
  },
  {
    // The blue glow around the Martian sun is the point of this one, and it is
    // small in the frame: 44 degrees rather than the website's 58, with the sun
    // just above the horizon instead of just below it. Wider and lower, the
    // glow is a few dozen pixels and the claim is invisible.
    name: '5-mars',
    caption: 'Skies computed, not painted',
    stand: { body: 'mars', sunElevationDeg: 0.2, altitudeKm: 4, viewElevationDeg: 3 },
    detail: 'mars',
    fov: 44,
  },
  {
    name: '6-hubble',
    caption: 'Ride real spacecraft trajectories',
    craft: { key: 'hubble', distanceRadii: 4.5, tiltDeg: 14 },
    fov: 40,
  },
  {
    // Saturn again, and deliberately: frame one is the whole planet from four
    // radii, this is the cloud tops from under two, and between them they are
    // the range the app is for. The alternative was another body for variety's
    // sake — Titan and Pluto were both shot for this slot and both came back
    // with artefacts (texture seams and a polar fan), and TRAPPIST-1 e was so
    // close to frame four that the two read as one picture twice.
    name: '7-saturn-close',
    caption: 'Closer, with no scale change',
    sun: { key: 'saturn', distanceRadii: 1.9, phaseDeg: 38, tiltDeg: 2 },
    detail: 'saturn',
    fov: 46,
  },
  {
    name: '8-jupiter',
    caption: 'Wind time, watch eclipses',
    sun: { key: 'jupiter', distanceRadii: 3.4, phaseDeg: 42, tiltDeg: 12 },
    detail: 'jupiter',
    fov: 40,
  },
  {
    // Sirius was here and went: a white disc on black is a fine picture of a
    // star and a poor advertisement, and "search 119,625 stars" is a claim
    // about a text field that no photograph of one star can make. The Sun at
    // eight radii at least has granulation and a limb in it.
    name: '9-sun',
    caption: "Approach a star's surface",
    look: { key: 'sun', distanceRadii: 8 },
    fov: 34,
  },
];

/* The cap is the point of the caption, so it is enforced rather than trusted. */
const tooLong = SHOTS.filter((s) => s.caption.trim().split(/\s+/).length > 5);
if (tooLong.length) {
  console.error('captions over five words:');
  for (const s of tooLong) console.error(`  ${s.name}: "${s.caption}"`);
  process.exit(1);
}

const only = process.argv.slice(2);
const wanted = SHOTS.filter((s) => !only.length || only.includes(s.name));
if (!wanted.length) {
  console.error(`nothing matches ${only.join(' ')}`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    '--hide-scrollbars',
    '--mute-audio',
    `--window-size=${WIDTH},${HEIGHT}`,
  ],
});
const problems = [];

/**
 * A page per shot, rather than one page walked through all nine.
 *
 * Nine bodies at full detail into one renderer at 2880x1800 exhausts the GPU
 * and takes the tab with it — reliably, on the fourth shot. A page is its own
 * process, so closing it hands the textures back, and the twelve seconds the
 * app takes to boot again is cheaper than a run that dies halfway.
 */
async function openPage() {
  const page = await browser.newPage();
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });

  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });

  await page.evaluate(() => {
    const sv = window.cosminova;
    sv.setRate(0);
    sv.setDate(new Date('2026-03-20T17:00:00Z'));
    sv.setUiVisible(false);
    for (const key of ['trajectories', 'craftVectors', 'distantMarkers']) sv.setView(key, false);
    for (const key of ['labelPlanets', 'labelStars', 'labelGalaxies', 'labelBlackHoles', 'labelCraft', 'labelExo']) {
      sv.setView(key, false);
    }
    sv.setQuality?.('ultra') ?? sv.quality?.setPreset?.('ultra');
  });

  return page;
}

/**
 * The caption, drawn in the page rather than composited afterwards so it picks
 * up the app's own type and renders at the same subpixel quality as everything
 * else in the frame.
 *
 * The scrim is doing real work: these frames run from a black starfield to a
 * blown-out solar limb, and white text with no ground under it is illegible on
 * about half of them. A gradient rather than a bar so there is no visible edge
 * across the picture.
 */
async function drawCaption(page, text) {
  await page.evaluate((caption) => {
    document.getElementById('store-caption')?.remove();
    const el = document.createElement('div');
    el.id = 'store-caption';
    el.innerHTML = `
      <div class="store-caption__scrim"></div>
      <div class="store-caption__text">${caption}</div>
    `;
    const style = document.createElement('style');
    style.textContent = `
      #store-caption {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
      }
      .store-caption__scrim {
        position: absolute;
        left: 0; right: 0; bottom: 0;
        height: 30%;
        background: linear-gradient(to top, rgba(2,4,10,0.88) 0%, rgba(2,4,10,0.55) 42%, rgba(2,4,10,0) 100%);
      }
      .store-caption__text {
        position: absolute;
        left: 0; right: 0; bottom: 122px;
        text-align: center;
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
        font-size: 78px;
        font-weight: 500;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: #f2f5ff;
        text-shadow: 0 2px 40px rgba(0,0,0,0.7);
      }
    `;
    el.appendChild(style);
    document.body.appendChild(el);
  }, text);
}

/** Waits for terrain patches to stop arriving, so nothing is caught half-built. */
async function settle(page, { minMs = 2500, maxMs = 30000 } = {}) {
  const started = Date.now();
  let last = -1;
  let stable = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 60));
    const patches = await page.evaluate(() => window.cosminova.stats().patches);
    if (patches === last) stable++;
    else {
      stable = 0;
      last = patches;
    }
    const waited = Date.now() - started;
    if (stable >= 3 && waited >= minMs) return;
    if (waited >= maxMs) return;
  }
}

/**
 * Enough of the frame to know it is a photograph.
 *
 * `lit` catches the black rectangle, which is what a refused camera state or an
 * unfinished shader produces, and `mean` catches the opposite — a frame filled
 * by a solar limb has nothing in it either.
 */
async function levels(file) {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let lit = 0;
  for (const v of data) {
    sum += v;
    if (v > 12) lit++;
  }
  return { mean: sum / data.length, lit: lit / (info.width * info.height), info };
}

const written = [];
for (const shot of wanted) {
  const page = await openPage();

  if (shot.exo) {
    // Built on demand: there is no surface to stand on until it exists.
    await page.evaluate((key) => window.cosminova.target(key), shot.exo);
    await page.waitForFunction(
      (key) => Boolean(window.cosminova.standAt(key, { sunElevationDeg: 2, altitudeKm: 10 })),
      { timeout: 180000 },
      shot.exo,
    );
  }
  if (shot.detail) await page.evaluate((b) => window.cosminova.loadDetail(b), shot.detail);

  const placed = await page.evaluate((s) => {
    const sv = window.cosminova;
    const c = sv.controls;
    c.stopFlight();
    c.cruise = 0;
    c.zoomVelocity = 0;
    c.yawVelocity = 0;
    c.pitchVelocity = 0;

    sv.setView('craft', Boolean(s.craft));

    if (s.stand) {
      const { body, ...options } = s.stand;
      if (!sv.standAt(body, { ...options, fov: s.fov })) return `standAt(${body}) refused`;
      return null;
    }
    if (s.hole) {
      sv.setView('blackHoles', true);
      sv.lookAtBlackHole(s.hole.key, s.hole.distanceRadii);
      c.fov = s.fov;
      return null;
    }
    if (s.craft) {
      if (!sv.lookAtCraft(s.craft.key, s.craft.distanceRadii, s.craft.tiltDeg)) {
        return `lookAtCraft(${s.craft.key}) refused`;
      }
      c.fov = s.fov;
      return null;
    }
    if (s.sun) {
      sv.lookFromSun(s.sun.key, s.sun.distanceRadii, s.sun.phaseDeg, s.sun.tiltDeg);
      c.fov = s.fov;
      return null;
    }
    sv.target(s.look.key, s.look.distanceRadii, s.look.options);
    c.stopFlight();
    c.distanceRadii = s.look.distanceRadii;
    c.fov = s.fov;
    return null;
  }, shot);

  if (placed) {
    console.log(`  ${shot.name.padEnd(16)} SKIPPED — ${placed}`);
    await page.close();
    continue;
  }

  await settle(page, shot.stand ? { minMs: 5000, maxMs: 60000 } : {});
  await drawCaption(page, shot.caption);

  const file = path.join(OUT, `${shot.name}.png`);
  await page.screenshot({ path: file });
  await page.close();

  const { mean, lit, info } = await levels(file);
  const sizeOk = info.width === WIDTH && info.height === HEIGHT;
  const warn = !sizeOk
    ? `  ← ${info.width}x${info.height}, WRONG SIZE`
    : lit < 0.02
      ? '  ← nearly empty'
      : mean > 200
        ? '  ← blown out'
        : '';
  written.push({ ...shot, file, mean, lit, sizeOk });
  console.log(
    `  ${shot.name.padEnd(16)} ${(fs.statSync(file).size / 1024 / 1024).toFixed(1).padStart(4)} MB` +
      `  ${info.width}x${info.height}  mean ${mean.toFixed(0).padStart(3)}` +
      `  lit ${(lit * 100).toFixed(0).padStart(3)}%  "${shot.caption}"${warn}`,
  );
}

/* A sheet, because the only way to know a gallery works is to see it as one. */
if (written.length) {
  const COLUMNS = 3;
  const cellW = 640;
  const cellH = Math.round((cellW * HEIGHT) / WIDTH);
  const rows = Math.ceil(written.length / COLUMNS);
  const tiles = await Promise.all(
    written.map(async (s, i) => ({
      input: await sharp(s.file).resize(cellW, cellH).jpeg({ quality: 86 }).toBuffer(),
      left: (i % COLUMNS) * cellW,
      top: Math.floor(i / COLUMNS) * cellH,
    })),
  );
  const sheet = path.join(OUT, 'contact-sheet.jpg');
  await sharp({
    create: {
      width: COLUMNS * cellW,
      height: rows * cellH,
      channels: 3,
      background: { r: 6, g: 8, b: 14 },
    },
  })
    .composite(tiles)
    .jpeg({ quality: 88 })
    .toFile(sheet);
  console.log(`\ncontact sheet: ${sheet}`);
}

const bad = written.filter((s) => !s.sizeOk || s.lit < 0.02 || s.mean > 200);
console.log(`\n${written.length} frames in ${OUT}`);
if (bad.length) {
  console.error(`${bad.length} need another look: ${bad.map((s) => s.name).join(', ')}`);
  process.exitCode = 1;
}
if (problems.length) {
  console.error(`\n${problems.length} console problems:`);
  for (const p of [...new Set(problems)].slice(0, 5)) console.error(`  ! ${p}`);
  process.exitCode = 1;
} else {
  console.log('no console errors');
}

await browser.close();
