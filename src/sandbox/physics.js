import {
  G, C_LIGHT, SIGMA, C_ROCK, M_SUN, R_SUN, L_SUN, bindingEnergy, escapeVelocity, schwarzschild,
} from './constants.js';

/*
 * The simulation, in SI units and double precision throughout.
 *
 * Bodies come in two classes. Majors (stars, planets, moons, black holes) attract
 * everything exactly, pair by pair. Minors (fragments, plasma, galaxy stars)
 * attract through a Barnes–Hut tree, which is what lets a shattered planet be
 * a few thousand pieces that still pull on each other and on what is left.
 *
 * The collision model follows the one Universe Sandbox documents: mass moves
 * from the smaller body to the larger, momentum is conserved, the melt volume
 * from the impact energy becomes fragments thrown out of the impact site in a
 * cone set by the impact angle, and a hot spot is left on the surface. On top of
 * that, specific impact energy above the catastrophic-disruption threshold
 * (Leinhardt & Stewart) shatters both bodies, and fast grazing hits run on.
 */

export const HEAT_W = 64;
export const HEAT_H = 32;
const HEAT_N = HEAT_W * HEAT_H;
const TEXEL_ANG = Math.PI / HEAT_H;

/** Body-local unit vector and area weight for every heat-map texel, laid out like three's SphereGeometry UVs. */
const TEXEL_DIR = new Float32Array(HEAT_N * 3);
const TEXEL_W = new Float32Array(HEAT_N);
let TEXEL_WSUM = 0;
for (let j = 0; j < HEAT_H; j++) {
  const v = (j + 0.5) / HEAT_H;
  const theta = Math.PI * (1 - v);
  for (let i = 0; i < HEAT_W; i++) {
    const phi = ((i + 0.5) / HEAT_W) * Math.PI * 2;
    const k = j * HEAT_W + i;
    TEXEL_DIR[k * 3] = -Math.cos(phi) * Math.sin(theta);
    TEXEL_DIR[k * 3 + 1] = Math.cos(theta);
    TEXEL_DIR[k * 3 + 2] = Math.sin(phi) * Math.sin(theta);
    TEXEL_W[k] = Math.sin(theta);
    TEXEL_WSUM += TEXEL_W[k];
  }
}

const STELLAR = new Set(['star', 'giant', 'whitedwarf', 'neutron']);
export const isStar = (b) => STELLAR.has(b.kind);
export const isHole = (b) => b.kind === 'blackhole';

let nextId = 1;
const rand = Math.random;

function randUnit(out) {
  const z = rand() * 2 - 1;
  const t = rand() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  out[0] = s * Math.cos(t);
  out[1] = z;
  out[2] = s * Math.sin(t);
  return out;
}

/** Random unit vector within `angle` of axis (ax, ay, az). */
function randCone(ax, ay, az, angle, out) {
  const cosA = Math.cos(angle);
  const z = cosA + rand() * (1 - cosA);
  const t = rand() * Math.PI * 2;
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  // Basis around the axis.
  let ux = Math.abs(ax) < 0.9 ? 1 : 0;
  let uy = ux ? 0 : 1;
  let uz = 0;
  // u = normalize(axis × helper)
  let px = ay * uz - az * uy;
  let py = az * ux - ax * uz;
  let pz = ax * uy - ay * ux;
  const pl = Math.hypot(px, py, pz) || 1;
  px /= pl; py /= pl; pz /= pl;
  const qx = ay * pz - az * py;
  const qy = az * px - ax * pz;
  const qz = ax * py - ay * px;
  out[0] = ax * z + (px * Math.cos(t) + qx * Math.sin(t)) * s;
  out[1] = ay * z + (py * Math.cos(t) + qy * Math.sin(t)) * s;
  out[2] = az * z + (pz * Math.cos(t) + qz * Math.sin(t)) * s;
  return out;
}

/** Main-sequence radius, luminosity and surface temperature from mass. */
export function mainSequence(mass) {
  const m = mass / M_SUN;
  const r = m < 1 ? Math.pow(m, 0.8) : Math.pow(m, 0.57);
  let l;
  if (m < 0.43) l = 0.23 * Math.pow(m, 2.3);
  else if (m < 2) l = Math.pow(m, 4);
  else if (m < 55) l = 1.4 * Math.pow(m, 3.5);
  else l = 32000 * m;
  const radius = r * R_SUN;
  const lum = l * L_SUN;
  const temp = Math.pow(lum / (4 * Math.PI * radius * radius * SIGMA), 0.25);
  return { radius, lum, temp };
}

export function makeBody(spec) {
  const b = {
    id: 0,
    name: 'Object',
    kind: 'planet',
    minor: false,
    ghost: false,
    mass: 1e20,
    radius: 1e5,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    ax: 0, ay: 0, az: 0,
    ox: 0, oy: 0, oz: 0,
    temp: 200,
    albedo: 0.3,
    greenhouse: 0,
    internalT: 3,
    lum: 0,
    spinPeriod: 86400,
    spinAngle: rand() * Math.PI * 2,
    tilt: 0,
    color: [0.6, 0.6, 0.6],
    tex: null,
    proc: null,
    night: null,
    clouds: null,
    atmo: null,
    rings: null,
    comp: { iron: 0.3, rock: 0.7, water: 0, gas: 0 },
    heat: null,
    heatVersion: 0,
    grace: 0,
    born: 0,
    initMass: 0,
    rocheShed: 0,
    rocheChunk: 0,
    laserE: 0,
    dead: false,
    msStar: false,
    ...spec,
  };
  b.comp = { ...b.comp };
  if (b.color) b.color = [...b.color];
  b.initMass = b.initMass || b.mass;
  return b;
}

export class Sim {
  constructor() {
    this.bodies = [];
    this.time = 0;
    this.settings = {
      gravity: true,
      collide: true,
      fragment: true,
      temperature: true,
      mode: 'realistic',
      accuracy: 0.02,
      gMult: 1,
      maxFragments: 3000,
      softening: 0,
      roche: true,
    };
    this.majors = [];
    this.minors = [];
    this.listDirty = true;
    this.accValid = false;
    this.maxDt = 1;
    this.events = [];
    this.pending = [];
    this.lastSteps = 0;
    this.limited = false;
    this.tree = new Octree();
    this.moonletCount = 0;
  }

  // ---------------------------------------------------------------------------
  // Bookkeeping

  add(spec) {
    const b = spec.id ? spec : makeBody(spec);
    b.id = nextId++;
    b.born = this.time;
    if (!b.minor && !isStar(b) && !isHole(b) && !b.heat) this.initHeat(b, b.temp);
    if (isHole(b)) b.radius = schwarzschild(b.mass);
    if (b.msStar) this.updateStar(b);
    this.bodies.push(b);
    this.listDirty = true;
    this.accValid = false;
    return b;
  }

  remove(b) {
    if (!b || b.dead) return;
    b.dead = true;
    this.listDirty = true;
    this.accValid = false;
    this.events.push({ type: 'removed', id: b.id });
  }

  clear() {
    this.bodies = [];
    this.time = 0;
    this.pending = [];
    this.listDirty = true;
    this.accValid = false;
    this.moonletCount = 0;
  }

  byId(id) {
    for (const b of this.bodies) if (b.id === id && !b.dead) return b;
    return null;
  }

  refreshLists() {
    if (!this.listDirty) return;
    this.bodies = this.bodies.filter((b) => !b.dead);
    this.majors = this.bodies.filter((b) => !b.minor);
    this.minors = this.bodies.filter((b) => b.minor);
    this.listDirty = false;
  }

  fragmentCount() {
    this.refreshLists();
    return this.minors.length;
  }

  initHeat(b, T) {
    b.heat = new Float32Array(HEAT_N).fill(T);
    b.heatVersion++;
  }

  updateStar(b) {
    if (!b.msStar) return;
    const ms = mainSequence(b.mass);
    b.radius = ms.radius;
    b.lum = ms.lum;
    b.temp = ms.temp;
  }

  /** What `b` orbits: see hostAt. */
  dominant(b) {
    return this.hostAt(b.x, b.y, b.z, b.mass, b);
  }

  dominantAt(x, y, z) {
    return this.hostAt(x, y, z, 0, null);
  }

  /**
   * The body something at (x, y, z) orbits. Strongest pull first, then down
   * into any lighter body whose Hill sphere contains the point — the Sun pulls
   * the Moon harder than Earth does, yet the Moon orbits Earth.
   */
  hostAt(x, y, z, minMass, exclude) {
    this.refreshLists();
    const majors = this.majors;
    let host = null;
    let bestA = 0;
    for (const o of majors) {
      if (o === exclude || o.dead || o.mass <= minMass) continue;
      const a = o.mass / ((o.x - x) ** 2 + (o.y - y) ** 2 + (o.z - z) ** 2);
      if (a > bestA) {
        bestA = a;
        host = o;
      }
    }
    for (let depth = 0; host && depth < 3; depth++) {
      let next = null;
      let nd = Infinity;
      for (const o of majors) {
        if (o === exclude || o === host || o.dead || o.mass <= minMass || o.mass >= host.mass) continue;
        const d = Math.hypot(o.x - x, o.y - y, o.z - z);
        if (d >= nd) continue;
        const hill = Math.hypot(o.x - host.x, o.y - host.y, o.z - host.z) * Math.cbrt(o.mass / (3 * host.mass));
        if (d < hill) {
          nd = d;
          next = o;
        }
      }
      if (!next) break;
      host = next;
    }
    return host;
  }

