import { BufferAttribute, BufferGeometry, Matrix4, Quaternion, ShaderMaterial, Vector3 } from 'three';

/**
 * Spacecraft models, built out of primitives.
 *
 * There is no model loader in this project and no reason to add one: a
 * spacecraft is mostly boxes, cylinders, dishes and flat panels, which is
 * exactly what a few hundred lines of geometry can make. Building them in code
 * also means one file describes every craft, the silhouettes stay consistent,
 * and there are no binary assets to ship or keep in step with the data.
 *
 * Each model is merged into a single BufferGeometry with the part colours baked
 * into vertex attributes, so a spacecraft is one draw call however many parts it
 * has. Geometry is cached per model name and shared between craft that use the
 * same one, which is what lets thirty satellites cost thirty meshes rather than
 * thirty model builds.
 *
 * Everything is built in metres. The renderer works in kilometres, so the mesh
 * is scaled by a thousandth when it goes into the scene.
 */

// Surface finishes. Spacecraft are mostly white paint, gold thermal blanket,
// bare aluminium and black solar cell, and getting those four right is most of
// what makes a model read as a spacecraft rather than as a pile of boxes.
export const FINISH = {
  white: [0.88, 0.88, 0.86, 0.25],
  grey: [0.55, 0.56, 0.58, 0.35],
  dark: [0.16, 0.16, 0.18, 0.2],
  black: [0.05, 0.05, 0.06, 0.1],
  gold: [0.85, 0.65, 0.22, 0.75],
  copper: [0.72, 0.42, 0.2, 0.7],
  alu: [0.72, 0.74, 0.78, 0.8],
  panel: [0.09, 0.13, 0.32, 0.55],
  panelBack: [0.35, 0.3, 0.26, 0.2],
  radiator: [0.93, 0.93, 0.95, 0.3],
  foil: [0.78, 0.72, 0.55, 0.6],
  red: [0.6, 0.15, 0.12, 0.3],
};

