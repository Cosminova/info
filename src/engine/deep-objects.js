import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  CustomBlending,
  CylinderGeometry,
  Data3DTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  LinearFilter,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  Points,
  Quaternion,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { equatorialToVector } from '../astro.js';
import { colorIndexToLinearRgb } from '../color.js';
import { equatorialToEcliptic, PC_KM } from './units.js';

/**
 * Nebulae, star clusters and neutron stars: the deep-sky objects you can fly
 * to, at their measured positions and sizes.
 *
 * Positions are J2000 right ascension and declination in degrees and distances
 * in parsecs; radii are physical, in parsecs, roughly half the extent the
 * object is usually quoted at. The look of each is procedural, set by its type
 * and a few colours, so these are recognisable kinds rather than portraits.
 */

const HA = [1.0, 0.16, 0.24];
const OIII = [0.12, 0.85, 0.78];
const SII = [1.0, 0.42, 0.18];
const BLUE = [0.35, 0.55, 1.0];
const ORANGE = [1.0, 0.46, 0.16];
const GOLD = [1.0, 0.78, 0.42];
const CREAM = [1.0, 0.9, 0.7];
const VIOLET = [0.62, 0.36, 1.0];
const GREEN = [0.35, 1.0, 0.55];
const PINK = [1.0, 0.36, 0.55];

/*
 * The famous ones, by hand.
 *
 * `shape` picks a structure within the type: for emission and dark nebulae 1
 * means pillars, columns of dust eaten away by the starlight (the Eagle's, the
 * Horsehead's). For planetary nebulae `bipolar` is how far the shell is drawn
 * into two lobes and `cavity` how fat they are. `look` draws one type with
 * another's shader where the physics is close enough — a Wolf–Rayet bubble is
 * a shell like a supernova's — and `label` names what it is.
 */
