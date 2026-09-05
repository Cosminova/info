/**
 * Lighting check harness.
 *
 * The one thing this simulation must never do is put sunlight somewhere the Sun
 * cannot reach. A night side has to be night, a shadow has to be dark, and an
 * eclipse has to actually happen. Those are easy properties to break and hard to
 * notice: a wrong sign or a stray ambient term reads as "slightly hazy" in a
 * screenshot and as nonsense to anyone who knows the sky.
 *
 * So the lighting is checked in two layers.
 *
 * The first tests the sunlight visibility functions in src/engine/shadow-glsl.js
 * on their own. They are GLSL, so they run on the GPU through tests/shadow.html,
 * and their answers are compared against values computed here by integrating over
 * the Sun's disc numerically. That is deliberately a different method from the
 * closed forms the shader uses, so agreement means the formulae are right and not
 * merely consistently transcribed.
 *
 * The second drives the real explorer and reads pixels back out of real frames:
 * how dark a night side is against its own day side, where the terminator falls,
 * whether Saturn's rings lay a shadow across the planet, whether an eclipse
 * darkens a disc and whether reflected light shows up on a night side without
 * flooding it. These are ratios rather than absolute levels, so they survive
 * changes in exposure and tone mapping and only fail when the physics is wrong.
 *
 * Usage: node scripts/light-check.mjs [maths|scene]
 */
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

import {
  REFLECTED_MAX_FRACTION,
  UMBRA_REFRACTED_LIGHT,
  displayedReflectance,
  illuminatedFraction,
  reflectedFraction,
} from '../src/engine/shadow-glsl.js';

const BASE = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const only = process.argv[2];

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

function near(name, actual, expected, tolerance, detail = '') {
  const delta = Math.abs(actual - expected);
  check(
    name,
    delta <= tolerance,
    `${actual.toFixed(5)} vs ${expected.toFixed(5)} (±${tolerance})${detail ? `  ${detail}` : ''}`,
  );
}

/* ---------------------------------------------------------------- references */

/**
 * Fraction of the Sun's disc above a horizon, by counting.
 *
 * A disc of unit radius on a grid, keeping the samples that fall inside it and
 * above the horizon line. Slow and obvious, which is the point: it shares no
 * algebra with the shader's circular segment formula.
 */
function integrateAboveHorizon(sinElevation, sunRadius, steps = 2400) {
  const u = sinElevation / sunRadius;
  let inside = 0;
  let above = 0;
  for (let i = 0; i < steps; i++) {
    const y = -1 + (2 * (i + 0.5)) / steps;
    for (let j = 0; j < steps; j++) {
      const x = -1 + (2 * (j + 0.5)) / steps;
      if (x * x + y * y > 1) continue;
      inside++;
      if (y > -u) above++;
    }
  }
  return above / inside;
}

/**
 * Fraction of the Sun's disc covered by another disc, by counting. Same idea:
 * sample the Sun and ask how many samples the occulter sits on top of.
 */
function integrateCovered(separation, occRadius, sunRadius, steps = 2400) {
  let inside = 0;
  let covered = 0;
  for (let i = 0; i < steps; i++) {
    const y = (-1 + (2 * (i + 0.5)) / steps) * sunRadius;
    for (let j = 0; j < steps; j++) {
      const x = (-1 + (2 * (j + 0.5)) / steps) * sunRadius;
      if (x * x + y * y > sunRadius * sunRadius) continue;
      inside++;
      const dx = x - separation;
      if (dx * dx + y * y <= occRadius * occRadius) covered++;
    }
  }
  return covered / inside;
}

/* --------------------------------------------------------------------- setup */

// New headless rather than the old shell mode. The shell throttles animation
// frames for a page nobody is watching, which leaves the scene frozen between
// measurements: the camera never arrives, terrain never refines, and every frame
// captured is the same stale one. The capture scripts run this way for the same
// reason.
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

/* ------------------------------------------------------- layer one: the maths */

