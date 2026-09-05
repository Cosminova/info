import {
  Group,
  Matrix4,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import {
  DEG,
  RAD,
  compassPoint,
  equatorialToHorizontalMatrix,
  equatorialToVector,
  formatAngle,
  formatDec,
  formatRa,
  horizontalFromWorld,
  vectorToEquatorial,
} from './astro.js';
import { loadSkyData } from './data.js';
import { StarField } from './starfield.js';
import { createMilkyWay } from './milkyway.js';
import { DeepSkyLayer } from './dsos.js';
import { SolarSystemLayer } from './bodies.js';
import { ResolvedBodies } from './resolved.js';
import { Universe } from './engine/universe.js';
import { BodyTextures } from './engine/textures.js';
import { solarSystemAt } from './solar.js';
import { createAtmosphere } from './atmosphere.js';
import { SkyControls } from './controls.js';
import { LabelLayer, pickSky } from './labels.js';
import { createPostProcessing } from './postfx.js';
import {
  CARDINAL_POINTS,
  buildEclipticLine,
  buildEquatorialGrid,
  buildHorizonRing,
  buildHorizontalGrid,
  createGround,
  createHorizonGlow,
  createLineLayer,
} from './overlays.js';
import { colorIndexToSpectralHint } from './color.js';
import { createAmbient, sceneWeights } from './engine/ambient.js';
import { createSkyUI } from './ui/sky-ui.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const REFERENCE_FOV = 100;
const PARSEC_IN_LIGHTYEARS = 3.26156;
// One magnitude equals this many photographic stops.
const STOPS_PER_MAGNITUDE = 1.3287712;

const state = {
  mode: 'ground',
  latitude: 37.77,
  longitude: -122.42,
  date: new Date(),
  timeRate: 1,
  playing: true,
  exposureStops: 0,
  lightPollution: 0.05,
  milkyWayIntensity: 0.55,
  starSize: 2.5,
  showConstellations: true,
  showConstellationLabels: true,
  showBounds: false,
  showAsterisms: false,
  showStarNames: true,
  showDso: true,
  showDsoLabels: true,
  // Off by default: an open cluster's light is its member stars, which the
  // catalogue already draws. The ring is a chart convention, not a sight.
  showClusterMarkers: false,
  showGrid: false,
  showAzGrid: false,
  showEcliptic: false,
  showHorizon: true,
  showMilkyWay: true,
  showPlanets: true,
  showFaint: true,
  twinkle: true,
  bloom: true,
  spikes: false,
  selection: null,
};

// ---------------------------------------------------------------- boot

const canvas = $('sky');
const renderer = new WebGLRenderer({
  canvas,
  antialias: false,
  // The sky layers are depth-independent and would not care, but a resolved
  // planet is real terrain built out of adaptive patches, and over a depth range
  // running from the ground underfoot to a shell hundreds of units out an
  // ordinary depth buffer has too little precision to keep a patch and its own
  // skirt apart. That drew dark seams in a grid across every magnified disc.
  logarithmicDepthBuffer: true,
  powerPreference: 'high-performance',
  alpha: false,
});
renderer.setClearColor(0x000000, 1);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
// Every layer is additive and depth-independent with an explicit renderOrder,
// so three's own transparency sort would only cost time (and it demands
// bounding spheres for geometry that is positioned entirely in the shader).
renderer.sortObjects = false;

const gl = renderer.getContext();
const maxPointSize = Math.min(
  90,
  gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)?.[1] ?? 90,
);
const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

const scene = new Scene();
const camera = new PerspectiveCamera(75, 1, 0.02, 2000);

/** Everything expressed in equatorial coordinates lives under this container. */
const skyGroup = new Group();
skyGroup.matrixAutoUpdate = false;
scene.add(skyGroup);

const loadingFill = $('loading-fill');
const loadingStatus = $('loading-status');
let loadStep = 0;
const LOAD_STEPS = 5;
const progress = (label) => {
  loadStep += 1;
  loadingStatus.textContent = label;
  loadingFill.style.width = `${Math.round((loadStep / LOAD_STEPS) * 100)}%`;
};

const data = await loadSkyData({ maxTextureSize, onProgress: progress });
progress('building the sky');

// ---------------------------------------------------------------- layers

const starField = new StarField({
  catalog: data.catalog,
  maxPointSize,
  faintCount: 600000,
});
for (const object of starField.objects) skyGroup.add(object);

const milkyWay = createMilkyWay({
  texture: data.milkyWayTexture,
  longitudeSign: data.milkyWayMeta.longitudeSign ?? -1,
});
skyGroup.add(milkyWay.mesh);

const deepSky = new DeepSkyLayer(data.dsos);
skyGroup.add(deepSky.mesh);

const solarSystem = new SolarSystemLayer();
for (const object of solarSystem.objects) skyGroup.add(object);

// Zooming in far enough hands a planet over from a shaded sprite to the real
// terrain renderer. The manifest is small and the imagery itself is only fetched
// for bodies that actually get magnified, so this costs nothing until used.
const universe = new Universe();
const bodyTextures = new BodyTextures(
  await fetch('textures/bodies.json').then((r) => r.json()),
  { anisotropy: renderer.capabilities.getMaxAnisotropy() },
);
const resolved = new ResolvedBodies({ scene, universe, textures: bodyTextures });

const constellationLines = createLineLayer(data.constellationLines, {
  color: 0x6f9fd8,
  linewidth: 1.25,
  opacity: 0.34,
  renderOrder: 3,
});
const constellationBounds = createLineLayer(data.constellationBounds, {
  color: 0x4a6f96,
  linewidth: 1,
  opacity: 0,
  dashed: true,
  dashSize: 1.4,
  gapSize: 1.4,
  renderOrder: 2,
});
const asterismLines = createLineLayer(data.asterismLines, {
  color: 0x63c6b4,
  linewidth: 1.15,
  opacity: 0,
  renderOrder: 3,
});
const equatorialGrid = createLineLayer(buildEquatorialGrid(), {
  color: 0x39557a,
  linewidth: 1,
  opacity: 0,
  renderOrder: 1,
});
const eclipticLine = createLineLayer(buildEclipticLine(), {
  color: 0xc7a24f,
  linewidth: 1.1,
  opacity: 0,
  dashed: true,
  dashSize: 2.2,
  gapSize: 2.2,
  renderOrder: 2,
});
const skyLineLayers = [
  constellationLines,
  constellationBounds,
  asterismLines,
  equatorialGrid,
  eclipticLine,
];
for (const layer of skyLineLayers) {
  skyGroup.add(layer.object);
}

const horizontalGrid = createLineLayer(buildHorizontalGrid(), {
  color: 0x4f6a55,
  linewidth: 1,
  opacity: 0,
  renderOrder: 1,
});
const horizonRing = createLineLayer(buildHorizonRing(), {
  color: 0x8fb3d8,
  linewidth: 1.4,
  opacity: 0.4,
  renderOrder: 2,
  depthTest: false,
});
scene.add(horizontalGrid.object);
scene.add(horizonRing.object);

