/**
 * What shape a body settled into.
 *
 * Three sources, in order of preference. Where a limb fit has been published the
 * measured semi-axes are better than anything derivable, and they carry the
 * history a formula cannot know: Iapetus is 4.5% oblate on a 79-day rotation
 * that could not possibly raise such a bulge, because the bulge is a fossil of
 * the much faster spin it had while still warm. Where there is no measurement
 * but the body is large enough to have relaxed, the hydrostatic figure follows
 * from its mass, its primary's mass and its orbit. Below the relaxation
 * crossover neither applies and the shape is whatever its last large collision
 * left, which is drawn procedurally in planet.js.
 *
 * Axis convention throughout this file is the usual satellite one: semi-axes
 * a x b x c in kilometres, a along the line to the primary, which tides stretch,
 * c along the rotation axis, which is the shortest. The renderer wants scales
 * against the mean radius with the rotation axis on y, so the conversion is
 * [a, c, b] over the geometric mean.
 */

import { PHYSICAL } from './physical-data.js';

/**
 * Published limb fits, a x b x c in kilometres.
 *
 * Sources: Thomas 2010 for the Saturnians, Thomas et al. 1998 for the small
 * Jovians, Thomas 1988 for the Uranians, Nimmo et al. 2017 for Ceres,
 * Russell et al. 2012 for Vesta, JPL physical parameters for the rest.
 *
 * Bodies round to within a kilometre or two are left out: the entry would be
 * noise, and the sphere the renderer already draws is correct. Bodies carrying a
 * measured `flattening` in bodies-data.js are also left out, because that is
 * applied separately and listing both would count the polar squash twice.
 */
export const MEASURED_AXES = {
  // Martian and Jovian small moons.
  phobos: [13.0, 11.4, 9.1],
  deimos: [7.8, 6.0, 5.1],
  metis: [30, 20, 17],
  adrastea: [10, 8, 7],
  amalthea: [125, 73, 64],
  thebe: [58, 49, 42],

  // Galileans. Io and Europa carry a resolvable tidal figure; Ganymede's is at
  // the limit of measurement and Callisto's is not resolved at all.
  io: [1829.4, 1819.4, 1815.7],
  europa: [1562.6, 1560.3, 1559.5],

  // Saturnians.
  pan: [17.3, 15.8, 10.4],
  atlas: [20.5, 17.8, 9.4],
  prometheus: [68.2, 41.6, 28.2],
  pandora: [52.0, 40.5, 32.0],
  janus: [101.7, 93.0, 76.3],
  epimetheus: [64.9, 57.0, 53.1],
  mimas: [207.8, 196.7, 190.6],
  enceladus: [256.6, 251.4, 248.3],
  tethys: [538.4, 528.3, 526.3],
  dione: [563.4, 561.3, 559.6],
  rhea: [764.3, 763.0, 762.4],
  hyperion: [180.1, 133.0, 102.7],
  // A fossil bulge: far too oblate for its present rotation.
  iapetus: [745.7, 745.7, 712.1],
  phoebe: [109.4, 108.5, 101.8],

  // Uranians.
  miranda: [240.4, 234.2, 232.9],
  ariel: [581.1, 577.9, 577.7],

  // Neptunians.
  proteus: [218, 208, 201],
  larissa: [108, 102, 84],

  // Dwarf planet and asteroid. Ceres is rotationally oblate; Vesta lost most of
  // its southern hemisphere to the Rheasilvia impact and is flattened far
  // further than its spin alone would explain.
  ceres: [482.1, 482.1, 445.9],
  vesta: [286.3, 278.6, 223.2],
};

/** Renderer axis scales from published semi-axes, normalised to unit volume. */
function toRendererAxes(a, b, c) {
  const mean = Math.cbrt(a * b * c);
  return [a / mean, c / mean, b / mean];
}

/**
 * Writes `axes` onto every spec in the list that has a published figure.
 *
 * Called by the data modules on their own tables rather than centrally, so a
 * module that is imported on its own still carries the shapes.
 */
