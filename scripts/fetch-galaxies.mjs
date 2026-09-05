/**
 * Builds public/data/galaxies.json: galaxies with measured distances, so they
 * can be placed as real objects in the same continuous space as the stars.
 * The entries in dsos.json carry only a unit direction, which is enough to
 * paint a deep sky object onto a sphere at infinity but not to fly past one.
 *
 * Three catalogues are stacked, best distance first:
 *   - the Updated Nearby Galaxy Catalog, the authority inside ~11 Mpc and the
 *     only one of the three that carries the Milky Way's dwarf companions;
 *   - Cosmicflows-3, redshift-independent distances from Cepheids, the tip of
 *     the red giant branch, Tully-Fisher and supernovae, out to ~500 Mpc;
 *   - RC3, for the remainder, where the distance has to come from a redshift.
 *
 * A galaxy found in more than one keeps the distance from the highest-priority
 * catalogue, so a measured distance always beats an inferred one. That ordering
 * is not cosmetic: RC3's redshift puts M87 at 23 Mpc because Virgo infall
 * inflates its velocity, where Cosmicflows-3 measures 16.5 Mpc.
 *
 * Run: node scripts/fetch-galaxies.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'data', 'galaxies.json');

const DEG = Math.PI / 180;
const TAP = 'https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync';

const H0 = 70; // km/s/Mpc

// Below this the redshift says more about a galaxy's motion within its group
// than about its distance, so a Hubble-law distance is not offered at all.
// 1400 km/s is about 20 Mpc.
const HUBBLE_FLOOR_KMS = 1400;

// Cosmicflows-3 holds 17669 galaxies, far more than a browser wants to carry.
// A cut on apparent brightness keeps the ones that would actually be picked out
// of the sky and lands the catalogue at a few thousand.
const BMAG_CUT = 14;

// Cross-catalogue identity is decided on position, and the upper bound on the
// tolerance is set by close interacting pairs rather than by positional error:
// the two Antennae galaxies are 68" apart and have to stay separate.
const MATCH_ARCSEC = 40;

/** Equatorial spherical -> three.js world vector (Y = north celestial pole). */
function equatorialToVec(raDeg, decDeg) {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const cd = Math.cos(dec);
  return [cd * Math.cos(ra), Math.sin(dec), -cd * Math.sin(ra)];
}

const round = (v, places) => {
  const scale = 10 ** places;
  return Math.round(v * scale) / scale;
};

/** Three significant figures, which is more than any of these distances earn. */
const sig3 = (v) => {
  const scale = 10 ** (3 - Math.ceil(Math.log10(v)));
  return Math.round(v * scale) / scale;
};

const first = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');

// ------------------------------------------------------------------- fetching

/**
 * VizieR's TAP endpoint rather than ASU because it hands back right ascension
 * already in degrees, and by POST because the HyperLEDA lookup below sends a
 * few hundred identifiers at a time.
 */
async function tap(label, adql) {
  const response = await fetch(TAP, {
    method: 'POST',
    headers: { 'user-agent': 'cosminova asset fetch' },
    body: new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'json', QUERY: adql }),
  });
  if (!response.ok) {
    console.error(`VizieR returned HTTP ${response.status} for ${label}`);
    console.error((await response.text()).slice(0, 400));
    process.exit(1);
  }
  const { metadata, data } = await response.json();
  const keys = metadata.map((m) => m.name);
  return data.map((row) => Object.fromEntries(keys.map((k, i) => [k, row[i]])));
}

console.log('querying VizieR');

const ungcRows = await tap(
  'UNGC',
  `SELECT "Name", "RAJ2000", "DEJ2000", "a26", "b/a", "TT", "Mcl", "Bmag", "Dist", "f_Dist"
   FROM "J/AJ/145/101/catalog" WHERE "Dist" > 0`,
);
console.log(`  ${ungcRows.length} Local Volume galaxies (Karachentsev+ 2013)`);

