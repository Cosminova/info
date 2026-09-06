/**
 * The still images the website is built from.
 *
 * Kept as a script rather than a folder of exported images because the shots
 * are camera states: if the sky or the star colours change, the site should be
 * able to catch up by being run again. Nothing here is retouched, and the
 * captions on the page are only allowed to claim what these frames show.
 *
 * Three formats, because the page asks three different things of a picture:
 *
 *   hero     16:9, full bleed behind the title, cycled as a slideshow. Wide
 *            because it is cropped hard on a phone and needs the headroom.
 *   feature  3:2, paired with a paragraph in the engine section. Landscape,
 *            since each one sits beside text rather than above it.
 *   gallery  4:5, tiled in a grid. Tall enough to keep the sense of standing
 *            under a sky, short enough to tile without its own scroll.
 *
 * Every run also writes a contact sheet per format, because the only way to
 * know whether a camera state produced a photograph or a black rectangle is to
 * look at it.
 *
 * Usage: node scripts/site-stills.mjs [hero|feature|gallery|...]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const GROUPS = {
  // 1600 rather than 1920: it is a background behind a scrim and a title, it
  // is the first thing on the critical path, and the difference is invisible
  // once it is covered but plainly visible in the page weight.
  hero: { dir: 'site/assets/hero', w: 1600, h: 900, quality: 78 },
  feature: { dir: 'site/assets/feature', w: 1400, h: 933, quality: 84 },
  gallery: { dir: 'site/assets/shots', w: 1000, h: 1250, quality: 88 },
};

/**
 * Each shot is a place to stand or a thing to look at.
 *
 * `look` frames a body from the sun side, so the disc carries a terminator
 * rather than arriving flat and fully lit — a phase angle is what makes a
 * planet read as a sphere. `stand` puts the camera on the surface.
 */
