import {
  G, AU, LY, DAY, YEAR, M_SUN, R_SUN, M_EARTH, R_EARTH, M_JUP, SIGMA,
} from './constants.js';
import { makeBody, mainSequence } from './physics.js';

const deg = Math.PI / 180;
const R_JUP = 69911e3;

/*
 * Every object the Add tool offers. Masses, radii, spins and tilts are real for
 * the named bodies; the generic ones are typical of their class.
 */
export const CATEGORIES = [
  { key: 'star', label: 'Stars' },
  { key: 'hole', label: 'Black Holes' },
  { key: 'planet', label: 'Planets' },
  { key: 'moon', label: 'Moons' },
  { key: 'small', label: 'Small Bodies' },
];

const T = (spec) => spec;

export const TEMPLATES = [
  // Stars
  T({ key: 'sun', cat: 'star', name: 'Sun', kind: 'star', msStar: true, mass: M_SUN, tex: 'sun-colour', spinHours: 609.12, tiltDeg: 7.25, color: [1, 0.85, 0.6], desc: 'G2V main-sequence star' }),
  T({ key: 'reddwarf', cat: 'star', name: 'Red Dwarf', kind: 'star', msStar: true, mass: 0.12 * M_SUN, tex: 'sun-colour', spinHours: 80, color: [1, 0.45, 0.25], desc: 'M-type, like Proxima Centauri' }),
  T({ key: 'orangedwarf', cat: 'star', name: 'Orange Dwarf', kind: 'star', msStar: true, mass: 0.7 * M_SUN, tex: 'sun-colour', spinHours: 700, color: [1, 0.7, 0.4], desc: 'K-type main-sequence star' }),
  T({ key: 'bluestar', cat: 'star', name: 'Blue Giant', kind: 'star', msStar: true, mass: 15 * M_SUN, tex: 'sun-colour', spinHours: 30, color: [0.6, 0.75, 1], desc: 'B-type, 15 solar masses — goes supernova' }),
  T({ key: 'redgiant', cat: 'star', name: 'Red Giant', kind: 'giant', mass: 1.2 * M_SUN, radius: 40 * R_SUN, temp: 4000, tex: 'sun-colour', spinHours: 8000, color: [1, 0.55, 0.3], desc: 'Swollen, dying Sun-like star' }),
  T({ key: 'betelgeuse', cat: 'star', name: 'Red Supergiant', kind: 'giant', mass: 18 * M_SUN, radius: 760 * R_SUN, temp: 3600, tex: 'sun-colour', spinHours: 1e5, color: [1, 0.45, 0.25], desc: 'Like Betelgeuse — bigger than Mars\'s orbit' }),
  T({ key: 'whitedwarf', cat: 'star', name: 'White Dwarf', kind: 'whitedwarf', mass: 0.6 * M_SUN, radius: 8.7e6, temp: 25000, spinHours: 1, color: [0.85, 0.9, 1], desc: 'Earth-sized stellar ember' }),
  T({ key: 'neutron', cat: 'star', name: 'Neutron Star', kind: 'neutron', mass: 1.4 * M_SUN, radius: 12e3, temp: 6e5, spinHours: 0.00001, color: [0.75, 0.85, 1], desc: 'City-sized, denser than a nucleus' }),

  // Black holes
  T({ key: 'bh', cat: 'hole', name: 'Black Hole', kind: 'blackhole', mass: 10 * M_SUN, color: [0.1, 0.1, 0.1], desc: 'Stellar-mass, 10 M☉' }),
  T({ key: 'imbh', cat: 'hole', name: 'Intermediate Black Hole', kind: 'blackhole', mass: 1e4 * M_SUN, color: [0.1, 0.1, 0.1], desc: '10,000 M☉' }),
  T({ key: 'smbh', cat: 'hole', name: 'Supermassive Black Hole', kind: 'blackhole', mass: 4.3e6 * M_SUN, color: [0.1, 0.1, 0.1], desc: 'Like Sagittarius A*' }),

  // Planets
  T({ key: 'mercury', cat: 'planet', name: 'Mercury', mass: 3.3011e23, radius: 2439.7e3, tex: 'mercury-colour', spinHours: 1407.6, tiltDeg: 0.034, albedo: 0.088, color: [0.55, 0.52, 0.5], comp: { iron: 0.7, rock: 0.3, water: 0, gas: 0 } }),
  T({ key: 'venus', cat: 'planet', name: 'Venus', mass: 4.8675e24, radius: 6051.8e3, tex: 'venus-clouds', spinHours: -5832.5, tiltDeg: 177.36, albedo: 0.76, greenhouse: 510, atmo: { color: [1, 0.85, 0.6], strength: 1.3 }, color: [0.9, 0.8, 0.6], comp: { iron: 0.3, rock: 0.7, water: 0, gas: 0 } }),
  T({ key: 'earth', cat: 'planet', name: 'Earth', mass: 5.97217e24, radius: R_EARTH, tex: 'earth-colour', night: 'earth-night', clouds: 'earth-clouds', spinHours: 23.934, tiltDeg: 23.44, albedo: 0.306, greenhouse: 33, atmo: { color: [0.35, 0.6, 1], strength: 1 }, color: [0.35, 0.45, 0.6], comp: { iron: 0.32, rock: 0.67, water: 0.01, gas: 0 } }),
  T({ key: 'mars', cat: 'planet', name: 'Mars', mass: 6.4171e23, radius: 3389.5e3, tex: 'mars-colour', spinHours: 24.62, tiltDeg: 25.19, albedo: 0.25, greenhouse: 5, atmo: { color: [0.95, 0.65, 0.45], strength: 0.35 }, color: [0.75, 0.45, 0.3], comp: { iron: 0.25, rock: 0.74, water: 0.01, gas: 0 } }),
  T({ key: 'jupiter', cat: 'planet', name: 'Jupiter', mass: M_JUP, radius: R_JUP, tex: 'jupiter-colour', spinHours: 9.925, tiltDeg: 3.13, albedo: 0.5, internalT: 125, atmo: { color: [0.9, 0.8, 0.65], strength: 0.5 }, color: [0.8, 0.7, 0.55], comp: { iron: 0.02, rock: 0.05, water: 0.03, gas: 0.9 } }),
  T({ key: 'saturn', cat: 'planet', name: 'Saturn', mass: 5.6834e26, radius: 58232e3, tex: 'saturn-colour', spinHours: 10.656, tiltDeg: 26.73, albedo: 0.5, internalT: 95, rings: { inner: 74500e3, outer: 140220e3, tex: 'saturn-rings.png' }, atmo: { color: [0.95, 0.85, 0.6], strength: 0.45 }, color: [0.85, 0.75, 0.55], comp: { iron: 0.02, rock: 0.05, water: 0.05, gas: 0.88 } }),
  T({ key: 'uranus', cat: 'planet', name: 'Uranus', mass: 8.681e25, radius: 25362e3, tex: 'uranus-colour', spinHours: -17.24, tiltDeg: 97.77, albedo: 0.3, internalT: 59, atmo: { color: [0.6, 0.9, 0.95], strength: 0.6 }, color: [0.6, 0.85, 0.9], comp: { iron: 0.05, rock: 0.15, water: 0.6, gas: 0.2 } }),
  T({ key: 'neptune', cat: 'planet', name: 'Neptune', mass: 1.02413e26, radius: 24622e3, tex: 'neptune-colour', spinHours: 16.11, tiltDeg: 28.32, albedo: 0.29, internalT: 59, atmo: { color: [0.4, 0.6, 1], strength: 0.6 }, color: [0.3, 0.45, 0.9], comp: { iron: 0.05, rock: 0.15, water: 0.6, gas: 0.2 } }),
  T({ key: 'pluto', cat: 'planet', name: 'Pluto', mass: 1.303e22, radius: 1188.3e3, tex: 'pluto-colour', spinHours: -153.3, tiltDeg: 122.5, albedo: 0.5, color: [0.8, 0.7, 0.6], comp: { iron: 0, rock: 0.65, water: 0.35, gas: 0 }, desc: 'Dwarf planet' }),
  T({ key: 'superearth', cat: 'planet', name: 'Super-Earth', mass: 5 * M_EARTH, radius: 1.6 * R_EARTH, proc: { type: 'ocean', seed: 3 }, spinHours: 30, tiltDeg: 12, albedo: 0.3, greenhouse: 40, atmo: { color: [0.4, 0.65, 1], strength: 1.2 }, color: [0.3, 0.45, 0.6], comp: { iron: 0.3, rock: 0.6, water: 0.1, gas: 0 }, desc: 'Ocean world, 5 Earth masses' }),
  T({ key: 'lavaworld', cat: 'planet', name: 'Lava World', mass: 1.2 * M_EARTH, radius: 1.05 * R_EARTH, proc: { type: 'lava', seed: 5 }, spinHours: 20, tiltDeg: 4, albedo: 0.1, internalT: 1500, color: [0.35, 0.2, 0.15], comp: { iron: 0.35, rock: 0.65, water: 0, gas: 0 }, desc: 'Surface of molten rock' }),
  T({ key: 'iceworld', cat: 'planet', name: 'Ice World', mass: 0.5 * M_EARTH, radius: 0.95 * R_EARTH, proc: { type: 'ice', seed: 9 }, spinHours: 40, tiltDeg: 20, albedo: 0.6, color: [0.8, 0.85, 0.95], comp: { iron: 0.1, rock: 0.4, water: 0.5, gas: 0 }, desc: 'Frozen water-rich planet' }),
  T({ key: 'hotjupiter', cat: 'planet', name: 'Hot Jupiter', mass: M_JUP, radius: 1.35 * R_JUP, proc: { type: 'hotgas', seed: 2 }, spinHours: 80, tiltDeg: 0, albedo: 0.1, internalT: 1300, atmo: { color: [1, 0.5, 0.3], strength: 0.6 }, color: [0.6, 0.35, 0.25], comp: { iron: 0.02, rock: 0.05, water: 0.03, gas: 0.9 }, desc: 'Gas giant roasting close to its star' }),
  T({ key: 'gasgiant', cat: 'planet', name: 'Gas Giant', mass: 0.6 * M_JUP, radius: 0.95 * R_JUP, proc: { type: 'gas', seed: 7 }, spinHours: 11, tiltDeg: 8, albedo: 0.45, internalT: 100, atmo: { color: [0.8, 0.85, 1], strength: 0.5 }, color: [0.7, 0.72, 0.8], comp: { iron: 0.02, rock: 0.05, water: 0.03, gas: 0.9 }, desc: 'A Jupiter of your own' }),

  // Moons
  T({ key: 'moon', cat: 'moon', name: 'Moon', mass: 7.342e22, radius: 1737.4e3, tex: 'moon-colour', spinHours: 655.7, tiltDeg: 6.68, albedo: 0.12, color: [0.6, 0.6, 0.58], comp: { iron: 0.1, rock: 0.9, water: 0, gas: 0 } }),
  T({ key: 'io', cat: 'moon', name: 'Io', mass: 8.931938e22, radius: 1821.6e3, tex: 'io-colour', spinHours: 42.46, albedo: 0.63, color: [0.85, 0.75, 0.4], comp: { iron: 0.2, rock: 0.8, water: 0, gas: 0 } }),
  T({ key: 'europa', cat: 'moon', name: 'Europa', mass: 4.799844e22, radius: 1560.8e3, tex: 'europa-colour', spinHours: 85.23, albedo: 0.67, color: [0.8, 0.75, 0.65], comp: { iron: 0.1, rock: 0.8, water: 0.1, gas: 0 } }),
  T({ key: 'ganymede', cat: 'moon', name: 'Ganymede', mass: 1.4819e23, radius: 2634.1e3, tex: 'ganymede-colour', spinHours: 171.7, albedo: 0.43, color: [0.6, 0.57, 0.52], comp: { iron: 0.1, rock: 0.45, water: 0.45, gas: 0 } }),
  T({ key: 'callisto', cat: 'moon', name: 'Callisto', mass: 1.075938e23, radius: 2410.3e3, tex: 'callisto-colour', spinHours: 400.5, albedo: 0.22, color: [0.45, 0.42, 0.38], comp: { iron: 0.05, rock: 0.5, water: 0.45, gas: 0 } }),
  T({ key: 'titan', cat: 'moon', name: 'Titan', mass: 1.3452e23, radius: 2574.7e3, tex: 'titan-colour', spinHours: 382.7, albedo: 0.22, greenhouse: 12, atmo: { color: [1, 0.7, 0.3], strength: 1.6 }, color: [0.85, 0.65, 0.35], comp: { iron: 0.05, rock: 0.5, water: 0.45, gas: 0 } }),
  T({ key: 'triton', cat: 'moon', name: 'Triton', mass: 2.1389e22, radius: 1353.4e3, tex: 'triton-colour', spinHours: -141, albedo: 0.72, color: [0.8, 0.75, 0.75], comp: { iron: 0.05, rock: 0.65, water: 0.3, gas: 0 } }),
  T({ key: 'enceladus', cat: 'moon', name: 'Enceladus', mass: 1.08022e20, radius: 252.1e3, tex: 'enceladus-colour', spinHours: 32.9, albedo: 0.8, color: [0.9, 0.92, 0.95], comp: { iron: 0, rock: 0.5, water: 0.5, gas: 0 } }),
  T({ key: 'charon', cat: 'moon', name: 'Charon', mass: 1.586e21, radius: 606e3, tex: 'charon-colour', spinHours: 153.3, albedo: 0.37, color: [0.6, 0.58, 0.56], comp: { iron: 0, rock: 0.6, water: 0.4, gas: 0 } }),

  // Small bodies
  T({ key: 'ceres', cat: 'small', name: 'Ceres', mass: 9.3839e20, radius: 469.7e3, tex: 'ceres-colour', spinHours: 9.07, albedo: 0.09, color: [0.45, 0.44, 0.42], comp: { iron: 0, rock: 0.75, water: 0.25, gas: 0 }, desc: 'Largest asteroid, a dwarf planet' }),
  T({ key: 'vesta', cat: 'small', name: 'Vesta', mass: 2.59076e20, radius: 262.7e3, tex: 'vesta-colour', spinHours: 5.34, albedo: 0.42, color: [0.55, 0.52, 0.48], comp: { iron: 0.2, rock: 0.8, water: 0, gas: 0 } }),
  T({ key: 'bigasteroid', cat: 'small', name: 'Giant Asteroid', mass: 4.5e20, radius: 350e3, proc: { type: 'rock', seed: 11 }, spinHours: 7, albedo: 0.1, color: [0.45, 0.4, 0.36], comp: { iron: 0.15, rock: 0.85, water: 0, gas: 0 }, desc: '700 km across — planet-scarring' }),
  T({ key: 'asteroid', cat: 'small', name: 'Asteroid', mass: 5e15, radius: 8e3, proc: { type: 'rock', seed: 4 }, spinHours: 5, albedo: 0.1, color: [0.45, 0.4, 0.36], comp: { iron: 0.15, rock: 0.85, water: 0, gas: 0 }, desc: '16 km, dinosaur-killer class' }),
  T({ key: 'comet', cat: 'small', name: 'Comet', mass: 1e14, radius: 5e3, proc: { type: 'comet', seed: 6 }, spinHours: 12, albedo: 0.04, color: [0.35, 0.33, 0.32], comp: { iron: 0, rock: 0.4, water: 0.6, gas: 0 }, comet: true, desc: 'Icy, grows a tail near stars' }),
];

