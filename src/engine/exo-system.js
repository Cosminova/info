import { DataTexture, LinearFilter, Quaternion, RGBAFormat, SRGBColorSpace, Vector3 } from 'three';
import { describePlanet, hashName, rng as seeded } from './classify.js';
import { inventGeology } from './geology.js';
import { createRings } from './rings.js';
import { starLook, starTint, surfaceBrightness } from './stellar.js';
import { proceduralCraft } from './craft-missions.js';
import { Planet } from './planet.js';
import { exoOrbit, moonOrbit, orbitOffset } from './kepler.js';
import { Star } from './star.js';
import { AU_KM, equatorialToEcliptic, SOLAR_RADIUS_KM } from './units.js';
import { equatorialToVector } from '../astro.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const IDENTITY = new Quaternion();
const ZERO = Object.freeze(new Vector3());

/**
 * The key a planet or moon of another star is known by, everywhere.
 *
 * Exported because space.js registers the same bodies as destinations and used
 * to spell this out again inline. Two copies of a key format is one copy too
 * many: a row in the destination list whose key does not match the spec key the
 * scene builds resolves to nothing, and the failure is a search result that
 * cannot be travelled to rather than an error.
 */
export function exoKey(name) {
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

/** What the inspector shows of an invented or catalogue world beyond its orbit. */
function detailsOf(described) {
  return {
    temperatureK: described.temperatureK,
    life: described.life,
    lifeNote: described.lifeNote,
    air: described.air,
    oceanKind: described.oceanKind,
    volatiles: described.volatiles,
    bulk: described.bulk,
  };
}

/**
 * How thick the drawn air is, from the surface pressure: a Martian wisp, an
 * Earth, or a Venusian ocean of gas that hides the ground.
 */
function airDensity(pressureBar) {
  if (!pressureBar) return 1.5;
  return clamp(1.3 + Math.log10(pressureBar) * 0.75, 0.35, 3.2);
}

function specFromPlanet(entry, described, hostKey) {
  const gaseous = described.gaseous;
  const palette = paletteArrays(described);
  const airless = described.volatiles === 'airless';
  const random = seeded(hashName(`${entry.name}:geo`));
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
    key: exoKey(entry.name),
    name: entry.name,
    parent: hostKey,
    radiusKm: described.radiusKm,
    rotationHours: described.rotationHours,
    tiltDeg: described.tiltDeg,
    craterFreq: gaseous ? 80 : Math.round(260 * described.craterScale),
    craterOctaves: gaseous ? 0 : described.craterOctaves,
    craterDepth: described.craterDepth,
    craterDensity: described.craterDensity,
    roughness: described.roughness,
    // Continents, ranges and hills, relatively taller on a small world the way
    // Mars stands higher for its size than Earth. The ridged swell under them
    // is turned down: flooded on its own it filled into round pools.
    terrain: gaseous ? 0 : clamp(0.0024 * Math.sqrt(6371 / described.radiusKm), 0.0012, 0.006),
    macroRelief: gaseous ? 0 : 0.0012,
    // Worn, sharp-crested mountain ranges on top, peaks a few kilometres high
    // with features about ten kilometres across.
    erosion: gaseous ? 0 : clamp(described.radiusKm * 0.0003, 0.8, 3),
    erosionFreq: gaseous ? 400 : Math.round(described.radiusKm / 10),
    rockDensity: gaseous ? 0 : 0.5,
    // Mesas and stepped cliffs, strongest on dry worlds where nothing fills
    // the steps back in; benches a few hundred metres high.
    // Benched mesa country is a local landform, not a world's whole surface:
    // laid over everything it turned the land into contour lines.
    terrace: gaseous ? 0 : clamp((described.terrace ?? 0) * (oceanFraction > 0.6 ? 0.4 : 1) * 1.3 - 0.8, 0, 0.45),
    terraceKm: 0.12 + ((described.terrace ?? 0) * 13.7 % 1) * 0.5,
    // How large the surface provinces are: a world of a few continents or one
    // of many islands.
    paletteFreq: gaseous ? 2.2 : described.provinceScale,
    photometry: gaseous ? 0.1 : 0.75,
    albedoBoost: gaseous ? 1.15 : 1.25,
    iceLatitude: described.icecapLatitude,
    palette,
    // Zonal cloud instead of continents. Without it a giant is drawn with the
    // blotchy field meant for rock and reads as a mottled ball.
    banding: gaseous ? described.bandScale || 1 : 0,
    heatGlow: described.heatGlow,
    heatColour: described.heatColour,
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
    cloudFreq: 2.6 + described.provinceScale * 0.6 + (described.radiusEarth > 2 ? 1.2 : 0),
    maxPatches: gaseous ? 1200 : 1800,
    maxLevel: gaseous ? 13 : 19,
    pixelsPerQuad: 6,
    atmosphere: gaseous
      ? { height: 0.08, density: 2.2, tint: palette[0] }
      : airless
        ? null
        // Thicker and bluer than it was. From low altitude the band of air over
        // the horizon is most of what makes a world look like somewhere you
        // could stand, and a thin one leaves the ground meeting black sky.
        : {
            height: 0.028 * clamp(0.7 + Math.log10((described.air?.pressureBar ?? 1) + 0.1) * 0.25, 0.5, 1.4),
            density: airDensity(described.air?.pressureBar),
            tint: described.hazeTint,
            // Past about ten bar the air is a Venus: one unbroken deck.
            overcast: clamp((Math.log10(described.air?.pressureBar ?? 1) - 0.8) / 0.8, 0, 1),
          },
    cloudTint: described.hazeTint && (described.air?.pressureBar ?? 1) > 6
      ? described.hazeTint.map((c) => 0.55 + 0.45 * c)
      : undefined,
    geology: gaseous ? null : inventGeology({ radiusKm: described.radiusKm, bulk: described.bulk === 'aquaria' ? 'ice' : 'rock' }, random),
    details: detailsOf(described),
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
  const craterFreq = clamp(radiusKm * 0.12 * described.craterScale, 8, 260);
  return {
    key: exoKey(entry.name),
    name: entry.name,
    parent: parentKey,
    radiusKm,
    rotationHours: described.rotationHours || 20,
    tiltDeg: described.tiltDeg,
    inclinationDeg: entry.inclinationDeg,
    craterFreq,
    craterOctaves: 7,
    // A moon that has been resurfaced keeps shallow filled craters; one that
    // never was keeps every sharp rim it was given.
    craterDepth: (radiusKm < 200 ? 0.3 : 0.22) * (0.7 + described.craterDepth * 1.6),
    craterDensity: radiusKm < 200 ? 0.85 : 0.6,
    roughness: radiusKm < 200 ? 0.32 : 0.22,
    terrain: radiusKm > 300 ? 0.0016 : 0,
    photometry: 1,
    albedoBoost: 1.35,
    iceLatitude: described.icecapLatitude,
    palette,
    paletteFreq: described.provinceScale,
    geology: inventGeology({ radiusKm, bulk: described.temperatureK < 170 ? 'ice' : 'rock' }, seeded(hashName(`${entry.name}:geo`))),
    details: detailsOf(described),
    maxPatches: 1600,
    maxLevel: 18,
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
    // Saturated past the true chromaticity and kept under the clipping point,
    // as for catalogue stars in space.js: a disc drawn at full brightness is
    // tone mapped to white whatever colour it was, which is why every host
    // star used to look the same.
    const colour = starTint(teff);
    // Stefan-Boltzmann, in solar units, so a planet's irradiance can be quoted
    // in Earth-equivalents: an M dwarf's habitable zone sits far closer in than
    // a Sun's, and lighting the planets as if every host were the Sun blows
    // every close orbit to white.
    this.luminositySol = ((system.radiusSol || 1) ** 2) * ((teff / 5772) ** 4);
    this.star = new Star({
      radiusKm: (system.radiusSol || 1) * SOLAR_RADIUS_KM,
      colour,
      intensity: 0.95 * surfaceBrightness(teff),
      look: starLook(teff, system.radiusSol || 1, hashName(system.host ?? '')),
    });
    this.star.group.name = this.key;
    this.companion = companionFor(system, teff);
    if (this.companion?.close) this.luminositySol += this.companion.luminositySol;

    this.planets = [];
    this.moons = [];
    for (const entry of system.planets) {
      if (!entry.aAu && !entry.periodDays) continue;
      const described = describePlanet(entry, { starTeff: system.teff, aAu: entry.aAu });
      const spec = { ...specFromPlanet(entry, described, this.key), ...PORTRAITS[entry.name] };
      if (!spec.aAu) {
        spec.aAu = entry.periodDays ? Math.cbrt((entry.periodDays / 365.25) ** 2 * (system.massSol || 1)) : 0.5;
      }
      spec.orbitKm = spec.aAu * AU_KM;
      spec.orbitDays = entry.periodDays || 365 * Math.pow(spec.aAu, 1.5);
      // Round a close pair, a planet can only survive well outside the pair
      // itself, the way Kepler-16b circles both its suns.
      if (this.companion?.close && spec.orbitKm < this.companion.separationKm * 3.5) {
        spec.orbitKm = this.companion.separationKm * (3.5 + hashAngle(`${entry.name}:cb`) * 0.3);
        spec.aAu = spec.orbitKm / AU_KM;
        spec.orbitDays = 365.25 * Math.sqrt(spec.aAu ** 3 / Math.max((system.massSol || 1) + this.companion.massSol, 0.1));
      }
      const planet = new Planet(spec);
      const item = { spec, planet, angle0: hashAngle(entry.name), moons: [] };
      // Giants out past where ice survives; a hot Jupiter's would have boiled off.
      // A rocky world keeps one now and then too, from a moon torn apart.
      const ringRoll = hashAngle(`${entry.name}:rings`);
      if ((spec.banding && spec.aAu > 0.6 && ringRoll < Math.PI * 1.1)
        || (!spec.banding && spec.aAu > 0.3 && ringRoll < Math.PI * 0.16)) {
        item.rings = ringSystemFor(spec, hashName(`${entry.name}:rings`));
        planet.spin.add(item.rings.mesh);
        planet.setRings(item.rings.texture, item.rings.innerKm, item.rings.outerKm);
      }
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

  /**
   * Positions every body for a date.
   *
   * Each body keeps `local`, its offset from the host star, as well as `world`.
   * The world position is the host's plus that offset, and ten megaparsecs out
   * a double is spaced 65,000 kilometres apart, so the sum rounds a planet's
   * orbit to that grid and anything drawn from it shakes as the camera moves.
   * The local offsets stay exact; see `localOf`.
   */
  place(date, cameraWorld) {
    const days = date.getTime() / 86400000;
    const host = this.position;
    this.star.group.position.set(host.x - cameraWorld.x, host.y - cameraWorld.y, host.z - cameraWorld.z);
    if (this.companion) {
      const c = this.companion;
      const angle = c.phase + (days / c.periodDays) * Math.PI * 2;
      c.local.set(c.separationKm * Math.cos(angle), c.separationKm * Math.sin(angle) * Math.sin(c.incl), c.separationKm * Math.sin(angle) * Math.cos(c.incl));
      c.world.copy(host).add(c.local);
      if (c.twin) {
        // Beside the first star, across the line of sight from the host.
        const t = c.twin;
        t.local.set(-c.local.z, 0, c.local.x).setLength(t.offsetKm).add(c.local);
        t.world.copy(host).add(t.local);
      }
    }
    for (const item of this.planets) {
      const angle = item.angle0 + (days / item.spec.orbitDays) * Math.PI * 2;
      item.local = item.local || new Vector3();
      orbitOffset(item.local, exoOrbit(item.spec), angle);
      item.world = item.world || new Vector3();
      item.world.copy(host).add(item.local);
      item.planet.group.position.copy(item.world).sub(cameraWorld);
      for (const moon of item.moons) {
        const ma = moon.angle0 + (days / moon.spec.orbitDays) * Math.PI * 2;
        moon.local = moon.local || new Vector3();
        orbitOffset(moon.local, moonOrbit(moon.spec), ma).add(item.local);
        moon.world = moon.world || new Vector3();
        moon.world.copy(host).add(moon.local);
        moon.planet.group.position.copy(moon.world).sub(cameraWorld);
      }
    }
  }

  /** A body's exact offset from the host star, or null if it is not one of this system's. */
  localOf(key) {
    if (key === this.key) return ZERO;
    for (const item of this.planets) if (item.spec.key === key) return item.local ?? null;
    for (const moon of this.moons) if (moon.spec.key === key) return moon.local ?? null;
    return null;
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
        return { key, position: item.world, orientation: item.planet.spin.quaternion, spec: item.spec, planet: item.planet };
      }
    }
    for (const moon of this.moons) {
      if (moon.spec.key === key && moon.world) {
        return { key, position: moon.world, orientation: moon.planet.spin.quaternion, spec: moon.spec, planet: moon.planet };
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
    this.companion?.star.group.removeFromParent();
    this.companion?.twin?.star.group.removeFromParent();
    for (const item of this.planets) {
      item.planet.group.removeFromParent();
      for (const moon of item.moons) moon.planet.group.removeFromParent();
      if (item.rings) {
        item.rings.mesh.geometry.dispose();
        item.rings.material.dispose();
        item.rings.texture.dispose();
      }
    }
  }
}

/**
 * A second star, for a third of the invented systems: about the fraction of
 * Sun-like stars that have one. Either a close pair the planets orbit both of,
 * or a wide companion far beyond the planets that is a second sun in their
 * sky; now and then a white dwarf, the burnt-out core of what was once the
 * brighter of the two. Catalogue systems keep the stars they are known to have.
 */
function companionFor(system, teff) {
  if (!system.generated) return knownCompanion(system);
  const random = seeded(hashName(`${system.host}:companion`));
  if (random() > 0.34) return null;
  const close = random() < 0.4;
  const whiteDwarf = random() < 0.12;
  const radiusA = system.radiusSol || 1;
  const teffB = whiteDwarf ? 9000 + random() * 16000 : clamp(teff * (0.5 + random() * 0.6), 2700, 32000);
  const radiusSol = whiteDwarf ? 0.012 : clamp(Math.min(radiusA, 2) * (0.35 + random() * 0.75), 0.12, 6);
  const massSol = whiteDwarf ? 0.6 : radiusSol ** 1.25;
  const widest = Math.max(0, ...system.planets.map((p) => p.aAu ?? 0));
  const separationAu = close
    ? Math.max(0.04 + random() * 0.18, (radiusA + radiusSol) * 0.00465047 * 4)
    : Math.max(25 + random() * 250, widest * 4);
  const separationKm = separationAu * AU_KM;
  const colour = starTint(teffB);
  const star = new Star({
    radiusKm: radiusSol * SOLAR_RADIUS_KM,
    colour,
    intensity: 0.95 * surfaceBrightness(teffB),
    look: starLook(teffB, radiusSol, hashName(`${system.host}:B`)),
  });
  star.group.name = `star:${system.host}:B`;
  const luminositySol = radiusSol ** 2 * (teffB / 5772) ** 4;
  const info = {
    close,
    whiteDwarf,
    teff: teffB,
    radiusSol,
    massSol,
    separationAu,
    periodDays: 365.25 * Math.sqrt(separationAu ** 3 / Math.max((system.massSol || 1) + massSol, 0.1)),
  };
  // For the inspector, which only sees the system's data.
  system.companionInfo = info;
  return {
    ...info,
    star,
    separationKm,
    luminositySol,
    phase: random() * Math.PI * 2,
    incl: (random() - 0.5) * (close ? 0.1 : 0.8),
    local: new Vector3(),
    world: new Vector3(),
  };
}

/**
 * Stars a catalogue system is known to have beyond the one its planets
 * circle. The archive lists planets by host, so a host that is one star of a
 * triple comes without the other two; these are put back from the literature.
 * `twin` is the second star of a distant pair, drawn beside the first.
 */
const KNOWN_COMPANIONS = {
  // GJ 667 A and B, a K3 and K5 pair 12 AU apart, some 230 AU from C.
  'GJ 667 C': { teff: 4600, radiusSol: 0.76, massSol: 0.73, separationAu: 230, twin: { teff: 4400, radiusSol: 0.7, offsetAu: 12 } },
};

function starFor(teff, radiusSol, seedName) {
  return new Star({
    radiusKm: radiusSol * SOLAR_RADIUS_KM,
    colour: starTint(teff),
    intensity: 0.95 * surfaceBrightness(teff),
    look: starLook(teff, radiusSol, hashName(seedName)),
  });
}

function knownCompanion(system) {
  const known = KNOWN_COMPANIONS[system.host];
  if (!known) return null;
  const random = seeded(hashName(`${system.host}:companion`));
  const star = starFor(known.teff, known.radiusSol, `${system.host}:A`);
  star.group.name = `star:${system.host}:B`;
  const info = {
    close: false,
    whiteDwarf: false,
    teff: known.teff,
    radiusSol: known.radiusSol,
    massSol: known.massSol,
    separationAu: known.separationAu,
    periodDays: 365.25 * Math.sqrt(known.separationAu ** 3 / Math.max((system.massSol || 0.3) + known.massSol, 0.1)),
  };
  system.companionInfo = info;
  const twin = known.twin && {
    star: starFor(known.twin.teff, known.twin.radiusSol, `${system.host}:twin`),
    offsetKm: known.twin.offsetAu * AU_KM,
    luminositySol: known.twin.radiusSol ** 2 * (known.twin.teff / 5772) ** 4,
    local: new Vector3(),
    world: new Vector3(),
  };
  return {
    ...info,
    star,
    twin,
    separationKm: known.separationAu * AU_KM,
    luminositySol: known.radiusSol ** 2 * (known.teff / 5772) ** 4,
    phase: random() * Math.PI * 2,
    incl: (random() - 0.5) * 0.8,
    local: new Vector3(),
    world: new Vector3(),
  };
}

/**
 * Planets drawn to a reference picture rather than left to the generator:
 * whatever is set here replaces what classification invented for them.
 */
const PORTRAITS = {
  // A dry, rust-red desert under thin air: near-black teal sky overhead,
  // warm dust low down, and worn, sharp ranges standing out of the plains.
  'GJ 667 C c': {
    palette: [[0.6, 0.29, 0.17], [0.47, 0.23, 0.15], [0.66, 0.4, 0.27], [0.86, 0.8, 0.74]],
    iceLatitude: 0,
    oceanFraction: 0,
    seaLevelKm: 0,
    specular: 0,
    cloudCover: 0,
    terrace: 0,
    rockDensity: 0.12,
    craterOctaves: 2,
    erosion: 2.6,
    atmosphere: {
      height: 0.02,
      density: 0.25,
      tint: [0.22, 0.6, 0.66],
      aerosol: 0.035,
      aerosolHeight: 1,
      dustTint: [1, 0.62, 0.4],
      dustBroad: 0.6,
    },
  },
};

/**
 * An invented ring system: a radial profile of bands and gaps, icy, dusty or
 * dark, from as narrow as Uranus's to wider than Saturn's.
 */
function ringSystemFor(spec, seed) {
  let s = seed >>> 0 || 1;
  const random = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9 >>> 0) / 4294967296);
  const tint = [
    [232, 226, 214], [214, 186, 146], [150, 136, 122], [200, 205, 214],
    [180, 200, 226], [206, 160, 128], [120, 110, 104], [226, 214, 190],
  ][Math.floor(random() * 8)];
  const width = 512;
  const data = new Uint8Array(width * 4);
  const f1 = 18 + random() * 40;
  const f2 = 60 + random() * 120;
  const p1 = random() * 6.28;
  const p2 = random() * 6.28;
  const gaps = Array.from({ length: 1 + Math.floor(random() * 4) }, () => [0.15 + random() * 0.75, 0.006 + random() * 0.03]);
  const narrow = random() < 0.25;
  for (let i = 0; i < width; i++) {
    const t = i / (width - 1);
    let density = 0.55 + 0.25 * Math.sin(t * f1 + p1) + 0.15 * Math.sin(t * f2 + p2);
    if (narrow) density *= Math.max(Math.sin(t * f1 * 0.5 + p1), 0) ** 6;
    for (const [at, w] of gaps) density *= 1 - 0.92 * Math.exp(-(((t - at) / w) ** 2));
    density *= Math.min(t / 0.06, 1) * Math.min((1 - t) / 0.1, 1);
    const shade = 0.78 + 0.22 * Math.sin(t * f2 * 0.37 + p2);
    data[i * 4] = tint[0] * shade;
    data[i * 4 + 1] = tint[1] * shade;
    data[i * 4 + 2] = tint[2] * shade;
    data[i * 4 + 3] = Math.max(0, Math.min(1, density)) * 255;
  }
  const texture = new DataTexture(data, width, 1, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  const innerKm = spec.radiusKm * (1.2 + random() * 0.3);
  const outerKm = spec.radiusKm * (narrow ? 1.7 + random() * 0.4 : 2 + random() * 0.9);
  const rings = createRings({
    innerKm,
    outerKm,
    planetRadiusKm: spec.radiusKm,
    texture,
    opticalDepth: narrow ? 0.8 : 1.2 + random() * 1.5,
    albedo: tint[0] > 200 ? 0.6 : 0.3,
  });
  return { ...rings, texture, innerKm, outerKm };
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