/** Accumulates primitives into flat arrays, then hands over a geometry. */
class Kit {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.spec = [];
    this.idx = [];
    this.m = new Matrix4();
    this.nm = new Matrix4();
    this._v = new Vector3();
    this._n = new Vector3();
  }

  /** Sets the transform applied to everything added until it changes again. */
  at(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const q = new Quaternion();
    const qx = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), rx);
    const qy = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), ry);
    const qz = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), rz);
    q.multiply(qy).multiply(qx).multiply(qz);
    this.m.compose(new Vector3(x, y, z), q, new Vector3(sx, sy, sz));
    this.nm.copy(this.m);
    this.nm.setPosition(0, 0, 0);
    return this;
  }

  _push(x, y, z, nx, ny, nz, finish) {
    this._v.set(x, y, z).applyMatrix4(this.m);
    this._n.set(nx, ny, nz).applyMatrix4(this.nm).normalize();
    this.pos.push(this._v.x, this._v.y, this._v.z);
    this.nrm.push(this._n.x, this._n.y, this._n.z);
    this.col.push(finish[0], finish[1], finish[2]);
    this.spec.push(finish[3]);
  }

  _quad(a, b, c, d, n, finish) {
    const base = this.pos.length / 3;
    this._push(a[0], a[1], a[2], n[0], n[1], n[2], finish);
    this._push(b[0], b[1], b[2], n[0], n[1], n[2], finish);
    this._push(c[0], c[1], c[2], n[0], n[1], n[2], finish);
    this._push(d[0], d[1], d[2], n[0], n[1], n[2], finish);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Axis-aligned box centred on the current transform origin. */
  box(w, h, d, finish, faces = null) {
    const x = w / 2;
    const y = h / 2;
    const z = d / 2;
    const top = faces?.top ?? finish;
    const bottom = faces?.bottom ?? finish;
    const side = faces?.side ?? finish;
    this._quad([-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z], [0, 1, 0], top);
    this._quad([-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z], [0, -1, 0], bottom);
    this._quad([-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z], [0, 0, 1], side);
    this._quad([x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z], [0, 0, -1], side);
    this._quad([x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z], [1, 0, 0], side);
    this._quad([-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z], [-1, 0, 0], side);
    return this;
  }

  /** A flat panel in the XZ plane, two-sided with a different back finish. */
  panel(w, d, finish = FINISH.panel, back = FINISH.panelBack, thickness = 0.03) {
    this.box(w, thickness, d, finish, { top: finish, bottom: back, side: back });
    return this;
  }

  /** Solar array with cell divisions, which is what makes it read as an array. */
  array(w, d, cells = 4, finish = FINISH.panel) {
    const cw = w / cells;
    const save = this.m.clone();
    const shift = new Matrix4();
    for (let i = 0; i < cells; i++) {
      const cx = -w / 2 + cw * (i + 0.5);
      // The offset has to go through the current transform, not be applied to
      // the vertices afterwards: a wing rotated onto a spoke would otherwise
      // have its cells laid out along world X and come apart.
      this.m.copy(save).multiply(shift.makeTranslation(cx, 0, 0));
      this.nm.copy(this.m).setPosition(0, 0, 0);
      this.box(cw * 0.94, 0.04, d * 0.96, finish, {
        top: finish, bottom: FINISH.panelBack, side: FINISH.alu,
      });
    }
    this.m.copy(save);
    this.nm.copy(this.m).setPosition(0, 0, 0);
    return this;
  }

  /** Cylinder along Y, open or capped. */
  cyl(r, h, finish, segments = 16, caps = true, rTop = null) {
    const top = rTop ?? r;
    const base = this.pos.length / 3;
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      this._push(c * r, -h / 2, s * r, c, 0, s, finish);
      this._push(c * top, h / 2, s * top, c, 0, s, finish);
    }
    for (let i = 0; i < segments; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 2, a + 3, a, a + 3, a + 1);
    }
    if (caps) {
      for (const [y, ny, rad] of [[-h / 2, -1, r], [h / 2, 1, top]]) {
        const centre = this.pos.length / 3;
        this._push(0, y, 0, 0, ny, 0, finish);
        for (let i = 0; i <= segments; i++) {
          const a = (i / segments) * Math.PI * 2;
          this._push(Math.cos(a) * rad, y, Math.sin(a) * rad, 0, ny, 0, finish);
        }
        for (let i = 0; i < segments; i++) {
          if (ny > 0) this.idx.push(centre, centre + 1 + i, centre + 2 + i);
          else this.idx.push(centre, centre + 2 + i, centre + 1 + i);
        }
      }
    }
    return this;
  }

  /** Parabolic dish opening towards +Y. */
  dish(r, depth, finish = FINISH.white, back = FINISH.grey, segments = 20, rings = 4) {
    const base = this.pos.length / 3;
    const at = (ring, seg) => {
      const rr = (ring / rings) * r;
      const a = (seg / segments) * Math.PI * 2;
      const y = (rr * rr / (r * r)) * depth;
      return [Math.cos(a) * rr, y, Math.sin(a) * rr];
    };
    for (let ring = 0; ring <= rings; ring++) {
      for (let seg = 0; seg <= segments; seg++) {
        const p = at(ring, seg);
        const rr = (ring / rings) * r;
        const slope = (2 * rr * depth) / (r * r);
        const a = (seg / segments) * Math.PI * 2;
        this._push(p[0], p[1], p[2], -Math.cos(a) * slope, 1, -Math.sin(a) * slope, finish);
      }
    }
    const stride = segments + 1;
    for (let ring = 0; ring < rings; ring++) {
      for (let seg = 0; seg < segments; seg++) {
        const a = base + ring * stride + seg;
        this.idx.push(a, a + 1, a + stride + 1, a, a + stride + 1, a + stride);
      }
    }
    // Back face, so the dish is not invisible from behind.
    const back0 = this.pos.length / 3;
    for (let ring = 0; ring <= rings; ring++) {
      for (let seg = 0; seg <= segments; seg++) {
        const p = at(ring, seg);
        const rr = (ring / rings) * r;
        const slope = (2 * rr * depth) / (r * r);
        const a = (seg / segments) * Math.PI * 2;
        this._push(p[0], p[1] - 0.02, p[2], Math.cos(a) * slope, -1, Math.sin(a) * slope, back);
      }
    }
    for (let ring = 0; ring < rings; ring++) {
      for (let seg = 0; seg < segments; seg++) {
        const a = back0 + ring * stride + seg;
        this.idx.push(a, a + stride + 1, a + 1, a, a + stride, a + stride + 1);
      }
    }
    return this;
  }

  /** Thin strut between two points, for booms and truss members. */
  strut(from, to, r, finish = FINISH.alu, segments = 6) {
    const dir = new Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const len = dir.length();
    if (len < 1e-6) return this;
    const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize());
    const saveM = this.m.clone();
    const local = new Matrix4().compose(new Vector3(...mid), q, new Vector3(1, 1, 1));
    this.m.multiply(local);
    this.nm.copy(this.m).setPosition(0, 0, 0);
    this.cyl(r, len, finish, segments, false);
    this.m.copy(saveM);
    this.nm.copy(this.m).setPosition(0, 0, 0);
    return this;
  }

  /** Faceted sphere. */
  ball(r, finish, segments = 12, rings = 8) {
    const base = this.pos.length / 3;
    for (let ring = 0; ring <= rings; ring++) {
      const phi = (ring / rings) * Math.PI;
      for (let seg = 0; seg <= segments; seg++) {
        const th = (seg / segments) * Math.PI * 2;
        const nx = Math.sin(phi) * Math.cos(th);
        const ny = Math.cos(phi);
        const nz = Math.sin(phi) * Math.sin(th);
        this._push(nx * r, ny * r, nz * r, nx, ny, nz, finish);
      }
    }
    const stride = segments + 1;
    for (let ring = 0; ring < rings; ring++) {
      for (let seg = 0; seg < segments; seg++) {
        const a = base + ring * stride + seg;
        this.idx.push(a, a + stride, a + stride + 1, a, a + stride + 1, a + 1);
      }
    }
    return this;
  }

  /** Cone along Y, apex at +h/2. Capsules and entry shells. */
  cone(rBase, h, finish, segments = 16) {
    return this.cyl(rBase, h, finish, segments, true, rBase * 0.08);
  }

  geometry() {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('aTint', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aSpec', new BufferAttribute(new Float32Array(this.spec), 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------- models

/**
 * Generic bus with panels and a dish, parameterised enough to stand in for the
 * many spacecraft that really do look like that. Anything with a silhouette
 * worth recognising gets its own builder below.
 */
function generic(kit, {
  bus = [2, 2, 2], span = 8, wings = 2, dishR = 1.2, cells = 4, finish = FINISH.white,
} = {}) {
  kit.at(0, 0, 0).box(bus[0], bus[1], bus[2], finish, {
    top: FINISH.gold, bottom: FINISH.dark, side: finish,
  });
  if (dishR > 0) {
    kit.at(0, bus[1] / 2 + dishR * 0.35, 0).dish(dishR, dishR * 0.35);
    kit.at(0, bus[1] / 2 + dishR * 0.1, 0).cyl(0.06, dishR * 0.5, FINISH.alu, 6, false);
  }
  const wingLen = Math.max(0.5, (span - bus[0]) / 2);
  for (let i = 0; i < wings; i++) {
    const sign = i % 2 === 0 ? 1 : -1;
    kit.at(sign * (bus[0] / 2 + wingLen / 2), 0, 0)
      .array(wingLen, bus[2] * 1.4, cells);
    kit.strut(
      [sign * bus[0] / 2, 0, 0],
      [sign * (bus[0] / 2 + wingLen * 0.2), 0, 0],
      0.05,
    );
  }
  return kit;
}

/** Deep-space craft: big dish on top, bus below, RTG and instrument booms. */
function deepSpace(kit, { dishR = 1.85, busR = 0.9, rtgs = 3, boom = 6 }) {
  kit.at(0, busR * 0.6 + dishR * 0.3, 0).dish(dishR, dishR * 0.3, FINISH.white, FINISH.grey, 24, 5);
  kit.at(0, 0, 0).cyl(busR, busR * 0.9, FINISH.gold, 10);
  kit.at(0, busR * 0.5, 0).cyl(0.08, dishR * 0.6, FINISH.alu, 6, false);
  for (let i = 0; i < rtgs; i++) {
    const a = (i / Math.max(1, rtgs)) * Math.PI * 2;
    const x = Math.cos(a) * (busR + 1.1);
    const z = Math.sin(a) * (busR + 1.1);
    kit.strut([Math.cos(a) * busR, -0.2, Math.sin(a) * busR], [x, -0.4, z], 0.05);
    kit.at(x, -0.45, z, 0, a, Math.PI / 2).cyl(0.22, 1.1, FINISH.dark, 8);
  }
  if (boom > 0) {
    kit.strut([0, 0, busR], [0, 0, busR + boom], 0.035, FINISH.alu, 5);
    kit.at(0, 0, busR + boom).ball(0.12, FINISH.white, 8, 6);
  }
  return kit;
}

const BUILDERS = {
  // ------------------------------------------------------------------- ISS
  iss(kit) {
    // The main truss runs along X, the modules along Z, and the eight arrays
    // hang off the truss ends in pairs. That arrangement is the silhouette.
    kit.at(0, 0, 0).box(94, 1.6, 1.6, FINISH.alu);
    for (let i = -4; i <= 4; i++) {
      kit.at(i * 9, 0, 0).box(1.1, 2.2, 2.2, FINISH.grey);
    }
    // Pressurised modules, fore and aft along Z.
    kit.at(0, -2.2, 0, Math.PI / 2, 0, 0).cyl(2.1, 24, FINISH.white, 16);
    kit.at(0, -2.2, 14, Math.PI / 2, 0, 0).cyl(2.2, 8, FINISH.white, 16);
    kit.at(0, -2.2, -13, Math.PI / 2, 0, 0).cyl(2.0, 7, FINISH.white, 14);
    kit.at(4.5, -2.2, 6, 0, 0, Math.PI / 2).cyl(1.9, 7, FINISH.white, 14);
    kit.at(-4.5, -2.2, 6, 0, 0, Math.PI / 2).cyl(1.9, 7, FINISH.white, 14);
    kit.at(0, -5.4, 8).ball(1.3, FINISH.dark, 10, 8);
    // Solar arrays: four pairs, each pair on a rotary joint at the truss ends.
    for (const [x, sign] of [[-42, 1], [-42, -1], [-33, 1], [-33, -1], [33, 1], [33, -1], [42, 1], [42, -1]]) {
      kit.at(x, 0, sign * 19).array(34, 11.5, 8);
      kit.strut([x, 0, sign * 2], [x, 0, sign * 13], 0.3, FINISH.grey);
    }
    // Thermal radiators, white and edge-on to the Sun.
    for (const z of [-1, 1]) {
      kit.at(0, z * 6.5, 0, 0, 0, z * 0.25).panel(22, 8, FINISH.radiator, FINISH.radiator, 0.2);
    }
    // Robotic arm, jointed, because it is always in silhouette photographs.
    kit.strut([6, 2, -2], [14, 7, -4], 0.35, FINISH.white, 8);
    kit.strut([14, 7, -4], [20, 3, -9], 0.32, FINISH.white, 8);
    return kit;
  },

  hubble(kit) {
    kit.at(0, 0, 0).cyl(2.2, 13.2, FINISH.foil, 24);
    kit.at(0, 6.7, 0).cyl(2.05, 0.6, FINISH.dark, 24);
    // Aperture door, hinged open at the top.
    kit.at(0, 7.6, 1.6, 0.5, 0, 0).panel(4.2, 4.2, FINISH.white, FINISH.alu, 0.12);
    for (const s of [1, -1]) {
      kit.at(s * 4.6, -1, 0).array(4.6, 12.2, 3);
      kit.strut([s * 2.2, -1, 0], [s * 2.4, -1, 0], 0.12, FINISH.alu);
    }
    for (const s of [1, -1]) {
      kit.at(0, -1.5, s * 3.1, Math.PI / 2 * (s > 0 ? 1 : -1), 0, 0).dish(1.3, 0.4, FINISH.white, FINISH.grey, 14, 3);
      kit.strut([0, -1.5, s * 2.2], [0, -1.5, s * 2.9], 0.08, FINISH.alu);
    }
    kit.at(0, -6.7, 0).cyl(2.2, 0.4, FINISH.dark, 24);
    return kit;
  },

  voyager(kit) {
    deepSpace(kit, { dishR: 1.85, busR: 0.9, rtgs: 3, boom: 6.5 });
    // The two 10 m planetary radio astronomy antennas, in a wide V.
    kit.strut([0, -0.3, 0], [7, -5, 4], 0.03, FINISH.alu, 4);
    kit.strut([0, -0.3, 0], [-7, -5, 4], 0.03, FINISH.alu, 4);
    // Scan platform with the cameras, on a short boom opposite the RTGs.
    kit.strut([0, -0.1, -0.9], [0, -0.3, -2.4], 0.05);
    kit.at(0, -0.35, -2.7).box(0.5, 0.4, 0.6, FINISH.dark);
    return kit;
  },

  pioneer(kit) {
    kit.at(0, 0.6, 0).dish(1.37, 0.45, FINISH.white, FINISH.grey, 20, 4);
    kit.at(0, 0, 0).cyl(0.72, 0.36, FINISH.gold, 6);
    kit.strut([0, 0.1, 0], [0, 0.85, 0], 0.05);
    for (const s of [1, -1]) {
      kit.strut([s * 0.6, -0.1, 0], [s * 3, -0.3, 0], 0.04);
      kit.at(s * 3.2, -0.35, 0, 0, 0, Math.PI / 2).cyl(0.15, 0.7, FINISH.dark, 8);
    }
    kit.strut([0, 0, 0.6], [0, 0.2, 3.2], 0.03);
    return kit;
  },

  newhorizons(kit) {
    kit.at(0, 0.55, 0).dish(1.05, 0.32, FINISH.white, FINISH.grey, 20, 4);
    kit.at(0, 0, 0).box(2.1, 0.7, 2.7, FINISH.foil, {
      top: FINISH.foil, bottom: FINISH.dark, side: FINISH.foil,
    });
    kit.strut([0, 0.3, 0], [0, 0.6, 0], 0.06);
    // Single RTG, sticking out sideways, which is the recognisable asymmetry.
    kit.at(-1.9, -0.1, 0, 0, 0, Math.PI / 2).cyl(0.21, 1.1, FINISH.dark, 10);
    kit.strut([-1.05, -0.1, 0], [-1.5, -0.1, 0], 0.07);
    kit.at(0.7, -0.2, 1.2).box(0.4, 0.3, 0.5, FINISH.dark);
    return kit;
  },

  cassini(kit) {
    kit.at(0, 3.1, 0).dish(2, 0.5, FINISH.white, FINISH.grey, 24, 5);
    kit.at(0, 1.5, 0).cyl(1.35, 1.4, FINISH.gold, 12);
    kit.at(0, 0.2, 0).cyl(1.15, 1.2, FINISH.foil, 12);
    kit.at(0, -0.9, 0).cyl(0.9, 1, FINISH.dark, 12);
    kit.strut([0, 2.2, 0], [0, 2.9, 0], 0.12);
    // Huygens, a shallow disc bolted to the side.
    kit.at(1.5, 0.4, 0, 0, 0, Math.PI / 2).cyl(1.3, 0.5, FINISH.alu, 16);
    // Magnetometer boom, 11 m of it.
    kit.strut([0, 1.4, 1.1], [0, 1.6, 11.5], 0.04, FINISH.alu, 5);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.6;
      kit.strut(
        [Math.cos(a) * 0.9, -1.4, Math.sin(a) * 0.9],
        [Math.cos(a) * 1.5, -2.4, Math.sin(a) * 1.5],
        0.05,
      );
      kit.at(Math.cos(a) * 1.6, -2.6, Math.sin(a) * 1.6).cyl(0.2, 0.9, FINISH.dark, 8);
    }
    return kit;
  },

  juno(kit) {
    // Three solar wings at 120 degrees, each nine metres long. Juno is mostly
    // wing: the bus is a hexagon two metres across at the middle of a
    // twenty-metre pinwheel.
    kit.at(0, 0, 0).cyl(1.7, 2, FINISH.gold, 6);
    kit.at(0, 1.1, 0).dish(1.3, 0.4, FINISH.white, FINISH.grey, 18, 4);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const len = 8.9;
      const cx = Math.cos(a) * (1.7 + len / 2);
      const cz = Math.sin(a) * (1.7 + len / 2);
      kit.at(cx, -0.2, cz, 0, -a, 0).array(len, 2.65, 3);
      kit.strut(
        [Math.cos(a) * 1.6, -0.2, Math.sin(a) * 1.6],
        [Math.cos(a) * 2.3, -0.2, Math.sin(a) * 2.3],
        0.08,
      );
    }
    return kit;
  },

  galileo(kit) {
    kit.at(0, 1.9, 0).dish(2.4, 0.6, FINISH.white, FINISH.grey, 22, 5);
    kit.at(0, 0.4, 0).cyl(1.1, 1.2, FINISH.gold, 12);
    kit.at(0, -0.6, 0).cyl(0.95, 0.9, FINISH.foil, 12);
    kit.strut([0, 1, 0], [0, 1.7, 0], 0.1);
    for (const s of [1, -1]) {
      kit.strut([s * 0.9, -0.3, 0], [s * 4.2, -0.6, 0], 0.05);
      kit.at(s * 4.5, -0.65, 0, 0, 0, Math.PI / 2).cyl(0.22, 1.1, FINISH.dark, 8);
    }
    kit.strut([0, 0, 1], [0, 0.2, 11], 0.035, FINISH.alu, 5);
    // The descent probe, hung underneath before release.
    kit.at(0, -1.7, 0).cone(0.63, 0.8, FINISH.alu, 14);
    return kit;
  },

  parker(kit) {
    // The heat shield is the whole point: a 2.3 m carbon disc held above a
    // small bus, with everything else hiding in its shadow.
    kit.at(0, 1.5, 0).cyl(1.15, 0.12, FINISH.white, 24);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      kit.strut(
        [Math.cos(a) * 0.5, 0.5, Math.sin(a) * 0.5],
        [Math.cos(a) * 0.85, 1.42, Math.sin(a) * 0.85],
        0.04,
      );
    }
    kit.at(0, 0.1, 0).box(1, 1.2, 1, FINISH.gold, {
      top: FINISH.dark, bottom: FINISH.dark, side: FINISH.gold,
    });
    for (const s of [1, -1]) {
      kit.at(s * 1.05, 0.3, 0, 0, 0, s * 0.35).array(1.2, 0.65, 2);
    }
    kit.at(0, -0.7, 0).dish(0.5, 0.15, FINISH.white, FINISH.grey, 14, 3);
    return kit;
  },

  solarorbiter(kit) {
    kit.at(0, 0.9, 0).panel(3, 2.4, FINISH.dark, FINISH.foil, 0.14);
    kit.at(0, 0, 0).box(2.5, 1.6, 2.1, FINISH.foil, {
      top: FINISH.dark, bottom: FINISH.dark, side: FINISH.foil,
    });
    for (const s of [1, -1]) {
      kit.at(s * 4.2, 0.1, 0).array(5.4, 2.1, 3);
      kit.strut([s * 1.25, 0.1, 0], [s * 1.6, 0.1, 0], 0.08);
    }
    kit.strut([0, 0, -1], [0, 0.2, -5.5], 0.04, FINISH.alu, 5);
    kit.at(0, -1.1, 0.6).dish(0.6, 0.2, FINISH.white, FINISH.grey, 14, 3);
    return kit;
  },

  orion(kit) {
    // Crew module cone on top of the European service module, with the four
    // arrays in an X, which is the shape everyone recognises from Artemis 1.
    kit.at(0, 1.6, 0).cyl(2.5, 3.2, FINISH.dark, 20, true, 0.9);
    kit.at(0, 3.3, 0).cyl(0.85, 0.4, FINISH.alu, 12);
    kit.at(0, -0.6, 0).cyl(2.55, 1.2, FINISH.white, 20);
    kit.at(0, -2.4, 0).cyl(2.25, 2.5, FINISH.white, 20);
    kit.at(0, -3.9, 0).cyl(0.6, 0.9, FINISH.dark, 12, true, 0.95);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const len = 5.4;
      kit.at(Math.cos(a) * (2.2 + len / 2), -2.4, Math.sin(a) * (2.2 + len / 2), 0, -a, 0)
        .array(len, 2.1, 3);
      kit.strut(
        [Math.cos(a) * 2.2, -2.4, Math.sin(a) * 2.2],
        [Math.cos(a) * 2.9, -2.4, Math.sin(a) * 2.9],
        0.09,
      );
    }
    return kit;
  },

  lm(kit) {
    // Descent stage: an octagonal box on four legs. Ascent stage: the lumpy
    // crew cabin with its front windows and the docking tunnel on top.
    kit.at(0, -1.2, 0).cyl(2.1, 1.7, FINISH.gold, 8);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const fx = Math.cos(a);
      const fz = Math.sin(a);
      kit.strut([fx * 1.5, -1.5, fz * 1.5], [fx * 4.3, -3.2, fz * 4.3], 0.09, FINISH.alu);
      kit.strut([fx * 1.7, -0.6, fz * 1.7], [fx * 4.1, -3.1, fz * 4.1], 0.07, FINISH.alu);
      kit.at(fx * 4.4, -3.3, fz * 4.4).cyl(0.47, 0.16, FINISH.alu, 12);
    }
    kit.at(0, -2.4, 0).cyl(0.35, 0.9, FINISH.dark, 12, true, 0.75);
    kit.at(0, 0.3, 0).cyl(1.45, 1.4, FINISH.foil, 8);
    kit.at(0, 0.5, 1.35).box(1.5, 1.1, 0.7, FINISH.alu);
    for (const s of [1, -1]) {
      kit.at(s * 0.42, 0.75, 1.72, 0.35, 0, 0).panel(0.42, 0.34, FINISH.black, FINISH.alu, 0.05);
    }
    kit.at(0, 1.2, 0).cyl(0.42, 0.5, FINISH.alu, 12);
    kit.at(0, 1.55, 0).cyl(0.5, 0.16, FINISH.dark, 12);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      kit.at(Math.cos(a) * 1.65, 0.8, Math.sin(a) * 1.65).box(0.3, 0.3, 0.3, FINISH.dark);
    }
    return kit;
  },

  sivb(kit) {
    kit.at(0, 0, 0).cyl(3.3, 17.8, FINISH.white, 20);
    kit.at(0, 8.5, 0).cyl(3.3, 0.9, FINISH.dark, 20);
    kit.at(0, -9.6, 0).cyl(1.1, 1.6, FINISH.alu, 14, true, 2.1);
    for (let i = 0; i < 2; i++) {
      const a = i * Math.PI;
      kit.at(Math.cos(a) * 3.4, -7, Math.sin(a) * 3.4).box(0.7, 1.4, 0.7, FINISH.grey);
    }
    return kit;
  },

  msl(kit) {
    // Curiosity and Perseverance: a boxy body on a rocker-bogie, mast forward,
    // RTG aft, arm stowed under the front.
    kit.at(0, 0, 0).box(2.4, 0.8, 1.5, FINISH.white, {
      top: FINISH.white, bottom: FINISH.dark, side: FINISH.grey,
    });
    for (const sx of [1, -1]) {
      for (const [wz, wy] of [[-0.95, -0.55], [0, -0.62], [0.95, -0.55]]) {
        kit.at(wz, wy, sx * 0.95, 0, 0, Math.PI / 2).cyl(0.25, 0.4, FINISH.alu, 12);
      }
      kit.strut([-0.95, -0.5, sx * 0.8], [0.3, -0.1, sx * 0.75], 0.06, FINISH.grey);
      kit.strut([0.95, -0.5, sx * 0.8], [0.3, -0.1, sx * 0.75], 0.06, FINISH.grey);
    }
    // Mast with the camera head.
    kit.strut([0.8, 0.4, 0.35], [0.8, 1.5, 0.35], 0.07, FINISH.grey);
    kit.at(0.8, 1.62, 0.35).box(0.55, 0.2, 0.2, FINISH.dark);
    // RTG, canted off the back corner.
    kit.at(-1.35, 0.35, -0.5, 0, 0.6, Math.PI / 2.4).cyl(0.24, 0.8, FINISH.dark, 10);
    // Arm, folded down at the front.
    kit.strut([1.2, 0.1, 0], [1.9, -0.4, 0.2], 0.08, FINISH.white);
    kit.at(1.95, -0.5, 0.25).cyl(0.22, 0.2, FINISH.grey, 10);
    kit.at(-0.2, 0.5, 0).panel(1.1, 0.9, FINISH.dark, FINISH.white, 0.06);
    return kit;
  },

  mer(kit) {
    // Spirit and Opportunity: the solar deck is a folded-out set of panels that
    // reads as a butterfly from above, on a much smaller body than Curiosity.
    kit.at(0, 0, 0).box(1.1, 0.4, 0.8, FINISH.gold);
    kit.at(0, 0.28, 0).panel(1.3, 1.0, FINISH.panel, FINISH.panelBack, 0.05);
    for (const s of [1, -1]) {
      kit.at(0, 0.24, s * 0.85, 0, 0, 0).panel(1.15, 0.72, FINISH.panel, FINISH.panelBack, 0.05);
      kit.at(s * 0.9, 0.24, 0, 0, Math.PI / 2, 0).panel(0.7, 0.6, FINISH.panel, FINISH.panelBack, 0.05);
    }
    for (const sx of [1, -1]) {
      for (const wz of [-0.45, 0.45]) {
        kit.at(wz, -0.35, sx * 0.5, 0, 0, Math.PI / 2).cyl(0.13, 0.16, FINISH.alu, 10);
      }
    }
    kit.strut([0.3, 0.3, 0], [0.3, 0.95, 0], 0.05, FINISH.grey);
    kit.at(0.3, 1.02, 0).box(0.3, 0.12, 0.12, FINISH.dark);
    return kit;
  },

  mro(kit) {
    kit.at(0, 0, 0).box(2.2, 1.7, 1.7, FINISH.gold, {
      top: FINISH.gold, bottom: FINISH.dark, side: FINISH.gold,
    });
    kit.at(0, 1.6, 0).dish(1.5, 0.45, FINISH.white, FINISH.grey, 22, 4);
    kit.strut([0, 0.85, 0], [0, 1.4, 0], 0.1);
    for (const s of [1, -1]) {
      kit.at(s * 3.6, 0.2, 0, 0, 0, s * 0.15).array(5.2, 2.5, 4);
      kit.strut([s * 1.1, 0.2, 0], [s * 1.5, 0.2, 0], 0.09);
    }
    // HiRISE: a half-metre telescope, the largest ever sent to another planet.
    kit.at(0.3, -1.3, 0).cyl(0.45, 1.4, FINISH.dark, 14);
    kit.at(-0.8, -1, 0.4).cyl(0.2, 0.7, FINISH.grey, 10);
    return kit;
  },

  lro(kit) {
    kit.at(0, 0, 0).box(1.6, 2.2, 1.4, FINISH.gold, {
      top: FINISH.dark, bottom: FINISH.dark, side: FINISH.gold,
    });
    kit.at(0, 1.5, 0.9).dish(0.65, 0.2, FINISH.white, FINISH.grey, 14, 3);
    kit.strut([0, 1.1, 0.3], [0, 1.4, 0.8], 0.06);
    kit.at(2.3, 0.3, 0, 0, 0, 0.2).array(2.6, 1.6, 3);
    kit.strut([0.8, 0.3, 0], [1.1, 0.3, 0], 0.08);
    kit.at(0, -1.3, 0.3).box(0.7, 0.5, 0.9, FINISH.dark);
    return kit;
  },

  jwst(kit) {
    // Five sunshield layers as a stack of flat kites, the mirror as eighteen
    // hexagons in three rows, and the whole thing tilted the way it flies.
    for (let i = 0; i < 5; i++) {
      const s = 1 - i * 0.06;
      kit.at(0, -1.4 - i * 0.42, 0).panel(19.4 * s, 12.2 * s, FINISH.foil, FINISH.dark, 0.05);
    }
    const R = 0.75;
    for (let row = -1; row <= 1; row++) {
      const count = row === 0 ? 7 : 6;
      for (let i = 0; i < count; i++) {
        const x = (i - (count - 1) / 2) * R * 1.78;
        const z = row * R * 1.55;
        if (row === 0 && i === 3) continue;
        kit.at(x, 1.9, z).cyl(R, 0.1, FINISH.gold, 6);
      }
    }
    kit.at(0, 1.9, 0).cyl(R, 0.1, FINISH.gold, 6);
    kit.strut([0, 1.2, 0], [0, 3.4, -2.6], 0.09, FINISH.grey);
    kit.at(0, 3.5, -2.8).cyl(0.42, 0.5, FINISH.dark, 12);
    for (const s of [1, -1]) {
      kit.strut([s * 3, 1.2, 0], [s * 3, 1.9, 0], 0.08, FINISH.grey);
    }
    kit.at(0, -1.1, 0).box(2.4, 0.9, 2.4, FINISH.dark);
    return kit;
  },

  gaia(kit) {
    kit.at(0, 0, 0).cyl(1.5, 2.2, FINISH.white, 20);
    // The conical skirt is both sunshade and solar array, and it is all you see.
    kit.at(0, -1.4, 0).cyl(5.1, 0.4, FINISH.panel, 24, true, 1.6);
    kit.at(0, 1.3, 0).dish(0.6, 0.18, FINISH.white, FINISH.grey, 14, 3);
    return kit;
  },

  chandra(kit) {
    kit.at(0, 0, 0).cyl(1.2, 11.8, FINISH.foil, 20);
    kit.at(0, 6, 0).cyl(1.25, 0.5, FINISH.dark, 20);
    kit.at(0, -6.1, 0).cyl(1, 0.6, FINISH.grey, 20);
    for (const s of [1, -1]) {
      kit.at(s * 3.6, -2, 0).array(4.6, 2.6, 3);
      kit.strut([s * 1.2, -2, 0], [s * 1.5, -2, 0], 0.09);
    }
    kit.at(0, 2, 1.4).dish(0.55, 0.18, FINISH.white, FINISH.grey, 12, 3);
    return kit;
  },

  goes(kit) {
    kit.at(0, 0, 0).box(2.1, 3.2, 2.1, FINISH.white, {
      top: FINISH.dark, bottom: FINISH.dark, side: FINISH.white,
    });
    // Geostationary weather satellites are single-winged and hang one big
    // radiator on the opposite side to balance it.
    kit.at(4.6, 0, 0).array(6.2, 2.4, 4);
    kit.strut([1.1, 0, 0], [1.5, 0, 0], 0.1);
    kit.at(-2, 0, 0).panel(2.2, 2.8, FINISH.radiator, FINISH.radiator, 0.1);
    kit.at(0, 1.9, 0.9).dish(0.7, 0.22, FINISH.white, FINISH.grey, 14, 3);
    kit.at(0, -1.9, 0.5).cyl(0.3, 0.9, FINISH.dark, 10);
    kit.strut([0, 1.6, -0.6], [0, 3.6, -0.6], 0.05);
    return kit;
  },

  gps(kit) {
    kit.at(0, 0, 0).box(1.8, 1.9, 1.8, FINISH.dark, {
      top: FINISH.gold, bottom: FINISH.dark, side: FINISH.dark,
    });
    for (const s of [1, -1]) {
      kit.at(s * 2.9, 0, 0).array(3.6, 1.8, 3);
      kit.strut([s * 0.9, 0, 0], [s * 1.2, 0, 0], 0.08);
    }
    // The L-band helix array on the Earth-facing face, in a ring of twelve.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r = i % 4 === 0 ? 0.3 : 0.62;
      kit.at(Math.cos(a) * r, -1.15, Math.sin(a) * r).cyl(0.11, 0.4, FINISH.alu, 8);
    }
    return kit;
  },

  eos(kit) {
    kit.at(0, 0, 0).box(2.7, 2.2, 2, FINISH.white, {
      top: FINISH.dark, bottom: FINISH.dark, side: FINISH.white,
    });
    kit.at(3.9, 0.3, 0).array(4.8, 2.9, 4);
    kit.strut([1.4, 0.3, 0], [1.7, 0.3, 0], 0.1);
    kit.at(0, 1.6, 0.7).dish(0.55, 0.18, FINISH.white, FINISH.grey, 12, 3);
    kit.at(0, -1.3, 0.4).box(1.2, 0.5, 0.9, FINISH.dark);
    return kit;
  },

  css(kit) {
    // Three modules in a T, plus the two big steerable arrays on each end.
    kit.at(0, 0, 0, Math.PI / 2, 0, 0).cyl(2.2, 18.1, FINISH.white, 18);
    for (const s of [1, -1]) {
      kit.at(s * 6.5, 0, 0, 0, 0, Math.PI / 2).cyl(2.1, 14.4, FINISH.white, 18);
      kit.at(s * 13.5, 0, 8).array(12, 4.6, 4);
      kit.at(s * 13.5, 0, -8).array(12, 4.6, 4);
      kit.strut([s * 13.5, 0, 2.4], [s * 13.5, 0, 5.5], 0.22, FINISH.grey);
      kit.strut([s * 13.5, 0, -2.4], [s * 13.5, 0, -5.5], 0.22, FINISH.grey);
    }
    kit.at(0, -2.6, 5).cyl(1.2, 1, FINISH.alu, 12);
    return kit;
  },

  mir(kit) {
    kit.at(0, 0, 0, Math.PI / 2, 0, 0).cyl(2.1, 13.1, FINISH.white, 16);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      kit.at(Math.cos(a) * 4.2, Math.sin(a) * 4.2, -5, 0, 0, 0)
        .cyl(1.9, 9, FINISH.white, 14);
    }
    for (const s of [1, -1]) {
      kit.at(s * 7.5, 0, 2).array(10, 3.2, 4);
      kit.strut([s * 2, 0, 2], [s * 3, 0, 2], 0.15, FINISH.grey);
    }
    return kit;
  },

  lander(kit) {
    kit.at(0, 0, 0).cyl(1.4, 0.55, FINISH.gold, 8);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const fx = Math.cos(a);
      const fz = Math.sin(a);
      kit.strut([fx * 1.1, -0.2, fz * 1.1], [fx * 2.2, -1.1, fz * 2.2], 0.07, FINISH.alu);
      kit.at(fx * 2.3, -1.2, fz * 2.3).cyl(0.3, 0.12, FINISH.alu, 10);
      kit.at(fx * 1.9, 0.4, fz * 1.9, 0, -a, 0).panel(1.5, 1.3, FINISH.panel, FINISH.panelBack, 0.05);
    }
    kit.strut([0, 0.3, 0], [0, 1.3, 0], 0.05, FINISH.grey);
    kit.at(0, 1.4, 0).box(0.35, 0.2, 0.2, FINISH.dark);
    return kit;
  },

  probe(kit) {
    kit.at(0, 0, 0).cone(1.35, 0.9, FINISH.alu, 18);
    kit.at(0, -0.6, 0).cyl(1.3, 0.3, FINISH.dark, 18, true, 1.1);
    return kit;
  },

  sphere(kit) {
    kit.at(0, 0, 0).ball(0.3, FINISH.alu, 14, 10);
    return kit;
  },

  cubesat(kit) {
    kit.at(0, 0, 0).box(0.36, 0.24, 0.24, FINISH.alu, {
      top: FINISH.dark, bottom: FINISH.dark, side: FINISH.alu,
    });
    for (const s of [1, -1]) {
      kit.at(0, s * 0.16, 0.34, 0, 0, 0).panel(0.34, 0.44, FINISH.panel, FINISH.panelBack, 0.02);
    }
    return kit;
  },

  roadster(kit) {
    kit.at(0, 0, 0).box(1.8, 0.5, 4.2, FINISH.red);
    kit.at(0, 0.4, -0.3).box(1.5, 0.4, 1.8, FINISH.black);
    for (const sx of [1, -1]) {
      for (const sz of [1.4, -1.4]) {
        kit.at(sx * 0.85, -0.3, sz, 0, 0, Math.PI / 2).cyl(0.33, 0.25, FINISH.black, 12);
      }
    }
    kit.at(0, 0.75, -0.1).ball(0.28, FINISH.white, 8, 6);
    return kit;
  },

  mariner(kit) {
    kit.at(0, 0, 0).cyl(0.7, 0.5, FINISH.gold, 8);
    kit.at(0, 0.9, 0).dish(0.6, 0.2, FINISH.white, FINISH.grey, 14, 3);
    kit.strut([0, 0.3, 0], [0, 0.75, 0], 0.05);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      kit.at(Math.cos(a) * 2.2, 0.05, Math.sin(a) * 2.2, 0, -a, 0)
        .array(2.6, 0.75, 2);
      kit.strut(
        [Math.cos(a) * 0.6, 0.05, Math.sin(a) * 0.6],
        [Math.cos(a) * 1.1, 0.05, Math.sin(a) * 1.1],
        0.04,
      );
    }
    kit.strut([0, -0.3, 0], [0, -1.4, 0], 0.04);
    return kit;
  },
};

