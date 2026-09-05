/**
 * Terrain continuity check.
 *
 * The claim being tested is that nothing changes discontinuously as the camera
 * approaches a surface. That is hard to eyeball — a pop lasts one frame — and
 * easy to break, since it happens whenever the quadtree swaps a patch for its
 * four children and every second vertex jumps to a new position.
 *
 * So it is measured instead. The camera is walked inward along a geometric
 * sequence of altitudes, a frame is captured at each step, and consecutive frames
 * are differenced. A continuous approach produces a smooth series of small
 * differences; a pop produces one frame that differs from its neighbour far more
 * than the trend. The statistic is therefore the worst step against the typical
 * step, which is scale-free: it does not care how fast the camera is moving, only
 * whether any one step stands out from the others.
 *
 * Absolute difference would be the wrong measure. Approaching a surface changes
 * the image continuously and substantially, and a threshold low enough to catch a
 * pop would flag ordinary motion.
 *
 * The steps are deliberately small and dense around the altitudes where levels
 * change. A coarse walk can step straight over a pop and see nothing.
 *
 * Usage: node scripts/lod-check.mjs [body...]
 */
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const BASE = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const bodies = process.argv.slice(2);
const BODIES = bodies.length ? bodies : ['moon', 'mars', 'mercury'];

let failures = 0;

function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/**
 * Mean absolute luminance difference between two frames, as a fraction of full
 * scale, ignoring the outer margin.
 *
 * The margin is dropped because the body does not fill the frame at the higher
 * altitudes and the star field beyond its limb wheels past as the camera moves,
 * which is a real difference but not one that says anything about terrain.
 */
function frameDelta(a, b, width, height) {
  const x0 = Math.floor(width * 0.2);
  const x1 = Math.floor(width * 0.8);
  const y0 = Math.floor(height * 0.2);
  const y1 = Math.floor(height * 0.8);
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 3;
      const la = (a[i] * 0.2126 + a[i + 1] * 0.7152 + a[i + 2] * 0.0722) / 255;
      const lb = (b[i] * 0.2126 + b[i + 1] * 0.7152 + b[i + 2] * 0.0722) / 255;
      sum += Math.abs(la - lb);
      count++;
    }
  }
  return sum / count;
}

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[sorted.length >> 1];
}

/**
 * Fraction of the frame showing sky rather than surface.
 *
 * Only meaningful at zero phase angle, with the sun directly behind the camera.
 * There are no cast shadows in that geometry, so when the body fills the view
 * every pixel is lit ground and anything dark is a gap in the terrain. At any
 * other phase this cannot tell a hole from a shadowed crater floor.
 */
function skyFraction(data, width, height) {
  const x0 = Math.floor(width * 0.1);
  const x1 = Math.floor(width * 0.9);
  const y0 = Math.floor(height * 0.1);
  const y1 = Math.floor(height * 0.9);
  let dark = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 3;
      const l = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
      if (l < 0.02) dark++;
      count++;
    }
  }
  return dark / count;
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
  // Bloom smears a pop across neighbouring pixels, which would soften exactly the
  // signal being looked for, and the dither pass animates noise every frame, which
  // would drown it: it alone puts about 2e-3 between two otherwise identical
  // frames, which is more than some of the differences being measured. Time is
  // frozen so that the only thing changing between two frames is the camera.
  window.cosminova.setBloom(false);
  window.cosminova.setPass('dither', false);
  window.cosminova.setUiVisible(false);
});
await settle(50);

/**
 * Walks the camera in from `from` to `to` radii over `steps` geometric stages,
 * capturing each frame and returning the consecutive differences.
 */
async function approach(key, { from, to, steps, morphScale = -1, phase = 28 }) {
  const deltas = [];
  const levels = [];
  let previous = null;
  const ratio = (to / from) ** (1 / (steps - 1));

  for (let i = 0; i < steps; i++) {
    const distance = from * ratio ** i;
    // The morph scale is reapplied after every move, because placing the camera
    // clears uniform overrides — it exists to undo whatever a previous test set.
    await page.evaluate(
      (k, d, m, p) => {
        window.cosminova.lookFromSun(k, d, p, 12);
        window.cosminova.setUniform(k, 'uMorphOverride', m);
      },
      key,
      distance,
      morphScale,
      phase,
    );
    // Long enough for the flight to finish and the tessellation to settle at the
    // new altitude, since both are frame-driven.
    await settle(14);

    const stats = await page.evaluate((k) => {
      const planet = window.cosminova.planets.get(k);
      return {
        patches: planet.sphere.patchCount,
        deepest: planet.sphere.deepestLevel,
        starved: planet.sphere.starved,
      };
    }, key);

    const png = await page.screenshot({ type: 'png' });
    if (process.env.LOD_DUMP) {
      await sharp(png).toFile(
        `shots/lod-${key}-${distance.toFixed(4)}-m${morphScale}.png`,
      );
    }
    const shot = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });

    if (previous) {
      deltas.push({
        delta: frameDelta(previous, shot.data, shot.info.width, shot.info.height),
        distance,
        deepest: stats.deepest,
        starved: stats.starved,
        patches: stats.patches,
      });
    }
    previous = shot.data;
    levels.push({
      ...stats,
      distance,
      sky: skyFraction(shot.data, shot.info.width, shot.info.height),
    });
  }
  return { deltas, levels };
}