const cf3Rows = await tap(
  'Cosmicflows-3',
  `SELECT "PGC", "Name", "RAJ2000", "DEJ2000", "Dist", "MType", "Bmag"
   FROM "J/AJ/152/50/table3" WHERE "Dist" > 0`,
);
console.log(`  ${cf3Rows.length} redshift-independent distances (Cosmicflows-3)`);

const rc3Rows = await tap(
  'RC3',
  `SELECT "PGC", "altname", "desig", "RA2000", "DE2000", "T", "D25", "R25", "PA", "BT", "Bmag", "V3K"
   FROM "VII/155/rc3"
   WHERE "V3K" > ${HUBBLE_FLOOR_KMS} AND "BT" < ${BMAG_CUT} AND "D25" IS NOT NULL`,
);
console.log(`  ${rc3Rows.length} redshifts beyond ${HUBBLE_FLOOR_KMS} km/s (RC3)`);

// -------------------------------------------------------------------- merging

const records = [];
const grid = new Map();
const tolerance = MATCH_ARCSEC * (DEG / 3600);
const cosTolerance = Math.cos(tolerance);

const bucketKey = (v, dx, dy, dz) =>
  `${Math.round(v[0] / tolerance) + dx},${Math.round(v[1] / tolerance) + dy},${
    Math.round(v[2] / tolerance) + dz
  }`;

/**
 * Cells are one tolerance wide, so a genuine match can only ever be in this
 * cell or one touching it, and the 27 probes are exhaustive.
 */
function resolve(raDeg, decDeg) {
  const v = equatorialToVec(raDeg, decDeg);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const record of grid.get(bucketKey(v, dx, dy, dz)) ?? []) {
          const dot = record.v[0] * v[0] + record.v[1] * v[1] + record.v[2] * v[2];
          if (dot >= cosTolerance) return record;
        }
      }
    }
  }
  const record = { v, ra: raDeg, dec: decDeg, desigs: [] };
  const key = bucketKey(v, 0, 0, 0);
  const bucket = grid.get(key);
  if (bucket) bucket.push(record);
  else grid.set(key, [record]);
  records.push(record);
  return record;
}

const arcminToDeg = (v) => v / 60;
// HyperLEDA and RC3 both tabulate the diameter as log of tenths of an arcminute.
const logToArcmin = (log) => 10 ** log / 10;

for (const row of ungcRows) {
  const name = (row.Name ?? '').trim();
  // The catalogue includes the Milky Way itself as a reference row, which is
  // not an object this renderer can place.
  if (name === 'Milky Way') continue;
  const record = resolve(row.RAJ2000, row.DEJ2000);
  record.ungc ??= {
    name,
    dist: row.Dist,
    mag: row.Bmag > 0 ? row.Bmag : undefined,
    maj: row.a26 > 0 ? arcminToDeg(row.a26) : undefined,
    min: row.a26 > 0 ? arcminToDeg(row.a26 * (row['b/a'] > 0 ? row['b/a'] : 1)) : undefined,
    tType: row.TT,
    dwarf: (row.Mcl ?? '').trim(),
  };
}

for (const row of cf3Rows) {
  const record = resolve(row.RAJ2000, row.DEJ2000);
  record.pgc ??= row.PGC;
  record.desigs.push((row.Name ?? '').trim());
  record.cf3 ??= {
    dist: row.Dist,
    mag: row.Bmag > 0 ? row.Bmag : undefined,
    tType: row.MType,
  };
}

for (const row of rc3Rows) {
  const record = resolve(row.RA2000, row.DE2000);
  // RC3 tabulates the PGC number with its prefix still attached, as 'PGC 5818'.
  const pgc = Number(String(row.PGC ?? '').replace(/\D/g, ''));
  if (pgc) record.pgc ??= pgc;
  record.desigs.push((row.altname ?? '').trim(), (row.desig ?? '').trim(), row.PGC ?? '');
  record.rc3 ??= {
    // The CMB-frame velocity, not the heliocentric one: the Sun's 370 km/s
    // through the microwave background is a quarter of the recession velocity
    // at this catalogue's floor, and using cz would displace a galaxy by
    // several Mpc purely according to where it sits on the sky.
    vcmb: row.V3K,
    mag: first(row.BT > 0 ? row.BT : undefined, row.Bmag > 0 ? row.Bmag : undefined),
    maj: arcminToDeg(logToArcmin(row.D25)),
    min: arcminToDeg(logToArcmin(row.D25 - (row.R25 ?? 0))),
    pa: row.PA,
    tType: row.T,
  };
}

