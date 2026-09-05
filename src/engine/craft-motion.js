import { Matrix4, Quaternion, Vector3 } from 'three';
import { DEG, dateToJulianDay, J2000 } from '../astro.js';
import { equatorialToEcliptic } from './units.js';
import { MISSIONS, MISSION_BY_KEY, landingSiteMissions } from './craft-missions.js';
import { CRAFT_BY_KEY, LANDING_SITES } from './craft-data.js';

/**
 * Where every spacecraft is, at whatever date the universe is showing.
 *
 * Three kinds of motion share one interface, because three kinds of data are
 * available and pretending otherwise would mean either throwing away the good
 * data or inventing the missing data:
 *
 *   path      Sampled state vectors from a Horizons trajectory solution,
 *             interpolated with a cubic Hermite spline. The spline is given
 *             both endpoints' velocities, so it reproduces a measured
 *             trajectory to well inside a kilometre from samples days apart.
 *
 *   elements  A repeating orbit, held as osculating states sampled every day
 *             or two and solved as a Kepler orbit in between. A twenty-year
 *             mapping orbit is a two-hour ellipse flown eighty thousand times;
 *             no table of positions is the right way to store that. Secular
 *             J2 rates are included, because without them an orbit plane that
 *             regresses five degrees a day is visibly wrong within a day.
 *
 *   surface   Fixed to a body at a measured latitude and longitude.
 *
 * Everything is relative to a centre body, and the centre's own position is
 * added at evaluation time. That is deliberate: this app's planets come from
 * approximate Keplerian elements rather than DE441, so a Mars orbiter sampled
 * relative to Mars stays correctly placed around Mars even though Mars itself
 * is a few thousand kilometres from where DE441 would put it. Sampling
 * everything heliocentrically would put the orbiter in the right absolute
 * place and the wrong place relative to the only thing you can see.
 *
 * ATTITUDE IS NOT DATA. Horizons publishes trajectories, not orientations.
 * Every spacecraft here is turned to face along its velocity with its panels
 * towards the Sun, which is roughly what most of them do and exactly what none
 * of them do. It is illustrative, and the inspector says so.
 */

const DAY_S = 86400;

/** Gravitational parameters, km^3/s^2. */
const MU = {
  sun: 1.32712440018e11,
  mercury: 2.2032e4,
  venus: 3.24859e5,
  earth: 3.986004418e5,
  moon: 4.9028e3,
  mars: 4.282837e4,
  jupiter: 1.26686534e8,
  saturn: 3.7931187e7,
  uranus: 5.793939e6,
  neptune: 6.836529e6,
  pluto: 8.71e2,
};

/** Oblateness, for the secular drift of an orbit plane. */
const OBLATE = {
  earth: { j2: 1.08263e-3, r: 6378.137 },
  mars: { j2: 1.96045e-3, r: 3396.19 },
  moon: { j2: 2.033e-4, r: 1737.4 },
  mercury: { j2: 5.03e-5, r: 2439.7 },
  venus: { j2: 4.458e-6, r: 6051.8 },
  jupiter: { j2: 1.4736e-2, r: 71492 },
  saturn: { j2: 1.6298e-2, r: 60268 },
  uranus: { j2: 3.343e-3, r: 25559 },
  neptune: { j2: 3.411e-3, r: 24764 },
};

export function daysFromJ2000(date) {
  return dateToJulianDay(date) - J2000;
}

function dayOf(iso) {
  return iso ? (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(2000, 0, 1, 12)) / 86400e3 : null;
}

// ------------------------------------------------------------------- Kepler

function solveKepler(M, e) {
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 40; i++) {
    const f = E - e * Math.sin(E) - M;
    const d = 1 - e * Math.cos(E);
    const step = f / d;
    E -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  return E;
}