export const TEMPLATE_BY_KEY = new Map(TEMPLATES.map((t) => [t.key, t]));

/** A body spec from a template, with overrides. */
export function fromTemplate(key, over = {}) {
  const t = TEMPLATE_BY_KEY.get(key);
  if (!t) throw new Error(`unknown template ${key}`);
  const spec = {
    name: t.name,
    kind: t.kind || (t.cat === 'moon' ? 'moon' : t.cat === 'small' ? 'asteroid' : 'planet'),
    mass: t.mass,
    radius: t.radius || R_SUN,
    tex: t.tex || null,
    proc: t.proc || null,
    night: t.night || null,
    clouds: t.clouds || null,
    atmo: t.atmo ? { ...t.atmo } : null,
    rings: t.rings ? { ...t.rings } : null,
    color: t.color,
    albedo: t.albedo ?? 0.3,
    greenhouse: t.greenhouse || 0,
    internalT: t.internalT || 3,
    spinPeriod: (t.spinHours || 24) * 3600,
    tilt: (t.tiltDeg || 0) * deg,
    comp: t.comp || { iron: 0.3, rock: 0.7, water: 0, gas: 0 },
    msStar: !!t.msStar,
    comet: !!t.comet,
    template: t.key,
    temp: t.temp || 150,
  };
  if (spec.kind === 'giant' || spec.kind === 'whitedwarf' || spec.kind === 'neutron') {
    spec.lum = 4 * Math.PI * spec.radius ** 2 * SIGMA * spec.temp ** 4;
  }
  if (spec.msStar) Object.assign(spec, starFields(spec.mass));
  Object.assign(spec, over);
  return makeBody(spec);
}