export const NEBULAE = [
  { key: 'm42', name: 'Orion Nebula', type: 'emission', ra: 83.822, dec: -5.391, distPc: 412, radiusPc: 4, colours: [HA, OIII, BLUE], cavity: 0.6 },
  { key: 'm16', name: 'Eagle Nebula', type: 'emission', ra: 274.7, dec: -13.807, distPc: 1740, radiusPc: 9, colours: [ORANGE, GOLD, SII], cavity: 0.4, shape: 1 },
  { key: 'm17', name: 'Omega Nebula', type: 'emission', ra: 275.196, dec: -16.171, distPc: 1700, radiusPc: 7, colours: [ORANGE, CREAM, HA], cavity: 0.3 },
  { key: 'm8', name: 'Lagoon Nebula', type: 'emission', ra: 270.904, dec: -24.387, distPc: 1250, radiusPc: 12, colours: [HA, [1.0, 0.45, 0.6], OIII], cavity: 0.3 },
  { key: 'm20', name: 'Trifid Nebula', type: 'emission', ra: 270.6, dec: -23.03, distPc: 1560, radiusPc: 6, colours: [HA, BLUE, OIII], cavity: 0.5 },
  { key: 'ngc3372', name: 'Carina Nebula', type: 'emission', ra: 161.265, dec: -59.867, distPc: 2300, radiusPc: 40, colours: [ORANGE, GOLD, HA], cavity: 0.3, shape: 1 },
  { key: 'ngc2237', name: 'Rosette Nebula', type: 'emission', ra: 97.98, dec: 4.95, distPc: 1600, radiusPc: 20, colours: [HA, [1.0, 0.5, 0.4], OIII], cavity: 1 },
  { key: 'ngc7000', name: 'North America Nebula', type: 'emission', ra: 314.7, dec: 44.3, distPc: 590, radiusPc: 15, colours: [HA, SII, OIII], cavity: 0.1 },
  { key: 'ic5070', name: 'Pelican Nebula', type: 'emission', ra: 312.75, dec: 44.37, distPc: 600, radiusPc: 4, colours: [HA, GOLD, OIII], cavity: 0.2, shape: 1 },
  { key: '30dor', name: 'Tarantula Nebula', type: 'emission', ra: 84.676, dec: -69.101, distPc: 49970, radiusPc: 100, colours: [HA, OIII, [0.9, 0.5, 1.0]], cavity: 0.7 },
  { key: 'ic1805', name: 'Heart Nebula', type: 'emission', ra: 38.2, dec: 61.45, distPc: 2300, radiusPc: 23, colours: [HA, PINK, SII], cavity: 0.9 },
  { key: 'ic1848', name: 'Soul Nebula', type: 'emission', ra: 42.8, dec: 60.4, distPc: 2000, radiusPc: 20, colours: [HA, CREAM, SII], cavity: 0.8, shape: 1 },
  { key: 'ngc2024', name: 'Flame Nebula', type: 'emission', ra: 85.42, dec: -1.85, distPc: 420, radiusPc: 1.5, colours: [ORANGE, GOLD, [0.6, 0.2, 0.1]], cavity: 0.2 },
  { key: 'ngc2264', name: 'Cone Nebula', type: 'emission', ra: 100.25, dec: 9.9, distPc: 760, radiusPc: 4, colours: [HA, BLUE, PINK], cavity: 0.4, shape: 1 },
  { key: 'ngc7635', name: 'Bubble Nebula', type: 'emission', ra: 350.2, dec: 61.2, distPc: 2400, radiusPc: 3, colours: [HA, OIII, GOLD], cavity: 1 },
  { key: 'ic1396', name: "Elephant's Trunk Nebula", type: 'emission', ra: 324.7, dec: 57.5, distPc: 870, radiusPc: 15, colours: [HA, GOLD, SII], cavity: 0.6, shape: 1 },
  { key: 'ngc6334', name: "Cat's Paw Nebula", type: 'emission', ra: 260.2, dec: -35.97, distPc: 1300, radiusPc: 8, colours: [HA, PINK, ORANGE], cavity: 0.3 },
  { key: 'ngc6357', name: 'Lobster Nebula', type: 'emission', ra: 261.2, dec: -34.2, distPc: 1700, radiusPc: 7, colours: [ORANGE, CREAM, HA], cavity: 0.5, shape: 1 },
  { key: 'ngc1499', name: 'California Nebula', type: 'emission', ra: 60.2, dec: 36.4, distPc: 300, radiusPc: 7, colours: [HA, PINK, HA], cavity: 0 },
  { key: 'ic4628', name: 'Prawn Nebula', type: 'emission', ra: 254.2, dec: -40.4, distPc: 1800, radiusPc: 8, colours: [HA, ORANGE, OIII], cavity: 0.4 },
  { key: 'ic2944', name: 'Running Chicken Nebula', type: 'emission', ra: 174.4, dec: -63.0, distPc: 1800, radiusPc: 10, colours: [HA, PINK, OIII], cavity: 0.5 },
  { key: 'ngc7380', name: 'Wizard Nebula', type: 'emission', ra: 341.8, dec: 58.1, distPc: 2200, radiusPc: 5, colours: [HA, GOLD, OIII], cavity: 0.6, shape: 1 },
  { key: 'ngc2174', name: 'Monkey Head Nebula', type: 'emission', ra: 92.3, dec: 20.5, distPc: 2100, radiusPc: 7, colours: [ORANGE, GOLD, OIII], cavity: 0.5, shape: 1 },
  { key: 'ic2177', name: 'Seagull Nebula', type: 'emission', ra: 106.0, dec: -10.6, distPc: 1100, radiusPc: 15, colours: [HA, PINK, BLUE], cavity: 0.2 },
  { key: 'rcw49', name: 'RCW 49', type: 'emission', ra: 156.0, dec: -57.76, distPc: 4200, radiusPc: 15, colours: [ORANGE, OIII, VIOLET], cavity: 0.8, shape: 1 },
  { key: 'ngc3603', name: 'NGC 3603', type: 'emission', ra: 168.79, dec: -61.26, distPc: 7000, radiusPc: 10, colours: [ORANGE, CREAM, HA], cavity: 0.8, shape: 1 },
  { key: 'ngc604', name: 'NGC 604', type: 'emission', ra: 23.65, dec: 30.78, distPc: 840000, radiusPc: 230, colours: [HA, OIII, PINK], cavity: 0.7 },
  { key: 'barnard-loop', name: "Barnard's Loop", type: 'emission', look: 'remnant', ra: 86.0, dec: -1.0, distPc: 440, radiusPc: 45, colours: [HA, HA, SII] },
  { key: 'ngc6888', name: 'Crescent Nebula', type: 'emission', look: 'remnant', label: 'Wolf\u2013Rayet wind bubble', ra: 303.03, dec: 38.35, distPc: 1500, radiusPc: 3.5, colours: [HA, OIII, GOLD] },
  { key: 'ngc2359', name: "Thor's Helmet", type: 'emission', look: 'remnant', label: 'Wolf\u2013Rayet wind bubble', ra: 109.3, dec: -13.2, distPc: 3670, radiusPc: 4, colours: [OIII, HA, BLUE] },
  { key: 'm57', name: 'Ring Nebula', type: 'planetary', ra: 283.396, dec: 33.029, distPc: 790, radiusPc: 0.25, colours: [HA, OIII, [0.95, 0.85, 0.3]] },
  { key: 'ngc7293', name: 'Helix Nebula', type: 'planetary', ra: 337.411, dec: -20.837, distPc: 200, radiusPc: 0.45, colours: [HA, OIII, [1.0, 0.6, 0.3]] },
  { key: 'm27', name: 'Dumbbell Nebula', type: 'planetary', ra: 299.902, dec: 22.721, distPc: 417, radiusPc: 0.7, colours: [HA, OIII, [0.6, 1.0, 0.5]], bipolar: 0.4 },
  { key: 'ngc6543', name: "Cat's Eye Nebula", type: 'planetary', ra: 269.639, dec: 66.633, distPc: 1000, radiusPc: 0.12, colours: [HA, OIII, BLUE], bipolar: 0.35 },
  { key: 'ngc6302', name: 'Butterfly Nebula', type: 'planetary', ra: 258.435, dec: -37.103, distPc: 1040, radiusPc: 0.3, colours: [[1.0, 0.5, 0.3], CREAM, VIOLET], bipolar: 1, cavity: 0.55 },
  { key: 'ngc6537', name: 'Red Spider Nebula', type: 'planetary', ra: 271.086, dec: -19.84, distPc: 1900, radiusPc: 0.15, colours: [ORANGE, CREAM, [0.8, 0.2, 0.1]], bipolar: 1, cavity: 0.9 },
  { key: 'm2-9', name: 'Twin Jet Nebula', type: 'planetary', ra: 260.89, dec: -10.14, distPc: 650, radiusPc: 0.1, colours: [VIOLET, GREEN, PINK], bipolar: 1, cavity: 0.05 },
  { key: 'mz3', name: 'Ant Nebula', type: 'planetary', ra: 244.97, dec: -51.98, distPc: 2500, radiusPc: 0.25, colours: [PINK, CREAM, VIOLET], bipolar: 1, cavity: 0.4 },
  { key: 'boomerang', name: 'Boomerang Nebula', type: 'planetary', label: 'Pre-planetary nebula', ra: 193.6, dec: -54.52, distPc: 1500, radiusPc: 0.1, colours: [BLUE, CREAM, BLUE], bipolar: 1, cavity: 0.3 },
  { key: 'ngc2392', name: 'Eskimo Nebula', type: 'planetary', ra: 112.29, dec: 20.91, distPc: 1300, radiusPc: 0.1, colours: [[1.0, 0.35, 0.2], [0.55, 0.9, 1.0], [0.85, 0.5, 0.35]] },
  { key: 'ngc3242', name: 'Ghost of Jupiter', type: 'planetary', ra: 156.19, dec: -18.64, distPc: 1400, radiusPc: 0.13, colours: [PINK, OIII, BLUE], bipolar: 0.3 },
  { key: 'ngc7009', name: 'Saturn Nebula', type: 'planetary', ra: 316.04, dec: -11.36, distPc: 1400, radiusPc: 0.12, colours: [HA, OIII, GOLD], bipolar: 0.45 },
  { key: 'm97', name: 'Owl Nebula', type: 'planetary', ra: 168.7, dec: 55.02, distPc: 620, radiusPc: 0.28, colours: [[0.9, 0.3, 0.3], OIII, HA] },
  { key: 'm76', name: 'Little Dumbbell Nebula', type: 'planetary', ra: 25.58, dec: 51.58, distPc: 780, radiusPc: 0.4, colours: [HA, OIII, PINK], bipolar: 0.8, cavity: 0.7 },
  { key: 'ngc3132', name: 'Southern Ring Nebula', type: 'planetary', ra: 151.76, dec: -40.44, distPc: 750, radiusPc: 0.2, colours: [ORANGE, OIII, HA], bipolar: 0.2 },
  { key: 'ic418', name: 'Spirograph Nebula', type: 'planetary', ra: 81.86, dec: -12.7, distPc: 1300, radiusPc: 0.06, colours: [[1.0, 0.45, 0.25], OIII, GOLD], bipolar: 0.25 },
  { key: 'abell21', name: 'Medusa Nebula', type: 'planetary', ra: 112.26, dec: 13.25, distPc: 450, radiusPc: 0.6, colours: [HA, OIII, PINK], bipolar: 0.15 },
  { key: 'homunculus', name: 'Homunculus Nebula', type: 'planetary', label: 'Ejecta of Eta Carinae', ra: 161.265, dec: -59.684, distPc: 2300, radiusPc: 0.1, colours: [[1.0, 0.6, 0.35], CREAM, HA], bipolar: 1, cavity: 0.85 },
  { key: 'sn1987a', name: 'SN 1987A', type: 'remnant', look: 'planetary', ra: 83.866, dec: -69.27, distPc: 51400, radiusPc: 0.2, colours: [HA, CREAM, GOLD], bipolar: 0.5 },
  { key: 'm1', name: 'Crab Nebula', type: 'plerion', ra: 83.633, dec: 22.0145, distPc: 2000, radiusPc: 1.7, colours: [SII, [0.45, 0.6, 1.0], HA] },
  { key: '3c58', name: '3C 58', type: 'plerion', ra: 31.4, dec: 64.83, distPc: 3200, radiusPc: 2.5, colours: [ORANGE, BLUE, HA] },
  { key: 'veil', name: 'Veil Nebula', type: 'remnant', ra: 312.75, dec: 30.7, distPc: 735, radiusPc: 18, colours: [HA, OIII, BLUE] },
  { key: 'cas-a', name: 'Cassiopeia A', type: 'remnant', ra: 350.85, dec: 58.815, distPc: 3400, radiusPc: 1.6, colours: [[0.4, 1.0, 0.5], HA, BLUE] },
  { key: 'vela-snr', name: 'Vela Supernova Remnant', type: 'remnant', ra: 128.5, dec: -45.5, distPc: 287, radiusPc: 18, colours: [HA, OIII, BLUE] },
  { key: 'tycho', name: "Tycho's Supernova Remnant", type: 'remnant', ra: 6.33, dec: 64.14, distPc: 2500, radiusPc: 3.7, colours: [GOLD, BLUE, HA] },
  { key: 'kepler', name: "Kepler's Supernova Remnant", type: 'remnant', ra: 262.67, dec: -21.49, distPc: 5100, radiusPc: 2.6, colours: [GOLD, [0.5, 0.7, 1.0], HA] },
  { key: 'sn1006', name: 'SN 1006', type: 'remnant', ra: 225.7, dec: -41.9, distPc: 2200, radiusPc: 9.5, colours: [BLUE, HA, CREAM] },
  { key: 'puppis-a', name: 'Puppis A', type: 'remnant', ra: 125.5, dec: -43.0, distPc: 2200, radiusPc: 16, colours: [HA, OIII, GOLD] },
  { key: 'simeis147', name: 'Spaghetti Nebula', type: 'remnant', ra: 85.0, dec: 27.8, distPc: 1200, radiusPc: 16, colours: [HA, PINK, HA] },
  { key: 'ic443', name: 'Jellyfish Nebula', type: 'remnant', ra: 94.25, dec: 22.53, distPc: 1500, radiusPc: 10, colours: [HA, OIII, VIOLET] },
  { key: 'rcw86', name: 'RCW 86', type: 'remnant', ra: 220.7, dec: -62.5, distPc: 2500, radiusPc: 15, colours: [HA, BLUE, GOLD] },
  { key: 'w50', name: 'Manatee Nebula (W50)', type: 'remnant', ra: 287.95, dec: 4.98, distPc: 5500, radiusPc: 50, colours: [HA, BLUE, VIOLET] },
  { key: 'ic2118', name: 'Witch Head Nebula', type: 'reflection', ra: 76.5, dec: -7.2, distPc: 270, radiusPc: 7, colours: [BLUE, [0.6, 0.75, 1.0], BLUE] },
  { key: 'm45-neb', name: 'Pleiades Nebulosity', type: 'reflection', ra: 56.75, dec: 24.1167, distPc: 136, radiusPc: 2.5, colours: [BLUE, [0.7, 0.8, 1.0], BLUE] },
  { key: 'ngc7023', name: 'Iris Nebula', type: 'reflection', ra: 315.4, dec: 68.17, distPc: 430, radiusPc: 1.0, colours: [BLUE, CREAM, BLUE] },
  { key: 'm78', name: 'M78', type: 'reflection', ra: 86.69, dec: 0.08, distPc: 420, radiusPc: 1.2, colours: [BLUE, [0.7, 0.8, 1.0], VIOLET] },
  { key: 'ngc1977', name: 'Running Man Nebula', type: 'reflection', ra: 83.85, dec: -4.82, distPc: 420, radiusPc: 1.8, colours: [BLUE, [0.7, 0.8, 1.0], HA] },
  { key: 'rho-oph', name: 'Rho Ophiuchi Cloud Complex', type: 'reflection', ra: 246.8, dec: -24.5, distPc: 140, radiusPc: 4, colours: [GOLD, BLUE, HA] },
  { key: 'b33', name: 'Horsehead Nebula', type: 'dark', ra: 85.24, dec: -2.46, distPc: 422, radiusPc: 1.2, colours: [[0.5, 0.25, 0.2], HA, HA], shape: 1 },
  { key: 'coalsack', name: 'Coalsack Nebula', type: 'dark', ra: 191.0, dec: -62.9, distPc: 180, radiusPc: 6, colours: [[0.3, 0.22, 0.2], HA, HA] },
  { key: 'b68', name: 'Barnard 68', type: 'dark', ra: 260.67, dec: -23.83, distPc: 150, radiusPc: 0.1, colours: [[0.3, 0.22, 0.2], [0.5, 0.3, 0.2], HA] },
  { key: 'pipe', name: 'Pipe Nebula', type: 'dark', ra: 262.5, dec: -27.0, distPc: 130, radiusPc: 5, colours: [[0.3, 0.22, 0.2], [0.6, 0.4, 0.3], HA] },
];

