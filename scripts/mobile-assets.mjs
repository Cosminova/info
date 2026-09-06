/**
 * Builds the phone and tablet asset set in public-mobile/ from the desktop one
 * in public/.
 *
 * The ceiling here is texture memory, not download size. A desktop near tier is
 * 8192x4096, which is 134 MB once it is decoded and uploaded, and iOS ends a web
 * content process for far less than a handful of those. 2048 near / 1024 far is
 * where a surface still reads as photographed on a screen a few inches wide
 * while the whole set fits inside what a phone will actually hand out;
 * procedural relief carries the detail the imagery gives up, which is the same
 * division of labour the desktop build already relies on past 4096.
 *
 * Derived from public/ rather than data-src/tex on purpose. public/ is
 * committed, so this runs from a clean checkout and from inside the Xcode build
 * phase, neither of which has the 2.1 GB of raw mosaics. Re-encoding an
 * already-compressed source is not a quality problem at a 4x reduction, where
 * the resample averages the artefacts away faster than it introduces them.
 *
 * Run: npm run build:mobile-assets  (npm run build:ios calls this first)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'public-mobile');

const NEAR_WIDTH = 2048;
const FAR_WIDTH = 1024;

// Displacement stops earlier than on the desktop for the same reason it stops
// at all there: below a few km per texel the procedural field is finer than the
// data. The normals are worth one tier past the heights because they are filtered
// in hardware and the heights are not.
const DEM_MAX_WIDTH = 1024;
const NORM_MAX_WIDTH = 2048;

// The ring sheet is a single PNG with alpha, 8192x500, and the shader samples it
// at a fixed v of 0.5: it is a radial profile, so every row but the middle one
// is already dead weight on the desktop too. Keeping a thin band of the rows
// that are actually read takes 6.2 MB to about 20 KB. Height is not 1 because a
// mip chain that reaches a 1px dimension gives the filter nothing to work with.
const RINGS_WIDTH = 2048;
const RINGS_HEIGHT = 8;

// A phone reports devicePixelRatio 3, which is enough to trip the desktop
// panorama heuristic into the 4k tier. The tier is dropped here as well as
// capped in the client, so a mistake in either place cannot cost 864 KB and the
// memory to hold it.
const PANORAMA_TIERS = ['milkyway-2k.jpg', 'milkyway-1k.jpg'];

const SHARP_INPUT = { unlimited: true, limitInputPixels: false };

const human = (n) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

let generated = 0;
let linked = 0;

/**
 * Hardlink where the filesystem allows it and copy where it does not. These are
 * build outputs that are only ever replaced wholesale, never edited in place, so
 * sharing an inode with public/ is free rather than dangerous, and it keeps the
 * 18 MB of catalogues from being written twice on every build.
 */
function place(relSrc, relOut = relSrc) {
  const from = path.join(SRC, relSrc);
  const to = path.join(OUT, relOut);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { force: true });
  try {
    fs.linkSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
  }
  linked += 1;
  return fs.statSync(to).size;
}

async function resizeImage(relSrc, name, width, { quality, height = null }) {
  const input = path.join(SRC, 'textures', relSrc);
  const out = path.join(OUT, 'textures', 'bodies', name);
  const png = name.endsWith('.png');
  const pipeline = sharp(input, SHARP_INPUT).resize(width, height, {
    kernel: 'lanczos3',
    fit: height ? 'fill' : 'cover',
  });
  // No palette on the rings: the alpha ramp across a gap quantises into visible
  // steps, and a 2048x8 image is small enough that the full-colour PNG is free.
  await (png
    ? pipeline.png({ compressionLevel: 9 }).toFile(out)
    : pipeline.jpeg({ quality, chromaSubsampling: '4:2:0', mozjpeg: true }).toFile(out));
  generated += 1;
  return fs.statSync(out).size;
}

/**
 * What the output depends on: the settings above, and the identity of every
 * source file the manifest names. The Xcode build phase runs on every build and
 * regenerating thirty JPEGs each time would put a minute on an incremental
 * compile, so an unchanged input skips the whole pass.
 */
function stamp() {
  const hash = crypto.createHash('sha256');
  hash.update(
    JSON.stringify({
      NEAR_WIDTH,
      FAR_WIDTH,
      DEM_MAX_WIDTH,
      NORM_MAX_WIDTH,
      RINGS_WIDTH,
      PANORAMA_TIERS,
      version: 1,
    }),
  );
  // Every file that ends up in the output, by identity rather than content:
  // hashing 159 MB on each build would cost more than the work it saves.
  for (const full of [...walk(path.join(SRC, 'data')), ...walk(path.join(SRC, 'textures'))].sort()) {
    const stat = fs.statSync(full);
    hash.update(`${path.relative(SRC, full)}:${stat.size}:${Math.round(stat.mtimeMs)}`);
  }
  return hash.digest('hex');
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'textures', 'bodies.json'), 'utf8'));
// Deliberately outside OUT: Vite copies the public directory wholesale, dotfiles
// included, so a stamp kept in there ships inside the app bundle.
const stampFile = path.join(ROOT, '.mobile-assets.stamp');
const want = stamp();
if (fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8').trim() === want) {
  console.log(`mobile assets already current (${human(walk(OUT).reduce((n, f) => n + fs.statSync(f).size, 0))})`);
  process.exit(0);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'textures', 'bodies'), { recursive: true });