/**
 * Measures the pop at one quadtree transition, with the camera held still.
 *
 * The invariant the morph exists to satisfy is that a fully collapsed child patch
 * is its parent. So the deepest level is capped to get the parent tessellation,
 * then uncapped with every patch forced fully collapsed: those two images should
 * be the same picture. Forcing the same patches uncollapsed instead produces the
 * image the parent would have jumped to without the morph, and the difference
 * between that and the parent is exactly the pop, in the units the eye sees.
 *
 * Holding the camera still is what makes this sharp. Walking it and looking for a
 * spike buries a pop under the much larger frame-to-frame change from the motion
 * itself.
 */
async function popAt(key, distance) {
  const setup = async (maxLevel, morph, morphLevel = -1) => {
    await page.evaluate(
      (k, d, ml, m, mlv) => {
        window.cosminova.lookFromSun(k, d, 22, 14);
        const planet = window.cosminova.planets.get(k);
        planet.sphere.maxLevel = ml;
        window.cosminova.setUniform(k, 'uMorphOverride', m);
        window.cosminova.setUniform(k, 'uMorphLevel', mlv);
      },
      key,
      distance,
      maxLevel,
      morph,
      morphLevel,
    );
    await settle(16);
    const state = await page.evaluate((k) => {
      const planet = window.cosminova.planets.get(k);
      return {
        level: planet.sphere.deepestLevel,
        starved: planet.sphere.starved,
        // Which elevation map is loaded, which the comparison needs to hold still:
        // it is chosen from the deepest level in use, so capping the level can
        // swap it and change the terrain itself. Mirrors the clamp in the frame
        // loop. Null for a body whose relief is entirely procedural, where there
        // is no map to swap.
        dem: planet.spec.dem ? Math.min(planet.desiredDemWidth(), 4096) : null,
      };
    }, key);
    const shot = await sharp(await page.screenshot({ type: 'png' }))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data: shot.data, info: shot.info, ...state };
  };

  const natural = await page.evaluate(
    (k, d) => {
      window.cosminova.lookFromSun(k, d, 22, 14);
      return window.cosminova.planets.get(k).sphere.maxLevel;
    },
    key,
    distance,
  );
  await settle(16);
  const deepest = await page.evaluate(
    (k) => window.cosminova.planets.get(k).sphere.deepestLevel,
    key,
  );

  // Every render here pins the morph off except where it is under test, so the
  // three differ in exactly one thing: whether the deepest level is present, and
  // whether it is collapsed onto the level above it.
  //
  // The cap is one level shallower than the tessellation wants, so that lifting it
  // restores a level that is genuinely in use.
  const parent = await setup(deepest - 1, 0);
  // The same configuration again, to establish what two renders differ by when
  // nothing has changed. Every other difference here is only meaningful against
  // that floor.
  const again = await setup(deepest - 1, 0);
  const collapsed = await setup(deepest, 1, deepest);
  const expanded = await setup(deepest, 0);

  await page.evaluate(
    (k, ml) => {
      window.cosminova.planets.get(k).sphere.maxLevel = ml;
      window.cosminova.setUniform(k, 'uMorphOverride', -1);
      window.cosminova.setUniform(k, 'uMorphLevel', -1);
    },
    key,
    natural,
  );

  const w = parent.info.width;
  const h = parent.info.height;
  return {
    level: deepest,
    // Only a like-for-like comparison if the three renders agree on the elevation
    // map and none of them ran out of instance slots. A starved run spends its
    // freed budget refining somewhere else, so capping the level would change
    // patches the test is not asking about.
    comparable:
      parent.dem === collapsed.dem &&
      parent.dem === expanded.dem &&
      !parent.starved &&
      !collapsed.starved &&
      !expanded.starved,
    why: `dem ${parent.dem}/${collapsed.dem}/${expanded.dem}${parent.starved || collapsed.starved || expanded.starved ? ', starved' : ''}`,
    floor: frameDelta(parent.data, again.data, w, h),
    matched: frameDelta(parent.data, collapsed.data, w, h),
    pop: frameDelta(parent.data, expanded.data, w, h),
  };
}

