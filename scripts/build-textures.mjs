/**
 * Turns the raw imagery in data-src/tex into runtime assets in
 * public/textures/bodies, plus a manifest the client uses to decide what to
 * load and when.
 *
 * Two tiers per surface: a small one loaded up front so a body is never
 * untextured, and a large one fetched only when you approach it. Elevation is
 * re-encoded losslessly into two 8-bit channels, because a browser cannot hand
 * a 16-bit PNG to WebGL with its precision intact.
 *
 * Run: npm run build:tex
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data-src', 'tex');
const OUT = path.join(ROOT, 'public', 'textures', 'bodies');
fs.mkdirSync(OUT, { recursive: true });

const NEAR_WIDTH = 8192;
const FAR_WIDTH = 2048;

// sharp refuses inputs over 268 megapixels by default, and several of these
// mosaics are larger: New Horizons mapped Pluto at 300 m per pixel, which is
// 25k pixels around the equator. `unlimited` alone is not enough — that governs
// the decoder's own limits, not this one.
const SHARP_INPUT = { unlimited: true, limitInputPixels: false };

// Lunar DEM encoding, straight from the CGI Moon Kit description: unsigned
// 16-bit half-metres against a 1727.4 km sphere, i.e. 10 km below the 1737.4 km
// reference radius used everywhere else.
const MOON_DEM_SCALE_KM = 0.0005;
const MOON_DEM_OFFSET_KM = -10;

const colourMaps = [
  { src: 'sun.jpg', body: 'sun' },
  { src: 'mercury.jpg', body: 'mercury' },
  { src: 'venus.jpg', body: 'venus' },
  { src: 'venus-clouds.jpg', body: 'venus', kind: 'clouds', near: 4096 },
  { src: 'earth.jpg', body: 'earth' },
  { src: 'earth-night.jpg', body: 'earth', kind: 'night' },
  { src: 'earth-clouds.jpg', body: 'earth', kind: 'clouds' },
  { src: 'moon.jpg', body: 'moon' },
  { src: 'mars.jpg', body: 'mars' },
  { src: 'jupiter.jpg', body: 'jupiter' },
  { src: 'saturn.jpg', body: 'saturn' },
  { src: 'uranus.jpg', body: 'uranus', near: 2048 },
  { src: 'neptune.jpg', body: 'neptune', near: 2048 },
  { src: 'ceres-dawn.tif', body: 'ceres', near: 4096 },
  { src: 'io.tif', body: 'io' },
  { src: 'europa.tif', body: 'europa' },
  { src: 'ganymede.tif', body: 'ganymede' },
  { src: 'callisto.tif', body: 'callisto' },
  { src: 'titan.tif', body: 'titan', near: 4096 },
  { src: 'enceladus.tif', body: 'enceladus' },
  { src: 'tethys.tif', body: 'tethys' },
  { src: 'dione.tif', body: 'dione' },
  { src: 'rhea.tif', body: 'rhea' },
  { src: 'iapetus.tif', body: 'iapetus', near: 4096 },
  { src: 'triton.tif', body: 'triton' },
  { src: 'pluto.tif', body: 'pluto' },
  { src: 'charon.tif', body: 'charon' },
  { src: 'vesta.tif', body: 'vesta' },
];

const human = (n) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);
const manifest = {};

function record(body, kind, tier, file, extra) {
  manifest[body] ??= {};
  manifest[body][kind] ??= {};
  manifest[body][kind][tier] = { file: `bodies/${file}`, ...extra };
}

async function buildColour({ src, body, kind = 'colour', near = NEAR_WIDTH }) {
  const input = path.join(SRC, src);
  if (!fs.existsSync(input)) {
    console.log(`  miss  ${src}`);
    return;
  }
  const meta = await sharp(input, SHARP_INPUT).metadata();
  // Never upscale: an 8k target on a 4k source only wastes bytes.
  const nearWidth = Math.min(near, meta.width);

  for (const [tier, width] of [
    ['far', Math.min(FAR_WIDTH, meta.width)],
    ['near', nearWidth],
  ]) {
    if (tier === 'near' && width <= FAR_WIDTH) continue;
    const name = `${body}-${kind}-${tier}.jpg`;
    const out = path.join(OUT, name);
    await sharp(input, SHARP_INPUT)
      .resize(width, Math.round(width / 2), { fit: 'fill', kernel: 'lanczos3' })
      // Chroma subsampling is invisible on planetary surfaces and saves ~20%.
      .jpeg({ quality: tier === 'near' ? 88 : 82, chromaSubsampling: '4:2:0', mozjpeg: true })
      .toFile(out);
    record(body, kind, tier, name, { width, height: Math.round(width / 2) });
    console.log(`  ${tier.padEnd(5)} ${name.padEnd(30)} ${human(fs.statSync(out).size)}`);
  }
}

/**
 * Re-encodes a 16-bit elevation raster into an 8-bit RGB PNG with the value
 * split across red (high byte) and green (low byte). PNG so it stays lossless:
 * a JPEG here would put ringing artefacts into the high byte, which reads as
 * kilometre-high cliffs.
 */
