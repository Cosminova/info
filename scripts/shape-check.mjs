/**
 * Body figure check.
 *
 * Every solid body gets one of three shapes: a published limb fit, the
 * equilibrium figure its own mass implies, or a procedural collision shape. This
 * checks all three against the things that must be true of them.
 *
 * The interesting layer is the middle one, because there the code is making a
 * prediction that can be wrong. Twenty-odd bodies have both a measured figure and
 * enough known mass to derive one, so the derivation can be run against the
 * measurement it does not get to see. That is a real test of the physics rather
 * than of the transcription.
 *
 * The rest are invariants. Volume has to be preserved, or a body silently changes
 * size when it gains a shape. The spin axis has to be the shortest axis, which is
 * not a stylistic choice: a body spinning about its long axis is not in the lowest
 * rotational energy state for its angular momentum, and internal friction takes it
 * out of that state long before anyone observes it.
 *
 * A last layer renders bodies and measures their outlines, because everything
 * above it would still pass if the axis scales never reached the GPU.
 *
 * Usage: node scripts/shape-check.mjs [tables|scene]
 */
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

import { MEASURED_AXES, hydrostaticAxes, isLocked, rotationalAxes } from '../src/engine/figures.js';
import { PHYSICAL } from '../src/engine/physical-data.js';
import { SOLAR_BODIES } from '../src/engine/bodies-data.js';

const BASE = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const only = process.argv[2];

let failures = 0;

function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

function within(name, actual, expected, factor, detail = '') {
  const ratio = actual / expected;
  check(
    name,
    ratio >= 1 / factor && ratio <= factor,
    `${actual.toExponential(3)} vs ${expected.toExponential(3)} — ${ratio.toFixed(2)}x (within ${factor}x)${detail ? `  ${detail}` : ''}`,
  );
}

function near(name, actual, expected, tolerance, detail = '') {
  check(
    name,
    Math.abs(actual - expected) <= tolerance,
    `${actual.toFixed(4)} vs ${expected.toFixed(4)} (±${tolerance})${detail ? `  ${detail}` : ''}`,
  );
}

const byKey = new Map(SOLAR_BODIES.map((b) => [b.key, b]));

// --- the measured figures reach the specs ---------------------------------

