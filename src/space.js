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
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SphereGeometry,
  HalfFloatType,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  Vector4,
  ShaderMaterial,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

import { loadSpaceData } from './data.js';
import { createMilkyWay, ECLIPTIC_OBLIQUITY } from './milkyway.js';
import { BODIES, BODY_BY_KEY, SUN } from './engine/bodies-data.js';
import { MOONS, MOON_BY_KEY } from './engine/moons-data.js';
import { Universe } from './engine/universe.js';
import { Planet } from './engine/planet.js';
import { Star, pointVisibility } from './engine/star.js';
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
import { ExoSystem, exoKey, teffToBv } from './engine/exo-system.js';
import { inventBlackHoleSystems, inventGalaxySystems } from './engine/generated.js';
import { BlackHole, BLACK_HOLES, BLACK_HOLE_LAYER } from './engine/black-hole.js';
import {
  createDeepObjects, CLUSTER_LABELS, NEBULA_LABELS, NEUTRON_LABELS, NEUTRON_STARS,
  NEUTRON_STAR_RADIUS_KM,
} from './engine/deep-objects.js';
import { SkyTint } from './engine/sky-tint.js';
import { createOrbitLines } from './engine/orbit-lines.js';
import { buildColorLookup, colorIndexToLinearRgb } from './color.js';
import { describeStar, spectralTemperature, starLook, starTint, surfaceBrightness, SOLAR_TEFF } from './engine/stellar.js';
import { hashName } from './engine/classify.js';
import { createDitherPass } from './dither.js';
import { createAmbient, sceneWeights } from './engine/ambient.js';
import { createDistantBodies } from './engine/distant-bodies.js';
import { createQuality } from './engine/quality.js';
import { CraftField } from './engine/craft-motion.js';
import { createCraftRenderer } from './engine/craft-render.js';
import { CRAFT_KINDS, DATA_TIERS } from './engine/craft-missions.js';
import {
  AU_KM, EARTH_RADIUS_KM, formatDistance, MPC_KM, PC_KM, SOLAR_RADIUS_KM, equatorialToEcliptic,
} from './engine/units.js';
import { equatorialToVector, vectorToEquatorial } from './astro.js';
import { Cosmos } from './engine/cosmos.js';
import { GaiaField, loadGaiaCatalog } from './engine/gaia-field.js';
import { Ship } from './engine/ship.js';
import { inventForCatalogStar, inventStarSystem } from './engine/procgen.js';
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
  showOrbits: false,
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
// three checks a target is readable before every async read by asking the
// context, and in Chrome each of those questions is a synchronous round trip
// to the GPU process. The answer cannot change, so it is asked once.
for (const name of ['textureFormatReadable', 'textureTypeReadable']) {
  const ask = renderer.capabilities[name].bind(renderer.capabilities);
  const known = new Map();
  renderer.capabilities[name] = (value) => {
    if (!known.has(value)) known.set(value, ask(value));
    return known.get(value);
  };
}
// three asks for the context back when the GPU drops it (memory pressure, a
// driver reset, a Mac waking from sleep) and rebuilds everything from the
// data it still holds. If the GPU never hands it back, the canvas stays black
// and dead, so start again rather than leave a frozen frame.
let contextLost = false;
canvas.addEventListener('webglcontextlost', () => {
  contextLost = true;
  setTimeout(() => {
    if (contextLost) location.reload();
  }, 5000);
});
canvas.addEventListener('webglcontextrestored', () => {
  contextLost = false;
});

const scene = new Scene();
const camera = new PerspectiveCamera(52, 1, 0.001, 1e24);

const skyScene = new Scene();
const skyCamera = new PerspectiveCamera(52, 1, 0.05, 4000);

const controls = new OrbitApproachControls(camera, canvas);
const ship = new Ship({ touch: platform.touch });
scene.add(ship.group);

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
// most of why the field looked like grey grain. Past physical, even, as
// SpaceEngine does: a point a few pixels wide goes through the tone curve at
// its core and comes out near white, and only a stronger tint survives into
// the halo where the eye reads colour, so M stars read orange and B stars blue
// instead of all of them cream.
const colorLookup = buildColorLookup(1024, 1.6);
const deepField = new DeepField({
  catalog: data.catalog,
  galaxies: data.galaxies,
  colorLookup,
  maxPointSize: platform.maxPointSize,
});

// Past the catalogues: stars generated inside every galaxy, galaxies generated
// past the edge of the survey, both in cells that load around the camera and
// unload behind it. See engine/cosmos.js.
const cosmos = new Cosmos({ deepField, colorLookup });
{
  const gl = renderer.getContext();
  cosmos.sprites.setMaxPointSize(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)?.[1] ?? 0);
}
for (const object of cosmos.underlay) scene.add(object);
for (const object of deepField.objects) scene.add(object);
for (const object of cosmos.objects) scene.add(object);
// The Gaia stars arrive after the first frames; see the end of this file.
let gaia = null;

const milkyWay = createMilkyWay({
  texture: data.milkyWayTexture,
  longitudeSign: data.milkyWayMeta.longitudeSign ?? -1,
});
const skyGroup = new Group();
skyGroup.rotation.x = -ECLIPTIC_OBLIQUITY;
skyGroup.add(milkyWay.mesh);
skyScene.add(skyGroup);
const skyTint = new SkyTint();
skyScene.add(skyTint.mesh);

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
const orbitLines = createOrbitLines();
scene.add(orbitLines.group);
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
const galaxyIndexByName = new Map();
data.galaxies.galaxies.forEach((g, i) => {
  galaxyIndexByName.set(g.id, i);
  if (g.name) galaxyIndexByName.set(g.name, i);
});
for (const spec of BLACK_HOLES) {
  const hole = new BlackHole(spec);
  // At the very centre of its galaxy as the galaxy is drawn, so flying to
  // one arrives at the other.
  const host = spec.host != null ? deepField.galaxyAt(galaxyIndexByName.get(spec.host)) : null;
  if (host) {
    hole.world.set(host.x, host.y, host.z);
    spec.world = hole.world.clone();
  }
  blackHoles.set(`bh:${spec.key}`, hole);
  extras.add(hole.group);
}
const deepObjects = createDeepObjects(data.deepSky);

/**
 * The sky's own glow from where the camera is: inside a nebula or a cluster,
 * or deep in a galaxy's bulge, where the unresolved light of its stars is a
 * golden haze over everything.
 */