if (only !== 'scene') {
  const page = await browser.newPage();
  page.on('pageerror', (error) => check(`shadow probe loaded`, false, error.message));
  await page.goto(`${BASE}tests/shadow.html`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('window.shadowProbeReady', { timeout: 60000 });

  const evaluate = (fn, cases) => page.evaluate((f, c) => window.evaluate(f, c), fn, cases);

  // The Sun's angular radius from Earth, which is the scale every soft edge in
  // the solar system is set by.
  const S = 0.00465;

  /* The terminator. */
  const horizonCases = [
    [1.0, S], [0.05, S], [-1.0, S], [-0.05, S],   // far from the edge, both ways
    [0, S],                                        // centre on the horizon
    [0.5 * S, S], [-0.5 * S, S],                   // half a radius either side
    [0.9 * S, S], [-0.9 * S, S],
  ];
  const horizon = await evaluate('sunAboveHorizon', horizonCases);

  check('terminator: full sun well above the horizon', horizon[0] === 1, `${horizon[0]}`);
  check('terminator: full sun a degree above the horizon', horizon[1] === 1, `${horizon[1]}`);
  check('terminator: no sun below the horizon', horizon[2] === 0, `${horizon[2]}`);
  check('terminator: no sun a degree below the horizon', horizon[3] === 0, `${horizon[3]}`);
  near('terminator: half the sun at the horizon', horizon[4], 0.5, 1e-4);
  for (let i = 5; i < horizonCases.length; i++) {
    const [sinElev, radius] = horizonCases[i];
    near(
      `terminator: partial sun at ${(sinElev / radius).toFixed(1)} radii`,
      horizon[i],
      integrateAboveHorizon(sinElev, radius),
      2e-3,
    );
  }

  /* Eclipses. */
  const eclipseCases = [
    [0, 2 * S, S],           // total: occulter twice the Sun's size, centred
    [0.5 * S, 2 * S, S],     // total: still fully covered
    [0, 0.5 * S, S],         // annular: occulter half the size, centred
    [0, 0.9 * S, S],         // annular: only a thin ring of Sun left
    [3 * S, S, S],           // clear of each other
    [S, S, S],               // partial: equal discs, one radius apart
    [1.5 * S, S, S],         // partial: grazing
    [0.5 * S, S, S],         // partial: deep
    [1.2 * S, 0.4 * S, S],   // partial: small occulter near the limb
  ];
  const eclipse = await evaluate('sunCoveredByDisc', eclipseCases);

  check('eclipse: total gives a true umbra', eclipse[0] === 1, `${eclipse[0]}`);
  check('eclipse: total stays total off centre', eclipse[1] === 1, `${eclipse[1]}`);
  near('eclipse: annular leaves the right ring of sun', eclipse[2], 0.25, 1e-4);
  near('eclipse: near-annular leaves a thin ring', eclipse[3], 0.81, 1e-4);
  check('eclipse: no shadow when the discs are clear', eclipse[4] === 0, `${eclipse[4]}`);
  for (let i = 5; i < eclipseCases.length; i++) {
    const [sep, occ, sun] = eclipseCases[i];
    near(
      `eclipse: partial at separation ${(sep / sun).toFixed(1)}, occulter ${(occ / sun).toFixed(1)}`,
      eclipse[i],
      integrateCovered(sep, occ, sun),
      3e-3,
    );
  }

  /* Ring shadows: Beer-Lambert through the ring plane. */
  const slab = await evaluate('slabTransmission', [
    [0, 1], [2.5, 1], [2.5, 0.5], [0.1, 1], [2.5, 0.1],
  ]);
  check('ring shadow: nothing in the way lets all the light through', slab[0] === 1, `${slab[0]}`);
  near('ring shadow: dense rings overhead', slab[1], Math.exp(-2.5), 1e-4);
  near('ring shadow: dense rings at 30 degrees', slab[2], Math.exp(-5), 1e-4);
  near('ring shadow: thin rings barely dim', slab[3], Math.exp(-0.1), 1e-4);
  check(
    'ring shadow: dense rings with a low sun go essentially black',
    slab[4] < 1e-6,
    `${slab[4]}`,
  );
  // The physical point of doing this properly: a lower sun means a longer path
  // and a darker shadow, always.
  check(
    'ring shadow: a lower sun always darkens the shadow',
    slab[2] < slab[1] && slab[4] < slab[2],
    `${slab[1].toFixed(4)} > ${slab[2].toFixed(4)} > ${slab[4].toExponential(2)}`,
  );

  /* Reflected light, against the one case that has been measured from the ground. */
  {
    const { Vector3 } = await import('three');
    // Earthshine on the Moon. The accepted figure is around a ten-thousandth of
    // direct sunlight, which is what makes the unlit part of a crescent Moon
    // faintly visible; if this came out at a hundredth or a millionth the
    // geometry would be wrong.
    const earthshine = reflectedFraction({
      hostRadiusKm: 6371,
      separationKm: 384400,
      hostAlbedo: 0.434,
      phase: 1,
    });
    check(
      'earthshine on the Moon comes out at the measured order of magnitude',
      earthshine > 3e-5 && earthshine < 3e-4,
      `${earthshine.toExponential(2)} of sunlight`,
    );

    // Jupiter-shine on Europa is genuinely far stronger, because Jupiter fills a
    // large part of Europa's sky. The ordering matters: a display curve may
    // compress the difference but must not invert it.
    const jupitershine = reflectedFraction({
      hostRadiusKm: 71492,
      separationKm: 670900,
      hostAlbedo: 0.538,
      phase: 1,
    });
    check(
      'a moon beside a giant receives far more reflected light than the Moon does',
      jupitershine > earthshine * 20,
      `${jupitershine.toExponential(2)} against ${earthshine.toExponential(2)}`,
    );
    check(
      'the display curve keeps that ordering',
      displayedReflectance(jupitershine) > displayedReflectance(earthshine),
      `${displayedReflectance(jupitershine).toFixed(4)} against ${displayedReflectance(earthshine).toFixed(4)}`,
    );
    check(
      'no reflected light can approach sunlight',
      displayedReflectance(1) <= REFLECTED_MAX_FRACTION && REFLECTED_MAX_FRACTION <= 0.1,
      `ceiling ${REFLECTED_MAX_FRACTION}`,
    );

    // The phase term, whose sign is the easiest thing here to get backwards. The
    // host is full as seen from its moon when the moon lies between the host and
    // the Sun, so the two directions point opposite ways.
    const toSun = new Vector3(1, 0, 0);
    near(
      'the host is full when the moon is between it and the sun',
      illuminatedFraction(toSun, new Vector3(-1, 0, 0)),
      1,
      1e-9,
    );
    near(
      'the host is new when the moon is on the far side',
      illuminatedFraction(toSun, new Vector3(1, 0, 0)),
      0,
      1e-9,
    );
    near(
      'the host is half lit at a right angle',
      illuminatedFraction(toSun, new Vector3(0, 1, 0)),
      0.5,
      1e-9,
    );
  }

  await page.close();
}

/* ------------------------------------------------------ layer two: the scene */

/**
 * A frame, as greyscale levels.
 *
 * Read through a screenshot rather than glReadPixels: the scene is composited by
 * a post-processing chain into the default framebuffer, which the browser is free
 * to discard once it has been presented, and reading it directly returns an empty
 * buffer. The screenshot is what the viewer actually sees, which is the right
 * thing to be making claims about anyway.
 */
async function capture(page) {
  const shot = await page.screenshot({ encoding: 'binary' });
  const { data, info } = await sharp(shot).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Mean colour inside a centred box, as fractions of full scale. */
async function colourBox(page, fraction = 0.32) {
  const shot = await page.screenshot({ encoding: 'binary' });
  const { data, info } = await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = Math.round(info.width * fraction);
  const h = Math.round(info.height * fraction);
  const x0 = Math.round((info.width - w) / 2);
  const y0 = Math.round((info.height - h) / 2);
  const sums = [0, 0, 0];
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * info.width + x) * 3;
      sums[0] += data[i];
      sums[1] += data[i + 1];
      sums[2] += data[i + 2];
    }
  }
  const n = w * h * 255;
  return { r: sums[0] / n, g: sums[1] / n, b: sums[2] / n };
}