const SHOTS = [
  /* ---------------------------------------------------------------- hero */

  // Opens on the black hole. It is the least familiar thing in the app and the
  // one nobody expects a browser to be drawing, so it earns the first frame.
  // M87 rather than Sagittarius A* because it comes with a jet, which is what
  // makes it read as a black hole rather than as a bright smear.
  //
  // Around thirty Schwarzschild radii, which is a compromise the other black
  // hole shots do not have to make. Closer, at twenty, the lensed disc fills
  // the whole frame with pale grey and the shadow stops reading as a shape —
  // fine as a picture on its own, but this one sits behind white type. Much
  // further out and it is a smudge in an empty frame. See
  // scripts/_frame-probe.mjs for the sweep.
  { group: 'hero', name: 'm87', hole: { key: 'm87-star', distanceRadii: 30 }, fov: 38 },
  // Then the two the solar system is famous for. Saturn at a high sun and a
  // rolled tilt is the one composition that gets the ring shadow onto the globe
  // and the globe's shadow into the rings, which is the whole point of it.
  { group: 'hero', name: 'saturn', sun: { key: 'saturn', distanceRadii: 4.2, phaseDeg: 45, tiltDeg: 26 }, detail: 'saturn', fov: 40 },
  { group: 'hero', name: 'jupiter', sun: { key: 'jupiter', distanceRadii: 3.4, phaseDeg: 42, tiltDeg: 12 }, detail: 'jupiter', fov: 40 },
  // A crescent Earth, for the atmosphere on the limb. Not closer than about
  // three and a half radii: inside that the globe overflows the frame and the
  // disc is cut off by the right edge rather than being framed by it.
  { group: 'hero', name: 'earth', sun: { key: 'earth', distanceRadii: 3.6, phaseDeg: 68, tiltDeg: 10 }, detail: 'earth', fov: 44 },
  { group: 'hero', name: 'the-sun', look: { key: 'sun', distanceRadii: 8 }, fov: 34 },
  // Sirius rather than Betelgeuse, which came back a flat beige disc at every
  // distance tried. A blue star also sets off the Sun's orange, and the pair
  // is the point: these are catalogue colours, not decoration.
  { group: 'hero', name: 'sirius', look: { key: 'star:Sirius', distanceRadii: 14 }, fov: 30 },
  // Ground level, because everything above it is a view from space and the
  // point of the app is that you can also be standing on the thing.
  //
  // Earth rather than Mars here. The Martian dusk is the better photograph on
  // its own, but as a hero it puts its one bright band directly behind the
  // title and leaves the lower two thirds featureless dark ground, and the
  // scrim then crushes what little there was. Earth at a low sun fills the
  // frame with graded sky instead. Mars keeps its slot in the gallery.
  { group: 'hero', name: 'earth-ground', stand: { body: 'earth', sunElevationDeg: 0.6, altitudeKm: 2.5, viewElevationDeg: 7 }, detail: 'earth', fov: 58 },

  /* ------------------------------------------------------------- feature */

  // One per claim in the engine section, each showing the specific thing its
  // paragraph asserts rather than being decoration next to it.
  //
  // Hubble is the only craft here. JWST was shot too, and its sunshield lit
  // face-on reads as a blank white card with a dark speck on it — accurate,
  // and useless as a photograph.
  { group: 'feature', name: 'scale', sun: { key: 'saturn', distanceRadii: 7.5, phaseDeg: 32, tiltDeg: 20 }, detail: 'saturn', fov: 42 },
  // Low sun on purpose: relief is invisible at noon and obvious at grazing
  // incidence, and this surface is measured altimetry rather than noise.
  { group: 'feature', name: 'surface', stand: { body: 'moon', sunElevationDeg: 3.5, altitudeKm: 0.6, viewElevationDeg: 1 }, detail: 'moon', fov: 52 },
  { group: 'feature', name: 'atmosphere', stand: { body: 'mars', sunElevationDeg: -0.5, altitudeKm: 4, viewElevationDeg: 6 }, detail: 'mars', fov: 58 },
  { group: 'feature', name: 'stars', look: { key: 'star:Sirius', distanceRadii: 14 }, fov: 30 },
  { group: 'feature', name: 'gravity', hole: { key: 'sgr-a', distanceRadii: 26 }, fov: 38 },
  { group: 'feature', name: 'craft', craft: { key: 'hubble', distanceRadii: 4.5, tiltDeg: 14 }, fov: 40 },
  { group: 'feature', name: 'time', sun: { key: 'jupiter', distanceRadii: 5.5, phaseDeg: 28, tiltDeg: 6 }, detail: 'jupiter', fov: 40 },

  /* ------------------------------------------------------------- gallery */

  { group: 'gallery', name: 'earth-sunset', stand: { body: 'earth', sunElevationDeg: 0.5, altitudeKm: 2.5, viewElevationDeg: 7 }, detail: 'earth', fov: 58 },
  { group: 'gallery', name: 'earth-dusk', stand: { body: 'earth', sunElevationDeg: -3.2, altitudeKm: 2.5, viewElevationDeg: 4 }, detail: 'earth', fov: 55 },
  { group: 'gallery', name: 'mars-sunset', stand: { body: 'mars', sunElevationDeg: -0.5, altitudeKm: 4, viewElevationDeg: 6 }, detail: 'mars', fov: 58 },
  // Stood on from far higher than the solar system worlds, and the reason is
  // the relief. This surface is invented rather than measured, and the
  // procedural terrain runs to tens of kilometres; from anywhere close to it
  // the frame fills with the undersides of the terrain patches, a lit lattice
  // above the horizon. It fades as the horizon drops away, and 70 km is where
  // it stops showing — see scripts/_exo-altitude.mjs.
  {
    group: 'gallery',
    name: 'trappist-1e',
    stand: { body: 'exo:trappist-1-e', sunElevationDeg: 1, altitudeKm: 70, viewElevationDeg: 8 },
    exo: 'exo:trappist-1-e',
    detail: 'trappist-1-e',
    fov: 58,
  },
  { group: 'gallery', name: 'the-sun', look: { key: 'sun', distanceRadii: 8 }, fov: 34 },
  { group: 'gallery', name: 'sirius', look: { key: 'star:Sirius', distanceRadii: 14 }, fov: 30 },
  // Further out than the hero's, because the lensed disc is a wide ellipse and
  // a 4:5 frame would otherwise cut both ends off it.
  { group: 'gallery', name: 'sagittarius-a', hole: { key: 'sgr-a', distanceRadii: 34 }, fov: 38 },
  // Added for the refreshed grid: the two giants as portraits, a measured
  // lunar surface, and the hole with a jet.
  { group: 'gallery', name: 'saturn', sun: { key: 'saturn', distanceRadii: 4.2, phaseDeg: 45, tiltDeg: 26 }, detail: 'saturn', fov: 40 },
  { group: 'gallery', name: 'jupiter', sun: { key: 'jupiter', distanceRadii: 3.2, phaseDeg: 40, tiltDeg: 10 }, detail: 'jupiter', fov: 40 },
  { group: 'gallery', name: 'moon-surface', stand: { body: 'moon', sunElevationDeg: 3.5, altitudeKm: 0.6, viewElevationDeg: 1 }, detail: 'moon', fov: 52 },
  { group: 'gallery', name: 'earth-crescent', sun: { key: 'earth', distanceRadii: 4.4, phaseDeg: 75, tiltDeg: 12 }, detail: 'earth', fov: 40 },
  { group: 'gallery', name: 'm87', hole: { key: 'm87-star', distanceRadii: 34 }, fov: 38 },
];

const only = process.argv.slice(2);
const wanted = SHOTS.filter((s) => !only.length || only.includes(s.group) || only.includes(s.name));
if (!wanted.length) {
  console.error(`nothing matches ${only.join(' ')}`);
  process.exit(1);
}

for (const group of new Set(wanted.map((s) => s.group))) {
  fs.mkdirSync(GROUPS[group].dir, { recursive: true });
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
});
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(m.text());
});

