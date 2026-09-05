/**
 * Spacecraft trajectories from JPL Horizons.
 *
 * Horizons publishes fitted trajectory solutions for most flown spacecraft in
 * the same frame this renderer uses: ecliptic of J2000, kilometres, Sun-centred
 * or planet-centred on request. So for the craft it covers there is no need to
 * model anything. The measured path can be sampled and interpolated, and the
 * date the user picks lands the spacecraft where it actually was.
 *
 *   node scripts/craft-fetch.mjs --probe        what Horizons has, and when
 *   node scripts/craft-fetch.mjs                fetch and build the tables
 *
 * Raw responses are cached under data-src/horizons/ (gitignored) so a rebuild
 * costs nothing and the API is only asked once per segment.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'data-src', 'horizons');
const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';

/**
 * Horizons centre codes. '500@n' is the body centre of major body n, which is
 * what parent-relative sampling wants: the renderer adds the parent's own
 * position, exactly as it does for moons.
 */
export const CENTRES = {
  sun: '500@10',
  mercury: '500@199',
  venus: '500@299',
  earth: '500@399',
  moon: '500@301',
  mars: '500@499',
  jupiter: '500@599',
  saturn: '500@699',
  uranus: '500@799',
  neptune: '500@899',
  pluto: '500@999',
};

/** Candidate roster. The probe decides which of these Horizons actually has. */
const ROSTER = [
  { key: 'voyager1', id: '-31', label: 'Voyager 1' },
  { key: 'voyager2', id: '-32', label: 'Voyager 2' },
  { key: 'pioneer10', id: '-23', label: 'Pioneer 10' },
  { key: 'pioneer11', id: '-24', label: 'Pioneer 11' },
  { key: 'new-horizons', id: '-98', label: 'New Horizons' },
  { key: 'cassini', id: '-82', label: 'Cassini' },
  { key: 'huygens', id: '-150', label: 'Huygens probe' },
  { key: 'galileo', id: '-77', label: 'Galileo' },
  { key: 'juno', id: '-61', label: 'Juno' },
  { key: 'magellan', id: '-18', label: 'Magellan' },
  { key: 'messenger', id: '-236', label: 'MESSENGER' },
  { key: 'dawn', id: '-203', label: 'Dawn' },
  { key: 'osiris-rex', id: '-64', label: 'OSIRIS-REx / APEX' },
  { key: 'hayabusa', id: '-130', label: 'Hayabusa' },
  { key: 'hayabusa2', id: '-37', label: 'Hayabusa2' },
  { key: 'rosetta', id: '-226', label: 'Rosetta' },
  { key: 'parker', id: '-96', label: 'Parker Solar Probe' },
  { key: 'solar-orbiter', id: '-144', label: 'Solar Orbiter' },
  { key: 'lucy', id: '-49', label: 'Lucy' },
  { key: 'psyche', id: '-255', label: 'Psyche' },
  { key: 'bepicolombo', id: '-121', label: 'BepiColombo' },
  { key: 'juice', id: '-28', label: 'JUICE' },
  { key: 'europa-clipper', id: '-159', label: 'Europa Clipper' },
  { key: 'ulysses', id: '-55', label: 'Ulysses' },
  { key: 'stardust', id: '-29', label: 'Stardust' },
  { key: 'deep-impact', id: '-140', label: 'Deep Impact' },
  { key: 'genesis', id: '-47', label: 'Genesis' },
  { key: 'akatsuki', id: '-5', label: 'Akatsuki' },
  { key: 'venus-express', id: '-248', label: 'Venus Express' },
  { key: 'mars-express', id: '-41', label: 'Mars Express' },
  { key: 'maven', id: '-202', label: 'MAVEN' },
  { key: 'mro', id: '-74', label: 'Mars Reconnaissance Orbiter' },
  { key: 'odyssey', id: '-53', label: 'Mars Odyssey' },
  { key: 'curiosity', id: '-76', label: 'Curiosity (MSL)' },
  { key: 'perseverance', id: '-168', label: 'Perseverance (Mars 2020)' },
  { key: 'insight', id: '-189', label: 'InSight' },
  { key: 'viking1', id: '-27', label: 'Viking 1' },
  { key: 'viking2', id: '-30', label: 'Viking 2' },
  { key: 'lro', id: '-85', label: 'Lunar Reconnaissance Orbiter' },
  { key: 'iss', id: '-125544', label: 'ISS' },
  { key: 'hubble', id: '-48', label: 'Hubble' },
  { key: 'jwst', id: '-170', label: 'JWST' },
  { key: 'tess', id: '-95', label: 'TESS' },
  { key: 'kepler', id: '-227', label: 'Kepler' },
  { key: 'gaia', id: '-139', label: 'Gaia' },
  { key: 'spitzer', id: '-79', label: 'Spitzer' },
  { key: 'chandra', id: '-151', label: 'Chandra' },
  { key: 'apollo11', id: '-911', label: 'Apollo 11 (guess)' },
  { key: 'apollo12', id: '-912', label: 'Apollo 12 (guess)' },
  { key: 'apollo17', id: '-917', label: 'Apollo 17 (guess)' },
  { key: 'artemis1', id: '-155', label: 'Artemis 1 / Orion (guess)' },
  { key: 'chandrayaan2', id: '-158', label: 'Chandrayaan-2 (guess)' },
  { key: 'tianwen1', id: '-49900', label: 'Tianwen-1 (guess)' },
];

