import { Matrix4, Vector3 } from 'three';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/**
 * World convention used everywhere in this app:
 *   +Y is the north celestial pole, RA 0h/Dec 0 lies along +X, and right
 *   ascension increases towards -Z. Viewed from the origin (where the camera
 *   always sits for sky modes) that puts east to the left, matching the real
 *   sky.
 */
export function equatorialToVector(raDeg, decDeg, target = new Vector3()) {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const cd = Math.cos(dec);
  return target.set(cd * Math.cos(ra), Math.sin(dec), -cd * Math.sin(ra));
}

/** Inverse of {@link equatorialToVector}. Returns degrees, RA in [0, 360). */
export function vectorToEquatorial(v) {
  const len = v.length() || 1;
  const dec = Math.asin(Math.min(1, Math.max(-1, v.y / len))) * RAD;
  let ra = Math.atan2(-v.z, v.x) * RAD;
  if (ra < 0) ra += 360;
  return { ra, dec };
}

export function formatRa(raDeg) {
  const totalHours = raDeg / 15;
  const h = Math.floor(totalHours);
  const totalMinutes = (totalHours - h) * 60;
  const m = Math.floor(totalMinutes);
  const s = (totalMinutes - m) * 60;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${s.toFixed(1)}s`;
}

export function formatDec(decDeg) {
  const sign = decDeg < 0 ? '-' : '+';
  const a = Math.abs(decDeg);
  const d = Math.floor(a);
  const totalMinutes = (a - d) * 60;
  const m = Math.floor(totalMinutes);
  const s = (totalMinutes - m) * 60;
  return `${sign}${String(d).padStart(2, '0')}° ${String(m).padStart(2, '0')}′ ${s.toFixed(0)}″`;
}

/** Formats an angle in degrees as a human readable field of view. */
export function formatAngle(deg) {
  if (deg >= 1) return `${deg.toFixed(deg < 10 ? 2 : 1)}°`;
  const arcmin = deg * 60;
  if (arcmin >= 1) return `${arcmin.toFixed(1)}′`;
  return `${(arcmin * 60).toFixed(1)}″`;
}

// ------------------------------------------------------------- galactic frame

// J2000 galactic pole and the galactic longitude of the north celestial pole.
const NGP_RA = 192.85948;
const NGP_DEC = 27.12825;
const L_NCP = 122.93192;

/** Equatorial degrees -> galactic longitude/latitude in degrees. */
export function equatorialToGalactic(raDeg, decDeg) {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const raG = NGP_RA * DEG;
  const decG = NGP_DEC * DEG;

  const sinB =
    Math.sin(dec) * Math.sin(decG) + Math.cos(dec) * Math.cos(decG) * Math.cos(ra - raG);
  const b = Math.asin(Math.min(1, Math.max(-1, sinB)));

  const y = Math.cos(dec) * Math.sin(ra - raG);
  const x =
    Math.sin(dec) * Math.cos(decG) - Math.cos(dec) * Math.sin(decG) * Math.cos(ra - raG);
  let l = L_NCP - Math.atan2(y, x) * RAD;
  l = ((l % 360) + 360) % 360;
  return { l, b: b * RAD };
}

/** Galactic longitude/latitude in degrees -> equatorial degrees. */
export function galacticToEquatorial(lDeg, bDeg) {
  const l = lDeg * DEG;
  const b = bDeg * DEG;
  const raG = NGP_RA * DEG;
  const decG = NGP_DEC * DEG;
  const dl = L_NCP * DEG - l;

  const sinDec = Math.sin(b) * Math.sin(decG) + Math.cos(b) * Math.cos(decG) * Math.cos(dl);
  const dec = Math.asin(Math.min(1, Math.max(-1, sinDec)));

  const y = Math.cos(b) * Math.sin(dl);
  const x = Math.cos(decG) * Math.sin(b) - Math.sin(decG) * Math.cos(b) * Math.cos(dl);
  let ra = (raG + Math.atan2(y, x)) * RAD;
  ra = ((ra % 360) + 360) % 360;
  return { ra, dec: dec * RAD };
}

// -------------------------------------------------------------- time and site

export const J2000 = 2451545.0;

export function dateToJulianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

export function julianCenturies(jd) {
  return (jd - J2000) / 36525;
}

/** Greenwich mean sidereal time in degrees (IAU 1982 series). */
export function greenwichMeanSiderealTime(jd) {
  const T = julianCenturies(jd);
  let gmst =
    280.46061837 +
    360.98564736629 * (jd - J2000) +
    0.000387933 * T * T -
    (T * T * T) / 38710000;
  gmst = ((gmst % 360) + 360) % 360;
  return gmst;
}

export function localSiderealTime(jd, longitudeDeg) {
  return ((greenwichMeanSiderealTime(jd) + longitudeDeg) % 360 + 360) % 360;
}

const NCP = new Vector3(0, 1, 0);

/**
 * Builds the matrix that maps equatorial world vectors into a local horizontal
 * frame where +Y is the zenith, +Z is north and +X is west. Applying it to the
 * sky container is what turns the app from a star globe into a view from a
 * specific place at a specific moment.
 */
export function equatorialToHorizontalMatrix(latitudeDeg, longitudeDeg, date, target = new Matrix4()) {
  const jd = dateToJulianDay(date);
  const lst = localSiderealTime(jd, longitudeDeg);

  const zenith = equatorialToVector(lst, latitudeDeg, new Vector3());
  const north = NCP.clone().addScaledVector(zenith, -NCP.dot(zenith));
  if (north.lengthSq() < 1e-12) north.set(0, 0, 1); // observer at a celestial pole
  north.normalize();
  const west = new Vector3().crossVectors(zenith, north).normalize();

  // Columns are the horizontal basis expressed in equatorial coordinates, so
  // the transpose converts an equatorial vector into horizontal components.
  return target.makeBasis(west, zenith, north).transpose();
}

/** Altitude/azimuth (degrees) of a world-space direction in horizontal frame. */
export function horizontalFromWorld(v) {
  const len = v.length() || 1;
  const altitude = Math.asin(Math.min(1, Math.max(-1, v.y / len))) * RAD;
  // Azimuth measured from north (+Z) towards east (-X).
  let azimuth = Math.atan2(-v.x, v.z) * RAD;
  if (azimuth < 0) azimuth += 360;
  return { altitude, azimuth };
}

/**
 * Relative airmass using Pickering's (2002) interpolation, which stays finite
 * at and below the horizon.
 */
export function airmass(altitudeDeg) {
  const h = Math.max(altitudeDeg, -2);
  return 1 / Math.sin((h + 244 / (165 + 47 * Math.pow(h, 1.1))) * DEG);
}

export function compassPoint(azimuthDeg) {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round((((azimuthDeg % 360) + 360) % 360) / 22.5) % 16];
}
