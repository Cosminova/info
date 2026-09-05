import { TextureLoader } from 'three';

const BASE = import.meta.env.BASE_URL ?? '/';
const url = (p) => `${BASE.replace(/\/$/, '')}/${p}`;

async function fetchJson(path) {
  const response = await fetch(url(path));
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.json();
}

async function fetchFloat32(path) {
  const response = await fetch(url(path));
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  const buffer = await response.arrayBuffer();
  return new Float32Array(buffer);
}

/**
 * The star catalogue is a single structure-of-arrays binary so each field can
 * be handed straight to a GPU buffer with no parsing or per-star allocation.
 */
async function loadStarCatalog() {
  const [meta, raw] = await Promise.all([
    fetchJson('data/stars.meta.json'),
    fetchFloat32('data/stars.bin'),
  ]);
  const count = meta.count;
  let offset = 0;
  const position = raw.subarray(offset, (offset += count * 3));
  const magnitude = raw.subarray(offset, (offset += count));
  const colorIndex = raw.subarray(offset, (offset += count));
  const distanceParsec = raw.subarray(offset, (offset += count));
  return { count, position, magnitude, colorIndex, distanceParsec, meta };
}

function loadTexture(path) {
  return new Promise((resolve, reject) => {
    new TextureLoader().load(url(path), resolve, undefined, reject);
  });
}

/** Chooses a panorama resolution the current device can comfortably hold. */
function pickPanoramaTier(maxTextureSize) {
  if (maxTextureSize >= 4096 && window.devicePixelRatio * window.innerWidth > 900) {
    return 'textures/milkyway-4k.jpg';
  }
  if (maxTextureSize >= 2048) return 'textures/milkyway-2k.jpg';
  return 'textures/milkyway-1k.jpg';
}

/**
 * Just the background sky: the star catalogue and the Milky Way panorama. The
 * 3D scene has no use for constellation figures or the deep sky catalogue, and
 * skipping them takes a megabyte off the first frame.
 */
export async function loadSpaceData({ maxTextureSize = 4096 } = {}) {
  const [catalog, milkyWayMeta, galaxies, exoplanets, starNames] = await Promise.all([
    loadStarCatalog(),
    fetchJson('textures/milkyway.meta.json'),
    fetchJson('data/galaxies.json'),
    fetchJson('data/exoplanets.json'),
    fetchJson('data/starnames.json'),
  ]);
  const milkyWayTexture = await loadTexture(pickPanoramaTier(maxTextureSize));
  return { catalog, milkyWayTexture, milkyWayMeta, galaxies, exoplanets, starNames };
}

export async function loadSkyData({ maxTextureSize = 4096, onProgress = () => {} } = {}) {
  onProgress('star catalogue');
  const catalog = await loadStarCatalog();

  onProgress('designations and deep sky');
  const [starNames, constellationLabels, asterismLabels, dsos, milkyWayMeta] = await Promise.all([
    fetchJson('data/starnames.json'),
    fetchJson('data/constellation-labels.json'),
    fetchJson('data/asterism-labels.json'),
    fetchJson('data/dsos.json'),
    fetchJson('textures/milkyway.meta.json'),
  ]);

  onProgress('constellation geometry');
  const [constellationLines, constellationBounds, asterismLines] = await Promise.all([
    fetchFloat32('data/constellation-lines.bin'),
    fetchFloat32('data/constellation-bounds.bin'),
    fetchFloat32('data/asterism-lines.bin'),
  ]);

  onProgress('milky way panorama');
  const milkyWayTexture = await loadTexture(pickPanoramaTier(maxTextureSize));

  return {
    catalog,
    starNames,
    constellationLabels,
    asterismLabels,
    dsos,
    constellationLines,
    constellationBounds,
    asterismLines,
    milkyWayTexture,
    milkyWayMeta,
  };
}