const ground = createGround();
const horizonGlow = createHorizonGlow();
const atmosphere = createAtmosphere();
scene.add(ground.mesh);
scene.add(horizonGlow.mesh);
scene.add(atmosphere.mesh);

const labelLayer = new LabelLayer($('labels'));
const controls = new SkyControls(camera, canvas, {
  fov: 78,
  pitch: 32,
  yaw: 160,
  // Seven arcseconds, or about three kilometres of lunar surface across the
  // frame: fifty thousand times the naked-eye field, and twice as deep as before.
  //
  // Not an arbitrary stop. Magnifying by narrowing the frustum, with the body on a
  // shell 380 units out, runs into single precision: below roughly this field the
  // terrain quads become smaller than the precision of coordinates measured from
  // 380 units away, every triangle collapses to zero area, and the screen goes
  // black. The limit is a ratio — the field of view itself — so it cannot be moved
  // by rescaling anything. Going deeper means travelling to the body instead of
  // magnifying it from here, which is what the solar system view does.
  minFov: 0.002,
  maxFov: 110,
  onInteract: () => hideSearchResults(),
});

const post = createPostProcessing(renderer, scene, camera);

// Lookup from catalogue index to its designation record, for click info.
const namedByIndex = new Map();
for (const entry of data.starNames) namedByIndex.set(entry.i, entry);

progress('ready');

// ---------------------------------------------------------------- search index

const searchIndex = [];
for (const entry of data.starNames) {
  const label = entry.n || entry.d || `HIP ${entry.hip}`;
  searchIndex.push({
    key: `${entry.n} ${entry.d} ${entry.conName} ${entry.hip}`.toLowerCase(),
    label,
    meta: [entry.n && entry.d ? entry.d : null, entry.conName].filter(Boolean).join(' · ') || 'star',
    note: `mag ${entry.mag.toFixed(1)}`,
    weight: entry.mag,
    kind: 'star',
    starIndex: entry.i,
  });
}
for (const c of data.constellationLabels) {
  searchIndex.push({
    key: `${c.name} ${c.id} ${c.genitive}`.toLowerCase(),
    label: c.name,
    meta: c.genitive ? `constellation · ${c.genitive}` : 'constellation',
    weight: -6 + c.rank,
    kind: 'constellation',
    position: new Vector3(c.p[0], c.p[1], c.p[2]),
    fov: 34,
  });
}
data.dsos.forEach((d, index) => {
  searchIndex.push({
    key: `${d.id} ${d.name}`.toLowerCase(),
    label: d.name ? `${d.id} — ${d.name}` : d.id,
    meta: d.cls.replace(/-/g, ' '),
    note: Number.isFinite(d.mag) ? `mag ${d.mag.toFixed(1)}` : '',
    // Messier objects are what people actually search for, so bias them up.
    weight: d.mag - (d.id.startsWith('M ') ? 6 : 0),
    kind: 'dso',
    dsoIndex: index,
  });
});
for (const name of ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']) {
  searchIndex.push({
    key: name.toLowerCase(),
    label: name,
    meta: 'solar system',
    weight: -30,
    kind: 'body',
    bodyKey: name.toLowerCase(),
  });
}

// ---------------------------------------------------------------- helpers

const skyMatrix = new Matrix4();
const vectorPool = [];
let poolCursor = 0;
const takeVector = () => {
  if (poolCursor >= vectorPool.length) vectorPool.push(new Vector3());
  return vectorPool[poolCursor++];
};

let ephemeris = solarSystemAt(state.date);

function currentLimitMagnitude(skyGlowMagnitudes) {
  const zoomGain = 0.62 * Math.log2(REFERENCE_FOV / controls.fov);
  const exposureGain = state.exposureStops / STOPS_PER_MAGNITUDE;
  return clamp(6.35 + zoomGain + exposureGain - skyGlowMagnitudes, -2, 17.5);
}

/** Extra sky glow from the Moon when it is up, in magnitudes. */
function moonGlow(moonAltitude, phase) {
  if (moonAltitude <= 0) return 0;
  const altitudeFactor = Math.sin(clamp(moonAltitude, 0, 90) * DEG);
  return 3.1 * Math.pow(phase, 1.6) * altitudeFactor;
}

function updateSkyOrientation() {
  if (state.mode === 'ground') {
    equatorialToHorizontalMatrix(state.latitude, state.longitude, state.date, skyMatrix);
  } else {
    skyMatrix.identity();
  }
  skyGroup.matrix.copy(skyMatrix);
  skyGroup.updateMatrixWorld(true);
}

function applyMode() {
  const ground3d = state.mode === 'ground';
  $('mode-label').textContent = ground3d ? 'from the ground' : 'free space';
  controls.minPitch = ground3d && state.showHorizon ? -32 : -89.5;
  for (const button of $('mode-toggle').querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.mode === state.mode);
  }
  updateVisibility();
}

function updateVisibility() {
  const ground3d = state.mode === 'ground';
  const horizon = ground3d && state.showHorizon;

  ground.mesh.visible = horizon;
  horizonGlow.mesh.visible = horizon;
  atmosphere.mesh.visible = ground3d;
  horizonRing.setOpacity(horizon ? 0.34 : 0);
  horizontalGrid.setOpacity(ground3d && state.showAzGrid ? 0.2 : 0);
  for (const layer of skyLineLayers) layer.setHorizonFade(horizon);

  constellationLines.setOpacity(state.showConstellations ? 0.34 : 0);
  constellationBounds.setOpacity(state.showBounds ? 0.3 : 0);
  asterismLines.setOpacity(state.showAsterisms ? 0.4 : 0);
  equatorialGrid.setOpacity(state.showGrid ? 0.22 : 0);
  eclipticLine.setOpacity(state.showEcliptic ? 0.5 : 0);

  milkyWay.mesh.visible = state.showMilkyWay;
  deepSky.mesh.visible = state.showDso;
  deepSky.setClusterMarkers(state.showClusterMarkers);
  solarSystem.setVisible(state.showPlanets);
  starField.setFaintVisible(state.showFaint);
  starField.setSpikes(state.spikes ? 0.075 : 0);
  post.setEnabled(state.bloom);
  starField.setStyle({ coreSize: state.starSize });
}

// ---------------------------------------------------------------- labels

