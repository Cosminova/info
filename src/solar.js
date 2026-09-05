/**
 * Low-precision but genuine ephemerides.
 *
 * Planets use the JPL "Approximate Positions of the Planets" Keplerian
 * elements (valid 1800-2050, good to a few arcminutes). The Moon uses the main
 * periodic terms of Meeus chapter 47, which lands within about an arcminute.
 * That is far below one pixel until extreme zoom, so nothing here is a
 * placeholder: the sky genuinely matches the chosen date.
 */
import { DEG, RAD, dateToJulianDay, J2000 } from './astro.js';

const OBLIQUITY = 23.4392911 * DEG;

// a (AU), e, I (deg), L (deg), longPeri (deg), longNode (deg) and per-century rates.
export const PLANETS = {
  mercury: {
    name: 'Mercury',
    elements: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
    rates: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
    radiusKm: 2439.7,
    color: [0.85, 0.8, 0.74],
  },
  venus: {
    name: 'Venus',
    elements: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
    rates: [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
    radiusKm: 6051.8,
    color: [1.0, 0.97, 0.88],
  },
  earth: {
    name: 'Earth',
    elements: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0],
    rates: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0],
    radiusKm: 6371,
    color: [0.6, 0.8, 1.0],
  },
  mars: {
    name: 'Mars',
    elements: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rates: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
    radiusKm: 3389.5,
    color: [1.0, 0.62, 0.42],
  },
  jupiter: {
    name: 'Jupiter',
    elements: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rates: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
    radiusKm: 69911,
    color: [1.0, 0.93, 0.8],
  },
  saturn: {
    name: 'Saturn',
    elements: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rates: [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
    radiusKm: 58232,
    color: [1.0, 0.94, 0.78],
  },
  uranus: {
    name: 'Uranus',
    elements: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503],
    rates: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
    radiusKm: 25362,
    color: [0.72, 0.9, 0.95],
  },
  neptune: {
    name: 'Neptune',
    elements: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    rates: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
    radiusKm: 24622,
    color: [0.55, 0.72, 1.0],
  },
};

const norm360 = (d) => ((d % 360) + 360) % 360;

function solveKepler(meanAnomalyDeg, e) {
  const M = norm360(meanAnomalyDeg + 180) - 180;
  let E = M * DEG;
  const target = M * DEG;
  for (let i = 0; i < 12; i++) {
    const dE = (E - e * Math.sin(E) - target) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-11) break;
  }
  return E;
}

/** Heliocentric ecliptic rectangular coordinates in AU. */
export function heliocentric(planet, T) {
  const [a0, e0, i0, L0, wBar0, node0] = planet.elements;
  const [da, de, di, dL, dwBar, dnode] = planet.rates;

  const a = a0 + da * T;
  const e = e0 + de * T;
  const inc = (i0 + di * T) * DEG;
  const L = L0 + dL * T;
  const wBar = wBar0 + dwBar * T;
  const node = (node0 + dnode * T) * DEG;
  const argPeri = (wBar - node0 - dnode * T) * DEG;

  const E = solveKepler(L - wBar, e);
  const xOrb = a * (Math.cos(E) - e);
  const yOrb = a * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);

  const cw = Math.cos(argPeri);
  const sw = Math.sin(argPeri);
  const cn = Math.cos(node);
  const sn = Math.sin(node);
  const ci = Math.cos(inc);
  const si = Math.sin(inc);

  // Rotate perifocal -> ecliptic: argument of perihelion, inclination, node.
  const xp = cw * xOrb - sw * yOrb;
  const yp = sw * xOrb + cw * yOrb;

  return {
    x: cn * xp - sn * yp * ci,
    y: sn * xp + cn * yp * ci,
    z: yp * si,
    a,
    e,
  };
}

