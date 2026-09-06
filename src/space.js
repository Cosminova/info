/**
 * Cosminova: a real-scale, explorable universe.
 *
 * Everything is in kilometres. The camera sits at the origin and the world is
 * translated to it each frame, so float32 vertices stay precise from a crater
 * floor out to the Local Group.
 */
import {
  ACESFilmicToneMapping,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  HalfFloatType,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  Vector4,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { loadSpaceData } from './data.js';
import { createMilkyWay, ECLIPTIC_OBLIQUITY } from './milkyway.js';
import { BODIES, BODY_BY_KEY, SUN } from './engine/bodies-data.js';
import { MOONS, MOON_BY_KEY } from './engine/moons-data.js';
import { Universe } from './engine/universe.js';
import { Planet } from './engine/planet.js';
import { Star } from './engine/star.js';
import { createRings } from './engine/rings.js';
import { physicalFor } from './engine/physical-data.js';
import {
  UMBRA_REFRACTED_LIGHT,
  displayedReflectance,
  illuminatedFraction,
  reflectedFraction,
} from './engine/shadow-glsl.js';
import { BodyTextures } from './engine/textures.js';
import { OrbitApproachControls } from './engine/camera-controls.js';
import { DeepField } from './engine/deep-field.js';
import { ExoSystem, teffToBv } from './engine/exo-system.js';
import { inventGalaxySystems } from './engine/generated.js';
import { BlackHole, BLACK_HOLES } from './engine/black-hole.js';
import { buildColorLookup, colorIndexToLinearRgb } from './color.js';
import { describeStar, spectralTemperature, surfaceBrightness, SOLAR_TEFF } from './engine/stellar.js';
import { createDitherPass } from './dither.js';
import { createAmbient, sceneWeights } from './engine/ambient.js';
import { createDistantBodies } from './engine/distant-bodies.js';
import { createQuality } from './engine/quality.js';
import { CraftField } from './engine/craft-motion.js';
import { createCraftRenderer } from './engine/craft-render.js';
import { CRAFT_KINDS, DATA_TIERS } from './engine/craft-missions.js';
import { formatDistance, PC_KM, SOLAR_RADIUS_KM, equatorialToEcliptic } from './engine/units.js';
import { equatorialToVector } from './astro.js';
import { createExplorerUI } from './ui/explorer-ui.js';
import { createHome } from './ui/home.js';
import { basePixelRatio, capTextureWidth, platform } from './engine/platform.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/*
 * Built before anything else in this file, because its first job is to take
 * itself away again: the start screen ships in the markup so that it is on the
 * screen at first paint, which means the hosts it does not apply to — the iOS
 * and macOS apps, and every capture script — are relying on this to remove it.
 * The sooner that is settled the less of it they see.
 */
const home = createHome();

const MAJOR = new Set([
  'sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn',
  'uranus', 'neptune', 'pluto', 'io', 'europa', 'ganymede', 'callisto', 'titan',
]);

const LANDMARK_GALAXIES = new Set([
  'LMC', 'SMC', 'NGC 224', 'NGC 598', 'NGC 253', 'NGC 5128', 'NGC 5194', 'NGC 5457',
  'NGC 3031', 'NGC 4486',
]);

const state = {
  date: new Date(),
  timeRate: 1,
  playing: true,
  exposure: 1,
  bloom: true,
  showAtmospheres: true,
  showCraft: true,
  showTrajectories: true,
  target: 'moon',
  // The craft whose trajectory and marker are highlighted. Sticky rather than
  // "the target if it happens to be a craft", because seeing where a probe is
  // going means pulling back to the scale of the trajectory, and pulling back
  // usually means targeting the body it is going round.
  craftSelected: null,
  viewFromEarth: false,
  riding: null,
  uniformOverrides: [],
  showBlackHoles: true,
  showDistantMarkers: true,
  showRings: true,
  showNightLights: true,
  showCraftVectors: true,
  terrainShadows: true,
  // Which categories of name are allowed onto the screen. Read by
  // collectLabelItems; written by setView from the Display panel.
  labels: { planets: true, stars: false, galaxies: true, blackHoles: true, craft: true, exo: true },
};

/**
 * The interface, built once the scene and catalogues exist. Declared here so the
 * functions above it can notify the interface of changes they make — the ground
 * view switch, in particular, is reachable from both sides.
 */
let ui = null;

const canvas = $('view');
const renderer = new WebGLRenderer({
  canvas,
  // Off on mobile. Multisampling costs bandwidth in proportion to the frame,
  // which is the one resource a phone has least of, and this scene's edges are
  // mostly limb curves against black that the bloom and dither passes already
  // soften. Losing it buys resolution, which is worth more here.
  antialias: platform.antialias,
  logarithmicDepthBuffer: true,
  powerPreference: 'high-performance',
});
// Resolution is owned by the quality level from here on; resize() applies it.
// Deferred so a machine that cannot hold 60 fps never has to draw a full
// resolution frame to find that out.
const quality = createQuality({ onResolutionChange: () => resize() });
renderer.setPixelRatio(basePixelRatio() * quality.renderScale);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.autoClear = false;
renderer.sortObjects = false;

const scene = new Scene();
const camera = new PerspectiveCamera(52, 1, 0.001, 1e22);

const skyScene = new Scene();
const skyCamera = new PerspectiveCamera(52, 1, 0.05, 4000);

const controls = new OrbitApproachControls(camera, canvas);

const universe = new Universe();
const sun = new Star({ radiusKm: SUN.radiusKm });
scene.add(sun.group);

const planets = new Map();
function moonSpec(spec) {
  if (spec.radiusKm >= 400) return spec;
  return {
    ...spec,
    maxPatches: spec.radiusKm < 25 ? 1400 : 2200,
    maxLevel: 16,
    patchResolution: spec.radiusKm < 40 ? 20 : 24,
    pixelsPerQuad: 4.5,
    craterOctaves: Math.max(spec.craterOctaves ?? 5, spec.radiusKm < 80 ? 7 : spec.craterOctaves ?? 5),
    roughness: Math.max(spec.roughness ?? 0.08, spec.radiusKm < 80 ? 0.16 : spec.roughness ?? 0.08),
  };
}

let textures = null;
let ringSystem = null;

function ensurePlanet(key) {
  if (key === 'sun') return null;
  if (planets.has(key)) return planets.get(key);
  const spec = BODY_BY_KEY.get(key);
  if (!spec || spec.key === 'sun') return null;
  const planet = new Planet(moonSpec(spec));
  planets.set(key, planet);
  scene.add(planet.group);
  // Bodies are built on arrival, long after the options were restored, so each
  // one has to be caught up rather than assuming the defaults still hold.
  if (spec.atmosphere && !state.showAtmospheres && planet.atmosphere) planet.atmosphere.visible = false;
  if (!state.showNightLights) planet.setNightLights(false);
  if (!state.terrainShadows) planet.setTerrainShadows(false);
  if (textures) loadBodyTextures(key);
  return planet;
}

for (const spec of BODIES) ensurePlanet(spec.key);

const data = await loadSpaceData({
  maxTextureSize: renderer.capabilities.maxTextureSize,
});
textures = new BodyTextures(await fetch('textures/bodies.json').then((r) => r.json()), {
  anisotropy: renderer.capabilities.getMaxAnisotropy(),
});

// Full physical colour rather than pulled a sixth of the way to white. The
// dilution is meant to match what a dark-adapted eye reports, but that argument
// applies to a naked-eye sky and this is a telescope: the reds and blues the
// catalogue's colour indices carry are worth seeing, and washing them out was
// most of why the field looked like grey grain.
const colorLookup = buildColorLookup(1024, 1);
const deepField = new DeepField({
  catalog: data.catalog,
  galaxies: data.galaxies,
  colorLookup,
  maxPointSize: platform.maxPointSize,
});
for (const object of deepField.objects) scene.add(object);

const milkyWay = createMilkyWay({
  texture: data.milkyWayTexture,
  longitudeSign: data.milkyWayMeta.longitudeSign ?? -1,
});
const skyGroup = new Group();
skyGroup.rotation.x = -ECLIPTIC_OBLIQUITY;
skyGroup.add(milkyWay.mesh);
skyScene.add(skyGroup);

const extras = new Group();
scene.add(extras);
const earthHorizon = new Mesh(
  new SphereGeometry(1, 48, 24),
  new MeshBasicMaterial({ color: 0x010208 }),
);
earthHorizon.scale.setScalar(6371);
earthHorizon.visible = false;
earthHorizon.frustumCulled = false;
earthHorizon.renderOrder = -2;
scene.add(earthHorizon);
const distantBodies = createDistantBodies();
scene.add(distantBodies.object);

// Spacecraft. The field holds where every craft is at the current date; the
// renderer decides how each one is drawn, from a marker a pixel across to a
// mesh you can fly around. Both live in the same kilometre world as the
// planets, so a craft is picked, labelled and flown to like any other target.
const craftField = await CraftField.load('');
// Anything sitting on a surface has to sit on the terrain that is drawn, and the
// only authority on where that is is the shader: the measured map is one term of
// it, and procedural relief displaces the ground further, by kilometres. So the
// height is read back from the terrain itself, batched once a frame and cached,
// because a landing site does not move and a readback per craft per frame would
// stall the pipeline for nothing. Until a probe has run — the first frame, or a
// body whose terrain is not loaded — the measured map alone is the best answer
// available, which is right to a few hundred metres and wrong by no more than
// the procedural relief it omits.
const groundCache = new Map();
const groundQueue = [];
const groundSite = new Vector3();

function demGroundKm(bodyKey, dir) {
  const km = textures?.elevationKm(bodyKey, dir);
  if (km === null || km === undefined) return null;
  const strength = planets.get(bodyKey)?.material.uniforms.uDemStrength?.value ?? 1;
  return km * strength;
}

craftField.groundKm = (bodyKey, dir) => {
  const key = `${bodyKey}|${dir.x.toFixed(6)},${dir.y.toFixed(6)},${dir.z.toFixed(6)}`;
  const entry = groundCache.get(key);
  if (entry) {
    entry.wanted = true;
    return entry.km;
  }
  const fallback = demGroundKm(bodyKey, dir);
  groundCache.set(key, {
    bodyKey, dir: dir.clone(), km: fallback, distanceKm: 0, demId: 0, wanted: true, probed: false,
  });
  return fallback;
};

/**
 * Refreshes the ground heights the craft field asked for.
 *
 * A height follows the relief the camera is currently being shown — octaves fade
 * in on approach, so the ground rises to meet it — which is why an entry is
 * re-probed once the distance to its body has moved a few per cent rather than
 * being read once and kept.
 */
function probeGround() {
  const byBody = new Map();
  for (const entry of groundCache.values()) {
    const wanted = entry.wanted;
    entry.wanted = false;
    if (!wanted) continue;
    const planet = planets.get(entry.bodyKey);
    const body = universe.get(entry.bodyKey);
    if (!planet || !body || !planet.group.visible) continue;
    // How far the camera is from the site, not from the body: the relief under a
    // lander sharpens over the last kilometre of an approach, and by then the
    // distance to the body's centre has stopped changing to four figures.
    const radiusKm = (body.spec.radiusKm ?? 1) + (entry.km ?? 0);
    groundSite.copy(entry.dir).applyQuaternion(body.orientation)
      .multiplyScalar(radiusKm).add(body.position);
    const distanceKm = Math.max(controls.worldPosition.distanceTo(groundSite), 1e-4);
    // Far enough out that no octave the probe would add is even a pixel across,
    // and the craft itself is a marker. Not worth a stall.
    if (distanceKm > (body.spec.radiusKm ?? 1) * 200 && entry.probed) continue;
    // A finer elevation map arriving moves the ground under a lander by as much
    // as a hundred metres, and it arrives while the camera is sitting still, so
    // distance alone is not enough to know the answer is still good.
    const demId = planet.material.uniforms.uDemMap.value?.id ?? 0;
    if (entry.probed && entry.demId === demId
        && Math.abs(Math.log(distanceKm / entry.distanceKm)) < 0.02) continue;
    entry.distanceKm = distanceKm;
    entry.demId = demId;
    if (!byBody.has(entry.bodyKey)) byBody.set(entry.bodyKey, []);
    byBody.get(entry.bodyKey).push(entry);
  }

  for (const [bodyKey, entries] of byBody) {
    const planet = planets.get(bodyKey);
    groundQueue.length = 0;
    for (const entry of entries) groundQueue.push(entry.dir);
    const heights = planet.groundHeightsKm(renderer, groundQueue);
    const limit = (planet.spec.radiusKm ?? 1) * 0.25;
    for (let i = 0; i < entries.length; i++) {
      const km = heights[i];
      // A float target the driver would not give us, or a NaN out of the noise:
      // keep the measured answer rather than teleporting a lander.
      if (!Number.isFinite(km) || Math.abs(km) > limit) continue;
      entries[i].km = km;
      entries[i].probed = true;
    }
  }
}
const craft = createCraftRenderer(craftField);
scene.add(craft.object);
let craftVisible = [];
universe.update(state.date);
craftField.update(state.date, universe);

let exoSystem = null;
let exoCraftKeys = [];
/**
 * Body lookup for anything that positions itself against a body.
 *
 * A craft orbits whatever it orbits, and that may belong to a procedurally
 * generated system rather than to the Solar System. The motion engine only ever
 * asks `get(key)`, so this is all it takes for the same code to fly a probe
 * around Proxima b as around Jupiter.
 */
const bodyFrames = {
  get: (key) => universe.get(key) ?? exoSystem?.get(key),
};
const starMeshes = new Map();
const blackHoles = new Map();
for (const spec of BLACK_HOLES) {
  const hole = new BlackHole(spec);
  blackHoles.set(`bh:${spec.key}`, hole);
  extras.add(hole.group);
}

async function loadBodyTextures(key) {
  const planet = planets.get(key);
  const maps = await textures.loadFar(key);
  if (key === 'sun') {
    sun.setMap(maps.colour ?? null);
    return;
  }
  if (!planet) return;
  if (maps.colour) planet.setColourMap(maps.colour);
  if (maps.night) planet.setNightMap(maps.night);
  if (maps.ocean) planet.setOceanMap(maps.ocean);
  if (maps.dem) planet.setDemMap(maps.dem, maps.demInfo);
  if (maps.norm) planet.setNormalMap(maps.norm);
    if (maps.rings && planet.spec.rings) {
    ringSystem = createRings({
      innerKm: planet.spec.rings.innerKm,
      outerKm: planet.spec.rings.outerKm,
      planetRadiusKm: planet.radius,
      texture: maps.rings,
    });
    planet.spin.add(ringSystem.mesh);
    ringSystem.mesh.visible = state.showRings;
    planet.setRings(maps.rings, planet.spec.rings.innerKm, planet.spec.rings.outerKm);
  }
}

await Promise.all([
  loadBodyTextures('sun'),
  ...BODIES.map((spec) => loadBodyTextures(spec.key)),
]);

const upgraded = new Set();
function considerUpgrade(key, apparentPixels) {
  if (upgraded.has(key) || apparentPixels < platform.nearUpgradePixels) return;
  upgraded.add(key);
  const kinds = Object.keys(textures.manifest?.[key] ?? {}).filter((k) => k !== 'dem');
  textures.ensureNear(key, kinds).then(() => {
    const planet = planets.get(key);
    const colour = textures.best(key, 'colour');
    if (key === 'sun') {
      if (colour) sun.setMap(colour.texture);
      return;
    }
    if (!planet) return;
    if (colour) planet.setColourMap(colour.texture);
    const night = textures.best(key, 'night');
    if (night) planet.setNightMap(night.texture);
  });
}

const destinations = [];
const destByKey = new Map();

function addDestination(entry) {
  // One entry per key. The map holds exactly one, so a second push under the
  // same key adds a row to the list that nothing can ever resolve to: it is
  // offered by search and appears in the label pass, and selecting it lands on
  // whichever entry the map kept. Callers that have something to contribute to
  // an existing entry — a catalogue system record for a star already listed
  // under its common name — say so explicitly rather than pushing again.
  const existing = destByKey.get(entry.key);
  if (existing) return existing;
  destinations.push(entry);
  destByKey.set(entry.key, entry);
  return entry;
}

/** For destinations that come and go: the craft of a procedural system. */
function removeDestination(key) {
  const index = destinations.findIndex((entry) => entry.key === key);
  if (index >= 0) destinations.splice(index, 1);
  destByKey.delete(key);
}

// Craft keys are namespaced in the destination list the way stars and galaxies
// are, so a probe named after its target cannot collide with the target.
const craftDestKey = (key) => `craft:${key}`;
const craftKeyOf = (key) => (typeof key === 'string' && key.startsWith('craft:') ? key.slice(6) : null);

addDestination({ key: 'sun', name: 'Sun', kind: 'star', group: 'Solar system' });
for (const spec of BODIES) {
  addDestination({
    key: spec.key,
    name: spec.name,
    kind: 'body',
    group: spec.parent === 'sun' || !spec.parent ? 'Solar system' : spec.parent,
  });
}
for (const spec of MOONS) {
  addDestination({
    key: spec.key,
    name: spec.name,
    kind: 'moon',
    group: BODY_BY_KEY.get(spec.parent)?.name ?? spec.parent,
  });
}

// Spacecraft are grouped under whatever they are visiting, so searching for
// "Jupiter" turns up Juno and Galileo alongside the moons, and the ISS files
// itself under Earth.
for (const spec of craftField.specs) {
  addDestination({
    key: craftDestKey(spec.key),
    name: spec.name,
    kind: 'craft',
    group: bodyName(spec.target) ?? 'Spacecraft',
    craft: spec,
    detail: [spec.agency, spec.mission].filter(Boolean).join(' · '),
  });
}

function bodyName(key) {
  if (!key) return null;
  if (key === 'sun') return 'Solar system';
  const solar = BODY_BY_KEY.get(key)?.name ?? MOON_BY_KEY.get(key)?.name;
  if (solar) return solar;
  // Procedural bodies only have names while their system is loaded, which is
  // also the only time anything can be asking about them.
  const loaded = exoSystem?.get(key)?.spec?.name;
  if (loaded) return loaded;
  // Stars, galaxies and black holes are named in the destination list rather
  // than in the body tables, and a host star is exactly what gets asked for
  // when something wants to say what an exoplanet orbits.
  return destByKey.get(key)?.name ?? null;
}

const namedStars = [];
for (const entry of data.starNames) {
  if (!entry.n || !(entry.dist > 0)) continue;
  // Bright enough to have a name worth looking up, or near enough to be a
  // neighbour. There used to be a four-hundred-parsec cut on top of this, and
  // because the magnitude test already holds the list to a hundred and fifty
  // stars, all it excluded was the far end of the naked-eye sky: Deneb,
  // Alnilam, Wezen and Sadr, which are famous precisely because they are
  // luminous enough to be first-magnitude from several hundred parsecs.
  if (entry.mag > 2.4 && entry.dist > 20) continue;
  const i = entry.i;
  const key = `star:${entry.n}`;
  addDestination({
    key,
    name: entry.n,
    kind: 'star',
    group: 'Stars',
    catalogIndex: i,
    distPc: entry.dist,
    spect: entry.spect,
    mag: entry.mag,
    // Visual-band luminosity, which is what the radius is derived from.
    lum: entry.lum,
  });
  namedStars.push(entry);
}

/**
 * The exoplanet catalogue, all of it, planets included.
 *
 * This used to register host stars within twenty-five parsecs and nothing else,
 * which came to two hundred and fifty of the four and a half thousand systems
 * on file and left the planets themselves entirely unnamed. So there was no way
 * to search for an exoplanet: not Kepler-452b or WASP-12b, whose systems were
 * outside the cut, and not TRAPPIST-1e either, whose star was listed while its
 * seven planets were not. Every one of them was in the data the whole time.
 *
 * The distance cut is gone because it was throwing away the famous ones — the
 * Kepler field is hundreds of parsecs out, and a catalogue of exoplanets you
 * cannot look up Kepler-186f in is not much of a catalogue. The planets are
 * registered as destinations in their own right, which is what makes them
 * findable, and their system is loaded on arrival exactly as before.
 *
 * The cost is the size of the destination list, roughly twelve thousand entries
 * where it was two. Search prepares its index once at startup and the per-frame
 * label pass skips this kind on the first test, so neither grows with it.
 */
for (const system of data.exoplanets.systems) {
  const hostKey = `star:${system.host}`;
  // A host already listed under its common name keeps that entry, and gains the
  // system record so its planets can be loaded from it.
  if (destByKey.has(hostKey)) {
    destByKey.get(hostKey).system = system;
  } else {
    addDestination({
      key: hostKey,
      name: system.host,
      kind: 'star',
      group: 'Exoplanets',
      system,
      distPc: system.distPc,
    });
  }
  for (const planet of system.planets ?? []) {
    const key = `exo:${planet.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    // The invented systems inside nearby galaxies claim keys in this same
    // namespace, and a real planet must not quietly displace one.
    if (destByKey.has(key)) continue;
    addDestination({
      key,
      name: planet.name,
      kind: 'exo-planet',
      group: system.host,
      system,
      planetName: planet.name,
      distPc: system.distPc,
    });
  }
}

for (let i = 0; i < data.galaxies.galaxies.length; i++) {
  const g = data.galaxies.galaxies[i];
  if (!LANDMARK_GALAXIES.has(g.id) && !g.name) continue;
  if (!LANDMARK_GALAXIES.has(g.id) && g.d > 20) continue;
  addDestination({
    key: `gal:${g.id}`,
    name: g.name || g.id,
    kind: 'galaxy',
    group: 'Galaxies',
    galaxyIndex: i,
    distMpc: g.d,
  });
}

const invented = inventGalaxySystems(data.galaxies.galaxies, deepField.galaxyWorld);
for (const system of invented) {
  addDestination({
    key: `star:${system.host}`,
    name: system.host,
    kind: 'star',
    group: system.galaxy,
    system,
  });
  for (const planet of system.planets) {
    addDestination({
      key: `exo:${planet.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: planet.name,
      kind: 'exo-planet',
      group: system.host,
      system,
      planetName: planet.name,
    });
  }
}