/** Mean and peak level inside a centred box, as fractions of full scale. */
function box(frame, fraction = 0.32) {
  const w = Math.round(frame.width * fraction);
  const h = Math.round(frame.height * fraction);
  const x0 = Math.round((frame.width - w) / 2);
  const y0 = Math.round((frame.height - h) / 2);
  let total = 0;
  let peak = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const l = frame.data[y * frame.width + x] / 255;
      total += l;
      if (l > peak) peak = l;
    }
  }
  return { mean: total / (w * h), peak };
}

/** A horizontal scan across the middle of the frame, as level per column. */
function scanline(frame) {
  const y = Math.round(frame.height / 2);
  return Array.from({ length: frame.width }, (_, x) => frame.data[y * frame.width + x] / 255);
}

/**
 * The longest unbroken run of lit samples.
 *
 * Not the distance from the first lit sample to the last, which is what this
 * started as and which a single star anywhere else along the line quietly turns
 * into the width of the frame. A body's lit region is by definition connected, so
 * the longest run is the thing being measured and a star is a run of two pixels.
 */
function longestRun(values, threshold) {
  let best = 0;
  let current = 0;
  let bestEnd = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > threshold) {
      current++;
      if (current > best) {
        best = current;
        bestEnd = i;
      }
    } else {
      current = 0;
    }
  }
  return { length: best, start: bestEnd - best + 1, end: bestEnd };
}