function solveHyperbolic(M, e) {
  let H = Math.sign(M) * Math.log(2 * Math.abs(M) / e + 1.8);
  for (let i = 0; i < 60; i++) {
    const f = e * Math.sinh(H) - H - M;
    const d = e * Math.cosh(H) - 1;
    const step = f / d;
    H -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  return H;
}

/**
 * State vector to classical elements. Returns null for a degenerate state,
 * which is how a sample taken during a burn or at a patch point shows up.
 */
function stateToElements(px, py, pz, vx, vy, vz, mu) {
  const r = Math.hypot(px, py, pz);
  const v2 = vx * vx + vy * vy + vz * vz;
  if (!(r > 0) || !Number.isFinite(v2)) return null;

  // Angular momentum, and the node vector from it.
  const hx = py * vz - pz * vy;
  const hy = pz * vx - px * vz;
  const hz = px * vy - py * vx;
  const h = Math.hypot(hx, hy, hz);
  if (!(h > 0)) return null;

  const energy = v2 / 2 - mu / r;
  const a = -mu / (2 * energy);
  const rv = px * vx + py * vy + pz * vz;

  // Eccentricity vector.
  const c = v2 - mu / r;
  const ex = (c * px - rv * vx) / mu;
  const ey = (c * py - rv * vy) / mu;
  const ez = (c * pz - rv * vz) / mu;
  const e = Math.hypot(ex, ey, ez);

  // The world frame is Y-up, so ecliptic north is +Y and the node line is the
  // intersection with the XZ plane.
  const inc = Math.acos(Math.max(-1, Math.min(1, hy / h)));
  const nx = -hz;
  const nz = hx;
  const nLen = Math.hypot(nx, nz);

  let raan = nLen > 1e-9 ? Math.atan2(nx, nz) : 0;
  let argp;
  if (nLen > 1e-9 && e > 1e-9) {
    const cosArg = (nx * ex + nz * ez) / (nLen * e);
    argp = Math.acos(Math.max(-1, Math.min(1, cosArg)));
    if (ey < 0) argp = -argp;
  } else {
    argp = 0;
  }

  // True anomaly. A circular orbit has no periapsis to measure from, so the
  // angle is taken from the ascending node instead and the argument of
  // periapsis is left at zero: the same orbit, described from a place that
  // exists.
  let nu;
  if (e > 1e-9) {
    const cosNu = (ex * px + ey * py + ez * pz) / (e * r);
    nu = Math.acos(Math.max(-1, Math.min(1, cosNu)));
    if (rv < 0) nu = -nu;
  } else if (nLen > 1e-9) {
    const cosU = (nx * px + nz * pz) / (nLen * r);
    nu = Math.acos(Math.max(-1, Math.min(1, cosU)));
    if (py < 0) nu = -nu;
  } else {
    nu = Math.atan2(pz, px);
  }

  let M;
  if (e < 1) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    M = E - e * Math.sin(E);
  } else {
    const H = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
    M = e * Math.sinh(H) - H;
  }

  return { a, e, inc, raan, argp, M, mu };
}

const _perifocal = new Vector3();
const _rotQ = new Quaternion();
const _axisY = new Vector3(0, 1, 0);
const _axisX = new Vector3(1, 0, 0);

/** Elements to a state vector, dt seconds after the element epoch. */
function elementsToState(el, dt, centre, out, outVel) {
  const { a, e, mu } = el;
  let { inc, raan, argp, M } = el;

  if (e < 1) {
    const n = Math.sqrt(mu / (a * a * a));
    // Secular J2 drift. An orbit plane around Earth regresses several degrees
    // a day, so leaving this out makes a satellite sampled two days ago come
    // out in visibly the wrong plane.
    const ob = OBLATE[centre];
    if (ob && a > 0) {
      const p = a * (1 - e * e);
      const f = 1.5 * n * ob.j2 * (ob.r / p) * (ob.r / p);
      const cosI = Math.cos(inc);
      raan += -f * cosI * dt;
      argp += 0.5 * f * (5 * cosI * cosI - 1) * dt;
      M += 0.5 * f * Math.sqrt(Math.max(0, 1 - e * e)) * (3 * cosI * cosI - 1) * dt;
    }
    M += n * dt;
    const E = solveKepler(M, e);
    const xo = a * (Math.cos(E) - e);
    const yo = a * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);
    const r = a * (1 - e * Math.cos(E));
    const rate = Math.sqrt(mu * a) / r;
    _perifocal.set(xo, 0, yo);
    if (outVel) outVel.set(-rate * Math.sin(E), 0, rate * Math.sqrt(Math.max(0, 1 - e * e)) * Math.cos(E));
  } else {
    const n = Math.sqrt(mu / (-a * -a * -a));
    M += n * dt;
    const H = solveHyperbolic(M, e);
    const xo = a * (e - Math.cosh(H));
    const yo = -a * Math.sqrt(e * e - 1) * Math.sinh(H);
    const r = a * (1 - e * Math.cosh(H));
    const rate = Math.sqrt(mu * -a) / r;
    _perifocal.set(xo, 0, yo);
    if (outVel) outVel.set(-rate * Math.sinh(H), 0, rate * Math.sqrt(e * e - 1) * Math.cosh(H));
  }

  // Perifocal to world: argument of periapsis about the orbit normal, then
  // inclination about the node, then the node about ecliptic north.
  _rotQ.setFromAxisAngle(_axisY, argp);
  _perifocal.applyQuaternion(_rotQ);
  if (outVel) outVel.applyQuaternion(_rotQ);
  _rotQ.setFromAxisAngle(_axisX, inc);
  _perifocal.applyQuaternion(_rotQ);
  if (outVel) outVel.applyQuaternion(_rotQ);
  _rotQ.setFromAxisAngle(_axisY, raan);
  _perifocal.applyQuaternion(_rotQ);
  if (outVel) outVel.applyQuaternion(_rotQ);

  out.copy(_perifocal);
  return out;
}