if (only !== 'scene') {
console.log('\nmeasured figures');

for (const key of Object.keys(MEASURED_AXES)) {
  const spec = byKey.get(key);
  if (!spec) {
    check(`${key} is a body in the scene`, false, 'no spec with that key');
    continue;
  }
  const [a, b, c] = MEASURED_AXES[key];
  const axes = spec.axes;
  if (!axes) {
    check(`${key} carries its measured figure`, false, 'spec.axes is unset');
    continue;
  }

  // Volume preserved, so a body does not change size by acquiring a shape.
  const volume = axes[0] * axes[1] * axes[2];
  const orderedRight = axes[0] >= axes[2] && axes[2] >= axes[1];
  const aspectRight = Math.abs(axes[0] / axes[1] - a / c) < 1e-6;
  check(
    `${key} ${a}x${b}x${c} km`,
    Math.abs(volume - 1) < 1e-9 && orderedRight && aspectRight,
    `a/c ${(a / c).toFixed(4)}, axes [${axes.map((v) => v.toFixed(4)).join(', ')}]`,
  );

  // The published mean radius and the spec radius are independent numbers and
  // should agree; if they do not, one of the two tables is stale.
  const publishedMean = Math.cbrt(a * b * c);
  within(`${key} radius agrees with its axes`, spec.radiusKm, publishedMean, 1.02);
}

// --- the derivation against the measurements it does not see ----------------

console.log('\nderived figures against measured ones');

let compared = 0;
for (const [key, [a, b, c]] of Object.entries(MEASURED_AXES)) {
  const spec = byKey.get(key);
  if (!spec || !PHYSICAL[key]?.mass || !isLocked(spec)) continue;

  const derived = hydrostaticAxes(spec);
  if (!derived) continue;

  // Only bodies actually above the relaxation crossover should agree: below it
  // the shape is a collision shape and hydrostatic theory has nothing to say.
  if ((spec.radiusKm ?? 0) < 200) continue;
  compared++;

  const measuredSpread = (a - c) / Math.cbrt(a * b * c);
  const derivedSpread = derived[0] - derived[1];
  within(`${key} tidal-rotational spread`, derivedSpread, measuredSpread, 1.8);
}
check('the derivation was exercised', compared >= 4, `${compared} bodies compared`);

// --- the derivation is dimensionally sane ----------------------------------

console.log('\nderived figures in isolation');

// Mimas is deep in Saturn's tidal field; Rhea is far out. The first must be
// several times the more distorted, which is the (R/d)^3 dependence showing up.
const mimas = hydrostaticAxes(byKey.get('mimas'));
const rhea = hydrostaticAxes(byKey.get('rhea'));
check(
  'a closer moon is more distorted',
  mimas[0] - mimas[1] > 4 * (rhea[0] - rhea[1]),
  `mimas ${(mimas[0] - mimas[1]).toExponential(2)}, rhea ${(rhea[0] - rhea[1]).toExponential(2)}`,
);

for (const [label, axes] of [['mimas', mimas], ['rhea', rhea]]) {
  check(
    `${label}'s derived figure preserves volume`,
    Math.abs(axes[0] * axes[1] * axes[2] - 1) < 1e-6,
    (axes[0] * axes[1] * axes[2]).toFixed(9),
  );
  check(
    `${label}'s derived spin axis is the shortest`,
    axes[0] > axes[2] && axes[2] > axes[1],
    `[${axes.map((v) => v.toFixed(5)).join(', ')}]`,
  );
}

// Rotational flattening, checked where the homogeneous assumption is the whole
// point: Earth's real value is 1/298 and a homogeneous Earth is 1/231, so the
// formula should land near the latter and the code should be using the measured
// number instead of this for a body that has one.
const earth = rotationalAxes(byKey.get('earth'));
const earthFlattening = 1 - earth[1] / earth[0];
within('a homogeneous Earth flattens to 1/231', earthFlattening, 1 / 231, 1.05);
check(
  'Earth uses its measured flattening, not the derived one',
  byKey.get('earth').flattening === 0.003353 && !byKey.get('earth').axes,
  `flattening ${byKey.get('earth').flattening}`,
);

// --- nothing carries two shapes at once ------------------------------------

console.log('\nconsistency across the tables');

const doubled = SOLAR_BODIES.filter((s) => s.axes && s.flattening);
check(
  'no body has both measured axes and a flattening',
  doubled.length === 0,
  doubled.map((s) => s.key).join(', ') || 'none',
);

const shaped = SOLAR_BODIES.filter((s) => s.axes);
check('the measured table is fully applied', shaped.length === Object.keys(MEASURED_AXES).length,
  `${shaped.length} bodies shaped, ${Object.keys(MEASURED_AXES).length} in the table`);
}

/* ------------------------------------------------- the shapes as rendered */

/**
 * Rotates a vector by the inverse of a quaternion, to take the camera's screen
 * basis out of world space and into the body's own frame, which is the frame the
 * axis scales are applied in.
 */
function unrotate(v, q) {
  const [x, y, z] = v;
  const { x: qx, y: qy, z: qz, w: qw } = q;
  // v' = q* v q, with q* the conjugate.
  const ix = -qx, iy = -qy, iz = -qz;
  const tx = 2 * (iy * z - iz * y);
  const ty = 2 * (iz * x - ix * z);
  const tz = 2 * (ix * y - iy * x);
  return [
    x + qw * tx + (iy * tz - iz * ty),
    y + qw * ty + (iz * tx - ix * tz),
    z + qw * tz + (ix * ty - iy * tx),
  ];
}

/**
 * The aspect ratio of an ellipsoid's outline, seen along a given view.
 *
 * An ellipsoid is the unit sphere stretched by diag(sx, sy, sz), so its outline
 * on screen is the image of the unit ball under the 2x3 matrix whose rows are
 * the screen right and up vectors scaled the same way. The image of a ball under
 * a linear map is an ellipse with semi-axes equal to that map's singular values,
 * and for a 2x3 matrix those come out of the 2x2 eigenproblem in closed form.
 *
 * Doing it this way rather than assuming the spin axis is vertical on screen
 * matters: a locked moon's pole follows its primary's tilt, so it is not, and a
 * test that assumed otherwise would be checking a number that has no reason to
 * be right.
 */