for (const spec of BLACK_HOLES) {
  addDestination({
    key: `bh:${spec.key}`,
    name: spec.name,
    kind: 'black-hole',
    group: 'Black holes',
    spec,
  });
}

destinations.sort((a, b) => a.name.localeCompare(b.name));

/** The shortcut row in the navigation panel. */
const quickTargets = [SUN, ...BODIES.filter((b) => MAJOR.has(b.key))].map((spec) => ({
  key: spec.key,
  name: spec.name,
}));

/**
 * Size, temperature and colour of a star you can fly to, cached on its
 * destination record because `resolveWorld` runs every frame for the target.
 *
 * A measured radius wins where there is one: the exoplanet catalogue carries
 * the host's radius, and for those stars this does not need to guess. For the
 * named stars there is no radius in the catalogue at all, so it is derived from
 * the luminosity and spectral type — see engine/stellar.js.
 */
function starProfile(dest) {
  if (dest._profile) return dest._profile;
  const teff = dest.system?.teff ?? spectralTemperature(dest.spect) ?? SOLAR_TEFF;
  const measured = dest.system?.radiusSol;
  const derived = describeStar({
    lum: dest.lum,
    spect: dest.spect,
    colorIndex: dest.catalogIndex === undefined ? undefined : data.catalog.colorIndex[dest.catalogIndex],
  });
  const radiusSol = measured || derived.radiusSol;
  dest._profile = {
    teff,
    radiusSol,
    luminositySol: derived.luminositySol,
    measured: Boolean(measured),
    radiusKm: Math.max(radiusSol, 0.02) * SOLAR_RADIUS_KM,
    // The same photometric path the star field uses, so the star you arrive at
    // is the colour of the point you were looking at from a thousand parsecs —
    // but pushed well past its true chromaticity on purpose, and the reason is
    // the tone curve rather than the physics. A 3600 K blackbody is a pale
    // orange whose red channel is the brightest by a long way, and the filmic
    // curve compresses the brightest channel hardest, so the disc converges on
    // cream exactly as it gets big enough to look at. Saturating first is what
    // survives that. Measured, not guessed: see scripts/_star-tune.mjs.
    colour: colorIndexToLinearRgb(teffToBv(teff), 2.2),
    // And kept below the clipping point, for the same reason. A disc sitting
    // over it is tone mapped towards white whatever colour it was given, so a
    // red supergiant has to be allowed to be dimmer than the sun — which is
    // also true of it: surface brightness goes with temperature, and this one
    // is 3600 K against the sun's 5772.
    intensity: 0.95 * surfaceBrightness(teff),
  };
  return dest._profile;
}

function resolveWorld(key) {
  const craftKey = craftKeyOf(key);
  if (craftKey) {
    const state = craftField.get(craftKey);
    if (!state?.present) return null;
    return {
      key,
      name: state.spec.name,
      position: state.position,
      // Half the craft's longest dimension, with a floor so a cubesat is still
      // something the flight code can aim at rather than a zero-radius point.
      radius: Math.max((state.spec.sizeM ?? 5) / 2, 1.5) / 1000,
      kind: 'craft',
      craft: state,
      spec: state.spec,
    };
  }
  const body = universe.get(key);
  if (body) {
    return { key, name: body.spec.name, position: body.position, radius: body.spec.radiusKm, kind: 'body', spec: body.spec };
  }
  if (exoSystem) {
    if (key === exoSystem.key) {
      return { key, name: exoSystem.system.host, position: exoSystem.position, radius: exoSystem.star.radius, kind: 'star', dest: destByKey.get(key) };
    }
    const planet = exoSystem.planets.find((item) => item.spec.key === key);
    if (planet?.world) {
      return { key, name: planet.spec.name, position: planet.world, radius: planet.spec.radiusKm, kind: 'body', spec: planet.spec };
    }
    const moon = exoSystem.moons.find((item) => item.spec.key === key);
    if (moon?.world) {
      return { key, name: moon.spec.name, position: moon.world, radius: moon.spec.radiusKm, kind: 'body', spec: moon.spec };
    }
  }
  const dest = destByKey.get(key);
  if (!dest) return null;
  if (dest.kind === 'galaxy') {
    const g = deepField.galaxyAt(dest.galaxyIndex);
    return {
      key,
      name: dest.name,
      position: new Vector3(g.x, g.y, g.z),
      radius: Math.max(g.radiusKm, 1e12),
      kind: 'galaxy',
      normal: g.normal,
    };
  }
  if (dest.kind === 'star') {
    const profile = starProfile(dest);
    return { key, name: dest.name, position: starWorld(dest), radius: profile.radiusKm, kind: 'star', dest, profile };
  }
  if (dest.kind === 'exo-planet') {
    const item = exoSystem?.planets.find((p) => p.spec.name === dest.planetName);
    if (item?.world) {
      return { key, name: dest.name, position: item.world, radius: item.spec.radiusKm, kind: 'body', spec: item.spec };
    }
    const moon = exoSystem?.moons.find((m) => m.spec.name === dest.planetName);
    if (moon?.world) {
      return { key, name: dest.name, position: moon.world, radius: moon.spec.radiusKm, kind: 'body', spec: moon.spec };
    }
    const pos = starWorld({ system: dest.system });
    return { key, name: dest.name, position: pos, radius: 6371, kind: 'star', dest };
  }
  if (dest.kind === 'black-hole') {
    const hole = blackHoles.get(dest.key);
    return {
      key,
      name: dest.name,
      position: hole.world.clone(),
      radius: hole.rs,
      kind: 'black-hole',
      spec: dest.spec,
    };
  }
  return null;
}

