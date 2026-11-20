import { Vector3, Ray } from 'three';

// A GPU-confirmed tile of the DRAWN vertex lattice. Movement may only enter a
// confirmed tile. A slow fence/readback therefore delays a step, never lets the
// eye tunnel into a hillside. Follow the triangle planes continuously rather
// than stepping between neighbourhood vertex maxima.
export class WalkSupport {
  constructor(planet, renderer) {
    this.planet = planet;
    this.renderer = renderer;
    this.tile = null;
    this.pending = null;
    this.generation = 0;
    this.blockedSteps = 0;
  }

  reset() { this.generation++; this.tile = null; this.pending = null; }

  describe(dir) {
    const s = this.planet.sphere;
    const cube = dir.clone().divideScalar(Math.max(Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z)));
    for (let i = 0; i < s.patchCount; i++) {
      const o = new Vector3().fromArray(s.origins, i * 3);
      const r = new Vector3().fromArray(s.rights, i * 3);
      const u = new Vector3().fromArray(s.ups, i * 3);
      const offset = cube.clone().sub(o);
      const x = offset.dot(r) / r.lengthSq(), y = offset.dot(u) / u.lengthSq();
      const face = r.clone().cross(u).normalize();
      if (Math.abs(offset.dot(face)) > 1e-5 || x < -1e-7 || y < -1e-7 || x > 1.0000001 || y > 1.0000001) continue;
      const n = s.resolution, ix = Math.min(n - 1, Math.max(0, Math.floor(x * n))), iy = Math.min(n - 1, Math.max(0, Math.floor(y * n)));
      const morph = s.morphs[i];
      const dirs = [];
      // One cell of overlap around the accepted 5x5-cell interior.
      const loX = ix - 3, loY = iy - 3;
      for (let v = 0; v < 8; v++) for (let h = 0; h < 8; h++) {
        const gx = loX + h, gy = loY + v;
        const wx = gx + (Math.floor(gx * 0.5 + 0.5) * 2 - gx) * morph;
        const wy = gy + (Math.floor(gy * 0.5 + 0.5) * 2 - gy) * morph;
        dirs.push(o.clone().addScaledVector(r, wx / n).addScaledVector(u, wy / n).normalize());
      }
      return { o, r, u, n, loX, loY, dirs, level: s.levels[i], morph, at: performance.now() };
    }
    return null;
  }

  height(tile, dir) {
    if (!tile?.heights) return null;
    const c = dir.clone().divideScalar(Math.max(Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z))).sub(tile.o);
    const normal = tile.r.clone().cross(tile.u).normalize();
    if (Math.abs(c.dot(normal)) > 1e-5) return null;
    const x = c.dot(tile.r) / tile.r.lengthSq() * tile.n - tile.loX;
    const y = c.dot(tile.u) / tile.u.lengthSq() * tile.n - tile.loY;
    if (x < 1 || y < 1 || x >= 6 || y >= 6) return null;
    // Cache the exact morphed vertex positions once per GPU readback. Radial
    // intersection follows the rendered triangle plane continuously, including
    // the diagonal. Scanning the small tile also handles collapsed morph cells.
    if (!tile.vertices) tile.vertices = tile.dirs.map((d, i) =>
      d.clone().multiplyScalar(this.planet.radius + tile.heights[i]));
    const ray = new Ray(new Vector3(), dir), hit = new Vector3();
    let h = -Infinity;
    for (let v = 0; v < 7; v++) for (let u = 0; u < 7; u++) {
      const a = v * 8 + u, b = a + 1, d = a + 8, e = d + 1;
      if (ray.intersectTriangle(tile.vertices[a], tile.vertices[b], tile.vertices[e], false, hit))
        h = Math.max(h, hit.length() - this.planet.radius);
      if (ray.intersectTriangle(tile.vertices[a], tile.vertices[e], tile.vertices[d], false, hit))
        h = Math.max(h, hit.length() - this.planet.radius);
    }
    const sea = this.planet.material.uniforms.uSeaLevelKm.value;
    return Number.isFinite(h) ? Math.max(h, sea > 0 ? sea : -Infinity) + 0.0006 : null;
  }

  floor(dir, bootstrap = false) {
    let h = this.height(this.tile, dir);
    if (h !== null && performance.now() - this.tile.at < 350) return h;
    if (!this.pending) {
      const tile = this.describe(dir);
      if (tile) {
        const generation = this.generation;
        if ((bootstrap && !this.tile) || !this.renderer.readRenderTargetPixelsAsync) {
          tile.heights = this.planet.groundHeightsKm(this.renderer, tile.dirs);
          this.tile = tile;
          return this.height(tile, dir);
        }
        const read = this.planet.groundHeightsKmAsync(this.renderer, tile.dirs);
        if (read) {
          this.pending = read;
          read.then(heights => {
            if (generation !== this.generation) return;
            if (heights.length !== 64 || !heights.every(Number.isFinite)) return;
            tile.heights = heights; this.tile = tile;
          }, () => {}).finally(() => { if (generation === this.generation) this.pending = null; });
        }
      }
    }
    if (h === null) this.blockedSteps++;
    return h;
  }
}
