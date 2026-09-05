/**
 * Physical and rendering parameters for every body in the scene.
 *
 * Radii, flattening, rotation periods and axial tilts are real. Moon orbits are
 * circular approximations in the parent's equatorial plane using true semi-major
 * axes and periods, which is right to a few hundred kilometres — invisible at
 * the scales you actually view them from, and it avoids carrying a full theory
 * for every satellite.
 *
 * Terrain parameters:
 *   craterFreq     crater grid cells per body radius; a cell is roughly one
 *                  crater, so radiusKm/craterFreq is the largest crater size
 *   craterOctaves  how many halvings of that size to add as you approach
 *   craterDepth    depth as a fraction of crater diameter (~0.2 is realistic)
 *   craterDensity  fraction of grid cells that hold a crater
 *   roughness      broadband fractal relief on top, for non-impact texture
 *   photometry     1 = Lommel-Seeliger regolith backscatter, 0 = Lambert
 */

import { MOONS } from './moons-data.js';
import { applyMeasuredAxes } from './figures.js';

export const SUN = {
  key: 'sun',
  name: 'Sun',
  radiusKm: 695700,
  rotationHours: 609.12,
  tiltDeg: 7.25,
};

export const BODIES = [
  {
    key: 'mercury',
    name: 'Mercury',
    parent: 'sun',
    radiusKm: 2439.7,
    rotationHours: 1407.6,
    tiltDeg: 0.034,
    // Saturation-cratered like the Moon, with no mare to erase them.
    craterFreq: 340,
    craterOctaves: 6,
    craterDepth: 0.2,
    craterDensity: 0.62,
    roughness: 0.05,
    photometry: 1,
    albedoBoost: 1.35,
  },
  {
    key: 'venus',
    name: 'Venus',
    parent: 'sun',
    radiusKm: 6051.8,
    rotationHours: -5832.5,
    tiltDeg: 177.36,
    craterFreq: 260,
    craterOctaves: 2,
    craterDepth: 0.1,
    craterDensity: 0.15,
    roughness: 0.09,
    photometry: 0.4,
    albedoBoost: 1.1,
    cloudMap: 'clouds',
    atmosphere: { height: 0.012, density: 3.4, tint: [1.0, 0.86, 0.62] },
  },
  {
    key: 'earth',
    name: 'Earth',
    parent: 'sun',
    radiusKm: 6371,
    flattening: 0.003353,
    rotationHours: 23.9345,
    tiltDeg: 23.4393,
    craterFreq: 300,
    craterOctaves: 3,
    craterDepth: 0.05,
    craterDensity: 0.05,
    roughness: 0.12,
    photometry: 0.25,
    // Sun glint is a small bright spot on the water, not a lobe across an ocean:
    // this was set when surfaces were being read as linear and so came out far
    // brighter than they should have been.
    specular: 0.45,
    cloudMap: 'clouds',
    nightMap: true,
    oceanMap: true,
    atmosphere: { height: 0.016, density: 1.6, tint: [0.32, 0.52, 1.0] },
  },
  {
    key: 'moon',
    name: 'Moon',
    parent: 'earth',
    radiusKm: 1737.4,
    rotationHours: 655.72,
    tiltDeg: 6.68,
    orbitKm: 384400,
    orbitDays: 27.321661,
    orbitInclDeg: 5.145,
    // Real LOLA topography carries everything down to about 1.3 km; procedural
    // craters take over below that.
    dem: true,
    craterFreq: 1300,
    craterOctaves: 6,
    craterDepth: 0.2,
    craterDensity: 0.6,
    roughness: 0.06,
    photometry: 1,
    albedoBoost: 1.0,
  },
  {
    key: 'mars',
    name: 'Mars',
    parent: 'sun',
    radiusKm: 3389.5,
    flattening: 0.00589,
    rotationHours: 24.6229,
    tiltDeg: 25.19,
    craterFreq: 420,
    craterOctaves: 6,
    craterDepth: 0.16,
    craterDensity: 0.4,
    roughness: 0.14,
    photometry: 0.75,
    albedoBoost: 1.2,
    // Mars's twilight is brighter than its half-percent of an atmosphere has any
    // right to be, because most of what lights it is suspended dust rather than
    // gas, and dust is not modelled. Lifting the sky term is the honest way to
    // stand in for it: the shape of the glow — a pale blue lobe hugging the sun,
    // the opposite way round from Earth — comes out of the scattering either
    // way, and only its brightness is being made up.
    atmosphere: { height: 0.008, density: 0.5, tint: [0.85, 0.62, 0.45], skyBrightness: 9 },
  },
  {
    key: 'jupiter',
    name: 'Jupiter',
    parent: 'sun',
    radiusKm: 69911,
    flattening: 0.06487,
    rotationHours: 9.925,
    tiltDeg: 3.13,
    craterOctaves: 0,
    roughness: 0,
    photometry: 0,
    albedoBoost: 1.15,
    polarSmooth: 1,
    atmosphere: { height: 0.02, density: 1.1, tint: [0.85, 0.78, 0.68] },
  },
  {
    key: 'io',
    name: 'Io',
    parent: 'jupiter',
    radiusKm: 1821.6,
    rotationHours: 42.46,
    orbitKm: 421700,
    orbitDays: 1.769138,
    craterFreq: 300,
    craterOctaves: 3,
    craterDepth: 0.09,
    craterDensity: 0.18,
    roughness: 0.1,
    photometry: 0.8,
    albedoBoost: 1.25,
  },
  {
    key: 'europa',
    name: 'Europa',
    parent: 'jupiter',
    radiusKm: 1560.8,
    rotationHours: 85.23,
    orbitKm: 671034,
    orbitDays: 3.551181,
    // Europa is famously smooth; almost no vertical relief.
    craterFreq: 500,
    craterOctaves: 2,
    craterDepth: 0.04,
    craterDensity: 0.08,
    roughness: 0.03,
    photometry: 0.5,
    albedoBoost: 1.8,
    // The lineae, which are the whole character of this surface: a dense global
    // network of double ridges, stained darker than the ice they cut through.
    fractureFreq: 120,
    fractureOctaves: 5,
    fractureDepth: 0.05,
    fractureWidth: 0.07,
    fractureTint: -0.22,
    iceLatitude: 0.15,
    surfaceClass: 'ice',
  },
  {
    key: 'ganymede',
    name: 'Ganymede',
    parent: 'jupiter',
    radiusKm: 2634.1,
    rotationHours: 171.71,
    orbitKm: 1070412,
    orbitDays: 7.15455,
    craterFreq: 420,
    craterOctaves: 5,
    craterDepth: 0.13,
    craterDensity: 0.42,
    roughness: 0.07,
    photometry: 0.85,
    albedoBoost: 1.3,
    // Grooved terrain: parallel sets of ridges and troughs covering two thirds
    // of the surface, formed where the older dark crust was pulled apart.
    fractureFreq: 150,
    fractureOctaves: 4,
    fractureDepth: 0.07,
    fractureWidth: 0.1,
    fractureTint: 0.1,
  },
  {
    key: 'callisto',
    name: 'Callisto',
    parent: 'jupiter',
    radiusKm: 2410.3,
    rotationHours: 400.54,
    orbitKm: 1882709,
    orbitDays: 16.6890184,
    // The most heavily cratered surface in the solar system.
    craterFreq: 380,
    craterOctaves: 6,
    craterDepth: 0.2,
    craterDensity: 0.7,
    roughness: 0.05,
    photometry: 1,
    albedoBoost: 1.45,
  },
  {
    key: 'saturn',
    name: 'Saturn',
    parent: 'sun',
    radiusKm: 58232,
    flattening: 0.09796,
    rotationHours: 10.55,
    tiltDeg: 26.73,
    craterOctaves: 0,
    roughness: 0,
    photometry: 0,
    albedoBoost: 1.25,
    polarSmooth: 1,
    atmosphere: { height: 0.02, density: 1.0, tint: [0.9, 0.82, 0.66] },
    rings: { innerKm: 74500, outerKm: 140220 },
  },
  {
    key: 'titan',
    name: 'Titan',
    parent: 'saturn',
    radiusKm: 2574.7,
    rotationHours: 382.68,
    orbitKm: 1221870,
    orbitDays: 15.945,
    craterFreq: 300,
    craterOctaves: 3,
    craterDepth: 0.06,
    craterDensity: 0.12,
    roughness: 0.08,
    photometry: 0.3,
    albedoBoost: 1.3,
    atmosphere: { height: 0.06, density: 2.2, tint: [0.92, 0.68, 0.35] },
    iceLatitude: 0.78,
    surfaceClass: 'tholin',
  },
  {
    key: 'enceladus',
    name: 'Enceladus',
    parent: 'saturn',
    radiusKm: 252.1,
    rotationHours: 32.885,
    orbitKm: 237948,
    orbitDays: 1.370218,
    // Resurfaced by its own plumbing: the south polar terrain is younger than
    // anything else in the outer system, so craters are sparse and shallow.
    craterFreq: 380,
    craterOctaves: 3,
    craterDepth: 0.07,
    craterDensity: 0.14,
    roughness: 0.05,
    photometry: 0.6,
    // Geometric albedo 1.4, the brightest surface in the solar system: fresh
    // snow constantly resupplied by its own plumes. It should sit close to
    // clipping in sunlight, not read as grey rock.
    albedoBoost: 3.4,
    // The tiger stripes and the fracture sets that cover most of the surface.
    // Roughly 2 km wide and 500 m deep, which is what these numbers work out to
    // on a 252 km body.
    fractureFreq: 90,
    fractureOctaves: 4,
    fractureDepth: 0.18,
    // Narrow: a fracture is a crack, and widening it past a tenth of its own
    // spacing turns the network into a labyrinth of fat worms.
    fractureWidth: 0.07,
    fractureTint: 0.12,
  },
  {
    key: 'tethys',
    name: 'Tethys',
    parent: 'saturn',
    radiusKm: 531.1,
    rotationHours: 45.307,
    orbitKm: 294619,
    orbitDays: 1.887802,
    craterFreq: 300,
    craterOctaves: 6,
    craterDepth: 0.18,
    craterDensity: 0.6,
    roughness: 0.06,
    photometry: 1,
    // Albedo 1.2: clean water ice, brighter than any rocky surface.
    albedoBoost: 2.1,
    // Ithaca Chasma runs three quarters of the way around the moon, so the
    // fracture set here is coarse and deep rather than a fine network.
    fractureFreq: 34,
    fractureOctaves: 2,
    fractureDepth: 0.09,
    fractureWidth: 0.16,
  },
  {
    key: 'dione',
    name: 'Dione',
    parent: 'saturn',
    radiusKm: 561.4,
    rotationHours: 65.686,
    orbitKm: 377396,
    orbitDays: 2.736915,
    craterFreq: 320,
    craterOctaves: 6,
    craterDepth: 0.17,
    craterDensity: 0.55,
    roughness: 0.07,
    photometry: 1,
    albedoBoost: 1.9,
    // The wispy terrain: bright ice cliffs across the trailing hemisphere,
    // which Cassini showed to be tectonic scarps rather than deposits.
    fractureFreq: 70,
    fractureOctaves: 3,
    fractureDepth: 0.1,
    fractureWidth: 0.09,
    fractureTint: 0.15,
  },
  {
    key: 'rhea',
    name: 'Rhea',
    parent: 'saturn',
    radiusKm: 763.8,
    rotationHours: 108.437,
    orbitKm: 527108,
    orbitDays: 4.518212,
    // Saturation cratered: nothing has resurfaced it since the late bombardment.
    craterFreq: 340,
    craterOctaves: 6,
    craterDepth: 0.2,
    craterDensity: 0.68,
    roughness: 0.05,
    photometry: 1,
    albedoBoost: 1.9,
  },
  {
    key: 'iapetus',
    name: 'Iapetus',
    parent: 'saturn',
    radiusKm: 734.5,
    rotationHours: 1903.72,
    orbitKm: 3560820,
    orbitDays: 79.3215,
    // Far enough out, and inclined enough, that its orbit leaves Saturn's
    // equatorial plane by 15 degrees — which is why it alone sees the rings
    // open.
    orbitInclDeg: 15.47,
    craterFreq: 300,
    craterOctaves: 6,
    craterDepth: 0.2,
    craterDensity: 0.65,
    roughness: 0.09,
    photometry: 1,
    albedoBoost: 1.2,
  },
  {
    key: 'uranus',
    name: 'Uranus',
    parent: 'sun',
    radiusKm: 25362,
    flattening: 0.02293,
    rotationHours: -17.24,
    tiltDeg: 97.77,
    craterOctaves: 0,
    roughness: 0,
    photometry: 0,
    albedoBoost: 1.2,
    polarSmooth: 1,
    atmosphere: { height: 0.02, density: 1.2, tint: [0.6, 0.88, 0.92] },
  },
  {
    key: 'neptune',
    name: 'Neptune',
    parent: 'sun',
    radiusKm: 24622,
    flattening: 0.01708,
    rotationHours: 16.11,
    tiltDeg: 28.32,
    craterOctaves: 0,
    roughness: 0,
    photometry: 0,
    albedoBoost: 1.2,
    polarSmooth: 1,
    atmosphere: { height: 0.02, density: 1.3, tint: [0.42, 0.6, 1.0] },
  },
  {
    key: 'triton',
    name: 'Triton',
    parent: 'neptune',
    radiusKm: 1353.4,
    // Tidally locked, so it turns once per orbit.
    rotationHours: 141.044,
    orbitKm: 354759,
    orbitDays: 5.876854,
    // Past 90 degrees, which is what makes the orbit retrograde: Triton goes
    // round Neptune backwards, and is almost certainly a captured Kuiper belt
    // object rather than a moon Neptune formed with.
    orbitInclDeg: 156.885,
    // Nitrogen ice, actively resurfaced by cryovolcanism. Craters are rare and
    // the cantaloupe terrain is broad and low rather than sharp.
    craterFreq: 400,
    craterOctaves: 3,
    craterDepth: 0.06,
    craterDensity: 0.12,
    roughness: 0.09,
    photometry: 0.5,
    // Nitrogen frost, albedo around 0.75.
    albedoBoost: 1.7,
    // Cantaloupe terrain: a dimpled, ridged surface found nowhere else, thought
    // to come from blobs of dense ice sinking through lighter ice. Broad and
    // shallow rather than sharp, so the troughs are wide and the relief low.
    fractureFreq: 55,
    fractureOctaves: 3,
    fractureDepth: 0.06,
    fractureWidth: 0.3,
    atmosphere: { height: 0.02, density: 0.25, tint: [0.85, 0.9, 1.0] },
  },
  {
    key: 'pluto',
    name: 'Pluto',
    parent: 'sun',
    radiusKm: 1188.3,
    rotationHours: 153.2935,
    tiltDeg: 122.53,
    orbitOverride: { aAu: 39.482, eccentricity: 0.2488, inclDeg: 17.16, periodDays: 90560 },
    // Half nitrogen-ice plain and half ancient cratered upland, which no single
    // set of crater parameters can express; these sit between the two.
    craterFreq: 260,
    craterOctaves: 5,
    craterDepth: 0.12,
    craterDensity: 0.35,
    roughness: 0.12,
    photometry: 0.7,
    albedoBoost: 1.15,
    atmosphere: { height: 0.03, density: 0.3, tint: [0.7, 0.8, 0.95] },
  },
  {
    key: 'charon',
    name: 'Charon',
    parent: 'pluto',
    radiusKm: 606,
    // Pluto and Charon are locked to each other, so both turn in the same
    // 6.39 days and each hangs fixed in the other's sky.
    rotationHours: 153.2935,
    orbitKm: 19591,
    orbitDays: 6.38723,
    craterFreq: 280,
    craterOctaves: 6,
    craterDepth: 0.18,
    craterDensity: 0.5,
    roughness: 0.1,
    photometry: 0.9,
    albedoBoost: 1.2,
    // Serenity Chasma and the belt of canyons along its equator, deeper than
    // anything of the sort on a body this size.
    fractureFreq: 40,
    fractureOctaves: 2,
    fractureDepth: 0.12,
    fractureWidth: 0.14,
  },
  {
    key: 'vesta',
    name: 'Vesta',
    parent: 'sun',
    radiusKm: 262.7,
    rotationHours: 5.342,
    tiltDeg: 29,
    orbitOverride: { aAu: 2.3617, eccentricity: 0.0887, inclDeg: 7.14, periodDays: 1325.75 },
    // The Rheasilvia impact took most of the southern hemisphere with it, so
    // the largest craters here are a substantial fraction of the body.
    craterFreq: 180,
    craterOctaves: 6,
    craterDepth: 0.22,
    craterDensity: 0.7,
    roughness: 0.14,
    photometry: 1,
    albedoBoost: 1.5,
    irregular: 0.08,
    macroRelief: 0.012,
  },
  {
    key: 'ceres',
    name: 'Ceres',
    parent: 'sun',
    radiusKm: 473,
    rotationHours: 9.074,
    tiltDeg: 4,
    orbitOverride: { aAu: 2.7675, eccentricity: 0.0757, inclDeg: 10.593, periodDays: 1681.63 },
    craterFreq: 220,
    craterOctaves: 6,
    craterDepth: 0.2,
    craterDensity: 0.65,
    roughness: 0.08,
    photometry: 1,
    albedoBoost: 1.6,
  },
];

// The mid-sized bodies here are large enough that the procedural shape law in
// planet.js treats them as relaxed spheres, which is right for most of them and
// wrong for the handful with a resolvable figure: Io and Europa carry a tidal
// bulge, Ceres is rotationally oblate, and Iapetus and Vesta are both flattened
// far past anything their present state would produce.
applyMeasuredAxes(BODIES);

export const SOLAR_BODIES = [...BODIES, ...MOONS];
export const BODY_BY_KEY = new Map([[SUN.key, SUN], ...SOLAR_BODIES.map((b) => [b.key, b])]);