function starFields(mass) {
  const ms = mainSequence(mass);
  return { radius: ms.radius, lum: ms.lum, temp: ms.temp };
}

// -----------------------------------------------------------------------------
// Orbits

/** Simulation frame from ecliptic: x stays, ecliptic north is +y, ecliptic y is −z. */
function ecl(x, y, z) {
  return [x, z, -y];
}

function solveKepler(M, e) {
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 30; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

/** State vector (sim frame) relative to the primary, from classical elements in the ecliptic. */
export function stateFromElements({ a, e, i, node, peri, M }, mu) {
  const E = solveKepler(M, e);
  const n = Math.sqrt(mu / (a * a * a));
  const xo = a * (Math.cos(E) - e);
  const yo = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const dE = n / (1 - e * Math.cos(E));
  const vxo = -a * Math.sin(E) * dE;
  const vyo = a * Math.sqrt(1 - e * e) * Math.cos(E) * dE;
  const cO = Math.cos(node);
  const sO = Math.sin(node);
  const cw = Math.cos(peri);
  const sw = Math.sin(peri);
  const ci = Math.cos(i);
  const si = Math.sin(i);
  const rot = (x, y) => [
    (cw * cO - sw * sO * ci) * x + (-sw * cO - cw * sO * ci) * y,
    (cw * sO + sw * cO * ci) * x + (-sw * sO + cw * cO * ci) * y,
    sw * si * x + cw * si * y,
  ];
  const p = rot(xo, yo);
  const v = rot(vxo, vyo);
  return { pos: ecl(...p), vel: ecl(...v) };
}

/** JPL approximate elements (J2000, valid 1800–2050): a AU, e, I, L, long. peri, node (deg), L rate (deg/century). */
const JPL = {
  mercury: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593, 149472.67411175],
  venus: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255, 58517.81538729],
  earth: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0, 35999.37244981],
  mars: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 19140.30268499],
  jupiter: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, 3034.74612775],
  saturn: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, 1222.49362201],
  uranus: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503, 428.48202785],
  neptune: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 218.45945325],
  pluto: [39.48211675, 0.2488273, 17.14001206, 238.92903833, 224.06891629, 110.30393684, 145.20780515],
  ceres: [2.7675, 0.0785, 10.59, 0, 73.6 + 80.3, 80.3, 0, 1],
  vesta: [2.3615, 0.0887, 7.14, 0, 151.2 + 103.8, 103.8, 0, 2],
};

