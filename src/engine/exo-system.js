import { Quaternion, Vector3 } from 'three';
import { describePlanet } from './classify.js';
import { proceduralCraft } from './craft-missions.js';
import { Planet } from './planet.js';
import { Star } from './star.js';
import { colorIndexToLinearRgb } from '../color.js';
import { AU_KM, equatorialToEcliptic, SOLAR_RADIUS_KM } from './units.js';
import { equatorialToVector } from '../astro.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const IDENTITY = new Quaternion();

function slug(name) {
  return `exo:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function teffToBv(teff) {
  if (!teff) return 0.65;
  return Math.max(-0.3, Math.min(2.0, (5601 / teff) - 0.47));
}

function paletteArrays(described) {
  const p = described.palette;
  if (!p) return null;
  if (Array.isArray(p)) return p;
  return [p.desert ?? p.upland, p.lowland ?? p.rock, p.beach ?? p.shelf, p.snow ?? [0.9, 0.9, 0.92]];
}

/**
 * The relief a rocky world without a measured elevation map is given, as a
 * fraction of its radius. Mirrors the default in Planet's uMacroRelief, and is
 * here because the waterline has to be placed inside that range: a sea level
 * set independently of the terrain is either a puddle or a drowned planet.
 */
const MACRO_RELIEF = 0.004;

function specFromPlanet(entry, described, hostKey) {
  const gaseous = described.gaseous;
  const palette = paletteArrays(described);
  const airless = described.volatiles === 'airless';
  // A starting guess only. The waterline that actually floods the fraction the
  // volatile class asked for depends on the shape of this world's own height
  // distribution, which is measured off the GPU on first sight: see
  // Planet.calibrateSeaLevel.
  const oceanFraction = gaseous ? 0 : described.oceanLevel ?? 0;
  const seaLevelKm = oceanFraction
    ? (0.30 + 0.52 * oceanFraction) * MACRO_RELIEF * described.radiusKm
    : 0;
  const stops = described.palette;
  return {
    key: slug(entry.name),
    name: entry.name,
    parent: hostKey,
    radiusKm: described.radiusKm,
    rotationHours: described.rotationHours,
    tiltDeg: described.tiltDeg,
    craterFreq: gaseous ? 80 : 260,
    craterOctaves: gaseous ? 0 : 6,
    craterDepth: gaseous ? 0 : 0.2,
    craterDensity: described.craterDensity,
    roughness: described.roughness,
    photometry: gaseous ? 0.1 : 0.75,
    albedoBoost: gaseous ? 1.15 : 1.25,
    iceLatitude: described.icecapLatitude,
    palette,
    // Zonal cloud instead of continents. Without it a giant is drawn with the
    // blotchy field meant for rock and reads as a mottled ball.
    banding: gaseous ? 1 : 0,
    polarSmooth: gaseous ? 1 : 0,
    seaLevelKm,
    oceanFraction,
    seaDeep: stops?.sea,
    seaShallow: stops?.shelf,
    // Sun glint is what tells you at a glance that the blue is liquid.
    specular: seaLevelKm > 0 ? 0.9 : 0,
    // Gas giants carry their weather in their own palette already; this is the
    // deck over a solid surface.
    cloudCover: gaseous ? 0 : described.cloudCover,
    // Storm cells, not continents: a handful of cycles over the whole sphere
    // gives half a dozen blobs and reads as marbling rather than weather.
    cloudFreq: 7.0 + (described.radiusEarth > 2 ? 2.5 : 0),
    maxPatches: 1200,
    maxLevel: 13,
    pixelsPerQuad: 6,
    atmosphere: gaseous
      ? { height: 0.08, density: 2.2, tint: palette[0] }
      : airless
        ? null
        // Thicker and bluer than it was. From low altitude the band of air over
        // the horizon is most of what makes a world look like somewhere you
        // could stand, and a thin one leaves the ground meeting black sky.
        : { height: 0.028, density: 1.5, tint: [0.38, 0.58, 1] },
    classLabel: described.label,
    aAu: entry.aAu,
    periodDays: entry.periodDays,
    eccentricity: entry.eccentricity ?? 0,
  };
}

function specFromMoon(entry, described, parentKey) {
  const palette = paletteArrays(described);
  const radiusKm = Math.max(described.radiusKm, 2);
  // Crater frequency is in cells per radius, so a fixed value would give a 5 km
  // moonlet nothing but 25-metre pits and a 2,000 km moon nothing but basins.
  // Anchoring the largest cell near a fixed fraction of the body instead keeps
  // the basin-to-pit range comparable across sizes, and small bodies get a
  // saturated surface because they have had no resurfacing to erase anything.
  const craterFreq = clamp(radiusKm * 0.12, 8, 260);
  return {
    key: slug(entry.name),
    name: entry.name,
    parent: parentKey,
    radiusKm,
    rotationHours: described.rotationHours || 20,
    tiltDeg: described.tiltDeg,
    inclinationDeg: entry.inclinationDeg,
    craterFreq,
    craterOctaves: 7,
    craterDepth: radiusKm < 200 ? 0.3 : 0.22,
    craterDensity: radiusKm < 200 ? 0.85 : 0.6,
    roughness: radiusKm < 200 ? 0.32 : 0.22,
    photometry: 1,
    albedoBoost: 1.35,
    iceLatitude: described.icecapLatitude,
    palette,
    maxPatches: 1600,
    maxLevel: 14,
    patchResolution: 20,
    pixelsPerQuad: 5,
    classLabel: described.label,
    aAu: entry.aAu,
    periodDays: entry.periodDays,
  };
}

function hostPosition(system) {
  if (system.world) return system.world.clone();
  const dir = equatorialToVector(system.ra, system.dec);
  equatorialToEcliptic(dir);
  dir.multiplyScalar(system.distPc * 3.0856775814913673e13);
  return dir;
}

/**
 * Instantiates one planetary system around its host. Only one of these is
 * kept alive at a time: there are thousands of systems and each planet is a
 * full terrain renderer.
 */
export class ExoSystem {
  constructor(system) {
    this.system = system;
    this.key = `star:${system.host}`;
    this.position = hostPosition(system);
    const teff = system.teff ?? 5500;
    const colour = colorIndexToLinearRgb(teffToBv(teff), 0.9);
    // Stefan-Boltzmann, in solar units, so a planet's irradiance can be quoted
    // in Earth-equivalents: an M dwarf's habitable zone sits far closer in than
    // a Sun's, and lighting the planets as if every host were the Sun blows
    // every close orbit to white.
    this.luminositySol = ((system.radiusSol || 1) ** 2) * ((teff / 5772) ** 4);
    this.star = new Star({
      radiusKm: (system.radiusSol || 1) * SOLAR_RADIUS_KM,
      colour,
      intensity: 2.6,
    });
    this.star.group.name = this.key;

    this.planets = [];
    this.moons = [];
    for (const entry of system.planets) {
      if (!entry.aAu && !entry.periodDays) continue;
      const described = describePlanet(entry, { starTeff: system.teff, aAu: entry.aAu });
      const spec = specFromPlanet(entry, described, this.key);
      if (!spec.aAu) {
        spec.aAu = entry.periodDays ? Math.cbrt((entry.periodDays / 365.25) ** 2 * (system.massSol || 1)) : 0.5;
      }
      spec.orbitKm = spec.aAu * AU_KM;
      spec.orbitDays = entry.periodDays || 365 * Math.pow(spec.aAu, 1.5);
      const planet = new Planet(spec);
      const item = { spec, planet, angle0: hashAngle(entry.name), moons: [] };
      this.planets.push(item);
      for (const moonEntry of entry.moons ?? []) {
        const moonDesc = describePlanet(
          {
            name: moonEntry.name,
            radiusEarth: moonEntry.radiusEarth ?? 0.2,
            massEarth: moonEntry.massEarth,
          },
          { starTeff: system.teff, aAu: spec.aAu },
        );
        const moonSpec = specFromMoon(moonEntry, moonDesc, spec.key);
        moonSpec.orbitKm = (moonEntry.aAu || 0.002) * AU_KM;
        moonSpec.orbitDays = moonEntry.periodDays || 3 + hashAngle(moonEntry.name);
        const moon = new Planet(moonSpec);
        item.moons.push({ spec: moonSpec, planet: moon, angle0: hashAngle(moonEntry.name) });
        this.moons.push(item.moons[item.moons.length - 1]);
      }
    }
  }

  place(date, cameraWorld) {
    const days = date.getTime() / 86400000;
    const host = this.position;
    this.star.group.position.set(host.x - cameraWorld.x, host.y - cameraWorld.y, host.z - cameraWorld.z);
    for (const item of this.planets) {
      const angle = item.angle0 + (days / item.spec.orbitDays) * Math.PI * 2;
      const r = item.spec.orbitKm;
      const incl = ((item.spec.tiltDeg * Math.PI) / 180) * 0.15;
      const x = host.x + r * Math.cos(angle);
      const y = host.y + r * Math.sin(angle) * Math.sin(incl);
      const z = host.z + r * Math.sin(angle) * Math.cos(incl);
      item.planet.group.position.set(x - cameraWorld.x, y - cameraWorld.y, z - cameraWorld.z);
      item.world = item.world || new Vector3();
      item.world.set(x, y, z);
      for (const moon of item.moons) {
        const ma = moon.angle0 + (days / moon.spec.orbitDays) * Math.PI * 2;
        const mr = moon.spec.orbitKm;
        const mIncl = ((moon.spec.inclinationDeg ?? 0) * Math.PI) / 180;
        const mx = x + mr * Math.cos(ma);
        const my = y + mr * Math.sin(ma) * Math.sin(mIncl);
        const mz = z + mr * Math.sin(ma) * Math.cos(mIncl);
        moon.planet.group.position.set(mx - cameraWorld.x, my - cameraWorld.y, mz - cameraWorld.z);
        moon.world = moon.world || new Vector3();
        moon.world.set(mx, my, mz);
      }
    }
  }

  /**
   * The same body lookup the Universe offers, so anything that positions itself
   * against a body — spacecraft, for one — works here without knowing whether
   * it is in the Solar System or eleven parsecs away.
   *
   * Only valid once `place` has run for the current date.
   */
  get(key) {
    if (key === this.key) {
      return {
        key,
        position: this.position,
        orientation: IDENTITY,
        spec: { name: this.system.host, radiusKm: this.star.radiusKm },
      };
    }
    for (const item of this.planets) {
      if (item.spec.key === key && item.world) {
        return { key, position: item.world, orientation: item.planet.spin.quaternion, spec: item.spec };
      }
    }
    for (const moon of this.moons) {
      if (moon.spec.key === key && moon.world) {
        return { key, position: moon.world, orientation: moon.planet.spin.quaternion, spec: moon.spec };
      }
    }
    return undefined;
  }

  /** The invented hardware around this system. See proceduralCraft. */
  craftSpecs() {
    return proceduralCraft({
      host: this.system.host,
      bodies: [
        ...this.planets.map((item) => ({
          key: item.spec.key,
          name: item.spec.name,
          radiusKm: item.spec.radiusKm,
          gaseous: !!item.spec.atmosphere && item.spec.craterOctaves === 0,
        })),
        ...this.moons.map((moon) => ({
          key: moon.spec.key,
          name: moon.spec.name,
          radiusKm: moon.spec.radiusKm,
          gaseous: false,
        })),
      ],
    });
  }

  dispose() {
    this.star.group.removeFromParent();
    for (const item of this.planets) {
      item.planet.group.removeFromParent();
      for (const moon of item.moons) moon.planet.group.removeFromParent();
    }
  }
}

function hashAngle(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

export function findSystem(systems, host) {
  const want = host.toLowerCase();
  return systems.find((s) => s.host.toLowerCase() === want);
}

export { hostPosition, teffToBv };