const coreDir = new Vector3();
function skyLookFrom(cam) {
  let look = deepObjects.skyLook(cam);
  for (const galaxy of [cosmos.milkyWay, cosmos.active]) {
    if (!galaxy?.center) continue;
    const core = galaxy.radiusKm * 0.12;
    const d = cam.distanceTo(galaxy.center);
    if (d > core) continue;
    const strength = 0.06 * (1 - d / core) ** 1.6;
    if (look && look.strength >= strength) continue;
    look = {
      strength,
      colours: [[1.0, 0.72, 0.4], [0.9, 0.5, 0.28], [1.0, 0.9, 0.7]],
      centre: d > 1 ? coreDir.subVectors(galaxy.center, cam).normalize().clone() : new Vector3(0, 0, 1),
      seed: ((galaxy.seed ?? 7) % 1000) / 37,
    };
  }
  return look;
}
extras.add(deepObjects.group);

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
// Only what is applied below; anything else fetched at this tier sat on the
// GPU unused (Earth's 8192 cloud map, for one).
const NEAR_KINDS = ['colour', 'night'];
function considerUpgrade(key, apparentPixels) {
  if (upgraded.has(key) || apparentPixels < platform.nearUpgradePixels) return;
  upgraded.add(key);
  const kinds = NEAR_KINDS.filter((k) => textures.entry(key, k, 'near'));
  textures.ensureNear(key, kinds).then(() => {
    // Left behind while the download was still running.
    if (!upgraded.has(key)) {
      textures.releaseNear(key);
      return;
    }
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

/**
 * The other half of considerUpgrade: once a body is small on screen again and
 * is not what you are looking at, its large maps go back to the small ones and
 * are freed. Only the place you are has its full detail loaded, the way only
 * the chunks around a player are. The gap between the two thresholds stops a
 * body at the boundary from loading and freeing over and over.
 */
function considerRelease(key, apparentPixels) {
  if (key === state.target || apparentPixels > platform.nearUpgradePixels * 0.3) return;
  if (upgraded.has(key)) {
    upgraded.delete(key);
    const colour = textures.far(key, 'colour');
    const night = textures.far(key, 'night');
    if (key === 'sun') {
      if (colour) sun.setMap(colour);
    } else {
      const planet = planets.get(key);
      if (planet && colour) planet.setColourMap(colour);
      if (planet && night) planet.setNightMap(night);
    }
    textures.releaseNear(key);
  }
  const planet = planets.get(key);
  if (planet?.spec.dem && apparentPixels < 40) {
    const dem = textures.demLevel(key, 256);
    if (dem) planet.setDemMap(dem.texture, dem.info);
    const normals = textures.level(key, 'norm', 512);
    if (normals) planet.setNormalMap(normals.texture);
  }
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
    const key = exoKey(planet.name);
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

/*
 * The stars of a double, told about each other.
 *
 * The archive keys a planet to the star it actually orbits, which is the right
 * answer to a different question: a binary where both components carry planets
 * arrives here as two systems with nothing to say they are the same place. Five
 * of them are — Gl 725, TOI-2267, HD 41004, HD 133131, WASP-94 — and each was
 * listed as two unrelated stars filed under "Exoplanets", one of them often
 * some tens of astronomical units from the other.
 *
 * Only where both components are present. The other hundred-odd lettered hosts
 * have a companion the archive names and knows nothing else about, and a row in
 * a system panel for a star with no position and no planets would be a claim
 * this atlas cannot make good on. The count in `starCount` says how many are up
 * there either way.
 */
const components = new Map();
for (const dest of destinations) {
  if (dest.kind !== 'star' || !dest.system?.host) continue;
  const stem = /^(.*?)[ -]([A-C])$/.exec(dest.system.host)?.[1];
  if (!stem) continue;
  if (!components.has(stem)) components.set(stem, []);
  components.get(stem).push(dest);
}
for (const [stem, stars] of components) {
  if (stars.length < 2) continue;
  for (const star of stars) {
    // Filed under the pair rather than under the catalogue at large, which is
    // the same rule the invented stars follow: a star belongs to its system.
    star.group = stem;
    star.companions = stars.filter((other) => other !== star).map((other) => other.key);
  }
}

for (let i = 0; i < data.galaxies.galaxies.length; i++) {
  const g = data.galaxies.galaxies[i];
  if (destByKey.has(`gal:${g.id}`)) continue;
  // Every galaxy can be searched for and flown to; only the famous and the
  // near are named on the sky without being asked, since sixteen thousand
  // labels would be the whole screen.
  const famous = LANDMARK_GALAXIES.has(g.id) || g.note || (g.name && g.d <= 20);
  addDestination({
    key: `gal:${g.id}`,
    name: g.name || g.id,
    kind: 'galaxy',
    group: 'Galaxies',
    galaxyIndex: i,
    distMpc: g.d,
    quiet: !famous,
  });
}

/**
 * One invented system in the destination list: the host star, then its planets.
 *
 * The galaxies and the black holes both get systems out of engine/generated.js
 * and they are registered identically — the only difference is what the star
 * belongs to, which is the galaxy it is in or the hole it orbits. `group` is
 * what the search list and the catalogue file it under, so a star that hosts
 * planets is filed under the thing it is part of rather than under itself.
 */
function registerInventedSystem(system, hostGroup) {
  addDestination({
    key: `star:${system.host}`,
    name: system.host,
    kind: 'star',
    group: hostGroup,
    system,
  });
  for (const planet of system.planets) {
    addDestination({
      key: exoKey(planet.name),
      name: planet.name,
      kind: 'exo-planet',
      group: system.host,
      system,
      planetName: planet.name,
    });
  }
}

for (const system of inventGalaxySystems(data.galaxies.galaxies, deepField.galaxyWorld)) {
  registerInventedSystem(system, system.galaxy);
}

for (const spec of BLACK_HOLES) {
  addDestination({
    key: `bh:${spec.key}`,
    name: spec.name,
    kind: 'black-hole',
    group: 'Black holes',
    spec,
    distPc: spec.distPc,
  });
}
// Every nebula and cluster in the catalogues, the hand-made ones named on the
// sky and the rest once you are among them.
for (const [key, { spec }] of deepObjects.nebulae) {
  addDestination({
    key, name: spec.name, kind: 'nebula', group: 'Nebulae', spec,
    subtype: spec.type, detail: spec.label ?? NEBULA_LABELS[spec.type], distPc: spec.distPc,
    quiet: !spec.curated,
  });
}
for (const [key, { spec }] of deepObjects.clusters) {
  addDestination({
    key, name: spec.name, kind: 'cluster', group: 'Star clusters', spec,
    subtype: spec.type, detail: CLUSTER_LABELS[spec.type], distPc: spec.distPc,
    quiet: !spec.curated,
  });
}
for (const spec of NEUTRON_STARS) {
  addDestination({
    key: `ns:${spec.key}`, name: spec.name, kind: 'neutron-star', group: 'Neutron stars', spec,
    subtype: spec.type, detail: NEUTRON_LABELS[spec.type], distPc: spec.distPc,
  });
}

/*
 * And what orbits them, which until now was nothing at all.
 *
 * Registered after the holes so a hole is in the destination list before the
 * stars that name it as theirs, and grouped under the hole's own name: the
 * search list and the catalogue then file these stars under Sagittarius A*
 * rather than in with the catalogue stars, and satellitesOf can hand the
 * hole's system panel its own contents. See inventBlackHoleSystems.
 */
const holeSystems = inventBlackHoleSystems([...blackHoles.values()]);
for (const system of holeSystems) {
  registerInventedSystem(system, system.holeName);
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
    colour: starTint(teff),
    // And kept below the clipping point, for the same reason. A disc sitting
    // over it is tone mapped towards white whatever colour it was given, so a
    // red supergiant has to be allowed to be dimmer than the sun — which is
    // also true of it: surface brightness goes with temperature, and this one
    // is 3600 K against the sun's 5772.
    intensity: 0.95 * surfaceBrightness(teff),
    look: starLook(teff, radiusSol, hashName(dest.key ?? dest.name ?? '')),
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
      return { key, name: planet.spec.name, position: planet.world, radius: planet.spec.radiusKm, kind: 'body', spec: planet.spec, generated: Boolean(exoSystem.system.generated) };
    }
    const moon = exoSystem.moons.find((item) => item.spec.key === key);
    if (moon?.world) {
      return { key, name: moon.spec.name, position: moon.world, radius: moon.spec.radiusKm, kind: 'body', spec: moon.spec, generated: true };
    }
  }
  const dest = destByKey.get(key);
  if (!dest) return null;
  if (dest.kind === 'galaxy' && dest.cosmic) {
    const g = dest.cosmic;
    return { key, name: dest.name, position: g.center.clone(), radius: g.radiusKm, kind: 'galaxy', normal: g.n };
  }
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
      return { key, name: dest.name, position: item.world, radius: item.spec.radiusKm, kind: 'body', spec: item.spec, generated: Boolean(dest.system?.generated) };
    }
    const moon = exoSystem?.moons.find((m) => m.spec.name === dest.planetName);
    if (moon?.world) {
      return { key, name: dest.name, position: moon.world, radius: moon.spec.radiusKm, kind: 'body', spec: moon.spec, generated: true };
    }
    const pos = starWorld({ system: dest.system });
    return { key, name: dest.name, position: pos, radius: 6371, kind: 'star', dest };
  }
  if (dest.kind === 'black-hole') {
    const hole = blackHoles.get(dest.key);
    // A generated hole is only built while you are near it; from further off
    // it is still somewhere to go.
    if (!hole) {
      return { key, name: dest.name, position: dest.spec.world.clone(), radius: 2.95 * dest.spec.massSol, kind: 'black-hole', spec: dest.spec };
    }
    return {
      key,
      name: dest.name,
      position: hole.world.clone(),
      radius: hole.rs,
      kind: 'black-hole',
      spec: dest.spec,
    };
  }
  if (dest.kind === 'nebula' || dest.kind === 'cluster' || dest.kind === 'neutron-star') {
    const item = deepObjects.get(key);
    return { key, name: dest.name, position: item.world.clone(), radius: item.radiusKm, kind: dest.kind, spec: dest.spec, dest };
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

const UP = new Vector3(0, 1, 0);
const tmpArrivalA = new Vector3();
const tmpArrivalB = new Vector3();
const tmpArrivalC = new Vector3();

/** The star lighting a body, whether it is ours or the one its own system has. */
function lightSourceFor(resolved) {
  if (exoSystem && (resolved.key.startsWith('exo:') || resolved.key === exoSystem.key)) {
    return exoSystem.position;
  }
  return universe.get('sun')?.position ?? null;
}

/** Whatever a body goes round, if that is something other than its star. */
function primaryPositionOf(resolved) {
  const parent = resolved.spec?.parent;
  if (!parent || parent === 'sun') return null;
  const body = universe.get(parent);
  if (body) return body.position;
  const planet = exoSystem?.planets.find((item) => item.spec.key === parent);
  return planet?.world ?? null;
}

/**
 * A point on a cone around `axis`, as near `toward` as the cone allows.
 *
 * Both arrival rules are this shape: hold an angle to something, and within
 * that freedom face the light.
 */
function onCone(axis, angleRad, toward, out) {
  const perpendicular = tmpArrivalA.copy(toward ?? UP).addScaledVector(axis, -(toward ?? UP).dot(axis));
  if (perpendicular.lengthSq() < 1e-12) {
    perpendicular.set(-axis.y, axis.x, axis.z).addScaledVector(axis, -axis.z);
    if (perpendicular.lengthSq() < 1e-12) perpendicular.set(0, 1, 0);
  }
  perpendicular.normalize();
  return out
    .copy(axis)
    .multiplyScalar(Math.cos(angleRad))
    .addScaledVector(perpendicular, Math.sin(angleRad))
    .normalize();
}

/**
 * Which side of a body to come in on.
 *
 * Two things decide it, and neither was being asked. A world arrived at from
 * an arbitrary direction is as likely as not to be a dark crescent, which is
 * why Saturn used to come up three-quarters in shadow. And a moon was arrived
 * at from directly outboard of its planet — along the line joining them — which
 * is the one direction that puts the planet exactly behind the moon, where the
 * moon hides it: you could stand at Titan and never see Saturn.
 *
 * So: face the light, and where there is a primary, hold far enough off the
 * line to it that it clears the target's limb and sits beside it in frame.
 */
function arrivalDirection(resolved, distanceRadii, out) {
  // In a visited system, from each body's exact offset from its star: far
  // from home the absolute positions are too coarse to say which way a moon's
  // planet lies, and arriving on the wrong side left it a black disc.
  const local = exoSystem?.localOf(resolved.spec?.key ?? resolved.key);
  const parent = resolved.spec?.parent;
  const parentLocal = local && parent && parent !== exoSystem.key ? exoSystem.localOf(parent) : null;
  const light = local ? null : lightSourceFor(resolved);
  const toLight = local ? tmpArrivalB.copy(local).negate()
    : light ? tmpArrivalB.subVectors(light, resolved.position) : null;
  if (toLight && toLight.lengthSq() > 1e-12) toLight.normalize();

  const primary = local ? parentLocal : primaryPositionOf(resolved);
  if (primary) {
    const outboard = out.subVectors(local ?? resolved.position, primary);
    if (outboard.lengthSq() < 1e-12) return null;
    outboard.normalize();
    // Enough to clear the target's own disc, plus a margin, and never so far
    // round that the primary leaves the frame.
    const limb = Math.asin(clamp(1 / Math.max(distanceRadii, 1.05), 0, 1));
    const axis = tmpArrivalC.copy(outboard);
    onCone(axis, clamp(limb + 0.16, 0.2, 0.52), toLight, out);
    if (!toLight || out.dot(toLight) > -0.05) return out;
    // Round the far side of its planet, where that framing is the moon's
    // night: a black disc in front of a black planet. Come in on the lit
    // side instead, leaning toward the planet.
    return onCone(toLight, 0.75, axis, out);
  }

  if (!toLight) return null;
  // Nothing to frame it against, so this is only about the light: a gibbous
  // phase, tipped so the star clears the body's limb and stays in shot.
  const sideways = tmpArrivalC.crossVectors(UP, toLight);
  if (sideways.lengthSq() < 1e-12) sideways.set(1, 0, 0);
  sideways.normalize().multiplyScalar(0.9).addScaledVector(UP, 0.45);
  return onCone(toLight, 0.56, sideways, out);
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
    const giantMoon = parentSpec && parentSpec.radiusKm > 20000 && resolved.spec.orbitKm;
    const distanceRadii =
      resolved.kind === 'galaxy' ? 2.4
      // A hole's radius is its horizon, and everything worth looking at is
      // outside it: the disk runs to 24 of them and the lensed image of its far
      // side to something like 40. Arriving at 18 puts the camera inside the
      // disk, looking at an orange fog.
      : resolved.kind === 'black-hole' ? 95
      : resolved.kind === 'nebula' ? 2.6
      : resolved.kind === 'cluster' ? 2.2
      : resolved.kind === 'neutron-star' ? 70
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
    } else if (resolved.kind === 'body') {
      arriveFrom = arrivalDirection(resolved, distanceRadii, tmpVector);
    }
    // From a planet to its own moon the camera's offset from the moon is
    // known exactly; from two absolute positions far from home it is not.
    const startOffset = cameraFrame.relative(tmpArrivalC, key)?.negate() ?? undefined;
    controls.flyTo(key, { distanceRadii, duration, arriveFrom, startOffset });
  } else {
    controls.setTarget(key, resolved.position, resolved.radius, {
      keepCamera: false,
      distanceRadii: controls.distanceRadii,
    });
  }
}

function unloadExo() {
  if (!exoSystem) return;
  // The craft go with the system: there are thousands of systems, and holding
  // every fleet ever visited would grow the roster without bound.
  craftField.drop(exoCraftKeys);
  craft.forget(exoCraftKeys);
  for (const craftKey of exoCraftKeys) removeDestination(craftDestKey(craftKey));
  exoCraftKeys = [];
  exoSystem.dispose();
  exoSystem = null;
  // Whichever point stood in for the host star is the star again.
  cosmos.hideStar(null);
  gaia?.hide(-1);
}

function maybeLoadExo(key) {
  const dest = destByKey.get(key);
  const system = dest?.system;
  if (!system) return;
  if (exoSystem?.system.host === system.host) return;
  unloadExo();
  exoSystem = new ExoSystem(system);
  extras.add(exoSystem.star.group);
  if (exoSystem.companion) extras.add(exoSystem.companion.star.group);
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
  const { colour, intensity, look } = starProfile(resolved.dest);
  const star = new Star({ radiusKm: resolved.radius, colour, intensity, look });
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
        : resolved.kind === 'nebula' ? 2.6
        : resolved.kind === 'cluster' ? 2.2
        : resolved.kind === 'neutron-star' ? 70
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
  if (carried.length || moons.length) {
    return [...carried, ...moons].sort((a, b) => b.radiusKm - a.radiusKm);
  }
  return membersOf(key);
}

/**
 * The same question asked of anything that is not a solar system body.
 *
 * BODIES and MOONS are the Sun's, so the answer above is "nothing" for every
 * other kind — and the system panel took that literally. Standing at TRAPPIST-1
 * with seven planets around it, or at a star in Andromeda with four, it said "no
 * known satellites"; at a black hole it said the same because nothing orbited
 * them at all, which is now no longer true. A system is a system wherever it is.
 *
 * Rows want `key`, `name` and either `radiusKm` or a `note` to show instead.
 */