function julianCenturies(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  return (jd - 2451545) / 36525;
}

function planetElements(key, date) {
  const [a, e, I, L0, wbar, node, Lrate, phase] = JPL[key];
  const Tc = julianCenturies(date);
  let L = L0 + Lrate * Tc;
  if (phase) L = (phase * 137.5 + Tc * (36000 / Math.pow(a, 1.5))) % 360;
  return { a: a * AU, e, i: I * deg, node: node * deg, peri: (wbar - node) * deg, M: ((L - wbar) % 360) * deg };
}

function addRelative(sim, spec, primary, el) {
  const mu = G * (primary.mass + spec.mass);
  const { pos, vel } = stateFromElements(el, mu);
  spec.x = primary.x + pos[0];
  spec.y = primary.y + pos[1];
  spec.z = primary.z + pos[2];
  spec.vx = primary.vx + vel[0];
  spec.vy = primary.vy + vel[1];
  spec.vz = primary.vz + vel[2];
  return sim.add(spec);
}

/** Circular orbit in the primary's equatorial plane (its tilt about x). */
function addEquatorial(sim, spec, primary, signedRadius, phase) {
  const t = primary.tilt;
  const e1 = [1, 0, 0];
  const e2 = [0, Math.sin(t), -Math.cos(t)];
  const radius = Math.abs(signedRadius);
  const v = Math.sign(signedRadius) * Math.sqrt((G * (primary.mass + spec.mass)) / radius);
  const c = Math.cos(phase);
  const s = Math.sin(phase);
  spec.x = primary.x + radius * (c * e1[0] + s * e2[0]);
  spec.y = primary.y + radius * (c * e1[1] + s * e2[1]);
  spec.z = primary.z + radius * (c * e1[2] + s * e2[2]);
  spec.vx = primary.vx + v * (-s * e1[0] + c * e2[0]);
  spec.vy = primary.vy + v * (-s * e1[1] + c * e2[1]);
  spec.vz = primary.vz + v * (-s * e1[2] + c * e2[2]);
  return sim.add(spec);
}

