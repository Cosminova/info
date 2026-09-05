/**
 * Measured bulk properties, for the object inspector.
 *
 * bodies-data.js carries what the renderer needs — radii, rotation, tilt,
 * terrain parameters. This file carries what a reader wants: mass, temperature,
 * albedo, atmosphere. They are kept apart because the renderer should not have
 * to load a table of surface temperatures to draw a sphere.
 *
 * Masses are the JPL Solar System Dynamics physical parameters tables. Planet
 * temperatures are the NASA planetary fact sheet mean surface values, except for
 * the four giants, which have no surface and are quoted at the 1-bar level, and
 * the Sun, which is its effective photospheric temperature. Albedos are
 * geometric, which is why the ring-dusted Saturnian ice moons exceed one.
 *
 * Only bodies with published measurements appear. Most of the several hundred
 * irregular satellites in moons-data.js have never had their mass determined —
 * the inspector omits the row rather than deriving a number from an assumed
 * density and presenting it as a measurement.
 */

const G = 6.6743e-11; // m^3 kg^-1 s^-2

/**
 * mass: kg
 * temperatureK: mean surface, or 1-bar for the giants
 * albedo: geometric
 * atmosphere: dominant constituents, surface pressure where meaningful
 */
export const PHYSICAL = {
  sun: { mass: 1.9885e30, temperatureK: 5772, note: 'photosphere' },

  mercury: { mass: 3.3011e23, temperatureK: 440, albedo: 0.142, atmosphere: 'trace Na, O, H' },
  venus: { mass: 4.8675e24, temperatureK: 737, albedo: 0.689, atmosphere: '96% CO₂, 92 bar' },
  earth: { mass: 5.97217e24, temperatureK: 288, albedo: 0.434, atmosphere: '78% N₂, 21% O₂, 1 bar' },
  mars: { mass: 6.4171e23, temperatureK: 210, albedo: 0.17, atmosphere: '95% CO₂, 6 mbar' },
  jupiter: { mass: 1.8982e27, temperatureK: 165, albedo: 0.538, atmosphere: '90% H₂, 10% He' },
  saturn: { mass: 5.6834e26, temperatureK: 134, albedo: 0.499, atmosphere: '96% H₂, 3% He' },
  uranus: { mass: 8.681e25, temperatureK: 76, albedo: 0.488, atmosphere: '83% H₂, 15% He, 2% CH₄' },
  neptune: { mass: 1.02413e26, temperatureK: 72, albedo: 0.442, atmosphere: '80% H₂, 19% He, 1% CH₄' },
  pluto: { mass: 1.303e22, temperatureK: 44, albedo: 0.52, atmosphere: 'N₂, CH₄, 1 Pa' },

  ceres: { mass: 9.3839e20, temperatureK: 168, albedo: 0.09 },
  vesta: { mass: 2.59076e20, temperatureK: 175, albedo: 0.423 },

  moon: { mass: 7.342e22, temperatureK: 250, albedo: 0.136 },
  phobos: { mass: 1.0659e16, temperatureK: 233, albedo: 0.071 },
  deimos: { mass: 1.4762e15, temperatureK: 233, albedo: 0.068 },

  io: { mass: 8.931938e22, temperatureK: 110, albedo: 0.63, atmosphere: 'SO₂, nanobar' },
  europa: { mass: 4.799844e22, temperatureK: 102, albedo: 0.67 },
  ganymede: { mass: 1.4819e23, temperatureK: 110, albedo: 0.43 },
  callisto: { mass: 1.075938e23, temperatureK: 134, albedo: 0.22 },

  mimas: { mass: 3.7493e19, temperatureK: 64, albedo: 0.962 },
  enceladus: { mass: 1.08022e20, temperatureK: 75, albedo: 1.375 },
  tethys: { mass: 6.17449e20, temperatureK: 86, albedo: 1.229 },
  dione: { mass: 1.095452e21, temperatureK: 87, albedo: 0.998 },
  rhea: { mass: 2.306518e21, temperatureK: 76, albedo: 0.949 },
  titan: { mass: 1.3452e23, temperatureK: 94, albedo: 0.22, atmosphere: '95% N₂, 5% CH₄, 1.5 bar' },
  hyperion: { mass: 5.6199e18, temperatureK: 93, albedo: 0.3 },
  iapetus: { mass: 1.805635e21, temperatureK: 130, albedo: 0.6 },
  phoebe: { mass: 8.292e18, temperatureK: 73, albedo: 0.06 },

  miranda: { mass: 6.59e19, temperatureK: 60, albedo: 0.32 },
  ariel: { mass: 1.2331e21, temperatureK: 60, albedo: 0.53 },
  umbriel: { mass: 1.2885e21, temperatureK: 75, albedo: 0.26 },
  titania: { mass: 3.455e21, temperatureK: 70, albedo: 0.35 },
  oberon: { mass: 3.114e21, temperatureK: 75, albedo: 0.31 },

  triton: { mass: 2.1389e22, temperatureK: 38, albedo: 0.719, atmosphere: 'N₂, 1.4 Pa' },
  proteus: { mass: 4.4e19, temperatureK: 51, albedo: 0.096 },
  nereid: { mass: 3.087e19, temperatureK: 50, albedo: 0.155 },

  charon: { mass: 1.586e21, temperatureK: 53, albedo: 0.372 },
};

/** Surface gravity in m/s², from mass and equatorial radius. */
export function surfaceGravity(massKg, radiusKm) {
  if (!massKg || !radiusKm) return null;
  return (G * massKg) / Math.pow(radiusKm * 1000, 2);
}

/** Mean density in g/cm³. */
export function meanDensity(massKg, radiusKm) {
  if (!massKg || !radiusKm) return null;
  const volumeCm3 = (4 / 3) * Math.PI * Math.pow(radiusKm * 1e5, 3);
  return (massKg * 1000) / volumeCm3;
}

/** Escape velocity in km/s. */
export function escapeVelocity(massKg, radiusKm) {
  if (!massKg || !radiusKm) return null;
  return Math.sqrt((2 * G * massKg) / (radiusKm * 1000)) / 1000;
}

export function physicalFor(key) {
  return PHYSICAL[key] ?? null;
}