function collectLabels(limitMagnitude, fov) {
  poolCursor = 0;
  const items = [];

  if (state.showPlanets) {
    for (const body of solarSystem.state) {
      const position = takeVector().copy(body._dir).applyMatrix4(skyMatrix);
      items.push({ position, text: body.name, kind: 'planet', priority: -20, offset: 11 });
    }
  }

  if (state.showStarNames) {
    // starNames is magnitude sorted, so we can stop as soon as it gets too faint.
    const nameLimit = Math.min(limitMagnitude - 0.8, fov > 40 ? 3.6 : fov > 12 ? 5.2 : 7.4);
    const bayerLimit = fov < 18 ? Math.min(limitMagnitude - 1.2, 5.6) : -99;
    for (const entry of data.starNames) {
      if (entry.mag > nameLimit && entry.mag > bayerLimit) break;
      const hasName = entry.n && entry.mag <= nameLimit;
      const text = hasName ? entry.n : entry.d;
      if (!text) continue;
      if (!hasName && entry.mag > bayerLimit) continue;
      const i = entry.i;
      const position = takeVector()
        .set(
          data.catalog.position[i * 3],
          data.catalog.position[i * 3 + 1],
          data.catalog.position[i * 3 + 2],
        )
        .applyMatrix4(skyMatrix);
      items.push({
        position,
        text,
        kind: hasName ? (entry.mag < 3 ? 'star' : 'star-dim') : 'bayer',
        priority: entry.mag + (hasName ? 0 : 4),
      });
    }
  }

  if (state.showConstellationLabels && fov > 9) {
    for (const c of data.constellationLabels) {
      const position = takeVector().set(c.p[0], c.p[1], c.p[2]).applyMatrix4(skyMatrix);
      items.push({
        position,
        text: c.name,
        kind: 'constellation',
        priority: 40 + c.rank,
        offset: 0,
      });
    }
  }

  if (state.showAsterisms && fov > 6) {
    for (const a of data.asterismLabels) {
      const position = takeVector().set(a.p[0], a.p[1], a.p[2]).applyMatrix4(skyMatrix);
      items.push({ position, text: a.name, kind: 'asterism', priority: 55, offset: 0 });
    }
  }

  if (state.showDso && state.showDsoLabels && fov < 42) {
    const cap = Math.min(deepSky.visibleCount ?? 0, fov < 3 ? 320 : 90);
    for (let i = 0; i < cap; i++) {
      const record = deepSky.records[i];
      const position = takeVector().copy(deepSky.positions[i]).applyMatrix4(skyMatrix);
      items.push({
        position,
        text: record.name || record.id,
        kind: 'dso',
        priority: 25 + record.mag,
      });
    }
  }

  if (state.mode === 'ground' && state.showHorizon) {
    for (const cardinal of CARDINAL_POINTS) {
      items.push({
        position: takeVector().copy(cardinal.position).normalize(),
        text: cardinal.label,
        kind: 'cardinal',
        priority: -30,
        offset: 0,
      });
    }
  }

  // Anything below the horizon is behind the ground, so its label would float
  // over the landscape. Cardinal points sit exactly on the horizon and stay.
  if (state.mode === 'ground' && state.showHorizon) {
    return items.filter((item) => item.kind === 'cardinal' || item.position.y > -0.01);
  }
  return items;
}

// ---------------------------------------------------------------- selection

/**
 * Where a selected object is now, in world space.
 *
 * Re-read every frame rather than stored, because both terms move: the sky turns,
 * and a planet also moves against it. Storing the direction at the moment of
 * selection is accurate for about a second at a telescopic field.
 */
function selectionLocal(selection) {
  if (!selection) return null;
  if (selection.kind === 'body') {
    const body = ephemeris.bodies.find((b) => b.key === selection.key);
    if (body) return equatorialToVector(body.ra, body.dec, new Vector3());
  }
  return selection.position.clone();
}

function selectionDirection(selection) {
  const local = selectionLocal(selection);
  return local ? local.applyMatrix4(skyMatrix).normalize() : null;
}

/**
 * The class badge for a selection.
 *
 * The colours are the shared `k-*` set, so a galaxy is the same violet here as
 * in the explorer. Deep sky objects carry their own catalogue class, which is
 * more use than the word "deep sky" — the difference between a globular cluster
 * and a planetary nebula is most of what you want to know about a smudge.
 */
function selectionBadge(selection) {
  if (selection.kind === 'star') return { label: 'star', cls: 'k-star' };
  if (selection.kind === 'body') {
    const moon = selection.title === 'Moon';
    return { label: moon ? 'moon' : 'solar system', cls: moon ? 'k-moon' : 'k-planet' };
  }
  const cls = (selection.dsoClass ?? '').toLowerCase();
  if (cls.includes('galaxy')) return { label: 'galaxy', cls: 'k-galaxy' };
  if (cls.includes('nebula')) return { label: cls, cls: 'k-nebula' };
  if (cls.includes('cluster')) return { label: cls, cls: 'k-cluster' };
  return { label: cls || 'deep sky', cls: 'k-system' };
}

function showSelection(selection) {
  state.selection = selection;
  // Selecting something points the view at it and keeps it there, which is the
  // whole difference between being able to look at a planet and not. Zoom is left
  // alone: the wheel is a better judge of how close you want to be than any
  // guess made here, and it now stays pointed at the target while you use it.
  controls.follow(selection ? () => selectionDirection(state.selection) : null);
  if (selection) {
    controls.flyTo({ direction: selectionDirection(selection), duration: 650 });
  }

  const panel = $('selection');
  if (!selection) {
    panel.hidden = true;
    $('reticle').hidden = true;
    return;
  }
  panel.hidden = false;
  $('selection-title').textContent = selection.title;

  // Class badge then the designation, the same way the explorer presents an
  // object: what kind of thing it is should be readable before the name is.
  const subtitle = $('selection-subtitle');
  subtitle.replaceChildren();
  const { label, cls } = selectionBadge(selection);
  const badge = document.createElement('span');
  badge.className = `badge ${cls}`;
  badge.textContent = label;
  subtitle.append(badge);
  if (selection.subtitle) {
    subtitle.append(document.createTextNode(selection.subtitle));
  }

  const dl = $('selection-facts');
  dl.innerHTML = '';
  for (const [key, value] of selection.facts) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }
}

function starSelection(index) {
  const named = namedByIndex.get(index);
  const position = new Vector3(
    data.catalog.position[index * 3],
    data.catalog.position[index * 3 + 1],
    data.catalog.position[index * 3 + 2],
  );
  const { ra, dec } = vectorToEquatorial(position);
  const magnitude = data.catalog.magnitude[index];
  const colorIndex = data.catalog.colorIndex[index];
  const distance = data.catalog.distanceParsec[index];

  const facts = [
    ['Magnitude', magnitude.toFixed(2)],
    ['Colour index', `B−V ${colorIndex.toFixed(2)}`],
    ['Spectral', named?.spect || `~${colorIndexToSpectralHint(colorIndex)}`],
    ['Right ascension', formatRa(ra)],
    ['Declination', formatDec(dec)],
  ];
  if (distance > 0) {
    facts.push(['Distance', `${(distance * PARSEC_IN_LIGHTYEARS).toFixed(1)} ly`]);
  }
  if (named?.absmag !== null && named?.absmag !== undefined) {
    facts.push(['Absolute mag', named.absmag.toFixed(2)]);
  }
  if (named?.lum) {
    facts.push(['Luminosity', `${named.lum < 100 ? named.lum.toFixed(2) : Math.round(named.lum)} L☉`]);
  }

  return {
    kind: 'star',
    title: named?.n || named?.d || `HIP ${named?.hip ?? index}`,
    subtitle: [named?.d && named?.n ? named.d : '', named?.conName]
      .filter(Boolean)
      .join('  ·  '),
    facts,
    position,
    fov: 2.5,
  };
}