/** Planets of the Solar System at their positions on `date`, the Sun at rest at the origin. */
function solarSystem(sim, date, { moons = true, minor = true } = {}) {
  const sun = sim.add(fromTemplate('sun'));
  const order = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
  if (minor) order.push('pluto', 'ceres', 'vesta');
  const out = { sun };
  for (const key of order) {
    const spec = fromTemplate(key);
    if (key === 'earth' && moons) {
      // Elements are for the Earth–Moon barycentre; split it.
      const moon = fromTemplate('moon');
      const bary = { mass: spec.mass + moon.mass, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
      const el = planetElements('earth', date);
      const st = stateFromElements(el, G * (sun.mass + bary.mass));
      const rel = stateFromElements({ a: 384400e3, e: 0.0549, i: 5.145 * deg, node: 125 * deg, peri: 318 * deg, M: 2.1 }, G * bary.mass);
      const fe = moon.mass / bary.mass;
      Object.assign(spec, {
        x: st.pos[0] - rel.pos[0] * fe, y: st.pos[1] - rel.pos[1] * fe, z: st.pos[2] - rel.pos[2] * fe,
        vx: st.vel[0] - rel.vel[0] * fe, vy: st.vel[1] - rel.vel[1] * fe, vz: st.vel[2] - rel.vel[2] * fe,
      });
      const fm = 1 - fe;
      Object.assign(moon, {
        x: st.pos[0] + rel.pos[0] * fm, y: st.pos[1] + rel.pos[1] * fm, z: st.pos[2] + rel.pos[2] * fm,
        vx: st.vel[0] + rel.vel[0] * fm, vy: st.vel[1] + rel.vel[1] * fm, vz: st.vel[2] + rel.vel[2] * fm,
      });
      out.earth = sim.add(spec);
      out.moon = sim.add(moon);
      continue;
    }
    out[key] = addRelative(sim, spec, sun, planetElements(key, date));
  }
  if (moons) {
    const jup = out.jupiter;
    const gal = [['io', 421700e3], ['europa', 671034e3], ['ganymede', 1070412e3], ['callisto', 1882709e3]];
    gal.forEach(([k, r], i) => addEquatorial(sim, fromTemplate(k), jup, r, i * 1.9 + 0.4));
    addEquatorial(sim, fromTemplate('titan'), out.saturn, 1221870e3, 2.2);
    addEquatorial(sim, fromTemplate('triton'), out.neptune, -354759e3, 0.8);
    if (out.pluto) addEquatorial(sim, fromTemplate('charon'), out.pluto, 19591e3, 0.3);
  }
  zeroMomentum(sim);
  return out;
}

export function zeroMomentum(sim) {
  let px = 0;
  let py = 0;
  let pz = 0;
  let m = 0;
  for (const b of sim.bodies) {
    px += b.mass * b.vx;
    py += b.mass * b.vy;
    pz += b.mass * b.vz;
    m += b.mass;
  }
  if (!m) return;
  for (const b of sim.bodies) {
    b.vx -= px / m;
    b.vy -= py / m;
    b.vz -= pz / m;
  }
}

/**
 * A Sun 1 AU away to light and warm a close-up scene. It is real and it pulls,
 * so `orbitLamp` afterwards sets the whole scene orbiting it.
 */
function lamp(sim, toward = [1, 0.15, 0.4]) {
  const l = Math.hypot(...toward);
  return sim.add(fromTemplate('sun', {
    x: (-toward[0] / l) * AU, y: (-toward[1] / l) * AU, z: (-toward[2] / l) * AU,
  }));
}

function orbitLamp(sim) {
  const sun = sim.bodies.find((b) => b.template === 'sun');
  if (!sun) return;
  let m = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const b of sim.bodies) {
    if (b === sun) continue;
    m += b.mass;
    x += b.mass * b.x;
    y += b.mass * b.y;
    z += b.mass * b.z;
  }
  if (!m) return;
  const rx = x / m - sun.x;
  const ry = y / m - sun.y;
  const rz = z / m - sun.z;
  const r = Math.hypot(rx, ry, rz);
  // Prograde about +y: v ∝ ŷ × r.
  let tx = rz;
  let tz = -rx;
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl;
  tz /= tl;
  const v = Math.sqrt((G * (sun.mass + m)) / r);
  for (const b of sim.bodies) {
    if (b === sun) continue;
    b.vx += tx * v;
    b.vz += tz * v;
  }
  void ry;
}

