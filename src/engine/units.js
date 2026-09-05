import { Quaternion, Vector3 } from 'three';

export const AU_KM = 149597870.7;
export const PC_KM = 3.0856775814913673e13;
export const LY_KM = 9.4607304725808e12;
export const KPC_KM = PC_KM * 1e3;
export const MPC_KM = PC_KM * 1e6;
export const SOLAR_RADIUS_KM = 695700;
export const EARTH_RADIUS_KM = 6371;
export const ECLIPTIC_OBLIQUITY = 23.4392911 * (Math.PI / 180);

const _eqToEcl = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -ECLIPTIC_OBLIQUITY);

/** Equatorial three.js vector (Y = NCP) into the ecliptic world frame. */
export function equatorialToEcliptic(v, out = v) {
  return out.copy(v).applyQuaternion(_eqToEcl);
}

export function formatDistance(km) {
  const abs = Math.abs(km);
  if (abs < 0.001) return `${(km * 1e6).toFixed(0)} mm`;
  if (abs < 1) return `${(km * 1000).toFixed(abs < 0.01 ? 1 : 0)} m`;
  if (abs < 1e6) return `${km.toLocaleString(undefined, { maximumFractionDigits: abs < 10 ? 2 : 0 })} km`;
  const au = km / AU_KM;
  if (au < 0.01) return `${(km / 1e6).toFixed(2)} million km`;
  if (au < 1000) return `${au.toFixed(au < 10 ? 3 : 1)} AU`;
  const ly = km / LY_KM;
  if (ly < 0.1) return `${(km / PC_KM).toFixed(3)} pc`;
  if (ly < 10) return `${ly.toFixed(2)} ly`;
  const pc = km / PC_KM;
  if (pc < 1000) return `${pc.toFixed(pc < 10 ? 2 : 1)} pc`;
  const kpc = km / KPC_KM;
  if (kpc < 1000) return `${kpc.toFixed(kpc < 10 ? 2 : 1)} kpc`;
  return `${(km / MPC_KM).toFixed(km / MPC_KM < 10 ? 2 : 1)} Mpc`;
}

/** Order-of-magnitude label for the Powers-of-Ten scale strip. */
export function scaleStep(km) {
  const abs = Math.max(km, 1e-6);
  const exp = Math.floor(Math.log10(abs));
  const steps = [
    [-3, '1 m'],
    [-2, '10 m'],
    [-1, '100 m'],
    [0, '1 km'],
    [1, '10 km'],
    [2, '100 km'],
    [3, '1 000 km'],
    [4, '10 000 km'],
    [5, 'Earth'],
    [6, 'lunar orbit'],
    [8, '1 million km'],
    [8.17, '1 AU'],
    [13, '1 ly'],
    [13.49, '1 pc'],
    [16.49, '1 kpc'],
    [19.49, '1 Mpc'],
    [22.49, '1 Gpc'],
  ];
  void exp;
  const log = Math.log10(abs);
  let label = '1 m';
  for (const [e, name] of steps) {
    if (log >= e - 0.15) label = name;
  }
  return { log, label, exp };
}