function dsoSelection(index) {
  const record = deepSky.records[index];
  const { ra, dec } = vectorToEquatorial(deepSky.positions[index]);
  const majorArcmin = (record.rMaj * 2 * RAD * 60).toFixed(1);
  const minorArcmin = (record.rMin * 2 * RAD * 60).toFixed(1);
  return {
    kind: 'dso',
    dsoClass: record.cls.replace(/-/g, ' '),
    title: record.name || record.id,
    // The class is on the badge, so the line beside it carries the catalogue
    // designation rather than repeating it.
    subtitle: record.name ? record.id : '',
    facts: [
      ['Magnitude', record.mag.toFixed(2)],
      ['Apparent size', `${majorArcmin}′ × ${minorArcmin}′`],
      ...(record.morph ? [['Morphology', record.morph]] : []),
      ['Right ascension', formatRa(ra)],
      ['Declination', formatDec(dec)],
    ],
    position: deepSky.positions[index].clone(),
    fov: clamp(record.rMaj * RAD * 8, 0.15, 8),
  };
}

function bodySelection(key) {
  const body = ephemeris.bodies.find((b) => b.key === key);
  if (!body) return null;
  const position = equatorialToVector(body.ra, body.dec, new Vector3());
  const diameterArcmin = body.angularRadius * 2 * RAD * 60;
  const facts = [
    ['Magnitude', body.magnitude.toFixed(2)],
    [
      'Distance',
      body.key === 'moon'
        ? `${Math.round(body.distanceAu * 149597870.7).toLocaleString()} km`
        : `${body.distanceAu.toFixed(4)} AU`,
    ],
    [
      'Apparent size',
      diameterArcmin >= 1
        ? `${diameterArcmin.toFixed(2)}′`
        : `${(diameterArcmin * 60).toFixed(1)}″`,
    ],
    ['Illuminated', `${(body.phase * 100).toFixed(1)}%`],
    ['Right ascension', formatRa(body.ra)],
    ['Declination', formatDec(body.dec)],
  ];
  if (body.elongation !== undefined) {
    facts.push(['Elongation', `${body.elongation.toFixed(1)}°`]);
  }
  return {
    kind: 'body',
    key: body.key,
    title: body.name,
    subtitle: body.kind === 'planet' ? 'planet' : body.kind,
    facts,
    position,
    // Four disc diameters across the frame, which is about how an eyepiece
    // presents a planet: large enough to see the markings, with enough space
    // around it for the rings and the nearer moons. The old floor of a twelfth of
    // a degree left Saturn as a speck in the middle of the frame.
    fov: clamp(body.angularRadius * 2 * RAD * 4, 0.002, 6),
  };
}

canvas.addEventListener('click', (event) => {
  if (controls._dragMoved > 6) return;
  const direction = controls.screenToDirection(event.clientX, event.clientY);
  const tolerance = Math.max(controls.radiansPerPixel(canvas.clientHeight) * 14, 0.0004);

  // Solar system bodies first: they are few and usually the intended target.
  let bodyHit = null;
  for (const body of solarSystem.state) {
    const world = body._dir.clone().applyMatrix4(skyMatrix);
    const separation = world.angleTo(direction);
    const reach = Math.max(tolerance, body.angularRadius * 1.6);
    if (separation < reach && (!bodyHit || separation < bodyHit.separation)) {
      bodyHit = { body, separation };
    }
  }
  if (bodyHit) {
    showSelection(bodySelection(bodyHit.body.key));
    return;
  }

  const hit = pickSky({
    direction,
    toleranceRadians: tolerance,
    starPositions: data.catalog.position,
    starMagnitudes: data.catalog.magnitude,
    starCount: starField.catalogPoints.geometry.drawRange.count,
    namedByIndex,
    dsoLayer: state.showDso ? deepSky : null,
    dsoVisibleCount: deepSky.visibleCount ?? 0,
    skyMatrix,
  });

  if (!hit) {
    showSelection(null);
    return;
  }
  showSelection(hit.type === 'star' ? starSelection(hit.index) : dsoSelection(hit.index));
});

$('selection-close').addEventListener('click', () => showSelection(null));
$('selection-goto').addEventListener('click', () => {
  if (!state.selection) return;
  goToLocalDirection(state.selection.position, state.selection.fov);
});

function goToLocalDirection(localDirection, fov) {
  const world = localDirection.clone().applyMatrix4(skyMatrix).normalize();
  controls.flyTo({ direction: world, fov, duration: 1500 });
  // Things with no selection panel — a constellation, a coordinate — are held
  // too, so a deep field does not drift off them either. Anything that does have
  // a selection is already being tracked by its live position, which for a planet
  // is better than the fixed direction passed in here.
  if (!state.selection) {
    const fixed = localDirection.clone();
    controls.follow(() => fixed.clone().applyMatrix4(skyMatrix).normalize());
  }
}

// ---------------------------------------------------------------- search ui

const searchInput = $('search-input');
const searchResults = $('search-results');
let searchMatches = [];
let searchCursor = -1;

function hideSearchResults() {
  searchResults.hidden = true;
  searchCursor = -1;
}

function runSearch(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) {
    hideSearchResults();
    return;
  }
  const scored = [];
  for (const item of searchIndex) {
    const at = item.key.indexOf(q);
    if (at < 0) continue;
    // Prefix matches rank above interior matches; brighter objects win ties.
    scored.push({ item, score: at * 4 + item.weight });
    if (scored.length > 2200) break;
  }
  scored.sort((a, b) => a.score - b.score);
  searchMatches = scored.slice(0, 12).map((s) => s.item);

  searchResults.innerHTML = '';
  for (const [index, match] of searchMatches.entries()) {
    // Same row structure as the explorer's results — name, a line of context,
    // and a right-aligned figure — so a search looks and reads the same in both
    // views. Here the figure is apparent magnitude, which is the one number that
    // tells you whether you will actually be able to see the thing.
    const li = document.createElement('li');
    li.className = 'search-row';
    li.dataset.index = String(index);
    const name = document.createElement('span');
    name.className = 'r-name';
    name.append(Object.assign(document.createElement('span'), { textContent: match.label }));
    const meta = document.createElement('span');
    meta.className = 'r-meta';
    meta.textContent = match.meta;
    const note = document.createElement('span');
    note.className = 'r-dist';
    note.textContent = match.note ?? '';
    li.append(name, meta, note);
    li.addEventListener('mousedown', (event) => {
      event.preventDefault();
      selectSearchMatch(index);
    });
    searchResults.append(li);
  }
  searchResults.hidden = searchMatches.length === 0;
}