  get Geff() {
    return this.settings.gravity ? G * this.settings.gMult : 0;
  }

  /** Put `b` on a circular, prograde orbit around `parent` at its current distance. */
  circularize(b, parent = this.dominant(b)) {
    if (!parent) return;
    const rx = b.x - parent.x;
    const ry = b.y - parent.y;
    const rz = b.z - parent.z;
    const r = Math.hypot(rx, ry, rz);
    if (r === 0) return;
    // Keep the current orbital plane when there is one, otherwise the grid plane.
    const vx = b.vx - parent.vx;
    const vy = b.vy - parent.vy;
    const vz = b.vz - parent.vz;
    let hx = ry * vz - rz * vy;
    let hy = rz * vx - rx * vz;
    let hz = rx * vy - ry * vx;
    let hl = Math.hypot(hx, hy, hz);
    if (hl < 1e-9 * r * Math.hypot(vx, vy, vz) || hl === 0) {
      hx = 0; hy = 1; hz = 0; hl = 1;
    }
    hx /= hl; hy /= hl; hz /= hl;
    let tx = hy * rz - hz * ry;
    let ty = hz * rx - hx * rz;
    let tz = hx * ry - hy * rx;
    const tl = Math.hypot(tx, ty, tz) || 1;
    const v = Math.sqrt((G * this.settings.gMult * (parent.mass + b.mass)) / r);
    tx /= tl; ty /= tl; tz /= tl;
    b.vx = parent.vx + tx * v;
    b.vy = parent.vy + ty * v;
    b.vz = parent.vz + tz * v;
    this.accValid = false;
  }

  orbitalElements(b, parent = this.dominant(b)) {
    if (!parent) return null;
    const mu = G * this.settings.gMult * (parent.mass + b.mass);
    const rx = b.x - parent.x;
    const ry = b.y - parent.y;
    const rz = b.z - parent.z;
    const vx = b.vx - parent.vx;
    const vy = b.vy - parent.vy;
    const vz = b.vz - parent.vz;
    const r = Math.hypot(rx, ry, rz);
    const v2 = vx * vx + vy * vy + vz * vz;
    const hx = ry * vz - rz * vy;
    const hy = rz * vx - rx * vz;
    const hz = rx * vy - ry * vx;
    const h = Math.hypot(hx, hy, hz);
    const rv = rx * vx + ry * vy + rz * vz;
    const ex = ((v2 - mu / r) * rx - rv * vx) / mu;
    const ey = ((v2 - mu / r) * ry - rv * vy) / mu;
    const ez = ((v2 - mu / r) * rz - rv * vz) / mu;
    const e = Math.hypot(ex, ey, ez);
    const energy = v2 / 2 - mu / r;
    const a = -mu / (2 * energy);
    const incl = h > 0 ? Math.acos(Math.min(1, Math.max(-1, hy / h))) : 0;
    const period = a > 0 ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity;
    return {
      parent, mu, r, speed: Math.sqrt(v2), a, e, incl, period, bound: energy < 0 && e < 1,
      h: [hx, hy, hz], evec: [ex, ey, ez],
    };
  }

  // ---------------------------------------------------------------------------
  // Integration

  /**
   * Advance by `dt` sim seconds (signed) within a wall-clock budget. Returns the
   * time actually simulated, which falls short when the requested speed needs
   * more substeps than the budget allows.
   */
  advance(dt, budgetMs = 10) {
    const t0 = performance.now();
    this.refreshLists();
    const dir = Math.sign(dt);
    let left = Math.abs(dt);
    let done = 0;
    let steps = 0;
    if (this.bodies.length === 0) {
      this.time += dt;
      return dt;
    }
    while (left > 1e-9) {
      if (!this.accValid) this.computeAcc();
      const h = Math.min(left, this.maxDt);
      this.substep(h * dir);
      left -= h;
      done += h;
      steps++;
      if (performance.now() - t0 > budgetMs) break;
    }
    this.lastSteps = steps;
    this.limited = left > 1e-9;
    this.slowUpdate(done * dir);
    return done * dir;
  }