/** Place `b` on a circular orbit around `p` at radius r, phase θ, in the plane tilted by `incl` about x. */
function circular(sim, spec, p, r, theta = 0, incl = 0) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const ci = Math.cos(incl);
  const si = Math.sin(incl);
  const v = Math.sqrt((G * (p.mass + spec.mass)) / r);
  spec.x = p.x + r * c;
  spec.y = p.y + r * -s * si;
  spec.z = p.z + r * -s * ci;
  spec.vx = p.vx - v * s;
  spec.vy = p.vy - v * c * si;
  spec.vz = p.vz - v * c * ci;
  return sim.add(spec);
}

function galaxy(sim, { name, cx, cz, vx, vz, n, radius, coreMass, diskMass, tilt, color, flip }) {
  const core = sim.add(fromTemplate('smbh', {
    name, mass: coreMass, x: cx, y: 0, z: cz, vx, vy: 0, vz,
  }));
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  for (let k = 0; k < n; k++) {
    const r = radius * (0.08 + 0.92 * Math.sqrt(Math.random()));
    const th = Math.random() * Math.PI * 2;
    const enclosed = coreMass + diskMass * (r / radius) ** 2;
    const v = Math.sqrt((G * enclosed) / r) * (flip ? -1 : 1);
    // In-plane position and velocity, then tilt the disk about x.
    const px = r * Math.cos(th);
    const pz = -r * Math.sin(th);
    const py = (Math.random() - 0.5) * radius * 0.03;
    const qx = -v * Math.sin(th);
    const qz = -v * Math.cos(th);
    const warm = Math.random();
    sim.add(makeBody({
      name: 'Star', kind: 'starp', minor: true, ghost: true, mass: diskMass / n, radius: 1e9,
      x: cx + px, y: py * ct - pz * st, z: cz + py * st + pz * ct,
      vx: vx + qx, vy: -qz * st, vz: vz + qz * ct,
      temp: warm < 0.35 ? 9000 + 15000 * Math.random() : 3500 + 3000 * Math.random(),
      color,
    }));
  }
  return core;
}

// -----------------------------------------------------------------------------
// Included simulations

