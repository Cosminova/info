import { Vector3 } from 'three';
import { hashName, rng } from './classify.js';
import { MPC_KM } from './units.js';

const LETTERS = 'bcdefgh';
const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];

/**
 * Invented star systems inside nearby galaxies, in the same shape as the
 * exoplanet archive entries so the existing system renderer can host them.
 *
 * SpaceEngine fills every galaxy with procedural worlds; we cannot do that
 * for thousands of galaxies at once, so a handful of stable systems are placed
 * in each landmark galaxy and in the Milky Way's disc. The names and orbits
 * are hashed from the galaxy id, so a given world is always the same world.
 */
export function inventGalaxySystems(galaxies, galaxyWorld) {
  const systems = [];
  // Host names are built from the galaxy's name, while everything else about a
  // system is hashed from its catalogue id. Those are not one to one: an
  // interacting pair is one name over several rows, so the Antennae alone came
  // back as four separate systems all called "Antennae Galaxies alpha", each
  // hashed differently and each somewhere else in the sky. Every name they own
  // then resolved to whichever was registered last while the other three sat in
  // the destination list unreachable, and two of them in view at once labelled
  // the same star twice in two places. One system per name, first row wins.
  const claimed = new Set();
  for (let g = 0; g < galaxies.length; g++) {
    const galaxy = galaxies[g];
    const gx = galaxyWorld[g * 3];
    const gy = galaxyWorld[g * 3 + 1];
    const gz = galaxyWorld[g * 3 + 2];
    const radiusKm = Math.max(Math.tan(((galaxy.aMaj ?? 0.2) * Math.PI) / 360) * galaxy.d * MPC_KM, 1e15);
    const named = Boolean(galaxy.name) || galaxy.id === 'LMC' || galaxy.id === 'SMC';
    const count = named ? 8 : 0;
    if (!count) continue;
    const short = (galaxy.name || galaxy.id).replace(/ Galaxy$/i, '');
    if (claimed.has(short)) continue;
    claimed.add(short);
    const random = rng(hashName(galaxy.id));
    for (let i = 0; i < count; i++) {
      const theta = random() * Math.PI * 2;
      const radial = (0.18 + random() * 0.55) * radiusKm;
      const height = (random() - 0.5) * radiusKm * 0.08;
      const right = new Vector3(1, 0, 0);
      const out = new Vector3(gx, gy, gz);
      if (out.lengthSq() < 1) out.set(1, 0, 0);
      out.normalize();
      right.crossVectors(new Vector3(0, 1, 0), out);
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
      else right.normalize();
      const up = new Vector3().crossVectors(out, right).normalize();
      const pos = new Vector3(gx, gy, gz)
        .addScaledVector(right, Math.cos(theta) * radial)
        .addScaledVector(up, Math.sin(theta) * radial)
        .addScaledVector(out, height);

      const teff = 3200 + random() * 9000;
      const radiusSol = teff > 7000 ? 1.4 + random() * 2.2 : 0.45 + random() * 0.9;
      const nPlanets = 2 + Math.floor(random() * 4);
      const planets = [];
      let aAu = 0.08 + random() * 0.4;
      for (let p = 0; p < nPlanets; p++) {
        aAu *= 1.5 + random() * 1.1;
        const radiusEarth = 0.4 + random() * (random() > 0.65 ? 11 : 2.4);
        // Satellite systems come out of two processes, and the solar system
        // shows both: a handful of large regular moons accreted in the
        // circumplanetary disc, plus a long tail of captured and collisional
        // moonlets that never grew. A giant gets both and ends up with dozens;
        // a small rocky planet usually gets nothing, and occasionally gets one
        // large moon from a giant impact. So systems do not all look alike.
        const giant = radiusEarth > 3;
        const regular = giant
          ? 1 + Math.floor(random() * 5)
          : radiusEarth > 1.2
            ? (random() > 0.5 ? 1 + Math.floor(random() * 2) : 0)
            : random() > 0.86
              ? 1
              : 0;
        const moonlets = giant
          ? Math.floor(random() ** 2 * 24)
          : Math.floor(random() ** 3 * 5);
        const moonList = [];
        for (let m = 0; m < regular + moonlets; m++) {
          const isRegular = m < regular;
          moonList.push({
            name: `${short} ${GREEK[i % GREEK.length]} ${LETTERS[p]}${m + 1}`,
            // Moon masses follow a steep power law, so a cube of a uniform
            // draw: mostly moonlets a few kilometres across, rarely something
            // the size of Titan. Captured bodies never reach that size at all.
            radiusEarth: isRegular
              ? 0.02 + 0.4 * random() ** 3
              : 0.0004 + 0.02 * random() ** 3,
            aAu: (0.0008 + random() * (isRegular ? 0.004 : 0.02)) * (m + 1),
            periodDays: 1.2 + random() * (isRegular ? 18 : 300),
            // Moonlets are usually captured, and captured orbits are inclined
            // and often retrograde.
            inclinationDeg: isRegular ? random() * 2 : random() * 180,
          });
        }
        planets.push({
          name: `${short} ${GREEK[i % GREEK.length]} ${LETTERS[p]}`,
          aAu,
          periodDays: 365 * Math.pow(aAu, 1.5),
          radiusEarth,
          massEarth: radiusEarth ** 3 * (0.6 + random()),
          equilibriumK: 0.7 * teff * Math.sqrt(0.00465047 / (2 * aAu)),
          moons: moonList,
        });
      }
      systems.push({
        host: `${short} ${GREEK[i % GREEK.length]}`,
        teff,
        radiusSol,
        massSol: radiusSol,
        world: pos,
        galaxy: galaxy.name || galaxy.id,
        planets,
      });
    }
  }
  return systems;
}