// -------------------------------------------------------------- table lookup

/** Binary search for the last sample at or before t. */
function findSample(times, lo, hi, t) {
  let a = lo;
  let b = hi;
  while (b - a > 1) {
    const mid = (a + b) >> 1;
    if (times[mid] <= t) a = mid;
    else b = mid;
  }
  return a;
}

// -------------------------------------------------------------------- field

/**
 * One spacecraft's live state. Reused between frames rather than reallocated,
 * because there are a hundred of these and they are recomputed every frame.
 */
class CraftState {
  constructor(spec) {
    this.spec = spec;
    this.key = spec.key;
    this.position = new Vector3();
    /**
     * The same place as `position`, as an offset from the centre body.
     *
     * Both are kept because they fail at opposite ends: the absolute position is
     * what distances and trajectories are measured in, but two absolute
     * positions subtracted lose everything below their own spacing, which is
     * five centimetres at Mars and thirty metres around another star. Drawing a
     * three-metre probe needs the offset that was never added to a big number.
     */
    this.local = new Vector3();
    this.velocity = new Vector3();
    this.orientation = new Quaternion();
    this.centre = 'sun';
    this.centreKey = 'sun';
    this.present = false;
    this.phase = '';
    this.onSurface = false;
    this.speedKms = 0;
    /** Measured elevation of the ground under it, km, or null off a surface. */
    this.groundKm = null;
    /**
     * How this position was arrived at, this frame: 'surface', 'path',
     * 'elements' or 'fallback'. The provenance shown to the user comes from
     * this rather than from the mission record, because one craft can be a
     * fitted cruise, then a Kepler orbit, then a fixed point on the ground.
     * @type {string|null}
     */
    this.source = null;
  }
}

export class CraftField {
  constructor({ table = null, meta = null, extra = [] } = {}) {
    this.table = table;
    /**
     * `(bodyKey, dirInBodyFrame) => km | null`: measured elevation above the
     * reference radius, so anything on a surface sits on the ground that is
     * actually drawn rather than on the sphere it is drawn from. Set by the app,
     * because the elevation maps belong to the renderer.
     * @type {((body: string, dir: Vector3) => number|null)|null}
     */
    this.groundKm = null;
    this.byKey = new Map();
    this.states = new Map();
    this.list = [];

    const specs = MISSIONS.concat(landingSiteMissions(LANDING_SITES), extra);
    this.specs = specs;
    for (const spec of specs) {
      const state = new CraftState(spec);
      this.states.set(spec.key, state);
      this.list.push(state);
    }
    if (meta) {
      for (const rec of meta.craft) this.byKey.set(rec.key, rec);
    }

    this._p = new Vector3();
    this._v = new Vector3();
    this._toSun = new Vector3();
    this._right = new Vector3();
    this._up = new Vector3();
    this._fwd = new Vector3();
    this._surfaceDir = new Vector3();
  }