function membersOf(key) {
  const dest = destByKey.get(key);

  // A star with planets. Taken from the live system when this is the one that
  // is loaded, which it is whenever you are actually in it: those specs carry
  // the radii the scene is drawing rather than the archive's earth-radii.
  if (exoSystem && key === exoSystem.key) {
    const planets = exoSystem.planets
      .map((item) => ({ key: item.spec.key, name: item.spec.name, radiusKm: item.spec.radiusKm }))
      .sort((a, b) => b.radiusKm - a.radiusKm);
    return [...planets, ...companionsOf(dest)];
  }
  if (exoSystem) {
    // A planet of one: its moons, which are not destinations of their own but
    // resolve by spec key, so the panel can still travel to them.
    const item = exoSystem.planets.find((planet) => planet.spec.key === key);
    if (item) {
      return item.moons
        .map((moon) => ({ key: moon.spec.key, name: moon.spec.name, radiusKm: moon.spec.radiusKm }))
        .sort((a, b) => b.radiusKm - a.radiusKm);
    }
  }
  // The same star before its system has been loaded: the record is enough to
  // list what is there, so the panel is filled on arrival rather than a frame
  // later.
  if (dest?.system && dest.system.host === dest.name) {
    const planets = (dest.system.planets ?? [])
      .map((planet) => ({
        key: exoKey(planet.name),
        name: planet.name,
        radiusKm: (planet.radiusEarth ?? 1) * EARTH_RADIUS_KM,
      }))
      .sort((a, b) => b.radiusKm - a.radiusKm);
    return [...planets, ...companionsOf(dest)];
  }
  // A galaxy or a black hole: the stars filed under it, nearest first for the
  // hole since how far out they orbit is the thing that distinguishes them.
  if (dest?.kind === 'galaxy') return hostsIn((system) => system.galaxy === dest.name);
  if (dest?.kind === 'black-hole') return hostsIn((system) => system.hole === dest.spec.key);
  return [];
}

/** The other stars of a double, listed with the planets of this one. */
function companionsOf(dest) {
  return (dest?.companions ?? []).map((key) => {
    const other = destByKey.get(key);
    return {
      key,
      name: other?.name ?? key,
      note: 'companion star',
      radiusKm: (other?.system?.radiusSol ?? 1) * SOLAR_RADIUS_KM,
    };
  });
}

/** The invented host stars matching `predicate`, as system panel rows. */
function hostsIn(predicate) {
  const rows = [];
  for (const dest of destinations) {
    if (dest.kind !== 'star' || !dest.system || !predicate(dest.system)) continue;
    rows.push({
      key: dest.key,
      name: dest.name,
      // A radius in kilometres is no use next to a star, and for the holes the
      // orbit is the fact worth having.
      note: dest.system.orbitAu
        ? `${formatAu(dest.system.orbitAu)} out`
        : `${(dest.system.planets?.length ?? 0)} planets`,
      radiusKm: (dest.system.radiusSol ?? 1) * SOLAR_RADIUS_KM,
      orbitAu: dest.system.orbitAu ?? 0,
    });
  }
  return rows.sort((a, b) => (a.orbitAu || Infinity) - (b.orbitAu || Infinity)
    || b.radiusKm - a.radiusKm);
}

/** Astronomical units, or parsecs once they stop being a readable number. */
function formatAu(au) {
  const pc = (au * AU_KM) / PC_KM;
  if (pc >= 0.1) return `${pc.toFixed(pc >= 10 ? 0 : 1)} pc`;
  return `${au < 100 ? au.toFixed(0) : Math.round(au / 10) * 10} AU`;
}

controls.onClick = (x, y) => {
  const hit = pickNamed(x, y);
  const dot = pickDot(x, y);
  // A named thing wins a near tie: a craft marker drawn over a bright star is
  // the craft being clicked.
  if (dot && (!hit || dot.score < hit.score - 2)) {
    const key = destinationForDot(dot.dot);
    if (key) selectTarget(key, { fly: true });
    return;
  }
  if (hit) selectTarget(hit.key, { fly: true });
};

controls.canWalk = () =>
  !state.viewFromEarth && !state.riding && resolveWorld(state.target)?.kind === 'body' && Boolean(surfaceOf(state.target));

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
      deepField.showStars = enabled;
      deepField.stars.visible = enabled;
      deepField.hostStars.points.visible = enabled;
      cosmos.starPoints.visible = enabled;
      if (gaia) gaia.points.visible = enabled;
      break;
    case 'galaxies':
      deepField.showGalaxies = enabled;
      deepField.galaxies.mesh.visible = enabled;
      cosmos.galaxyMesh.visible = enabled;
      cosmos.showClouds = enabled;
      break;
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
    case 'orbits':
      state.showOrbits = enabled;
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
    roamReadout: () => roamReadout(performance.now()),
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
      if (dest?.cosmic) {
        const g = dest.cosmic;
        return { generated: true, morph: `${galaxyType(g.morph)}, uncharted`, d: g.center.distanceTo(universe.get('sun').position) / (PC_KM * 1e6), radiusKm: g.radiusKm };
      }
      if (dest?.galaxyIndex === undefined) return null;
      return { ...data.galaxies.galaxies[dest.galaxyIndex], radiusKm: deepField.galaxyAt(dest.galaxyIndex)?.radiusKm };
    },
    sunDistanceTo(position) {
      return position.distanceTo(universe.get('sun').position);
    },
    collectLabelItems: collectLabelItems,
    liveDestinations: () => liveDests,
    setShip,
    shipActive: () => ship.active,
    toggleShipView: () => ship.active && ship.toggleView(),
    toggleWarp: () => ship.active && ship.toggleWarp(),
    shipBrake: () => ship.active && ship.brake(),
  },
});