export const PRESETS = [
  {
    key: 'solar',
    name: 'Solar System',
    desc: 'The planets where they are today, with their major moons.',
    build(sim, date) {
      solarSystem(sim, date);
      return { focus: 'Sun', dist: 4.5 * AU, pitch: 0.55, yaw: 0.6, speed: 7 * DAY };
    },
  },
  {
    key: 'earthmoon',
    name: 'Earth & Moon',
    desc: 'Our planet and its satellite, lit by the Sun.',
    build(sim) {
      lamp(sim);
      const earth = sim.add(fromTemplate('earth'));
      sim.add(stateAround(fromTemplate('moon'), earth, { a: 384400e3, e: 0.0549, i: 5.1 * deg, node: 0.3, peri: 1, M: 0.8 }));
      orbitLamp(sim);
      return { focus: 'Earth', dist: 9e8, pitch: 0.35, yaw: 0.3, speed: 6 * 3600 };
    },
  },
  {
    key: 'moonimpact',
    name: 'Moon Hits Earth',
    desc: 'The Moon on a collision course. Watch the surface melt.',
    build(sim) {
      lamp(sim, [1, 0.1, -0.3]);
      const earth = sim.add(fromTemplate('earth'));
      sim.add(fromTemplate('moon', {
        x: 52000e3, y: 3000e3, z: -20000e3, vx: -3200, vy: -200, vz: 2600,
      }));
      orbitLamp(sim);
      return { focus: 'Earth', dist: 7.5e7, pitch: 0.25, yaw: -0.4, speed: 1200 };
    },
  },
  {
    key: 'theia',
    name: 'Theia: Birth of the Moon',
    desc: 'A Mars-sized world strikes the young Earth at an angle, throwing up the debris the Moon formed from.',
    build(sim) {
      lamp(sim, [0.7, 0.2, 0.7]);
      sim.add(fromTemplate('earth', {
        name: 'Proto-Earth', mass: 0.9 * M_EARTH, radius: 0.97 * R_EARTH, tex: null, clouds: null, night: null,
        proc: { type: 'lava', seed: 21 }, atmo: { color: [1, 0.6, 0.4], strength: 0.5 }, internalT: 900,
      }));
      sim.add(fromTemplate('mars', {
        name: 'Theia', mass: 0.11 * M_EARTH, radius: 3390e3, tex: null, proc: { type: 'rock', seed: 13 },
        x: 26000e3, y: 0, z: -9200e3, vx: -3800, vy: 0, vz: 600, atmo: null,
      }));
      orbitLamp(sim);
      return { focus: 'Proto-Earth', dist: 6e7, pitch: 0.5, yaw: 0.2, speed: 240 };
    },
  },
  {
    key: 'roche',
    name: 'Moon Inside the Roche Limit',
    desc: 'Move the Moon to 12,000 km and Earth\'s tides tear it into a ring.',
    build(sim) {
      lamp(sim);
      const earth = sim.add(fromTemplate('earth'));
      circular(sim, fromTemplate('moon'), earth, 12500e3, 0, 0.05);
      orbitLamp(sim);
      return { focus: 'Earth', dist: 6.5e7, pitch: 0.7, yaw: 0, speed: 600 };
    },
  },
  {
    key: 'twoearths',
    name: 'Two Earths Collide',
    desc: 'Two copies of our planet, 12 km/s, slightly off-centre.',
    build(sim) {
      lamp(sim);
      sim.add(fromTemplate('earth', { name: 'Earth A', x: -30000e3, z: 3000e3, vx: 6000 }));
      sim.add(fromTemplate('earth', { name: 'Earth B', x: 30000e3, z: -3000e3, vx: -6000, spinAngle: 2 }));
      orbitLamp(sim);
      return { focus: 'Earth A', dist: 8e7, pitch: 0.45, yaw: 0.5, speed: 480 };
    },
  },
  {
    key: 'blackhole',
    name: 'Black Hole Passes Through',
    desc: 'A 10 solar-mass black hole crosses the inner Solar System.',
    build(sim, date) {
      solarSystem(sim, date, { moons: true, minor: false });
      sim.add(fromTemplate('bh', { name: 'Rogue Black Hole', x: 6 * AU, y: 0.6 * AU, z: -2.5 * AU, vx: -38000, vy: -3500, vz: 15000 }));
      return { focus: 'Sun', dist: 9 * AU, pitch: 0.6, yaw: 0.9, speed: 14 * DAY };
    },
  },
  {
    key: 'supernova',
    name: 'Supernova',
    desc: 'A red supergiant with planets explodes. The blast reaches each world in turn.',
    build(sim) {
      const star = sim.add(fromTemplate('betelgeuse', { name: 'Supergiant' }));
      circular(sim, fromTemplate('neptune', { name: 'Inner Giant' }), star, 12 * AU, 0.5);
      circular(sim, fromTemplate('earth', { name: 'Frozen World', atmo: null, clouds: null }), star, 25 * AU, 2.5, 0.05);
      circular(sim, fromTemplate('jupiter', { name: 'Outer Giant' }), star, 45 * AU, 4.2, 0.03);
      return { focus: 'Supergiant', dist: 110 * AU, pitch: 0.5, yaw: 0.3, speed: 30.44 * DAY, explode: { name: 'Supergiant', after: 4 } };
    },
  },
  {
    key: 'binary',
    name: 'Twin Suns',
    desc: 'A planet orbiting a pair of stars, like Tatooine.',
    build(sim) {
      const m1 = 1 * M_SUN;
      const m2 = 0.7 * M_SUN;
      const sep = 0.22 * AU;
      const v = Math.sqrt((G * (m1 + m2)) / sep);
      sim.add(fromTemplate('sun', { name: 'Star A', x: (-sep * m2) / (m1 + m2), vz: (v * m2) / (m1 + m2) }));
      sim.add(fromTemplate('orangedwarf', { name: 'Star B', x: (sep * m1) / (m1 + m2), vz: (-v * m1) / (m1 + m2) }));
      const bary = { mass: m1 + m2, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
      circular(sim, fromTemplate('mars', { name: 'Tatooine', tex: null, proc: { type: 'desert', seed: 8 }, atmo: { color: [1, 0.85, 0.6], strength: 0.5 } }), bary, 1.1 * AU, 1.2);
      circular(sim, fromTemplate('gasgiant', { name: 'Outer Giant' }), bary, 2.6 * AU, 3.4, 0.02);
      return { focus: 'Star A', dist: 4 * AU, pitch: 0.75, yaw: 0, speed: 7 * DAY, focusCOM: true };
    },
  },
  {
    key: 'rings',
    name: 'Ring World',
    desc: 'A gas giant with a ring of real, colliding ice particles. Throw a moon through it.',
    build(sim) {
      lamp(sim, [1, 0.3, 0.2]);
      const giant = sim.add(fromTemplate('saturn', { name: 'Ringed Giant', rings: null, tilt: 0 }));
      for (let k = 0; k < 1600; k++) {
        const r = giant.radius * (1.35 + 1.0 * Math.random());
        const th = Math.random() * Math.PI * 2;
        const spec = makeBody({
          name: 'Ring particle', kind: 'fragment', minor: true, mass: 2e15, radius: 6e3,
          color: [0.85, 0.82, 0.75].map((c) => c * (0.8 + 0.3 * Math.random())), temp: 90,
          comp: { iron: 0, rock: 0.05, water: 0.95, gas: 0 },
        });
        circular(sim, spec, giant, r, th, (Math.random() - 0.5) * 0.002);
      }
      sim.add(fromTemplate('moon', { name: 'Intruder', x: 6.2 * giant.radius, y: 0.15 * giant.radius, z: -1.2 * giant.radius, vx: -14000, vy: -400, vz: 9000 }));
      orbitLamp(sim);
      return { focus: 'Ringed Giant', dist: 7 * giant.radius, pitch: 0.42, yaw: 0.4, speed: 600 };
    },
  },
  {
    key: 'galaxies',
    name: 'Galaxy Collision',
    desc: 'Two spiral galaxies of 1,200 stars each fall together over a few hundred million years.',
    build(sim) {
      sim.settings.softening = 1500 * LY;
      sim.settings.accuracy = 0.03;
      const R = 30000 * LY;
      galaxy(sim, { name: 'Galaxy A', cx: -70000 * LY, cz: 20000 * LY, vx: 120e3, vz: -25e3, n: 1200, radius: R, coreMass: 4e10 * M_SUN, diskMass: 3e10 * M_SUN, tilt: 0.2, color: [0.7, 0.8, 1] });
      galaxy(sim, { name: 'Galaxy B', cx: 70000 * LY, cz: -20000 * LY, vx: -120e3, vz: 25e3, n: 1200, radius: R * 0.8, coreMass: 3e10 * M_SUN, diskMass: 2e10 * M_SUN, tilt: 1.0, color: [1, 0.85, 0.7], flip: true });
      zeroMomentum(sim);
      return { focus: 'Galaxy A', dist: 4e5 * LY, pitch: 0.7, yaw: 0, speed: 3e6 * YEAR, focusCOM: true };
    },
  },
  {
    key: 'empty',
    name: 'Empty Space',
    desc: 'Nothing at all. Add whatever you like.',
    build(sim) {
      return { focus: null, dist: 1e8, pitch: 0.5, yaw: 0, speed: 3600 };
    },
  },
];

function stateAround(spec, p, el) {
  const { pos, vel } = stateFromElements(el, G * (p.mass + spec.mass));
  spec.x = p.x + pos[0];
  spec.y = p.y + pos[1];
  spec.z = p.z + pos[2];
  spec.vx = p.vx + vel[0];
  spec.vy = p.vy + vel[1];
  spec.vz = p.vz + vel[2];
  return spec;
}