function starWorld(dest) {
  if (dest.system?.world) return dest.system.world.clone();
  if (dest.catalogIndex != null) {
    const i = dest.catalogIndex;
    return new Vector3(deepField.world[i * 3], deepField.world[i * 3 + 1], deepField.world[i * 3 + 2]);
  }
  if (dest.system?.ra != null) {
    const dir = equatorialToVector(dest.system.ra, dest.system.dec);
    equatorialToEcliptic(dir);
    return dir.multiplyScalar(dest.system.distPc * PC_KM);
  }
  if (dest.distPc && dest.ra != null) {
    const dir = equatorialToVector(dest.ra, dest.dec);
    equatorialToEcliptic(dir);
    return dir.multiplyScalar(dest.distPc * PC_KM);
  }
  return new Vector3();
}

function setViewFromEarth(enabled) {
  state.viewFromEarth = enabled;
  // Routed through the controls so the field of view the user chose is restored
  // on the way out, rather than reset to a hardcoded default.
  controls.setGroundView(enabled);
  document.body.classList.toggle('from-earth', enabled);
  earthHorizon.visible = enabled;
  if (enabled) {
    controls.mode = 'orbit';
    controls.cruise = 0;
    controls._flight = null;
    controls.lookYaw = 0;
    controls.lookPitch = 0.06;
    controls.yawVelocity = 0;
    controls.pitchVelocity = 0;
    controls.zoomVelocity = 0;
    if (state.target === 'earth') selectTarget('moon', { fly: false });
  }
  ui?.syncCamera();
}

/**
 * Where to put the camera to look at a spacecraft.
 *
 * Named in the craft's own frame rather than the world's, which is the only way
 * to guarantee a view that shows its shape. A craft's attitude here is nose
 * along track with its panels turned to the Sun, so "approach from the sunward
 * side" — the obvious choice, and the one that guarantees it is lit — means
 * looking straight down its own up axis at every single craft. Anything long and
 * flat then arrives edge on: the station, seen that way, is a twenty-pixel
 * sliver four hundred pixels wide.
 *
 * A fixed three-quarter direction in the craft's frame shows all three axes of
 * whatever it is, and because up is sunward by construction, a direction with a
 * positive up component is lit for free.
 */
const CRAFT_VIEW_LOCAL = new Vector3(0.62, 0.55, -0.56).normalize();

function craftViewLocal(item, out) {
  out.copy(CRAFT_VIEW_LOCAL);
  // On the surface the attitude is local vertical, not flight, so tilt the view
  // down from above rather than looking along the ground.
  if (item.onSurface) out.y += 0.85;
  return out.normalize();
}

/** The same direction in world space, for an approach that has to be flown. */
function craftViewDirection(item, out) {
  return craftViewLocal(item, out).applyQuaternion(item.orientation);
}

/**
 * Ride a spacecraft, or stop riding.
 *
 * The camera stops being a distance from a target and becomes attached to the
 * craft, turning with it. What you look at is then whatever the craft is
 * pointed at, which for most of these is along the direction of flight.
 */
function setRiding(craftKey) {
  const state_ = craftKey ? craftField.get(craftKey) : null;
  if (craftKey && !state_?.present) return false;
  state.riding = craftKey ?? null;
  controls.setRiding(Boolean(craftKey));
  document.body.classList.toggle('riding', Boolean(craftKey));
  if (craftKey) {
    setViewFromEarth(false);
    // Look at whatever the craft is visiting, not at the craft itself.
    const centre = state_.centreKey;
    if (centre && centre !== 'sun') ensurePlanet(centre);
    if (state.target === craftDestKey(craftKey)) {
      selectTarget(centre && centre !== 'sun' ? centre : 'sun', { fly: false });
    }
  }
  ui?.syncCamera();
  return true;
}

function selectTarget(key, { fly = false, duration = 3200 } = {}) {
  if (fly) setViewFromEarth(false);
  // Arriving somewhere new means loading its terrain and textures, and those
  // frames are slow for reasons the quality level cannot fix. Measuring them
  // would drop the resolution of a scene that is about to be fast again.
  quality.settle(2200);
  if (BODY_BY_KEY.has(key) && key !== 'sun') ensurePlanet(key);
  const craftKey = craftKeyOf(key);
  if (craftKey) {
    craft.invalidateTrajectory();
    // Bring in whatever the craft is flying around, so arriving at a Mars
    // orbiter means arriving at Mars rather than at a lit speck in the dark.
    const centre = craftField.get(craftKey)?.centreKey;
    if (centre && centre !== 'sun') ensurePlanet(centre);
    craftField.update(state.date, bodyFrames);
  }
  maybeLoadExo(key);
  if (exoSystem) exoSystem.place(state.date, controls.worldPosition);
  const resolved = resolveWorld(key);
  if (!resolved) return;
  state.target = key;
  if (craftKey) state.craftSelected = craftKey;
  if (state.viewFromEarth && key !== 'earth') {
    controls.lookYaw = 0;
    controls.lookPitch = 0.06;
    controls.setTarget(key, resolved.position, resolved.radius, { keepCamera: true });
    return;
  }
  if (fly) {
    controls.setTarget(key, resolved.position, resolved.radius, { keepCamera: true });
    const parentSpec = resolved.spec?.parent && resolved.spec.parent !== 'sun'
      ? BODY_BY_KEY.get(resolved.spec.parent)
      : null;
    const parentState = parentSpec ? universe.get(resolved.spec.parent) : null;
    const giantMoon = parentSpec && parentSpec.radiusKm > 20000 && resolved.spec.orbitKm;
    const distanceRadii =
      resolved.kind === 'galaxy' ? 2.4
      // A hole's radius is its horizon, and everything worth looking at is
      // outside it: the disk runs to 24 of them and the lensed image of its far
      // side to something like 40. Arriving at 18 puts the camera inside the
      // disk, looking at an orange fog.
      : resolved.kind === 'black-hole' ? 95
      : key === 'sun' || resolved.kind === 'star' ? 12
      : resolved.kind === 'craft' ? 5
      : giantMoon
        ? clamp(resolved.spec.orbitKm / (parentSpec.radiusKm * 0.42), 14, 32)
        : 3.4;
    let arriveFrom = null;
    if (resolved.kind === 'galaxy' && resolved.normal) {
      // Straight down the face of the billboard, with no artistic tilt.
      //
      // A galaxy here is a single flat quad carrying the ellipse it presents to
      // Earth, and its inclination is already baked into how squashed that
      // ellipse is rather than into any 3D orientation. So there is exactly one
      // direction worth arriving from, and an arbitrary approach has even odds
      // of ending up in the plane of the quad looking at a line. Tilting off
      // the normal for a three-quarter view, which is the right instinct for a
      // solid object, re-projects an already-projected image: on an inclined
      // galaxy like Andromeda it closes the thin axis the rest of the way and
      // arrives at a tenth of the disc it should be showing.
      arriveFrom = tmpVector
        .set(resolved.normal.x, resolved.normal.y, resolved.normal.z)
        .normalize();
    } else if (resolved.kind === 'craft') {
      arriveFrom = craftViewDirection(resolved.craft, tmpVector);
    } else if (resolved.kind === 'black-hole') {
      // Just above the plane of the disk. Face-on, the lensing does nothing you
      // can see — it is only from close to the edge that the far side of the
      // disk is lifted over the top of the shadow, and that arc is the whole
      // reason the object looks the way it does.
      arriveFrom = blackHoles.get(resolved.key)?.viewDirection(tmpVector) ?? null;
    } else if (parentState) {
      arriveFrom = tmpVector.subVectors(resolved.position, parentState.position);
      if (arriveFrom.lengthSq() < 1e-12) arriveFrom.set(0, 0.2, 1);
      else arriveFrom.normalize();
    }
    controls.flyTo(key, { distanceRadii, duration, arriveFrom });
  } else {
    controls.setTarget(key, resolved.position, resolved.radius, {
      keepCamera: false,
      distanceRadii: controls.distanceRadii,
    });
  }
}

function maybeLoadExo(key) {
  const dest = destByKey.get(key);
  const system = dest?.system;
  if (!system) return;
  if (exoSystem?.system.host === system.host) return;
  if (exoSystem) {
    // The craft go with the system: there are thousands of systems, and holding
    // every fleet ever visited would grow the roster without bound.
    craftField.drop(exoCraftKeys);
    craft.forget(exoCraftKeys);
    for (const craftKey of exoCraftKeys) removeDestination(craftDestKey(craftKey));
    exoCraftKeys = [];
    exoSystem.dispose();
    exoSystem = null;
  }
  exoSystem = new ExoSystem(system);
  extras.add(exoSystem.star.group);
  for (const item of exoSystem.planets) extras.add(item.planet.group);
  for (const moon of exoSystem.moons) extras.add(moon.planet.group);
  // Bodies have to be somewhere before anything can be put in orbit around them.
  exoSystem.place(state.date, controls.worldPosition);
  const specs = exoSystem.craftSpecs();
  craftField.add(specs);
  craftField.update(state.date, bodyFrames);
  exoCraftKeys = specs.map((spec) => spec.key);
  for (const spec of specs) {
    addDestination({
      key: craftDestKey(spec.key),
      name: spec.name,
      kind: 'craft',
      group: system.host,
      craft: spec,
      detail: [spec.mission, 'generated'].filter(Boolean).join(' · '),
    });
  }
}

/** Cached per key, and the cache holds the Star itself: callers want `.group`. */
function ensureStarMesh(resolved) {
  if (resolved.kind !== 'star' || resolved.key === 'sun') return;
  if (starMeshes.has(resolved.key)) return starMeshes.get(resolved.key);
  if (exoSystem?.key === resolved.key) return exoSystem.star;
  const { colour, intensity } = starProfile(resolved.dest);
  const star = new Star({ radiusKm: resolved.radius, colour, intensity });
  star.group.name = resolved.key;
  extras.add(star.group);
  starMeshes.set(resolved.key, star);
  return star;
}

const ambient = createAmbient();
const armMusic = () => {
  ambient.start();
  window.removeEventListener('pointerdown', armMusic);
  window.removeEventListener('keydown', armMusic);
};
window.addEventListener('pointerdown', armMusic, { once: true });
window.addEventListener('keydown', armMusic, { once: true });

function startTour() {
  setViewFromEarth(false);
  const resolved = resolveWorld(state.target) || resolveWorld('moon');
  if (resolved.kind === 'galaxy') {
    selectTarget('moon', { fly: false });
    controls.distanceRadii = 1.02;
  }
  controls.mode = 'orbit';
  controls.lookYaw = 0;
  controls.lookPitch = 0;
  controls.zoomVelocity = 0;
  controls.cruise = 1.15;
}

function startSaturnRun() {
  setViewFromEarth(false);
  const earth = universe.get('earth');
  if (earth) {
    controls.setTarget('earth', earth.position, earth.spec.radiusKm, { keepCamera: false, distanceRadii: 3.6 });
  }
  selectTarget('saturn', { fly: true, duration: 11000 });
}

function toggleViewFromEarth(enabled) {
  if (!enabled) {
    setViewFromEarth(false);
    const resolved = resolveWorld(state.target);
    if (resolved) {
      const distanceRadii = resolved.kind === 'galaxy' ? 2.4
        : resolved.kind === 'black-hole' ? 18
        : state.target === 'sun' || resolved.kind === 'star' ? 12
        : 3.4;
      controls.flyTo(state.target, { distanceRadii, duration: 2800 });
    }
    return;
  }
  setViewFromEarth(true);
}

/**
 * Everything the inspector needs about a spacecraft: the mission facts from the
 * roster, plus the live numbers that only exist once it has been placed at a
 * date. Kept here rather than in the panel because the distances are between
 * world positions the panel has no access to.
 */
/**
 * Where the position on screen actually came from, for this date.
 *
 * The mission record names the best data that exists for a craft, but one craft
 * can be a fitted cruise, then a Kepler orbit, then a fixed point on the
 * ground, and saying "fitted trajectory" while a rover sits on Mars overstates
 * what is known. So the tier follows how the state was placed this frame, and
 * only falls back to the record when the two agree.
 */