/**
 * Bakes surface normals from an elevation tier.
 *
 * Shading cannot read the packed 16-bit heights through a hardware filter, so
 * without this the only way to keep slopes from aliasing is to widen the sample
 * stencil until the detail is smeared away. Normals in an ordinary 8-bit texture
 * can be mipmapped and anisotropically filtered, which band-limits shading
 * correctly at every angle and costs one tap instead of sixteen. JPEG is fine
 * here: a slightly wrong normal is invisible, unlike a slightly wrong height.
 */
async function buildNormals({ body, width, height, source, scaleKm, radiusKm }) {
  const rgb = Buffer.alloc(width * height * 3);
  const at = (x, y) => source[y * width + ((x + width) % width)];

  for (let y = 0; y < height; y++) {
    // Metre spacing of one texel, east and north, at this latitude. Longitude
    // lines converge at the poles, so the east step shrinks with cos(lat).
    const lat = (0.5 - (y + 0.5) / height) * Math.PI;
    const dEast = Math.max(Math.cos(lat), 1e-3) * ((2 * Math.PI * radiusKm) / width);
    const dNorth = (Math.PI * radiusKm) / height;
    const y0 = Math.max(y - 1, 0);
    const y1 = Math.min(y + 1, height - 1);

    for (let x = 0; x < width; x++) {
      const slopeEast = ((at(x + 1, y) - at(x - 1, y)) * scaleKm) / (2 * dEast);
      const slopeNorth = ((at(x, y1) - at(x, y0)) * scaleKm) / (2 * dNorth);
      const inv = 1 / Math.sqrt(slopeEast * slopeEast + slopeNorth * slopeNorth + 1);
      const i = (y * width + x) * 3;
      rgb[i] = Math.round((-slopeEast * inv * 0.5 + 0.5) * 255);
      rgb[i + 1] = Math.round((slopeNorth * inv * 0.5 + 0.5) * 255);
      rgb[i + 2] = Math.round((inv * 0.5 + 0.5) * 255);
    }
  }

  const name = `${body}-norm-${width}.jpg`;
  const out = path.join(OUT, name);
  await sharp(rgb, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(out);
  record(body, 'norm', String(width), name, { width, height });
  console.log(`  norm  ${name.padEnd(30)} ${human(fs.statSync(out).size)}`);
}

async function buildElevation({ src, body, scaleKm, offsetKm, radiusKm, widths, normalWidths = [] }) {
  const input = path.join(SRC, src);
  if (!fs.existsSync(input)) {
    console.log(`  miss  ${src}`);
    return;
  }

  for (const width of [...new Set([...widths, ...normalWidths])].sort((a, b) => a - b)) {
    const wantHeight = widths.includes(width);
    const height = Math.round(width / 2);
    // Depth and colourspace are pinned rather than left to sharp. Left alone it
    // decodes this one-channel 16-bit raster to three 8-bit channels: reading
    // those bytes back as 16-bit samples shreds the elevation, because two bytes
    // per sample against three per pixel puts every row a third of a pixel out
    // of phase. Note grey16 rather than b-w, which would also drop to 8 bits.
    const { data, info } = await sharp(input, SHARP_INPUT)
      .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
      .toColourspace('grey16')
      .raw({ depth: 'ushort' })
      .toBuffer({ resolveWithObject: true });

    const samples = info.width * info.height;
    const stride = info.channels;
    if (data.byteLength !== samples * stride * 2) {
      throw new Error(
        `${src}: expected ${samples * stride * 2} bytes of 16-bit elevation, got ${data.byteLength}`,
      );
    }
    const interleaved = new Uint16Array(data.buffer, data.byteOffset, samples * stride);
    const source = new Uint16Array(samples);
    for (let i = 0; i < samples; i++) source[i] = interleaved[i * stride];

    if (wantHeight) {
      const rgb = Buffer.alloc(samples * 3);
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < samples; i++) {
        const v = source[i];
        rgb[i * 3] = (v >> 8) & 255;
        rgb[i * 3 + 1] = v & 255;
        if (v < min) min = v;
        if (v > max) max = v;
      }

      const name = `${body}-dem-${width}.png`;
      const out = path.join(OUT, name);
      await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } })
        .png({ compressionLevel: 9, effort: 10, palette: false })
        .toFile(out);

      // Keyed by width rather than a near/far pair: the renderer picks the level
      // whose texel matches its current vertex spacing, so displacement is always
      // band-limited to the geometry that carries it.
      record(body, 'dem', String(width), name, {
        width: info.width,
        height: info.height,
        scaleKm,
        offsetKm,
        minKm: min * scaleKm + offsetKm,
        maxKm: max * scaleKm + offsetKm,
      });
      console.log(
        `  dem   ${name.padEnd(30)} ${human(fs.statSync(out).size)}` +
          `  relief ${(min * scaleKm + offsetKm).toFixed(2)} .. ${(max * scaleKm + offsetKm).toFixed(2)} km`,
      );
    }

    await buildNormals({
      body,
      width: info.width,
      height: info.height,
      source,
      scaleKm,
      radiusKm,
    });
  }
}