function cachePath(name) {
  return path.join(CACHE, `${name}.txt`);
}

/**
 * A roster date as milliseconds UTC, with or without a time on it.
 *
 * A segment sometimes has to start at an hour rather than a day, because a
 * spacecraft's ephemeris can begin at separation rather than at launch and
 * Horizons refuses a whole request that starts one record early.
 */
function utc(stamp) {
  const ms = Date.parse(stamp.includes('T') ? `${stamp}Z` : `${stamp}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`unparseable date "${stamp}"`);
  return ms;
}

/** GET with a disk cache, sequential by construction so the API is asked gently. */
async function horizons(name, params) {
  const file = cachePath(name);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    return fs.readFileSync(file, 'utf8');
  }
  const query = new URLSearchParams({ format: 'text', ...params });
  const response = await fetch(`${API}?${query}`, {
    headers: { 'user-agent': 'cosminova asset fetch' },
  });
  const body = await response.text();
  if (!response.ok && !body.includes('$$SOE') && !body.includes('Trajectory files')) {
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, body);
  return body;
}

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** 'A.D. 1977-SEP-05 13:59:24.3830 TDB' -> ISO string. */
function parseHorizonsDate(raw) {
  const m = /(\d{4})-([A-Z]{3})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?))?/.exec(raw);
  if (!m) return null;
  const ms = Date.UTC(
    Number(m[1]), MONTHS[m[2]], Number(m[3]),
    Number(m[4] ?? 0), Number(m[5] ?? 0), Math.floor(Number(m[6] ?? 0)),
  );
  return new Date(ms).toISOString();
}

/**
 * Horizons refuses dates outside a spacecraft's trajectory and says exactly
 * where the edge is, so asking for an impossible date is how you learn the
 * coverage. Two queries bracket it: one before the start, one after the end.
 */
function parseEdge(text) {
  const before = /No ephemeris for target "([^"]+)"\s+prior to\s+(.+?)\s*$/m.exec(text);
  if (before) return { kind: 'start', name: before[1], at: parseHorizonsDate(before[2]) };
  const after = /No ephemeris for target "([^"]+)"\s+after\s+(.+?)\s*$/m.exec(text);
  if (after) return { kind: 'stop', name: after[1], at: parseHorizonsDate(after[2]) };
  return null;
}

function looksUnknown(text) {
  return /No matches found|Cannot interpret|Unknown target|No such record|No site matches/i.test(text);
}

async function edgeQuery(name, id, start, stop) {
  return horizons(name, {
    COMMAND: `'${id}'`,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    CENTER: `'${CENTRES.sun}'`,
    START_TIME: `'${start}'`,
    STOP_TIME: `'${stop}'`,
    STEP_SIZE: `'1d'`,
    VEC_TABLE: `'2'`,
    OUT_UNITS: `'KM-S'`,
  });
}

async function probe() {
  console.log('Asking Horizons what it holds for each spacecraft.\n');
  const found = [];
  const missing = [];
  for (const entry of ROSTER) {
    const low = await edgeQuery(`edge-lo-${entry.key}`, entry.id, '1900-01-01', '1900-01-02');
    if (looksUnknown(low)) {
      missing.push({ ...entry, why: 'not in Horizons' });
      console.log(`  --    ${entry.label.padEnd(30)} not in Horizons`);
      continue;
    }
    const lowEdge = parseEdge(low);
    if (!lowEdge || lowEdge.kind !== 'start') {
      missing.push({ ...entry, why: 'could not read coverage start' });
      console.log(`  ??    ${entry.label.padEnd(30)} could not read coverage`);
      continue;
    }
    const from = lowEdge.at;
    const dayAfter = new Date(Date.parse(from) + 86400e3).toISOString().slice(0, 10);
    const high = await edgeQuery(`edge-hi-${entry.key}`, entry.id, dayAfter, '2300-01-01');
    const highEdge = parseEdge(high);
    const to = highEdge?.kind === 'stop' ? highEdge.at : null;
    found.push({ ...entry, horizonsName: lowEdge.name, from, to });
    console.log(
      `  ok    ${entry.label.padEnd(30)} ${from.slice(0, 10)} to ${to ? to.slice(0, 10) : '2300+'}`
      + `   ${lowEdge.name}`,
    );
  }
  console.log(`\n${found.length} with real ephemeris, ${missing.length} without.`);
  for (const m of missing) console.log(`   no data: ${m.label} (${m.id}) — ${m.why}`);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(
    path.join(CACHE, 'coverage.json'),
    `${JSON.stringify({ retrieved: new Date().toISOString(), found, missing }, null, 2)}\n`,
  );
  console.log(`\nWrote ${path.relative(ROOT, path.join(CACHE, 'coverage.json'))}`);
}

// ---------------------------------------------------------------- fetching

const MINUTES = { m: 1, h: 60, d: 1440, y: 525600 };

function stepMinutes(step) {
  const m = /^(\d+(?:\.\d+)?)\s*([mhdy])$/.exec(step);
  if (!m) throw new Error(`bad step "${step}"`);
  return Number(m[1]) * MINUTES[m[2]];
}

const DAY_MS = 86400e3;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

function toJ2000Days(ms) {
  return (ms - J2000_MS) / DAY_MS;
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Horizons caps a single request at about 90,000 records, and a fine step over
 * a long mission blows through that, so long spans are asked for in pieces.
 */
const MAX_RECORDS = 40000;

/**
 * One vectors request. Horizons rejects dates outside a craft's trajectory and
 * names the edge in the error, so a rejection is clamped and retried rather
 * than treated as a failure: it is how the true coverage gets found.
 */
async function vectorsChunk(cacheName, id, centre, startMs, stopMs, step, depth = 0) {
  const text = await horizons(cacheName, {
    COMMAND: `'${id}'`,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    VEC_TABLE: `'2'`,
    VEC_CORR: `'NONE'`,
    CENTER: `'${centre}'`,
    REF_PLANE: `'ECLIPTIC'`,
    REF_SYSTEM: `'J2000'`,
    OUT_UNITS: `'KM-S'`,
    CSV_FORMAT: `'YES'`,
    START_TIME: `'${isoDay(startMs)}'`,
    STOP_TIME: `'${isoDay(stopMs)}'`,
    STEP_SIZE: `'${step}'`,
  });

  const edge = depth < 3 ? parseEdge(text) : null;
  if (edge?.at) {
    const at = Date.parse(edge.at);
    // Nudge inside the boundary; Horizons is exclusive about the exact instant.
    if (edge.kind === 'start' && at > startMs && at < stopMs) {
      fs.rmSync(cachePath(cacheName), { force: true });
      return vectorsChunk(cacheName, id, centre, at + 60e3, stopMs, step, depth + 1);
    }
    if (edge.kind === 'stop' && at < stopMs && at > startMs) {
      fs.rmSync(cachePath(cacheName), { force: true });
      return vectorsChunk(cacheName, id, centre, startMs, at - 60e3, step, depth + 1);
    }
    return [];
  }
  return parseVectors(text);
}

/**
 * CSV rows are: JDTDB, calendar date, X, Y, Z, VX, VY, VZ.
 *
 * The frame is converted here rather than in the browser, matching the rest of
 * this pipeline. Horizons ecliptic coordinates have +z towards ecliptic north;
 * the renderer is Y-up, so the mapping is (x, z, -y), which is the same one
 * universe.js applies to the planets.
 */
function parseVectors(text) {
  const start = text.indexOf('$$SOE');
  const end = text.indexOf('$$EOE');
  if (start < 0 || end < 0) return [];
  const body = text.slice(start + 5, end).trim();
  if (!body) return [];
  const out = [];
  for (const line of body.split('\n')) {
    const f = line.split(',');
    if (f.length < 8) continue;
    const jd = Number(f[0]);
    if (!Number.isFinite(jd)) continue;
    const x = Number(f[2]); const y = Number(f[3]); const z = Number(f[4]);
    const vx = Number(f[5]); const vy = Number(f[6]); const vz = Number(f[7]);
    if (!Number.isFinite(x) || !Number.isFinite(vx)) continue;
    out.push({
      t: jd - 2451545.0,
      p: [x, z, -y],
      v: [vx, vz, -vy],
    });
  }
  return out;
}

/**
 * A craft can change how it is best described partway through its mission.
 * Cruising to Mars is a smooth arc that a spline fits in a few dozen samples;
 * the mapping orbit afterwards is a two-hour ellipse repeated for twenty years,
 * which no spline can hold at any sane file size. So mode is per segment: the
 * cruise is sampled as a path, the orbit as osculating elements.
 */
function segmentMode(craft, seg) {
  return seg.mode ?? craft.mode ?? 'path';
}

/** Merge new samples into a sorted list, keeping it sorted and unique in t. */
function mergeSamples(into, extra) {
  if (extra.length === 0) return into;
  const all = into.concat(extra);
  all.sort((a, b) => a.t - b.t);
  const out = [all[0]];
  for (let i = 1; i < all.length; i++) {
    if (all[i].t - out[out.length - 1].t > 1e-9) out.push(all[i]);
  }
  return out;
}

function turnAngle(a, b) {
  const la = Math.hypot(a.v[0], a.v[1], a.v[2]);
  const lb = Math.hypot(b.v[0], b.v[1], b.v[2]);
  if (la === 0 || lb === 0) return 0;
  const dot = (a.v[0] * b.v[0] + a.v[1] * b.v[1] + a.v[2] * b.v[2]) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

/**
 * Where a fixed cadence is too coarse to see the trajectory bend.
 *
 * A flyby is the whole point of a mission and lasts hours inside a cruise
 * sampled every five days, so sampling evenly either misses every encounter or
 * downloads a decade of straight line at encounter resolution. Instead the
 * velocity is asked how fast it is turning: where the direction swings more
 * than a few degrees between samples, or the speed changes by more than a few
 * per cent, the interval is refetched finer. Voyager finds Jupiter and Saturn
 * this way, and Parker finds all twenty-four of its perihelia, without either
 * being told where to look.
 */
function underResolved(samples, maxTurn = 0.05, maxSpeedRatio = 0.04) {
  const spans = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const la = Math.hypot(a.v[0], a.v[1], a.v[2]);
    const lb = Math.hypot(b.v[0], b.v[1], b.v[2]);
    const speedChange = la > 0 ? Math.abs(lb - la) / la : 0;
    if (turnAngle(a, b) > maxTurn || speedChange > maxSpeedRatio) {
      spans.push([a.t, b.t]);
    }
  }
  // Coalesce touching spans so one encounter is one request.
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] - last[1] < 1e-9) last[1] = span[1];
    else merged.push([...span]);
  }
  return merged;
}

async function fetchSegment(craft, seg, index) {
  const centre = CENTRES[seg.centre];
  if (!centre) throw new Error(`${craft.key}: unknown centre "${seg.centre}"`);
  const from = utc(seg.from ?? craft.launched);
  const to = utc(seg.to ?? '2100-01-01');
  const baseStep = seg.step ?? '1d';
  const stepMin = stepMinutes(baseStep);

  let samples = [];
  const chunkMs = MAX_RECORDS * stepMin * 60e3;
  let cursor = from;
  let piece = 0;
  while (cursor < to) {
    const stop = Math.min(to, cursor + chunkMs);
    const name = `vec-${craft.key}-${index}-${piece}`;
    let got;
    try {
      got = await vectorsChunk(name, craft.horizons, centre, cursor, stop, baseStep);
    } catch (err) {
      console.log(`      chunk ${piece} failed: ${err.message}`);
      got = [];
    }
    if (got.length === 0 && samples.length > 0) break;
    samples = mergeSamples(samples, got);
    cursor = stop;
    piece += 1;
    if (piece > 200) break;
  }
  if (samples.length < 2 || segmentMode(craft, seg) === 'elements') return samples;

  // Refinement. Each pass divides the cadence by eight in the intervals that
  // need it, so three passes reach a five-hundredth of the base step.
  let refined = 0;
  let currentStep = stepMin;
  for (let pass = 0; pass < 3; pass++) {
    const spans = underResolved(samples);
    if (spans.length === 0) break;
    const nextStep = Math.max(0.5, currentStep / 8);
    let piece2 = 0;
    for (const [t0, t1] of spans.slice(0, 400)) {
      const startMs = J2000_MS + t0 * DAY_MS;
      const stopMs = J2000_MS + t1 * DAY_MS;
      const stepLabel = nextStep >= 1 ? `${Math.round(nextStep)}m` : '1m';
      const name = `ref-${craft.key}-${index}-${pass}-${piece2}`;
      piece2 += 1;
      try {
        const got = await vectorsChunk(name, craft.horizons, centre, startMs, stopMs, stepLabel);
        if (got.length) {
          samples = mergeSamples(samples, got);
          refined += got.length;
        }
      } catch {
        // A refusal here just means the interval sits outside coverage.
      }
    }
    currentStep = nextStep;
  }
  if (refined) samples.refined = refined;
  return samples;
}

// -------------------------------------------------------------- decimation

/** Cubic Hermite between two states, with time in days and velocity in km/s. */
function hermite(a, b, t, out) {
  const h = (b.t - a.t) * 86400;
  const s = h === 0 ? 0 : ((t - a.t) * 86400) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  for (let i = 0; i < 3; i++) {
    out[i] = h00 * a.p[i] + h10 * h * a.v[i] + h01 * b.p[i] + h11 * h * b.v[i];
  }
  return out;
}

/**
 * Drops every sample the spline can reproduce.
 *
 * A cruise between planets is close to a straight line for months at a time and
 * needs almost no samples; a periapsis pass swings through in hours and needs
 * many. Testing the interpolation error rather than fixing a cadence puts the
 * samples where the trajectory actually bends, which is what makes a thirteen-
 * year Saturn tour fit in a file worth shipping.
 *
 * The tolerance scales with distance from the centre, so it is tight near a
 * planet and loose out in the cruise, but it is capped. Without the cap the
 * allowance out at Jupiter is 150,000 km, which is wider than the whole
 * gravity assist, and Voyager's encounters get smoothed into the straight line
 * they interrupt.
 */
function decimate(samples, relTol = 2e-4, absTolKm = 0.02, capKm = 500) {
  if (samples.length < 3) return samples;
  const kept = [samples[0]];
  const probe = [0, 0, 0];
  let anchor = 0;
  while (anchor < samples.length - 1) {
    let best = anchor + 1;
    for (let end = anchor + 2; end < samples.length; end++) {
      let ok = true;
      for (let i = anchor + 1; i < end; i++) {
        hermite(samples[anchor], samples[end], samples[i].t, probe);
        const p = samples[i].p;
        const err = Math.hypot(probe[0] - p[0], probe[1] - p[1], probe[2] - p[2]);
        const scale = Math.hypot(p[0], p[1], p[2]);
        const tol = Math.min(capKm, Math.max(absTolKm, relTol * scale));
        if (err > tol) { ok = false; break; }
      }
      if (!ok) break;
      best = end;
      // Doubling the reach would make this O(n log n), but spans stay short
      // near a planet and the check is cheap; a cap keeps the worst case sane.
      if (end - anchor > 4096) break;
    }
    kept.push(samples[best]);
    anchor = best;
  }
  return kept;
}

// ------------------------------------------------------------------- build

async function build() {
  const all = (await import('../src/engine/craft-missions.js')).MISSIONS;
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
  const MISSIONS = only ? all.filter((m) => only.includes(m.key)) : all;
  console.log(`Sampling ${MISSIONS.length} spacecraft trajectories from Horizons.\n`);

  const times = [];
  const pos = [];
  const vel = [];
  const records = [];
  let cursor = 0;

  for (const craft of MISSIONS) {
    if (!craft.horizons) continue;
    const segments = [];
    for (let i = 0; i < craft.path.length; i++) {
      const seg = craft.path[i];
      const raw = await fetchSegment(craft, seg, i);
      if (raw.length < 2) {
        console.log(`  --    ${craft.name} segment ${i} (${seg.centre}): no samples`);
        continue;
      }
      // Element-mode samples are osculating states propagated at runtime, so
      // the spline tolerance does not apply to them.
      const mode = segmentMode(craft, seg);
      const kept = mode === 'elements' ? raw : decimate(raw);
      segments.push({
        centre: seg.centre,
        mode,
        offset: cursor,
        count: kept.length,
        from: kept[0].t,
        to: kept[kept.length - 1].t,
      });
      for (const s of kept) {
        times.push(s.t);
        pos.push(s.p[0], s.p[1], s.p[2]);
        vel.push(s.v[0], s.v[1], s.v[2]);
      }
      cursor += kept.length;
      const pct = raw.length ? Math.round((kept.length / raw.length) * 100) : 0;
      console.log(
        `  ok    ${craft.name.padEnd(32)} ${seg.centre.padEnd(8)}`
        + ` ${String(kept.length).padStart(6)} of ${String(raw.length).padStart(7)} (${pct}%)`,
      );
    }
    if (segments.length === 0) continue;
    records.push({ key: craft.key, horizons: craft.horizons, segments });
  }

  const timeArray = Float64Array.from(times);
  const posArray = Float32Array.from(pos);
  const velArray = Float32Array.from(vel);
  const bin = Buffer.concat([
    Buffer.from(timeArray.buffer),
    Buffer.from(posArray.buffer),
    Buffer.from(velArray.buffer),
  ]);

  const outDir = path.join(ROOT, 'public', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'craft-paths.bin'), bin);

  const meta = {
    source: 'JPL Horizons, spacecraft trajectory solutions',
    retrieved: new Date().toISOString().slice(0, 10),
    frame: 'Ecliptic J2000, rotated to the renderer world frame (x, z, -y). Kilometres and km/s, relative to each segment centre.',
    epoch: 'times are days from J2000 TDB',
    samples: timeArray.length,
    layout: [
      { name: 'time', type: 'f64', components: 1 },
      { name: 'position', type: 'f32', components: 3 },
      { name: 'velocity', type: 'f32', components: 3 },
    ],
    craft: records,
  };
  fs.writeFileSync(path.join(outDir, 'craft-paths.json'), `${JSON.stringify(meta)}\n`);

  const mb = (bin.length / 1048576).toFixed(2);
  console.log(`\n${records.length} craft, ${timeArray.length} samples, ${mb} MB`);
  console.log(`Wrote public/data/craft-paths.bin and craft-paths.json`);
}

if (process.argv.includes('--probe')) {
  await probe();
} else {
  await build();
}