function craftProvenance(item) {
  const spec = item.spec;
  let tier = spec.data;
  // An invented craft is invented however it was placed. Everything else takes
  // its tier from how this frame's position was actually arrived at, since one
  // craft can be a fitted cruise, then a Kepler orbit, then a point on the
  // ground, and only the live source knows which.
  if (item.present && !spec.procedural) {
    if (item.source === 'surface') tier = spec.surfaceData ?? 'estimated';
    else if (item.source === 'elements' || item.source === 'fallback') tier = 'elements';
  }
  const custom = tier === spec.data ? spec.dataNote : null;
  return {
    data: tier,
    dataLabel: DATA_TIERS[tier]?.label ?? tier,
    dataNote: custom ?? DATA_TIERS[tier]?.blurb,
  };
}

function craftRecord(key) {
  const craftKey = craftKeyOf(key);
  if (!craftKey) return null;
  const item = craftField.get(craftKey);
  if (!item) return null;
  const spec = item.spec;
  const earth = universe.get('earth');
  const target = bodyFrames.get(spec.target);
  const t = state.date.getTime();
  // An invented craft eleven parsecs away has a distance from the Sun, and it is
  // 2.9 million AU of nothing. Its own star is the only reference that says
  // anything, so that is the one reported.
  const origin = spec.procedural && exoSystem?.key === `star:${spec.host}` ? exoSystem : null;

  const launched = spec.launched ? new Date(`${spec.launched}T00:00:00Z`) : null;
  const ended = spec.ended ? new Date(`${spec.ended}T00:00:00Z`) : null;
  const durationDays = launched
    ? Math.max(0, ((ended ? ended.getTime() : t) - launched.getTime()) / 86400e3)
    : null;

  const coverage = craftField.coverage(craftKey);
  return {
    key,
    name: spec.name,
    agency: spec.agency,
    mission: spec.mission,
    kind: spec.kind,
    note: spec.note,
    launched: spec.launched,
    ended: spec.ended,
    durationDays,
    stillFlying: !ended && durationDays !== null,
    present: item.present,
    phase: item.phase,
    onSurface: item.onSurface,
    speedKms: item.present ? item.speedKms : null,
    targetKey: spec.target,
    targetName: bodyName(spec.target),
    locationName: bodyName(item.centreKey) ?? 'Interplanetary space',
    distanceFromEarthKm: item.present && earth && !origin
      ? item.position.distanceTo(earth.position)
      : null,
    distanceToTargetKm: item.present && target ? item.position.distanceTo(target.position) : null,
    distanceFromSunKm: item.present && !origin ? item.position.length() : null,
    originName: origin ? spec.host : null,
    distanceFromOriginKm: origin && item.present ? item.position.distanceTo(origin.position) : null,
    ...craftProvenance(item),
    hasPath: craftField.hasPath(craftKey),
    coverage: coverage && {
      from: new Date(J2000_MS + coverage.from * 86400e3),
      to: new Date(J2000_MS + coverage.to * 86400e3),
    },
    riding: state.riding === craftKey,
  };
}

const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/** Everything orbiting `key`, largest first, for the system panel and menus. */
function satellitesOf(key) {
  const carried = BODIES.filter((b) => b.parent === key);
  const moons = MOONS.filter((m) => m.parent === key);
  return [...carried, ...moons].sort((a, b) => b.radiusKm - a.radiusKm);
}

controls.onClick = (x, y) => {
  const hit = pick(x, y);
  if (hit) selectTarget(hit, { fly: true });
};

/**
 * Applies one row of the options table to the scene.
 *
 * Every option the interface offers arrives here, including the ones restored
 * from the saved preferences at startup, so there is exactly one description of
 * what each switch does. A visibility flag is set on the object rather than the
 * object being removed, because most of these are toggled repeatedly and
 * rebuilding a 119,000-point star field to hide it would cost far more than
 * drawing it.
 */
function setView(key, enabled) {
  switch (key) {
    case 'labelPlanets': state.labels.planets = enabled; break;
    case 'labelStars': state.labels.stars = enabled; break;
    case 'labelGalaxies': state.labels.galaxies = enabled; break;
    case 'labelBlackHoles': state.labels.blackHoles = enabled; break;
    case 'labelCraft': state.labels.craft = enabled; break;
    case 'labelExo': state.labels.exo = enabled; break;

    case 'stars':
      deepField.stars.visible = enabled;
      deepField.hostStars.points.visible = enabled;
      break;
    case 'galaxies': deepField.galaxies.mesh.visible = enabled; break;
    case 'milkyWay':
      milkyWay.mesh.visible = enabled;
      deepField.milkyWay.points.visible = enabled;
      break;
    case 'blackHoles':
      state.showBlackHoles = enabled;
      for (const hole of blackHoles.values()) hole.group.visible = enabled;
      break;
    case 'distantMarkers':
      state.showDistantMarkers = enabled;
      distantBodies.object.visible = enabled;
      break;

    case 'atmospheres':
      state.showAtmospheres = enabled;
      for (const planet of planets.values()) if (planet.atmosphere) planet.atmosphere.visible = enabled;
      for (const item of exoSystem?.planets ?? []) {
        if (item.planet.atmosphere) item.planet.atmosphere.visible = enabled;
      }
      break;
    case 'rings':
      state.showRings = enabled;
      if (ringSystem) ringSystem.mesh.visible = enabled;
      break;
    case 'nightLights':
      state.showNightLights = enabled;
      for (const planet of planets.values()) planet.setNightLights(enabled);
      break;
    case 'terrainShadows':
      state.terrainShadows = enabled;
      for (const planet of planets.values()) planet.setTerrainShadows(enabled);
      break;

    case 'craft': state.showCraft = enabled; break;
    case 'trajectories': state.showTrajectories = enabled; break;
    case 'craftVectors': state.showCraftVectors = enabled; break;

    case 'bloom':
      state.bloom = enabled;
      bloomPass.enabled = enabled;
      break;
    case 'dither': dither.pass.enabled = enabled; break;
    case 'music': ambient.setMuted(!enabled); break;
    default: return false;
  }
  return true;
}

ui = createExplorerUI({
  root: $('ui-root'),
  labelRoot: $('label-layer'),
  canvas,
  controls,
  camera,
  state,
  destinations,
  quickTargets,
  resolveWorld,
  hooks: {
    selectTarget: (key, options) => selectTarget(key, options),
    setViewFromEarth: toggleViewFromEarth,
    tour: startTour,
    saturnRun: startSaturnRun,
    setDate(value) {
      state.date = new Date(value);
      universe.update(state.date);
      craftField.update(state.date, bodyFrames);
      craft.invalidateTrajectory();
      trajectoryDate = state.date.getTime();
    },
    setView,
    setQualityPreset(preset) {
      quality.setPreset(preset);
    },
    setTargetFps(fps) {
      quality.setTargetFps(fps);
    },
    setMaxRenderScale(value) {
      quality.setMaxRenderScale(value);
    },
    qualityStats() {
      return {
        fps: smoothedFps,
        renderScale: quality.renderScale,
        quality: quality.level,
        preset: quality.settings.preset,
      };
    },
    craftRecord,
    viewFromCraft(key) {
      const craftKey = craftKeyOf(key) ?? key;
      if (state.riding === craftKey) {
        setRiding(null);
        return false;
      }
      return setRiding(craftKey);
    },
    isRiding: () => state.riding,
    setExposure(value) {
      state.exposure = value;
    },
    pick,
    satellitesOf,
    bodyName,
    galaxyRecord(key) {
      const dest = destByKey.get(key);
      if (dest?.galaxyIndex === undefined) return null;
      return { ...data.galaxies.galaxies[dest.galaxyIndex], radiusKm: deepField.galaxyAt(dest.galaxyIndex)?.radiusKm };
    },
    sunDistanceTo(position) {
      return position.distanceTo(universe.get('sun').position);
    },
    collectLabelItems: collectLabelItems,
  },
});

const composerTarget = new WebGLRenderTarget(1, 1, {
  type: HalfFloatType,
  depthBuffer: true,
  stencilBuffer: true,
});
const composer = new EffectComposer(renderer, composerTarget);
const skyPass = new RenderPass(skyScene, skyCamera);
const mainPass = new RenderPass(scene, camera);
mainPass.clear = false;
mainPass.clearDepth = true;
const bloomPass = new UnrealBloomPass(new Vector2(1, 1), 0.22, 0.28, 0.97);
composer.addPass(skyPass);
composer.addPass(mainPass);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());
const dither = createDitherPass();
composer.addPass(dither.pass);

/**
 * The pixel count the scene is drawn at.
 *
 * Device pixel ratio is capped at 2 and then scaled by the quality level, which
 * is the single largest lever in the renderer: the surface shader is fragment
 * bound, so half the resolution is close to half the frame time. Both the
 * renderer and the composer have to be told, because the composer captured a
 * pixel ratio when it was built and sizes its own targets with it — setting only
 * the renderer's leaves every post-processing target at the old size and saves
 * nothing at all.
 */
function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const ratio = basePixelRatio() * quality.renderScale;
  renderer.setPixelRatio(ratio);
  renderer.setSize(width, height, false);
  composer.setPixelRatio(ratio);
  composer.setSize(width, height);
  bloomPass.resolution.set(width * ratio, height * ratio);
  camera.aspect = width / height;
  skyCamera.aspect = width / height;
  camera.updateProjectionMatrix();
  skyCamera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

const sunColour = new Color(1, 0.97, 0.93);
const tmpCameraLocal = new Vector3();
const tmpSunLocal = new Vector3();
const tmpVector = new Vector3();
const tmpViewDir = new Vector3();
const tmpViewLocal = new Vector3();
const tmpProj = new Vector3();
const tmpOcculter = new Vector4();
const tmpOcculter2 = new Vector4();
const tmpShine = new Vector3();
const tmpOccWorld = new Vector3();
const tmpSunWorld = new Vector3();
const tmpRoamLocal = new Vector3();
let lastFrame = performance.now();
let smoothedFps = 60;
let patchTotal = 0;
let trajectoryBuiltAt = 0;
let trajectoryDate = 0;

/**
 * Writes an override into a uniform without giving away the override's own copy,
 * so the next frame's in-place writes cannot destroy it.
 */
function applyUniformOverride(uniform, value) {
  if (!uniform) return;
  if (uniform.value?.copy && value?.copy) uniform.value.copy(value);
  else uniform.value = value;
}

/**
 * The camera as an exact offset from a body centre, for the body it is anchored
 * to. `key` is null when it is anchored to nothing that helps — mid-flight, or
 * looking at a galaxy.
 *
 * Subtracting two absolute positions loses everything below the spacing of a
 * double at that magnitude: five centimetres at Mars, thirty metres eleven
 * parsecs out. That is the difference between a rover on the ground and a rover
 * under it, so where the camera was built from a known offset to a known object,
 * the offset is carried through instead of the subtraction.
 */
const cameraFrame = { key: null, offset: new Vector3() };

function updateCameraFrame() {
  const origin = controls.originKey;
  const craftKey = craftKeyOf(origin);
  if (craftKey) {
    const item = craftField.get(craftKey);
    if (item?.present && item.centreKey) {
      cameraFrame.key = item.centreKey;
      cameraFrame.offset.copy(item.local).add(controls.originOffset);
      return;
    }
    cameraFrame.key = null;
    return;
  }
  cameraFrame.key = origin && bodyFrames.get(origin) ? origin : null;
  cameraFrame.offset.copy(controls.originOffset);
}

/**
 * Where something at `world` is, relative to the camera, for drawing and picking.
 *
 * `frameKey` names the body it belongs to and `local` its offset from that
 * body's centre, if it has one. Given both, and given that the camera is
 * anchored to the same body, the answer comes from the two small vectors instead
 * of from two large ones, which is the whole difference at interstellar range.
 */
function renderOffset(out, world, frameKey = null, local = null) {
  if (frameKey !== null && frameKey === cameraFrame.key) {
    if (local) return out.copy(local).sub(cameraFrame.offset);
    return out.copy(cameraFrame.offset).negate();
  }
  return out.set(
    world.x - controls.worldPosition.x,
    world.y - controls.worldPosition.y,
    world.z - controls.worldPosition.z,
  );
}

function placeRelative(group, world, key = null) {
  renderOffset(group.position, world, key);
}

/** Starlight reaching an orbit, in Earth-equivalents. */
function exoFlux(luminositySol, au) {
  return (luminositySol || 1) / Math.max(au * au, 1e-9);
}

/**
 * Sunlight for an exoplanet surface, exposed for where the camera actually is.
 *
 * Flux within one system spans orders of magnitude — TRAPPIST-1e takes 0.65
 * Earths, TOI-150.01 at 0.07 AU takes 650 — and multiplying albedo by that
 * literally draws the second one as a featureless white disc, which is exactly
 * what it looked like. Compressing the absolute figure does not help either,
 * because the eye has no absolute reference out here: nothing in frame tells
 * you whether you are seeing a bright planet or an overexposed one.
 *
 * The solar system already answers this by dividing out the flux at the
 * target's own orbit (`exposureScale`), which is why Mercury reads as rock and
 * not as a lamp. This is the same adaptation around other stars. Relative
 * ordering survives — from a given vantage the worlds further in are still
 * brighter — but the level lands where the tone mapper can show detail.
 */