// Everything is drawn into this rather than the canvas, so the canvas's own
// antialias never touches the scene: without samples here every ridge line and
// limb against the sky is a staircase.
const composerTarget = new WebGLRenderTarget(1, 1, {
  type: HalfFloatType,
  depthBuffer: true,
  stencilBuffer: true,
  samples: platform.antialias ? 4 : 0,
});
const composer = new EffectComposer(renderer, composerTarget);
const skyPass = new RenderPass(skyScene, skyCamera);
const mainPass = new RenderPass(scene, camera);
mainPass.clear = false;
mainPass.clearDepth = true;
const bloomPass = new UnrealBloomPass(new Vector2(1, 1), 0.22, 0.28, 0.97);
// The target is half float, which overflows to infinity past 65504, and one
// infinite or NaN pixel is enough for the bloom blur to smear into black
// blocks that flicker from frame to frame. Clamped out before the blur sees it.
const sanitizePass = new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 rgb = any(isnan(c.rgb)) ? vec3(0.0) : clamp(c.rgb, 0.0, 6e4);
      gl_FragColor = vec4(rgb, isnan(c.a) ? 1.0 : c.a);
    }`,
});
/*
 * Black holes bend the light of everything behind them, so they are drawn
 * last: the frame so far is copied aside, and each hole's rays read their
 * background from that copy in the direction they escape. Drawn into the
 * same buffer as the main pass, so its depth still hides a hole behind a
 * planet. Both passes idle when no hole is big enough on screen to draw.
 */
const behindTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
const copyMaterial = new ShaderMaterial({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv); }',
  depthTest: false,
  depthWrite: false,
});
const copyQuad = new FullScreenQuad(copyMaterial);
const holePass = new (class extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
  }
  setSize(width, height) {
    behindTarget.setSize(width, height);
  }
  render(r, writeBuffer, readBuffer) {
    copyMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    r.setRenderTarget(behindTarget);
    copyQuad.render(r);
    const mask = camera.layers.mask;
    const autoClear = r.autoClear;
    camera.layers.set(BLACK_HOLE_LAYER);
    r.autoClear = false;
    r.setRenderTarget(readBuffer);
    r.render(scene, camera);
    camera.layers.mask = mask;
    r.autoClear = autoClear;
  }
})();
holePass.enabled = false;

composer.addPass(skyPass);
composer.addPass(mainPass);
composer.addPass(holePass);
composer.addPass(sanitizePass);
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
const cameraFrame = {
  key: null,
  offset: new Vector3(),
  /**
   * Where something belonging to body `frameKey`, at `local` from its centre,
   * is relative to the camera, worked out without the absolute positions; or
   * null when that cannot be done exactly.
   *
   * Besides the body the camera is anchored to, this covers every other body
   * of a visited system: each holds its exact offset from the host star, so a
   * moon seen from its planet is the difference of two small vectors as well.
   * Ten megaparsecs out a double is spaced 65,000 kilometres apart, and
   * subtracting there shook the planets back and forth as the camera turned.
   */
  relative(out, frameKey, local = null) {
    if (frameKey === null || this.key === null) return null;
    if (frameKey === this.key) {
      if (local) return out.copy(local).sub(this.offset);
      return out.copy(this.offset).negate();
    }
    const there = exoSystem?.localOf(frameKey);
    const here = there && exoSystem.localOf(this.key);
    if (!here) return null;
    out.copy(there).sub(here).sub(this.offset);
    if (local) out.add(local);
    return out;
  },
};

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
  if (cameraFrame.relative(out, frameKey, local)) return out;
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
 * A planet or moon of the loaded system as a point of reflected light, once it
 * is too small to draw: the way a system reads in SpaceEngine, its worlds and
 * their moons strung out as sparks round the star.
 */
const tmpDot = new Vector3();
function addExoDot(body, distanceKm, hostLum, fromStarKm) {
  const palette = body.spec.palette;
  const tint = body.spec.atmosphere?.tint ?? (palette ? palette[0] : [0.8, 0.78, 0.74]);
  renderOffset(tmpDot, body.world, body.spec.key);
  distantBodies.addReflected(tmpDot, tint, {
    radiusKm: body.spec.radiusKm,
    distanceKm,
    flux: exoFlux(hostLum, fromStarKm / 149597870.7),
    albedo: body.spec.atmosphere ? 0.45 : 0.25,
    limit: 11.5 + 2.5 * Math.log10(Math.max(58 / Math.max(camera.fov, 1e-4), 1)),
  });
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
  // A moon's own orbit is round its planet, a thousandth of an au: exposing
  // for that much sunlight drew every moon black.
  const fromStarKm = system.moons.includes(chosen) ? chosen.local?.length() : chosen.spec.orbitKm;
  return exoFlux(hostLum, (fromStarKm || chosen.spec.orbitKm) / 149597870.7);
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
let roamSurfaceKm = Infinity;
const roamNearest = { key: null, position: null, radius: 0 };
const tmpShipWorld = new Vector3();
const tmpShipUp = new Vector3();
const tmpUnitScale = new Vector3(1, 1, 1);
const tmpBodyInverse = new Quaternion();

/**
 * The ground under the camera, or under the ship when there is one, measured
 * off the terrain as it is drawn.
 *
 * Without this the only floor was the reference sphere: zooming all the way in
 * stopped at radius x 1.000001, which is under every hill, crater rim and
 * octave of procedural relief, and from under the ground the terrain is all
 * back faces and only the skirts along its patch edges show, as a grid. The
 * measured map alone is not enough either, since the shader displaces the
 * ground further. So the height is read back from the terrain shader itself,
 * a few times a second and when the point has moved, and only close in, where
 * the relief can matter.
 */
const cameraGround = { key: null, km: 0, at: 0, dir: new Vector3(), altitudeKm: Infinity };
let groundExposure = 1;
const groundProbeDirs = [new Vector3()];
const GROUND_CLEARANCE_KM = 0.004;
const SHIP_CLEARANCE_KM = 0.03;

function surfaceOf(key) {
  if (!key) return null;
  const planet = planets.get(key);
  if (planet) {
    const body = universe.get(key);
    return body ? { planet, position: body.position, orientation: body.orientation, radius: planet.radius } : null;
  }
  const exo = exoSystem?.get(key);
  if (exo?.planet) return { planet: exo.planet, position: exo.position, orientation: exo.orientation, radius: exo.spec.radiusKm };
  return null;
}

/** Height of the drawn ground under `point`, in km above the body's sphere, or null. */
function groundUnder(key, point, now) {
  const surface = surfaceOf(key);
  if (!surface) return null;
  const up = tmpShipUp.copy(point).sub(surface.position);
  const distance = up.length();
  if (!(distance > 0) || distance > surface.radius * 1.25) return null;
  up.multiplyScalar(1 / distance);
  const local = groundProbeDirs[0].copy(up).applyQuaternion(tmpBodyInverse.copy(surface.orientation).invert());
  const altitude = distance - surface.radius - cameraGround.km;
  const stale = cameraGround.key !== key
    || now - cameraGround.at > 120
    || cameraGround.dir.angleTo(local) * surface.radius > Math.max(altitude * 0.05, 0.001);
  if (stale && surface.planet.group.visible) {
    const uniforms = surface.planet.material.uniforms;
    const settle = (km) => {
      if (!Number.isFinite(km) || Math.abs(km) > surface.radius * 0.25) km = demGroundKm(key, local) ?? 0;
      // The height function is the seabed; the water drawn over it is the floor.
      if (uniforms.uHasOcean?.value > 0 || surface.planet.spec?.oceanFraction > 0) {
        km = Math.max(km, uniforms.uSeaLevelKm?.value ?? 0);
      }
      cameraGround.key = key;
      cameraGround.km = km;
    };
    // Only the first answer on a body is worth a stall; after that the floor
    // can be a frame or two behind while the read is in flight.
    const pending = cameraGround.key === key && renderer.readRenderTargetPixelsAsync
      ? surface.planet.groundHeightsKmAsync(renderer, groundProbeDirs)
      : null;
    if (pending) pending.then((h) => { if (cameraGround.key === key) settle(h[0]); }, () => {});
    else if (cameraGround.key !== key) settle(surface.planet.groundHeightsKm(renderer, groundProbeDirs)[0]);
    cameraGround.at = now;
    cameraGround.dir.copy(local);
  }
  if (cameraGround.key !== key) return null;
  return { up, distance, radius: surface.radius, groundKm: cameraGround.km };
}

/**
 * Orbit and free flight keep their distance from the target as a ratio, so
 * their floor is a ratio too, set before the controls move. Roaming and the
 * ship are pushed back out afterwards instead, since their position is not
 * held as a distance from anything that has a surface.
 */
function floorBeforeControls(resolved, now) {
  cameraGround.altitudeKm = Infinity;
  controls.minDistanceRadii = 1.000001;
  controls.horizon = null;
  controls.groundFloor = false;
  if (controls.mode === 'roam' || state.viewFromEarth || state.riding || !resolved) return;
  // A galaxy has no surface to stop at. Held a radius out, you could look at
  // the Magellanic Clouds but never go into them, among their stars.
  if (resolved.kind === 'galaxy') {
    controls.minDistanceRadii = 1e-9;
    return;
  }
  if (resolved.kind === 'craft') {
    horizonForCraft(resolved, now);
    return;
  }
  // Kept current in every mode, because starting a walk converts the camera
  // into this frame before the first walking frame has run.
  const surface = surfaceOf(resolved.key);
  controls.walkFrame = surface?.orientation ?? null;
  controls.walkAxisScale.copy(surface?.planet.material.uniforms.uAxisScale?.value ?? tmpUnitScale);
  if (controls.mode === 'walk' && surface) {
    walkOnGround(surface, resolved.key, now);
    return;
  }
  const ground = groundUnder(resolved.key, controls.worldPosition, now);
  if (!ground) return;
  const radius = resolved.radius;
  const floor = (radius + ground.groundKm + GROUND_CLEARANCE_KM) / radius;
  controls.minDistanceRadii = Math.max(1.000001, floor);
  controls.groundFloor = true;
  if (controls.distanceRadii < controls.minDistanceRadii) controls.distanceRadii = controls.minDistanceRadii;
  cameraGround.altitudeKm = ground.distance - radius - ground.groundKm;
}

/**
 * Under a full daytime sky nothing beyond the solar system shows. The layers
 * are hidden after their own updates have run, and each is handed back exactly
 * as it was once the sky darkens again.
 */
const veiled = new Set();
function veilSky(day) {
  if (day) {
    for (const object of [...cosmos.underlay, ...cosmos.objects, ...deepField.objects, deepObjects.group, distantBodies.object,
      ...[...blackHoles.values()].map((hole) => hole.group)]) {
      if (object.visible) {
        object.visible = false;
        veiled.add(object);
      }
    }
  } else if (veiled.size) {
    for (const object of veiled) object.visible = true;
    veiled.clear();
  }
}

/**
 * The ground under a walker.
 *
 * The height function at the walker's own point is not enough. The mesh drawn
 * there is triangles between vertices a quad apart, and in a hollow the
 * triangle passes above the true surface, so an eye placed on the true surface
 * ends up under the drawn one, looking at the underside of the terrain. So the
 * ground is the highest of a three-by-three spread at the drawn vertex spacing,
 * which no triangle around the walker can rise above.
 *
 * Read back asynchronously: a walker crosses a metre a frame at a run, and a
 * synchronous read every frame stalls the whole pipeline while it does.
 */
const walkProbe = { key: null, dirs: Array.from({ length: 9 }, () => new Vector3()), km: null, at: 0, last: 0, dir: new Vector3() };
const walkRight = new Vector3();
function walkOnGround(surface, key, now) {
  const planet = surface.planet;
  const up = controls.walkLocal;
  if (walkProbe.key !== key || walkProbe.epoch !== controls.walkGroundEpoch) {
    walkProbe.key = key;
    walkProbe.epoch = controls.walkGroundEpoch;
    walkProbe.km = null;
    walkProbe.at = -Infinity;
  }
  // Wider at speed, to cover the ground crossed while a read is in flight and
  // until the next one: each read costs the frame a few milliseconds, so they
  // come at a steady rate rather than once per frame of movement.
  const ahead = (controls.walkVelocity * 0.3) / surface.radius;
  const spacing = Math.max(planet.finestSpacingRadians() * 2, ahead, 2e-7);
  const moved = walkProbe.dir.angleTo(up);
  const fresh = walkProbe.km === null;
  const due = moved > spacing * 0.25 ? now - walkProbe.at > 90 : now - walkProbe.at > 400;
  if ((fresh || due) && planet.group.visible) {
    walkRight.crossVectors(controls.walkHeadingLocal, up).normalize();
    let n = 0;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        walkProbe.dirs[n++].copy(up)
          .addScaledVector(controls.walkHeadingLocal, i * spacing)
          .addScaledVector(walkRight, j * spacing)
          .normalize();
      }
    }
    const uniforms = planet.material.uniforms;
    const wet = uniforms.uHasOcean?.value > 0 || planet.spec?.oceanFraction > 0;
    const settle = (heights) => {
      let km = -Infinity;
      for (const h of heights) if (Number.isFinite(h) && Math.abs(h) < surface.radius * 0.25) km = Math.max(km, h);
      if (!Number.isFinite(km)) return;
      if (wet) km = Math.max(km, uniforms.uSeaLevelKm?.value ?? 0);
      walkProbe.km = km;
    };
    const pending = walkProbe.km === null ? null : planet.groundHeightsKmAsync(renderer, walkProbe.dirs);
    if (pending) pending.then(settle, () => {});
    else if (walkProbe.km === null || !renderer.readRenderTargetPixelsAsync) settle(planet.groundHeightsKm(renderer, walkProbe.dirs));
    if (pending || walkProbe.km !== null) {
      walkProbe.at = now;
      walkProbe.dir.copy(up);
    }
  }
  if (walkProbe.km !== null) {
    // Up at once and down gently: stepping onto a rise must never put the eye
    // inside it for a frame, and a dip is no hurry.
    const dt = Math.min(Math.max((now - walkProbe.last) / 1000, 0), 0.25);
    const gap = walkProbe.km - controls.walkGroundKm;
    controls.walkGroundKm += gap > 0 || fresh ? gap : gap * Math.min(1, dt * 5);
  }
  walkProbe.last = now;
  cameraGround.key = key;
  cameraGround.km = controls.walkGroundKm;
  cameraGround.altitudeKm = controls.walkEyeKm;
}

/**
 * A craft on the ground, or just above it, is orbited like anything else, but
 * half of that orbit is underground. The floor there is a horizon: the camera
 * stays above the plane of the ground at the craft, and higher still if the
 * terrain under the camera rises above the craft's own footing.
 */
const horizonUp = new Vector3();
function horizonForCraft(resolved, now) {
  const item = craftField.get(craftKeyOf(resolved.key));
  const surface = surfaceOf(item?.centreKey);
  if (!item || !surface || !resolved.position) return;
  horizonUp.copy(resolved.position).sub(surface.position);
  const fromCentre = horizonUp.length();
  if (!(fromCentre > 0)) return;
  horizonUp.multiplyScalar(1 / fromCentre);
  const craftAltKm = fromCentre - surface.radius;
  if (!item.onSurface && craftAltKm > Math.max(3, surface.radius * 0.002)) return;
  const distanceKm = controls.distanceRadii * resolved.radius;
  let minSin = Math.sin((3 * Math.PI) / 180);
  const ground = groundUnder(item.centreKey, controls.worldPosition, now);
  if (ground && distanceKm > 0) {
    // The clearance scales with the orbit: a rover is a couple of metres
    // across and is framed from ten, so a fixed eye height would put the
    // camera straight overhead.
    const clearance = Math.min(GROUND_CLEARANCE_KM, distanceKm * 0.06);
    const need = (ground.groundKm + clearance - craftAltKm) / distanceKm;
    minSin = Math.max(minSin, need);
  }
  controls.horizon = { up: horizonUp, minSin: Math.min(minSin, 0.97) };
}

function floorAfterControls(now, resolved) {
  if (controls.mode === 'orbit') {
    orbitFloorAfterControls(now, resolved);
    return;
  }
  if (controls.mode !== 'roam' || !roamNearest.key) return;
  const point = ship.active ? ship.worldPosition(controls, tmpShipWorld) : tmpShipWorld.copy(controls.worldPosition);
  const ground = groundUnder(roamNearest.key, point, now);
  if (!ground) return;
  const floor = ground.radius + ground.groundKm + (ship.active ? SHIP_CLEARANCE_KM : GROUND_CLEARANCE_KM);
  cameraGround.altitudeKm = ground.distance - ground.radius - ground.groundKm;
  if (ground.distance >= floor) return;
  const push = floor - ground.distance;
  const up = ground.up;
  controls.roamOffset.addScaledVector(up, push);
  controls.originOffset.addScaledVector(up, push);
  controls.worldPosition.addScaledVector(up, push);
  cameraGround.altitudeKm += push;
  if (ship.active) {
    // Whatever was carrying the ship into the ground stops; sliding along it is fine.
    const into = ship.velocity.dot(up);
    if (into < 0) ship.velocity.addScaledVector(up, -into);
    ship.speed = Math.min(ship.speed, ship.velocity.length());
  }
}

/**
 * The floor set before the controls moved is for where the camera was. Orbit
 * a few metres up and a drag carries it sideways into the next rise before
 * that floor catches up, and for a frame the view is from inside the ground:
 * the planet's back faces, the patch skirts as a grid, or nothing at all. So
 * the new position is checked against the ground under it as well, and lifted
 * along the same line of sight if it went in.
 */
function orbitFloorAfterControls(now, resolved) {
  if (!resolved || resolved.kind === 'galaxy' || resolved.kind === 'craft') return;
  if (state.viewFromEarth || state.riding || controls.flying) return;
  const ground = groundUnder(resolved.key, controls.worldPosition, now);
  if (!ground) return;
  const floor = ground.radius + ground.groundKm + GROUND_CLEARANCE_KM;
  if (ground.distance >= floor) return;
  const lifted = controls.distanceRadii * (floor / Math.max(ground.distance, 1e-9));
  controls.distanceRadii = lifted;
  controls.originOffset.multiplyScalar(floor / Math.max(ground.distance, 1e-9));
  controls.worldPosition.copy(controls.targetPosition).add(controls.originOffset);
  cameraGround.altitudeKm = GROUND_CLEARANCE_KM;
}

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
  roamSurfaceKm = bestSurface;
  roamNearest.key = bestKey;
  roamNearest.position = bestPos;
  roamNearest.radius = bestRadius;
  // Three hundred radii out a body is a couple of degrees wide and its orbital
  // motion is no longer yours to share.
  if (bestKey && bestSurface < bestRadius * 300) controls.setRoamAnchor(bestKey, bestPos);
  else controls.setRoamAnchor(starKey, starPos);
  // Roaming belongs to no one body: whatever you fly down to becomes the
  // selection, so its ground loads in detail and Walk lands on it, without the
  // camera being handed to it.
  if (bestKey && bestKey !== state.target && bestSurface < bestRadius * 1.5 && resolveWorld(bestKey)?.kind === 'body') {
    selectTarget(bestKey, { fly: false });
  }
}

const roamLast = { offset: new Vector3(), key: null, at: 0, speed: 0 };
function roamReadout(now) {
  if (controls.mode !== 'roam') return null;
  const dt = (now - roamLast.at) / 1000;
  if (roamLast.key === controls.roamOriginKey && dt > 0 && dt < 1) {
    const moved = roamLast.offset.distanceTo(controls.roamOffset) / dt;
    roamLast.speed += (moved - roamLast.speed) * Math.min(1, dt * 4);
  }
  roamLast.offset.copy(controls.roamOffset);
  roamLast.key = controls.roamOriginKey;
  roamLast.at = now;
  const name = roamNearest.key ? (resolveWorld(roamNearest.key)?.name ?? roamNearest.key) : null;
  const km = (v) => (v < 1 ? `${Math.round(v * 1000)} m`
    : v < 1e6 ? `${Math.round(v).toLocaleString()} km`
      : v < 1.496e8 * 2000 ? `${(v / 1.496e8).toFixed(v < 1.496e9 ? 2 : 0)} au`
        : `${(v / 9.4607e12).toFixed(2)} ly`);
  const s = roamLast.speed;
  const speed = s < 1 ? `${Math.round(s * 1000)} m/s` : s < 299792 ? `${km(s)}/s` : `${(s / 299792).toFixed(s < 2997920 ? 2 : 0)} c`;
  return { speed, nearest: name ? `${name} \u00b7 ${km(Math.max(roamSurfaceKm, 0))}` : '' };
}

/*
 * The neighbourhood: four times a second, what is near the camera (or the
 * ship) and what that should switch on.
 *
 * A star you come within a few thousand au of becomes a system — the real one
 * where the archive has planets for it, an invented one everywhere else — so
 * every point of light in the sky is somewhere you can arrive. Generated
 * galaxies and the black holes in them become destinations as they come into
 * range, so search and the labels can name them. Only what is near is ever
 * built, and the cost of this pass does not grow with how far you have come.
 */
const ACTIVATE_KM = 4000 * AU_KM;
const liveDests = [];
const liveStarKeys = new Map();
const liveHoles = new Set();
const catalogDests = new Map();
for (const dest of destinations) {
  if (dest.catalogIndex !== undefined) catalogDests.set(dest.catalogIndex, dest);
}
let realSystems = null;
const tmpProbe = new Vector3();
const tmpDesignation = new Vector3();
const ECLIPTIC_TO_EQUATORIAL = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), ECLIPTIC_OBLIQUITY);
let neighbourhoodAt = 0;
const neighbourhood = { star: null, spaceKm: PC_KM };

function addLive(entry) {
  const existing = destByKey.get(entry.key);
  if (existing) return existing;
  addDestination(entry);
  liveDests.push(entry);
  return entry;
}

function registerLiveSystem(system, hostGroup) {
  addLive({ key: `star:${system.host}`, name: system.host, kind: 'star', group: hostGroup, system, generated: true });
  for (const planet of system.planets) {
    addLive({
      key: exoKey(planet.name), name: planet.name, kind: 'exo-planet', group: system.host, system, planetName: planet.name,
    });
  }
}

/** The IAU-style coordinate name a survey star goes by: "Gaia DR3 J053214.6+092251". */
function designation(prefix, world) {
  const { ra, dec } = vectorToEquatorial(tmpDesignation.copy(world).applyQuaternion(ECLIPTIC_TO_EQUATORIAL));
  const pad = (n) => String(Math.floor(n)).padStart(2, '0');
  const h = ra / 15;
  const m = (h % 1) * 60;
  const sec = (m % 1) * 60;
  const ad = Math.abs(dec);
  const dm = (ad % 1) * 60;
  return `${prefix} J${pad(h)}${pad(m)}${sec.toFixed(1).padStart(4, '0')}${dec < 0 ? '-' : '+'}${pad(ad)}${pad(dm)}${pad((dm % 1) * 60)}`;
}

function nearestCatalogStar(world, maxKm) {
  const w = deepField.world;
  let best = -1;
  let bestD2 = maxKm * maxKm;
  for (let i = 0, n = deepField.count; i < n; i++) {
    const dx = w[i * 3] - world.x;
    const dy = w[i * 3 + 1] - world.y;
    const dz = w[i * 3 + 2] - world.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  if (best < 0) return null;
  return {
    kind: 'hyg',
    index: best,
    absMag: deepField.absMag[best],
    bv: data.catalog.colorIndex[best],
    world: new Vector3(w[best * 3], w[best * 3 + 1], w[best * 3 + 2]),
    distanceKm: Math.sqrt(bestD2),
  };
}

function nearestRealSystem(world) {
  if (!realSystems) {
    realSystems = destinations
      .filter((dest) => dest.kind === 'star' && dest.system && !dest.system.generated && dest.key !== 'sun')
      .map((dest) => ({ dest, world: starWorld(dest) }));
  }
  let best = null;
  let bestKm = Infinity;
  for (const item of realSystems) {
    const d = item.world.distanceTo(world);
    if (d < bestKm) {
      bestKm = d;
      best = item;
    }
  }
  if (!best || bestKm > 200 * PC_KM) return null;
  return { kind: 'real', dest: best.dest, world: best.world, distanceKm: bestKm };
}

function starName(c) {
  if (c.kind === 'real') return c.dest.name;
  const key = liveStarKeys.get(starIdentity(c));
  if (key) return destByKey.get(key)?.name ?? '';
  if (c.kind === 'hyg') return catalogDests.get(c.index)?.name ?? designation('HYG', c.world);
  if (c.kind === 'gaia') return designation('Gaia DR3', c.world);
  return 'Uncharted star';
}

function starIdentity(c) {
  return c.kind === 'gen' ? `g${c.seed}` : c.kind === 'hyg' ? `h${c.index}` : c.kind === 'gaia' ? `a${c.index}` : c.dest.key;
}

/** Loads the system of a star found near the camera or clicked on, and returns its key. */
function activateStar(c) {
  if (c.kind === 'real') {
    maybeLoadExo(c.dest.key);
    return c.dest.key;
  }
  const identity = starIdentity(c);
  let key = liveStarKeys.get(identity);
  if (!key) {
    const named = c.kind === 'hyg' ? catalogDests.get(c.index) : null;
    if (named) {
      if (!named.system) {
        named.system = inventForCatalogStar(named.key, { name: named.name, absMag: c.absMag, world: c.world, bv: c.bv });
        named._profile = null;
        for (const planet of named.system.planets) {
          addLive({ key: exoKey(planet.name), name: planet.name, kind: 'exo-planet', group: named.name, system: named.system, planetName: planet.name });
        }
      }
      key = named.key;
    } else {
      const system = c.kind === 'gen'
        ? inventStarSystem(c.seed, { absMag: c.absMag, world: c.world, region: c.galaxy?.name })
        : inventForCatalogStar(identity, { name: designation(c.kind === 'hyg' ? 'HYG' : 'Gaia DR3', c.world), absMag: c.absMag, world: c.world, bv: c.bv });
      registerLiveSystem(system, c.kind === 'gen' ? (c.galaxy?.name ?? 'Uncharted stars') : 'Nearby stars');
      key = `star:${system.host}`;
    }
    liveStarKeys.set(identity, key);
  }
  maybeLoadExo(key);
  if (c.kind === 'gen') cosmos.hideStar(c.seed);
  else if (c.kind === 'gaia') gaia?.hide(c.index);
  return key;
}

/** Inverse of deep-field's morphCode. */
function galaxyType(morph) {
  return ['E', 'S0', 'Sb', 'Sc', 'SBb', 'SBc', 'Irr'][Math.round(Math.min(Math.max(morph, 0), 6))];
}

function disposeTree(object) {
  object.traverse((node) => {
    node.geometry?.dispose?.();
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const material of materials) material.dispose?.();
  });
}

function updateHoles(probe) {
  const wanted = new Map();
  for (const g of cosmos.nearbyGalaxies(probe, 4)) {
    if (g.center.distanceTo(probe) > g.radiusKm * 3) continue;
    const spec = cosmos.holeSpecFor(g);
    if (spec) wanted.set(`bh:${spec.key}`, spec);
  }
  for (const spec of cosmos.nearbyHoles(probe, 400)) wanted.set(`bh:${spec.key}`, spec);
  for (const [key, spec] of wanted) {
    if (blackHoles.has(key)) continue;
    const hole = new BlackHole({ ...spec, ra: 0, dec: 0, distPc: 0 });
    hole.world.copy(spec.world);
    hole.group.visible = state.showBlackHoles;
    blackHoles.set(key, hole);
    extras.add(hole.group);
    liveHoles.add(key);
    addLive({ key, name: spec.name, kind: 'black-hole', group: 'Black holes', spec });
  }
  for (const key of liveHoles) {
    if (wanted.has(key) || key === state.target) continue;
    const hole = blackHoles.get(key);
    extras.remove(hole.group);
    disposeTree(hole.group);
    blackHoles.delete(key);
    liveHoles.delete(key);
  }
}

function updateNeighbourhood(now) {
  if (now - neighbourhoodAt < 250) return;
  neighbourhoodAt = now;
  const probe = ship.active ? ship.worldPosition(controls, tmpProbe) : tmpProbe.copy(controls.worldPosition);
  const fromSun = probe.distanceTo(universe.get('sun').position);

  let best = null;
  const consider = (c, bias = 1) => {
    if (c && (!best || c.distanceKm * bias < best.distanceKm)) best = c;
  };
  const generated = cosmos.nearestStar(probe, 200 * PC_KM);
  if (generated) consider({ kind: 'gen', ...generated });
  if (fromSun < 6000 * PC_KM) {
    consider(nearestCatalogStar(probe, 200 * PC_KM));
    const g = gaia?.nearest(probe, 30 * PC_KM);
    if (g) consider({ kind: 'gaia', ...g });
  }
  // A real planetary system beats a survey star that is the same star.
  consider(nearestRealSystem(probe), 0.5);
  neighbourhood.star = best;

  let galaxyKm = Infinity;
  let galaxyName = '';
  const nearGalaxy = (name, d, radiusKm) => {
    const surface = Math.max(d - radiusKm, radiusKm * 0.05);
    if (surface < galaxyKm) {
      galaxyKm = surface;
      galaxyName = name;
    }
  };
  // Galaxies passed at warp would otherwise pile up in search and the labels.
  if (liveDests.length > 400) {
    for (let i = liveDests.length - 1; i >= 0; i--) {
      const dest = liveDests[i];
      if (!dest.cosmic || dest.key === state.target) continue;
      if (dest.cosmic.center.distanceTo(probe) < 40 * PC_KM * 1e6) continue;
      removeDestination(dest.key);
      liveDests.splice(i, 1);
    }
  }
  for (const g of cosmos.nearbyGalaxies(probe, 16)) {
    nearGalaxy(g.name, g.center.distanceTo(probe), g.radiusKm);
    addLive({ key: g.key, name: g.name, kind: 'galaxy', group: 'Uncharted galaxies', cosmic: g });
  }
  const inGalaxy = cosmos.active && cosmos.active.center.distanceTo(probe) < cosmos.active.radiusKm * 1.5;
  for (let i = 0, n = data.galaxies.galaxies.length; i < n; i++) {
    const g = deepField.galaxyAt(i);
    const d = Math.hypot(g.x - probe.x, g.y - probe.y, g.z - probe.z);
    const record = data.galaxies.galaxies[i];
    nearGalaxy(record.name || record.id, d, g.radiusKm);
  }
  const starKm = best ? best.distanceKm : Infinity;
  neighbourhood.spaceKm = Math.max(Math.min(inGalaxy || fromSun < 30000 * PC_KM ? Math.min(starKm, 3 * PC_KM) : Infinity, galaxyKm), 1e5);

  if (ship.active) {
    const sunKm = fromSun;
    if (sunKm < 2000 * AU_KM) {
      ship.nearestName = 'Sun';
      ship.nearestKm = sunKm;
    } else if (best && best.distanceKm < 50 * PC_KM) {
      ship.nearestName = starName(best);
      ship.nearestKm = best.distanceKm;
    } else if (galaxyName) {
      ship.nearestName = galaxyName;
      ship.nearestKm = galaxyKm;
    } else {
      ship.nearestName = '';
    }
  }

  if (best && best.distanceKm < ACTIVATE_KM) activateStar(best);
  else if (exoSystem && destByKey.get(state.target)?.system !== exoSystem.system) {
    // A system nobody is near or looking at is unloaded, the same as a star
    // cell; arriving again rebuilds it from its seed.
    const host = resolveWorld(`star:${exoSystem.system.host}`);
    if (!host || host.position.distanceTo(probe) > PC_KM) unloadExo();
  }
  updateHoles(probe);
}

function setShip(enabled) {
  if (enabled === ship.active) return;
  if (enabled) {
    if (state.viewFromEarth) setViewFromEarth(false);
    if (state.riding) setRiding(null);
    controls.trackTarget = false;
    controls.startRoam();
    ship.enter(controls);
    controls.pilot = ship;
  } else {
    controls.pilot = null;
    ship.exit();
  }
}

/** The camera in a body's own frame, exactly where the camera is anchored to it. */
function cameraLocalIn(world, key, out) {
  if (cameraFrame.relative(out, key)) return out.negate();
  return out.copy(controls.worldPosition).sub(world);
}

/** The named thing under the pointer, as a key: what hover and the context menu ask for. */
function pick(clientX, clientY) {
  return pickNamed(clientX, clientY)?.key ?? null;
}

/**
 * The nearest solid body along the pointer's ray, and how far off it is.
 *
 * Points and markers are picked by how near they project to the pointer, which
 * on its own knows nothing of what is in the way: a star directly behind a
 * planet, or a moon on the far side of it, could be clicked straight through
 * the planet. Anything farther than this is hidden and is not offered.
 */
const occludeRay = new Vector3();
const occludeCentre = new Vector3();
function pointerOcclusion(nx, ny) {
  camera.updateMatrixWorld();
  occludeRay.set(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize();
  let nearest = { key: null, km: Infinity };
  const sphere = (key, world, radius, frameKey = null) => {
    if (!world || !(radius > 0)) return;
    renderOffset(occludeCentre, world, frameKey, null).sub(camera.position);
    const dist = occludeCentre.length();
    // Standing on it, the sphere has to pass under the eye, or the ground
    // below a basin would hide the whole sky.
    const r = Math.min(radius, dist - Math.max(dist * 1e-9, 0.001));
    if (r <= 0) return;
    const along = occludeCentre.dot(occludeRay);
    const miss = dist * dist - along * along;
    if (miss > r * r) return;
    const t = along - Math.sqrt(r * r - miss);
    if (t > 0 && t < nearest.km) nearest = { key, km: t };
  };
  const fromSun = controls.worldPosition.distanceTo(universe.get('sun').position);
  if (fromSun < 1000 * PC_KM) sphere('sun', universe.get('sun').position, SUN.radiusKm);
  if (fromSun < PC_KM) {
    for (const [key, planet] of planets) {
      if (planet.group.visible) sphere(key, universe.get(key).position, planet.radius, key);
    }
  }
  if (exoSystem) {
    sphere(exoSystem.key, exoSystem.position, exoSystem.star.radius, exoSystem.key);
    if (exoSystem.companion) sphere(null, exoSystem.companion.world, exoSystem.companion.star.radius);
    for (const item of exoSystem.planets) sphere(item.spec.key, item.world, item.spec.radiusKm, item.spec.key);
    for (const moon of exoSystem.moons) sphere(moon.spec.key, moon.world, moon.spec.radiusKm, moon.spec.key);
  }
  return nearest;
}

const PICKABLE_KINDS = new Set(['star', 'galaxy', 'black-hole', 'neutron-star', 'nebula', 'cluster']);

/** The named thing under the pointer and how good a hit it is, lower being better. */
function pickNamed(clientX, clientY) {
  const width = renderer.domElement.clientWidth;
  const height = renderer.domElement.clientHeight;
  const nx = (clientX / width) * 2 - 1;
  const ny = -(clientY / height) * 2 + 1;
  camera.updateMatrixWorld();
  let best = null;
  let bestScore = 28;
  const blocker = pointerOcclusion(nx, ny);

  const consider = (key, world, radius, minPixels = 0, frameKey = null, local = null) => {
    renderOffset(tmpVector, world, frameKey, local);
    if (key !== blocker.key && tmpVector.distanceTo(camera.position) - radius > blocker.km) return;
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

  // Only from where each is drawn. From a megaparsec out the whole solar
  // system and every catalogue star sit on one pixel at the centre of the
  // screen, and a click on the galaxy behind them took you to Voyager.
  const fromSun = controls.worldPosition.distanceTo(universe.get('sun').position);
  const nearHome = fromSun < PC_KM;
  const inGalaxy = fromSun < 8000 * PC_KM;
  if (fromSun < 1000 * PC_KM) consider('sun', universe.get('sun').position, SUN.radiusKm);
  for (const [key, planet] of planets) {
    if (!planet.group.visible || !nearHome) continue;
    consider(key, universe.get(key).position, planet.radius, 0, key);
  }
  if (exoSystem) {
    consider(exoSystem.key, exoSystem.position, exoSystem.star.radius, 0, exoSystem.key);
    for (const item of exoSystem.planets) {
      if (item.world) consider(item.spec.key, item.world, item.spec.radiusKm, 0, item.spec.key);
    }
    for (const moon of exoSystem.moons) {
      if (moon.world) consider(moon.spec.key, moon.world, moon.spec.radiusKm, 0, moon.spec.key);
    }
  }
  const pxPerRad = height / (camera.fov * Math.PI / 180);
  for (const dest of destinations) {
    if (!PICKABLE_KINDS.has(dest.kind)) continue;
    // The thousands of catalogue galaxies, nebulae and clusters only once they
    // are drawn big enough to aim at; as specks they would catch every click
    // that missed something else.
    if (dest.quiet && dest.key !== state.target) {
      const resolved = resolveWorld(dest.key);
      if (!resolved) continue;
      const px = (resolved.radius / Math.max(resolved.position.distanceTo(controls.worldPosition), 1)) * pxPerRad;
      if (px < 5) continue;
      consider(dest.key, resolved.position, resolved.radius);
      continue;
    }
    // Invented systems carry no catalogue distance or magnitude, so the test
    // below let every one of them through: the eight stars of a galaxy ten
    // megaparsecs off, drawn nowhere, could be clicked from anywhere they
    // happened to project. What is drawn of them is a point, and pickDot has those.
    if (dest.kind === 'star' && (dest.generated || dest.system?.generated || dest.distPc === undefined) && dest.key !== state.target) continue;
    if (dest.kind === 'star' && dest.distPc > 30 && dest.mag > 1.5) continue;
    if (dest.kind === 'star' && !inGalaxy && dest.key !== state.target) continue;
    const resolved = resolveWorld(dest.key);
    if (resolved) consider(dest.key, resolved.position, resolved.radius);
  }
  // Only craft the renderer actually drew this frame, and with a pixel floor,
  // because a marker three pixels across has to be clickable at the size it is
  // drawn rather than at the size the spacecraft really is.
  for (const item of craftVisible) {
    if (item.state.position.distanceTo(controls.worldPosition) > PC_KM) continue;
    consider(
      craftDestKey(item.state.key),
      item.state.position,
      Math.max(item.state.spec.sizeM ?? 5, 2) / 2000,
      item.apparent > 3.5 ? 0 : 7,
      item.state.centreKey,
      item.state.local,
    );
  }
  // A body filling the view under the pointer is what was clicked, however
  // far its centre projects from it — unless it is the one already chosen,
  // where a click on its ground is not a request to fly to it again.
  if (!best && blocker.key && blocker.key !== state.target) {
    return { key: blocker.key, score: 0 };
  }
  return best ? { key: best, score: bestScore } : null;
}

/**
 * How near the pointer a point of light has to be to count as clicked, in
 * CSS pixels. A star is drawn a pixel or two across, and a finger is not that
 * accurate, so this is generous; the brighter of two nearby points wins.
 */
const DOT_PICK_PX = 11;
const tmpViewProjection = new Matrix4();

/**
 * The point of light under the pointer, whatever drew it.
 *
 * `pick` knows the things with names. Most of what is on screen has none:
 * the stars of the galaxy you are flying through, the brightest stars of one
 * seen from outside, the far galaxies of the field. Every one of those is a
 * place in this universe — a star unfolds into a planetary system when you
 * reach it, a far galaxy into a billboard, sprites and stars of its own — so
 * every one can be clicked, and what is clicked becomes a destination.
 *
 * Each source is tested the way it is drawn: a point only counts if its own
 * shader would actually put light on screen, so clicking black space does
 * nothing and a star too faint to see cannot be hit by accident.
 */
function pickDot(clientX, clientY) {
  const width = renderer.domElement.clientWidth;
  const height = renderer.domElement.clientHeight;
  camera.updateMatrixWorld();
  const e = tmpViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
  const cam = controls.worldPosition;
  let best = null;
  let bestScore = DOT_PICK_PX;
  const hidden = pointerOcclusion((clientX / width) * 2 - 1, -(clientY / height) * 2 + 1).km;
  const test = (x, y, z, bonus) => {
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (!(w > 0)) return false;
    if (hidden < Infinity && x * x + y * y + z * z > hidden * hidden) return false;
    const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * width;
    const sy = (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5) * height;
    const d = Math.hypot(sx - clientX, sy - clientY);
    if (d > DOT_PICK_PX) return false;
    const score = d - bonus;
    if (score >= bestScore) return false;
    bestScore = score;
    return true;
  };
  const limit = deepField.starMaterial.uniforms.limitMagnitude.value;
  const starBonus = (absMag, distKm) => {
    const rel = limit - (absMag + 5 * Math.log10(Math.max(distKm / PC_KM, 1e-8)) - 5);
    return rel < -0.8 ? null : clamp(rel, 0, 4);
  };

  // The stars generated for the galaxy the camera is in.
  if (cosmos.starPoints.visible) {
    const w = cosmos.world;
    for (let q = 0; q < cosmos.count; q++) {
      if (cosmos.absMag[q] > 90) continue;
      const x = w[q * 3] - cam.x;
      const y = w[q * 3 + 1] - cam.y;
      const z = w[q * 3 + 2] - cam.z;
      const bonus = starBonus(cosmos.absMag[q], Math.hypot(x, y, z));
      if (bonus === null || !test(x, y, z, bonus)) continue;
      best = {
        kind: 'gen',
        seed: cosmos.seeds[q],
        absMag: cosmos.absMag[q],
        world: new Vector3(w[q * 3], w[q * 3 + 1], w[q * 3 + 2]),
        galaxy: cosmos.active,
      };
    }
  }
  // The catalogue and Gaia, near home.
  if (deepField.stars.visible) {
    const w = deepField.world;
    for (let i = 0; i < deepField.count; i++) {
      const x = w[i * 3] - cam.x;
      const y = w[i * 3 + 1] - cam.y;
      const z = w[i * 3 + 2] - cam.z;
      const bonus = starBonus(deepField.absMag[i], Math.hypot(x, y, z));
      if (bonus === null || !test(x, y, z, bonus)) continue;
      best = { kind: 'hyg', index: i, absMag: deepField.absMag[i], bv: data.catalog.colorIndex[i], world: new Vector3(w[i * 3], w[i * 3 + 1], w[i * 3 + 2]) };
    }
  }
  if (gaia?.points.visible) {
    const p = gaia.position;
    for (let i = 0; i < gaia.count; i++) {
      if (gaia.absMag[i] > 90) continue;
      const x = p[i * 3] - cam.x;
      const y = p[i * 3 + 1] - cam.y;
      const z = p[i * 3 + 2] - cam.z;
      const bonus = starBonus(gaia.absMag[i], Math.hypot(x, y, z));
      if (bonus === null || !test(x, y, z, bonus)) continue;
      best = { kind: 'gaia', index: i, absMag: gaia.absMag[i], bv: gaia.bv[i], world: new Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) };
    }
  }
  // The brightest stars of a galaxy seen from outside it.
  cosmos.sprites.forEachStar(cam, (frame, index, x, y, z, shown, lum) => {
    if (!test(x, y, z, shown * 3)) return;
    best = {
      kind: 'gen',
      seed: (Math.imul(frame.seed ^ 0x51a75, 0x9e3779b1) + Math.imul(index + 1, 0x85ebca6b)) >>> 0,
      // Supergiants: these are the stars that show from a galaxy away.
      absMag: clamp(-3.5 - 2.5 * Math.log10(lum / 0.08), -9.5, -3.5),
      world: new Vector3(cam.x + x, cam.y + y, cam.z + z),
      galaxy: frame,
    };
  });
  // Generated galaxies: those near enough to have been made in full.
  const pxPerRad = height / (camera.fov * Math.PI / 180);
  for (const g of cosmos.galaxyList) {
    if (g.kind !== 'generated') continue;
    const x = g.center.x - cam.x;
    const y = g.center.y - cam.y;
    const z = g.center.z - cam.z;
    const px = (g.radiusKm / Math.max(Math.hypot(x, y, z), 1)) * pxPerRad;
    if (px < 0.5) continue;
    if (!test(x, y, z, Math.min(px, 30) * 0.35 + 1)) continue;
    best = { kind: 'galaxy', frame: g };
  }
  // And the field beyond them.
  cosmos.field.forEachPoint(cam, pxPerRad, (id, level, x, y, z, brightness, record) => {
    if (!test(x * MPC_KM, y * MPC_KM, z * MPC_KM, brightness * 2)) return;
    best = { kind: 'field', id, level, world: { x: cam.x / MPC_KM + x, y: cam.y / MPC_KM + y, z: cam.z / MPC_KM + z }, record };
  });
  return best ? { dot: best, score: bestScore } : null;
}

/** Makes a picked point of light a destination, and returns its key. */
function destinationForDot(dot) {
  if (dot.kind === 'galaxy' || dot.kind === 'field') {
    const g = dot.kind === 'field' ? cosmos.pinFieldGalaxy(dot.id, dot.level, dot.world, dot.record) : dot.frame;
    addLive({ key: g.key, name: g.name, kind: 'galaxy', group: 'Uncharted galaxies', cosmic: g });
    return g.key;
  }
  // A survey star that is a known planetary system is that system.
  const real = dot.kind === 'gen' ? null : nearestRealSystem(dot.world);
  return activateStar(real && real.distanceKm < 0.05 * PC_KM ? real : dot);
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
  const out = labelOffsets[labelOffsetsUsed] ?? (labelOffsets[labelOffsetsUsed] = new Vector3());
  if (!cameraFrame.relative(out, frameKey, local)) return null;
  labelOffsetsUsed++;
  return out;
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
      offset: labelOffset(exoSystem.position, exoSystem.key),
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
  // Stars, galaxies and holes are named only when their names are switched on,
  // the selection included: out in open space a name hanging in the sky over
  // the thing you flew to is in the way, and the inspector already says what
  // it is.
  for (const dest of destinations) {
    const selected = dest.key === targetKey;
    if (dest.quiet && !selected) {
      // Named once you are among them: a nebula you are inside, a cluster
      // next door, the galaxy you have just flown up to.
      if (dest.kind === 'galaxy' || !shown.galaxies) continue;
      const resolved = resolveWorld(dest.key);
      if (!resolved || resolved.position.distanceTo(controls.worldPosition) > resolved.radius * 40) continue;
      pushLabel({ key: dest.key, name: dest.name, position: resolved.position, radius: resolved.radius });
      continue;
    }
    if (dest.kind === 'star') {
      if (!shown.stars) continue;
      // Naked-eye stars and anything within ten parsecs; the rest are points
      // that a label would only obscure.
      if (!(dest.mag <= 2.2 || dest.distPc <= 10) && !selected) continue;
    } else if (dest.kind === 'galaxy') {
      if (!shown.galaxies) continue;
    } else if (dest.kind === 'black-hole' || dest.kind === 'neutron-star') {
      if (!shown.blackHoles) continue;
    } else if (dest.kind === 'nebula' || dest.kind === 'cluster') {
      if (!shown.galaxies) continue;
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
  floorBeforeControls(resolved, now);

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

  floorAfterControls(now, resolved);
  const cam = controls.worldPosition;
  updateCameraFrame();
  // Anything that took the camera out of roam — a flight, a mode button — has
  // also taken it off the ship.
  if (ship.active && controls.mode !== 'roam') {
    setShip(false);
    ui?.syncCamera?.();
  }
  updateNeighbourhood(now);
  ship.surfaceKm = roamSurfaceKm;
  ship.spaceKm = neighbourhood.spaceKm;
  const range = state.viewFromEarth
    ? 0.02
    : Math.max(Math.min(controls.altitudeKm, cameraGround.altitudeKm), 0.0005);
  // From onboard, the nearest thing is the craft's own structure a few metres
  // away, so the near plane has to come off the craft rather than off the
  // distance to a planet that may be an astronomical unit off.
  camera.near = rider
    ? Math.max(riderSizeKm * 0.01, 2e-7)
    : ship.active
      ? ship.view === 'cockpit' ? 3e-5 : 1.5e-3
      : clamp(range * 0.02, 0.0004, 1e8);
  // Out past the furthest catalogued galaxy, about ten gigaparsecs.
  camera.far = 1e24;
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
  sun.update({
    cameraLocal: tmpCameraLocal,
    time: now / 1000,
    distanceKm: sunDistance,
    pixelsPerRadian,
    // Sunlight where the camera is, at the exposure everything else is being
    // drawn at, which is what decides how a Sun too small to resolve is drawn.
    brightness: exposureScale / Math.max((sunDistance / 149597870.7) ** 2, 1e-6),
    // An ordinary star from far enough away: fifteenth magnitude from a
    // kiloparsec, where it had been a blazing point out to the edge of the
    // universe.
    visibility: pointVisibility(1, sunDistance, 8.7 + 2.5 * Math.log10(Math.max(58 / Math.max(camera.fov, 1e-4), 1))),
    // The glare is how a star looks to someone standing in its light, not a
    // marker for one being flown to.
    flare: !controls.flying,
  });
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
    considerRelease(key, apparentPixels);
    const isParent = key === parentKey;
    const hideEarth = state.viewFromEarth && key === 'earth';
    const visible = !hideEarth && (apparentPixels > 0.35 || key === state.target || isParent);
    planet.group.visible = visible;
    if (!visible) {
      if (!hideEarth && apparentPixels > 0.012 && apparentPixels < 3.5 && key !== 'sun') {
        const tint = planet.spec.atmosphere
          ? planet.spec.atmosphere.tint
          : [0.85, 0.82, 0.76];
        const au = bodyState.position.distanceTo(sunState.position) / 149597870.7;
        distantBodies.addReflected(planet.group.position, tint, {
          radiusKm: planet.radius,
          distanceKm: distance,
          flux: 1 / Math.max(au * au, 1e-9),
          albedo: Math.min(0.9, 0.35 * (planet.spec.albedoBoost ?? 1)),
          limit: 11.5 + 2.5 * Math.log10(Math.max(58 / Math.max(camera.fov, 1e-4), 1)),
        });
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
      groundKm: cameraGround.key === key ? cameraGround.km : 0,
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
    placeRelative(exoSystem.star.group, exoSystem.position, exoSystem.key);
    cameraLocalIn(exoSystem.position, exoSystem.key, tmpCameraLocal);
    const hostDist = tmpCameraLocal.length();
    // Exposure adapts to the orbit being visited, exactly as it does at home,
    // so a world taking hundreds of Earths' flux reads as a lit planet rather
    // than a white disc.
    const hostLum = exoSystem.luminositySol ?? 1;
    const exoReference = exoReferenceFlux(exoSystem, state.target, hostLum, cam);
    exoSystem.star.update({
      cameraLocal: tmpCameraLocal,
      time: now / 1000,
      distanceKm: hostDist,
      pixelsPerRadian,
      visibility: pointVisibility(hostLum, hostDist, 8.7 + 2.5 * Math.log10(Math.max(58 / Math.max(camera.fov, 1e-4), 1))),
      brightness: exoSunIntensity(
        exoFlux(hostLum, hostDist / 149597870.7),
        exoReference,
        state.exposure,
      ),
      flare: !controls.flying && state.target !== exoSystem.key,
    });
    // Always drawn. A host star seen from one of its own planets is the one
    // thing in that sky you cannot be without, and it is a point source out
    // past a few au, which is exactly where a size threshold would drop it.
    exoSystem.star.group.visible = true;
    const companion = exoSystem.companion;
    if (companion) {
      renderOffset(companion.star.group.position, companion.world, exoSystem.key, companion.local);
      tmpCameraLocal.copy(companion.star.group.position).negate();
      const d = tmpCameraLocal.length();
      companion.star.update({
        cameraLocal: tmpCameraLocal,
        time: now / 1000,
        distanceKm: d,
        pixelsPerRadian,
        visibility: pointVisibility(companion.luminositySol, d, 8.7 + 2.5 * Math.log10(Math.max(58 / Math.max(camera.fov, 1e-4), 1))),
        brightness: exoSunIntensity(exoFlux(companion.luminositySol, d / 149597870.7), exoReference, state.exposure),
        flare: !controls.flying,
      });
      companion.star.group.visible = true;
    }
    for (const item of exoSystem.planets) {
      const distance = cameraLocalIn(item.world, item.spec.key, tmpCameraLocal).length();
      const apparentPixels = (item.spec.radiusKm / distance) * pixelsPerRadian * 2;
      item.planet.group.visible = apparentPixels > 0.7;
      if (apparentPixels < 3) addExoDot(item, distance, hostLum, item.local.length());
      if (!item.planet.group.visible) continue;
      // Once, and only for a world close enough to be worth it: the waterline
      // has to be measured against this planet's own relief.
      if (item.spec.oceanFraction > 0 && !item.seaCalibrated && apparentPixels > 12) {
        item.seaCalibrated = true;
        item.planet.calibrateSeaLevel(renderer, item.spec.oceanFraction);
      }
      placeRelative(item.planet.group, item.world, item.spec.key);
      tmpSunLocal.copy(item.local).negate().normalize();
      tmpViewLocal.copy(tmpViewDir).normalize();
      const au = item.spec.orbitKm / 149597870.7;
      // As at home: close in, the patch under the camera has its centre well
      // outside the view cone however much of the screen it fills, and culling
      // by cone drops the ground you are standing on.
      const close = item.spec.radiusKm / distance > 0.04;
      patchTotal += item.planet.update({
        cameraLocal: tmpCameraLocal,
        sunLocal: tmpSunLocal.copy(tmpSunLocal),
        pixelsPerRadian,
        detailScale: quality.terrainDetail,
        patchScale: quality.patchScale,
        microDetail: quality.microDetail,
        sunColour,
        sunIntensity: exoSunIntensity(exoFlux(hostLum, au), exoReference, state.exposure),
        viewLocal: close ? null : tmpViewLocal,
        coneCos: close ? -1 : coneCos,
        groundKm: cameraGround.key === item.spec.key ? cameraGround.km : 0,
      });
      if (item.rings) {
        const u = item.rings.material.uniforms;
        u.uSunDir.value.copy(tmpSunLocal);
        u.uCameraLocal.value.copy(tmpCameraLocal);
        u.uSunIntensity.value = item.planet.material.uniforms.uSunIntensity.value;
        u.uPixelsPerRadian.value = pixelsPerRadian;
        item.rings.mesh.visible = state.showRings;
      }
    }
    for (const moon of exoSystem.moons) {
      if (!moon.world) continue;
      const distance = cameraLocalIn(moon.world, moon.spec.key, tmpCameraLocal).length();
      const apparentPixels = (moon.spec.radiusKm / distance) * pixelsPerRadian * 2;
      moon.planet.group.visible = apparentPixels > 0.7;
      if (apparentPixels < 3) addExoDot(moon, distance, hostLum, moon.local.length());
      if (!moon.planet.group.visible) continue;
      placeRelative(moon.planet.group, moon.world, moon.spec.key);
      tmpSunLocal.copy(moon.local).negate().normalize();
      const au = moon.local.length() / 149597870.7;
      patchTotal += moon.planet.update({
        cameraLocal: tmpCameraLocal,
        sunLocal: tmpSunLocal,
        pixelsPerRadian,
        detailScale: quality.terrainDetail,
        patchScale: quality.patchScale,
        microDetail: quality.microDetail,
        sunColour,
        sunIntensity: exoSunIntensity(exoFlux(hostLum, au), exoReference, state.exposure),
        viewLocal: moon.spec.radiusKm / distance > 0.04 ? null : tmpViewDir,
        coneCos: moon.spec.radiusKm / distance > 0.04 ? -1 : coneCos,
        groundKm: cameraGround.key === moon.spec.key ? cameraGround.km : 0,
      });
    }
  }
  distantBodies.end(renderer.getPixelRatio());
  if (!state.showDistantMarkers) distantBodies.object.visible = false;
  orbitLines.update({
    visible: state.showOrbits,
    universe,
    date: state.date,
    exoSystem,
    place: placeRelative,
    nearHome: cam.distanceTo(sunState.position) < 3e10,
  });

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
  //
  // A star whose system has loaded is drawn by the system, and the system's
  // star is the one that gets placed below. The cached sphere — built on the
  // way in, before the system existed — has to go dark then, or it is left
  // visible at its last offset and rides along with the camera.
  for (const [key, mesh] of starMeshes) {
    mesh.group.visible = key === resolved?.key && exoSystem?.key !== key;
  }

  if (resolved?.kind === 'star' && resolved.key !== 'sun') {
    const mesh = ensureStarMesh(resolved);
    if (mesh && exoSystem?.key !== resolved.key) {
      placeRelative(mesh.group, resolved.position);
      tmpCameraLocal.copy(cam).sub(resolved.position);
      mesh.update({
        cameraLocal: tmpCameraLocal,
        time: now / 1000,
        distanceKm: cam.distanceTo(resolved.position),
        pixelsPerRadian,
        flare: false,
      });
    }
  }

  // Seconds from J2000 on the simulation's clock, for what orbits the holes.
  const simSeconds = (state.date.getTime() - 946728000000) / 1000;
  for (const hole of blackHoles.values()) {
    placeRelative(hole.group, hole.world);
    tmpCameraLocal.copy(cam).sub(hole.world).applyQuaternion(tmpQuaternionInverse(hole.group.quaternion));
    hole.update({
      cameraLocal: tmpCameraLocal,
      time: now / 1000,
      simSeconds,
      visible: state.showBlackHoles,
      pixelsPerRadian,
      pixelRatio: renderer.getPixelRatio(),
      exposure: state.exposure,
    });
  }

  deepObjects.update({
    cameraWorld: cam,
    cameraQuaternion: camera.quaternion,
    place: placeRelative,
    time: now / 1000,
    pixelsPerRadian,
    pixelRatio: renderer.getPixelRatio(),
    exposure: state.exposure,
    steps: platform.mobile ? 28 : 44,
  });
  skyTint.set(skyLookFrom(cam));

  const viewingGalaxy = resolved?.kind === 'galaxy';
  const fromSun = sunDistance;
  const panoramaFade = 1 / (1 + (fromSun / PC_KM) * 6);
  // Under a lit sky the stars are there but drowned: the eye sets itself for
  // the daylight and they fall below it. Faded by the air the camera is in.
  const daylight = (resolved?.kind === 'body' && surfaceOf(resolved.key)?.planet.daylight) || 0;
  const starsLeft = clamp(1 - 1.12 * daylight, 0, 1);
  // Under a closed deck the sun's disc is gone too; its light still arrives,
  // diffused, through the sky shader.
  const groundPlanet = resolved?.kind === 'body' ? surfaceOf(resolved.key)?.planet : null;
  const decked = !!groundPlanet?.sky?.visible && (groundPlanet.skyUniforms?.uOvercast.value ?? 0) > 0.5
    && groundPlanet.material.uniforms.uOvercastSeen.value < 0.5;
  sun.group.visible = !decked;
  if (exoSystem) exoSystem.star.group.visible = !decked;
  milkyWay.mesh.visible = panoramaFade > 0.03 && starsLeft > 0.02;
  milkyWay.update({ exposure: 0.55, intensity: 0.5 * panoramaFade * starsLeft, atmosphere: null });

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
    gain: (viewingGalaxy
      ? 0.1
      : 0.05 / (1 + (targetRadius / Math.max(controls.distanceKm, 1)) * 10)) * starsLeft,
    focusGalaxyIndex: viewingGalaxy ? destByKey.get(state.target)?.galaxyIndex ?? -1 : -1,
    veil: starsLeft,
    viewPxPerRad: renderer.domElement.clientHeight
      / (2 * Math.tan((camera.fov * Math.PI) / 360)),
  });

  cosmos.update({
    cameraWorld: cam,
    pixelRatio: renderer.getPixelRatio(),
    pxPerRad: renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360)),
    sunDistanceKm: fromSun,
    cameraDistanceToSunKm: fromSun,
    // The invented field thins out at a third of this; it is filler, and the
    // catalogue's own galaxies are what should reach further.
    farKm: 1e22,
  });
  veilSky(starsLeft < 0.06);
  if (gaia) {
    gaia.points.visible = deepField.showStars && fromSun < 8000 * PC_KM && starsLeft > 0.3;
    // Brightest first, so a frame under strain sheds the faint tail, which is
    // most of the vertices and very little of the picture.
    gaia.points.geometry.setDrawRange(0, Math.round(gaia.count * clamp(quality.level ** 1.5, 0.3, 1)));
    gaia.update(cam);
  }
  if (ship.active) {
    const sunPos = universe.get('sun').position;
    const useExo = exoSystem && cam.distanceTo(exoSystem.position) < cam.distanceTo(sunPos);
    const lightPos = useExo ? exoSystem.position : sunPos;
    const lightKm = Math.max(cam.distanceTo(lightPos), 1);
    const lum = useExo ? exoSystem.luminositySol ?? 1 : 1;
    if (useExo) shipLightColour.setRGB(...colorIndexToLinearRgb(teffToBv(exoSystem.system.teff ?? SOLAR_TEFF), 1));
    else shipLightColour.setRGB(1, 0.98, 0.95);
    const peak = Math.max(shipLightColour.r, shipLightColour.g, shipLightColour.b, 1e-6);
    shipLightColour.multiplyScalar(1 / peak);
    ship.frame({
      starRel: tmpShipLight.copy(lightPos).sub(cam),
      starColour: shipLightColour,
      starFlux: Math.min(lum * (AU_KM / lightKm) ** 2 * 4, 1),
      time: now / 1000,
    });
  }

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

  // Standing on an airless world the ground is lit by a low sun and nothing
  // else, and a fixed exposure leaves it a murk. Open up, as a surface camera
  // does: the Apollo frames are exposed for the regolith, not for space.
  const standing = controls.mode === 'walk' || cameraGround.altitudeKm < 3;
  const airless = !surfaceOf(state.target)?.planet.atmosphereMaterial;
  const wanted = standing && airless ? 1.8 : 1;
  groundExposure += (wanted - groundExposure) * Math.min(1, dt * 2);
  renderer.toneMappingExposure = groundExposure;
  dither.advance();
  let holeDrawn = false;
  for (const hole of blackHoles.values()) {
    if (hole.group.visible && hole.mesh.visible) holeDrawn = true;
    hole.setBehind(behindTarget.texture);
  }
  holePass.enabled = holeDrawn;
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

const shipLightColour = new Color();
const tmpShipLight = new Vector3();

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
  cosmos,
  ship,
  setShip,
  neighbourhood,
  liveDests,
  get gaia() {
    return gaia;
  },
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
  sun,
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
  /** A click at canvas CSS coordinates, as the pointer gives it; returns the new target. */
  click(x, y) {
    controls.onClick(x, y);
    return state.target;
  },
  /** Goes there the way pressing a destination does, framing and all. */
  travel(key, { duration = 3200 } = {}) {
    selectTarget(key, { fly: true, duration });
    return state.target;
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
    const home = universe.get(key);
    const body = home ? home.position : resolveWorld(key).position;
    const star = home ? universe.get('sun').position : exoSystem.position;
    const toSun = new Vector3().subVectors(star, body).normalize();
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
  /** For checks that compare renders of the same surface tessellated differently. */
  setAntialias(enabled) {
    const samples = enabled && platform.antialias ? 4 : 0;
    for (const target of [composer.renderTarget1, composer.renderTarget2]) {
      if (target.samples === samples) continue;
      target.samples = samples;
      target.dispose();
    }
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
  /**
   * What the system panel would be given at `key`.
   *
   * On the surface because the panel's contents are now worked out for stars,
   * galaxies and black holes as well as for moons, and a check that reads the
   * rendered panel can only see the forty rows it draws and none of the keys
   * behind them — which is exactly where a system of names that resolve to
   * nothing would hide. See membersOf.
   */
  systemMembers(key) {
    return satellitesOf(key).map((member) => ({
      key: member.key,
      name: member.name,
      radiusKm: member.radiusKm,
      note: member.note ?? null,
    }));
  },
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
  // Handed the app's own surface so it can frame a subject and turn round it
  // instead of showing a still of one.
  home.ready(window.cosminova);
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

// The million Gaia stars are nine megabytes and a few hundred milliseconds of
// decoding, which the first view does not need: from Earth they are all past
// the naked-eye limit. So they come in once the scene is up. A phone keeps the
// brightest half; the file is sorted brightest first.
setTimeout(async () => {
  const catalog = await loadGaiaCatalog(`${(import.meta.env.BASE_URL ?? '/').replace(/\/$/, '')}/data`);
  if (!catalog) return;
  const t0 = performance.now();
  gaia = new GaiaField(catalog, {
    colorLookup,
    starMaterial: deepField.starMaterial,
    limit: platform.deviceClass === 'phone' ? 500000 : platform.deviceClass === 'tablet' ? 800000 : undefined,
  });
  gaia.points.visible = deepField.showStars;
  scene.add(gaia.points);
  window.cosminova.gaiaDecodeMs = performance.now() - t0;
}, 2500);
