/**
 * Downloads the raw planetary imagery and elevation data into data-src/tex/.
 * Everything here is either public domain (NASA/USGS) or CC-BY (Solar System
 * Scope); see README credits. Files already present are skipped, so this is
 * safe to re-run.
 *
 * Run: npm run fetch:assets
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data-src', 'tex');
fs.mkdirSync(OUT, { recursive: true });

const SSS = 'https://www.solarsystemscope.com/textures/download/';
const MOONKIT = 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/';
const USGS = 'https://planetarymaps.usgs.gov/mosaic/';

/**
 * `as` is the local filename. Colour maps are the highest resolution offered,
 * since surface detail is the whole point; the featureless ice giants are only
 * published at 2k and lose nothing by it.
 */
const ASSETS = [
  // --- Solar System Scope, CC-BY 4.0, based on NASA imagery ---
  { url: `${SSS}8k_sun.jpg`, as: 'sun.jpg' },
  { url: `${SSS}8k_mercury.jpg`, as: 'mercury.jpg' },
  { url: `${SSS}8k_venus_surface.jpg`, as: 'venus.jpg' },
  { url: `${SSS}4k_venus_atmosphere.jpg`, as: 'venus-clouds.jpg' },
  { url: `${SSS}8k_earth_daymap.jpg`, as: 'earth.jpg' },
  { url: `${SSS}8k_earth_nightmap.jpg`, as: 'earth-night.jpg' },
  { url: `${SSS}8k_earth_clouds.jpg`, as: 'earth-clouds.jpg' },
  { url: `${SSS}8k_earth_specular_map.tif`, as: 'earth-ocean.tif' },
  { url: `${SSS}8k_moon.jpg`, as: 'moon.jpg' },
  { url: `${SSS}8k_mars.jpg`, as: 'mars.jpg' },
  { url: `${SSS}8k_jupiter.jpg`, as: 'jupiter.jpg' },
  { url: `${SSS}8k_saturn.jpg`, as: 'saturn.jpg' },
  { url: `${SSS}8k_saturn_ring_alpha.png`, as: 'saturn-rings.png' },
  { url: `${SSS}2k_uranus.jpg`, as: 'uranus.jpg' },
  { url: `${SSS}2k_neptune.jpg`, as: 'neptune.jpg' },
  { url: `${SSS}4k_ceres_fictional.jpg`, as: 'ceres.jpg' },

  // --- NASA SVS CGI Moon Kit: real LOLA topography, 16 px/deg ---
  // 16-bit unsigned, half-metres, offset +10 km against a 1737.4 km sphere.
  { url: `${MOONKIT}ldem_16_uint.tif`, as: 'moon-dem.tif', big: true },

  // --- USGS Astrogeology global mosaics, public domain ---
  // Voyager/Galileo/Cassini imagery for the major moons. These are the real
  // surfaces: Io's volcanic sulphur, Europa's lineae, Ganymede's grooved
  // terrain, Callisto's saturation cratering.
  { url: `${USGS}Io_GalileoSSI-Voyager_Global_Mosaic_1km.tif`, as: 'io.tif', big: true },
  { url: `${USGS}Europa_Voyager_GalileoSSI_global_mosaic_500m.tif`, as: 'europa.tif', big: true },
  { url: `${USGS}Ganymede_Voyager_GalileoSSI_global_mosaic_1km.tif`, as: 'ganymede.tif', big: true },
  { url: `${USGS}Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif`, as: 'callisto.tif', big: true },
  { url: `${USGS}Titan_ISS_P19658_Mosaic_Global_4km.tif`, as: 'titan.tif' },

  // Saturn's icy moons, Cassini ISS with Voyager fill. These are clear-filter
  // mosaics, so they are genuinely monochrome — the moons really are grey-white
  // ice, and tinting them would be invention.
  { url: `${USGS}Enceladus_Cassini_mosaic_global_110m.tif`, as: 'enceladus.tif', big: true },
  { url: `${USGS}Tethys_Cassini_mosaic_global_293m.tif`, as: 'tethys.tif', big: true },
  { url: `${USGS}Dione_Cassini_Voyager_mosaic_global_154m.tif`, as: 'dione.tif', big: true },
  { url: `${USGS}Rhea_Cassini_Voyager_mosaic_global_417m.tif`, as: 'rhea.tif', big: true },
  { url: `${USGS}Iapetus_Cassini_Voyager_mosaic_global_783m.tif`, as: 'iapetus.tif' },

  // Triton: Voyager 2 colour, gap-filled. The only spacecraft ever to see it.
  { url: `${USGS}Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif`, as: 'triton.tif', big: true },

  // New Horizons, 2015. Only one hemisphere of each was seen at high
  // resolution; the mosaics carry the rest at approach resolution.
  {
    url: `${USGS}Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif`,
    as: 'pluto.tif',
    big: true,
  },
  {
    url: `${USGS}Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif`,
    as: 'charon.tif',
    big: true,
  },

  // Dawn framing camera. Replaces the fictional Ceres texture with the real one.
  { url: `${USGS}Vesta_Dawn_FC_HAMO_Mosaic_Global_74ppd.tif`, as: 'vesta.tif', big: true },
  { url: `${USGS}Ceres_Dawn_FC_DLR_global_20ppd_Oct2015.tif`, as: 'ceres-dawn.tif' },
];

const human = (n) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

async function download({ url, as, optional }) {
  const dest = path.join(OUT, as);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  skip  ${as.padEnd(20)} ${human(fs.statSync(dest).size)}`);
    return true;
  }
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (cosminova asset fetch)' },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // Streamed to a temp name so an interrupted run cannot leave a truncated
    // file that a later run would happily skip.
    const tmp = `${dest}.part`;
    await fs.promises.writeFile(tmp, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(tmp, dest);
    const size = fs.statSync(dest).size;
    console.log(`  got   ${as.padEnd(20)} ${human(size)}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return true;
  } catch (error) {
    const level = optional ? 'warn ' : 'FAIL ';
    console.log(`  ${level} ${as.padEnd(20)} ${error.message}  ${url}`);
    return Boolean(optional);
  }
}

console.log(`fetching ${ASSETS.length} assets into data-src/tex`);
let ok = true;
// Sequential on purpose: these are large files from a handful of hosts, and
// hammering them in parallel gets connections dropped.
for (const asset of ASSETS) ok = (await download(asset)) && ok;

const total = fs
  .readdirSync(OUT)
  .reduce((sum, f) => sum + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`total ${human(total)} in data-src/tex`);
if (!ok) {
  console.error('some required assets failed');
  process.exit(1);
}
