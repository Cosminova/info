/**
 * Converts raw astronomical catalogs in data-src/ into compact runtime assets
 * in public/data/ and public/textures/.
 *
 * Run: npm run build:data
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data-src');
const OUT_DATA = path.join(ROOT, 'public', 'data');
const OUT_TEX = path.join(ROOT, 'public', 'textures');

const DEG = Math.PI / 180;

fs.mkdirSync(OUT_DATA, { recursive: true });
fs.mkdirSync(OUT_TEX, { recursive: true });

const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
const writeJSON = (f, v) => {
  const p = path.join(OUT_DATA, f);
  fs.writeFileSync(p, JSON.stringify(v));
  return report(p);
};
const report = (p) => {
  const kb = fs.statSync(p).size / 1024;
  const label = kb > 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${kb.toFixed(0)} KB`;
  console.log(`  ${path.relative(ROOT, p).padEnd(42)} ${label}`);
  return p;
};

/** Equatorial spherical -> three.js world vector (Y = north celestial pole). */
function equatorialToVec(raDeg, decDeg) {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const cd = Math.cos(dec);
  return [cd * Math.cos(ra), Math.sin(dec), -cd * Math.sin(ra)];
}

// ---------------------------------------------------------------- stars

/** Minimal RFC4180-ish splitter; HYG quotes fields but never embeds newlines. */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function buildStars() {
  console.log('stars: parsing HYG v4.1 ...');
  const raw = fs.readFileSync(path.join(SRC, 'hygdata_v41.csv'), 'utf8');
  const lines = raw.split('\n');
  const header = splitCsvLine(lines[0]);
  const col = {};
  header.forEach((h, i) => (col[h.replace(/"/g, '')] = i));

  const stars = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = splitCsvLine(line);
    const id = f[col.id];
    if (id === '0') continue; // Sol

    const mag = parseFloat(f[col.mag]);
    if (!Number.isFinite(mag)) continue;
    const ra = parseFloat(f[col.ra]) * 15; // hours -> degrees
    const dec = parseFloat(f[col.dec]);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;

    // B-V colour index; default to a sun-like 0.65 when the catalogue lacks it.
    let ci = parseFloat(f[col.ci]);
    if (!Number.isFinite(ci)) ci = 0.65;

    // HYG stores 100000 pc as "parallax unknown".
    let dist = parseFloat(f[col.dist]);
    if (!Number.isFinite(dist) || dist >= 100000) dist = 0;

    stars.push({
      hip: f[col.hip] ? parseInt(f[col.hip], 10) : 0,
      proper: f[col.proper] || '',
      con: f[col.con] || '',
      spect: f[col.spect] || '',
      absmag: parseFloat(f[col.absmag]),
      lum: parseFloat(f[col.lum]),
      ra,
      dec,
      mag,
      ci,
      dist,
    });
  }

  // Brightest first: lets the renderer clip the draw range by magnitude.
  stars.sort((a, b) => a.mag - b.mag);

  const n = stars.length;
  const pos = new Float32Array(n * 3);
  const mag = new Float32Array(n);
  const ci = new Float32Array(n);
  const dist = new Float32Array(n);

  const hipToIndex = new Map();
  for (let i = 0; i < n; i++) {
    const s = stars[i];
    const v = equatorialToVec(s.ra, s.dec);
    pos[i * 3] = v[0];
    pos[i * 3 + 1] = v[1];
    pos[i * 3 + 2] = v[2];
    mag[i] = s.mag;
    ci[i] = Math.max(-0.4, Math.min(2.5, s.ci));
    dist[i] = s.dist;
    if (s.hip) hipToIndex.set(s.hip, i);
  }

  const bin = Buffer.concat([
    Buffer.from(pos.buffer),
    Buffer.from(mag.buffer),
    Buffer.from(ci.buffer),
    Buffer.from(dist.buffer),
  ]);
  fs.writeFileSync(path.join(OUT_DATA, 'stars.bin'), bin);
  report(path.join(OUT_DATA, 'stars.bin'));

  writeJSON('stars.meta.json', {
    count: n,
    magMin: stars[0].mag,
    magMax: stars[n - 1].mag,
    layout: [
      { name: 'position', type: 'f32', components: 3 },
      { name: 'magnitude', type: 'f32', components: 1 },
      { name: 'colorIndex', type: 'f32', components: 1 },
      { name: 'distanceParsec', type: 'f32', components: 1 },
    ],
  });

  console.log(`  ${n} stars, magnitude ${stars[0].mag} .. ${stars[n - 1].mag}`);
  return { stars, hipToIndex };
}

// ---------------------------------------------------------- named stars

const CONSTELLATION_META = (() => {
  const m = new Map();
  for (const f of readJSON('constellations.json').features) {
    m.set(f.id, {
      name: f.properties.name,
      genitive: f.properties.gen,
      ra: f.geometry.coordinates[0],
      dec: f.geometry.coordinates[1],
      rank: parseInt(f.properties.rank, 10) || 3,
    });
  }
  return m;
})();

function buildStarNames({ stars, hipToIndex }) {
  console.log('names: joining IAU/Bayer designations onto catalogue indices ...');
  const starnames = readJSON('starnames.json');
  const entries = [];
  const seen = new Set();

  const push = (index, name, designation, hip) => {
    const s = stars[index];
    const con = CONSTELLATION_META.get(s.con);
    entries.push({
      i: index,
      n: name || '',
      d: designation || '',
      hip: hip || 0,
      con: s.con,
      conName: con ? con.name : '',
      mag: Math.round(s.mag * 100) / 100,
      spect: s.spect,
      dist: s.dist ? Math.round(s.dist * 100) / 100 : 0,
      absmag: Number.isFinite(s.absmag) ? Math.round(s.absmag * 100) / 100 : null,
      lum: Number.isFinite(s.lum) ? s.lum : null,
    });
  };

  for (const [hipStr, rec] of Object.entries(starnames)) {
    const hip = parseInt(hipStr, 10);
    const index = hipToIndex.get(hip);
    if (index === undefined) continue;

    // Prefer the Bayer letter + constellation genitive as the formal designation.
    const con = CONSTELLATION_META.get(stars[index].con) || CONSTELLATION_META.get(rec.c);
    const gen = con ? con.genitive : rec.c;
    let designation = '';
    if (rec.bayer) designation = `${rec.bayer} ${gen}`;
    else if (rec.flam) designation = `${rec.flam} ${gen}`;
    else if (rec.desig) designation = `${rec.desig} ${gen}`;
    else if (rec.hip) designation = rec.hip;

    push(index, rec.name || '', designation, hip);
    seen.add(index);
  }

  // HYG proper names that starnames.json does not cover.
  for (let i = 0; i < stars.length; i++) {
    if (seen.has(i) || !stars[i].proper) continue;
    push(i, stars[i].proper, stars[i].hip ? `HIP ${stars[i].hip}` : '', stars[i].hip);
  }

  entries.sort((a, b) => a.mag - b.mag);
  writeJSON('starnames.json', entries);
  console.log(`  ${entries.length} designated stars`);
}

// -------------------------------------------------------- line geometry

/**
 * Flattens GeoJSON MultiLineString/LineString features into a single
 * Float32Array of unit-sphere segment endpoints, subdividing along great
 * circles so long spans stay on the sphere when zoomed in.
 */
function flattenLines(features, maxSegmentDeg = 2) {
  const verts = [];
  const pushArc = (a, b) => {
    const va = equatorialToVec(a[0], a[1]);
    const vb = equatorialToVec(b[0], b[1]);
    let dot = va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2];
    dot = Math.max(-1, Math.min(1, dot));
    const angle = Math.acos(dot) / DEG;
    const steps = Math.max(1, Math.ceil(angle / maxSegmentDeg));
    let prev = va;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      // Normalised linear interpolation is enough at <=2 degree steps.
      const p = [
        va[0] + (vb[0] - va[0]) * t,
        va[1] + (vb[1] - va[1]) * t,
        va[2] + (vb[2] - va[2]) * t,
      ];
      const len = Math.hypot(p[0], p[1], p[2]) || 1;
      const q = [p[0] / len, p[1] / len, p[2] / len];
      verts.push(prev[0], prev[1], prev[2], q[0], q[1], q[2]);
      prev = q;
    }
  };

  for (const f of features) {
    const g = f.geometry;
    const parts =
      g.type === 'MultiLineString' || g.type === 'Polygon'
        ? g.coordinates
        : g.type === 'MultiPolygon'
          ? g.coordinates.flat()
          : [g.coordinates];
    for (const part of parts) {
      for (let i = 0; i < part.length - 1; i++) pushArc(part[i], part[i + 1]);
    }
  }
  return new Float32Array(verts);
}

function writeLineBin(name, array) {
  fs.writeFileSync(path.join(OUT_DATA, name), Buffer.from(array.buffer));
  report(path.join(OUT_DATA, name));
}

function buildConstellations() {
  console.log('constellations: figures, boundaries, asterisms, labels ...');
  const lines = readJSON('constellations.lines.json');
  writeLineBin('constellation-lines.bin', flattenLines(lines.features, 1));

  const bounds = readJSON('constellations.bounds.json');
  writeLineBin('constellation-bounds.bin', flattenLines(bounds.features, 1.5));

  const asterisms = readJSON('asterisms.json');
  writeLineBin('asterism-lines.bin', flattenLines(asterisms.features, 1));

  const labels = [];
  for (const [id, meta] of CONSTELLATION_META) {
    labels.push({
      id,
      name: meta.name,
      genitive: meta.genitive,
      rank: meta.rank,
      p: equatorialToVec(meta.ra, meta.dec).map((v) => Math.round(v * 1e5) / 1e5),
    });
  }
  writeJSON('constellation-labels.json', labels);

  const asterismLabels = readJSON('asterisms.json').features.map((f) => ({
    name: f.properties.n,
    p: equatorialToVec(f.properties.loc[0], f.properties.loc[1]).map(
      (v) => Math.round(v * 1e5) / 1e5,
    ),
  }));
  writeJSON('asterism-labels.json', asterismLabels);
}

// ------------------------------------------------------------------ dsos

const DSO_CLASS = {
  g: 'galaxy',
  s: 'galaxy',
  s0: 'galaxy',
  sd: 'galaxy',
  e: 'galaxy',
  i: 'galaxy',
  gg: 'galaxy-group',
  gc: 'globular-cluster',
  oc: 'open-cluster',
  pn: 'planetary-nebula',
  snr: 'supernova-remnant',
  bn: 'nebula',
  dn: 'dark-nebula',
  rn: 'reflection-nebula',
  en: 'emission-nebula',
  sfr: 'star-forming-region',
};

/** "110x110" or "8.7x3.5" arcminutes -> [major, minor] arcminutes. */
function parseDim(dim) {
  if (!dim) return [4, 4];
  const parts = String(dim)
    .split(/[x×]/)
    .map((v) => parseFloat(v))
    .filter(Number.isFinite);
  if (!parts.length) return [4, 4];
  return [parts[0], parts[1] ?? parts[0]];
}

function buildDsos() {
  console.log('deep sky: building Messier + NGC/IC catalogue ...');
  const messierNames = new Map();
  for (const f of readJSON('messier.json').features) {
    messierNames.set(f.id.replace(/\s+/g, ' ').trim(), f.properties.name || '');
  }

  const out = [];
  let skippedDark = 0;
  for (const f of readJSON('dsos.14.json').features) {
    const p = f.properties;

    // Lynds dark nebulae store an opacity class (1-6) in the magnitude field
    // rather than a brightness, and they are absorption features that additive
    // blending cannot represent. Including them painted ~1900 bright blobs
    // across the sky, so they are excluded rather than drawn wrongly.
    if (p.type === 'dn') {
      skippedDark++;
      continue;
    }

    const mag = parseFloat(p.mag);
    if (!Number.isFinite(mag) || mag > 13) continue;
    const [major, minor] = parseDim(p.dim);
    const id = String(p.desig || f.id).trim();

    // Surface brightness proxy: integrated light spread over apparent area.
    // Blending it with the integrated magnitude produces a draw order where a
    // large bright nebula outranks a compact faint galaxy, which matches what
    // becomes visible as the field of view narrows.
    const areaArcmin = Math.max(0.35, Math.PI * (major / 2) * (minor / 2));
    const surfaceBrightness = mag + 2.5 * Math.log10(areaArcmin);
    const rank = 0.65 * mag + 0.35 * surfaceBrightness;

    out.push({
      id,
      name: messierNames.get(id) || '',
      cls: DSO_CLASS[p.type] || 'other',
      type: p.type,
      morph: p.morph || '',
      mag: Math.round(mag * 100) / 100,
      sb: Math.round(surfaceBrightness * 100) / 100,
      rank: Math.round(rank * 100) / 100,
      // arcminutes -> radians for direct use as an angular radius
      rMaj: Math.round((major / 2) * (1 / 60) * DEG * 1e7) / 1e7,
      rMin: Math.round((minor / 2) * (1 / 60) * DEG * 1e7) / 1e7,
      p: equatorialToVec(f.geometry.coordinates[0], f.geometry.coordinates[1]).map(
        (v) => Math.round(v * 1e6) / 1e6,
      ),
    });
  }
  // Visibility order, so the renderer can clip with a plain draw range.
  out.sort((a, b) => a.rank - b.rank);
  writeJSON('dsos.json', out);
  console.log(`  ${out.length} deep sky objects (skipped ${skippedDark} dark nebulae)`);
}

// -------------------------------------------------------- milky way texture

/**
 * The ESO GigaGalaxy Zoom panorama is an equirectangular projection in
 * *galactic* coordinates. Only the horizontal direction is ambiguous, so the
 * two candidate mappings are scored against known off-plane landmarks (the
 * Magellanic Clouds) and the brighter match wins.
 */
async function orientPanorama(file) {
  const img = sharp(file);
  const { width, height } = await img.metadata();
  const raw = await sharp(file)
    .resize(1440, 720, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();
  const W = 1440;
  const H = 720;

  const sampleAt = (u, v, box = 14) => {
    const cx = Math.round(((u % 1) + 1) % 1 * (W - 1));
    const cy = Math.round((1 - v) * (H - 1));
    let sum = 0;
    let count = 0;
    for (let dy = -box; dy <= box; dy++) {
      for (let dx = -box; dx <= box; dx++) {
        const x = (((cx + dx) % W) + W) % W;
        const y = Math.min(H - 1, Math.max(0, cy + dy));
        sum += raw[y * W + x];
        count++;
      }
    }
    return sum / count;
  };

  // Landmarks well away from the galactic plane, in galactic (l, b) degrees.
  const landmarks = [
    { name: 'LMC', l: 280.47, b: -32.89 },
    { name: 'SMC', l: 302.8, b: -44.3 },
  ];

  let scoreMinus = 0;
  let scorePlus = 0;
  for (const lm of landmarks) {
    const v = 0.5 + lm.b / 180;
    const a = sampleAt(0.5 - lm.l / 360, v);
    const b = sampleAt(0.5 + lm.l / 360, v);
    scoreMinus += a;
    scorePlus += b;
    console.log(
      `  ${lm.name}: u=0.5-l/360 -> ${a.toFixed(1)}   u=0.5+l/360 -> ${b.toFixed(1)}`,
    );
  }
  const longitudeSign = scoreMinus >= scorePlus ? -1 : 1;

  // Confirm the plane really is the bright horizontal band through v=0.5.
  const equatorBrightness = sampleAt(0.25, 0.5, 20);
  const poleBrightness = (sampleAt(0.25, 0.92, 20) + sampleAt(0.25, 0.08, 20)) / 2;

  console.log(
    `  galactic plane ${equatorBrightness.toFixed(1)} vs poles ${poleBrightness.toFixed(1)}`,
  );
  console.log(`  chosen longitudeSign = ${longitudeSign}`);

  return {
    source: 'ESO / S. Brunier - GigaGalaxy Zoom',
    frame: 'galactic',
    width,
    height,
    longitudeSign,
    planeContrast: equatorBrightness / Math.max(1, poleBrightness),
  };
}

async function buildMilkyWay() {
  console.log('milky way: orienting and resizing panorama ...');
  const src = path.join(SRC, 'milkyway_eso.jpg');
  const meta = await orientPanorama(src);

  const tiers = [
    { name: 'milkyway-4k.jpg', width: 4096, quality: 88, blur: 2.6 },
    { name: 'milkyway-2k.jpg', width: 2048, quality: 86, blur: 1.6 },
    { name: 'milkyway-1k.jpg', width: 1024, quality: 82, blur: 1.0 },
  ];
  for (const t of tiers) {
    const p = path.join(OUT_TEX, t.name);
    const resized = await sharp(src)
      .resize(t.width, t.width / 2, { fit: 'fill', kernel: 'lanczos3' })
      .toColorspace('srgb')
      .png()
      .toBuffer();

    // The panorama already contains the bright stars, which would double up
    // with the rendered catalogue. Compositing the image against a slightly
    // brightened blur with a "darken" (per-channel min) blend is a cheap
    // morphological opening: point sources collapse, diffuse nebulosity stays.
    const opened = await sharp(resized)
      .blur(t.blur)
      .linear(1.08, 2)
      .png()
      .toBuffer();

    await sharp(resized)
      .composite([{ input: opened, blend: 'darken' }])
      .jpeg({ quality: t.quality, progressive: true, mozjpeg: true })
      .toFile(p);
    report(p);
  }

  fs.writeFileSync(
    path.join(OUT_TEX, 'milkyway.meta.json'),
    JSON.stringify({ ...meta, tiers: tiers.map((t) => t.name) }, null, 2),
  );
  report(path.join(OUT_TEX, 'milkyway.meta.json'));
  return meta;
}

// ------------------------------------------------------------------- main

const catalog = buildStars();
buildStarNames(catalog);
buildConstellations();
buildDsos();
await buildMilkyWay();
console.log('done.');
