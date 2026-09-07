/**
 * Is anything in the sky besides the thing you came to see?
 *
 * Reported as three complaints that turned out to be one: standing at Saturn or
 * at one of its moons you could no longer see Saturn or the Sun, a host star
 * was not visible from its own exoplanets, and a black hole was not visible
 * from the stars and worlds put in orbit around it.
 *
 * Two separate causes. Arrival framing came in along the line joining a moon to
 * its planet, which is the one direction that hides the planet behind the moon.
 * And every light source was drawn at the size of its own disc, so once a star
 * was too small to resolve its light shrank away with it — the Sun came out a
 * grey speck from Earth and nothing at all from Saturn, and a stellar-mass
 * hole, whose whole rendered volume is a few thousand kilometres across, drew
 * nothing whatever from a couple of hundred au.
 *
 * So each case is travelled to the way a person travels to it, and the frame is
 * measured where the thing that should be visible lands: is it drawn, is it on
 * screen, and are those pixels actually bright. Reading the scene graph alone
 * would have passed all of this — the Sun was always "there".
 *
 * Usage: node scripts/sky-check.mjs
 */
import sharp from 'sharp';
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIDTH = 900;
const HEIGHT = 560;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  // The hardware backend, deliberately: under software rasterisation the
  // additively blended glare that most of this file is about comes out dark.
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: WIDTH, height: HEIGHT },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${URL}?home=0`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.cosminova?.ready === true, { timeout: 180000 });
await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setUiVisible(false);
});

let failures = 0;
const report = (ok, label, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
};

/** Travel there and wait out the flight. */
async function travelTo(key) {
  await page.evaluate((k) => window.cosminova.travel(k), key);
  await new Promise((r) => setTimeout(r, 5200));
}

/**
 * Where a thing landed on screen, and whether it is being drawn.
 *
 * Named bodies are found by group name; the Sun, host stars and holes have no
 * name, so they are found by what they are: the sphere of a known radius, or
 * the glare billboard hung at the same point.
 */
/**
 * Every star shares a photosphere of the same radius and every hole the same
 * glare billboard, so a match on shape alone can land in another system
 * entirely. The nearest one is the one being asked about.
 */
const NEAREST = `(api, query) => {
  const V = () => new api.camera.position.constructor();
  const here = api.camera.getWorldPosition(V());
  let node = null;
  let best = Infinity;
  api.scene.traverse((child) => {
    const hit = (query.sun && child === api.sun.group)
      || (query.name && child.name === query.name)
      || (query.sphereKm && child.geometry?.type === 'SphereGeometry'
        && Math.abs(child.geometry.parameters.radius - query.sphereKm) < query.sphereKm * 0.02)
      // A hole's glare is the billboard with no photosphere behind it, which is
      // what tells it apart from a star's corona.
      || (query.glare && child.geometry?.type === 'PlaneGeometry'
        && child.material?.uniforms?.uColour && !child.material.uniforms.uDiscFraction);
    if (!hit) return;
    const km = child.getWorldPosition(V()).distanceTo(here);
    if (km < best) { best = km; node = child; }
  });
  return node;
}`;

const findInSky = (what) => page.evaluate((query, source) => {
  const api = window.cosminova;
  const camera = api.camera;
  const V = () => new camera.position.constructor();
  // eslint-disable-next-line no-new-func
  const node = new Function(`return ${source}`)()(api, query);
  if (!node) return null;
  let drawn = node.visible;
  for (let p = node.parent; p; p = p.parent) drawn = drawn && p.visible;
  const world = node.getWorldPosition(V());
  const ndc = world.clone().project(camera);
  // Anything this far off projects to a depth of exactly one whether it is in
  // front or behind, and a point behind the camera comes back mirrored through
  // the centre, so which side it is on has to be asked of the view vector.
  const toward = world.clone().sub(camera.getWorldPosition(V())).normalize();
  const ahead = toward.dot(camera.getWorldDirection(V())) > 0;
  return {
    drawn,
    km: world.length(),
    x: (ndc.x * 0.5 + 0.5) * 900,
    y: (0.5 - ndc.y * 0.5) * 560,
    onScreen: ahead && Math.abs(ndc.x) < 0.98 && Math.abs(ndc.y) < 0.96,
  };
}, what, NEAREST);

/**
 * Stand off a body and turn until the thing lighting it is in frame.
 *
 * Which means looking at its night side, since a light source and a lit face
 * cannot both be in front of you. Twenty-eight degrees off the light puts it
 * inside the frame beside the body rather than hidden behind it.
 */
const faceLight = (key, radii, query) => page.evaluate(async (args, source) => {
  const api = window.cosminova;
  const V = () => new api.camera.position.constructor();
  api.target(args.key, args.radii);
  // The camera only moves on the next frame, and asking which way the light is
  // from where it used to be aims at nothing.
  await new Promise((r) => setTimeout(r, 700));
  // eslint-disable-next-line no-new-func
  const node = new Function(`return ${source}`)()(api, args.query);
  if (!node) return false;
  // The light is astronomically further off than the standoff distance, so its
  // direction from the camera and from the body are the same direction.
  const toLight = node.getWorldPosition(V()).sub(api.camera.getWorldPosition(V())).normalize();
  const away = toLight.clone().negate().applyAxisAngle(new (V().constructor)(0, 1, 0), 0.49);
  api.target(args.key, args.radii, {
    yaw: Math.atan2(away.x, away.z),
    pitch: Math.asin(Math.max(-1, Math.min(1, away.y))),
  });
  return true;
}, { key, radii, query }, NEAREST);

/**
 * Brightest pixel in a box around a point, 0 to 1, and where it sat.
 *
 * The box is generous and the peak is searched for rather than sampled at the
 * centre: a projected position is a frame or two stale by the time the shot is
 * taken, and a ten-pixel glare measured at a thirty-pixel offset reads as
 * nothing at all — which is how this check first told itself the fix had not
 * worked when it had.
 */
/**
 * The frame as drawn, read off the canvas rather than through a page shot.
 *
 * The drawing buffer is thrown away once the browser has composited it, so an
 * ordinary screenshot hands back an empty canvas and the page's own dark
 * background shows through. Read inside a frame callback — which runs after the
 * scene has drawn itself and before the buffer goes — it is the real frame.
 * Everything in this file read as unlit black until it was done this way.
 */
async function shoot(keep = null) {
  let png = null;
  // A shot asked for on a frame boundary catches the drawing buffer after the
  // browser has taken it and comes back empty, so these are taken between
  // frames and an empty one is retried rather than believed. Reading the canvas
  // directly is worse: it empties the buffer for everything after it.
  for (let attempt = 0; attempt < 6 && !png; attempt++) {
    await new Promise((r) => setTimeout(r, attempt ? 400 : 0));
    const shot = await page.screenshot();
    const { channels } = await sharp(shot).stats();
    if (Math.max(...channels.slice(0, 3).map((c) => c.max)) > 12) png = shot;
  }
  png ??= await page.screenshot();
  if (keep) await sharp(png).toFile(`shots/_sky-${keep}.png`);
  return png;
}

async function peakAt(where, box = 140, keep = null) {
  const png = await shoot(keep);
  // The canvas carries its own pixel count, which is not the window's.
  const { width, height } = await sharp(png).metadata();
  const x = (where.x / WIDTH) * width;
  const y = (where.y / HEIGHT) * height;
  const left = Math.round(Math.max(0, Math.min(width - box, x - box / 2)));
  const top = Math.round(Math.max(0, Math.min(height - box, y - box / 2)));
  const { data } = await sharp(png)
    .extract({ left, top, width: box, height: box })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = data.length / (box * box);
  let peak = 0;
  let at = [0, 0];
  for (let i = 0; i < box * box; i++) {
    const value = Math.max(data[i * channels], data[i * channels + 1], data[i * channels + 2]);
    if (value > peak) {
      peak = value;
      at = [(i % box) - box / 2, Math.floor(i / box) - box / 2];
    }
  }
  return { peak: peak / 255, offset: at };
}

console.log('\nstanding at a moon, is its planet in the sky:\n');
for (const [moon, planet, planetKm] of [['titan', 'saturn', 58232], ['europa', 'jupiter', 69911], ['iapetus', 'saturn', 58232]]) {
  await travelTo(moon);
  const found = await findInSky({ name: planet });
  const lit = found ? (await peakAt(found, 200)).peak : 0;
  report(
    Boolean(found?.drawn && found.onScreen && lit > 0.08),
    `${planet} from ${moon}`,
    found
      ? `${found.drawn ? 'drawn' : 'not drawn'}, ${found.onScreen ? 'in frame' : 'out of frame'}`
        + ` at ${Math.round(found.x)},${Math.round(found.y)}, brightest pixel ${lit.toFixed(2)}`
      : 'no such body in the scene',
  );
}

console.log('\nand is the Sun still findable out there:\n');
const SUN = { sun: true };
for (const key of ['earth', 'jupiter', 'saturn', 'titan', 'neptune', 'pluto']) {
  await faceLight(key, 6, SUN);
  await new Promise((r) => setTimeout(r, 2600));
  const found = await findInSky(SUN);
  const measured = found ? await peakAt(found, 140, key) : null;
  const peak = measured?.peak ?? 0;
  report(
    Boolean(found?.onScreen && peak > 0.5),
    `the Sun from ${key}`,
    found
      ? `at ${Math.round(found.x)},${Math.round(found.y)}, brightest pixel ${peak.toFixed(2)}`
        + ` ${measured.offset[0]},${measured.offset[1]} off where it was reckoned to be`
      : 'not in the scene',
  );
}

console.log('\nstanding at an exoplanet, is its host star in the sky:\n');
for (const [planet, host] of [['exo:trappist-1-e', 'star:TRAPPIST-1'], ['exo:kepler-452-b', 'star:Kepler-452']]) {
  await travelTo(planet);
  await faceLight(planet, 6, { name: host });
  await new Promise((r) => setTimeout(r, 2600));
  const found = await findInSky({ name: host });
  const found2 = found?.onScreen ? await peakAt(found) : null;
  const peak = found2?.peak ?? 0;
  report(
    Boolean(found?.drawn && found.onScreen && peak > 0.4),
    `${host} from ${planet.replace('exo:', '')}`,
    found
      ? `${found.drawn ? 'drawn' : 'not drawn'}, ${found.onScreen ? 'in frame' : 'out of frame'}`
        + `, brightest pixel ${peak.toFixed(2)}`
      : 'not in the scene',
  );
}

console.log('\nstanding at a world around a hole, is the hole in the sky:\n');
for (const [planet, holeName] of [
  ['exo:cygnus-x-1-gamma-b', 'Cygnus X-1'],
  ['exo:m87-alpha-b', 'M87*'],
  ['star:Cygnus X-1 gamma', 'Cygnus X-1'],
]) {
  await travelTo(planet);
  const aimed = await faceLight(planet, 6, { glare: true });
  await new Promise((r) => setTimeout(r, 2600));
  const found = aimed ? await findInSky({ glare: true }) : null;
  const found2 = found?.onScreen ? await peakAt(found) : null;
  const peak = found2?.peak ?? 0;
  report(
    Boolean(found && peak > 0.3),
    `${holeName} from ${planet.replace(/^(exo|star):/, '')}`,
    found
      ? `${found.drawn ? 'as a point' : 'as its own disc'}, brightest pixel ${peak.toFixed(2)}`
      : 'nothing there for it',
  );
}

console.log('\nand do exoplanets look like different planets:\n');
const looks = await page.evaluate(async () => {
  const api = window.cosminova;
  const out = [];
  for (const host of ['exo:trappist-1-e', 'exo:kepler-452-b', 'exo:proxima-cen-b', 'exo:gj-1214-b']) {
    api.travel(host);
    await new Promise((r) => setTimeout(r, 900));
    for (const item of api.exoSystem?.planets ?? []) {
      out.push({
        name: item.spec.name,
        palette: item.spec.palette?.[0]?.map((c) => Math.round(c * 255)),
        province: item.spec.paletteFreq,
        crater: item.spec.craterFreq,
      });
    }
  }
  return out;
});
const colours = new Set(looks.filter((l) => l.palette).map((l) => l.palette.join(',')));
const provinces = new Set(looks.map((l) => Math.round((l.province ?? 0) * 20)));
const craters = new Set(looks.map((l) => l.crater));
report(
  colours.size >= Math.min(12, Math.round(looks.length * 0.8)),
  'ground colours differ between worlds',
  `${colours.size} distinct of ${looks.length} planets`,
);
report(provinces.size >= 8, 'continent scale differs between worlds', `${provinces.size} distinct`);
report(craters.size >= 8, 'crater lattice differs between worlds', `${craters.size} distinct`);

report(errors.length === 0, 'no errors on the console', errors.slice(0, 2).join(' | ') || 'clean');

console.log(`\n${failures === 0 ? 'all good' : `${failures} failing`}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