  substep(dt) {
    const bodies = this.bodies;
    const half = dt * 0.5;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      b.vx += b.ax * half;
      b.vy += b.ay * half;
      b.vz += b.az * half;
      b.ox = b.x;
      b.oy = b.y;
      b.oz = b.z;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
    }
    this.time += dt;
    this.computeAcc();
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      b.vx += b.ax * half;
      b.vy += b.ay * half;
      b.vz += b.az * half;
    }
    if (this.settings.collide) this.detectCollisions();
    if (this.listDirty) {
      this.refreshLists();
      this.accValid = false;
    }
  }

  computeAcc() {
    this.refreshLists();
    const bodies = this.bodies;
    const majors = this.majors;
    const minors = this.minors;
    const Gm = G * this.settings.gMult;
    const gravity = this.settings.gravity;
    const soft2 = this.settings.softening * this.settings.softening;
    const eta = this.settings.accuracy;
    let maxDt = Infinity;

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      b.ax = 0;
      b.ay = 0;
      b.az = 0;
      b._dm = 0;
      b._dd = Infinity;
      b._best = 0;
      b._dv = 0;
    }

    if (gravity) {
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        const eps2 = b.minor ? soft2 : 0;
        let ax = 0;
        let ay = 0;
        let az = 0;
        for (let j = 0; j < majors.length; j++) {
          const o = majors[j];
          if (o === b) continue;
          const dx = o.x - b.x;
          const dy = o.y - b.y;
          const dz = o.z - b.z;
          const r2raw = dx * dx + dy * dy + dz * dz;
          const r2 = r2raw + eps2 + 1;
          const R2 = o.radius * o.radius;
          // Inside a body its pull falls off towards the centre rather than
          // diverging, so nothing passing through is flung out at absurd speed.
          const inv = r2 < R2 ? 1 / (R2 * o.radius) : 1 / (r2 * Math.sqrt(r2));
          const f = Gm * o.mass * inv;
          ax += dx * f;
          ay += dy * f;
          az += dz * f;
          const pull = o.mass / r2;
          if (pull > b._best) {
            b._best = pull;
            b._dm = o.mass;
            b._dd = Math.sqrt(r2raw);
            const vx = o.vx - b.vx;
            const vy = o.vy - b.vy;
            const vz = o.vz - b.vz;
            b._dv = Math.sqrt(vx * vx + vy * vy + vz * vz);
            b._dr = o.radius;
          }
        }
        b.ax = ax;
        b.ay = ay;
        b.az = az;
      }

      if (minors.length > 0) {
        if (minors.length <= 48) {
          for (let i = 0; i < bodies.length; i++) {
            const b = bodies[i];
            const eps2 = soft2 + b.radius * b.radius * 0.25;
            for (let j = 0; j < minors.length; j++) {
              const o = minors[j];
              if (o === b) continue;
              const dx = o.x - b.x;
              const dy = o.y - b.y;
              const dz = o.z - b.z;
              const r2 = dx * dx + dy * dy + dz * dz + eps2 + 1;
              const f = (Gm * o.mass) / (r2 * Math.sqrt(r2));
              b.ax += dx * f;
              b.ay += dy * f;
              b.az += dz * f;
            }
          }
        } else {
          this.tree.build(minors);
          for (let i = 0; i < bodies.length; i++) {
            const b = bodies[i];
            this.tree.accel(b, Gm, soft2 + b.radius * b.radius * 0.25, 0.65);
          }
        }
      }
    }

    // Time step: a fixed fraction of the local orbital time around whatever pulls
    // hardest, tighter for majors than for fragments, plus a closing-speed limit
    // near contact so impacts are resolved at the right geometry.
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      let dt;
      if (b._dm > 0 && gravity) {
        const d = b._dd;
        // Something already inside what it is falling into is about to be
        // absorbed; its step should not shrink towards zero meanwhile.
        const dOrb = Math.max(d, b._dr || 0);
        const tOrb = Math.sqrt((dOrb * dOrb * dOrb) / (Gm * (b._dm + b.mass)));
        dt = (b.minor ? eta * 3 : eta) * tOrb;
        const gap = d - b.radius - (b._dr || 0);
        if (!b.minor && b._dv > 0 && gap < 4 * (b.radius + (b._dr || 0))) {
          dt = Math.min(dt, Math.max(gap, 0.2 * b.radius) / b._dv * 0.5);
        }
      } else {
        const a = Math.hypot(b.ax, b.ay, b.az);
        const v = Math.hypot(b.vx, b.vy, b.vz);
        const L = Math.max(b.radius, this.settings.softening, 1);
        dt = a > 0 ? eta * 4 * Math.sqrt(L / a) : Infinity;
        if (v > 0) dt = Math.min(dt, (200 * L) / v);
      }
      if (dt < maxDt) maxDt = dt;
    }
    this.maxDt = Number.isFinite(maxDt) ? Math.max(maxDt, 1e-3) : 3600 * 24 * 365;
    this.accValid = true;
  }

  // ---------------------------------------------------------------------------
  // Collisions

  detectCollisions() {
    const majors = this.majors;
    const minors = this.minors;
    const hits = [];
    const t = this.time;

    for (let i = 0; i < majors.length; i++) {
      const a = majors[i];
      if (a.ghost) continue;
      for (let j = i + 1; j < majors.length; j++) {
        const b = majors[j];
        if (b.ghost) continue;
        const tc = swept(a, b, a.radius + b.radius);
        if (tc >= 0) hits.push([a, b, tc]);
      }
    }

    for (let i = 0; i < minors.length; i++) {
      const m = minors[i];
      if (m.ghost) continue;
      if (m.grace && !this.graceOver(m)) continue;
      for (let j = 0; j < majors.length; j++) {
        const a = majors[j];
        if (a.ghost) continue;
        // A world being torn apart does not gather its own pieces back up.
        if (m.src === a.id) continue;
        const R = a.radius + m.radius;
        // Cheap reject before the swept test.
        const dx = a.x - m.x;
        const dy = a.y - m.y;
        const dz = a.z - m.z;
        const reach = R + Math.abs(m.x - m.ox) + Math.abs(m.y - m.oy) + Math.abs(m.z - m.oz)
          + Math.abs(a.x - a.ox) + Math.abs(a.y - a.oy) + Math.abs(a.z - a.oz);
        if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
        const tc = swept(a, m, R);
        if (tc >= 0) {
          hits.push([a, m, tc]);
          break;
        }
      }
    }

    if (minors.length > 1) this.minorPairs(minors, hits);

    if (hits.length === 0) return;
    for (const [a, b, tc] of hits) {
      if (a.dead || b.dead) continue;
      // Back both up to the moment of contact.
      for (const o of [a, b]) {
        o.x = o.ox + (o.x - o.ox) * tc;
        o.y = o.oy + (o.y - o.oy) * tc;
        o.z = o.oz + (o.z - o.oz) * tc;
      }
      this.collide(a, b);
    }
    void t;
    this.listDirty = true;
    this.accValid = false;
  }

  /**
   * Fresh fragments ignore collisions until they are clear of the body they came
   * from and have moved twice their own radius from where they were made, in
   * that body's frame; otherwise a spray would re-merge the instant it formed.
   */
  graceOver(m) {
    const age = Math.abs(this.time - m.born);
    let over = age > m.gt;
    if (!over) {
      const p = m.gp;
      let fx;
      let fy;
      let fz;
      if (p && !p.dead) {
        const sx = m.x - p.x;
        const sy = m.y - p.y;
        const sz = m.z - p.z;
        const sep = Math.hypot(sx, sy, sz);
        if (sep < p.radius + m.radius) {
          // Still overlapping is fine on the way out; falling back in ends it.
          const vr = (sx * (m.vx - p.vx) + sy * (m.vy - p.vy) + sz * (m.vz - p.vz)) / (sep || 1);
          if (vr >= 0 || age < 60) return false;
          m.grace = 0;
          m.gp = null;
          return true;
        }
        fx = p.x + m.gx;
        fy = p.y + m.gy;
        fz = p.z + m.gz;
      } else if (p) {
        over = true;
      } else {
        fx = m.gx + m.gvx * (this.time - m.born);
        fy = m.gy + m.gvy * (this.time - m.born);
        fz = m.gz + m.gvz * (this.time - m.born);
      }
      if (!over) over = Math.hypot(m.x - fx, m.y - fy, m.z - fz) > 2 * m.radius;
    }
    if (over) {
      m.grace = 0;
      m.gp = null;
    }
    return over;
  }

  minorPairs(minors, hits) {
    const live = [];
    let sumR = 0;
    for (const m of minors) {
      if (m.ghost || m.grace || m.kind === 'plasma' || m.kind === 'starp') continue;
      live.push(m);
      sumR += m.radius;
    }
    if (live.length < 2) return;
    // Cells sized for typical debris; the few much larger pieces are tested
    // against everything directly rather than inflating every cell.
    const cell = (sumR / live.length) * 6;
    const big = [];
    const grid = new Map();
    const hash = (ix, iy, iz) => ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0;
    for (const m of live) {
      m._sticky = 0;
      if (m.radius * 2 > cell) {
        big.push(m);
        continue;
      }
      m._ix = Math.floor(m.x / cell);
      m._iy = Math.floor(m.y / cell);
      m._iz = Math.floor(m.z / cell);
      const k = hash(m._ix, m._iy, m._iz);
      const arr = grid.get(k);
      if (arr) arr.push(m);
      else grid.set(k, [m]);
    }
    const test = (m, o) => {
      if (o === m || o._sticky || (m.tidal && o.tidal)) return false;
      const R = m.radius + o.radius;
      const dx = o.x - m.x;
      const dy = o.y - m.y;
      const dz = o.z - m.z;
      if (dx * dx + dy * dy + dz * dz >= R * R) return false;
      // Debris only sticks when it meets slowly; fast crossings pass.
      const v = Math.hypot(o.vx - m.vx, o.vy - m.vy, o.vz - m.vz);
      return v < 1.5 * escapeVelocity(m.mass + o.mass, R) + 30;
    };
    const pair = (m, o) => {
      m._sticky = 1;
      o._sticky = 1;
      hits.push([m, o, 1]);
    };
    for (const m of big) {
      if (m._sticky) continue;
      for (const o of live) {
        if (test(m, o)) {
          pair(m, o);
          break;
        }
      }
    }
    for (const m of live) {
      if (m._sticky || m.radius * 2 > cell) continue;
      let found = null;
      for (let a = -1; a <= 1 && !found; a++) {
        for (let b = -1; b <= 1 && !found; b++) {
          for (let c = -1; c <= 1 && !found; c++) {
            const arr = grid.get(hash(m._ix + a, m._iy + b, m._iz + c));
            if (!arr) continue;
            for (let i = 0; i < arr.length; i++) {
              if (test(m, arr[i])) {
                found = arr[i];
                break;
              }
            }
          }
        }
      }
      if (found) pair(m, found);
    }
  }

  collide(a, b) {
    const A = a.mass >= b.mass ? a : b;
    const B = A === a ? b : a;
    const Mtot = A.mass + B.mass;
    let nx = B.x - A.x;
    let ny = B.y - A.y;
    let nz = B.z - A.z;
    const dist = Math.hypot(nx, ny, nz) || 1;
    nx /= dist; ny /= dist; nz /= dist;
    const rvx = B.vx - A.vx;
    const rvy = B.vy - A.vy;
    const rvz = B.vz - A.vz;
    const vrel = Math.hypot(rvx, rvy, rvz);
    const mu = (A.mass * B.mass) / Mtot;
    const KE = 0.5 * mu * vrel * vrel;
    const vn = rvx * nx + rvy * ny + rvz * nz;
    const sinT = vrel > 0 ? Math.min(1, Math.abs(vn) / vrel) : 1;
    const px = A.x + nx * A.radius;
    const py = A.y + ny * A.radius;
    const pz = A.z + nz * A.radius;

    if (!A.minor || !B.minor) {
      this.events.push({
        type: 'impact', x: px, y: py, z: pz, energy: KE, v: vrel,
        size: B.minor ? B.radius * 2.5 : Math.max(B.radius, A.radius * 0.05),
        a: A.id, b: B.id, aName: A.name, bName: B.name, major: !B.minor, time: this.time,
      });
    }

    const special = isHole(A) || isHole(B) || isStar(A) || isStar(B);
    // Below escape speed there is too little energy to throw much off: the
    // impactor is accreted (Leinhardt & Stewart's perfect-merging regime).
    const vEsc = escapeVelocity(Mtot, A.radius + B.radius);
    // Debris falling back is reaccreted too, so debris cannot cascade.
    const gentle = vrel < 0.6 * vEsc || (vrel < vEsc && B.mass < 0.1 * A.mass) || (B.minor && vrel < 2 * vEsc);
    const simple = this.settings.mode === 'merge' || !this.settings.fragment || special || gentle
      || (B.minor && B.mass < 1e-3 * A.mass) || (A.minor && B.minor);
    if (simple) {
      this.merge(A, B, KE, [nx, ny, nz], sinT);
      return;
    }
    this.fragmentingImpact(A, B, { nx, ny, nz, rvx, rvy, rvz, vrel, vn, KE, sinT, Mtot });
  }

  merge(A, B, KE, n, sinT) {
    const M = A.mass + B.mass;
    const wA = A.mass / M;
    const wB = B.mass / M;
    const big = B.mass > 1e-4 * A.mass;
    A.vx = A.vx * wA + B.vx * wB;
    A.vy = A.vy * wA + B.vy * wB;
    A.vz = A.vz * wA + B.vz * wB;
    if (big) {
      A.x = A.x * wA + B.x * wB;
      A.y = A.y * wA + B.y * wB;
      A.z = A.z * wA + B.z * wB;
    }
    for (const k of Object.keys(A.comp)) A.comp[k] = A.comp[k] * wA + (B.comp[k] || 0) * wB;
    const before = A.mass;
    A.mass = M;
    if (isHole(A)) {
      A.radius = schwarzschild(M);
      A.feed = Math.min(1, (A.feed || 0) + 0.3 + wB * 5);
    } else if (isHole(B)) {
      // A star or planet hit by a heavier-looking but lighter black hole: the hole wins.
      A.kind = 'blackhole';
      A.radius = schwarzschild(M);
      A.name = B.name;
      A.tex = null;
      A.feed = 1;
    } else if (isStar(A)) {
      if (A.msStar) this.updateStar(A);
      else A.radius *= Math.cbrt(M / before);
      if (isStar(B)) this.events.push({ type: 'flash', x: A.x, y: A.y, z: A.z, energy: KE, size: A.radius * 3 });
      this.checkStellarLimits(A);
    } else {
      A.radius *= Math.cbrt(M / before);
    }
    if (A.minor && this.shouldPromote(A)) this.promote(A);
    if (A.heat && this.settings.temperature && KE > 0) {
      this.impactHeat(A, n, KE, sinT, B.radius);
    } else if (A.minor) {
      A.temp = Math.min(6000, A.temp + (0.5 * KE) / (C_ROCK * M));
    }
    B.dead = true;
    this.events.push({ type: 'merged', from: B.id, into: A.id });
  }

  shouldPromote(m) {
    return m.kind !== 'plasma' && m.kind !== 'starp' && !m.tidal && m.radius > 280e3;
  }

  promote(m) {
    m.minor = false;
    m.kind = 'moon';
    m.grace = 0;
    this.moonletCount++;
    m.name = `Moonlet ${this.moonletCount}`;
    this.initHeat(m, m.temp);
    this.listDirty = true;
    this.events.push({ type: 'notice', text: `${m.name} has formed from the debris` });
  }

  /** Neutron stars and white dwarfs over their mass limits. */
  checkStellarLimits(A) {
    if (A.kind === 'whitedwarf' && A.mass > 1.44 * M_SUN) {
      this.events.push({ type: 'notice', text: `${A.name} passed the Chandrasekhar limit — type Ia supernova` });
      this.supernova(A, { remnant: 'none' });
    } else if (A.kind === 'neutron' && A.mass > 2.3 * M_SUN) {
      A.kind = 'blackhole';
      A.radius = schwarzschild(A.mass);
      A.lum = 0;
      A.tex = null;
      A.name = `${A.name} (black hole)`;
      this.events.push({ type: 'flash', x: A.x, y: A.y, z: A.z, energy: 1e45, size: 1e9 });
      this.events.push({ type: 'notice', text: 'The neutron star collapsed into a black hole' });
    }
  }

  qStar(M, R) {
    return Math.max((0.6 * G * this.settings.gMult * M) / R, 300);
  }

  fragmentingImpact(A, B, c) {
    const { nx, ny, nz, rvx, rvy, rvz, vrel, vn, KE, sinT, Mtot } = c;
    const Rtot = Math.cbrt(A.radius ** 3 + B.radius ** 3);
    const Q = KE / Mtot;
    const Qs = this.qStar(Mtot, Rtot);
    let Mlr = Q < 1.8 * Qs ? Mtot * (1 - (0.5 * Q) / Qs) : Mtot * 0.1 * Math.pow(Q / (1.8 * Qs), -1.5);
    const rhoA = A.mass / ((4 / 3) * Math.PI * A.radius ** 3);
    const rhoB = B.mass / ((4 / 3) * Math.PI * B.radius ** 3);
    const Vmelt = 8.9e-12 * KE * sinT * (1 + (0.8 * B.radius) / A.radius);
    const Mmelt = Vmelt * rhoA;
    let Mej = Math.max(Mtot - Mlr, Math.min(0.3 * Mmelt, 0.5 * Mtot));
    Mej = Math.min(Mej, 0.97 * Mtot);
    const vEscMutual = escapeVelocity(Mtot, A.radius + B.radius);
    const superCat = Mlr < 0.5 * Mtot;

    // Hit-and-run: a fast, grazing hit by something not much smaller carries most
    // of the impactor on past the target.
    let keepB = 0;
    if (!superCat && sinT < 0.45 && B.mass > 0.02 * A.mass && vrel > 1.1 * vEscMutual && !B.minor) {
      keepB = B.mass * (1 - sinT / 0.45) * 0.85;
      Mej = Math.min(Mej, (Mtot - keepB) * 0.6);
    }

    const budget = Math.max(0, this.settings.maxFragments - this.fragmentCount());
    if (Mej < 1e-12 * Mtot || budget < 2) {
      this.merge(A, B, KE, [nx, ny, nz], sinT);
      return;
    }

    const Mrem = Mtot - Mej - keepB;
    const frac = Mej / Mtot;
    let count = Math.round(Math.cbrt(frac) * (superCat ? 900 : 650));
    count = Math.max(10, Math.min(count, budget));

    // Momentum frame.
    const Px = A.mass * A.vx + B.mass * B.vx;
    const Py = A.mass * A.vy + B.mass * B.vy;
    const Pz = A.mass * A.vz + B.mass * B.vz;
    const cvx = Px / Mtot;
    const cvy = Py / Mtot;
    const cvz = Pz / Mtot;
    const comx = (A.x * A.mass + B.x * B.mass) / Mtot;
    const comy = (A.y * A.mass + B.y * B.mass) / Mtot;
    const comz = (A.z * A.mass + B.z * B.mass) / Mtot;

    // Spray axis: back out along the normal for head-on hits, along the
    // impactor's track for grazing ones.
    let tx = rvx - vn * nx;
    let ty = rvy - vn * ny;
    let tz = rvz - vn * nz;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const cosT = Math.sqrt(Math.max(0, 1 - sinT * sinT));
    let axx = nx * sinT + tx * cosT * 1.1;
    let axy = ny * sinT + ty * cosT * 1.1;
    let axz = nz * sinT + tz * cosT * 1.1;
    const al = Math.hypot(axx, axy, axz) || 1;
    axx /= al; axy /= al; axz /= al;
    const cone = (25 + 40 * sinT) * (Math.PI / 180);

    // Fragment masses from a steep power law, normalised to the ejecta mass.
    const weights = new Float64Array(count);
    let wsum = 0;
    for (let k = 0; k < count; k++) {
      const w = Math.pow(rand(), 3) + 0.015;
      weights[k] = w;
      wsum += w;
    }

    const remRho = rhoA;
    const Rrem = Math.cbrt((3 * Math.max(Mrem, 1)) / (4 * Math.PI * remRho));
    const vEscRem = escapeVelocity(Math.max(Mrem, 1), Rrem);
    const mixColor = [0, 1, 2].map((i) => A.color[i] * 0.55 + B.color[i] * 0.2 + 0.12);
    const comp = {};
    for (const k of Object.keys(A.comp)) comp[k] = (A.comp[k] * A.mass + (B.comp[k] || 0) * B.mass) / Mtot;
    const fragT = Math.min(4500, 1400 + (superCat ? 1600 : 700) * Math.log10(1 + Q / (0.01 * Qs)));

    let fpx = 0;
    let fpy = 0;
    let fpz = 0;
    const dir = [0, 0, 0];
    const off = [0, 0, 0];
    const expansion = superCat ? Math.sqrt(Math.max(2 * Q - 0.6 * vEscMutual * vEscMutual, 0.04 * vEscMutual ** 2)) : 0;
    const graceTime = superCat
      ? (3 * Rtot) / Math.max(expansion, 0.3 * vEscMutual, 1)
      : (6 * Rrem) / Math.max(vEscRem, 1);
    for (let k = 0; k < count; k++) {
      const m = (Mej * weights[k]) / wsum;
      const rho = (0.45 + 0.55 * rand()) * (rhoA * 0.7 + rhoB * 0.3);
      const r = Math.cbrt((3 * m) / (4 * Math.PI * rho));
      let x;
      let y;
      let z;
      let vx;
      let vy;
      let vz;
      if (superCat) {
        randUnit(dir);
        const depth = Math.cbrt(rand()) * Rtot * 1.05 + r;
        x = comx + dir[0] * depth;
        y = comy + dir[1] * depth;
        z = comz + dir[2] * depth;
        const s = expansion * (0.25 + 0.95 * rand()) * (depth / Rtot);
        randUnit(off);
        const j = expansion * 0.15;
        vx = cvx + dir[0] * s + off[0] * j + tx * vrel * 0.15 * rand();
        vy = cvy + dir[1] * s + off[1] * j + ty * vrel * 0.15 * rand();
        vz = cvz + dir[2] * s + off[2] * j + tz * vrel * 0.15 * rand();
      } else {
        // Launch site: the intersection ring around the impact point.
        randUnit(off);
        const spread = Math.min(0.9, (B.radius / A.radius) * 1.3 + 0.05);
        let ux = nx + off[0] * spread * rand();
        let uy = ny + off[1] * spread * rand();
        let uz = nz + off[2] * spread * rand();
        const ul = Math.hypot(ux, uy, uz) || 1;
        ux /= ul; uy /= ul; uz /= ul;
        const lift = Rrem + r * 1.3 + B.radius * 0.1;
        x = comx + ux * lift;
        y = comy + uy * lift;
        z = comz + uz * lift;
        randCone(axx, axy, axz, cone, dir);
        // Equal kinetic energy per fragment, so the small ones fly fastest.
        let s = vrel * Math.sqrt((0.5 * (Mej / count)) / m) * (0.7 + 0.6 * rand());
        s = Math.min(Math.max(s, 0.3 * vEscRem), 1.6 * vrel + 0.5 * vEscRem);
        // Keep the spray pointing out of the surface.
        const outward = dir[0] * ux + dir[1] * uy + dir[2] * uz;
        if (outward < 0.1) {
          dir[0] += ux * (0.1 - outward) * 1.5;
          dir[1] += uy * (0.1 - outward) * 1.5;
          dir[2] += uz * (0.1 - outward) * 1.5;
          const dl = Math.hypot(dir[0], dir[1], dir[2]);
          dir[0] /= dl; dir[1] /= dl; dir[2] /= dl;
        }
        vx = cvx + dir[0] * s;
        vy = cvy + dir[1] * s;
        vz = cvz + dir[2] * s;
      }
      fpx += m * vx;
      fpy += m * vy;
      fpz += m * vz;
      this.spawnFragment({
        mass: m, radius: r, x, y, z, vx, vy, vz, color: jitterColor(mixColor), comp,
        temp: fragT * (0.75 + 0.5 * rand()),
      }, A, graceTime);
    }

    let survivorP = [0, 0, 0];
    if (keepB > 0) {
      const scale = Math.cbrt(keepB / B.mass);
      B.mass = keepB;
      B.radius *= scale;
      B.initMass = Math.min(B.initMass, keepB);
      // Lose the normal component and a fifth of the rest.
      B.vx = A.vx + (rvx - vn * nx) * 0.8;
      B.vy = A.vy + (rvy - vn * ny) * 0.8;
      B.vz = A.vz + (rvz - vn * nz) * 0.8;
      const sep = Rrem + B.radius * 1.05;
      B.x = comx + nx * sep;
      B.y = comy + ny * sep;
      B.z = comz + nz * sep;
      survivorP = [B.mass * B.vx, B.mass * B.vy, B.mass * B.vz];
      if (B.heat) this.impactHeat(B, [-nx, -ny, -nz], KE * 0.3, sinT, A.radius * 0.3);
    } else {
      B.dead = true;
      this.events.push({ type: 'merged', from: B.id, into: A.id });
    }

    const before = A.mass;
    A.mass = Math.max(Mrem, 1);
    A.radius = Rrem;
    A.comp = comp;
    A.vx = (Px - fpx - survivorP[0]) / A.mass;
    A.vy = (Py - fpy - survivorP[1]) / A.mass;
    A.vz = (Pz - fpz - survivorP[2]) / A.mass;
    if (keepB === 0 || superCat) {
      A.x = comx;
      A.y = comy;
      A.z = comz;
    }
    if (A.rings && (superCat || A.mass < 0.9 * before)) A.rings = null;
    if (A.clouds && (superCat || Q > 0.05 * Qs)) A.clouds = null;
    if (superCat) {
      A.atmo = null;
      if (A.heat) {
        A.heat.fill(Math.max(fragT, 2500));
        A.heatVersion++;
      }
      this.events.push({ type: 'notice', text: `${A.name} was shattered by ${B.name}` });
      this.events.push({ type: 'flash', x: comx, y: comy, z: comz, energy: KE, size: Rtot * 2 });
      // What is left of something shattered is just the biggest fragment.
      if (Mrem < 0.15 * Mtot && A.radius < 1500e3) {
        A.minor = true;
        A.kind = 'fragment';
        A.heat = null;
        A.grace = 0;
        this.listDirty = true;
      }
    } else if (A.heat) {
      this.impactHeat(A, [nx, ny, nz], KE, sinT, B.radius);
    }
    this.listDirty = true;
  }

  /**
   * `parent` is the body the fragment is leaving (grace is measured in its frame),
   * `graceTime` the longest it may ignore collisions, and `frameV` the frame
   * velocity to use when there is no parent left.
   */
  spawnFragment(spec, parent = null, graceTime = 0, frameV = null) {
    const f = makeBody({
      name: 'Fragment',
      kind: 'fragment',
      minor: true,
      albedo: 0.2,
      spinPeriod: 3600 * (1 + rand() * 20),
      ...spec,
    });
    f.grace = graceTime > 0 ? 1 : 0;
    f.gt = graceTime;
    f.gp = parent;
    if (parent) {
      f.gx = f.x - parent.x;
      f.gy = f.y - parent.y;
      f.gz = f.z - parent.z;
    } else {
      f.gx = f.x;
      f.gy = f.y;
      f.gz = f.z;
      f.gvx = frameV ? frameV[0] : f.vx;
      f.gvy = frameV ? frameV[1] : f.vy;
      f.gvz = frameV ? frameV[2] : f.vz;
    }
    f.id = nextId++;
    f.born = this.time;
    this.bodies.push(f);
    this.listDirty = true;
    return f;
  }

  /** Melt a patch of surface around the impact direction `n` (world frame). */
  impactHeat(A, n, KE, sinT, impactorR) {
    if (!A.heat || !this.settings.temperature) return;
    const M = A.mass;
    const Vmelt = 8.9e-12 * KE * Math.max(sinT, 0.2);
    let alpha = (Math.cbrt(Vmelt) * 1.4 + impactorR * 0.6) / A.radius;
    alpha = Math.min(alpha, Math.PI);
    const globalDT = Math.min(3000, (0.05 * KE) / (C_ROCK * M));
    const spot = Math.min(4200, 1700 + 600 * Math.log10(1 + KE / (1e-7 * bindingEnergy(M, A.radius))));
    this.heatSpot(A, n, alpha, spot, globalDT);
  }

  heatSpot(A, n, alpha, Tspot, globalDT = 0) {
    const local = worldToLocal(A, n[0], n[1], n[2]);
    const heat = A.heat;
    let a = alpha;
    let T = Tspot;
    if (a < TEXEL_ANG * 0.7) {
      const f = (a / (TEXEL_ANG * 0.7)) ** 2;
      a = TEXEL_ANG * 0.7;
      T = A.temp + (Tspot - A.temp) * Math.max(f, 0.35);
    }
    const cosOuter = Math.cos(Math.min(Math.PI, a * 1.6));
    for (let k = 0; k < HEAT_N; k++) {
      if (globalDT) heat[k] += globalDT;
      const d = TEXEL_DIR[k * 3] * local[0] + TEXEL_DIR[k * 3 + 1] * local[1] + TEXEL_DIR[k * 3 + 2] * local[2];
      if (d < cosOuter) continue;
      const ang = Math.acos(Math.min(1, d));
      const w = ang < a ? 1 : 1 - (ang - a) / (0.6 * a);
      const target = heat[k] + (T - heat[k]) * w;
      if (target > heat[k]) heat[k] = target;
    }
    A.heatVersion++;
  }

  // ---------------------------------------------------------------------------
  // Powers

  explode(b, energyFactor = 4) {
    if (!b || b.dead) return;
    if (isStar(b)) {
      this.supernova(b);
      return;
    }
    if (isHole(b)) {
      this.events.push({ type: 'notice', text: 'Black holes cannot be exploded' });
      return;
    }
    const E = bindingEnergy(b.mass, b.radius) * energyFactor;
    const budget = Math.max(4, this.settings.maxFragments - this.fragmentCount());
    const count = Math.min(b.minor ? 40 : 800, budget);
    const vexp = Math.sqrt((2 * (E - bindingEnergy(b.mass, b.radius))) / b.mass);
    const rho = b.mass / ((4 / 3) * Math.PI * b.radius ** 3);
    const weights = [];
    let wsum = 0;
    for (let k = 0; k < count; k++) {
      const w = Math.pow(rand(), 3) + 0.02;
      weights.push(w);
      wsum += w;
    }
    const dir = [0, 0, 0];
    for (let k = 0; k < count; k++) {
      const m = (b.mass * weights[k]) / wsum;
      const r = Math.cbrt((3 * m) / (4 * Math.PI * rho * (0.5 + 0.5 * rand())));
      randUnit(dir);
      const depth = Math.cbrt(rand()) * b.radius;
      const s = vexp * (0.3 + 0.9 * rand()) * (0.3 + depth / b.radius);
      this.spawnFragment({
        mass: m, radius: r,
        x: b.x + dir[0] * depth, y: b.y + dir[1] * depth, z: b.z + dir[2] * depth,
        vx: b.vx + dir[0] * s, vy: b.vy + dir[1] * s, vz: b.vz + dir[2] * s,
        color: jitterColor(b.color.map((c) => c * 0.6 + 0.12)), comp: b.comp,
        temp: 2500 + 2000 * rand(),
      }, null, (3 * b.radius) / Math.max(vexp, 1), [b.vx, b.vy, b.vz]);
    }
    this.events.push({ type: 'flash', x: b.x, y: b.y, z: b.z, energy: E, size: b.radius * 3 });
    this.events.push({ type: 'notice', text: `${b.name} exploded` });
    this.remove(b);
  }

  supernova(star, opts = {}) {
    const M = star.mass;
    let remnantKind = opts.remnant;
    if (!remnantKind) {
      if (star.kind === 'whitedwarf') remnantKind = 'none';
      else if (star.kind === 'neutron') remnantKind = 'blackhole';
      else if (M > 20 * M_SUN) remnantKind = 'blackhole';
      else if (M > 8 * M_SUN) remnantKind = 'neutron';
      else remnantKind = 'whitedwarf';
    }
    let Mrem = 0;
    if (remnantKind === 'blackhole') Mrem = Math.max(3 * M_SUN, 0.3 * M);
    else if (remnantKind === 'neutron') Mrem = 1.4 * M_SUN;
    else if (remnantKind === 'whitedwarf') Mrem = Math.min(0.6 * M_SUN, 0.5 * M);
    Mrem = Math.min(Mrem, M * 0.9);
    const Mej = M - Mrem;
    const Esn = 1e44 * Math.sqrt(Math.max(Mej, 0.1 * M_SUN) / (10 * M_SUN));
    const vej = Math.sqrt((2 * Esn) / Mej);
    const budget = Math.max(50, this.settings.maxFragments - this.fragmentCount());
    const count = Math.min(900, budget);
    const dir = [0, 0, 0];
    for (let k = 0; k < count; k++) {
      randUnit(dir);
      const s = vej * (0.55 + 0.7 * rand());
      const d = star.radius * (1 + rand());
      this.spawnFragment({
        name: 'Supernova ejecta', kind: 'plasma', ghost: true,
        mass: Mej / count, radius: 1e6,
        x: star.x + dir[0] * d, y: star.y + dir[1] * d, z: star.z + dir[2] * d,
        vx: star.vx + dir[0] * s, vy: star.vy + dir[1] * s, vz: star.vz + dir[2] * s,
        temp: 12000 + 20000 * rand(), color: [1, 0.7, 0.5],
      });
    }
    this.events.push({ type: 'supernova', x: star.x, y: star.y, z: star.z, energy: Esn, size: star.radius * 20 });
    this.events.push({ type: 'notice', text: `${star.name} went supernova` });

    // The light arrives first, then the blast. Each lands when it gets there.
    for (const o of this.majors) {
      if (o === star || o.dead || isHole(o)) continue;
      const d = Math.hypot(o.x - star.x, o.y - star.y, o.z - star.z);
      const share = (o.radius * o.radius) / (4 * d * d);
      this.pending.push({ at: this.time + d / C_LIGHT, id: o.id, energy: Esn * 0.01 * share, src: [star.x, star.y, star.z] });
      this.pending.push({ at: this.time + d / vej, id: o.id, energy: Esn * 0.5 * share, src: [star.x, star.y, star.z] });
    }

    if (remnantKind === 'none') {
      this.remove(star);
      return;
    }
    star.mass = Mrem;
    star.msStar = false;
    star.initMass = Mrem;
    if (remnantKind === 'blackhole') {
      star.kind = 'blackhole';
      star.radius = schwarzschild(Mrem);
      star.lum = 0;
      star.tex = null;
      star.name = `${star.name} remnant`;
      star.feed = 1;
    } else if (remnantKind === 'neutron') {
      star.kind = 'neutron';
      star.radius = 12e3;
      star.temp = 6e5;
      star.lum = 4 * Math.PI * star.radius ** 2 * SIGMA * star.temp ** 4;
      star.tex = null;
      star.name = `${star.name} (neutron star)`;
    } else {
      star.kind = 'whitedwarf';
      star.radius = 7e6;
      star.temp = 60000;
      star.lum = 4 * Math.PI * star.radius ** 2 * SIGMA * star.temp ** 4;
      star.tex = null;
      star.name = `${star.name} (white dwarf)`;
    }
    this.listDirty = true;
    this.accValid = false;
  }

  /** Hold a laser of `power` watts on `b` at world direction `n` from its centre for `dt` seconds. */
  laser(b, n, power, dt) {
    if (!b || b.dead || isHole(b)) return;
    const E = power * dt;
    if (isStar(b)) return;
    if (b.minor) {
      b.temp = Math.min(8000, b.temp + E / (C_ROCK * b.mass));
      if (E > 2e7 * b.mass) this.remove(b);
      return;
    }
    b.laserE += E;
    const U = bindingEnergy(b.mass, b.radius);
    if (b.heat) {
      const spot = Math.min(5000, 1500 + 700 * Math.log10(1 + E / (1e-9 * U)));
      this.heatSpot(b, n, Math.max(0.05, Math.min(0.5, 0.04 * Math.log10(1 + b.laserE / (1e-6 * U)))), spot);
    } else {
      b.temp = Math.min(8000, b.temp + E / (C_ROCK * b.mass));
    }
    // Vaporised rock leaves as hot fragments, a few at a time.
    const ablated = E / 5e6;
    b._ablate = (b._ablate || 0) + ablated;
    const chunk = Math.max(b.mass * 2e-5, 1e12);
    let spawned = 0;
    while (b._ablate > chunk && spawned < 4 && this.fragmentCount() < this.settings.maxFragments) {
      b._ablate -= chunk;
      const m = Math.min(chunk, b.mass * 0.02);
      b.mass -= m;
      b.radius *= Math.cbrt(1 - m / (b.mass + m));
      const dir = randCone(n[0], n[1], n[2], 0.5, [0, 0, 0]);
      const s = escapeVelocity(b.mass, b.radius) * (0.8 + 0.8 * rand());
      const r = Math.cbrt((3 * m) / (4 * Math.PI * 2500));
      const lift = b.radius + r * 2;
      this.spawnFragment({
        mass: m, radius: r,
        x: b.x + n[0] * lift, y: b.y + n[1] * lift, z: b.z + n[2] * lift,
        vx: b.vx + dir[0] * s, vy: b.vy + dir[1] * s, vz: b.vz + dir[2] * s,
        color: jitterColor(b.color.map((c) => c * 0.5 + 0.2)), temp: 3000 + 1500 * rand(),
      }, b, 1e12);
      spawned++;
    }
    if (b.laserE > U) {
      this.events.push({ type: 'notice', text: `The laser blew ${b.name} apart` });
      this.explode(b, 1.6);
    }
  }

  /** A stream of loose material, for the Material tool. */
  emit(x, y, z, vx, vy, vz, mass, material) {
    if (this.fragmentCount() >= this.settings.maxFragments) return;
    const rho = material === 'water' ? 1000 : material === 'iron' ? 7800 : material === 'ice' ? 920 : 2800;
    const color = material === 'water' ? [0.25, 0.45, 0.85] : material === 'iron' ? [0.45, 0.42, 0.4]
      : material === 'ice' ? [0.85, 0.9, 0.95] : [0.55, 0.48, 0.42];
    const r = Math.cbrt((3 * mass) / (4 * Math.PI * rho));
    const j = [0, 0, 0];
    randUnit(j);
    const sp = Math.hypot(vx, vy, vz) * 0.03;
    this.spawnFragment({
      mass, radius: r, x, y, z, vx: vx + j[0] * sp, vy: vy + j[1] * sp, vz: vz + j[2] * sp,
      color: jitterColor(color), temp: 250,
      comp: { iron: material === 'iron' ? 1 : 0, rock: material === 'rock' ? 1 : 0, water: material === 'water' || material === 'ice' ? 1 : 0, gas: 0 },
    });
  }

  // ---------------------------------------------------------------------------
  // Per-frame processes: temperature, Roche breakup, spin, delayed blasts.

  slowUpdate(dt) {
    const adt = Math.abs(dt);
    this.refreshLists();
    const stars = this.majors.filter((b) => b.lum > 0);

    if (adt > 0) {
      for (const b of this.bodies) {
        if (b.spinPeriod) b.spinAngle = (b.spinAngle + (2 * Math.PI * dt) / b.spinPeriod) % (Math.PI * 2);
        if (b.feed) b.feed = Math.max(0, b.feed - adt / (86400 * 30));
      }
    }

    if (this.pending.length) {
      const due = this.pending.filter((p) => (dt >= 0 ? p.at <= this.time : true));
      this.pending = this.pending.filter((p) => !due.includes(p));
      for (const p of due) {
        const o = this.byId(p.id);
        if (!o) continue;
        const U = bindingEnergy(o.mass, o.radius);
        if (p.energy > 0.5 * U && this.settings.fragment) {
          this.events.push({ type: 'notice', text: `The blast destroyed ${o.name}` });
          this.explode(o, 1 + p.energy / U);
        } else if (o.heat) {
          let nx = p.src[0] - o.x;
          let ny = p.src[1] - o.y;
          let nz = p.src[2] - o.z;
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l; ny /= l; nz /= l;
          const dT = Math.min(5000, p.energy / (C_ROCK * o.mass * 0.01));
          this.heatSpot(o, [nx, ny, nz], Math.PI / 2, Math.min(5000, o.temp + dT), dT * 0.2);
          if (o.atmo && dT > 500) o.atmo = null;
          if (o.clouds && dT > 300) o.clouds = null;
        }
      }
    }

    if (this.settings.temperature && adt > 0) this.thermal(adt, stars);
    if (this.settings.roche && this.settings.fragment && adt > 0) this.rocheStep(adt);

    // Expanding plasma cools, fades, and is forgotten once it is cold.
    for (const b of this.minors) {
      if (b.kind !== 'plasma') continue;
      b.temp *= Math.exp(-adt / (86400 * 60));
      if (b.temp < 900) b.dead = true;
    }
    if (this.minors.some((b) => b.dead)) {
      this.listDirty = true;
      this.accValid = false;
    }
  }

  equilibrium(b, stars) {
    let flux = 0;
    for (const s of stars) {
      if (s === b) continue;
      const d2 = (s.x - b.x) ** 2 + (s.y - b.y) ** 2 + (s.z - b.z) ** 2;
      flux += s.lum / (4 * Math.PI * d2);
    }
    return Math.pow(((1 - b.albedo) * flux) / (4 * SIGMA), 0.25);
  }

  /** Start worlds at the temperature their starlight holds them at. */
  settleTemperatures(list = null) {
    this.refreshLists();
    const stars = this.majors.filter((s) => isStar(s) && s.lum > 0);
    for (const b of list || this.majors) {
      if (isStar(b) || isHole(b)) continue;
      const Teq = this.equilibrium(b, stars);
      const T = Math.max(Teq + (b.atmo ? b.greenhouse : 0), b.internalT || 3);
      b.teq = Teq;
      b.temp = T;
      if (b.heat) {
        b.heat.fill(T);
        b.heatVersion++;
      }
    }
  }

  thermal(dt, stars) {
    for (const b of this.majors) {
      if (isStar(b) || isHole(b)) continue;
      const Teq = this.equilibrium(b, stars);
      const atmoGreen = b.atmo ? b.greenhouse : 0;
      const Tt = Math.max(Teq + atmoGreen, b.internalT || 3);
      b.teq = Teq;
      if (!b.heat) {
        b.temp += (Tt - b.temp) * Math.min(1, dt / (86400 * 20));
        continue;
      }
      const heat = b.heat;
      const rho = b.mass / ((4 / 3) * Math.PI * b.radius ** 3);
      // A molten layer a few kilometres deep radiating from its top.
      const D = Math.min(Math.max(b.radius * 0.0004, 200), 5000);
      const capacity = rho * C_ROCK * D;
      const relax = Math.min(1, dt / (86400 * 15));
      let sum = 0;
      let changed = false;
      for (let k = 0; k < HEAT_N; k++) {
        let T = heat[k];
        if (T > Tt + 1) {
          const T4 = T * T * T * T;
          const Tt4 = Tt * Tt * Tt * Tt;
          const drop = (SIGMA * (T4 - Tt4) * dt) / capacity;
          T = Math.max(Tt, T - Math.min(drop, (T - Tt) * 0.9));
          if (T - Tt < 40) T += (Tt - T) * relax;
          changed = true;
        } else if (Math.abs(T - Tt) > 0.5) {
          T += (Tt - T) * relax;
          changed = true;
        }
        heat[k] = T;
        sum += T * TEXEL_W[k];
      }
      if (changed) b.heatVersion++;
      b.temp = sum / TEXEL_WSUM;
      if (b.temp > 2200 && b.atmo) b.atmo = null;
      if (b.temp > 600 && b.clouds) b.clouds = null;
    }
    for (const b of this.minors) {
      if (b.kind === 'plasma' || b.kind === 'starp') continue;
      if (b.temp > 400) {
        const rho = b.mass / ((4 / 3) * Math.PI * b.radius ** 3);
        // Only the crust has to cool for the glow to go.
        const D = Math.min(b.radius / 3, 2000);
        const drop = (SIGMA * b.temp ** 4 * dt) / (rho * C_ROCK * D);
        b.temp = Math.max(250, b.temp - Math.min(drop, (b.temp - 250) * 0.5));
      }
    }
  }

  rocheStep(dt) {
    const Gm = G * this.settings.gMult;
    const majors = this.majors;
    for (const b of majors) {
      if (b.dead || isStar(b) || isHole(b) || b.radius < 30e3) continue;
      let P = null;
      let best = 0;
      for (const o of majors) {
        if (o === b || o.mass < 3 * b.mass) continue;
        const d2 = (o.x - b.x) ** 2 + (o.y - b.y) ** 2 + (o.z - b.z) ** 2;
        const pull = o.mass / d2;
        if (pull > best) {
          best = pull;
          P = o;
        }
      }
      if (!P) continue;
      const rx = b.x - P.x;
      const ry = b.y - P.y;
      const rz = b.z - P.z;
      const d = Math.hypot(rx, ry, rz);
      // Fluid Roche limit: worlds this size hold together by gravity, not strength.
      const dR = 2.44 * b.radius * Math.cbrt(P.mass / b.mass);
      if (d >= dR || d < P.radius) continue;
      if (!b.rocheChunk) {
        b.rocheChunk = b.mass / 1000;
        this.events.push({ type: 'notice', text: `${b.name} crossed ${P.name}'s Roche limit and is breaking apart` });
      }
      const s = (dR / d) ** 3 - 1;
      const tdyn = Math.sqrt(b.radius ** 3 / (Gm * b.mass));
      b.rocheShed += b.mass * Math.min(0.6, ((s * dt) / tdyn) * 0.25);
      // Co-rotation with the orbit, so pieces on the near side fall behind and
      // inward and those on the far side pull ahead and out: that shear is what
      // spreads a broken moon into a ring.
      const vx = b.vx - P.vx;
      const vy = b.vy - P.vy;
      const vz = b.vz - P.vz;
      const d2 = d * d;
      const wx = (ry * vz - rz * vy) / d2;
      const wy = (rz * vx - rx * vz) / d2;
      const wz = (rx * vy - ry * vx) / d2;
      let made = 0;
      const dir = [0, 0, 0];
      // A fluid world inside the limit stretches until material spills over its
      // Hill sphere at L1 and L2. A rigid sphere never does, so shed pieces are
      // launched along the tidal axis just fast enough to get there.
      const rH = d * Math.cbrt(b.mass / (3 * P.mass));
      while (b.rocheShed >= b.rocheChunk && made < 40 && this.fragmentCount() < this.settings.maxFragments) {
        const m = Math.min(b.rocheChunk, b.mass);
        b.rocheShed -= m;
        made++;
        b.rocheFlip = (b.rocheFlip || 0) + 1;
        const near = b.rocheFlip % 2 ? -1 : 1;
        randCone((rx / d) * near, (ry / d) * near, (rz / d) * near, 0.4, dir);
        const rho = (b.mass / ((4 / 3) * Math.PI * b.radius ** 3)) * (0.5 + 0.5 * rand());
        const r = Math.cbrt((3 * m) / (4 * Math.PI * rho));
        b.mass -= m;
        if (b.mass > 0) b.radius *= Math.cbrt(b.mass / (b.mass + m));
        const lift = b.radius + r * 1.05;
        const ox = dir[0] * lift;
        const oy = dir[1] * lift;
        const oz = dir[2] * lift;
        const vEsc = Math.sqrt((2 * Gm * b.mass) / lift);
        const vOut = rH > lift ? 1.08 * Math.sqrt(2 * Gm * b.mass * (1 / lift - 1 / rH)) + 0.04 * vEsc : 0.08 * vEsc;
        this.spawnFragment({
          mass: m, radius: r,
          x: b.x + ox, y: b.y + oy, z: b.z + oz,
          vx: b.vx + (wy * oz - wz * oy) + dir[0] * vOut,
          vy: b.vy + (wz * ox - wx * oz) + dir[1] * vOut,
          vz: b.vz + (wx * oy - wy * ox) + dir[2] * vOut,
          color: jitterColor(b.color), comp: b.comp, temp: b.temp, tidal: true, src: b.id,
        }, b, 1e12);
        if (b.mass > 0) {
          const k = m / b.mass;
          b.vx -= k * ((wy * oz - wz * oy) + dir[0] * vOut);
          b.vy -= k * ((wz * ox - wx * oz) + dir[1] * vOut);
          b.vz -= k * ((wx * oy - wy * ox) + dir[2] * vOut);
        }
        if (b.mass < 2.5 * b.rocheChunk) {
          this.spawnFragment({
            mass: b.mass, radius: b.radius, x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz,
            color: b.color, comp: b.comp, temp: b.temp, tidal: true,
          });
          this.events.push({ type: 'merged', from: b.id, into: 0 });
          b.dead = true;
          this.listDirty = true;
          break;
        }
      }
      if (made) {
        this.listDirty = true;
        this.accValid = false;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Save / load

  serialize() {
    this.refreshLists();
    const keep = ['name', 'kind', 'minor', 'ghost', 'mass', 'radius', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'temp', 'albedo',
      'greenhouse', 'internalT', 'lum', 'spinPeriod', 'spinAngle', 'tilt', 'color', 'tex', 'proc', 'night', 'clouds', 'atmo',
      'rings', 'comp', 'msStar', 'initMass'];
    return {
      time: this.time,
      settings: { ...this.settings },
      bodies: this.bodies.map((b) => Object.fromEntries(keep.map((k) => [k, b[k]]))),
    };
  }

  load(data) {
    this.clear();
    Object.assign(this.settings, data.settings || {});
    this.time = data.time || 0;
    for (const spec of data.bodies) this.add(makeBody(spec));
  }
}

function jitterColor(c) {
  const j = 0.85 + rand() * 0.3;
  return [Math.min(1, c[0] * j), Math.min(1, c[1] * j), Math.min(1, c[2] * j)];
}

/** Earliest fraction of the last substep at which a and b were `R` apart, or -1. */
function swept(a, b, R) {
  const r0x = b.ox - a.ox;
  const r0y = b.oy - a.oy;
  const r0z = b.oz - a.oz;
  const r1x = b.x - a.x;
  const r1y = b.y - a.y;
  const r1z = b.z - a.z;
  const R2 = R * R;
  const c0 = r0x * r0x + r0y * r0y + r0z * r0z;
  if (c0 < R2) return 0;
  const dx = r1x - r0x;
  const dy = r1y - r0y;
  const dz = r1z - r0z;
  const A = dx * dx + dy * dy + dz * dz;
  if (A === 0) return -1;
  const B = 2 * (r0x * dx + r0y * dy + r0z * dz);
  if (B >= 0) return -1;
  const disc = B * B - 4 * A * (c0 - R2);
  if (disc < 0) return -1;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  return t >= 0 && t <= 1 ? t : -1;
}

/** World direction to body-local, the inverse of the render rotation Rx(tilt)·Ry(spin). */
export function worldToLocal(b, x, y, z) {
  const ct = Math.cos(-b.tilt);
  const st = Math.sin(-b.tilt);
  const y1 = y * ct - z * st;
  const z1 = y * st + z * ct;
  const cs = Math.cos(-b.spinAngle);
  const ss = Math.sin(-b.spinAngle);
  const x2 = x * cs + z1 * ss;
  const z2 = -x * ss + z1 * cs;
  return [x2, y1, z2];
}

/** Barnes–Hut octree over the minor bodies, in flat typed arrays. */
class Octree {
  constructor() {
    this.cap = 0;
    this.ensure(1024);
  }

  ensure(n) {
    if (n <= this.cap) return;
    this.cap = n;
    this.m = new Float64Array(n);
    this.wx = new Float64Array(n);
    this.wy = new Float64Array(n);
    this.wz = new Float64Array(n);
    this.cx = new Float64Array(n);
    this.cy = new Float64Array(n);
    this.cz = new Float64Array(n);
    this.h = new Float64Array(n);
    this.leaf = new Int32Array(n);
    this.child = new Int32Array(n * 8);
  }

  node(cx, cy, cz, h) {
    const i = this.count++;
    this.m[i] = 0;
    this.wx[i] = 0;
    this.wy[i] = 0;
    this.wz[i] = 0;
    this.cx[i] = cx;
    this.cy[i] = cy;
    this.cz[i] = cz;
    this.h[i] = h;
    this.leaf[i] = -1;
    this.child.fill(-1, i * 8, i * 8 + 8);
    return i;
  }

  build(list) {
    this.list = list;
    this.ensure(list.length * 4 + 64);
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const b of list) {
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.z < minZ) minZ = b.z;
      if (b.x > maxX) maxX = b.x;
      if (b.y > maxY) maxY = b.y;
      if (b.z > maxZ) maxZ = b.z;
    }
    const h = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 0.5 + 1;
    this.count = 0;
    this.node((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2, h);
    for (let i = 0; i < list.length; i++) this.insert(i);
  }

  octant(n, x, y, z) {
    return (x > this.cx[n] ? 1 : 0) | (y > this.cy[n] ? 2 : 0) | (z > this.cz[n] ? 4 : 0);
  }

  makeChild(n, o) {
    if (this.count >= this.cap - 1) {
      // Out of room: grow and keep going. Copy the arrays over.
      const old = this;
      const keep = {
        m: old.m, wx: old.wx, wy: old.wy, wz: old.wz, cx: old.cx, cy: old.cy, cz: old.cz, h: old.h, leaf: old.leaf, child: old.child,
      };
      const cap = this.cap;
      this.cap = 0;
      this.ensure(cap * 2);
      for (const k of Object.keys(keep)) this[k].set(keep[k]);
      this.child.fill(-1, cap * 8);
    }
    const h = this.h[n] * 0.5;
    const c = this.node(
      this.cx[n] + (o & 1 ? h : -h),
      this.cy[n] + (o & 2 ? h : -h),
      this.cz[n] + (o & 4 ? h : -h),
      h,
    );
    this.child[n * 8 + o] = c;
    return c;
  }

  insert(i) {
    const b = this.list[i];
    let n = 0;
    let depth = 0;
    for (;;) {
      this.m[n] += b.mass;
      this.wx[n] += b.mass * b.x;
      this.wy[n] += b.mass * b.y;
      this.wz[n] += b.mass * b.z;
      const lb = this.leaf[n];
      if (lb === -1) {
        this.leaf[n] = i;
        return;
      }
      if (lb >= 0) {
        if (depth > 40) return;
        const o = this.list[lb];
        this.leaf[n] = -2;
        const oc = this.octant(n, o.x, o.y, o.z);
        const c = this.makeChild(n, oc);
        this.m[c] += o.mass;
        this.wx[c] += o.mass * o.x;
        this.wy[c] += o.mass * o.y;
        this.wz[c] += o.mass * o.z;
        this.leaf[c] = lb;
      }
      const oct = this.octant(n, b.x, b.y, b.z);
      let c = this.child[n * 8 + oct];
      if (c < 0) {
        c = this.makeChild(n, oct);
        this.m[c] += b.mass;
        this.wx[c] += b.mass * b.x;
        this.wy[c] += b.mass * b.y;
        this.wz[c] += b.mass * b.z;
        this.leaf[c] = i;
        return;
      }
      n = c;
      depth++;
    }
  }

  accel(b, Gm, eps2, theta) {
    const stack = this._stack || (this._stack = new Int32Array(4096));
    let sp = 0;
    stack[sp++] = 0;
    const th2 = theta * theta;
    let ax = 0;
    let ay = 0;
    let az = 0;
    const list = this.list;
    while (sp > 0) {
      const n = stack[--sp];
      const m = this.m[n];
      if (m === 0) continue;
      const lb = this.leaf[n];
      if (lb >= 0 && list[lb] === b) {
        // This leaf holds the body itself; any other mass aggregated here is
        // effectively at its position.
        continue;
      }
      const mx = this.wx[n] / m - b.x;
      const my = this.wy[n] / m - b.y;
      const mz = this.wz[n] / m - b.z;
      const r2 = mx * mx + my * my + mz * mz;
      const size = this.h[n] * 2;
      if (lb >= 0 || size * size < th2 * r2) {
        const q = r2 + eps2 + 1;
        const f = (Gm * m) / (q * Math.sqrt(q));
        ax += mx * f;
        ay += my * f;
        az += mz * f;
      } else {
        const base = n * 8;
        for (let o = 0; o < 8; o++) {
          const c = this.child[base + o];
          if (c >= 0) {
            if (sp >= stack.length - 1) {
              const bigger = new Int32Array(stack.length * 2);
              bigger.set(stack);
              this._stack = bigger;
              return this.accelSlow(b, Gm, eps2, theta);
            }
            stack[sp++] = c;
          }
        }
      }
    }
    b.ax += ax;
    b.ay += ay;
    b.az += az;
  }

  accelSlow(b, Gm, eps2, theta) {
    return this.accel(b, Gm, eps2, theta);
  }
}