  /**
   * Loads the sampled trajectories. The binary is one block of f64 times then
   * two blocks of f32 vectors, matching the layout stars.bin uses: parallel
   * arrays rather than interleaved records, so each can be a typed-array view
   * straight onto the buffer with no copying.
   */
  static async load(base = '', { extra = [] } = {}) {
    let meta = null;
    let table = null;
    try {
      const metaResponse = await fetch(`${base}data/craft-paths.json`);
      if (metaResponse.ok) {
        meta = await metaResponse.json();
        const binResponse = await fetch(`${base}data/craft-paths.bin`);
        if (binResponse.ok) {
          const buffer = await binResponse.arrayBuffer();
          const n = meta.samples;
          const times = new Float64Array(buffer, 0, n);
          const pos = new Float32Array(buffer, n * 8, n * 3);
          const vel = new Float32Array(buffer, n * 8 + n * 12, n * 3);
          table = { times, pos, vel };
        }
      }
    } catch {
      // No trajectory file: the field still works from the Keplerian elements
      // and landing sites in craft-data.js, with fewer craft and less accuracy.
    }
    return new CraftField({ table, meta, extra });
  }

  get(key) {
    return this.states.get(key);
  }

  /** Every craft's live state, present or not. */
  all() {
    return this.states.values();
  }

  /**
   * Registers craft that were not in the roster at startup.
   *
   * A procedurally generated system brings its own, and there are thousands of
   * systems, so they arrive when one is loaded and leave when it is disposed
   * rather than all existing at once.
   */
  add(specs) {
    for (const spec of specs) {
      if (this.states.has(spec.key)) continue;
      const state = new CraftState(spec);
      this.specs.push(spec);
      this.states.set(spec.key, state);
      this.list.push(state);
    }
    return this;
  }

  /** Drops craft added by `add`. */
  drop(keys) {
    const gone = new Set(keys);
    if (!gone.size) return this;
    for (const key of gone) this.states.delete(key);
    this.specs = this.specs.filter((spec) => !gone.has(spec.key));
    this.list = this.list.filter((state) => !gone.has(state.spec.key));
    return this;
  }

  /** Which segment of a craft's trajectory covers this date, if any. */
  _segmentAt(rec, t) {
    let best = null;
    for (const seg of rec.segments) {
      if (t >= seg.from && t <= seg.to) return seg;
      if (!best || Math.abs(t - seg.to) < Math.abs(t - best.to)) best = seg;
    }
    return null;
  }

  /** Advances every spacecraft to `date`. Bodies must already be at `date`. */
  update(date, universe) {
    const t = daysFromJ2000(date);
    for (const state of this.list) {
      this._place(state, t, universe);
    }
    return this;
  }

  _place(state, t, universe) {
    const spec = state.spec;
    const launch = dayOf(spec.launched);
    state.present = false;
    state.onSurface = false;
    state.source = null;
    state.groundKm = null;

    if (launch !== null && t < launch) {
      state.phase = 'Not yet launched';
      return;
    }

    // Invented craft carry their own orbit or their own fixed point, because
    // there is no ephemeris to look them up in and never will be.
    if (spec.fix) {
      if (this._placeSurfaceAt(state, spec.fix.centre, spec.fix.latDeg, spec.fix.lonDeg, universe)) {
        state.phase = 'On the surface';
        state.onSurface = true;
        state.present = true;
        state.source = 'surface';
      } else {
        state.phase = 'Its body is not loaded';
      }
      return;
    }
    if (spec.orbit) {
      this._placeFromOrbit(state, spec.orbit, t, universe);
      return;
    }

    // A rover that has landed stops being a trajectory and becomes a place.
    if (spec.surfaceAfter && t >= dayOf(spec.surfaceAfter.date)) {
      if (this._placeSurface(state, spec.surfaceAfter.site, universe)) {
        state.phase = 'On the surface';
        state.onSurface = true;
        state.present = true;
        state.source = 'surface';
        return;
      }
    }

    const rec = this.byKey.get(spec.key);
    if (rec && this.table) {
      const seg = this._segmentAt(rec, t);
      if (seg) {
        this._placeFromTable(state, rec, seg, t, universe);
        return;
      }
      const last = rec.segments[rec.segments.length - 1];
      state.phase = t > last.to ? 'Beyond the published trajectory' : 'Before the published trajectory';
      return;
    }

    // No sampled trajectory: fall back to the osculating elements or the
    // escape asymptote in craft-data.js, both of which are single-epoch and
    // therefore only right near that epoch.
    this._placeFromFallback(state, t, universe);
  }