/**
 * Craft whose look is close enough to the generic bus that a parameter set
 * describes them better than a bespoke builder would.
 */
const PARAMS = {
  boxsat: { bus: [2, 2, 2], span: 8, dishR: 1.1 },
  messenger: { bus: [1.4, 1.3, 1.9], span: 6.1, dishR: 0.9, finish: FINISH.foil },
  bepicolombo: { bus: [2.4, 1.6, 2.4], span: 6.4, dishR: 1.1, finish: FINISH.white },
  dawn: { bus: [1.6, 2.2, 1.3], span: 19.7, cells: 6, dishR: 0.8 },
  osirisrex: { bus: [2.4, 2.6, 2.4], span: 6.2, dishR: 1.1, finish: FINISH.foil },
  hayabusa: { bus: [1.6, 1.1, 1.4], span: 5.9, dishR: 0.8, finish: FINISH.gold },
  psyche: { bus: [2.2, 2.4, 2.2], span: 24.8, cells: 5, dishR: 1.1 },
  lucy: { bus: [2, 2.4, 2], span: 15.8, cells: 4, dishR: 1 },
  rosetta: { bus: [2.8, 2.1, 2], span: 32, cells: 7, dishR: 1.1 },
  clipper: { bus: [3, 3, 2.5], span: 30.5, cells: 6, dishR: 1.5 },
  juice: { bus: [2.9, 4.1, 2.6], span: 27, cells: 5, dishR: 1.4 },
};