function eclipticRectToEquatorial({ x, y, z }) {
  const ce = Math.cos(OBLIQUITY);
  const se = Math.sin(OBLIQUITY);
  const xe = x;
  const ye = y * ce - z * se;
  const ze = y * se + z * ce;
  const r = Math.hypot(xe, ye, ze);
  let ra = Math.atan2(ye, xe) * RAD;
  if (ra < 0) ra += 360;
  return { ra, dec: Math.asin(ze / (r || 1)) * RAD, distance: r };
}

function eclipticSphericalToEquatorial(lambdaDeg, betaDeg) {
  const l = lambdaDeg * DEG;
  const b = betaDeg * DEG;
  const ce = Math.cos(OBLIQUITY);
  const se = Math.sin(OBLIQUITY);
  const sinDec = Math.sin(b) * ce + Math.cos(b) * se * Math.sin(l);
  const dec = Math.asin(Math.min(1, Math.max(-1, sinDec)));
  const y = Math.sin(l) * ce - Math.tan(b) * se;
  const x = Math.cos(l);
  let ra = Math.atan2(y, x) * RAD;
  if (ra < 0) ra += 360;
  return { ra, dec: dec * RAD };
}

// --------------------------------------------------------------------- moon

const MOON_LONGITUDE_TERMS = [
  [6288774, 0, 0, 1, 0],
  [1274027, 0, 2, -1, 0],
  [658314, 0, 2, 0, 0],
  [213618, 0, 0, 2, 0],
  [-185116, 1, 0, 0, 0],
  [-114332, 0, 0, 0, 2],
  [58793, 0, 2, -2, 0],
  [57066, 1, 2, -1, 0],
  [53322, 0, 2, 1, 0],
  [45758, 1, 2, 0, 0],
  [-40923, 1, 0, -1, 0],
  [-34720, 0, 1, 0, 0],
  [-30383, 1, 0, 1, 0],
  [15327, 0, 2, 0, -2],
  [-12528, 0, 0, 1, 2],
  [10980, 0, 0, 1, -2],
  [10675, 0, 4, -1, 0],
  [10034, 0, 0, 3, 0],
  [8548, 0, 4, -2, 0],
  [-7888, 1, 2, 1, 0],
  [-6766, 1, 2, 0, 0],
  [-5163, 0, 1, -1, 0],
  [4987, 1, 1, 0, 0],
  [4036, 1, 2, -1, 0],
  [3994, 0, 2, 2, 0],
  [3861, 0, 4, 0, 0],
  [3665, 0, 2, -3, 0],
  [-2689, 1, 0, 2, 0],
  [-2602, 0, 2, -1, 2],
  [2390, 1, 2, -3, 0],
  [-2348, 0, 1, 1, 0],
  [2236, 2, 2, -2, 0],
  [-2120, 1, 0, 2, 0],
  [-2069, 2, 0, 0, 0],
  [2048, 2, 2, -1, 0],
];

const MOON_LATITUDE_TERMS = [
  [5128122, 0, 0, 0, 1],
  [280602, 0, 0, 1, 1],
  [277693, 0, 0, 1, -1],
  [173237, 0, 2, 0, -1],
  [55413, 0, 2, -1, 1],
  [46271, 0, 2, -1, -1],
  [32573, 0, 2, 0, 1],
  [17198, 0, 0, 2, 1],
  [9266, 0, 2, 1, -1],
  [8822, 0, 0, 2, -1],
  [8216, 1, 2, 0, -1],
  [4324, 0, 2, -2, -1],
  [4200, 0, 2, 1, 1],
  [-3359, 1, 2, 0, 1],
  [2463, 1, 2, -1, -1],
  [2211, 1, 2, 0, -1],
  [2065, 1, 2, -1, 1],
  [-1870, 1, 0, 1, -1],
  [1828, 0, 4, -1, -1],
  [-1794, 1, 0, 0, 1],
  [-1749, 0, 0, 0, 3],
  [-1565, 1, 0, 1, 1],
];