  _placeFromTable(state, rec, seg, t, universe) {
    const { times, pos, vel } = this.table;
    const lo = seg.offset;
    const hi = seg.offset + seg.count - 1;
    const i = findSample(times, lo, hi, t);
    const j = Math.min(i + 1, hi);

    if (seg.mode === 'elements') {
      // Osculating state at the sample, propagated forward as a Kepler orbit.
      const mu = MU[seg.centre] ?? MU.sun;
      const el = stateToElements(
        pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2],
        vel[i * 3], vel[i * 3 + 1], vel[i * 3 + 2],
        mu,
      );
      if (el) {
        elementsToState(el, (t - times[i]) * DAY_S, seg.centre, this._p, this._v);
      } else {
        this._p.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        this._v.set(vel[i * 3], vel[i * 3 + 1], vel[i * 3 + 2]);
      }
    } else if (i === j) {
      this._p.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      this._v.set(vel[i * 3], vel[i * 3 + 1], vel[i * 3 + 2]);
    } else {
      hermiteSample(times, pos, vel, i, j, t, this._p, this._v);
    }

    this._finish(state, seg.centre, universe);
    state.phase = phaseAt(state.spec, t);
    state.source = seg.mode === 'elements' ? 'elements' : 'path';
  }

  /**
   * A craft whose orbit is given rather than sampled.
   *
   * Kepler from a stated epoch, with the centre's gravity taken from the orbit
   * itself: the mu table here only knows the Solar System, and this is the path
   * a craft around another star travels.
   */
  _placeFromOrbit(state, orbit, t, universe) {
    const body = universe.get(orbit.centre);
    if (!body) {
      state.phase = 'Its body is not loaded';
      return;
    }
    const el = {
      a: orbit.aKm,
      e: orbit.e ?? 0,
      inc: (orbit.inclDeg ?? 0) * DEG,
      raan: (orbit.raanDeg ?? 0) * DEG,
      argp: (orbit.argpDeg ?? 0) * DEG,
      M: (orbit.m0Deg ?? 0) * DEG,
      mu: orbit.mu ?? MU[orbit.centre] ?? MU.sun,
    };
    const epoch = dayOf(orbit.epoch ?? '2026-01-01') ?? 0;
    elementsToState(el, (t - epoch) * DAY_S, orbit.centre, this._p, this._v);
    this._finish(state, orbit.centre, universe);
    state.phase = state.spec.mission || 'In orbit';
    state.source = 'elements';
  }

  _placeFromFallback(state, t, universe) {
    const legacy = CRAFT_BY_KEY.get(state.spec.key);
    if (!legacy) {
      state.phase = 'No trajectory data';
      return;
    }
    const centre = legacy.parent ?? 'sun';
    if (legacy.escape) {
      // A straight coast from a known distance and direction at one epoch.
      const [raDeg, decDeg] = legacy.escape.directionRaDec;
      const epoch = dayOf(legacy.escape.epoch);
      const years = (t - epoch) / 365.25;
      const au = legacy.escape.distanceAuAtEpoch + legacy.escape.speedAuPerYear * years;
      const km = au * 149597870.7;
      const ra = raDeg * DEG;
      const dec = decDeg * DEG;
      // The direction is quoted as right ascension and declination, so it is
      // equatorial and has to be tilted into the ecliptic world frame.
      this._p.set(Math.cos(dec) * Math.cos(ra), Math.sin(dec), -Math.cos(dec) * Math.sin(ra));
      equatorialToEcliptic(this._p);
      this._v.copy(this._p).multiplyScalar(
        (legacy.escape.speedAuPerYear * 149597870.7) / (365.25 * DAY_S),
      );
      this._p.multiplyScalar(km);
    } else if (legacy.orbitKm) {
      const mu = MU[centre] ?? MU.sun;
      const a = legacy.orbitKm;
      const e = legacy.orbitEcc ?? 0;
      const n = Math.sqrt(mu / (a * a * a));
      const el = {
        a,
        e,
        inc: (legacy.orbitInclDeg ?? 0) * DEG,
        raan: 0,
        argp: 0,
        M: (n * (t - dayOf('2026-08-27')) * DAY_S) % (2 * Math.PI),
        mu,
      };
      elementsToState(el, 0, centre, this._p, this._v);
    } else if (legacy.latDeg !== undefined) {
      if (this._placeSurfaceAt(state, centre, legacy.latDeg, legacy.lonDeg, universe)) {
        state.present = true;
        state.onSurface = true;
        state.phase = 'On the surface';
        state.source = 'surface';
      }
      return;
    } else {
      state.phase = 'No trajectory data';
      return;
    }
    this._finish(state, centre, universe);
    state.phase = phaseAt(state.spec, t);
    state.source = 'fallback';
  }

  _placeSurface(state, siteKey, universe) {
    const site = SITE_BY_KEY.get(siteKey);
    if (!site) return false;
    return this._placeSurfaceAt(state, site.body, site.latDeg, site.lonDeg, universe);
  }

  _placeSurfaceAt(state, bodyKey, latDeg, lonDeg, universe) {
    const body = universe.get(bodyKey);
    if (!body) return false;
    const lat = latDeg * DEG;
    const lon = lonDeg * DEG;
    const cosLat = Math.cos(lat);
    // Matches dirToUv in the terrain shader: lon = atan2(z, -x), so the prime
    // meridian sits at the centre of an equirectangular map.
    this._surfaceDir.set(-cosLat * Math.cos(lon), Math.sin(lat), cosLat * Math.sin(lon));
    // Height first, in the body's own frame, because that is the frame the
    // elevation map is indexed in; then turn the direction into the world.
    const ground = this.groundKm ? this.groundKm(bodyKey, this._surfaceDir) : null;
    this._surfaceDir.applyQuaternion(body.orientation);
    const radius = (body.spec.radiusKm ?? 1) + (ground ?? 0);
    state.groundKm = ground;
    state.local.copy(this._surfaceDir).multiplyScalar(radius);
    state.position.copy(body.position).add(state.local);
    state.velocity.set(0, 0, 0);
    state.speedKms = 0;
    state.centre = bodyKey;
    state.centreKey = bodyKey;

    // Stand it up: local vertical is out of the surface, and turn it so it
    // does not all face the same way on a body with several landers.
    this._up.copy(this._surfaceDir);
    this._fwd.set(0, 1, 0).applyQuaternion(body.orientation);
    this._right.crossVectors(this._up, this._fwd).normalize();
    if (this._right.lengthSq() < 1e-9) this._right.set(1, 0, 0);
    this._fwd.crossVectors(this._right, this._up).normalize();
    state.orientation.setFromRotationMatrix(
      basisMatrix(this._right, this._up, this._fwd),
    );
    return true;
  }

  _finish(state, centre, universe) {
    const body = universe.get(centre);
    state.centre = centre;
    state.centreKey = centre;
    state.local.copy(this._p);
    if (body) state.position.copy(body.position).add(this._p);
    else state.position.copy(this._p);
    state.velocity.copy(this._v);
    state.speedKms = this._v.length();
    state.present = true;

    // Illustrative attitude: nose along the track, panels towards the Sun.
    this._fwd.copy(this._v);
    if (this._fwd.lengthSq() < 1e-12) this._fwd.set(0, 0, 1);
    this._fwd.normalize();
    this._toSun.copy(state.position).negate();
    if (this._toSun.lengthSq() < 1e-12) this._toSun.set(0, 1, 0);
    this._toSun.normalize();
    // The basis has to come out right-handed: makeBasis reads the columns as
    // the model's x, y and z, and a left-handed one is not a rotation at all —
    // setFromRotationMatrix returns a quaternion that shears the craft instead
    // of turning it. So build right from up and forward, then up from forward
    // and right, which satisfies right x up = forward by construction.
    this._right.crossVectors(this._toSun, this._fwd);
    if (this._right.lengthSq() < 1e-12) {
      this._right.set(1, 0, 0).cross(this._fwd);
      if (this._right.lengthSq() < 1e-12) this._right.set(0, 1, 0).cross(this._fwd);
    }
    this._right.normalize();
    this._up.crossVectors(this._fwd, this._right).normalize();
    state.orientation.setFromRotationMatrix(basisMatrix(this._right, this._up, this._fwd));
  }

  /**
   * Points along a craft's trajectory, in world kilometres, for drawing it.
   *
   * Walks the stored samples rather than resampling at a fixed cadence, so the
   * line is dense exactly where the trajectory bends and cheap where it does
   * not, which is the same reason the samples are spaced that way on disk.
   */
  trajectory(key, date, universe, { pastDays = null, futureDays = null, maxPoints = 4000 } = {}) {
    const t = daysFromJ2000(date);
    // A stated orbit has no samples to draw, so the ellipse itself is drawn.
    const orbit = this.states.get(key)?.spec.orbit;
    if (orbit) return this._orbitTrajectory(orbit, t, universe);
    const rec = this.byKey.get(key);
    if (!rec || !this.table) return null;
    const { times, pos } = this.table;
    const out = [];
    let split = 0;

    for (const seg of rec.segments) {
      const body = universe.get(seg.centre);
      const cx = body ? body.position.x : 0;
      const cy = body ? body.position.y : 0;
      const cz = body ? body.position.z : 0;
      const lo = seg.offset;
      const hi = seg.offset + seg.count;
      // Element-mode segments are one ellipse flown thousands of times, so the
      // samples are a smear rather than a path. One revolution around the date
      // on screen is the useful thing to draw.
      if (seg.mode === 'elements') {
        const at = this._traceOrbit(out, seg, t, cx, cy, cz);
        if (at >= 0) split = at;
        continue;
      }
      // A fitted path can be a cruise across the Solar System or three hundred
      // laps of Saturn, and drawing all of the latter is a ball of wool rather
      // than a trajectory. Where the craft is going round something, show a
      // revolution each side of now; where it is going somewhere, show the lot.
      const window = this._windowDays(seg, t);
      const past = pastDays ?? window;
      const future = futureDays ?? window;
      const stride = Math.max(1, Math.floor(seg.count / maxPoints));
      for (let i = lo; i < hi; i += stride) {
        const dt = times[i] - t;
        if (past !== null && dt < -past) continue;
        if (future !== null && dt > future) continue;
        out.push(pos[i * 3] + cx, pos[i * 3 + 1] + cy, pos[i * 3 + 2] + cz);
        if (times[i] <= t) split = out.length / 3;
      }
    }
    if (out.length < 6) return null;
    // Float64, because these are absolute world positions and the renderer
    // subtracts the camera from them every frame. A lunar orbit held in float32
    // at 150 million kilometres from the Sun is quantised to about ten
    // kilometres, which is a visible stagger when you are flying alongside it.
    return { points: Float64Array.from(out), split };
  }

  /** One revolution of a stated orbit, centred on the date on screen. */
  _orbitTrajectory(orbit, t, universe) {
    const body = universe.get(orbit.centre);
    if (!body) return null;
    const mu = orbit.mu ?? MU[orbit.centre] ?? MU.sun;
    const el = {
      a: orbit.aKm,
      e: orbit.e ?? 0,
      inc: (orbit.inclDeg ?? 0) * DEG,
      raan: (orbit.raanDeg ?? 0) * DEG,
      argp: (orbit.argpDeg ?? 0) * DEG,
      M: (orbit.m0Deg ?? 0) * DEG,
      mu,
    };
    const period = 2 * Math.PI * Math.sqrt((el.a * el.a * el.a) / mu);
    if (!(period > 0)) return null;
    const epoch = dayOf(orbit.epoch ?? '2026-01-01') ?? 0;
    const base = (t - epoch) * DAY_S;
    const steps = 256;
    const out = [];
    for (let k = 0; k <= steps; k++) {
      elementsToState(el, base + (k / steps - 0.5) * period, orbit.centre, this._p, null);
      out.push(this._p.x + body.position.x, this._p.y + body.position.y, this._p.z + body.position.z);
    }
    return { points: Float64Array.from(out), split: steps / 2 };
  }

  /**
   * How far each side of `t` is worth drawing for a fitted segment: one orbital
   * period where the craft is on a closed orbit about the segment's centre, or
   * null where it is on its way out and the whole path is the point.
   */
  _windowDays(seg, t) {
    const { times, pos, vel } = this.table;
    const lo = seg.offset;
    const hi = seg.offset + seg.count - 1;
    if (hi <= lo) return null;
    const i = findSample(times, lo, hi, Math.min(Math.max(t, times[lo]), times[hi]));
    const mu = MU[seg.centre] ?? MU.sun;
    const el = stateToElements(
      pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2],
      vel[i * 3], vel[i * 3 + 1], vel[i * 3 + 2],
      mu,
    );
    if (!el || !(el.e < 1) || !(el.a > 0)) return null;
    const period = (2 * Math.PI * Math.sqrt((el.a * el.a * el.a) / mu)) / DAY_S;
    return period > 0 && Number.isFinite(period) ? period : null;
  }

  /**
   * One revolution of an element-mode segment, centred on `t`, appended to
   * `out`. Half a period each side of now, so the line reads as a track just
   * flown running into a track about to be flown rather than as a bare loop.
   *
   * Returns the index of the point at `t`, or -1 if the segment has no closed
   * orbit to trace.
   */
  _traceOrbit(out, seg, t, cx, cy, cz) {
    const { times, pos, vel } = this.table;
    const lo = seg.offset;
    const hi = seg.offset + seg.count - 1;
    const at = Math.min(Math.max(t, times[lo]), times[hi]);
    const i = findSample(times, lo, hi, at);
    const mu = MU[seg.centre] ?? MU.sun;
    const el = stateToElements(
      pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2],
      vel[i * 3], vel[i * 3 + 1], vel[i * 3 + 2],
      mu,
    );
    if (!el || !(el.e < 1) || !(el.a > 0)) return -1;
    const period = 2 * Math.PI * Math.sqrt((el.a * el.a * el.a) / mu);
    if (!(period > 0)) return -1;

    const base = (at - times[i]) * DAY_S;
    const steps = 256;
    const start = out.length / 3;
    for (let k = 0; k <= steps; k++) {
      elementsToState(el, base + (k / steps - 0.5) * period, seg.centre, this._p, null);
      out.push(this._p.x + cx, this._p.y + cy, this._p.z + cz);
    }
    return start + steps / 2;
  }

  /** True when the craft has sampled trajectory data at this date. */
  hasPath(key) {
    return this.byKey.has(key) && !!this.table;
  }

  coverage(key) {
    const rec = this.byKey.get(key);
    if (!rec || rec.segments.length === 0) return null;
    let from = Infinity;
    let to = -Infinity;
    for (const seg of rec.segments) {
      from = Math.min(from, seg.from);
      to = Math.max(to, seg.to);
    }
    return { from, to };
  }
}