/*
 * The catalogues give a nebula's place, size and kind but not how it looks,
 * so each one is dressed from a palette of what that kind looks like: Hα red
 * through the orange and gold of a SpaceEngine-style render for H II regions,
 * the oxygen-blue centres and red rims of planetaries.
 */
const EMISSION_PALETTES = [
  [HA, OIII, SII],
  [ORANGE, CREAM, HA],
  [HA, PINK, BLUE],
  [ORANGE, OIII, [0.9, 0.25, 0.15]],
  [[0.95, 0.12, 0.12], GOLD, [0.6, 0.1, 0.25]],
  [PINK, [0.9, 0.7, 1.0], HA],
];
const PLANETARY_PALETTES = [
  [HA, OIII, GOLD],
  [[1.0, 0.35, 0.2], [0.5, 0.9, 1.0], [0.95, 0.6, 0.4]],
  [VIOLET, GREEN, PINK],
  [ORANGE, CREAM, [0.9, 0.3, 0.15]],
  [[0.3, 0.6, 1.0], [0.6, 1.0, 0.9], [1.0, 0.3, 0.35]],
  [PINK, OIII, VIOLET],
];
const PN_SHAPES = { bipolar: 1, elliptical: 0.35, irregular: 0.15, round: 0, stellar: 0 };

/**
 * Surface brightness relative to a bright H II region. The great nearby shells
 * span tens of degrees of our sky and are so faint that it took long-exposure
 * plates to find them at all; drawn at Orion's brightness they would bury the
 * view from Earth.
 */
const FAINT = {
  'barnard-loop': 0.12,
  'vela-snr': 0.22,
  simeis147: 0.25,
  w50: 0.3,
  ic2118: 0.3,
  rcw86: 0.4,
  veil: 0.45,
  'puppis-a': 0.45,
  ngc1499: 0.45,
  ic1396: 0.5,
  ic2177: 0.5,
  ngc7000: 0.55,
};

function dressNebula(entry) {
  const rnd = random(hashKey(entry.key));
  const pick = (list) => list[Math.floor(rnd() * list.length) % list.length];
  if (entry.type === 'planetary') {
    return {
      ...entry,
      // A few catalogue sizes are the faint outer halo, or a bad distance
      // turning arcseconds into tens of parsecs; no planetary is that big.
      radiusPc: Math.min(entry.radiusPc, 1),
      faint: 0.8,
      colours: pick(PLANETARY_PALETTES),
      bipolar: PN_SHAPES[entry.shape] ?? 0,
      cavity: rnd(),
      shape: 0,
    };
  }
  return {
    ...entry,
    // WISE measures the warm-dust bubble, which reaches well past the glowing gas.
    radiusPc: entry.radiusPc * 0.7,
    faint: 0.5,
    colours: pick(EMISSION_PALETTES),
    cavity: 0.15 + rnd() * 0.8,
    shape: rnd() < 0.35 ? 1 : 0,
  };
}

export const CLUSTERS = [
  { key: 'm45', name: 'Pleiades', type: 'open', ra: 56.75, dec: 24.1167, distPc: 136, radiusPc: 4, stars: 1000, ageMyr: 110 },
  { key: 'hyades', name: 'Hyades', type: 'open', ra: 66.75, dec: 15.87, distPc: 47, radiusPc: 5, stars: 450, ageMyr: 625 },
  { key: 'm44', name: 'Beehive Cluster', type: 'open', ra: 130.1, dec: 19.67, distPc: 187, radiusPc: 3.5, stars: 1000, ageMyr: 600 },
  { key: 'ngc869', name: 'Double Cluster (h Persei)', type: 'open', ra: 34.75, dec: 57.13, distPc: 2300, radiusPc: 10, stars: 2500, ageMyr: 13 },
  { key: 'ngc884', name: 'Double Cluster (\u03c7 Persei)', type: 'open', ra: 35.6, dec: 57.15, distPc: 2300, radiusPc: 10, stars: 2500, ageMyr: 13 },
  { key: 'ngc4755', name: 'Jewel Box', type: 'open', ra: 193.4, dec: -60.33, distPc: 1976, radiusPc: 3, stars: 900, ageMyr: 14 },
  { key: 'm11', name: 'Wild Duck Cluster', type: 'open', ra: 282.77, dec: -6.27, distPc: 1900, radiusPc: 3, stars: 2900, ageMyr: 250 },
  { key: 'wd1', name: 'Westerlund 1', type: 'open', ra: 251.77, dec: -45.85, distPc: 3900, radiusPc: 1.5, stars: 4000, ageMyr: 4 },
  { key: 'r136', name: 'R136', type: 'open', ra: 84.676, dec: -69.101, distPc: 49970, radiusPc: 2.5, stars: 5000, ageMyr: 1.5 },
  { key: 'ngc5139', name: 'Omega Centauri', type: 'globular', ra: 201.697, dec: -47.479, distPc: 5430, radiusPc: 25, stars: 90000, core: 0.24 },
  { key: 'ngc104', name: '47 Tucanae', type: 'globular', ra: 6.024, dec: -72.081, distPc: 4450, radiusPc: 20, stars: 70000, core: 0.15 },
  { key: 'm13', name: 'Hercules Cluster (M13)', type: 'globular', ra: 250.42, dec: 36.46, distPc: 6800, radiusPc: 20, stars: 60000, core: 0.12 },
  { key: 'm15', name: 'M15', type: 'globular', ra: 322.493, dec: 12.167, distPc: 10400, radiusPc: 18, stars: 50000, core: 0.09 },
  { key: 'm3', name: 'M3', type: 'globular', ra: 205.548, dec: 28.377, distPc: 10200, radiusPc: 27, stars: 50000, core: 0.1 },
  { key: 'm4', name: 'M4', type: 'globular', ra: 245.897, dec: -26.526, distPc: 2200, radiusPc: 11, stars: 30000, core: 0.22 },
  { key: 'm22', name: 'M22', type: 'globular', ra: 279.1, dec: -23.9, distPc: 3200, radiusPc: 15, stars: 45000, core: 0.18 },
  { key: 'trapezium', name: 'Trapezium Cluster', type: 'open', ra: 83.82, dec: -5.39, distPc: 412, radiusPc: 0.6, stars: 900, ageMyr: 0.5 },
  { key: 'arches', name: 'Arches Cluster', type: 'open', ra: 266.46, dec: -28.82, distPc: 8000, radiusPc: 0.5, stars: 3000, ageMyr: 2.5 },
  { key: 'quintuplet', name: 'Quintuplet Cluster', type: 'open', ra: 266.56, dec: -28.83, distPc: 8000, radiusPc: 1, stars: 2000, ageMyr: 4 },
  { key: 'wd2', name: 'Westerlund 2', type: 'open', ra: 156.0, dec: -57.76, distPc: 4200, radiusPc: 1.5, stars: 3000, ageMyr: 2 },
  { key: 'hd97950', name: 'NGC 3603 Cluster', type: 'open', ra: 168.79, dec: -61.26, distPc: 7000, radiusPc: 1.5, stars: 3000, ageMyr: 1 },
  { key: 'pismis24', name: 'Pismis 24', type: 'open', ra: 261.19, dec: -34.2, distPc: 1700, radiusPc: 1, stars: 800, ageMyr: 1 },
];

