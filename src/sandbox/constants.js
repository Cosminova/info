export const G = 6.674e-11;
export const C_LIGHT = 299792458;
export const SIGMA = 5.670374e-8;
export const AU = 1.495978707e11;
export const LY = 9.4607304725808e15;
export const DAY = 86400;
export const YEAR = 365.25 * DAY;

export const M_SUN = 1.98847e30;
export const R_SUN = 6.957e8;
export const L_SUN = 3.828e26;
export const M_EARTH = 5.97217e24;
export const R_EARTH = 6.371e6;
export const M_JUP = 1.89813e27;
export const M_MOON = 7.342e22;

/** Specific heat of rock, J/(kg·K). */
export const C_ROCK = 1000;

export const RENDER_SCALE = 1e-6;

export function schwarzschild(mass) {
  return (2 * G * mass) / (C_LIGHT * C_LIGHT);
}

export function bindingEnergy(mass, radius) {
  return (0.6 * G * mass * mass) / Math.max(radius, 1);
}

export function escapeVelocity(mass, radius) {
  return Math.sqrt((2 * G * mass) / Math.max(radius, 1));
}

/** Approximate blackbody colour (linear RGB, 0..1) for a temperature in kelvin. */
export function blackbody(T) {
  const t = Math.min(Math.max(T, 1000), 40000) / 100;
  let r;
  let g;
  let b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v) => Math.pow(Math.min(Math.max(v, 0), 255) / 255, 2.2);
  return [c(r), c(g), c(b)];
}

const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

export function sci(v, digits = 3) {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const e = Math.floor(Math.log10(Math.abs(v)));
  if (e >= digits && e < 5) return Number(v.toPrecision(digits)).toLocaleString('en-US');
  if (e >= -2 && e < 5) return trim(v.toPrecision(digits));
  const m = v / Math.pow(10, e);
  return `${trim(m.toPrecision(digits))}×10${String(e).replace(/./g, (ch) => SUP[ch])}`;
}

function trim(s) {
  return s.includes('e') ? s : s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function fmtMass(kg) {
  if (kg >= 0.01 * M_SUN) return `${sci(kg / M_SUN)} M☉`;
  if (kg >= 0.05 * M_JUP) return `${sci(kg / M_JUP)} M♃`;
  if (kg >= 1e-4 * M_EARTH) return `${sci(kg / M_EARTH)} M⊕`;
  return `${sci(kg)} kg`;
}

export function fmtDist(m) {
  const a = Math.abs(m);
  if (a >= 0.05 * LY) return `${sci(m / LY)} ly`;
  if (a >= 0.01 * AU) return `${sci(m / AU)} AU`;
  if (a >= 1e4) return `${sci(m / 1000)} km`;
  return `${sci(m)} m`;
}

export function fmtSpeed(ms) {
  const a = Math.abs(ms);
  if (a >= 0.01 * C_LIGHT) return `${sci(ms / C_LIGHT)} c`;
  const num = (v) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : sci(v));
  if (a >= 1000) return `${num(ms / 1000)} km/s`;
  return `${num(ms)} m/s`;
}

export function fmtDuration(s) {
  const a = Math.abs(s);
  if (a < 120) return `${sci(s)} s`;
  if (a < 2 * 3600) return `${sci(s / 60)} min`;
  if (a < 2 * DAY) return `${sci(s / 3600)} h`;
  if (a < 60 * DAY) return `${sci(s / DAY)} days`;
  if (a < 2 * YEAR) return `${sci(s / (30.44 * DAY))} months`;
  if (a < 2e6 * YEAR) return `${sci(s / YEAR)} years`;
  return `${sci(s / (1e6 * YEAR))} Myr`;
}

export function fmtTemp(K) {
  return `${Math.round(K).toLocaleString()} K (${Math.round(K - 273.15).toLocaleString()} °C)`;
}

/** Simulation speeds offered by the slower/faster buttons, in sim seconds per real second. */
export const SPEEDS = [
  1, 10, 60, 600, 3600, 6 * 3600, DAY, 7 * DAY, 30.44 * DAY, 0.25 * YEAR, YEAR, 10 * YEAR, 100 * YEAR,
  1e3 * YEAR, 1e4 * YEAR, 1e5 * YEAR, 1e6 * YEAR, 1e7 * YEAR,
];

export function fmtRate(r) {
  const a = Math.abs(r);
  const sign = r < 0 ? '−' : '';
  const units = [
    [1e6 * YEAR, 'Myr'], [1e3 * YEAR, 'kyr'], [YEAR, 'years'], [30.44 * DAY, 'months'], [7 * DAY, 'weeks'],
    [DAY, 'days'], [3600, 'hours'], [60, 'min'], [1, 'sec'],
  ];
  for (const [u, name] of units) {
    if (a >= u * 0.999) {
      const n = trim((a / u).toPrecision(3));
      const label = n === '1' && name.endsWith('s') ? name.slice(0, -1) : name;
      return `${sign}${n} ${label}/sec`;
    }
  }
  return `${sign}${trim(a.toPrecision(3))} sec/sec`;
}