function selectSearchMatch(index) {
  const match = searchMatches[index];
  if (!match) return;
  hideSearchResults();
  searchInput.blur();

  if (match.kind === 'star') {
    const selection = starSelection(match.starIndex);
    showSelection(selection);
    goToLocalDirection(selection.position, selection.fov);
  } else if (match.kind === 'dso') {
    const selection = dsoSelection(match.dsoIndex);
    showSelection(selection);
    goToLocalDirection(selection.position, selection.fov);
  } else if (match.kind === 'body') {
    const selection = bodySelection(match.bodyKey);
    if (selection) {
      showSelection(selection);
      goToLocalDirection(selection.position, selection.fov);
    }
  } else if (match.kind === 'constellation') {
    showSelection(null);
    goToLocalDirection(match.position, match.fov);
  }
}

searchInput.addEventListener('input', () => runSearch(searchInput.value));
searchInput.addEventListener('keydown', (event) => {
  if (searchResults.hidden) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    searchCursor = (searchCursor + delta + searchMatches.length) % searchMatches.length;
    for (const li of searchResults.children) {
      li.classList.toggle('is-cursor', Number(li.dataset.index) === searchCursor);
    }
  } else if (event.key === 'Enter') {
    event.preventDefault();
    selectSearchMatch(searchCursor >= 0 ? searchCursor : 0);
  } else if (event.key === 'Escape') {
    hideSearchResults();
  }
});

// ---------------------------------------------------------------- panel ui

/*
 * The shell — navigation rail, panel collapsing, immersive mode, the rebindable
 * shortcut table and the appearance settings — is built in ui/sky-ui.js. It works
 * on the same elements this file does rather than owning them, so there is one
 * handler per control; where both need to know about a change, they say so
 * explicitly (the rail watches the options button below; showSelection tells the
 * shell when it opens the selection panel).
 */
const ui = createSkyUI({
  controls,
  state,
  setRate: (rate) => setRate(rate),
  getRate: () => state.timeRate,
  onModeChange: (mode) => {
    state.mode = mode;
    applyMode();
  },
});

$('btn-panel').addEventListener('click', () => {
  $('panel').hidden = !$('panel').hidden;
});
$('btn-help').addEventListener('click', () => {
  $('help').hidden = !$('help').hidden;
});
$('help-close').addEventListener('click', () => {
  $('help').hidden = true;
});
$('help').addEventListener('click', (event) => {
  if (event.target === $('help')) $('help').hidden = true;
});

for (const button of $('mode-toggle').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    state.mode = button.dataset.mode;
    applyMode();
  });
}

const checkboxBindings = {
  'opt-constellations': 'showConstellations',
  'opt-conlabels': 'showConstellationLabels',
  'opt-bounds': 'showBounds',
  'opt-asterisms': 'showAsterisms',
  'opt-starnames': 'showStarNames',
  'opt-dso': 'showDso',
  'opt-dsolabels': 'showDsoLabels',
  'opt-clusters': 'showClusterMarkers',
  'opt-grid': 'showGrid',
  'opt-azgrid': 'showAzGrid',
  'opt-ecliptic': 'showEcliptic',
  'opt-horizon': 'showHorizon',
  'opt-milkyway': 'showMilkyWay',
  'opt-planets': 'showPlanets',
  'opt-faint': 'showFaint',
  'opt-twinkle': 'twinkle',
  'opt-bloom': 'bloom',
  'opt-spikes': 'spikes',
};
for (const [id, key] of Object.entries(checkboxBindings)) {
  const input = $(id);
  input.checked = state[key];
  input.addEventListener('change', () => {
    state[key] = input.checked;
    if (key === 'showHorizon') applyMode();
    else updateVisibility();
  });
}

const ambient = createAmbient();
$('opt-music').addEventListener('change', (event) => {
  ambient.setMuted(!event.target.checked);
});
const armMusic = () => {
  ambient.start();
  window.removeEventListener('pointerdown', armMusic);
  window.removeEventListener('keydown', armMusic);
};
window.addEventListener('pointerdown', armMusic, { once: true });
window.addEventListener('keydown', armMusic, { once: true });

$('opt-exposure').addEventListener('input', (event) => {
  state.exposureStops = Number(event.target.value);
  $('val-exposure').textContent = state.exposureStops.toFixed(1);
});
$('opt-mwintensity').addEventListener('input', (event) => {
  state.milkyWayIntensity = Number(event.target.value);
  $('val-milkyway').textContent = state.milkyWayIntensity.toFixed(2);
});
$('opt-pollution').addEventListener('input', (event) => {
  state.lightPollution = Number(event.target.value);
  $('val-pollution').textContent = state.lightPollution.toFixed(2);
});
$('opt-starsize').addEventListener('input', (event) => {
  state.starSize = Number(event.target.value);
  $('val-starsize').textContent = state.starSize.toFixed(1);
  starField.setStyle({ coreSize: state.starSize });
});

$('latitude').addEventListener('change', (event) => {
  state.latitude = clamp(Number(event.target.value) || 0, -90, 90);
});
$('longitude').addEventListener('change', (event) => {
  state.longitude = clamp(Number(event.target.value) || 0, -180, 180);
});
$('btn-locate').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((pos) => {
    state.latitude = pos.coords.latitude;
    state.longitude = pos.coords.longitude;
    $('latitude').value = state.latitude.toFixed(2);
    $('longitude').value = state.longitude.toFixed(2);
  });
});

// ---------------------------------------------------------------- time ui

const timeInput = $('time-input');
let timeInputFocused = false;
timeInput.addEventListener('focus', () => {
  timeInputFocused = true;
});
timeInput.addEventListener('blur', () => {
  timeInputFocused = false;
});
timeInput.addEventListener('change', () => {
  const parsed = new Date(timeInput.value);
  if (!Number.isNaN(parsed.getTime())) state.date = parsed;
});

function formatRate(rate) {
  if (rate === 0) return 'paused';
  const absolute = Math.abs(rate);
  const sign = rate < 0 ? '−' : '';
  if (absolute === 1) return 'realtime';
  if (absolute < 60) return `${sign}${absolute}×`;
  if (absolute < 3600) return `${sign}${(absolute / 60).toFixed(0)} min/s`;
  if (absolute < 86400) return `${sign}${(absolute / 3600).toFixed(1)} h/s`;
  return `${sign}${(absolute / 86400).toFixed(1)} d/s`;
}

function setRate(rate) {
  state.timeRate = rate;
  state.playing = rate !== 0;
  $('rate-label').textContent = formatRate(rate);
  $('btn-play').textContent = state.playing ? '▮▮' : '▶';
}

for (const button of document.querySelectorAll('[data-rate]')) {
  button.addEventListener('click', () => {
    const step = Number(button.dataset.rate);
    // Repeated presses accelerate in the chosen direction.
    const next =
      Math.sign(step) === Math.sign(state.timeRate) && state.timeRate !== 0
        ? state.timeRate * 6
        : step;
    setRate(clamp(next, -2592000, 2592000));
  });
}
$('btn-play').addEventListener('click', () => setRate(state.playing ? 0 : 1));
$('btn-now').addEventListener('click', () => {
  state.date = new Date();
  setRate(1);
});
setRate(1);

// ---------------------------------------------------------------- zoom ui