function exoSunIntensity(flux, referenceFlux, exposure) {
  const relative = flux / Math.max(referenceFlux, 1e-9);
  // A knee rather than a clamp above the adapted level, so a world well inside
  // the one you are visiting still looks brighter instead of flattening to the
  // same white as everything else. Continuous at relative = 1.
  const rolled = relative <= 1 ? relative : Math.log2(relative + 1);
  return Math.min(rolled, 2.6) * exposure;
}

/**
 * The orbit the camera's eye is assumed to have adjusted to. The target if it
 * belongs to this system, otherwise whichever world the camera is nearest, so
 * that flying between planets adapts on the way rather than at arrival.
 */
function exoReferenceFlux(system, targetKey, hostLum, cameraWorld) {
  const bodies = [...system.planets, ...system.moons];
  if (!bodies.length) return 1;
  const targeted = bodies.find((item) => item.spec.key === targetKey);
  let chosen = targeted;
  if (!chosen) {
    let best = Infinity;
    for (const item of bodies) {
      if (!item.world) continue;
      const d = cameraWorld.distanceTo(item.world);
      if (d < best) {
        best = d;
        chosen = item;
      }
    }
  }
  if (!chosen) return 1;
  return exoFlux(hostLum, chosen.spec.orbitKm / 149597870.7);
}

/**
 * The body a roaming camera measures itself against: how fast thrust moves it,
 * and the frame its position is held in.
 *
 * Measuring against whatever is nearest is what gives roaming the same feel at
 * every scale — metres per second on an approach, parsecs per second between
 * stars — and it is what lets you arrive somewhere by hand, because closing on
 * a body slows you down automatically.
 *
 * An anchor is also a frame, though, and a planet's frame moves: anchored to
 * Earth you are carried along Earth's orbit at thirty kilometres a second.
 * Near a body that is exactly what you want, since you hover over the place
 * you flew to instead of watching it slide out from under you. Far away it is
 * not, so a body only holds the anchor while you are close enough for its
 * motion to be the motion you share; past that the local star takes it, being
 * the nearest thing to still that this scene has.
 */
function updateRoamFrame() {
  if (controls.mode !== 'roam') return;
  const starKey = exoSystem ? exoSystem.key : 'sun';
  const starPos = exoSystem ? exoSystem.position : universe.get('sun').position;
  let bestKey = null;
  let bestPos = null;
  let bestRadius = 1;
  let bestSurface = Infinity;
  const consider = (key, position, radiusKm) => {
    // Through the camera's own frame rather than by subtracting two absolute
    // positions, for the usual reason: see cameraLocalIn.
    const distance = cameraLocalIn(position, key, tmpRoamLocal).length();
    const surface = Math.max(distance - radiusKm, radiusKm * 1e-4);
    if (surface >= bestSurface) return;
    bestSurface = surface;
    bestKey = key;
    bestPos = position;
    bestRadius = radiusKm;
  };
  for (const [key, planet] of planets) {
    const body = universe.get(key);
    if (body) consider(key, body.position, planet.radius);
  }
  // The sun is not among the loaded planets, and leaving it out meant that the
  // one body you can see from anywhere in the system did nothing to slow you
  // down as you flew at it.
  const sun = universe.get('sun');
  if (sun) consider('sun', sun.position, sun.spec?.radiusKm ?? 696000);
  if (exoSystem) {
    consider(starKey, starPos, exoSystem.star?.radius ?? 1);
    for (const item of exoSystem.planets) {
      if (item.world) consider(item.spec.key, item.world, item.spec.radiusKm);
    }
    for (const moon of exoSystem.moons) {
      if (moon.world) consider(moon.spec.key, moon.world, moon.spec.radiusKm);
    }
  }
  controls.roamReferenceKm = clamp(bestSurface, 0.05, 1e12);
  // Three hundred radii out a body is a couple of degrees wide and its orbital
  // motion is no longer yours to share.
  if (bestKey && bestSurface < bestRadius * 300) controls.setRoamAnchor(bestKey, bestPos);
  else controls.setRoamAnchor(starKey, starPos);
}

/** The camera in a body's own frame, exactly where the camera is anchored to it. */
function cameraLocalIn(world, key, out) {
  if (key !== null && key === cameraFrame.key) return out.copy(cameraFrame.offset);
  return out.copy(controls.worldPosition).sub(world);
}

function pick(clientX, clientY) {
  const width = renderer.domElement.clientWidth;
  const height = renderer.domElement.clientHeight;
  const nx = (clientX / width) * 2 - 1;
  const ny = -(clientY / height) * 2 + 1;
  camera.updateMatrixWorld();
  let best = null;
  let bestScore = 28;

  const consider = (key, world, radius, minPixels = 0, frameKey = null, local = null) => {
    renderOffset(tmpVector, world, frameKey, local);
    tmpProj.copy(tmpVector).applyMatrix4(camera.matrixWorldInverse);
    tmpProj.applyMatrix4(camera.projectionMatrix);
    if (tmpProj.z < -1 || tmpProj.z > 1) return;
    const dist = tmpVector.length();
    const px = Math.max(
      (radius / Math.max(dist, 1)) * (height / (camera.fov * Math.PI / 180)),
      minPixels,
    );
    const screen = Math.hypot(tmpProj.x - nx, tmpProj.y - ny) * (height / 2);
    const score = screen - Math.min(px, 80) * 0.35;
    if (score < bestScore) {
      bestScore = score;
      best = key;
    }
  };

  consider('sun', universe.get('sun').position, SUN.radiusKm);
  for (const [key, planet] of planets) {
    if (!planet.group.visible) continue;
    consider(key, universe.get(key).position, planet.radius, 0, key);
  }
  if (exoSystem) {
    consider(exoSystem.key, exoSystem.position, exoSystem.star.radius);
    for (const item of exoSystem.planets) {
      if (item.world) consider(item.spec.key, item.world, item.spec.radiusKm, 0, item.spec.key);
    }
    for (const moon of exoSystem.moons) {
      if (moon.world) consider(moon.spec.key, moon.world, moon.spec.radiusKm, 0, moon.spec.key);
    }
  }
  for (const dest of destinations) {
    if (dest.kind !== 'star' && dest.kind !== 'galaxy' && dest.kind !== 'black-hole') continue;
    if (dest.kind === 'star' && dest.distPc > 30 && dest.mag > 1.5) continue;
    const resolved = resolveWorld(dest.key);
    if (resolved) consider(dest.key, resolved.position, resolved.radius);
  }
  // Only craft the renderer actually drew this frame, and with a pixel floor,
  // because a marker three pixels across has to be clickable at the size it is
  // drawn rather than at the size the spacecraft really is.
  for (const item of craftVisible) {
    consider(
      craftDestKey(item.state.key),
      item.state.position,
      Math.max(item.state.spec.sizeM ?? 5, 2) / 2000,
      item.apparent > 3.5 ? 0 : 7,
      item.state.centreKey,
      item.state.local,
    );
  }
  return best;
}

/**
 * Candidates for the label layer.
 *
 * Only things actually in the scene are offered: loaded planets and moons, the
 * exoplanet system if one is resident, and the handful of stars, galaxies and
 * black holes bright or close enough to be worth naming. The layer does the
 * ranking and culling; this only has to avoid handing it the whole catalogue,
 * which would mean resolving forty thousand world positions six times a second.
 */
const labelItems = [];
/**
 * Camera-relative vectors for the few label items that need one worked out
 * rather than subtracted. Pooled: this runs every frame.
 */
const labelOffsets = [];
let labelOffsetsUsed = 0;
function labelOffset(world, frameKey, local = null) {
  if (frameKey !== cameraFrame.key) return null;
  const out = labelOffsets[labelOffsetsUsed] ?? (labelOffsets[labelOffsetsUsed] = new Vector3());
  labelOffsetsUsed++;
  return renderOffset(out, world, frameKey, local);
}

/**
 * Keys already given a label this frame.
 *
 * One object can be reachable through two of the passes below. A resident
 * exoplanet system names its host star, and that same host is also an entry in
 * the destination list, so it was named twice at the same position — and both
 * copies were the selection, which is the one case the placement grid lets
 * through regardless of what already occupies the cell. Two identical labels
 * drawn on the same pixel is what the pile-up of names in an invented system
 * was: not many objects crowding, one object repeated.
 */
const labelKeys = new Set();

function pushLabel(item) {
  if (labelKeys.has(item.key)) return;
  labelKeys.add(item.key);
  labelItems.push(item);
}

function collectLabelItems() {
  labelItems.length = 0;
  labelKeys.clear();
  labelOffsetsUsed = 0;
  const shown = state.labels;
  // The selection always gets a name whatever its category is switched off to,
  // because the alternative is clicking something and being told nothing.
  const targetKey = state.target;
  const sunState = universe.get('sun');
  if (sunState && (shown.planets || targetKey === 'sun')) {
    pushLabel({ key: 'sun', name: 'Sun', position: sunState.position, radius: SUN.radiusKm, major: true });
  }
  if (shown.planets || planets.has(targetKey)) {
    for (const [key, planet] of planets) {
      if (!planet.group.visible) continue;
      if (!shown.planets && key !== targetKey) continue;
      const body = universe.get(key);
      if (!body) continue;
      pushLabel({
        key,
        name: body.spec.name,
        position: body.position,
        offset: labelOffset(body.position, key),
        radius: planet.radius,
        major: MAJOR.has(key),
      });
    }
  }
  if (exoSystem && shown.exo) {
    pushLabel({
      key: exoSystem.key,
      name: exoSystem.system.host,
      position: exoSystem.position,
      radius: exoSystem.star.radius,
      major: true,
    });
    for (const item of exoSystem.planets) {
      if (item.world) {
        pushLabel({
          key: item.spec.key,
          name: item.spec.name,
          position: item.world,
          offset: labelOffset(item.world, item.spec.key),
          radius: item.spec.radiusKm,
          major: true,
        });
      }
    }
    for (const moon of exoSystem.moons) {
      if (moon.world) {
        pushLabel({
          key: moon.spec.key,
          name: moon.spec.name,
          position: moon.world,
          offset: labelOffset(moon.world, moon.spec.key),
          radius: moon.spec.radiusKm,
          major: false,
        });
      }
    }
  }
  for (const dest of destinations) {
    const selected = dest.key === targetKey;
    if (dest.kind === 'star') {
      if (!shown.stars && !selected) continue;
      // Naked-eye stars and anything within ten parsecs; the rest are points
      // that a label would only obscure.
      if (!(dest.mag <= 2.2 || dest.distPc <= 10) && !selected) continue;
    } else if (dest.kind === 'galaxy') {
      if (!shown.galaxies && !selected) continue;
    } else if (dest.kind === 'black-hole') {
      if (!shown.blackHoles && !selected) continue;
    } else {
      continue;
    }
    const resolved = resolveWorld(dest.key);
    if (resolved) {
      pushLabel({
        key: dest.key,
        name: dest.name,
        position: resolved.position,
        radius: resolved.radius,
        major: dest.kind === 'galaxy' && LANDMARK_GALAXIES.has(dest.key.slice(4)),
      });
    }
  }
  // Spacecraft, once near enough that the marker means something. The cut is on
  // apparent size rather than distance so it works at both ends of the scale:
  // the station is named from a few thousand kilometres, Voyager from a few
  // hundred, and neither clutters the sky from anywhere else. This is what makes
  // a craft something you come across while flying rather than something you
  // have to already know is there.
  if (state.showCraft && state.labels.craft) {
    for (const item of craftVisible) {
      const key = craftDestKey(item.state.key);
      if (item.apparent < 0.015 && key !== state.target) continue;
      pushLabel({
        key,
        name: item.state.spec.name,
        position: item.state.position,
        offset: labelOffset(item.state.position, item.state.centreKey, item.state.local),
        radius: Math.max(item.state.spec.sizeM ?? 5, 2) / 2000,
        major: key === state.target,
      });
    }
  }
  return labelItems;
}