/** Worst consecutive step against the typical one, over a whole approach. */
function spikiness(deltas) {
  const values = deltas.map((d) => d.delta);
  const typical = median(values);
  const worst = Math.max(...values);
  return {
    typical,
    worst,
    ratio: worst / Math.max(typical, 1e-9),
    at: deltas[values.indexOf(worst)],
  };
}

for (const key of BODIES) {
  // From well outside down to low altitude, in many small steps. The range
  // crosses a dozen level boundaries, which is the point: each one is a chance to
  // pop, and a coarse walk can step straight over one and see nothing. It stops
  // short of grazing the surface because down there the sun is so low that the
  // frame is mostly shadow and the differences stop meaning anything.
  const range = {
    from: Number(process.env.LOD_FROM ?? 2.4),
    to: Number(process.env.LOD_TO ?? 1.03),
    steps: Number(process.env.LOD_STEPS ?? 56),
  };

  // The transition itself, measured with the camera still, at a few altitudes.
  let compared = 0;
  for (const distance of [1.16, 1.11, 1.07]) {
    const { level, comparable, why, floor, matched, pop } = await popAt(key, distance);
    if (!comparable) {
      console.log(`      skipped ${key} at ${distance} radii: not like for like (${why})`);
      continue;
    }
    // There has to be something to remove before it means anything to say it was
    // removed. Where adding a level changes almost nothing — smooth ground, or
    // relief already resolved — the comparison would pass on an empty measurement,
    // so it is skipped rather than counted.
    if (pop < Math.max(floor * 4, 1e-5)) {
      console.log(
        `      skipped ${key} at ${distance} radii: level ${level} boundary changes too little to measure (${pop.toExponential(2)})`,
      );
      continue;
    }
    compared++;

    check(
      `${key} collapses exactly onto its parent at ${distance} radii`,
      matched < pop * 0.05,
      `collapsed differs from parent by ${matched.toExponential(2)}, expanded by ${pop.toExponential(2)} — the morph removes ${(100 - (matched / pop) * 100).toFixed(1)}% of it`,
    );
  }
  check(
    `${key} offered a measurable transition to compare`,
    compared > 0,
    `${compared} of 3 altitudes`,
  );

  const { deltas, levels } = await approach(key, range);
  const morphed = spikiness(deltas);

  if (process.env.LOD_TRACE) {
    for (const d of deltas) {
      console.log(
        `    ${d.distance.toFixed(4)} radii  delta ${d.delta.toExponential(2)}  level ${d.deepest}  ${d.patches} patches${d.starved ? '  STARVED' : ''}`,
      );
    }
  }

  const deepest = Math.max(...levels.map((l) => l.deepest));
  const patches = Math.max(...levels.map((l) => l.patches));

  check(
    `${key} subdivides over the approach`,
    deepest >= 8,
    `reached level ${deepest}, ${patches} patches at most`,
  );

  // End to end over the whole descent: no single step of the walk should stand out
  // against the others. This is a weaker measure than the transition test above,
  // because the camera is moving and that motion dominates each difference, but it
  // is the one that covers everything at once — level changes, texture tiers,
  // the patch budget running out.
  check(
    `${key} reveals detail without a discontinuity`,
    morphed.ratio < 3,
    `worst step ${morphed.worst.toExponential(2)} against a typical ${morphed.typical.toExponential(2)} — ${morphed.ratio.toFixed(2)}x, at ${morphed.at.distance.toFixed(4)} radii, level ${morphed.at.deepest}`,
  );

  // Descend at zero phase, where the sun sits behind the camera and the surface
  // casts no shadow it can see, so the terrain either covers the frame or it has
  // a hole in it. This is the direct test: running out of instance slots is
  // allowed to cost detail, and is not allowed to cost geometry.
  const covered = await approach(key, { from: 1.3, to: 1.008, steps: 10, phase: 0 });
  const leakiest = covered.levels.reduce((a, b) => (b.sky > a.sky ? b : a));

  check(
    `${key} has no gaps in the terrain on the way down`,
    leakiest.sky < 0.004,
    `worst ${(leakiest.sky * 100).toFixed(3)}% sky at ${leakiest.distance.toFixed(4)} radii, ${leakiest.patches} patches${leakiest.starved ? ', starved' : ''}`,
  );

  const starved = covered.levels.concat(levels).filter((l) => l.starved);
  if (starved.length) {
    console.log(
      `      note: ${key} hit its patch budget below ${Math.max(...starved.map((l) => l.distance)).toFixed(3)} radii, so close detail is capped`,
    );
  }
}

check('no console errors during the approach', errors.length === 0, errors[0] ?? '');

await browser.close();

console.log(
  `\n${failures === 0 ? 'terrain stayed continuous' : `${failures} failed`} over ${BODIES.length} approaches`,
);
process.exit(failures === 0 ? 0 : 1);