/** Percentiles of everything in frame that is not empty sky. */
function litLevels(frame, floor = 0.02) {
  const lit = [];
  for (let i = 0; i < frame.data.length; i++) {
    const l = frame.data[i] / 255;
    if (l > floor) lit.push(l);
  }
  lit.sort((a, b) => a - b);
  const at = (p) => (lit.length ? lit[Math.floor(lit.length * p)] : 0);
  return { count: lit.length, median: at(0.5), low: at(0.02) };
}

const sample = async (page, fraction) => box(await capture(page), fraction);

/**
 * Waits a number of rendered frames.
 *
 * Not a sleep. Headless Chrome does not necessarily run animation frames for a
 * page nobody is looking at, so waiting on the clock can return with the scene
 * exactly as it was — the camera still where it started, every measurement taken
 * from a stale frame. Counting frames from inside the page waits for the thing
 * that actually has to happen. Terrain level of detail and texture tiers also
 * ramp over frames rather than over time, so this is the right unit anyway.
 */
let settle = () => Promise.resolve();

if (only !== 'maths') {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  settle = (frames = 45) =>
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
  await settle(20);

  // Frozen at a fixed date so a failure is reproducible rather than depending on
  // where the planets happen to be today.
  await page.evaluate(() => {
    window.cosminova.setRate(0);
    window.cosminova.setDate('2026-03-21T12:00:00Z');
  });
  await settle(60);

  // Bloom spreads light sideways across the terminator and out over the night
  // side, which is exactly what it is meant to do and exactly what would hide the
  // thing being measured here. The interface is hidden for the same reason.
  await page.evaluate(() => {
    window.cosminova.setBloom(false);
    window.cosminova.setUiVisible(false);
  });
  await settle();

  /* ---- Night sides are dark, on every kind of body ---- */

  // Close enough that the body overfills the frame. This is not for the look of
  // it: at a phase angle near 180 the Sun sits directly behind the body, and a
  // view that showed any sky would be measuring its corona rather than the night
  // side. For a moon it would also catch its planet, which is far brighter than
  // anything on the moon. With the body covering the frame, the centre of the
  // image is nothing but its surface.
  const CLOSE = 1.6;
  const BODIES = ['earth', 'mars', 'moon', 'saturn', 'titan', 'enceladus', 'ceres'];
  for (const key of BODIES) {
    // Almost fully lit: the camera nearly between the Sun and the body.
    await page.evaluate((k, d) => window.cosminova.lookFromSun(k, d, 12, 0), key, CLOSE);
    await settle();
    const day = await sample(page);

    // Almost fully unlit: the body between the camera and the Sun.
    //
    // With reflected light from the host switched off, because this test is about
    // direct sunlight alone. Enceladus sits close to a large bright planet and
    // genuinely receives a few per cent of full sunlight reflected off it, which
    // is physically right and would otherwise fail a test aimed at something else
    // entirely. Reflected light gets its own checks below.
    await page.evaluate((k, d) => {
      window.cosminova.lookFromSun(k, d, 172, 0);
      window.cosminova.setUniform(k, 'uShine', 0);
    }, key, CLOSE);
    await settle();
    const night = await sample(page);

    // The ratio is the physical claim, and it holds whatever the exposure is: a
    // night side lit only by secondary sources has to be orders of magnitude
    // below a sunlit one. A body that failed this would be receiving direct
    // sunlight where it cannot see the Sun.
    const ratio = night.mean / Math.max(day.mean, 1e-9);
    check(
      `night side of ${key} is dark against its own day side`,
      ratio < 0.02,
      `night/day mean = ${ratio.toExponential(2)} (${night.mean.toFixed(5)} vs ${day.mean.toFixed(5)})`,
    );

    // And nothing on it is brightly lit, which a mean can hide: one sunlit crater
    // wall on the far side would pass the test above and fail this one.
    check(
      `nothing on the night side of ${key} is sunlit`,
      night.peak < Math.max(0.1, day.peak * 0.25),
      `night peak ${night.peak.toFixed(4)}, day peak ${day.peak.toFixed(4)}`,
    );
  }

  /* ---- The terminator falls where the phase says it should ---- */

  /**
   * The lit width across the middle of the disc, and the disc's own diameter, from
   * one frame.
   *
   * An unlit hemisphere is indistinguishable from empty sky, so the diameter
   * cannot be found by looking for the disc — only the lit part of it is visible
   * at all. But the phase here is swung about the polar axis, which puts the
   * terminator across the disc vertically, and the lit region therefore always
   * reaches from pole to pole however thin a crescent it is. So the tallest run of
   * lit pixels in the frame is the diameter, and it is measured in the same frame
   * as the width rather than in a separate one that might have been taken from a
   * different distance.
   */
  const discGeometry = (frame, threshold = 0.08) => {
    let diameter = 0;
    const column = new Array(frame.height);
    for (let x = 0; x < frame.width; x++) {
      for (let y = 0; y < frame.height; y++) column[y] = frame.data[y * frame.width + x] / 255;
      const run = longestRun(column, threshold).length;
      if (run > diameter) diameter = run;
    }
    return { diameter, width: longestRun(scanline(frame), threshold).length };
  };

  // For a sphere, the lit part of the equator spans (1 + cos of the phase angle)
  // over two of the diameter. That is a prediction, not a fitted constant.
  for (const phase of [40, 90, 130]) {
    await page.evaluate((p) => window.cosminova.lookFromSun('mars', 3, p, 0), phase);
    await settle();
    const { diameter, width } = discGeometry(await capture(page));
    const expected = (1 + Math.cos((phase * Math.PI) / 180)) / 2;
    check(`the disc is measurable at a ${phase} degree phase angle`, diameter > 200, `${diameter} px`);
    // The tolerance covers the limb falling away gradually through the threshold
    // and the scan line not passing exactly through the sub-solar point.
    near(
      `terminator sits right at a ${phase} degree phase angle`,
      diameter ? width / diameter : 0,
      expected,
      0.1,
      `${width} of ${diameter} px`,
    );
  }

  /* ---- No sunlight beyond the terminator ---- */

  await page.evaluate(() => window.cosminova.lookFromSun('moon', 3, 90, 0));
  await settle();
  {
    // A half-lit Moon is the strongest case for this: no atmosphere, no night
    // lights, heavy relief, and a terminator straight across the middle of the
    // disc where every crater wall is at a grazing angle to the Sun.
    const frame = await capture(page);
    const scan = scanline(frame);
    const threshold = 0.08;

    // At a right-angle phase the terminator runs through the middle of the disc,
    // and the body is centred in frame, so every lit pixel has to be on one side
    // of the centre column. Allowing a small margin for the terminator's own
    // softness, anything beyond that is sunlight falling where the Sun cannot
    // reach — which is the single failure this whole exercise exists to prevent.
    //
    // Deliberately not a test that the lit region is unbroken. It is not, and
    // should not be: at a grazing Sun the crater shadows are long enough to cut
    // right across a scan line, which is the correct behaviour and the reason the
    // terminator on a real half Moon is a ragged line rather than a clean edge.
    const { diameter } = discGeometry(frame, threshold);
    const centre = Math.round(frame.width / 2);
    const margin = Math.round(diameter * 0.03);
    //
    // Measured as a share of the light in the scan rather than as a pixel count,
    // so that a background star happening to sit on the line cannot fail it while
    // a sunlit patch, which would carry real brightness, still does.
    let litEnergy = 0;
    let beyondEnergy = 0;
    let beyondPixels = 0;
    scan.forEach((l, x) => {
      if (l <= threshold) return;
      litEnergy += l;
      if (x > centre + margin) {
        beyondEnergy += l;
        beyondPixels++;
      }
    });
    const share = litEnergy ? beyondEnergy / litEnergy : 0;
    check(
      'no sunlight falls beyond the terminator of a half Moon',
      litEnergy > 20 && share < 0.005,
      `${(share * 100).toFixed(3)}% of the light in the scan, in ${beyondPixels} px`,
    );
  }

  /* ---- Eclipses ---- */

  await page.evaluate((d) => window.cosminova.lookFromSun('moon', d, 12, 0), CLOSE);
  await settle();
  const uneclipsed = await sample(page);

  /**
   * Puts an occulting sphere in the Moon's own frame, in kilometres, and reports
   * how much of the disc survives.
   *
   * The occulter is placed by hand rather than by date. The explorer's Moon
   * follows a circular orbit that is not the real one, so no real eclipse date
   * would reproduce here; and in any case what is under test is the shadow
   * geometry, for which a known sphere in a known place is a sharper instrument
   * than an ephemeris. The planetarium, which does use real positions, is where
   * dates are worth testing.
   */
  const eclipseBy = async (label, place, umbraLight = 0) => {
    await page.evaluate((p, u) => {
      const uniforms = window.cosminova.planets.get('moon').material.uniforms;
      const sun = uniforms.uSunDir.value;
      const Vector4 = uniforms.uOcculter.value.constructor;
      const along = p.alongSun ? sun.clone() : new (sun.constructor)(-sun.y, sun.x, sun.z).normalize();
      window.cosminova.setUniform(
        'moon',
        'uOcculter',
        new Vector4(along.x * p.distanceKm, along.y * p.distanceKm, along.z * p.distanceKm, p.radiusKm),
      );
      window.cosminova.setUniform('moon', 'uUmbraLight', u);
    }, place, umbraLight);
    await settle();
    const shot = await sample(page);
    return { label, ratio: shot.mean / uneclipsed.mean, ...shot };
  };

  // An Earth-sized body one Earth-Moon distance away, in the Sun's direction: it
  // subtends nearly a degree against the Sun's quarter, so the Moon should go out
  // entirely.
  const total = await eclipseBy('total', { alongSun: true, distanceKm: 384400, radiusKm: 6371 });
  check(
    'a total eclipse takes the disc essentially dark',
    total.ratio < 0.05,
    `${total.ratio.toExponential(2)} of uneclipsed`,
  );

  // Further away, the same body is smaller than the Sun, so however centrally it
  // sits a ring of sunlight survives and the surface only dims. This is the case
  // an implementation that treated any central hit as totality gets wrong, and at
  // this distance it covers about seven eighths of the Sun — deep enough that
  // failing to leave the last eighth would be unmistakable.
  const annular = await eclipseBy('annular', { alongSun: true, distanceKm: 1500000, radiusKm: 6371 });
  check(
    'an annular eclipse dims the disc without extinguishing it',
    annular.ratio > 0.05 && annular.ratio < 0.9,
    `${annular.ratio.toFixed(3)} of uneclipsed`,
  );

  // And the same body off to one side casts no shadow here at all.
  const aside = await eclipseBy('aside', { alongSun: false, distanceKm: 384400, radiusKm: 6371 });
  near('an occulter away from the sun line changes nothing', aside.ratio, 1, 0.06);

  check(
    'eclipse depth follows how much of the sun is covered',
    total.ratio < annular.ratio && annular.ratio < aside.ratio,
    `${total.ratio.toExponential(2)} < ${annular.ratio.toFixed(3)} < ${aside.ratio.toFixed(3)}`,
  );

  // The umbra of a body that has an atmosphere is not empty. The Earth bends a
  // little sunlight around its limb into its own shadow, reddened by the same
  // scattering that reddens a sunset, and that is why a totally eclipsed Moon is
  // a dim copper disc rather than a hole in the sky.
  const copper = await eclipseBy(
    'total, with refraction',
    { alongSun: true, distanceKm: 384400, radiusKm: 6371 },
    UMBRA_REFRACTED_LIGHT,
  );
  check(
    'an atmosphere lights its own umbra',
    copper.ratio > total.ratio * 5 && copper.ratio < 0.2,
    `${copper.ratio.toExponential(2)} against ${total.ratio.toExponential(2)} with no atmosphere`,
  );
  const tint = await colourBox(page);
  check(
    'the umbra is the colour of a sunset',
    tint.r > tint.b * 2 && tint.r > tint.g * 1.3,
    `r ${tint.r.toFixed(4)}, g ${tint.g.toFixed(4)}, b ${tint.b.toFixed(4)}`,
  );

  await page.evaluate(() => {
    const uniforms = window.cosminova.planets.get('moon').material.uniforms;
    window.cosminova.setUniform('moon', 'uOcculter', uniforms.uOcculter.value.clone().set(0, 0, 0, 0));
    window.cosminova.setUniform('moon', 'uUmbraLight', 0);
  });

  /* ---- Reflected light: present on the night side, and clearly not sunlight ---- */

  // Aimed at the camera rather than left wherever the host happens to be. Whether
  // Jupiter lies behind Europa's visible night side on any particular date is a
  // fact about the date, not about the shader, and a test that depended on it
  // would pass or fail for the wrong reason. Pointing the reflected light at the
  // hemisphere in view tests the path itself.
  const withReflectance = async (shine) => {
    await page.evaluate((s) => {
      const uniforms = window.cosminova.planets.get('europa').material.uniforms;
      const toCamera = uniforms.uCameraLocal.value.clone().normalize();
      window.cosminova.setUniform('europa', 'uShineDir', toCamera);
      window.cosminova.setUniform('europa', 'uShine', s);
    }, shine);
    await settle();
    return sample(page);
  };

  await page.evaluate((d) => window.cosminova.lookFromSun('europa', d, 172, 0), CLOSE);
  await settle();
  const withoutShine = await withReflectance(0);
  const withShine = await withReflectance(0.04);

  check(
    'reflected light from the host reaches a moon night side',
    withShine.mean > withoutShine.mean * 2,
    `${withShine.mean.toFixed(6)} with, ${withoutShine.mean.toFixed(6)} without`,
  );

  await page.evaluate((d) => window.cosminova.lookFromSun('europa', d, 12, 0), CLOSE);
  await settle();
  const europaDay = await sample(page);
  check(
    'reflected light stays far below sunlight',
    withShine.mean < europaDay.mean * 0.15,
    `${(withShine.mean / europaDay.mean).toExponential(2)} of the day side`,
  );

  /* ---- Saturn: ring shadow on the globe, planet shadow in the rings ---- */

  // A high sun and a phase that puts the shadowed part of the globe in view.
  await page.evaluate(() => window.cosminova.lookFromSun('saturn', 4, 45, 26));
  await settle(2200);
  const saturn = await sample(page, 0.5);

  await page.evaluate(() => window.cosminova.setUniform('saturn', 'uHasRings', 0));
  await settle(1200);
  const noRingShadow = await sample(page, 0.5);
  await page.evaluate(() => window.cosminova.setUniform('saturn', 'uHasRings', 1));

  // Removing the shadow can only add light to the globe, and it has to add a
  // visible amount or the shadow was not there.
  check(
    'the rings cast a shadow on Saturn',
    noRingShadow.mean > saturn.mean * 1.02,
    `${saturn.mean.toFixed(5)} with the shadow, ${noRingShadow.mean.toFixed(5)} without`,
  );

  // And the planet's shadow in the rings has to reach a real umbra: somewhere in
  // frame the rings must be far darker than their typical brightness.
  const ringContrast = litLevels(await capture(page));
  check(
    'the Saturn system has deep shadow as well as sunlit surface',
    ringContrast.count > 500 && ringContrast.low < ringContrast.median * 0.4,
    `2nd percentile ${ringContrast.low.toFixed(4)} against median ${ringContrast.median.toFixed(4)}`,
  );

  check('no console errors during the lighting checks', errors.length === 0, errors.slice(0, 3).join(' | '));

  await page.close();
}

await browser.close();

console.log(`\n${results.length - failures}/${results.length} lighting checks passed`);
if (failures) {
  console.log('\nfailed:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.name}  —  ${r.detail}`);
  process.exit(1);
}