await page.setViewport({ ...sizeOf(wanted[0].group), deviceScaleFactor: 1 });
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });

await page.evaluate(() => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.setDate(new Date('2026-03-20T17:00:00Z'));
  sv.setUiVisible(false);
  // Navigation aids: useful in the app, clutter in a photograph.
  for (const key of ['trajectories', 'craftVectors', 'distantMarkers']) sv.setView(key, false);
  for (const key of ['labelPlanets', 'labelStars', 'labelGalaxies', 'labelBlackHoles', 'labelCraft', 'labelExo']) {
    sv.setView(key, false);
  }
  sv.setQuality?.('ultra') ?? sv.quality?.setPreset?.('ultra');
});

function sizeOf(group) {
  const { w, h } = GROUPS[group];
  return { width: w, height: h };
}

/**
 * Terrain arrives over several frames and textures upgrade behind it, so a
 * capture taken on arrival records the low-detail version. Waits for the patch
 * count to stop moving.
 */
async function settle({ minMs = 2500, maxMs = 30000 } = {}) {
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

/** Mean level and the share of pixels with anything in them, to catch a black frame. */
async function levels(file) {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let lit = 0;
  for (const v of data) {
    sum += v;
    if (v > 12) lit++;
  }
  return { mean: sum / data.length, lit: lit / (info.width * info.height) };
}

const shotsByGroup = new Map();
let currentGroup = null;

for (const shot of wanted) {
  if (shot.group !== currentGroup) {
    currentGroup = shot.group;
    await page.setViewport({ ...sizeOf(currentGroup), deviceScaleFactor: 1 });
    await settle({ minMs: 800, maxMs: 8000 });
  }

  if (shot.exo) {
    // Built on demand, so it has to be asked for and waited on before there is
    // a surface to stand on.
    await page.evaluate((key) => window.cosminova.target(key), shot.exo);
    await page.waitForFunction(
      (key) => Boolean(window.cosminova.standAt(key, { sunElevationDeg: 2, altitudeKm: 10 })),
      { timeout: 120000 },
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

    // Craft are only drawn when their layer is on, and only this shot wants it.
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
    sv.target(s.look.key, s.look.distanceRadii);
    c.stopFlight();
    c.distanceRadii = s.look.distanceRadii;
    c.fov = s.fov;
    return null;
  }, shot);

  const { dir, quality } = GROUPS[shot.group];
  const file = path.join(dir, `${shot.name}.jpg`);

  if (placed) {
    console.log(`  ${shot.group.padEnd(8)} ${shot.name.padEnd(16)} SKIPPED — ${placed}`);
    continue;
  }

  await settle(shot.stand ? { minMs: 5000, maxMs: 45000 } : {});
  await page.screenshot({ path: file, type: 'jpeg', quality });

  const { mean, lit } = await levels(file);
  const kb = fs.statSync(file).size / 1024;
  const warn = lit < 0.02 ? '  ← nearly empty' : mean > 200 ? '  ← blown out' : '';
  console.log(
    `  ${shot.group.padEnd(8)} ${shot.name.padEnd(16)} ${kb.toFixed(0).padStart(5)} KB` +
      `   mean ${mean.toFixed(0).padStart(3)}   lit ${(lit * 100).toFixed(0).padStart(3)}%${warn}`,
  );

  if (!shotsByGroup.has(shot.group)) shotsByGroup.set(shot.group, []);
  shotsByGroup.get(shot.group).push({ name: shot.name, file });
}

/* A sheet per format, so every frame can be judged next to its siblings. */
const SHEET_W = 320;
for (const [group, shots] of shotsByGroup) {
  const { w, h } = GROUPS[group];
  const cellH = Math.round((SHEET_W * h) / w);
  const columns = Math.min(4, shots.length);
  const rows = Math.ceil(shots.length / columns);
  const tiles = await Promise.all(
    shots.map(async (s, i) => ({
      input: await sharp(s.file).resize(SHEET_W, cellH).jpeg({ quality: 82 }).toBuffer(),
      left: (i % columns) * SHEET_W,
      top: Math.floor(i / columns) * cellH,
    })),
  );
  const sheet = path.resolve(`shots/site-${group}-sheet.jpg`);
  fs.mkdirSync(path.dirname(sheet), { recursive: true });
  await sharp({
    create: {
      width: columns * SHEET_W,
      height: rows * cellH,
      channels: 3,
      background: { r: 8, g: 10, b: 16 },
    },
  })
    .composite(tiles)
    .jpeg({ quality: 84 })
    .toFile(sheet);
  console.log(`\ncontact sheet: ${sheet}  (${shots.map((s) => s.name).join(', ')})`);
}

console.log(problems.length ? `\n${problems.length} console problems:` : '\nno console errors');
for (const p of problems.slice(0, 5)) console.log(`  ! ${p}`);

await browser.close();