console.log(`  ${records.length} distinct galaxies after cross-matching`);

const selected = records.filter(
  (r) => r.ungc || r.rc3 || (r.cf3?.mag !== undefined && r.cf3.mag <= BMAG_CUT),
);
console.log(`  ${selected.length} pass the B < ${BMAG_CUT} cut`);

// ------------------------------------------------- shapes, angles and naming

/**
 * HyperLEDA is the one source here that has a position angle and a plain-text
 * morphological type for most galaxies, and its alternate-name list is what
 * makes it possible to give a galaxy its NGC number rather than whichever
 * survey identifier the distance catalogue happened to use.
 */
const ledaByPgc = new Map();
const pgcs = [...new Set(selected.map((r) => r.pgc).filter(Boolean))];
for (let i = 0; i < pgcs.length; i += 400) {
  const chunk = pgcs.slice(i, i + 400);
  const rows = await tap(
    'HyperLEDA',
    `SELECT "PGC", "MType", "logD25", "logR25", "PA", "ANames"
     FROM "VII/237/pgc" WHERE "PGC" IN (${chunk.join(',')})`,
  );
  for (const row of rows) if (!ledaByPgc.has(row.PGC)) ledaByPgc.set(row.PGC, row);
}
console.log(`  ${ledaByPgc.size} of ${pgcs.length} matched in HyperLEDA for shape and type`);

const PREFIXES = ['NGC', 'IC', 'M', 'UGCA', 'UGC', 'ESO', 'PGC'];
const PATTERNS = [
  [/^N(?:GC)?0*(\d+[A-D]?)$/i, 'NGC'],
  [/^IC0*(\d+[A-D]?)$/i, 'IC'],
  [/^(?:MESSIER|M)0*(\d{1,3})$/i, 'M'],
  [/^UGCA0*(\d+)$/i, 'UGCA'],
  [/^UGC0*(\d+)$/i, 'UGC'],
  [/^ESO0*(\d+)-0*(\d+)$/i, 'ESO'],
  [/^PGC0*(\d+)$/i, 'PGC'],
];

/** 'NGC0224', 'N4486', '(ESO572-47)' -> 'NGC 224', 'NGC 4486', 'ESO 572-47'. */
function designation(raw) {
  const bare = raw.replace(/[\s_()]/g, '');
  for (const [pattern, prefix] of PATTERNS) {
    const m = bare.match(pattern);
    if (m) return { prefix, id: `${prefix} ${m.slice(1).join('-')}` };
  }
  return null;
}

// The Magellanic Clouds and the Milky Way's dwarf companions are known by name
// rather than by catalogue number, and HyperLEDA would otherwise hand the LMC
// back as ESO 56-115.
const LOCAL_IDS = {
  LMC: 'LMC',
  SMC: 'SMC',
  'Sag dSph': 'Sagittarius Dwarf',
  Fornax: 'Fornax Dwarf',
  Sculptor: 'Sculptor Dwarf',
  Draco: 'Draco Dwarf',
  UMin: 'Ursa Minor Dwarf',
  Carina: 'Carina Dwarf',
  SexDSph: 'Sextans Dwarf',
  LeoI: 'Leo I',
  LeoII: 'Leo II',
};