export const NEUTRON_STARS = [
  { key: 'crab-pulsar', name: 'Crab Pulsar', type: 'pulsar', ra: 83.633, dec: 22.0145, distPc: 2000, periodS: 0.0337 },
  { key: 'vela-pulsar', name: 'Vela Pulsar', type: 'pulsar', ra: 128.836, dec: -45.176, distPc: 287, periodS: 0.0893 },
  { key: 'geminga', name: 'Geminga', type: 'pulsar', ra: 98.476, dec: 17.77, distPc: 250, periodS: 0.237 },
  { key: 'psr-b1919', name: 'PSR B1919+21', type: 'pulsar', ra: 290.4375, dec: 21.8836, distPc: 300, periodS: 1.337 },
  { key: 'psr-b1913', name: 'Hulse\u2013Taylor Pulsar', type: 'pulsar', ra: 288.867, dec: 16.107, distPc: 6400, periodS: 0.059 },
  { key: 'psr-j0437', name: 'PSR J0437\u22124715', type: 'millisecond', ra: 69.316, dec: -47.252, distPc: 156.3, periodS: 0.005757 },
  { key: 'psr-j1748', name: 'PSR J1748\u22122446ad', type: 'millisecond', ra: 267.02, dec: -24.78, distPc: 5900, periodS: 0.001396 },
  { key: 'rxj1856', name: 'RX J1856.5\u22123754', type: 'isolated', ra: 284.15, dec: -37.91, distPc: 123, periodS: 7.06 },
  { key: 'sgr1806', name: 'SGR 1806\u221220', type: 'magnetar', ra: 272.164, dec: -20.411, distPc: 8700, periodS: 7.6 },
  { key: 'sgr1900', name: 'SGR 1900+14', type: 'magnetar', ra: 286.81, dec: 9.32, distPc: 12500, periodS: 5.2 },
  { key: 'xte1810', name: 'XTE J1810\u2212197', type: 'magnetar', ra: 272.46, dec: -19.73, distPc: 3500, periodS: 5.54 },
];

export const NEUTRON_STAR_RADIUS_KM = 12;

export const NEBULA_LABELS = {
  emission: 'Emission nebula',
  planetary: 'Planetary nebula',
  remnant: 'Supernova remnant',
  plerion: 'Pulsar wind nebula',
  reflection: 'Reflection nebula',
  dark: 'Dark nebula',
};
export const CLUSTER_LABELS = { open: 'Open cluster', globular: 'Globular cluster' };
export const NEUTRON_LABELS = {
  pulsar: 'Pulsar',
  millisecond: 'Millisecond pulsar',
  magnetar: 'Magnetar',
  isolated: 'Isolated neutron star',
};

export function deepObjectWorld(spec, out = new Vector3()) {
  equatorialToVector(spec.ra, spec.dec, out);
  equatorialToEcliptic(out);
  return out.multiplyScalar(spec.distPc * PC_KM);
}

function hashKey(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

function random(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random orientation, fixed per object. */
function orientation(rnd) {
  const u1 = rnd(), u2 = rnd(), u3 = rnd();
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return new Quaternion(a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2), b * Math.sin(2 * Math.PI * u3), b * Math.cos(2 * Math.PI * u3));
}

// ------------------------------------------------------------------ nebulae

/**
 * Tileable value noise, four independent channels, 64³. Sampled in hardware a
 * whole octave costs one fetch, which is what makes ray-marching a cloud at
 * full resolution affordable.
 */
function noiseTexture(size = 64, cells = 8) {
  const rnd = random(1234567);
  const lattice = new Float32Array(cells * cells * cells * 4);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
  const data = new Uint8Array(size * size * size * 4);
  const smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const at = (x, y, z, c) => lattice[(((z % cells) * cells + (y % cells)) * cells + (x % cells)) * 4 + c];
  let o = 0;
  for (let z = 0; z < size; z++) {
    const fz = (z / size) * cells, iz = Math.floor(fz), tz = smooth(fz - iz);
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * cells, iy = Math.floor(fy), ty = smooth(fy - iy);
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells, ix = Math.floor(fx), tx = smooth(fx - ix);
        for (let c = 0; c < 4; c++) {
          const a = at(ix, iy, iz, c) + (at(ix + 1, iy, iz, c) - at(ix, iy, iz, c)) * tx;
          const b = at(ix, iy + 1, iz, c) + (at(ix + 1, iy + 1, iz, c) - at(ix, iy + 1, iz, c)) * tx;
          const d = at(ix, iy, iz + 1, c) + (at(ix + 1, iy, iz + 1, c) - at(ix, iy, iz + 1, c)) * tx;
          const e = at(ix, iy + 1, iz + 1, c) + (at(ix + 1, iy + 1, iz + 1, c) - at(ix, iy + 1, iz + 1, c)) * tx;
          const lower = a + (b - a) * ty;
          const upper = d + (e - d) * ty;
          data[o++] = Math.round((lower + (upper - lower) * tz) * 255);
        }
      }
    }
  }
  const texture = new Data3DTexture(data, size, size, size);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

const NEBULA_TYPES = { emission: 0, planetary: 1, remnant: 2, plerion: 3, reflection: 4, dark: 5 };