export function applyMeasuredAxes(specs) {
  for (const spec of specs) {
    const measured = MEASURED_AXES[spec.key];
    if (!measured || spec.axes) continue;
    spec.axes = toRendererAxes(...measured);
  }
}

/**
 * Whether a moon keeps one face towards its parent. Almost every major moon
 * does, so rather than tagging each of them the test is whether the rotation
 * period matches the orbital period, which is what tidal locking means.
 */
export function isLocked(spec) {
  if (!spec.parent || spec.parent === 'sun' || !spec.orbitDays || !spec.rotationHours) return false;
  const orbitHours = Math.abs(spec.orbitDays) * 24;
  return Math.abs(orbitHours - Math.abs(spec.rotationHours)) / orbitHours < 0.02;
}

const G = 6.6743e-11;

/**
 * The hydrostatic figure of a synchronously rotating satellite.
 *
 * A body large enough for gravity to have won against its own strength takes the
 * equilibrium shape of the combined tidal and centrifugal potential. For a
 * homogeneous one this is a classical result: the three semi-axes differ by
 *
 *     (a - c) / R = (25/6) q,    (a - b) : (b - c) = 4 : 1
 *
 * where q is the ratio of tidal to gravitational acceleration at the surface,
 * (M_primary / M_body)(R / d)^3. Checked against every Saturnian and Galilean
 * with a published figure, the constant lands between 3.3 and 5.3 rather than
 * exactly 25/6 — the spread is how centrally condensed each body is, which this
 * does not attempt to model, and it is well inside what the eye can tell.
 *
 * Returns renderer axis scales, or null if the masses needed are not known.
 */
export function hydrostaticAxes({ key, radiusKm, parent, orbitKm }) {
  const mass = PHYSICAL[key]?.mass;
  const parentMass = PHYSICAL[parent]?.mass;
  if (!mass || !parentMass || !orbitKm || !radiusKm) return null;

  const q = (parentMass / mass) * (radiusKm / orbitKm) ** 3;
  // Cap for a body grazing its Roche limit, where the expansion this comes from
  // has stopped being valid and the answer would be absurd rather than merely
  // approximate.
  const spread = Math.min((25 / 6) * q, 0.25);
  if (spread < 1e-4) return null;

  // Distributed so the three deviations cancel to first order, then divided
  // through by the geometric mean so the volume is preserved exactly and a body
  // does not shrink by a fraction of a percent as it gains a shape.
  const a = 1 + 0.6 * spread;
  const b = 1 - 0.2 * spread;
  const c = 1 - 0.4 * spread;
  const mean = Math.cbrt(a * b * c);
  return [a / mean, c / mean, b / mean];
}

/**
 * Rotational flattening of a body that is not tidally locked.
 *
 * The Maclaurin result for a homogeneous spheroid, f = (5/4) q, with q the ratio
 * of centrifugal to gravitational acceleration at the equator. It overestimates
 * a centrally condensed body by half — Earth comes out at 1/231 against a real
 * 1/298 — which is why every body whose flattening has actually been measured
 * carries the measurement instead and this is reserved for the ones where it has
 * not. Those are small, near-homogeneous, and mostly rotating slowly enough that
 * the answer is a fraction of a kilometre; it earns its place on the fast
 * rotators, where it is the difference between a sphere and a visible lens.
 *
 * Returns renderer axis scales, or null if the mass is not known.
 */
export function rotationalAxes({ key, radiusKm, rotationHours }) {
  const mass = PHYSICAL[key]?.mass;
  if (!mass || !radiusKm || !rotationHours) return null;

  const omega = (2 * Math.PI) / (Math.abs(rotationHours) * 3600);
  const radiusM = radiusKm * 1000;
  const q = (omega * omega * radiusM ** 3) / (G * mass);
  const flattening = Math.min(1.25 * q, 0.4);
  if (flattening < 1e-4) return null;

  // a^2 c = 1 with c = a(1 - f), so the volume is preserved.
  const a = Math.cbrt(1 / (1 - flattening));
  return [a, a * (1 - flattening), a];
}