const MOON_DISTANCE_TERMS = [
  [-20905355, 0, 0, 1, 0],
  [-3699111, 0, 2, -1, 0],
  [-2955968, 0, 2, 0, 0],
  [-569925, 0, 0, 2, 0],
  [48888, 1, 0, 0, 0],
  [-3149, 0, 0, 0, 2],
  [246158, 0, 2, -2, 0],
  [-152138, 1, 2, -1, 0],
  [-170733, 0, 2, 1, 0],
  [-204586, 1, 2, 0, 0],
  [-129620, 1, 0, -1, 0],
  [108743, 0, 1, 0, 0],
  [104755, 1, 0, 1, 0],
  [10321, 0, 2, 0, -2],
  [79661, 0, 0, 1, -2],
  [-34782, 0, 4, -1, 0],
  [-23210, 0, 0, 3, 0],
  [-21636, 0, 4, -2, 0],
  [24208, 1, 2, 1, 0],
  [30824, 1, 2, 0, 0],
  [-8379, 0, 1, -1, 0],
  [-16675, 1, 1, 0, 0],
  [-12831, 1, 2, -1, 0],
  [-10445, 0, 2, 2, 0],
  [-11650, 0, 4, 0, 0],
  [14403, 0, 2, -3, 0],
];

function moonPosition(T) {
  const Lp =
    218.3164477 +
    481267.88123421 * T -
    0.0015786 * T * T +
    (T * T * T) / 538841 -
    (T * T * T * T) / 65194000;
  const D =
    297.8501921 +
    445267.1114034 * T -
    0.0018819 * T * T +
    (T * T * T) / 545868 -
    (T * T * T * T) / 113065000;
  const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T * T + (T * T * T) / 24490000;
  const Mp =
    134.9633964 +
    477198.8675055 * T +
    0.0087414 * T * T +
    (T * T * T) / 69699 -
    (T * T * T * T) / 14712000;
  const F =
    93.272095 +
    483202.0175233 * T -
    0.0036539 * T * T -
    (T * T * T) / 3526000 +
    (T * T * T * T) / 863310000;

  const E = 1 - 0.002516 * T - 0.0000074 * T * T;

  const sum = (terms, trig) => {
    let total = 0;
    for (const [coeff, mM, mD, mMp, mF] of terms) {
      const arg = (mD * D + mM * M + mMp * Mp + mF * F) * DEG;
      const eccentricity = mM === 0 ? 1 : Math.pow(E, Math.abs(mM));
      total += coeff * eccentricity * trig(arg);
    }
    return total;
  };

  const sigmaL = sum(MOON_LONGITUDE_TERMS, Math.sin);
  const sigmaB = sum(MOON_LATITUDE_TERMS, Math.sin);
  const sigmaR = sum(MOON_DISTANCE_TERMS, Math.cos);

  const lambda = norm360(Lp + sigmaL / 1e6);
  const beta = sigmaB / 1e6;
  const distanceKm = 385000.56 + sigmaR / 1000;

  return { lambda, beta, distanceKm };
}

// ------------------------------------------------------------- magnitudes

function planetMagnitude(key, r, delta, phaseAngle) {
  const i = phaseAngle;
  const base = 5 * Math.log10(Math.max(1e-6, r * delta));
  switch (key) {
    case 'mercury':
      return -0.6 + base + 0.0498 * i - 0.000488 * i * i + 3.02e-6 * i * i * i;
    case 'venus':
      return -4.47 + base + 0.0103 * i + 0.000057 * i * i + 1.3e-8 * i * i * i;
    case 'mars':
      return -1.52 + base + 0.016 * i;
    case 'jupiter':
      return -9.4 + base + 0.005 * i;
    case 'saturn':
      // Rings dominate and vary; this is the ring-averaged value.
      return -8.88 + base + 0.044 * i;
    case 'uranus':
      return -7.19 + base;
    case 'neptune':
      return -6.87 + base;
    default:
      return 0;
  }
}

const AU_KM = 149597870.7;