const NEBULA_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const NEBULA_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler3D;
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler3D uNoise;
  uniform vec3 uCamera;
  uniform float uType;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColC;
  uniform vec3 uSeed;
  uniform vec3 uAxis;
  uniform float uBright;
  uniform float uCavity;
  uniform float uBipolar;
  uniform float uShape;
  uniform float uSteps;
  varying vec3 vLocal;

  float fbm(vec3 p) {
    float sum = 0.0, amp = 0.5;
    for (int i = 0; i < 5; i++) {
      sum += amp * texture(uNoise, p).r;
      p = p * 2.03 + 0.171;
      amp *= 0.5;
    }
    return sum / 0.97;
  }

  float fbm3(vec3 p) {
    float sum = 0.0, amp = 0.5;
    for (int i = 0; i < 3; i++) {
      sum += amp * texture(uNoise, p).r;
      p = p * 2.07 + 0.29;
      amp *= 0.5;
    }
    return sum / 0.875;
  }

  // Thin bright walls where a noise field crosses its midpoint: filaments.
  float ridged(vec3 p) {
    float r = 1.0 - abs(fbm(p) * 2.0 - 1.0);
    return r * r * r * r * r;
  }

  // Emission (rgb) and extinction (a) per unit length, radius units.
  vec4 sampleCloudInner(vec3 p) {
    vec3 q = p * 0.5 + uSeed;
    vec3 warp = texture(uNoise, q * 0.6).gba - 0.5;
    vec3 pw = p + warp * 0.5;
    float rw = length(pw);
    float body = smoothstep(1.0, 0.3, rw);
    float f = fbm(q + warp * 0.35);

    if (uType < 0.5) {
      // H II region: ionised gas lit from within, a hollow blown by the young
      // stars at its heart, the doubly ionised oxygen nearest them, and dark
      // lanes of dust crossing it all. Where a cloud's surface faces the
      // stars it is an ionisation front, the brightest gas in the nebula, and
      // the turbulence draws the rest out into filaments.
      float gas = smoothstep(0.42, 0.76, f) * body;
      float hollow = mix(1.0, smoothstep(0.08, 0.42, rw), uCavity);
      gas *= hollow;
      float front = (smoothstep(0.47, 0.6, f) - smoothstep(0.6, 0.74, f)) * body * hollow;
      float strandBase = 1.0 - abs(fbm3(q * 1.25 + warp * 0.9) * 2.0 - 1.0);
      float strands = strandBase * strandBase * strandBase * strandBase * strandBase;
      float lit = 0.4 + 1.5 / (1.0 + rw * rw * 7.0);
      float inner = smoothstep(0.75, 0.1, rw);
      vec3 colour = mix(uColA, uColB, inner * smoothstep(0.5, 0.85, f));
      colour = mix(colour, uColC, smoothstep(0.6, 0.9, texture(uNoise, q * 2.3 + 5.0).r) * 0.5);
      float dust = smoothstep(0.54, 0.8, fbm3(q * 1.7 + 11.3 + warp)) * body;
      vec3 emit = colour * (gas * 1.0 + front * 1.4 + strands * body * hollow * 0.9) * lit;
      if (uShape > 0.5) {
        // Pillars: columns of cold gas standing in the hollow, pointing at
        // the stars that are eroding them, each tipped with a bright rim.
        vec3 n = pw / max(rw, 1e-3);
        float ang = texture(uNoise, n * 0.55 + uSeed * 0.37).r + (fbm3(q * 3.1) - 0.5) * 0.1;
        float column = smoothstep(0.64, 0.7, ang);
        float tip = 0.3 + texture(uNoise, n * 0.4 + uSeed).g * 0.3;
        float reach = smoothstep(tip, tip + 0.05, rw) * smoothstep(1.0, 0.7, rw);
        float pillar = column * reach;
        float cap = column * (smoothstep(tip - 0.03, tip + 0.03, rw) - smoothstep(tip + 0.03, tip + 0.12, rw));
        float side = (smoothstep(0.6, 0.65, ang) - smoothstep(0.65, 0.7, ang)) * reach;
        dust += pillar * 4.0;
        emit = emit * (1.0 - pillar * 0.85) + mix(uColA, uColB, 0.6) * (cap * 2.2 + side * 1.0) * lit;
      }
      vec3 starlight = uColB * exp(-rw * rw * 40.0) * 2.0;
      return vec4(emit + starlight, dust * 5.0 + gas * 0.4);
    }
    if (uType < 1.5) {
      // A dying star's shell: hot oxygen inside, hydrogen at the rim, drawn
      // out along an axis into lobes when the star had a companion.
      float along = dot(p, uAxis);
      vec3 acrossV = p - uAxis * along;
      float rho = length(acrossV);
      vec3 dwarf = vec3(0.8, 0.9, 1.0) * exp(-dot(p, p) * 2500.0) * 25.0;
      float knots = 0.55 + fbm3(q * 2.4 + warp) * 0.9;
      if (uBipolar < 0.75) {
        // Round to elliptical: a bright rim of knots and radial spokes round
        // a glowing oxygen-blue interior, and the faint halo of an earlier
        // wind outside it.
        float sr = length(vec2(rho, along * mix(1.0, 0.55, uBipolar)));
        vec3 n = p / max(length(p), 1e-3);
        float spokes = 0.55 + 0.9 * pow(texture(uNoise, n * 1.6 + uSeed).r, 3.0);
        float shell = exp(-pow((sr - 0.56) / 0.12, 2.0)) * spokes;
        float fill = smoothstep(0.62, 0.1, sr) * 0.35;
        float halo = exp(-pow((sr - 0.84) / 0.09, 2.0)) * 0.22;
        vec3 colour = mix(uColB, uColA, smoothstep(0.3, 0.6, sr));
        colour = mix(colour, uColC, smoothstep(0.62, 0.86, sr));
        float gas = (shell + fill + halo) * knots;
        return vec4(colour * gas * 1.1 + dwarf, gas * 0.25);
      }
      // Bipolar: two lobes blown out either side of a dense waist, their
      // walls streaked along the outflow, the waist itself glowing hottest.
      float width = mix(0.12, 0.42, uCavity);
      float h = abs(along);
      float c = 0.42;
      float u = (h - c) / c;
      float profile = width * sqrt(max(0.0, 1.0 - u * u)) * (1.0 + (knots - 1.0) * 0.25);
      float wall = exp(-pow((rho - profile) / (0.018 + 0.12 * profile), 2.0)) * step(h, 2.0 * c);
      float filled = smoothstep(-0.01, 0.03, profile - rho) * 0.1;
      vec3 dir = acrossV / max(rho, 1e-3);
      float streak = 0.2 + 1.9 * pow(texture(uNoise, dir * 1.3 + vec3(0.0, 0.0, h * 0.35) + uSeed).r, 3.5);
      float waistGlow = exp(-(rho * rho + along * along) * 90.0) * 3.0;
      float gas = (wall + filled) * streak * knots;
      vec3 colour = mix(uColB, uColA, smoothstep(0.05, 0.55, h));
      colour = mix(colour, uColC, smoothstep(0.55, 1.0, rho / max(width, 0.01)) * 0.5);
      return vec4(colour * gas * 1.3 + uColB * waistGlow + dwarf, gas * 0.2 + waistGlow * 0.4);
    }
    if (uType < 2.5) {
      // Supernova shell: a thin, torn front of glowing filaments.
      float shell = smoothstep(0.55, 0.86, rw) * smoothstep(1.02, 0.86, rw);
      float strands = ridged(q * 1.4 + warp * 0.8);
      strands *= strands;
      float gas = strands * shell;
      vec3 colour = mix(uColA, uColB, smoothstep(0.42, 0.58, texture(uNoise, q * 1.7 + 3.0).r));
      return vec4(colour * gas * 2.2, 0.0);
    }
    if (uType < 3.5) {
      // Pulsar wind nebula: the pulsar's blue synchrotron haze, laced through
      // with the orange filaments of the star that made it.
      float strands = ridged(q * 1.6 + warp);
      strands *= strands;
      float fill = smoothstep(1.0, 0.4, rw);
      vec3 haze = uColB * exp(-rw * rw * 2.5) * 0.45;
      return vec4(haze + uColA * strands * fill * 2.4, strands * fill * 1.2);
    }
    if (uType < 4.5) {
      // Dust lit by nearby stars: blue, soft, brightest closest to them.
      float dust = smoothstep(0.38, 0.8, f) * body;
      float lit = 1.0 / (1.0 + dot(p, p) * 5.0);
      return vec4(uColA * dust * lit * 2.2, dust * 0.6);
    }
    // Dark nebula: cold dust and nothing to light it but a faint glow at the edge.
    float dust = smoothstep(0.36, 0.62, f) * body;
    float rim = smoothstep(0.4, 0.62, f) - smoothstep(0.62, 0.8, f);
    if (uShape > 0.5) {
      // The edge of a dark cloud against the glowing sheet of gas beyond
      // it, with a column of its dust standing up into the glow: what makes
      // the Horsehead a silhouette.
      float s = dot(pw, uAxis);
      float ragged = (fbm3(q * 2.2 + 3.1) - 0.5) * 0.35;
      float cloud = smoothstep(0.03, -0.06, s + ragged) * body;
      vec3 side = normalize(cross(uAxis, vec3(0.3, 1.0, 0.2)));
      float rhoC = length(pw - uAxis * s);
      float neck = smoothstep(0.15, 0.08, rhoC + (f - 0.5) * 0.15) * smoothstep(0.42, 0.3, s) * step(-0.1, s);
      float head = smoothstep(0.17, 0.09, length(pw - uAxis * 0.36 - side * 0.09) + (f - 0.5) * 0.12);
      float dark = max(cloud, max(neck, head));
      float glow = smoothstep(-0.05, 0.25, s) * body * smoothstep(0.3, 0.7, fbm3(q * 1.3 + 7.0)) * (1.0 - dark);
      float edge = (smoothstep(0.0, 0.08, dark) - smoothstep(0.08, 0.3, dark)) * body;
      return vec4(uColB * (glow * 3.0 + edge * 1.2), dark * 30.0 + dust * 0.5);
    }
    return vec4(uColB * rim * body * 0.12, dust * 9.0);
  }

  vec4 sampleCloud(vec3 p) {
    // Nothing reaches the bounding sphere, or its outline shows.
    return sampleCloudInner(p) * smoothstep(1.0, 0.82, length(p));
  }

  void main() {
    vec3 rd = normalize(vLocal - uCamera);
    float b = dot(uCamera, rd);
    float c = dot(uCamera, uCamera) - 1.0;
    float h = b * b - c;
    if (h <= 0.0) discard;
    h = sqrt(h);
    float t0 = max(-b - h, 0.0);
    float t1 = -b + h;
    if (t1 <= t0) discard;
    float dt = (t1 - t0) / uSteps;
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    vec3 colour = vec3(0.0);
    float transmit = 1.0;
    for (int i = 0; i < 72; i++) {
      if (float(i) >= uSteps) break;
      vec3 p = uCamera + rd * (t0 + (float(i) + jitter) * dt);
      vec4 s = sampleCloud(p);
      colour += transmit * s.rgb * dt * uBright;
      transmit *= exp(-s.a * dt);
      if (transmit < 0.01) break;
    }
    // Brightness compressed before the tone curve sees it, so the densest
    // gas stays orange or red instead of being bleached to cream.
    float peak = max(max(colour.r, colour.g), colour.b);
    colour *= 1.35 / (1.0 + 0.6 * peak);
    // A cloud drawn faint because it is small on the sky is dimmed as a
    // whole, its dust included; only a dark nebula is meant to be a hole.
    float cover = uType > 4.5 ? 1.0 : clamp(uBright * 2.0, 0.03, 1.0);
    gl_FragColor = vec4(colour, (1.0 - transmit) * cover);
    #include <logdepthbuf_fragment>
  }