const out = {};
const record = (body, kind, tier, entry) => {
  out[body] ??= {};
  out[body][kind] ??= {};
  out[body][kind][tier] = entry;
};

console.log('surfaces');
for (const [body, kinds] of Object.entries(manifest)) {
  for (const [kind, tiers] of Object.entries(kinds)) {
    // Elevation and normals are already a per-width pyramid, so the mobile set
    // is a prefix of it. Nothing to resample, just fewer levels carried.
    if (kind === 'dem' || kind === 'norm') {
      const cap = kind === 'dem' ? DEM_MAX_WIDTH : NORM_MAX_WIDTH;
      const kept = Object.entries(tiers).filter(([width]) => Number(width) <= cap);
      // Never leave a body with no elevation at all: if every tier is over the
      // cap, keep the coarsest one rather than silently flattening the surface.
      const entries = kept.length
        ? kept
        : [Object.entries(tiers).sort(([a], [b]) => Number(a) - Number(b))[0]];
      for (const [width, entry] of entries) {
        place(path.join('textures', entry.file), path.join('textures', entry.file));
        record(body, kind, width, entry);
      }
      continue;
    }

    if (kind === 'rings') {
      const [tier, entry] = Object.entries(tiers)[0];
      const name = path.basename(entry.file);
      const size = await resizeImage(entry.file, name, RINGS_WIDTH, { height: RINGS_HEIGHT });
      record(body, kind, tier, { ...entry });
      console.log(`  rings ${name.padEnd(30)} ${human(size)}`);
      continue;
    }

    // The ocean mask is a single greyscale far tier with no width recorded, and
    // the client reads only its file name. Kept at the far width and otherwise
    // passed through unchanged so that stays true.
    if (kind === 'ocean') {
      const [tier, entry] = Object.entries(tiers)[0];
      const name = path.basename(entry.file);
      const size = await resizeImage(entry.file, name, FAR_WIDTH, { quality: 82 });
      record(body, kind, tier, { ...entry });
      console.log(`  ocean ${name.padEnd(30)} ${human(size)}`);
      continue;
    }

    // Resample from the finest source available so the reduction averages the
    // desktop tier's compression away instead of compounding it.
    const source = tiers.near ?? tiers.far;
    if (!source) continue;
    const sourceWidth = source.width ?? NEAR_WIDTH;
    for (const [tier, target] of [
      ['far', Math.min(FAR_WIDTH, sourceWidth)],
      ['near', Math.min(NEAR_WIDTH, sourceWidth)],
    ]) {
      // Same rule the desktop build uses: a near tier that is not larger than
      // the far tier is a second copy of it.
      if (tier === 'near' && target <= FAR_WIDTH) continue;
      const name = `${body}-${kind}-${tier}.jpg`;
      const size = await resizeImage(source.file, name, target, { quality: tier === 'near' ? 86 : 80 });
      record(body, kind, tier, { file: `bodies/${name}`, width: target, height: Math.round(target / 2) });
      console.log(`  ${tier.padEnd(5)} ${name.padEnd(30)} ${human(size)}`);
    }
  }
}

fs.writeFileSync(path.join(OUT, 'textures', 'bodies.json'), `${JSON.stringify(out, null, 2)}\n`);

console.log('panorama');
const panorama = JSON.parse(fs.readFileSync(path.join(SRC, 'textures', 'milkyway.meta.json'), 'utf8'));
for (const tier of PANORAMA_TIERS) {
  console.log(`  keep  ${tier.padEnd(30)} ${human(place(path.join('textures', tier)))}`);
}
fs.writeFileSync(
  path.join(OUT, 'textures', 'milkyway.meta.json'),
  `${JSON.stringify({ ...panorama, tiers: PANORAMA_TIERS }, null, 2)}\n`,
);

// Catalogues carry over whole. They are 18 MB of the budget, but they are what
// the app is: trimming stars is visible as a sky with holes in it, and the
// client already culls by magnitude per frame, so the cost is disk rather than
// memory or fill rate.
console.log('catalogues');
for (const full of walk(path.join(SRC, 'data'))) {
  place(path.relative(SRC, full));
}
for (const entry of fs.readdirSync(SRC, { withFileTypes: true })) {
  // Dotfiles are the Finder's business, not the app bundle's.
  if (entry.isFile() && !entry.name.startsWith('.')) place(entry.name);
}
console.log(`  ${String(linked)} files linked or copied`);

fs.writeFileSync(stampFile, `${want}\n`);

const total = walk(OUT).reduce((n, f) => n + fs.statSync(f).size, 0);
const before = walk(SRC).reduce((n, f) => n + fs.statSync(f).size, 0);
console.log(
  `\npublic-mobile: ${human(total)} from ${human(before)} `
    + `(${(100 - (total / before) * 100).toFixed(0)}% smaller, ${generated} images generated)`,
);