/**
 * Everything the renderer needs for the solar system at a moment in time.
 * Distances in AU, angular diameters in radians, position angles in degrees.
 */
export function solarSystemAt(date) {
  const jd = dateToJulianDay(date);
  const T = (jd - J2000) / 36525;

  const earth = heliocentric(PLANETS.earth, T);
  const earthDistance = Math.hypot(earth.x, earth.y, earth.z);

  const bodies = [];

  // Sun: geocentric position is the negated Earth vector.
  const sunEq = eclipticRectToEquatorial({ x: -earth.x, y: -earth.y, z: -earth.z });
  const sunAngularRadius = Math.atan(695700 / (sunEq.distance * AU_KM));
  bodies.push({
    key: 'sun',
    name: 'Sun',
    ra: sunEq.ra,
    dec: sunEq.dec,
    distanceAu: sunEq.distance,
    magnitude: -26.74,
    angularRadius: sunAngularRadius,
    phase: 1,
    color: [1.0, 0.95, 0.86],
    kind: 'star',
  });

  const moon = moonPosition(T);
  const moonEq = eclipticSphericalToEquatorial(moon.lambda, moon.beta);
  const moonDistanceAu = moon.distanceKm / AU_KM;
  // Elongation from the Sun gives the phase angle, hence the illuminated limb.
  const sunEcliptic = Math.atan2(-earth.y, -earth.x) * RAD;
  const elongation = norm360(moon.lambda - sunEcliptic);
  // The phase angle is the Sun-Moon-Earth angle: zero at full Moon, opposite the
  // Sun, and 180 degrees at new. Both quarters give 90 either way round, which is
  // why an inverted version of this went unnoticed for so long — it was only
  // wrong near the ends, where it was wrong completely, calling a new Moon full.
  const phaseAngle = Math.abs(180 - elongation);
  const illuminated = (1 + Math.cos(phaseAngle * DEG)) / 2;
  bodies.push({
    key: 'moon',
    name: 'Moon',
    ra: moonEq.ra,
    dec: moonEq.dec,
    distanceAu: moonDistanceAu,
    magnitude: -12.74 + 0.026 * phaseAngle + 4e-9 * Math.pow(phaseAngle, 4),
    angularRadius: Math.atan(1737.4 / moon.distanceKm),
    phase: illuminated,
    phaseAngle,
    elongation,
    // Sun direction relative to the Moon, used to orient the terminator.
    sunLongitude: sunEcliptic,
    color: [1.0, 0.98, 0.94],
    kind: 'moon',
  });

  for (const [key, planet] of Object.entries(PLANETS)) {
    if (key === 'earth') continue;
    const helio = heliocentric(planet, T);
    const geo = { x: helio.x - earth.x, y: helio.y - earth.y, z: helio.z - earth.z };
    const eq = eclipticRectToEquatorial(geo);
    const r = Math.hypot(helio.x, helio.y, helio.z);
    const delta = eq.distance;
    // Law of cosines on the Sun-planet-Earth triangle.
    const cosPhase =
      (r * r + delta * delta - earthDistance * earthDistance) / (2 * r * delta || 1);
    const phaseAngleDeg = Math.acos(Math.min(1, Math.max(-1, cosPhase))) * RAD;
    bodies.push({
      key,
      name: planet.name,
      ra: eq.ra,
      dec: eq.dec,
      distanceAu: delta,
      heliocentricAu: r,
      magnitude: planetMagnitude(key, r, delta, phaseAngleDeg),
      angularRadius: Math.atan(planet.radiusKm / (delta * AU_KM)),
      phase: (1 + Math.cos(phaseAngleDeg * DEG)) / 2,
      phaseAngle: phaseAngleDeg,
      color: planet.color,
      kind: 'planet',
    });
  }

  return { jd, bodies, sun: bodies[0], moon: bodies[1] };
}

export const PLANET_KEYS = Object.keys(PLANETS).filter((k) => k !== 'earth');