`;

/**
 * Adds and removes an object's group from the scene as it comes into and out
 * of view. Thousands of catalogue objects sit in the scene graph otherwise,
 * every one walked for its matrix each frame while nothing of it is drawn.
 */
class Shown {
  constructor(spec) {
    this.spec = spec;
    this.world = deepObjectWorld(spec);
    this.radiusKm = spec.radiusPc * PC_KM;
    this.group = new Group();
    this.group.scale.setScalar(this.radiusKm);
    this.parent = null;
    this.shownAt = -Infinity;
  }

  show(parent, on, frame) {
    if (on) this.shownAt = frame;
    if (on && !this.parent) {
      parent.add(this.group);
      this.parent = parent;
    } else if (!on && this.parent) {
      this.parent.remove(this.group);
      this.parent = null;
    }
  }
}

/** A star-forming cloud's own stars: young, and as many as its size suggests. */
function embeddedStars(spec) {
  if (spec.type !== 'emission' && spec.type !== 'reflection') return null;
  if ((spec.look ?? spec.type) === 'remnant') return null;
  return {
    key: `${spec.key}*`,
    type: 'open',
    ageMyr: spec.type === 'emission' ? 2 : 40,
    stars: Math.round(Math.min(1600, Math.max(120, spec.radiusPc * 45))),
  };
}

class Nebula extends Shown {
  constructor(spec, noise, geometry, starMaterial) {
    super(spec);
    this.noise = noise;
    this.geometry = geometry;
    this.starMaterial = starMaterial;
    this.material = null;
    this.stars = null;
    this.inside = 0;
  }

  build() {
    if (this.material) return;
    const spec = this.spec;
    const rnd = random(hashKey(spec.key));
    const [a, b, c] = spec.colours;
    const axis = new Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    this.material = new ShaderMaterial({
      vertexShader: NEBULA_VERTEX,
      fragmentShader: NEBULA_FRAGMENT,
      uniforms: {
        uNoise: { value: this.noise },
        uCamera: { value: new Vector3() },
        uType: { value: NEBULA_TYPES[spec.look ?? spec.type] ?? 0 },
        uColA: { value: new Vector3(...a) },
        uColB: { value: new Vector3(...b) },
        uColC: { value: new Vector3(...c) },
        uSeed: { value: new Vector3(rnd() * 8, rnd() * 8, rnd() * 8) },
        uAxis: { value: axis },
        uBright: { value: 1 },
        uCavity: { value: spec.cavity ?? 0.4 },
        uBipolar: { value: spec.bipolar ?? 0 },
        uShape: { value: spec.shape ?? 0 },
        uSteps: { value: 48 },
      },
      side: BackSide,
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
    });
    const mesh = new Mesh(this.geometry, this.material);
    mesh.renderOrder = 4;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    // Drawn before the gas, so the dust in front of a star dims it.
    const stars = embeddedStars(spec);
    if (stars) {
      this.stars = new Points(buildCluster(stars), this.starMaterial);
      this.stars.renderOrder = 3;
      this.stars.frustumCulled = false;
      this.group.add(this.stars);
    }
  }

  /** The cheap part, done for every nebula every frame. */
  measure(distanceKm) {
    this.distanceKm = distanceKm;
    this.apparent = this.radiusKm / Math.max(distanceKm, this.radiusKm);
    /** How far inside the cloud the camera is, 0 outside to 1 at its heart. */
    this.inside = Math.max(0, 1 - distanceKm / this.radiusKm);
  }

  update(cameraLocal, pixelsPerRadian, steps) {
    this.build();
    const u = this.material.uniforms;
    // Seen from light-years off, only the bright core of a cloud registers:
    // the faint outskirts that make it a sprawl up close are lost against the
    // sky, so from a planetary system it is a compact dim knot, and it opens
    // out to its full extent as you close on it.
    const far = Math.min(1, Math.max(0, (this.distanceKm / this.radiusKm - 6) / 60));
    const drawnKm = this.radiusKm * (1 - 0.8 * far);
    this.group.scale.setScalar(drawnKm);
    u.uCamera.value.copy(cameraLocal).multiplyScalar(1 / drawnKm);
    // A cloud is the same surface brightness from any distance, and a real
    // one is faint: Orion from Earth is a smudge. Up close the eye adapts to
    // it, so the drawn brightness follows the apparent size, not the distance
    // — and from a planet a couple of its radii off, it fills the sky. Further
    // out than that it stays a faint smudge however wide it spans.
    const near = Math.min(1, Math.max(0, (this.apparent - 0.05) / 0.55));
    const faint = this.spec.faint ?? FAINT[this.spec.key] ?? 1;
    // From inside, the whole sky is cloud, and at the brightness it has
    // seen whole from outside it would be a white-out.
    const bright = (0.04 + 0.96 * near * near * (3 - 2 * near)) * (1 - 0.5 * Math.sqrt(this.inside));
    u.uBright.value = bright * (faint + (1 - faint) * near) * (1 - 0.75 * far);
    // A few pixels across, or too faint to show detail, needs nothing like
    // the full march; a dim cloud across half the sky is the costliest thing
    // on screen otherwise.
    u.uSteps.value = this.apparent * pixelsPerRadian < 60 || u.uBright.value < 0.15 ? Math.min(steps, 16) : steps;
  }
}

// ----------------------------------------------------------------- clusters

const bvOf = (teff) => Math.max(-0.33, Math.min(2.0, 5601 / teff - 0.47));
const COLOUR_TABLE = Array.from({ length: 96 }, (_, i) => colorIndexToLinearRgb(-0.33 + (i / 95) * 2.33, 1.5));
function colourOf(teff) {
  const i = Math.round(((bvOf(teff) + 0.33) / 2.33) * 95);
  return COLOUR_TABLE[Math.max(0, Math.min(95, i))];
}

/**
 * The stars of a cluster: where they are and what they are.
 *
 * A globular cluster is old, so its main sequence has burned down to stars
 * cooler than the Sun, and the brightest things in it are red giants and a
 * scatter of hot horizontal-branch stars. An open cluster is young: its
 * brightest members are blue, and only the older ones have any giants. The
 * age sets the main-sequence turnoff, and the turnoff sets everything else.
 */
function buildCluster(spec) {
  const rnd = random(hashKey(spec.key));
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-9))) * Math.cos(2 * Math.PI * rnd());
  const n = spec.stars;
  const positions = new Float32Array(n * 3);
  const colours = new Float32Array(n * 3);
  const lum = new Float32Array(n);
  const globular = spec.type === 'globular';
  const turnoff = globular ? 0.85 : Math.min(60, (10000 / Math.max(spec.ageMyr, 0.5)) ** (1 / 2.5));
  const lo = 0.3 ** -1.35;
  const hi = Math.min(turnoff, 60) ** -1.35;
  for (let i = 0; i < n; i++) {
    let r;
    if (globular) {
      // Plummer sphere, truncated at the tidal radius.
      const a = spec.core ?? 0.08;
      do {
        r = a / Math.sqrt(Math.max(rnd(), 1e-9) ** (-2 / 3) - 1);
      } while (r > 1);
    } else {
      r = Math.min(1, Math.abs(gauss()) * 0.42);
    }
    const z = rnd() * 2 - 1;
    const phi = rnd() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    positions[i * 3] = r * s * Math.cos(phi);
    positions[i * 3 + 1] = r * z;
    positions[i * 3 + 2] = r * s * Math.sin(phi);

    let teff;
    let L;
    const x = rnd();
    if (globular && x < 0.012) {
      teff = 3900 + rnd() * 900;
      L = 10 ** (1.4 + rnd() * 1.5);
    } else if (globular && x < 0.02) {
      teff = 7500 + rnd() * 4000;
      L = 40 + rnd() * 25;
    } else if (!globular && spec.ageMyr > 40 && x < 0.008) {
      teff = 4100 + rnd() * 900;
      L = 10 ** (1.7 + rnd() * 1.0);
    } else {
      const m = globular ? 0.2 + 0.65 * rnd() ** 1.8 : (lo - rnd() * (lo - hi)) ** (-1 / 1.35);
      L = m < 0.43 ? 0.23 * m ** 2.3 : m < 2 ? m ** 4 : 1.4 * m ** 3.5;
      teff = Math.min(42000, 5772 * m ** 0.58);
    }
    const [cr, cg, cb] = colourOf(teff);
    colours[i * 3] = cr;
    colours[i * 3 + 1] = cg;
    colours[i * 3 + 2] = cb;
    lum[i] = L;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
  geometry.setAttribute('lum', new Float32BufferAttribute(lum, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

const CLUSTER_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 color;
  attribute float lum;
  uniform float uGain;
  uniform float uPixelRatio;
  uniform float uMaxFlux;
  uniform float uMaxSize;
  varying vec3 vColour;
  varying float vEnergy;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float pc = max(length(mv.xyz) / ${PC_KM.toExponential(8)}, 1e-6);
    // Flux in units of a zeroth-magnitude star.
    float flux = min(lum / (pc * pc) * uGain, uMaxFlux);
    float size = clamp(2.0 + 2.4 * log2(1.0 + flux), 2.0, uMaxSize);
    // The same light spread over the sprite: a faint star is a dim two-pixel
    // dot, and ten thousand of them overlapping are the glow of the cluster.
    vEnergy = flux / (0.09 * size * size);
    vColour = color;
    gl_PointSize = size * uPixelRatio;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const CLUSTER_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec3 vColour;
  varying float vEnergy;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float profile = exp(-r2 * 9.0) + exp(-r2 * 2.5) * 0.06;
    gl_FragColor = vec4(vColour * vEnergy * profile, 1.0);
    #include <logdepthbuf_fragment>
  }
`;