function frame(now) {
  requestAnimationFrame(frame);
  const interval = now - lastFrame;
  const dt = Math.min(interval / 1000, 0.25);
  lastFrame = now;
  quality.sample(interval);

  if (state.playing) {
    state.date = new Date(state.date.getTime() + dt * 1000 * state.timeRate);
  }
  universe.update(state.date);
  // The procedural bodies move to this date before anything is positioned
  // against them; their render offsets are set again below, once the camera for
  // this frame is known. A craft in low orbit notices a body a frame behind.
  if (exoSystem) exoSystem.place(state.date, controls.worldPosition);
  // Before the target is resolved: a craft being flown to is a moving target
  // and reading last frame's position makes the approach lag by a frame.
  craftField.update(state.date, bodyFrames);
  // Then the ground under anything standing on a surface, from the heights the
  // last frame asked for. One frame behind, which a landing site does not notice.
  probeGround();

  const resolved = resolveWorld(state.target);
  const targetPos = resolved?.position ?? universe.get('earth').position;
  const targetRadius = resolved?.radius ?? 6371;
  if (resolved) controls.targetKey = resolved.key;
  // The controls drop out of ground view on their own when you zoom in or press
  // a movement key, so the app has to notice rather than being told.
  if (state.viewFromEarth && !controls.earthView) {
    state.viewFromEarth = false;
    document.body.classList.remove('from-earth');
    earthHorizon.visible = false;
    controls.setGroundView(false);
  }
  // Riding ends the same way ground view does: the controls drop it when you
  // thrust, so the app has to notice rather than being told.
  if (state.riding && !controls.riding) setRiding(null);
  const rider = state.riding ? craftField.get(state.riding) : null;
  if (state.riding && !rider?.present) setRiding(null);
  const riderSizeKm = rider ? Math.max((rider.spec.sizeM ?? 5) / 1000, 2e-6) : 0;

  // Orbiting a craft happens in the craft's frame, so the three-quarter view it
  // was framed with survives the craft turning, thrusting and being reoriented
  // as its attitude model changes. Anything else orbits in the world frame.
  controls.bodyFrame = resolved?.kind === 'craft' && !state.viewFromEarth
    ? resolved.craft.orientation
    : null;

  updateRoamFrame();

  const earth = universe.get('earth');
  controls.update(
    dt,
    targetPos,
    targetRadius,
    state.viewFromEarth
      ? {
          key: 'earth',
          position: earth.position,
          radius: earth.spec.radiusKm,
          altitude: 2.4,
          sunPosition: universe.get('sun').position,
          night: state.target !== 'sun',
        }
      : null,
    rider
      ? {
          key: craftDestKey(state.riding),
          position: rider.position,
          orientation: rider.orientation,
          sizeKm: riderSizeKm,
        }
      : null,
  );

  const cam = controls.worldPosition;
  updateCameraFrame();
  const range = state.viewFromEarth
    ? 0.02
    : Math.max(controls.altitudeKm, targetRadius * 0.001, 0.0005);
  // From onboard, the nearest thing is the craft's own structure a few metres
  // away, so the near plane has to come off the craft rather than off the
  // distance to a planet that may be an astronomical unit off.
  camera.near = rider
    ? Math.max(riderSizeKm * 0.01, 2e-7)
    : clamp(range * 0.02, 0.0004, 1e8);
  camera.far = 1e22;
  camera.updateProjectionMatrix();

  skyCamera.quaternion.copy(camera.quaternion);
  skyCamera.fov = camera.fov;
  skyCamera.updateProjectionMatrix();

  const targetAu = Math.max(targetPos.distanceTo(universe.get('sun').position) / 149597870.7, 0.05);
  const exposureScale = state.exposure * Math.min(targetAu * targetAu, 400);

  const height = renderer.domElement.height / renderer.getPixelRatio();
  const pixelsPerRadian = height / (camera.fov * (Math.PI / 180));
  const halfV = camera.fov * (Math.PI / 360);
  const coneCos = Math.cos(Math.min(Math.atan(Math.hypot(1, camera.aspect) * Math.tan(halfV)) + 0.05, 1.55));
  camera.getWorldDirection(tmpViewDir);

  const sunState = universe.get('sun');
  placeRelative(sun.group, sunState.position);
  sun.group.quaternion.copy(sunState.orientation);
  const sunDistance = cam.distanceTo(sunState.position);
  tmpCameraLocal.copy(cam).sub(sunState.position).applyQuaternion(tmpQuaternionInverse(sunState.orientation));
  sun.update({ cameraLocal: tmpCameraLocal, time: now / 1000, distanceKm: sunDistance });
  considerUpgrade('sun', (SUN.radiusKm / sunDistance) * pixelsPerRadian * 2);

  const parentKey = (() => {
    const spec = BODY_BY_KEY.get(state.target);
    if (!spec) return null;
    return spec.parent && spec.parent !== 'sun' ? spec.parent : spec.key;
  })();
  if (parentKey) ensurePlanet(parentKey);
  for (const spec of MOONS) {
    const parent = universe.get(spec.parent);
    if (!parent) continue;
    const nearParent = cam.distanceTo(parent.position) < spec.orbitKm * 12 + spec.radiusKm * 200;
    const inSystem = spec.parent === parentKey && spec.radiusKm >= 8;
    if (nearParent || inSystem || spec.key === state.target) ensurePlanet(spec.key);
  }

  if (state.viewFromEarth) {
    placeRelative(earthHorizon, earth.position);
    earthHorizon.scale.setScalar(earth.spec.radiusKm);
    earthHorizon.quaternion.copy(earth.orientation);
  }

  patchTotal = 0;
  distantBodies.begin();
  for (const [key, planet] of planets) {
    const bodyState = universe.get(key);
    placeRelative(planet.group, bodyState.position, key);
    planet.spin.quaternion.copy(bodyState.orientation);

    const distance = cameraLocalIn(bodyState.position, key, tmpCameraLocal).length();
    const apparentPixels = (planet.radius / distance) * pixelsPerRadian * 2;
    const isParent = key === parentKey;
    const hideEarth = state.viewFromEarth && key === 'earth';
    const visible = !hideEarth && (apparentPixels > 0.35 || key === state.target || isParent);
    planet.group.visible = visible;
    if (!visible) {
      if (!hideEarth && apparentPixels > 0.012 && apparentPixels < 3.5 && key !== 'sun') {
        const tint = planet.spec.atmosphere
          ? planet.spec.atmosphere.tint
          : [0.85, 0.82, 0.76];
        distantBodies.add(planet.group.position, tint, apparentPixels, (planet.spec.albedoBoost ?? 1) * 0.4);
      }
      continue;
    }

    const inverse = tmpQuaternionInverse(bodyState.orientation);
    tmpCameraLocal.applyQuaternion(inverse);
    tmpSunLocal.copy(sunState.position).sub(bodyState.position).applyQuaternion(inverse).normalize();
    tmpViewLocal.copy(tmpViewDir).applyQuaternion(inverse).normalize();
    const sunDistanceAu = bodyState.position.distanceTo(sunState.position) / 149597870.7;
    const irradiance = 1 / Math.max(sunDistanceAu * sunDistanceAu, 1e-6);
    const nearbyGiant = planet.radius / distance > 0.04;
    const sunDistKm = bodyState.position.distanceTo(sunState.position);
    const sunAngular = SUN.radiusKm / Math.max(sunDistKm, 1);
    let occluder;
    let shineDir;
    let shine = 0;
    let tideDir;
    const host = planet.spec.parent;
    if (host && host !== 'sun') {
      const hostState = universe.get(host);
      if (hostState) {
        tmpVector.copy(hostState.position).sub(bodyState.position).applyQuaternion(inverse);
        tmpShine.copy(tmpVector).normalize();
        shineDir = tmpShine;
        // The tidal bulge points at the primary, so the vertex shader needs that
        // direction in the body's own frame; and a moon close in to a large
        // planet is lit appreciably by light reflected off it, which is a
        // separate source from the sun and has to stay separate.
        tideDir = tmpShine;
        shine = displayedReflectance(reflectedFraction({
          hostRadiusKm: hostState.spec.radiusKm,
          separationKm: tmpVector.length(),
          hostAlbedo: physicalFor(host)?.albedo ?? 0.4,
          phase: illuminatedFraction(tmpSunLocal, tmpShine),
        }));
      }
    }

    // Which other bodies, if any, are between this one and the sun. Shadows run
    // in both directions — a planet eclipses its moons, and a moon drops its
    // shadow onto the planet, which is the spot you can watch cross Jupiter's
    // cloud tops — so the search covers the primary, the siblings and the
    // satellites rather than just the parent.
    //
    // The two deepest are kept. One is nearly always enough, but a moon can be
    // inside its planet's shadow and another moon's at the same time, and with
    // one slot the second shadow silently disappears.
    let occluder2;
    let umbraLight = 0;
    let bestDepth = -Infinity;
    let secondDepth = -Infinity;
    for (const [otherKey, other] of planets) {
      if (otherKey === key) continue;
      const otherSpec = other.spec;
      const related =
        otherSpec.parent === key ||
        otherSpec.key === host ||
        (host && otherSpec.parent === host);
      if (!related) continue;
      const otherState = universe.get(otherKey);
      if (!otherState) continue;
      tmpOccWorld.copy(otherState.position).sub(bodyState.position);
      const dist = tmpOccWorld.length();
      if (dist <= otherSpec.radiusKm) continue;
      // How far inside the shadow the body sits, as an angle: the occulter's
      // angular radius less its angular distance from the sun. Positive means
      // the sun's centre is covered.
      const occAng = Math.asin(Math.min(otherSpec.radiusKm / dist, 0.999));
      tmpOccWorld.divideScalar(dist);
      tmpSunWorld.copy(sunState.position).sub(bodyState.position).normalize();
      const sepAng = Math.acos(clamp(tmpOccWorld.dot(tmpSunWorld), -1, 1));
      const depth = occAng - sepAng;
      // Anything more than the sun's own angular radius short of contact casts
      // no penumbra here either.
      if (depth < -sunAngular || depth < secondDepth) continue;
      // An occulter with an atmosphere refracts a little reddened sunlight into
      // its own shadow, which is what keeps an eclipsed body visible. An airless
      // one casts a shadow that is simply dark.
      if (otherSpec.atmosphere) umbraLight = UMBRA_REFRACTED_LIGHT;
      tmpVector.copy(otherState.position).sub(bodyState.position).applyQuaternion(inverse);
      if (depth >= bestDepth) {
        // Demote the previous best rather than dropping it.
        if (bestDepth > -Infinity) {
          secondDepth = bestDepth;
          tmpOcculter2.copy(tmpOcculter);
          occluder2 = tmpOcculter2;
        }
        bestDepth = depth;
        tmpOcculter.set(tmpVector.x, tmpVector.y, tmpVector.z, otherSpec.radiusKm);
        occluder = tmpOcculter;
      } else {
        secondDepth = depth;
        tmpOcculter2.set(tmpVector.x, tmpVector.y, tmpVector.z, otherSpec.radiusKm);
        occluder2 = tmpOcculter2;
      }
    }

    patchTotal += planet.update({
      cameraLocal: tmpCameraLocal,
      sunLocal: tmpSunLocal,
      pixelsPerRadian,
      detailScale: quality.terrainDetail,
      patchScale: quality.patchScale,
      microDetail: quality.microDetail,
      sunColour,
      sunIntensity: irradiance * exposureScale,
      viewLocal: nearbyGiant ? null : tmpViewLocal,
      coneCos: nearbyGiant ? -1 : coneCos,
      occluder,
      occluder2,
      umbraLight,
      sunAngular,
      shineDir,
      shine,
      tideDir,
    });

    for (const override of state.uniformOverrides) {
      if (override.key !== key) continue;
      applyUniformOverride(planet.material.uniforms[override.name], override.value);
    }

    if (planet.spec.dem) {
      const wanted = capTextureWidth(planet.desiredDemWidth(), 'dem');
      const level = textures.demLevel(key, wanted);
      if (level) planet.setDemMap(level.texture, level.info);
      const normals = textures.level(key, 'norm', capTextureWidth(wanted * 2, 'norm'));
      if (normals) planet.setNormalMap(normals.texture);
    }

    if (ringSystem && key === 'saturn') {
      const u = ringSystem.material.uniforms;
      u.uSunDir.value.copy(tmpSunLocal);
      u.uCameraLocal.value.copy(tmpCameraLocal);
      u.uSunIntensity.value = irradiance * exposureScale;
      u.uPixelsPerRadian.value = pixelsPerRadian;
      u.uSunAngular.value = sunAngular;
    }

    considerUpgrade(key, apparentPixels);
  }
  distantBodies.end(renderer.getPixelRatio());
  if (!state.showDistantMarkers) distantBodies.object.visible = false;

  // The trajectory is absolute world kilometres and is rebuilt rather than
  // re-centred when the date moves, since the centre body has moved with it.
  // Throttled both ways: a running clock must not mean rebuilding a six
  // thousand point Saturn tour every frame.
  const craftShown = state.riding ?? craftKeyOf(state.target) ?? state.craftSelected;
  if (
    craftShown
    && Math.abs(state.date.getTime() - trajectoryDate) > 6 * 3600e3
    && now - trajectoryBuiltAt > 400
  ) {
    craft.invalidateTrajectory();
    trajectoryBuiltAt = now;
    trajectoryDate = state.date.getTime();
  }
  craftVisible = craft.update({
    universe: bodyFrames,
    cameraWorld: cam,
    camera,
    pixelsPerRadian,
    pixelRatio: renderer.getPixelRatio(),
    selectedKey: craftShown,
    showCraft: state.showCraft,
    showTrajectories: state.showTrajectories,
    showVectors: state.showCraftVectors,
    date: state.date,
    frame: cameraFrame,
  });

  if (exoSystem) {
    exoSystem.place(state.date, cam);
    const hostDist = cam.distanceTo(exoSystem.position);
    tmpCameraLocal.copy(cam).sub(exoSystem.position);
    exoSystem.star.update({ cameraLocal: tmpCameraLocal, time: now / 1000, distanceKm: hostDist });
    exoSystem.star.group.visible = (exoSystem.star.radius / hostDist) * pixelsPerRadian * 2 > 0.4;
    // Exposure adapts to the orbit being visited, exactly as it does at home,
    // so a world taking hundreds of Earths' flux reads as a lit planet rather
    // than a white disc.
    const hostLum = exoSystem.luminositySol ?? 1;
    const exoReference = exoReferenceFlux(exoSystem, state.target, hostLum, cam);
    for (const item of exoSystem.planets) {
      const distance = cameraLocalIn(item.world, item.spec.key, tmpCameraLocal).length();
      const apparentPixels = (item.spec.radiusKm / distance) * pixelsPerRadian * 2;
      item.planet.group.visible = apparentPixels > 0.7;
      if (!item.planet.group.visible) continue;
      // Once, and only for a world close enough to be worth it: the waterline
      // has to be measured against this planet's own relief.
      if (item.spec.oceanFraction > 0 && !item.seaCalibrated && apparentPixels > 12) {
        item.seaCalibrated = true;
        item.planet.calibrateSeaLevel(renderer, item.spec.oceanFraction);
      }
      placeRelative(item.planet.group, item.world, item.spec.key);
      tmpSunLocal.copy(exoSystem.position).sub(item.world).normalize();
      tmpViewLocal.copy(tmpViewDir).normalize();
      const au = item.spec.orbitKm / 149597870.7;
      patchTotal += item.planet.update({
        cameraLocal: tmpCameraLocal,
        sunLocal: tmpSunLocal.copy(tmpSunLocal),
        pixelsPerRadian,
        detailScale: quality.terrainDetail,
        patchScale: quality.patchScale,
        microDetail: quality.microDetail,
        sunColour,
        sunIntensity: exoSunIntensity(exoFlux(hostLum, au), exoReference, state.exposure),
        viewLocal: tmpViewLocal,
        coneCos,
      });
    }
    for (const moon of exoSystem.moons) {
      if (!moon.world) continue;
      const distance = cameraLocalIn(moon.world, moon.spec.key, tmpCameraLocal).length();
      const apparentPixels = (moon.spec.radiusKm / distance) * pixelsPerRadian * 2;
      moon.planet.group.visible = apparentPixels > 0.7;
      if (!moon.planet.group.visible) continue;
      placeRelative(moon.planet.group, moon.world, moon.spec.key);
      tmpSunLocal.copy(exoSystem.position).sub(moon.world).normalize();
      const au = moon.world.distanceTo(exoSystem.position) / 149597870.7;
      patchTotal += moon.planet.update({
        cameraLocal: tmpCameraLocal,
        sunLocal: tmpSunLocal,
        pixelsPerRadian,
        detailScale: quality.terrainDetail,
        patchScale: quality.patchScale,
        microDetail: quality.microDetail,
        sunColour,
        sunIntensity: exoSunIntensity(exoFlux(hostLum, au), exoReference, state.exposure),
        viewLocal: tmpViewDir,
        coneCos,
      });
    }
  }

  /*
   * Only the star being looked at is drawn as a sphere; every other star in
   * the sky is the deep field's business.
   *
   * This has to be reasserted every frame rather than on a change of target.
   * Group positions here are offsets from a floating origin that moves with
   * the camera, so a mesh that simply stops being updated keeps the offset it
   * last had — which means it stops sitting at a fixed point in space and
   * starts following the camera around. Visit Betelgeuse, then fly to Mars,
   * and a 712-solar-radius sphere comes along and hangs in the sky behind it.
   *
   * The meshes are kept rather than disposed: they are cached per star because
   * building one is not free, and hiding is enough.
   */
  for (const [key, mesh] of starMeshes) {
    mesh.group.visible = key === resolved?.key;
  }

  if (resolved?.kind === 'star' && resolved.key !== 'sun') {
    const mesh = ensureStarMesh(resolved);
    if (mesh && exoSystem?.key !== resolved.key) {
      placeRelative(mesh.group, resolved.position);
      tmpCameraLocal.copy(cam).sub(resolved.position);
      mesh.update({ cameraLocal: tmpCameraLocal, time: now / 1000, distanceKm: cam.distanceTo(resolved.position) });
    }
  }

  for (const hole of blackHoles.values()) {
    placeRelative(hole.group, hole.world);
    tmpCameraLocal.copy(cam).sub(hole.world).applyQuaternion(tmpQuaternionInverse(hole.group.quaternion));
    hole.update({ cameraLocal: tmpCameraLocal, time: now / 1000, visible: state.showBlackHoles });
  }

  const viewingGalaxy = resolved?.kind === 'galaxy';
  const fromSun = sunDistance;
  const panoramaFade = 1 / (1 + (fromSun / PC_KM) * 6);
  milkyWay.mesh.visible = panoramaFade > 0.03;
  milkyWay.update({ exposure: 0.55, intensity: 0.5 * panoramaFade, atmosphere: null });

  // A narrower field is a bigger telescope. The same starlight falls across more
  // pixels, so fainter stars lift out of the background the further you zoom —
  // without this, magnifying only pushes the same naked-eye handful apart and
  // the sky empties out. The catalogue reaches magnitude 21, so there is
  // something new arriving the whole way down.
  const magnification = Math.max(58 / Math.max(camera.fov, 1e-4), 1);
  deepField.update({
    cameraWorld: cam,
    pixelRatio: renderer.getPixelRatio(),
    sunDistanceKm: fromSun,
    limitMagnitude: Math.min(7.2 + 2.5 * Math.log10(magnification), 21),
    gain: viewingGalaxy
      ? 0.1
      : 0.05 / (1 + (targetRadius / Math.max(controls.distanceKm, 1)) * 10),
    focusGalaxyIndex: viewingGalaxy ? destByKey.get(state.target)?.galaxyIndex ?? -1 : -1,
  });

  ambient.updateScene(
    sceneWeights({
      viewFromEarth: state.viewFromEarth,
      kind: resolved?.kind ?? 'body',
      key: state.target,
      distanceRadii: controls.distanceRadii,
      fromSunKm: fromSun,
      earthDistanceKm: cam.distanceTo(universe.get('earth').position),
    }),
  );

  renderer.toneMappingExposure = 1;
  dither.advance();
  composer.render();

  smoothedFps = smoothedFps * 0.92 + (1 / Math.max(dt, 1e-4)) * 0.08;

  ui.frame({
    dt,
    resolved,
    fps: smoothedFps,
    patches: patchTotal,
    sunDistanceKm: fromSun,
    width: renderer.domElement.clientWidth,
    height: renderer.domElement.clientHeight,
  });

  if (window.cosminova) window.cosminova.ready = true;
}