const zoomSlider = $('zoom-slider');
const fovToSlider = (fov) =>
  (Math.log(controls.maxFov / fov) / Math.log(controls.maxFov / controls.minFov)) * 1000;
const sliderToFov = (value) =>
  controls.maxFov * Math.pow(controls.minFov / controls.maxFov, value / 1000);

zoomSlider.value = String(fovToSlider(controls.fov));
zoomSlider.addEventListener('input', () => {
  controls.setFov(sliderToFov(Number(zoomSlider.value)));
});
$('btn-zoom-in').addEventListener('click', () => controls.zoomBy(-0.45));
$('btn-zoom-out').addEventListener('click', () => controls.zoomBy(0.45));

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  switch (event.key) {
    case '+':
    case '=':
      controls.zoomBy(-0.4);
      break;
    case '-':
    case '_':
      controls.zoomBy(0.4);
      break;
    case 'ArrowLeft':
      controls.yaw += controls.fov * 0.08;
      break;
    case 'ArrowRight':
      controls.yaw -= controls.fov * 0.08;
      break;
    case 'ArrowUp':
      controls.pitch = clamp(controls.pitch + controls.fov * 0.08, controls.minPitch, controls.maxPitch);
      break;
    case 'ArrowDown':
      controls.pitch = clamp(controls.pitch - controls.fov * 0.08, controls.minPitch, controls.maxPitch);
      break;
    case ' ':
      event.preventDefault();
      setRate(state.playing ? 0 : 1);
      break;
    case 'g':
    case 'G':
      state.mode = 'ground';
      applyMode();
      break;
    case 'f':
    case 'F':
      state.mode = 'space';
      applyMode();
      break;
    case 'c':
    case 'C':
      state.showConstellations = !state.showConstellations;
      $('opt-constellations').checked = state.showConstellations;
      updateVisibility();
      break;
    case 'r':
    case 'R':
      controls.flyTo({ yaw: 160, pitch: 32, fov: 78, duration: 900 });
      showSelection(null);
      break;
    case 'z':
    case 'Z':
      // Frame whatever is selected at a sensible size for what it is.
      if (state.selection) {
        goToLocalDirection(selectionLocal(state.selection), state.selection.fov);
      }
      break;
    case 't':
    case 'T':
      // Tracking is on whenever something is selected, so this is the way to let
      // the sky drift past — worth having, since sidereal drift at a telescopic
      // field is a real thing to watch rather than only a nuisance.
      controls.follow(
        controls.isFollowing ? null : () => selectionDirection(state.selection),
      );
      break;
    case '?':
      $('help').hidden = !$('help').hidden;
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------- resize

function resize() {
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  post.setSize(width, height);
  const ratio = renderer.getPixelRatio();
  for (const layer of [
    constellationLines,
    constellationBounds,
    asterismLines,
    equatorialGrid,
    eclipticLine,
    horizontalGrid,
    horizonRing,
  ]) {
    layer.setResolution(width * ratio, height * ratio);
  }
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- loop

const readout = {
  ra: $('out-ra'),
  dec: $('out-dec'),
  alt: $('out-alt'),
  az: $('out-az'),
  fov: $('out-fov'),
  limit: $('out-limit'),
  count: $('out-count'),
  fps: $('out-fps'),
};

const sunDirectionWorld = new Vector3();
const inverseSky = new Matrix4();
const viewForward = new Vector3();
let previousTime = performance.now();
let smoothedFps = 60;
let hudAccumulator = 0;
let elapsed = 0;
let lastLimitMagnitude = 6.35;
let lastSkyGlow = 0;

applyMode();
updateVisibility();

// Safety net: anything still lacking bounds would throw the moment a future
// change re-enables sorting, and the failure mode is a blank screen.
scene.traverse((object) => {
  const geometry = object.geometry;
  if (!geometry) return;
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  if (geometry.boundingSphere === null) {
    console.warn(`no bounding sphere for ${object.name || object.type}`);
  }
});

let frameErrorLogged = false;

function frame(now) {
  try {
    renderFrame(now);
  } catch (error) {
    // Never let one bad frame kill the animation loop and freeze the app.
    if (!frameErrorLogged) {
      frameErrorLogged = true;
      console.error('frame failed', error);
    }
  }
  requestAnimationFrame(frame);
}

function renderFrame(now) {
  const dt = Math.min(0.1, (now - previousTime) / 1000);
  previousTime = now;
  elapsed += dt;

  if (state.playing) {
    state.date = new Date(state.date.getTime() + dt * state.timeRate * 1000);
  }

  ambient.updateScene(
    sceneWeights({
      viewFromEarth: true,
      kind: 'body',
      key: 'earth',
      distanceRadii: 1.02,
      fromSunKm: 1.496e8,
      earthDistanceKm: 6372,
    }),
  );

  updateSkyOrientation();
  ephemeris = solarSystemAt(state.date);

  controls.update(dt);
  camera.updateMatrixWorld(true);

  const height = canvas.clientHeight || window.innerHeight;
  const radPerPixel = controls.radiansPerPixel(height);
  const linearExposure = Math.pow(2, state.exposureStops);

  // Sky brightness: twilight from the atmosphere, plus moonlight and any
  // configured light pollution. All three eat into the limiting magnitude.
  let skyGlow = 0;
  const sunBody = ephemeris.sun;
  sunDirectionWorld.copy(
    equatorialToVector(sunBody.ra, sunBody.dec, new Vector3()),
  ).applyMatrix4(skyMatrix);
  const sunAltitude = state.mode === 'ground' ? Math.asin(clamp(sunDirectionWorld.y, -1, 1)) * RAD : -90;

  if (state.mode === 'ground') {
    skyGlow += atmosphere.update({
      sunDirection: sunDirectionWorld.clone().normalize(),
      sunAltitude,
      exposure: linearExposure,
      airglow: 0.03 + state.lightPollution * 0.9,
      turbidity: 1 + state.lightPollution * 1.6,
    });
    const moonWorld = equatorialToVector(ephemeris.moon.ra, ephemeris.moon.dec, new Vector3())
      .applyMatrix4(skyMatrix);
    const moonAltitude = Math.asin(clamp(moonWorld.y, -1, 1)) * RAD;
    skyGlow += moonGlow(moonAltitude, ephemeris.moon.phase);
    skyGlow += state.lightPollution * 4.2;
    horizonGlow.material.uniforms.strength.value = 0.06 + state.lightPollution * 0.9;
  }

  const limitMagnitude = currentLimitMagnitude(skyGlow);
  lastLimitMagnitude = limitMagnitude;
  lastSkyGlow = skyGlow;
  const atmosphereState =
    state.mode === 'ground'
      ? { extinction: 0.21 + state.lightPollution * 0.1, twinkle: state.twinkle ? 0.55 : 0 }
      : null;

  starField.update({
    limitMagnitude,
    exposure: 1,
    pixelRatio: renderer.getPixelRatio(),
    time: elapsed,
    atmosphere: atmosphereState,
  });
  // The panorama is a 4K image spanning the whole sky, so deep zoom magnifies
  // it well past its real resolution. Fading it down as the field narrows hands
  // the diffuse glow over to the resolved faint stars, which is also what
  // actually happens when you point a telescope at the Milky Way.
  const milkyWayZoomFade = smoothstep(9, 38, controls.fov);
  milkyWay.update({
    exposure: linearExposure,
    intensity: state.milkyWayIntensity * milkyWayZoomFade,
    atmosphere: atmosphereState,
  });
  // Extended objects are referenced to the unzoomed depth so their surface
  // brightness responds to exposure and sky glow but not to magnification.
  const surfaceRefMagnitude = 6.35 + state.exposureStops / STOPS_PER_MAGNITUDE - skyGlow;

  deepSky.update({
    limitMagnitude,
    surfaceRefMagnitude,
    radPerPixel,
    fovDegrees: controls.fov,
    horizonCut: state.mode === 'ground' && state.showHorizon,
  });
  if (state.showPlanets) {
    // Bodies large enough to render properly are taken over by the terrain
    // renderer, and the sprite that stood in for them is suppressed so the two
    // are never drawn on top of each other.
    universe.update(state.date);
    // Half the screen diagonal: at a telescopic field that is a small fraction of
    // a planet, and the terrain layer uses it to refine only what is on screen.
    const halfV = camera.fov * (Math.PI / 360);
    const resolvedKeys = resolved.update({
      ephemeris,
      skyMatrix,
      pixelsPerRadian: 1 / radPerPixel,
      exposure: linearExposure,
      viewWorld: camera.getWorldDirection(viewForward),
      viewConeRadians: Math.atan(Math.hypot(1, camera.aspect) * Math.tan(halfV)),
    });

    solarSystem.update({
      ephemeris,
      limitMagnitude,
      surfaceRefMagnitude,
      radPerPixel,
      camera,
      skyMatrix,
      atmosphere: atmosphereState,
      showSun: true,
      skip: resolvedKeys,
    });
  }

  const width = canvas.clientWidth || window.innerWidth;
  labelLayer.update(camera, width, height, collectLabels(limitMagnitude, controls.fov));

  // Reticle tracks the current selection.
  if (state.selection) {
    const world = selectionDirection(state.selection);
    const projected = world.clone().project(camera);
    const reticle = $('reticle');
    if (projected.z < 1 && camera.getWorldDirection(new Vector3()).dot(world.normalize()) > 0) {
      reticle.hidden = false;
      reticle.style.left = `${(projected.x * 0.5 + 0.5) * width}px`;
      reticle.style.top = `${(-projected.y * 0.5 + 0.5) * height}px`;
    } else {
      reticle.hidden = true;
    }
  }

  post.render(dt);
  if (window.cosminova) window.cosminova.ready = true;

  // HUD at a fixed lower rate; text layout is far more expensive than the draw.
  smoothedFps = smoothedFps * 0.92 + (1 / Math.max(dt, 1e-4)) * 0.08;
  hudAccumulator += dt;
  if (hudAccumulator > 0.12) {
    hudAccumulator = 0;
    const viewDirection = camera.getWorldDirection(new Vector3());
    inverseSky.copy(skyMatrix).invert();
    const equatorial = vectorToEquatorial(viewDirection.clone().applyMatrix4(inverseSky));
    readout.ra.textContent = formatRa(equatorial.ra);
    readout.dec.textContent = formatDec(equatorial.dec);
    if (state.mode === 'ground') {
      const horizontal = horizontalFromWorld(viewDirection);
      readout.alt.textContent = `${horizontal.altitude.toFixed(2)}°`;
      readout.az.textContent = `${horizontal.azimuth.toFixed(2)}° ${compassPoint(horizontal.azimuth)}`;
    } else {
      readout.alt.textContent = '—';
      readout.az.textContent = '—';
    }
    readout.fov.textContent = formatAngle(controls.fov);
    readout.limit.textContent = `${limitMagnitude.toFixed(1)} mag`;
    readout.count.textContent = starField.visibleCount.toLocaleString();
    readout.fps.textContent = smoothedFps.toFixed(0);
    zoomSlider.value = String(fovToSlider(controls.fov));
    if (!timeInputFocused) {
      const d = state.date;
      const pad = (n) => String(n).padStart(2, '0');
      timeInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
        d.getHours(),
      )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
  }
}

// --------------------------------------------------------------- debug api

/**
 * Scripting surface used by scripts/shoot.mjs to drive deterministic captures.
 * It only reads and sets the same state the UI does, so anything reproducible
 * here is reproducible by hand.
 */
window.cosminova = {
  ready: false,
  state,
  controls,
  resolved,
  ui,
  /** Used by the capture scripts to clear the interface out of a shot. */
  setUiVisible(visible) {
    ui.setImmersive(!visible, true);
  },
  setMode(mode) {
    state.mode = mode;
    applyMode();
  },
  /**
   * Points the view at a solar system body and holds it there.
   *
   * The capture and lighting checks need to put a named body in the middle of the
   * frame at a known magnification, which is what a viewer does through the
   * selection panel; this is the same two calls that panel makes.
   */
  lookAtBody(key, fov, { immediate = true } = {}) {
    const selection = bodySelection(key);
    if (!selection) return false;
    showSelection(selection);
    const world = selection.position.clone().applyMatrix4(skyMatrix).normalize();
    const settings = { direction: world, fov: fov ?? selection.fov };
    if (immediate) controls.setOrientation(settings);
    else controls.flyTo({ ...settings, duration: 1500 });
    return true;
  },
  setLocation(latitude, longitude) {
    state.latitude = latitude;
    state.longitude = longitude;
    $('latitude').value = latitude.toFixed(2);
    $('longitude').value = longitude.toFixed(2);
  },
  setDate(value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) state.date = parsed;
  },
  setRate(rate) {
    setRate(rate);
  },
  setExposure(stops) {
    state.exposureStops = stops;
    $('opt-exposure').value = String(stops);
    $('val-exposure').textContent = stops.toFixed(1);
  },
  option(key, value) {
    state[key] = value;
    updateVisibility();
  },
  /** Restores default display options so captures cannot leak into each other. */
  reset() {
    Object.assign(state, {
      mode: 'ground',
      latitude: 37.77,
      longitude: -122.42,
      exposureStops: 0,
      lightPollution: 0.05,
      milkyWayIntensity: 0.55,
      starSize: 2.6,
      showConstellations: true,
      showConstellationLabels: true,
      showBounds: false,
      showAsterisms: false,
      showStarNames: true,
      showDso: true,
      showDsoLabels: true,
      showClusterMarkers: false,
      showGrid: false,
      showAzGrid: false,
      showEcliptic: false,
      showHorizon: true,
      showMilkyWay: true,
      showPlanets: true,
      showFaint: true,
      twinkle: true,
      bloom: true,
      spikes: false,
    });
    starField.catalogPoints.visible = true;
    $('opt-exposure').value = '0';
    $('val-exposure').textContent = '0.0';
    showSelection(null);
    $('help').hidden = true;
    $('panel').hidden = true;
    applyMode();
  },
  /** Isolates a single layer, for tuning brightness without cross-talk. */
  only(layer) {
    Object.assign(state, {
      showMilkyWay: layer === 'milkyway',
      showDso: layer === 'dso',
      showPlanets: layer === 'planets',
      showFaint: layer === 'stars' || layer === 'faint',
      showConstellations: false,
      showConstellationLabels: false,
      showStarNames: false,
      showDsoLabels: layer === 'dso',
      showHorizon: false,
      showGrid: false,
      showAzGrid: false,
      showEcliptic: false,
      showAsterisms: false,
      showBounds: false,
    });
    for (const object of starField.objects) object.visible = true;
    starField.catalogPoints.visible = layer === 'stars' || layer === 'faint';
    applyMode();
    updateVisibility();
    starField.catalogPoints.visible = layer === 'stars' || layer === 'faint';
  },
  lookAt({ ra, dec, fov }) {
    updateSkyOrientation();
    const world = equatorialToVector(ra, dec, new Vector3()).applyMatrix4(skyMatrix);
    controls.setOrientation({ direction: world, fov });
  },
  /**
   * Everything a test needs to choose a moment worth looking at: a body low down
   * or nearly unlit makes for a shot that says nothing about the renderer.
   */
  bodyInfo(key) {
    updateSkyOrientation();
    const body = solarSystemAt(state.date).bodies.find((b) => b.key === key);
    if (!body) return null;
    const world = equatorialToVector(body.ra, body.dec, new Vector3()).applyMatrix4(skyMatrix);
    const sun = solarSystemAt(state.date).sun;
    const separation =
      equatorialToVector(body.ra, body.dec, new Vector3()).angleTo(
        equatorialToVector(sun.ra, sun.dec, new Vector3()),
      ) * RAD;
    return {
      altitude: Math.asin(clamp(world.y, -1, 1)) * RAD,
      phase: body.phase,
      magnitude: body.magnitude,
      diameterArcmin: body.angularRadius * 2 * RAD * 60,
      distanceAu: body.distanceAu,
      ra: body.ra,
      dec: body.dec,
      // Angle from the Sun as seen from here. For the Moon this is the phase in
      // another form — 180 degrees is full — so the two disagreeing means the
      // positions and the illumination have come from different geometry.
      sunSeparation: separation,
    };
  },
  /** Altitude of a body right now, in degrees, in the horizontal frame. */
  bodyAltitude(key) {
    updateSkyOrientation();
    const body = solarSystemAt(state.date).bodies.find((b) => b.key === key);
    if (!body) return null;
    const world = equatorialToVector(body.ra, body.dec, new Vector3()).applyMatrix4(skyMatrix);
    return Math.asin(clamp(world.y, -1, 1)) * RAD;
  },
  /**
   * Steps time forward until a body is well placed in a dark sky. Test
   * scenarios need this because a fixed timestamp is only night-time for one
   * particular longitude.
   */
  advanceToBodyVisible(key, { minAltitude = 30, maxPhase = 1, sunBelow = -15, stepMinutes = 20, maxDays = 400 } = {}) {
    const steps = Math.round((maxDays * 24 * 60) / stepMinutes);
    for (let i = 0; i < steps; i++) {
      const current = solarSystemAt(state.date);
      equatorialToHorizontalMatrix(state.latitude, state.longitude, state.date, skyMatrix);
      const altitudeOf = (body) =>
        Math.asin(
          clamp(
            equatorialToVector(body.ra, body.dec, new Vector3()).applyMatrix4(skyMatrix).y,
            -1,
            1,
          ),
        ) * RAD;
      const target = current.bodies.find((b) => b.key === key);
      if (
        target &&
        altitudeOf(target) >= minAltitude &&
        altitudeOf(current.sun) <= sunBelow &&
        target.phase <= maxPhase
      ) {
        return true;
      }
      state.date = new Date(state.date.getTime() + stepMinutes * 60000);
    }
    return false;
  },
  advanceToSunAltitude(targetAltitude, { stepMinutes = 4, maxDays = 400 } = {}) {
    const steps = Math.round((maxDays * 24 * 60) / stepMinutes);
    let previous = null;
    for (let i = 0; i < steps; i++) {
      const sun = solarSystemAt(state.date).sun;
      equatorialToHorizontalMatrix(state.latitude, state.longitude, state.date, skyMatrix);
      const altitude =
        Math.asin(
          clamp(equatorialToVector(sun.ra, sun.dec, new Vector3()).applyMatrix4(skyMatrix).y, -1, 1),
        ) * RAD;
      if (previous !== null && Math.abs(altitude - targetAltitude) < 0.6) return true;
      previous = altitude;
      state.date = new Date(state.date.getTime() + stepMinutes * 60000);
    }
    return false;
  },
  /** Points the camera a given altitude above the Sun's current azimuth. */
  lookAtSunAzimuth(altitude, fov) {
    updateSkyOrientation();
    const sun = solarSystemAt(state.date).sun;
    const world = equatorialToVector(sun.ra, sun.dec, new Vector3()).applyMatrix4(skyMatrix);
    const azimuth = Math.atan2(-world.x, world.z) * RAD;
    const yaw = azimuth;
    controls.setOrientation({ yaw, pitch: altitude, fov });
  },
  lookAtBody(key, fov) {
    updateSkyOrientation();
    const current = solarSystemAt(state.date);
    const body = current.bodies.find((b) => b.key === key);
    if (!body) return false;
    const world = equatorialToVector(body.ra, body.dec, new Vector3()).applyMatrix4(skyMatrix);
    controls.setOrientation({ direction: world, fov });
    return true;
  },
  /** Renders one frame and summarises both the HUD and the actual pixels. */
  stats() {
    post.render(0);
    const width = renderer.domElement.width;
    const height = renderer.domElement.height;
    const context = renderer.getContext();
    const pixels = new Uint8Array(width * height * 4);
    context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);

    let total = 0;
    let max = 0;
    let nonBlack = 0;
    const sampleStride = 4;
    let samples = 0;
    for (let i = 0; i < width * height; i += sampleStride) {
      const o = i * 4;
      const luma = 0.2126 * pixels[o] + 0.7152 * pixels[o + 1] + 0.0722 * pixels[o + 2];
      total += luma;
      if (luma > max) max = luma;
      if (luma > 6) nonBlack++;
      samples++;
    }

    return {
      fov: formatAngle(controls.fov),
      fovDegrees: controls.fov,
      limitMagnitude: Number(lastLimitMagnitude.toFixed(2)),
      visibleStars: starField.visibleCount,
      visibleDsos: deepSky.visibleCount ?? 0,
      mode: state.mode,
      date: state.date.toISOString(),
      skyGlowMagnitudes: Number(lastSkyGlow.toFixed(2)),
      meanLuma: total / samples,
      maxLuma: max,
      nonBlackFraction: nonBlack / samples,
    };
  },
};

$('loading').classList.add('done');
setTimeout(() => {
  $('loading').style.display = 'none';
}, 800);

requestAnimationFrame(frame);