const SITE_BY_KEY = new Map(LANDING_SITES.map((s) => [s.key, s]));

function hermiteSample(times, pos, vel, i, j, t, outP, outV) {
  const t0 = times[i];
  const t1 = times[j];
  const h = (t1 - t0) * DAY_S;
  const s = h === 0 ? 0 : ((t - t0) * DAY_S) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  // Derivatives of the basis, so velocity comes from the same curve as
  // position and the two cannot disagree.
  const d00 = (6 * s2 - 6 * s) / h;
  const d10 = (3 * s2 - 4 * s + 1) / h;
  const d01 = (-6 * s2 + 6 * s) / h;
  const d11 = (3 * s2 - 2 * s) / h;
  const a = i * 3;
  const b = j * 3;
  outP.set(
    h00 * pos[a] + h10 * h * vel[a] + h01 * pos[b] + h11 * h * vel[b],
    h00 * pos[a + 1] + h10 * h * vel[a + 1] + h01 * pos[b + 1] + h11 * h * vel[b + 1],
    h00 * pos[a + 2] + h10 * h * vel[a + 2] + h01 * pos[b + 2] + h11 * h * vel[b + 2],
  );
  outV.set(
    d00 * pos[a] + d10 * h * vel[a] + d01 * pos[b] + d11 * h * vel[b],
    d00 * pos[a + 1] + d10 * h * vel[a + 1] + d01 * pos[b + 1] + d11 * h * vel[b + 1],
    d00 * pos[a + 2] + d10 * h * vel[a + 2] + d01 * pos[b + 2] + d11 * h * vel[b + 2],
  );
}

const _basisMatrix = new Matrix4();
function basisMatrix(x, y, z) {
  return _basisMatrix.makeBasis(x, y, z);
}

/** The mission phase a date falls in, from the curated event list. */
export function phaseAt(spec, t) {
  const ended = dayOf(spec.ended);
  if (ended !== null && t > ended) return 'Mission ended';
  const events = spec.events;
  if (events && events.length) {
    let label = null;
    for (const [when, what] of events) {
      const d = dayOf(when);
      if (d !== null && d <= t) label = what;
    }
    if (label) return label;
    return 'Outbound';
  }
  return 'Operating';
}

export { MISSION_BY_KEY, MU };