function outlineAspect(axes, right, up) {
  const scale = (v) => [v[0] * axes[0], v[1] * axes[1], v[2] * axes[2]];
  const r = scale(right);
  const u = scale(up);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const a = dot(r, r);
  const b = dot(r, u);
  const c = dot(u, u);
  const trace = a + c;
  const gap = Math.sqrt(Math.max((a - c) ** 2 + 4 * b * b, 0));
  return Math.sqrt((trace + gap) / Math.max(trace - gap, 1e-12));
}

/**
 * The aspect ratio of the body's actual silhouette in a frame.
 *
 * The mask is built a row at a time as the longest run of lit pixels containing
 * the centre column, and the second moments of that mask give the outline's
 * principal axes — which is what makes this independent of which way up the body
 * happens to be on screen, and a locked moon's pole is not vertical.
 *
 * Two competing errors have to be avoided at once, and this is what the per-row
 * run is for. The threshold has to be low, because a real surface has albedo
 * markings and one set high enough to ignore them cuts the limb short wherever a
 * dark patch reaches it — on Ceres that alone put the measured outline more
 * oblate than any view of its ellipsoid could possibly be. But a low threshold
 * lets an area fill escape through the Milky Way and swallow the sky. Requiring
 * the run to be contiguous with the disc along its own row keeps the limb at a
 * low threshold while leaving stars out, since a star is not in the disc's row.
 */