const geometryCache = new Map();

/** Model geometry for a name, built once and shared. */
export function craftGeometry(model) {
  const key = model ?? 'boxsat';
  const cached = geometryCache.get(key);
  if (cached) return cached;
  const kit = new Kit();
  if (BUILDERS[key]) {
    BUILDERS[key](kit);
  } else if (PARAMS[key]) {
    generic(kit, PARAMS[key]);
  } else {
    generic(kit, PARAMS.boxsat);
  }
  const geometry = kit.geometry();
  geometry.computeBoundingBox();
  geometryCache.set(key, geometry);
  return geometry;
}

/**
 * The model's longest dimension, in whatever units it was built in.
 *
 * Used to scale a model to the craft's real size rather than trusting the
 * builder to have been proportioned to scale. The builders are written to look
 * right, and a truss drawn a third too long is the sort of thing that is
 * invisible in the model and wrong on screen — the level-of-detail system sizes
 * a craft from the metres in its mission record, so if the mesh disagrees the
 * two fight: a station is culled while it still fills the frame, or drawn as a
 * sliver when it should be readable.
 */
export function craftExtent(model) {
  const box = craftGeometry(model).boundingBox;
  return Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
}

/**
 * One material for every spacecraft in the scene.
 *
 * There are no lights in this renderer; planets are lit by a sun direction
 * handed to their own shaders, so spacecraft are lit the same way. The tiny
 * ambient term is not physical: unlit sides of a spacecraft in deep space
 * really are black, but at these sizes a completely black silhouette is
 * unreadable, so a starlight-level fill keeps the shape visible.
 */