const COMMON_NAMES = {
  LMC: 'Large Magellanic Cloud',
  SMC: 'Small Magellanic Cloud',
  'NGC 55': 'Whale of the South',
  'NGC 205': 'Messier 110',
  'NGC 221': 'Messier 32',
  'NGC 224': 'Andromeda Galaxy',
  'NGC 253': 'Sculptor Galaxy',
  'NGC 598': 'Triangulum Galaxy',
  'NGC 891': 'Silver Sliver Galaxy',
  'NGC 1068': 'Cetus A',
  'NGC 1097': 'Fornax Barred Spiral',
  'NGC 1275': 'Perseus A',
  'NGC 1316': 'Fornax A',
  'NGC 1365': 'Great Barred Spiral Galaxy',
  'NGC 2403': 'Cigar-Ring Galaxy',
  'NGC 2685': 'Helix Galaxy',
  'NGC 3031': "Bode's Galaxy",
  'NGC 3034': 'Cigar Galaxy',
  'NGC 3115': 'Spindle Galaxy',
  'NGC 3521': 'Bubble Galaxy',
  'NGC 3628': 'Hamburger Galaxy',
  'NGC 4038': 'Antennae Galaxies',
  'NGC 4039': 'Antennae Galaxies',
  'NGC 4258': 'Messier 106',
  'NGC 4472': 'Messier 49',
  'NGC 4486': 'Virgo A',
  'NGC 4565': 'Needle Galaxy',
  'NGC 4594': 'Sombrero Galaxy',
  'NGC 4656': 'Hockey Stick Galaxy',
  'NGC 4676': 'Mice Galaxies',
  'NGC 4826': 'Black Eye Galaxy',
  'NGC 5055': 'Sunflower Galaxy',
  'NGC 5128': 'Centaurus A',
  'NGC 5194': 'Whirlpool Galaxy',
  'NGC 5236': 'Southern Pinwheel Galaxy',
  'NGC 5457': 'Pinwheel Galaxy',
  'NGC 5907': 'Splinter Galaxy',
  'NGC 6503': 'Lost In Space Galaxy',
  'NGC 6822': "Barnard's Galaxy",
  'NGC 6946': 'Fireworks Galaxy',
  'NGC 7742': 'Fried Egg Galaxy',
};

// de Vaucouleurs stage, used only where no source gives a type as text.
const STAGES = {
  '-6': 'E',
  '-5': 'E',
  '-4': 'E',
  '-3': 'S0-',
  '-2': 'S0',
  '-1': 'S0+',
  0: 'S0/a',
  1: 'Sa',
  2: 'Sab',
  3: 'Sb',
  4: 'Sbc',
  5: 'Sc',
  6: 'Scd',
  7: 'Sd',
  8: 'Sdm',
  9: 'Sm',
  10: 'Im',
  11: 'Irr',
};

// ------------------------------------------------------------------- assembly

const galaxies = [];
let dropped = 0;