const _inverse = { x: 0, y: 0, z: 0, w: 1 };
function tmpQuaternionInverse(q) {
  _inverse.x = -q.x;
  _inverse.y = -q.y;
  _inverse.z = -q.z;
  _inverse.w = q.w;
  return _inverse;
}

window.cosminova = {
  ready: false,
  state,
  controls,
  camera,
  get ui() {
    return ui;
  },
  scene,
  planets,
  renderer,
  universe,
  /** Getter: the resident system is swapped out whenever you visit another one. */
  get exoSystem() {
    return exoSystem;
  },
  setDate(value) {
    state.date = new Date(value);
    universe.update(state.date);
    craftField.update(state.date, bodyFrames);
    craft.invalidateTrajectory();
    trajectoryDate = state.date.getTime();
  },
  // Exposed like the renderer and the controls are, so a check can ask whether
  // the music actually stopped rather than only whether the preference that
  // ought to stop it changed.
  ambient,
  craftField,
  craftRecord,
  craftDetail: (key) => craft.detailFor(craftKeyOf(key) ?? key),
  destinations,
  /** Frames a spacecraft the way lookFromSun frames a body. */
  lookAtCraft(key, distanceRadii = 5, tiltDeg = 0) {
    const craftKey = craftKeyOf(key) ?? key;
    const item = craftField.get(craftKey);
    if (!item) return null;
    setViewFromEarth(false);
    setRiding(null);
    craftField.update(state.date, bodyFrames);
    if (!item.present) return { present: false, phase: item.phase };
    if (item.centreKey && item.centreKey !== 'sun') ensurePlanet(item.centreKey);
    selectTarget(craftDestKey(craftKey), { fly: false });
    // Any approach still in progress would keep driving yaw and pitch and undo
    // the framing a frame later.
    controls.stopFlight();
    // Body-frame angles, so this does not depend on the craft's attitude having
    // settled yet: the frame loop rotates them by whatever it turns out to be.
    const dir = craftViewLocal(item, new Vector3());
    if (tiltDeg) dir.applyAxisAngle(new Vector3(0, 1, 0), (tiltDeg * Math.PI) / 180);
    controls.distanceRadii = distanceRadii;
    controls.pitch = Math.asin(clamp(dir.y, -1, 1));
    controls.yaw = Math.atan2(dir.x, dir.z);
    controls.lookYaw = 0;
    controls.lookPitch = 0;
    controls.yawVelocity = 0;
    controls.pitchVelocity = 0;
    controls.zoomVelocity = 0;
    controls.mode = 'orbit';
    return {
      present: true,
      phase: item.phase,
      centre: item.centreKey,
      speedKms: item.speedKms,
      onSurface: item.onSurface,
    };
  },
  /**
   * Frames an exoplanet with its host star behind the camera, which is the only
   * way to see anything: an arbitrary approach direction has even odds of
   * arriving over the night side, and a rocky planet lit by nothing is black.
   */
  lookAtExo(key, distanceRadii = 2.6, phaseDeg = 35, tiltDeg = 14) {
    if (!exoSystem) return null;
    selectTarget(key, { fly: false });
    controls.stopFlight();
    const item = exoSystem.get(key);
    if (!item) return null;
    const toStar = new Vector3().subVectors(exoSystem.position, item.position).normalize();
    const axis = new Vector3(0, 1, 0);
    const direction = toStar
      .clone()
      .applyAxisAngle(axis, (phaseDeg * Math.PI) / 180)
      .applyAxisAngle(new Vector3().crossVectors(axis, toStar).normalize(), (tiltDeg * Math.PI) / 180)
      .normalize();
    controls.distanceRadii = distanceRadii;
    controls.pitch = Math.asin(clamp(direction.y, -1, 1));
    controls.yaw = Math.atan2(direction.x, direction.z);
    controls.lookYaw = 0;
    controls.lookPitch = 0;
    controls.yawVelocity = 0;
    controls.pitchVelocity = 0;
    controls.zoomVelocity = 0;
    controls.mode = 'orbit';
    return { key, radiusKm: item.spec.radiusKm };
  },
  /** Frames a galaxy on the face of its disc rather than edge-on to it. */
  lookAtGalaxy(key, distanceRadii = 3, tiltDeg = 0) {
    const resolved = resolveWorld(key);
    if (!resolved || resolved.kind !== 'galaxy') return null;
    selectTarget(key, { fly: false });
    controls.stopFlight();
    const n = new Vector3(resolved.normal.x, resolved.normal.y, resolved.normal.z);
    const tilt = new Vector3(0, 1, 0).cross(n);
    if (tilt.lengthSq() < 1e-12) tilt.set(1, 0, 0);
    n.applyAxisAngle(tilt.normalize(), (tiltDeg * Math.PI) / 180).normalize();
    controls.distanceRadii = distanceRadii;
    controls.pitch = Math.asin(clamp(n.y, -1, 1));
    controls.yaw = Math.atan2(n.x, n.z);
    controls.lookYaw = 0;
    controls.lookPitch = 0;
    controls.yawVelocity = 0;
    controls.pitchVelocity = 0;
    controls.zoomVelocity = 0;
    controls.mode = 'orbit';
    return { key, radiusKm: resolved.radius };
  },
  /** Frames a hole the way lookAtCraft frames a spacecraft: near its disk plane. */
  lookAtBlackHole(key, distanceRadii = 95) {
    const hole = blackHoles.get(key.startsWith('bh:') ? key : `bh:${key}`);
    if (!hole) return null;
    selectTarget(key.startsWith('bh:') ? key : `bh:${key}`, { fly: false });
    controls.stopFlight();
    const dir = hole.viewDirection(new Vector3());
    controls.distanceRadii = distanceRadii;
    controls.pitch = Math.asin(clamp(dir.y, -1, 1));
    controls.yaw = Math.atan2(dir.x, dir.z);
    controls.lookYaw = 0;
    controls.lookPitch = 0;
    controls.yawVelocity = 0;
    controls.pitchVelocity = 0;
    controls.zoomVelocity = 0;
    controls.mode = 'orbit';
    return { rsKm: hole.rs, distanceKm: hole.rs * distanceRadii };
  },
  rideCraft(key) {
    if (key === null || key === false) {
      setRiding(null);
      return false;
    }
    return setRiding(craftKeyOf(key) ?? key);
  },
  setRate(rate) {
    state.timeRate = rate;
    state.playing = rate !== 0;
  },
  target(key, distanceRadii = 3.2, { yaw, pitch, lookYaw, lookPitch } = {}) {
    selectTarget(key);
    controls.distanceRadii = distanceRadii;
    if (yaw !== undefined) controls.yaw = yaw;
    if (pitch !== undefined) controls.pitch = pitch;
    controls.lookYaw = lookYaw ?? 0;
    controls.lookPitch = lookPitch ?? 0;
    controls.yawVelocity = 0;
    controls.pitchVelocity = 0;
    controls.zoomVelocity = 0;
  },
  viewFromEarth(enabled) {
    if (enabled === false) {
      setViewFromEarth(false);
      return false;
    }
    setViewFromEarth(true);
    return true;
  },
  /**
   * Stands just above a world at a chosen sun elevation, looking where the
   * light is.
   *
   * Framing a sunrise by orbit angle is guesswork: the phase angle that puts the
   * sun on the horizon depends on how high you are, and the heading that faces
   * it depends on where round the body you ended up. Both are asked for here in
   * the terms that actually matter — how far the sun is above the horizon, and
   * how far off the sun the camera is looking — and worked out from the geometry
   * for whatever world and star are involved. That makes the same call frame the
   * same moment of sunset on Earth, on Titan, or on a planet orbiting another
   * star.
   *
   * @param {string} key body to stand on
   * @param {object} [options]
   * @param {number} [options.sunElevationDeg] sun's height above the horizon; 0
   *   is sunset, negative is twilight
   * @param {number} [options.altitudeKm] height above the reference surface
   * @param {number} [options.azimuthDeg] heading away from the sun's bearing
   * @param {number} [options.viewElevationDeg] where the view sits relative to
   *   the horizon, so the horizon can be placed up or down the frame
   * @param {number} [options.rollDeg] which of the two level-horizon standing
   *   points to use: 0 or 180
   * @param {number} [options.fov]
   */
  standAt(key, options = {}) {
    const {
      sunElevationDeg = 0,
      altitudeKm = 2,
      azimuthDeg = 0,
      viewElevationDeg = 0,
      rollDeg = 0,
      fov,
    } = options;

    setViewFromEarth(false);
    setRiding(null);
    selectTarget(key, { fly: false });
    controls.stopFlight();
    universe.update(state.date);

    // A world in this solar system is placed by the ephemeris and lit by the
    // sun; one in another system is placed by its own model and lit by its own
    // host. Everything after this only needs the three vectors.
    const exo = exoSystem?.get(key);
    let body;
    let star;
    let radiusKm;
    let starKey;
    if (exo) {
      exoSystem.place(state.date, controls.worldPosition);
      body = exo.position ?? exo.world;
      star = exoSystem.position;
      radiusKm = exo.spec.radiusKm;
      starKey = exoSystem.key;
    } else {
      const entry = universe.get(key);
      if (!entry) return null;
      body = entry.position;
      star = universe.get('sun').position;
      radiusKm = resolveWorld(key)?.radiusKm ?? entry.spec?.radiusKm;
      starKey = 'sun';
    }
    if (!radiusKm) return null;

    const toStar = new Vector3().subVectors(star, body).normalize();
    // Turning the sub-stellar point along a great circle towards a reference
    // pole puts the camera exactly this far round from noon, so the sun really
    // does end up at the elevation asked for rather than near it.
    const pole = new Vector3(0, 1, 0);
    if (Math.abs(pole.dot(toStar)) > 0.98) pole.set(1, 0, 0);
    const swing = new Vector3().crossVectors(toStar, pole).normalize();
    const standingPoint = (roll) =>
      toStar
        .clone()
        .applyAxisAngle(swing, ((90 - sunElevationDeg) * Math.PI) / 180)
        .applyAxisAngle(toStar, (roll * Math.PI) / 180)
        .normalize();

    // Every point on this circle sees the sun at the same height, but only the
    // two where the star, the standing point and the reference pole line up put
    // the sun's bearing along the frame's vertical: the controls take their
    // horizon from the orbit yaw, so anywhere else the horizon comes out tilted
    // by however far the view has to turn. Which of the two, and what the ground
    // under it looks like, is left to the caller — the time of day moves the
    // terrain beneath the terminator without disturbing the framing.
    const surface = exo ? exo.planet : planets.get(key);
    const orientation = exo ? null : universe.get(key)?.orientation;
    const heightAt = (dirs) => {
      if (!surface) return dirs.map(() => 0);
      const probes = dirs.map((d) => {
        const p = d.clone();
        if (orientation) p.applyQuaternion(tmpQuaternionInverse(orientation));
        return p;
      });
      const out = surface.groundHeightsKm(renderer, probes);
      return dirs.map((_, i) =>
        Number.isFinite(out[i]) && Math.abs(out[i]) < radiusKm * 0.25 ? out[i] : 0,
      );
    };

    const roll = rollDeg;
    const dir = standingPoint(roll);

    // Reported, not acted on. The height function describes the seabed rather
    // than the surface that gets drawn over it, so on a world whose relief is
    // procedural it is not the number to raise a camera by — but it is still
    // worth knowing when a site turns out to be a summit.
    const seaLevelKm = surface?.material?.uniforms?.uSeaLevelKm?.value ?? 0;
    const groundKm = heightAt([dir])[0];

    controls.targetKey = key;
    controls.distanceRadii = 1 + altitudeKm / radiusKm;
    controls.pitch = Math.asin(clamp(dir.y, -1, 1));
    controls.yaw = Math.atan2(dir.x, dir.z);
    controls.autoCenter = false;
    controls.mode = 'orbit';
    controls.yawVelocity = 0;
    controls.pitchVelocity = 0;
    controls.zoomVelocity = 0;
    if (fov !== undefined) controls.fov = fov;

    // Rebuild the basis the controls will use, so the look offsets can be
    // solved for rather than guessed at. Looking at the body centre from just
    // above it is looking straight down, and both offsets are measured from
    // there.
    const eye = new Vector3()
      .copy(body)
      .addScaledVector(dir, controls.distanceRadii * radiusKm);
    const forward = dir.clone().negate();
    const right = new Vector3(-Math.cos(controls.yaw), 0, Math.sin(controls.yaw));
    right.addScaledVector(forward, -right.dot(forward));
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = new Vector3().crossVectors(forward, right).normalize();

    const toStarLocal = new Vector3().subVectors(star, eye).normalize();
    const bearing = toStarLocal.clone().addScaledVector(dir, -toStarLocal.dot(dir));
    if (bearing.lengthSq() < 1e-8) bearing.copy(right);
    bearing.normalize().applyAxisAngle(dir, (azimuthDeg * Math.PI) / 180);
    const elev = (viewElevationDeg * Math.PI) / 180;
    const want = bearing.multiplyScalar(Math.cos(elev)).addScaledVector(dir, Math.sin(elev));

    // The controls yaw about their up axis and then pitch about the yawed right
    // axis, so in the basis above the wanted direction is
    // (sin y cos p, -sin p, cos y cos p) and both angles read straight off.
    controls.lookYaw = Math.atan2(want.dot(right), want.dot(forward));
    controls.lookPitch = Math.asin(clamp(-want.dot(up), -1, 1));

    return {
      altitudeKm,
      groundKm,
      seaLevelKm,
      rollDeg: roll,
      sunElevationDeg,
      radiusKm,
      star: starKey,
      lookYaw: controls.lookYaw,
      lookPitch: controls.lookPitch,
    };
  },
  lookFromSun(key, distanceRadii = 3, phaseDeg = 40, tiltDeg = 18) {
    setViewFromEarth(false);
    while (state.uniformOverrides.length) {
      const { key: body, name, previous } = state.uniformOverrides.pop();
      applyUniformOverride(planets.get(body)?.material.uniforms[name], previous);
    }
    selectTarget(key);
    universe.update(state.date);
    const body = universe.get(key).position;
    const toSun = new Vector3().subVectors(universe.get('sun').position, body).normalize();
    const axis = new Vector3(0, 1, 0);
    const direction = toSun
      .clone()
      .applyAxisAngle(axis, (phaseDeg * Math.PI) / 180)
      .applyAxisAngle(new Vector3().crossVectors(axis, toSun).normalize(), (tiltDeg * Math.PI) / 180)
      .normalize();

    controls.targetKey = key;
    controls.distanceRadii = distanceRadii;
    controls.pitch = Math.asin(clamp(direction.y, -1, 1));
    controls.yaw = Math.atan2(direction.x, direction.z);
    controls.lookYaw = 0;
    controls.lookPitch = 0;
    controls.yawVelocity = 0;
    controls.pitchVelocity = 0;
    return { yaw: controls.yaw, pitch: controls.pitch };
  },
  async loadDetail(key) {
    upgraded.add(key);
    await textures.ensureNear(key);
    const planet = planets.get(key);
    const colour = textures.best(key, 'colour');
    if (key === 'sun') {
      if (colour) sun.setMap(colour.texture);
    } else if (planet) {
      if (colour) planet.setColourMap(colour.texture);
      const dem = textures.best(key, 'dem');
      if (dem) planet.setDemMap(dem.texture, dem.info);
      const night = textures.best(key, 'night');
      if (night) planet.setNightMap(night.texture);
    }
    return true;
  },
  setExposure(value) {
    state.exposure = value;
  },
  setBloom(enabled) {
    state.bloom = enabled;
    bloomPass.enabled = enabled;
  },
  /** Screenshot scripts hide the interface rather than crop around it. */
  setUiVisible(visible) {
    ui.setImmersive(!visible, true);
    return true;
  },
  /**
   * Toggle one layer, by the same keys the Display panel uses.
   *
   * Here so a test can isolate what it is measuring. Asking how large a galaxy
   * renders is unanswerable against a full star field: stars are scattered over
   * the whole frame and above any threshold that would catch the disc, so the
   * bounding box of everything lit is always the entire viewport.
   */
  setView,
  /**
   * The size, colour and brightness derived for a star, or null if the key is
   * not one.
   *
   * A star's disc can come out the wrong colour either because the colour was
   * derived wrongly or because something downstream washed it out, and on
   * screen those look the same. This reports what the shader was handed, so the
   * two can be told apart.
   */
  starProfileFor(key) {
    const resolved = resolveWorld(key);
    if (resolved?.kind !== 'star') return null;
    const profile = resolved.profile ?? starProfile(resolved.dest);
    return {
      teff: profile.teff,
      radiusSol: profile.radiusSol,
      colour: [...profile.colour],
      intensity: profile.intensity,
    };
  },
  /**
   * Current value of a surface uniform, or null if the body does not have one.
   *
   * The distinction matters when a terrain term appears to do nothing: a uniform
   * that is zero, a uniform being swamped by another term, and a uniform whose
   * name never existed on the material all look the same on screen.
   */
  probeUniform(key, name) {
    const uniform = planets.get(key)?.material.uniforms[name];
    if (!uniform) return null;
    return uniform.value;
  },
  setUniform(key, name, value) {
    const uniform = planets.get(key)?.material.uniforms[name];
    if (!uniform) return false;
    // Vector and colour uniforms are written in place by the frame loop, which
    // holds no reference to this override and cannot know to leave it alone. An
    // override that handed over its own object would therefore be quietly
    // overwritten a frame later — the sun direction rewritten, an occulter's
    // radius zeroed — and appear to have had no effect at all. So the override
    // keeps a private copy and the loop below writes that copy back in.
    const snapshot = value?.clone?.() ?? value;
    state.uniformOverrides.push({
      key,
      name,
      value: snapshot,
      previous: uniform.value?.clone?.() ?? uniform.value,
    });
    applyUniformOverride(uniform, snapshot);
    return true;
  },
  setPass(name, enabled) {
    const pass = { sky: skyPass, bloom: bloomPass, dither: dither.pass }[name];
    if (!pass) return false;
    pass.enabled = enabled;
    return true;
  },
  quality,
  setQuality(preset) {
    quality.setPreset(preset);
    ui?.syncDisplay?.();
    return quality.settings.preset;
  },
  pick,
  stats() {
    return {
      target: state.target,
      altitudeKm: controls.altitudeKm,
      distanceRadii: controls.distanceRadii,
      patches: patchTotal,
      craterOctaves: planets.get(state.target)?.material.uniforms.uCraterOctaves.value ?? 0,
      demWidth: planets.get(state.target)?.demWidth ?? 0,
      hasDem: planets.get(state.target)?.material.uniforms.uHasDem.value ?? 0,
      hasNormal: planets.get(state.target)?.material.uniforms.uHasNormal.value ?? 0,
      reliefKm: planets.get(state.target)?.material.uniforms.uDemMap.value?.userData?.reliefKm ?? null,
      fps: smoothedFps,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      quality: quality.level,
      renderScale: quality.renderScale,
      preset: quality.settings.preset,
      // The device profile is reported because it is otherwise invisible: it
      // decides shader loop bounds and buffer sizes before the first frame, so
      // by the time anything is measurable the evidence of it is gone.
      deviceClass: platform.deviceClass,
      shell: platform.shell,
      targetFps: quality.settings.targetFps,
      maxRenderScale: quality.settings.maxRenderScale,
    };
  },
};

selectTarget(state.target);
ui.applyViewPrefs();
resize();
ui.syncCamera();
// Faded rather than removed, so the first frame is not a hard cut from the
// loading cover to the scene.
$('loading').classList.add('is-done');
setTimeout(() => {
  $('loading').hidden = true;
  // There is somewhere to go now, so the start screen can offer to take them.
  home.ready();
  /*
   * Only after the cover has gone, and only on a first visit — and on the web,
   * not until the start screen has been dismissed. Raising the card behind it
   * meant a first-time visitor tapped to start and arrived to find a dialog
   * already open over the view they had just asked to see. Without a start
   * screen this resolves immediately and the timing is what it always was.
   */
  home.whenStarted.then(() => ui.showIntroIfNew?.());
}, 400);
requestAnimationFrame(frame);