export function createCraftMaterial() {
  return new ShaderMaterial({
    uniforms: {
      uSunDirView: { value: new Vector3(0, 0, 1) },
      uAmbient: { value: 0.045 },
      uExposure: { value: 1 },
      uFade: { value: 1 },
    },
    // The renderer uses a logarithmic depth buffer, so this has to write depth
    // on the same curve the planets do. Without it a spacecraft crossing a
    // planet's disc is depth-sorted against a different function and cuts
    // through the surface.
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 aTint;
      attribute float aSpec;
      varying vec3 vNormal;
      varying vec3 vTint;
      varying float vSpec;
      varying vec3 vView;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vTint = aTint;
        vSpec = aSpec;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = mv.xyz;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSunDirView;
      uniform float uAmbient;
      uniform float uExposure;
      uniform float uFade;
      varying vec3 vNormal;
      varying vec3 vTint;
      varying float vSpec;
      varying vec3 vView;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 n = normalize(vNormal);
        vec3 v = normalize(-vView);
        // Two-sided: panels and dishes are single surfaces with no back.
        if (dot(n, v) < 0.0) n = -n;
        vec3 l = normalize(uSunDirView);
        float diffuse = max(dot(n, l), 0.0);
        vec3 h = normalize(l + v);
        float gloss = mix(12.0, 220.0, clamp(vSpec, 0.0, 1.0));
        float spec = pow(max(dot(n, h), 0.0), gloss) * vSpec * step(0.001, diffuse);
        vec3 colour = vTint * (diffuse + uAmbient) + vec3(spec);
        gl_FragColor = vec4(colour * uExposure, uFade);
      }
    `,
    transparent: true,
  });
}

export { Kit };