for (const record of selected) {
  const leda = record.pgc ? ledaByPgc.get(record.pgc) : undefined;

  let dist;
  let method;
  if (record.ungc?.dist > 0) {
    dist = record.ungc.dist;
    method = 'ri';
  } else if (record.cf3?.dist > 0) {
    dist = record.cf3.dist;
    method = 'ri';
  } else if (record.rc3?.vcmb > HUBBLE_FLOOR_KMS) {
    dist = record.rc3.vcmb / H0;
    method = 'z';
  }

  const mag = first(record.ungc?.mag, record.cf3?.mag, record.rc3?.mag);
  const maj = first(
    record.ungc?.maj,
    leda?.logD25 != null ? arcminToDeg(logToArcmin(leda.logD25)) : undefined,
    record.rc3?.maj,
  );
  const min = first(
    record.ungc?.min,
    leda?.logD25 != null
      ? arcminToDeg(logToArcmin(leda.logD25 - (leda.logR25 ?? 0)))
      : undefined,
    record.rc3?.min,
  );

  // A galaxy without all four cannot be drawn at the right place, brightness
  // and size, and a placeholder would be a worse answer than an absence.
  if (!(dist > 0) || !(mag > -30) || !(maj > 0) || !(min > 0)) {
    dropped++;
    continue;
  }

  const candidates = [...record.desigs, ...String(leda?.ANames ?? '').split(/\s+/)]
    .filter(Boolean)
    .map(designation)
    .filter(Boolean);
  candidates.sort((a, b) => PREFIXES.indexOf(a.prefix) - PREFIXES.indexOf(b.prefix));

  const id = first(
    LOCAL_IDS[record.ungc?.name],
    candidates[0]?.id,
    record.ungc?.name,
    record.pgc ? `PGC ${record.pgc}` : undefined,
  );
  if (!id) {
    dropped++;
    continue;
  }

  const stage = first(record.ungc?.tType, record.cf3?.tType, record.rc3?.tType);
  const morph = first(
    (leda?.MType ?? '').trim(),
    // For a dwarf spheroidal the stage code collapses to 'S0-', which says
    // nothing useful, so the UNGC dwarf class is preferred over it.
    record.ungc?.dwarf,
    stage != null ? STAGES[Math.round(stage)] : undefined,
  );

  // Both position angles are quoted for B1950. Precessing them would turn each
  // by under a degree, which is less than the spread between the surveys that
  // measured them.
  const pa = first(leda?.PA, record.rc3?.pa);

  galaxies.push({
    id,
    ...(COMMON_NAMES[id] ? { name: COMMON_NAMES[id] } : {}),
    ra: round(record.ra, 5),
    dec: round(record.dec, 5),
    d: sig3(dist),
    dm: method,
    mag: round(mag, 2),
    aMaj: round(maj, 5),
    aMin: round(min, 5),
    ...(pa != null ? { pa: round(pa, 5) } : {}),
    ...(morph ? { morph } : {}),
    p: equatorialToVec(record.ra, record.dec).map((v) => round(v, 6)),
  });
}

galaxies.sort((a, b) => a.d - b.d);

const payload = {
  sources: [
    'Karachentsev+ 2013, Updated Nearby Galaxy Catalog (VizieR J/AJ/145/101)',
    'Tully+ 2016, Cosmicflows-3 (VizieR J/AJ/152/50)',
    'de Vaucouleurs+ 1991, RC3 (VizieR VII/155)',
    'Paturel+ 2003, HyperLEDA/PGC (VizieR VII/237)',
  ],
  retrieved: new Date().toISOString().slice(0, 10),
  h0: H0,
  frame: 'equatorial J2000, +Y to the north celestial pole, RA increasing to -Z',
  galaxies,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload));

// -------------------------------------------------------------------- summary

const measured = galaxies.filter((g) => g.dm === 'ri').length;
const nearest = galaxies[0];
const farthest = galaxies[galaxies.length - 1];
const size = fs.statSync(OUT).size;

console.log(`  ${dropped} dropped for want of a distance, magnitude or size`);
console.log(`${galaxies.length} galaxies`);
console.log(
  `  ${nearest.d} Mpc (${nearest.id}) to ${farthest.d} Mpc (${farthest.id})`,
);
console.log(
  `  ${measured} redshift-independent, ${galaxies.length - measured} from Hubble's law at H0 = ${H0}`,
);
console.log(`  ${galaxies.filter((g) => g.pa != null).length} with a position angle`);
console.log(`wrote ${path.relative(ROOT, OUT)} ${(size / 1024).toFixed(0)} KB`);

// A build that quietly loses Andromeda is worse than one that fails, so the
// galaxies anyone will actually look for are checked by name.
const EXPECTED = [
  'LMC',
  'SMC',
  'Sagittarius Dwarf',
  'Fornax Dwarf',
  'Sculptor Dwarf',
  'Draco Dwarf',
  'Ursa Minor Dwarf',
  'NGC 224',
  'NGC 253',
  'NGC 598',
  'NGC 3031',
  'NGC 3034',
  'NGC 4038',
  'NGC 4039',
  'NGC 4486',
  'NGC 4594',
  'NGC 5128',
  'NGC 5194',
  'NGC 5457',
];
const present = new Set(galaxies.map((g) => g.id));
const absent = EXPECTED.filter((id) => !present.has(id));
if (absent.length) console.warn(`  MISSING: ${absent.join(', ')}`);
else console.log(`  all ${EXPECTED.length} landmark galaxies present`);