/**
 * Stars as points lit by their own luminosity: `lum` in Suns per vertex,
 * `color` linear. Clusters use it, and so do the stars orbiting a black hole,
 * which are a few hundred au off and need the caps lower: at the real
 * brightness every one of them is a glare thirty pixels wide.
 */
export function starPointsMaterial({ maxFlux = 3000, maxSize = 30 } = {}) {
  return new ShaderMaterial({
    vertexShader: CLUSTER_VERTEX,
    fragmentShader: CLUSTER_FRAGMENT,
    uniforms: {
      uGain: { value: 1.17 * 4 },
      uPixelRatio: { value: 1 },
      uMaxFlux: { value: maxFlux },
      uMaxSize: { value: maxSize },
    },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

export { colourOf as starColour };

class Cluster extends Shown {
  constructor(spec, material) {
    super(spec);
    this.material = material;
    this.points = null;
  }

  build() {
    if (this.points) return;
    this.points = new Points(buildCluster(this.spec), this.material);
    this.points.renderOrder = 3;
    this.points.frustumCulled = false;
    this.group.add(this.points);
  }

  release() {
    if (!this.points) return;
    this.group.remove(this.points);
    this.points.geometry.dispose();
    this.points = null;
  }
}

// ------------------------------------------------------------ neutron stars

const SURFACE_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vNormal;
  varying vec3 vViewNormal;
  void main() {
    vNormal = normalize(position);
    vViewNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const SURFACE_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uMagAxis;
  uniform vec3 uColour;
  uniform float uSpots;
  varying vec3 vNormal;
  varying vec3 vViewNormal;
  void main() {
    // A million degrees: white-hot with a blue cast, hottest where the field
    // lines come down onto the poles.
    float mu = max(vViewNormal.z, 0.0);
    float spot = pow(abs(dot(vNormal, uMagAxis)), 60.0) * uSpots;
    vec3 colour = uColour * (0.55 + 0.45 * mu) * 2.2 + vec3(0.8, 0.9, 1.0) * spot * 8.0;
    gl_FragColor = vec4(colour, 1.0);
    #include <logdepthbuf_fragment>
  }
`;

const BEAM_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying float vAlong;
  varying float vFacing;
  void main() {
    vAlong = uv.y;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vFacing = abs(dot(n, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const BEAM_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColour;
  uniform float uIntensity;
  varying float vAlong;
  varying float vFacing;
  void main() {
    // Looking through the middle of the cone crosses more of it than grazing
    // its edge, which is all the volume a surface can fake.
    float fall = pow(1.0 - vAlong, 2.2);
    float core = 0.15 + 0.85 * pow(vFacing, 2.5);
    gl_FragColor = vec4(uColour * fall * core * uIntensity, 1.0);
    #include <logdepthbuf_fragment>
  }
`;

const GLOW_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColour;
  uniform float uIntensity;
  varying vec2 vUv;
  void main() {
    float r = length(vUv * 2.0 - 1.0);
    float glow = exp(-r * 9.0) * 1.4 + exp(-r * 3.0) * 0.12;
    gl_FragColor = vec4(uColour * glow * uIntensity * smoothstep(1.0, 0.8, r), 1.0);
    #include <logdepthbuf_fragment>
  }
`;

const GLOW_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const additive = (vertexShader, fragmentShader, uniforms) => new ShaderMaterial({
  vertexShader,
  fragmentShader,
  uniforms,
  transparent: true,
  depthWrite: false,
  blending: AdditiveBlending,
  side: DoubleSide,
});

/** Dipole field lines, r = L sin²θ, about +y, from one pole to the other. */
function fieldLines(shells, azimuths) {
  const points = [];
  for (const L of shells) {
    const theta0 = Math.asin(Math.sqrt(1 / L));
    for (let k = 0; k < azimuths; k++) {
      const phi = (k / azimuths) * Math.PI * 2;
      let prev = null;
      const steps = 48;
      for (let i = 0; i <= steps; i++) {
        const theta = theta0 + (Math.PI - 2 * theta0) * (i / steps);
        const r = L * Math.sin(theta) ** 2;
        const p = [r * Math.sin(theta) * Math.cos(phi), r * Math.cos(theta), r * Math.sin(theta) * Math.sin(phi)];
        if (prev) points.push(...prev, ...p);
        prev = p;
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
  return geometry;
}

class NeutronStar {
  constructor(spec) {
    this.spec = spec;
    this.world = deepObjectWorld(spec);
    this.radiusKm = NEUTRON_STAR_RADIUS_KM;
    const rnd = random(hashKey(spec.key));
    const magnetar = spec.type === 'magnetar';
    const beams = spec.type !== 'isolated';
    // Magnetic axis tilted off the spin axis, which is what makes a pulsar
    // a lighthouse rather than a steady pair of searchlights.
    const tilt = 0.45 + rnd() * 0.5;
    const magAxis = new Vector3(Math.sin(tilt), Math.cos(tilt), 0);
    const magQuat = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), magAxis);
    const colour = magnetar ? new Vector3(0.85, 0.8, 1.0) : new Vector3(0.7, 0.82, 1.0);

    this.group = new Group();
    this.group.quaternion.copy(orientation(rnd));
    this.spinner = new Group();
    this.group.add(this.spinner);
    this.group.scale.setScalar(this.radiusKm);

    const surface = new Mesh(new SphereGeometry(1, 48, 32), new ShaderMaterial({
      vertexShader: SURFACE_VERTEX,
      fragmentShader: SURFACE_FRAGMENT,
      uniforms: {
        uMagAxis: { value: magAxis },
        uColour: { value: colour },
        uSpots: { value: beams ? 1 : 0.3 },
      },
    }));
    this.spinner.add(surface);

    if (beams) {
      const length = 600;
      const width = length * Math.tan((magnetar ? 6 : 9) * (Math.PI / 180));
      const geometry = new CylinderGeometry(width, 0.3, length, 40, 1, true);
      geometry.translate(0, length / 2, 0);
      this.beamMaterial = additive(BEAM_VERTEX, BEAM_FRAGMENT, {
        uColour: { value: magnetar ? new Vector3(0.75, 0.55, 1.0) : new Vector3(0.55, 0.7, 1.0) },
        uIntensity: { value: 0.9 },
      });
      for (const sign of [1, -1]) {
        const beam = new Mesh(geometry, this.beamMaterial);
        beam.quaternion.copy(magQuat);
        if (sign < 0) beam.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI));
        beam.renderOrder = 5;
        this.spinner.add(beam);
      }
    }

    const lines = new LineSegments(
      fieldLines(magnetar ? [2, 3, 4.5, 7, 11, 17] : [2.5, 4, 7], magnetar ? 10 : 6),
      new LineBasicMaterial({
        color: magnetar ? 0xb08cff : 0x6fa8ff,
        transparent: true,
        opacity: magnetar ? 0.55 : 0.22,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    lines.quaternion.copy(magQuat);
    this.spinner.add(lines);

    this.glowMaterial = additive(GLOW_VERTEX, GLOW_FRAGMENT, {
      uColour: { value: colour },
      uIntensity: { value: 1 },
    });
    this.glow = new Mesh(new PlaneGeometry(80, 80), this.glowMaterial);
    this.glow.renderOrder = 6;
    this.group.add(this.glow);

    // Spun as seen, not as it is: the Crab turns thirty times a second, which
    // a sixty-hertz display can only alias. Slow ones keep their real period.
    this.visualPeriod = Math.max(spec.periodS, 0.7);
  }

  update(time, distanceKm, cameraQuaternion) {
    this.group.visible = distanceKm < 5e6;
    if (!this.group.visible) return;
    this.spinner.rotation.y = (time / this.visualPeriod) * Math.PI * 2;
    // Facing the camera, in the group's own frame.
    this.glow.quaternion.copy(this.group.quaternion).invert().multiply(cameraQuaternion);
  }
}

// --------------------------------------------------------------------- all

/**
 * The hand-made list, then whatever of the catalogue it does not already
 * cover. A catalogue entry is dropped when it sits inside a curated object of
 * the same family, which is how the Orion Nebula is not also drawn a second
 * time as the WISE H II region G209.0-19.4 on top of itself.
 */
function mergeCatalogue(curated, catalogue, family, dress = (s) => s) {
  const out = curated.map((spec) => ({ ...spec, curated: true }));
  const keys = new Set(out.map((s) => s.key));
  const placed = out.map((s) => ({ world: deepObjectWorld(s), r: s.radiusPc * PC_KM, family: family(s) }));
  const at = new Vector3();
  for (const entry of catalogue) {
    if (keys.has(entry.key) || !(entry.radiusPc > 0) || !(entry.distPc > 0)) continue;
    deepObjectWorld(entry, at);
    const r = entry.radiusPc * PC_KM;
    const kind = family(entry);
    if (placed.some((p) => p.family === kind && p.world.distanceTo(at) < (p.r + r) * 0.7)) continue;
    keys.add(entry.key);
    out.push(dress(entry));
  }
  return out;
}

/** How many of each are drawn at once, the largest on screen first. */
const NEBULA_DRAWS = 24;
const CLUSTER_DRAWS = 36;
/** Frames a cluster's stars are kept after it was last drawn. */
const CLUSTER_KEEP = 900;

export function createDeepObjects(catalogue = {}) {
  const group = new Group();
  const noise = noiseTexture();
  const sphere = new SphereGeometry(1, 48, 24);
  const clusterMaterial = starPointsMaterial();
  const nebulaSpecs = mergeCatalogue(
    NEBULAE,
    catalogue.nebulae ?? [],
    (s) => (s.type === 'planetary' ? 'pn' : 'cloud'),
    dressNebula,
  );
  const clusterSpecs = mergeCatalogue(CLUSTERS, catalogue.clusters ?? [], (s) => s.type);
  const nebulae = new Map(nebulaSpecs.map((spec) => [`neb:${spec.key}`, new Nebula(spec, noise, sphere, clusterMaterial)]));
  const clusters = new Map(clusterSpecs.map((spec) => [`cl:${spec.key}`, new Cluster(spec, clusterMaterial)]));
  const neutronStars = new Map(NEUTRON_STARS.map((spec) => [`ns:${spec.key}`, new NeutronStar(spec)]));
  for (const item of neutronStars.values()) group.add(item.group);
  const nebulaList = [...nebulae.values()];
  const clusterList = [...clusters.values()];

  const local = new Vector3();
  const drawn = [];
  let frame = 0;

  /** The `limit` largest of `items` on screen, by apparent pixel radius. */
  function largest(items, cameraWorld, pixelsPerRadian, minPx, limit) {
    drawn.length = 0;
    for (const item of items) {
      const px = (item.radiusKm / Math.max(cameraWorld.distanceTo(item.world), item.radiusKm)) * pixelsPerRadian;
      item.px = px;
      if (px > minPx) drawn.push(item);
    }
    if (drawn.length > limit) {
      drawn.sort((a, b) => b.px - a.px);
      drawn.length = limit;
    }
    return drawn;
  }

  return {
    group,
    nebulae,
    clusters,
    neutronStars,
    get(key) {
      return nebulae.get(key) ?? clusters.get(key) ?? neutronStars.get(key) ?? null;
    },
    /**
     * What the sky behind everything looks like from here: the glow of the
     * cloud or cluster the camera is inside, or null out in the open.
     */
    skyLook(cameraWorld) {
      let best = null;
      for (const nebula of nebulae.values()) {
        const inside = nebula.inside ?? 0;
        if (inside <= 0) continue;
        const spec = nebula.spec;
        const dark = spec.type === 'dark';
        const strength = (dark ? 0.012 : spec.type === 'planetary' ? 0.05 : 0.07) * Math.min(1, inside * 3) ** 0.8;
        if (best && best.strength >= strength) continue;
        best = {
          strength,
          colours: spec.colours,
          centre: new Vector3().subVectors(nebula.world, cameraWorld).normalize(),
          seed: (hashKey(spec.key) % 1000) / 37,
        };
      }
      for (const cluster of clusters.values()) {
        const spec = cluster.spec;
        const radiusKm = spec.radiusPc * PC_KM;
        const d = cameraWorld.distanceTo(cluster.world);
        if (d > radiusKm) continue;
        const globular = spec.type === 'globular';
        const inside = 1 - d / radiusKm;
        const strength = (globular ? 0.05 : 0.018) * inside ** 1.5;
        if (best && best.strength >= strength) continue;
        best = {
          strength,
          colours: globular
            ? [[1.0, 0.78, 0.5], [0.85, 0.6, 0.38], [1.0, 0.92, 0.75]]
            : [[0.7, 0.8, 1.0], [0.5, 0.6, 0.9], [0.95, 0.95, 1.0]],
          centre: new Vector3().subVectors(cluster.world, cameraWorld).normalize(),
          seed: (hashKey(spec.key) % 1000) / 37,
        };
      }
      return best;
    },
    /**
     * @param {object} o
     * @param {(group: Group, world: Vector3) => void} o.place floating-origin placement
     */
    update({ cameraWorld, cameraQuaternion, place, time, pixelsPerRadian, pixelRatio, exposure = 1, steps = 48, visible = true }) {
      group.visible = visible;
      if (!visible) return;
      clusterMaterial.uniforms.uPixelRatio.value = pixelRatio;
      // A zeroth-magnitude star is 1.17 Suns at a parsec; the rest is the same
      // headroom the star field is drawn with.
      clusterMaterial.uniforms.uGain.value = 1.17 * 4 * exposure;
      frame++;

      for (const nebula of nebulaList) nebula.measure(cameraWorld.distanceTo(nebula.world));
      // Below a couple of pixels there is nothing to march.
      const nebulaeDrawn = new Set(largest(nebulaList, cameraWorld, pixelsPerRadian, 1.5, NEBULA_DRAWS));
      for (const nebula of nebulaList) {
        const on = nebulaeDrawn.has(nebula);
        nebula.show(group, on, frame);
        if (!on) continue;
        place(nebula.group, nebula.world);
        local.copy(cameraWorld).sub(nebula.world);
        nebula.update(local, pixelsPerRadian, steps);
      }

      // A cluster is drawn star by star once it is a few pixels across; until
      // then its light is too spread to show.
      const clustersDrawn = new Set(largest(clusterList, cameraWorld, pixelsPerRadian, 2.5, CLUSTER_DRAWS));
      for (const cluster of clusterList) {
        const on = clustersDrawn.has(cluster);
        cluster.show(group, on, frame);
        if (on) {
          cluster.build();
          place(cluster.group, cluster.world);
        } else if (cluster.points && frame - cluster.shownAt > CLUSTER_KEEP) {
          cluster.release();
        }
      }
      for (const star of neutronStars.values()) {
        place(star.group, star.world);
        star.update(time, cameraWorld.distanceTo(star.world), cameraQuaternion);
      }
    },
  };
}