async function buildRings() {
  const input = path.join(SRC, 'saturn-rings.png');
  if (!fs.existsSync(input)) return;
  const name = 'saturn-rings.png';
  await sharp(input).png({ compressionLevel: 9 }).toFile(path.join(OUT, name));
  record('saturn', 'rings', 'near', name, {});
  console.log(`  rings ${name}`);
}

async function buildOceanMask() {
  const input = path.join(SRC, 'earth-ocean.tif');
  if (!fs.existsSync(input)) return;
  const name = 'earth-ocean-far.jpg';
  await sharp(input, SHARP_INPUT)
    .resize(2048, 1024, { fit: 'fill' })
    .greyscale()
    .jpeg({ quality: 80 })
    .toFile(path.join(OUT, name));
  record('earth', 'ocean', 'far', name, {});
  console.log(`  mask  ${name}`);
}

console.log('building body textures');
for (const entry of colourMaps) await buildColour(entry);
await buildElevation({
  src: 'moon-dem.tif',
  body: 'moon',
  scaleKm: MOON_DEM_SCALE_KM,
  offsetKm: MOON_DEM_OFFSET_KM,
  radiusKm: 1737.4,
  // Displacement stops at 4096 (about 2.7 km per texel), below which procedural
  // relief carries the detail. An 8192 tier of lossless 16-bit height is 63 MB
  // and buys nothing, but its normals are cheap and do sharpen shading.
  widths: [128, 256, 512, 1024, 2048, 4096],
  normalWidths: [8192],
});
await buildRings();
await buildOceanMask();

fs.writeFileSync(
  path.join(ROOT, 'public', 'textures', 'bodies.json'),
  JSON.stringify(manifest, null, 1),
);

const total = fs
  .readdirSync(OUT)
  .reduce((sum, f) => sum + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`total ${human(total)} in public/textures/bodies`);