function silhouetteAspect(frame, threshold = 0.02) {
  const { data, width, height } = frame;
  const lum = (x, y) => {
    const i = (y * width + x) * 3;
    return (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
  };

  const centreX = width >> 1;
  const rows = [];
  let dropped = 0;
  for (let y = 0; y < height; y++) {
    if (lum(centreX, y) <= threshold) continue;
    let left = centreX;
    let right = centreX;
    while (left > 0 && lum(left - 1, y) > threshold) left--;
    while (right < width - 1 && lum(right + 1, y) > threshold) right++;
    // A run that reaches the edge of the frame has not found a limb, so it
    // carries no width worth measuring and is dropped rather than believed. Near
    // the ecliptic the sky itself is faintly lit and a run can wander off into
    // it; a body clipped by the frame would lose every row this way, which is
    // the case the count below is there to catch.
    if (left === 0 || right === width - 1) {
      dropped++;
      continue;
    }
    rows.push({ y, left, right });
  }
  if (!rows.length) return { pixels: 0, aspect: 0, rows: 0, dropped };

  let pixels = 0;
  let sumX = 0;
  let sumY = 0;
  for (const { y, left, right } of rows) {
    const n = right - left + 1;
    pixels += n;
    sumX += ((left + right) / 2) * n;
    sumY += y * n;
  }
  const meanX = sumX / pixels;
  const meanY = sumY / pixels;

  let vxx = 0, vyy = 0, vxy = 0;
  for (const { y, left, right } of rows) {
    const dy = y - meanY;
    for (let x = left; x <= right; x++) {
      const dx = x - meanX;
      vxx += dx * dx;
      vyy += dy * dy;
      vxy += dx * dy;
    }
  }
  vxx /= pixels; vyy /= pixels; vxy /= pixels;
  const trace = vxx + vyy;
  const gap = Math.sqrt(Math.max((vxx - vyy) ** 2 + 4 * vxy * vxy, 0));
  return {
    pixels,
    dropped,
    rows: rows.length,
    aspect: Math.sqrt((trace + gap) / Math.max(trace - gap, 1e-12)),
  };
}

if (only !== 'tables') {
  console.log('\nshapes as rendered');

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
  await page.setViewport({ width: 1000, height: 1000, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  const settle = (frames = 45) =>
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
    // Bloom would spread the limb outward by a few pixels all round, which is a
    // small bias on a diameter and a large one on the difference between two
    // axes. The interface is hidden so the flood fill cannot escape into a panel.
    window.cosminova.setBloom(false);
    window.cosminova.setUiVisible(false);
  });
  await settle(60);

  // Two clean ellipsoids, a near-sphere and a true sphere.
  //
  // Iapetus and Ceres are the cases worth rendering: both are far enough above
  // the relaxation crossover that the procedural relief which would otherwise
  // roughen a silhouette is switched off entirely, so their outlines are the
  // ellipsoid and nothing else. Rhea is shaped too, but only by a part in four
  // hundred, and Mercury is not shaped at all — between them they catch the
  // opposite failure, where something applies a distortion that should not be
  // there.
  const CASES = ['iapetus', 'ceres', 'rhea', 'mercury'];
  for (const key of CASES) {
    // Fully lit and fully inside the frame: a phase angle of zero puts the Sun
    // behind the camera, so the whole disc is illuminated and its edge is the
    // limb rather than a terminator.
    await page.evaluate((k) => window.cosminova.lookFromSun(k, 5, 0, 0), key);
    await settle(90);

    // Opened up well past a natural exposure, for the same reason a photographer
    // would: what is being measured is where the limb is, and on Iapetus half the
    // surface has an albedo of 0.05 against 0.6 on the other half. At a natural
    // exposure the dark hemisphere's limb sits at the detection floor and the
    // outline comes out rounder than the body is. Tone mapping is monotonic and
    // bloom is off, so more gain moves every edge outward by the same amount and
    // leaves the ratio of the two axes alone.
    await page.evaluate(() => window.cosminova.setExposure(6));
    await settle(10);

    const view = await page.evaluate((k) => {
      const planet = window.cosminova.planets.get(k);
      const camera = window.cosminova.camera;
      camera.updateMatrixWorld();
      const e = camera.matrixWorld.elements;
      const q = planet.group.quaternion;
      return {
        axes: planet.material.uniforms.uAxisScale.value.toArray(),
        right: [e[0], e[1], e[2]],
        up: [e[4], e[5], e[6]],
        quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
      };
    }, key);

    // The uniform is the one number the whole chain depends on, so it is checked
    // against the table directly rather than inferred from pixels.
    const spec = byKey.get(key);
    const expectedAxes = spec.axes ?? [1, 1, 1];
    const axesMatch = view.axes.every((v, i) => Math.abs(v - expectedAxes[i]) < 1e-5);
    check(
      `${key}'s axis scales reach the shader`,
      axesMatch,
      `[${view.axes.map((v) => v.toFixed(5)).join(', ')}]`,
    );

    const frame = await sharp(await page.screenshot({ type: 'png' }))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const measured = silhouetteAspect({
      data: frame.data,
      width: frame.info.width,
      height: frame.info.height,
    });

    const right = unrotate(view.right, view.quaternion);
    const up = unrotate(view.up, view.quaternion);
    const expected = outlineAspect(view.axes, right, up);

    check(
      `${key}'s disc is measurable`,
      measured.pixels > 20000 && measured.dropped < measured.rows * 0.05,
      `${measured.pixels} px over ${measured.rows} rows, ${measured.dropped} dropped`,
    );
    // A pixel or two of softness at the limb costs a little of the ratio, and
    // the craters break the outline by a fraction of a percent.
    near(
      `${key}'s outline is as oblate as its axes say`,
      measured.aspect,
      expected,
      0.02,
      `predicted from [${view.axes.map((v) => v.toFixed(4)).join(', ')}]`,
    );

    // No view of an ellipsoid can be more eccentric than its longest axis
    // against its shortest, whatever angle it is seen from. A measurement past
    // that bound is a measurement error rather than a shape, which is worth
    // saying separately: it is the failure that looks most like a real result.
    const ceiling = Math.max(...view.axes) / Math.min(...view.axes);
    check(
      `${key}'s outline is within what its axes allow`,
      measured.aspect <= ceiling + 0.02,
      `${measured.aspect.toFixed(4)} against a ceiling of ${ceiling.toFixed(4)}`,
    );
  }

  check('no console errors while rendering shapes', errors.length === 0, errors[0] ?? '');
  await browser.close();
}

const total = SOLAR_BODIES.filter((s) => s.axes).length;
console.log(
  `\n${failures === 0 ? `all figure checks passed` : `${failures} failed`} — ${total} bodies carry a measured figure`,
);
process.exit(failures === 0 ? 0 : 1);
