import {
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Vector3,
} from 'three';

/**
 * Adaptive cube-sphere tessellation.
 *
 * Six cube faces are split quadtree-style until each patch is small enough on
 * screen, and every visible patch is drawn in a single instanced call: the
 * shared geometry is a unit grid, and per-instance attributes carry the patch's
 * corner and edge vectors in cube space. That keeps a few hundred patches at
 * one draw call, so the selection can be rebuilt from scratch every frame
 * without any node pooling or dirty tracking.
 *
 * Refinement is best-first, not depth-first, and that is a correctness matter
 * rather than a performance one. The selection starts as the six cube faces —
 * which already cover the whole sphere — and repeatedly replaces whichever patch
 * has the largest screen-space error with its four children. Every intermediate
 * state is therefore a complete cover, so running out of instance slots can only
 * leave the terrain coarse and never leave a hole in it.
 *
 * Depth-first cannot make that guarantee. It commits the budget to whichever face
 * it happens to visit first, and since the faces are visited in a fixed order
 * rather than in order of what the camera is looking at, the face directly under
 * the camera is the one most likely to find the buffer already full. At low
 * altitude that does not degrade the view, it deletes it.
 *
 * Patches carry a skirt — a border ring pushed down along the surface normal —
 * which hides the cracks where a patch meets a neighbour one level coarser.
 *
 * They also carry a morph factor, which is what stops the tessellation changing
 * visibly. See MORPH_START.
 */

/**
 * Where a patch starts collapsing onto its parent, as a multiple of the split
 * threshold.
 *
 * Four children replace their parent the instant the parent's screen-space error
 * crosses the threshold, and without help that swap moves every odd-numbered
 * vertex, which is a visible twitch across the whole patch. So each child is
 * given a factor that slides its own vertices onto its parent's lattice, and it
 * reaches 1 exactly when the parent's error returns to the threshold — at the
 * moment of the swap the children are already geometrically identical to the
 * parent they are about to become, and nothing moves.
 *
 * The factor is derived from the parent's error rather than the child's own,
 * which is the part that has to be right. The two are not simply a factor of two
 * apart: a patch's error uses the chord across it and the distance to its own
 * centre, and both the cube-sphere's distortion and the parent's different centre
 * push the ratio around. Only the parent's error is what the merge is actually
 * tested against, so only the parent's error can say exactly when the merge will
 * happen.
 *
 * 1.35 leaves the outer third of each level's range unmorphed, so a patch is at
 * full detail for most of its life and only gives it up as it is about to be
 * replaced by something coarser anyway.
 */
const MORPH_START = 1.35;

const FACES = [
  // origin, right, up. Each face spans the [-1,1] square of the cube.
  { origin: [-1, -1, 1], right: [2, 0, 0], up: [0, 2, 0] }, // +Z
  { origin: [1, -1, -1], right: [-2, 0, 0], up: [0, 2, 0] }, // -Z
  { origin: [1, -1, 1], right: [0, 0, -2], up: [0, 2, 0] }, // +X
  { origin: [-1, -1, -1], right: [0, 0, 2], up: [0, 2, 0] }, // -X
  { origin: [-1, 1, 1], right: [2, 0, 0], up: [0, 0, -2] }, // +Y
  { origin: [-1, -1, -1], right: [2, 0, 0], up: [0, 0, 2] }, // -Y
];

/** Unit grid with a skirt ring, shared by every patch instance. */
function buildPatchGeometry(resolution) {
  const n = resolution;
  const inner = (n + 1) * (n + 1);
  // Skirt adds one vertex per boundary grid point.
  const border = 4 * n;
  const count = inner + border;

  const grid = new Float32Array(count * 2);
  const skirt = new Float32Array(count);

  let w = 0;
  for (let y = 0; y <= n; y++) {
    for (let x = 0; x <= n; x++) {
      grid[w * 2] = x / n;
      grid[w * 2 + 1] = y / n;
      w++;
    }
  }

  const indices = [];
  const at = (x, y) => y * (n + 1) + x;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = at(x, y);
      const b = at(x + 1, y);
      const c = at(x + 1, y + 1);
      const d = at(x, y + 1);
      indices.push(a, b, c, a, c, d);
    }
  }

  // Walk the boundary once, emitting a dropped duplicate of each edge vertex
  // and stitching it to its neighbour to form a vertical curtain.
  const boundary = [];
  for (let x = 0; x < n; x++) boundary.push(at(x, 0));
  for (let y = 0; y < n; y++) boundary.push(at(n, y));
  for (let x = n; x > 0; x--) boundary.push(at(x, n));
  for (let y = n; y > 0; y--) boundary.push(at(0, y));

  const skirtStart = w;
  for (let i = 0; i < boundary.length; i++) {
    const source = boundary[i];
    grid[w * 2] = grid[source * 2];
    grid[w * 2 + 1] = grid[source * 2 + 1];
    skirt[w] = 1;
    w++;
  }
  for (let i = 0; i < boundary.length; i++) {
    const next = (i + 1) % boundary.length;
    const topA = boundary[i];
    const topB = boundary[next];
    const lowA = skirtStart + i;
    const lowB = skirtStart + next;
    indices.push(topA, lowA, lowB, topA, lowB, topB);
  }

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('grid', new BufferAttribute(grid, 2));
  geometry.setAttribute('skirt', new BufferAttribute(skirt, 1));
  geometry.setIndex(indices);
  return geometry;
}

export class CubeSphere {
  /**
   * @param {object} options
   * @param {number} options.resolution vertices per patch edge
   * @param {number} options.maxLevel deepest quadtree level
   * @param {number} options.maxPatches instance buffer capacity
   * @param {number} options.pixelsPerQuad target screen size of one grid quad;
   *   smaller means finer geometry and many more patches
   */
  constructor({ resolution = 24, maxLevel = 14, maxPatches = 2400, pixelsPerQuad = 7 } = {}) {
    // Rounded up to even, because the morph depends on it. A child patch shares
    // every second vertex with its parent only if the grid has an even number of
    // cells; with an odd one, which vertices line up depends on which quadrant of
    // its parent the child occupies, and the morph would pull half of them to the
    // wrong place. Failing silently there would look like a subtle terrain
    // shimmer, so the constraint is enforced rather than documented.
    this.resolution = resolution + (resolution % 2);
    this.maxLevel = maxLevel;
    this.maxPatches = maxPatches;
    this.pixelsPerQuad = pixelsPerQuad;

    this.geometry = buildPatchGeometry(this.resolution);
    this.origins = new Float32Array(maxPatches * 3);
    this.rights = new Float32Array(maxPatches * 3);
    this.ups = new Float32Array(maxPatches * 3);
    this.levels = new Float32Array(maxPatches);
    this.morphs = new Float32Array(maxPatches);

    this.originAttr = new InstancedBufferAttribute(this.origins, 3);
    this.rightAttr = new InstancedBufferAttribute(this.rights, 3);
    this.upAttr = new InstancedBufferAttribute(this.ups, 3);
    this.levelAttr = new InstancedBufferAttribute(this.levels, 1);
    this.morphAttr = new InstancedBufferAttribute(this.morphs, 1);
    for (const attr of [
      this.originAttr, this.rightAttr, this.upAttr, this.levelAttr, this.morphAttr,
    ]) {
      attr.setUsage(35048); // DynamicDrawUsage
    }
    this.geometry.setAttribute('iOrigin', this.originAttr);
    this.geometry.setAttribute('iRight', this.rightAttr);
    this.geometry.setAttribute('iUp', this.upAttr);
    this.geometry.setAttribute('iLevel', this.levelAttr);
    this.geometry.setAttribute('iMorph', this.morphAttr);

    this._corner = new Vector3();
    this._centre = new Vector3();
    this.patchCount = 0;
    this.deepestLevel = 0;

    // Candidate nodes for one frame's refinement. A refinement retires one node
    // and adds up to four, so the number of nodes ever created is bounded by
    // about four thirds of the patch budget; double it and there is no arithmetic
    // to get wrong.
    const capacity = maxPatches * 2 + 8;
    this._nOrigin = new Float32Array(capacity * 3);
    this._nRight = new Float32Array(capacity * 3);
    this._nUp = new Float32Array(capacity * 3);
    this._nLevel = new Int32Array(capacity);
    this._nMorph = new Float32Array(capacity);
    this._nError = new Float64Array(capacity);
    this._capacity = capacity;

    // Max-heap of node indices ordered by screen-space error, plus the list of
    // nodes that are settled — too deep or too small to refine further.
    this._heap = new Int32Array(capacity);
    this._settled = new Int32Array(capacity);
  }

  _heapPush(node) {
    const heap = this._heap;
    const error = this._nError;
    let i = this._heapSize++;
    heap[i] = node;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (error[heap[parent]] >= error[heap[i]]) break;
      const swap = heap[parent];
      heap[parent] = heap[i];
      heap[i] = swap;
      i = parent;
    }
  }

  _heapPop() {
    const heap = this._heap;
    const error = this._nError;
    const top = heap[0];
    heap[0] = heap[--this._heapSize];
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      if (left >= this._heapSize) break;
      const right = left + 1;
      let big = left;
      if (right < this._heapSize && error[heap[right]] > error[heap[left]]) big = right;
      if (error[heap[i]] >= error[heap[big]]) break;
      const swap = heap[big];
      heap[big] = heap[i];
      heap[i] = swap;
      i = big;
    }
    return top;
  }

  /**
   * Rebuilds the visible patch set.
   *
   * @param {Vector3} cameraLocal camera position in body space, body radii units
   * @param {number} pixelsPerRadian screen pixels per radian of view angle
   * @param {Vector3} [viewDir] camera forward in body space, unit
   * @param {number} [coneCos] cosine of the angle from the forward axis to a
   *   screen corner; patches outside it are off screen
   */
  update(cameraLocal, pixelsPerRadian, viewDir = null, coneCos = -1) {
    this.patchCount = 0;
    this.deepestLevel = 0;
    this.starved = false;
    const cameraDistance = cameraLocal.length();
    this._viewDir = viewDir;
    this._coneSin = Math.sqrt(Math.max(0, 1 - coneCos * coneCos));
    this._coneCos = coneCos;
    this._splitThreshold = this.resolution * this.pixelsPerQuad * 1.22;
    this._cameraLocal = cameraLocal;
    this._cameraDistance = cameraDistance;
    this._pixelsPerRadian = pixelsPerRadian;

    this._nodeCount = 0;
    this._heapSize = 0;
    this._settledCount = 0;

    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      this._consider(
        face.origin[0], face.origin[1], face.origin[2],
        face.right[0], face.right[1], face.right[2],
        face.up[0], face.up[1], face.up[2],
        // A cube face is never merged into anything, so it never morphs.
        0, 0,
      );
    }

    // Refine the worst patch on screen until nothing exceeds the threshold or
    // there is no room left. Because the working set is a complete cover at every
    // step, stopping early costs detail and nothing else.
    while (this._heapSize > 0) {
      const worst = this._heap[0];
      if (this._nError[worst] <= this._splitThreshold) break;

      if (this._nLevel[worst] >= this.maxLevel) {
        this._settled[this._settledCount++] = this._heapPop();
        continue;
      }

      // Four children replace one parent, so a refinement costs three slots.
      if (this._heapSize + this._settledCount + 3 > this.maxPatches) {
        this.starved = true;
        break;
      }
      // Nor may it outrun the node pool, which the budget above normally keeps it
      // well inside.
      if (this._nodeCount + 4 > this._capacity) {
        this.starved = true;
        break;
      }

      this._refine(this._heapPop());
    }

    for (let i = 0; i < this._heapSize; i++) this._emitNode(this._heap[i]);
    for (let i = 0; i < this._settledCount; i++) this._emitNode(this._settled[i]);

    this.originAttr.addUpdateRange(0, this.patchCount * 3);
    this.rightAttr.addUpdateRange(0, this.patchCount * 3);
    this.upAttr.addUpdateRange(0, this.patchCount * 3);
    this.levelAttr.addUpdateRange(0, this.patchCount);
    this.morphAttr.addUpdateRange(0, this.patchCount);
    this.originAttr.needsUpdate = true;
    this.rightAttr.needsUpdate = true;
    this.upAttr.needsUpdate = true;
    this.levelAttr.needsUpdate = true;
    this.morphAttr.needsUpdate = true;
    this.geometry.instanceCount = this.patchCount;
    return this.patchCount;
  }

  _emit(ox, oy, oz, rx, ry, rz, ux, uy, uz, level, morph) {
    if (this.patchCount >= this.maxPatches) return;
    const i = this.patchCount++;
    this.morphs[i] = morph;
    this.origins[i * 3] = ox;
    this.origins[i * 3 + 1] = oy;
    this.origins[i * 3 + 2] = oz;
    this.rights[i * 3] = rx;
    this.rights[i * 3 + 1] = ry;
    this.rights[i * 3 + 2] = rz;
    this.ups[i * 3] = ux;
    this.ups[i * 3 + 1] = uy;
    this.ups[i * 3 + 2] = uz;
    this.levels[i] = level;
    if (level > this.deepestLevel) this.deepestLevel = level;
  }

  /**
   * Tests a candidate patch and, if it can be seen, records it for refinement.
   */
  _consider(ox, oy, oz, rx, ry, rz, ux, uy, uz, level, morph) {
    const cameraLocal = this._cameraLocal;
    const cameraDistance = this._cameraDistance;

    // Patch centre projected onto the unit sphere.
    const cx = ox + (rx + ux) * 0.5;
    const cy = oy + (ry + uy) * 0.5;
    const cz = oz + (rz + uz) * 0.5;
    const centre = this._centre.set(cx, cy, cz).normalize();

    // Horizon cull: drop patches whose centre faces away, with a generous
    // margin so terrain near the limb and tall relief are never clipped.
    if (cameraDistance > 1.02) {
      const horizonCos = -Math.sqrt(Math.max(0, 1 - 1 / (cameraDistance * cameraDistance)));
      const facing = centre.dot(cameraLocal) / cameraDistance;
      if (facing < horizonCos - 0.15) return;
    }

    const corner = this._corner.set(ox, oy, oz).normalize();
    const edge = corner.distanceTo(centre) * 2;
    const distance = Math.max(cameraLocal.distanceTo(centre), 1e-6);

    // Off-screen cull against the view cone through the screen corners. Without
    // this the whole near hemisphere is subdivided to full depth, and at low
    // altitude nearly all of it is behind the camera: the patch budget is spent
    // out of sight and the ground actually in view is left coarse.
    if (this._viewDir && this._coneCos > -1) {
      const dx = centre.x - cameraLocal.x;
      const dy = centre.y - cameraLocal.y;
      const dz = centre.z - cameraLocal.z;
      const along = (dx * this._viewDir.x + dy * this._viewDir.y + dz * this._viewDir.z) / distance;
      // Allow for the patch's own extent: it can straddle the cone edge.
      const slack = Math.min(edge / distance, 3.0);
      if (along < this._coneCos * Math.sqrt(Math.max(0, 1 - Math.min(slack, 1) ** 2)) -
                  this._coneSin * Math.min(slack, 1)) {
        return;
      }
    }

    const node = this._nodeCount++;
    const i3 = node * 3;
    this._nOrigin[i3] = ox;
    this._nOrigin[i3 + 1] = oy;
    this._nOrigin[i3 + 2] = oz;
    this._nRight[i3] = rx;
    this._nRight[i3 + 1] = ry;
    this._nRight[i3 + 2] = rz;
    this._nUp[i3] = ux;
    this._nUp[i3 + 1] = uy;
    this._nUp[i3 + 2] = uz;
    this._nLevel[node] = level;
    this._nMorph[node] = morph;
    // Screen-space error: patch edge length over distance, in pixels.
    this._nError[node] = (edge / distance) * this._pixelsPerRadian;
    this._heapPush(node);
  }

  /** Replaces a patch with its four children. */
  _refine(node) {
    const i3 = node * 3;
    const ox = this._nOrigin[i3];
    const oy = this._nOrigin[i3 + 1];
    const oz = this._nOrigin[i3 + 2];
    const hrx = this._nRight[i3] * 0.5;
    const hry = this._nRight[i3 + 1] * 0.5;
    const hrz = this._nRight[i3 + 2] * 0.5;
    const hux = this._nUp[i3] * 0.5;
    const huy = this._nUp[i3 + 1] * 0.5;
    const huz = this._nUp[i3 + 2] * 0.5;
    const level = this._nLevel[node] + 1;

    // How far this patch is past the threshold decides how much its children have
    // collapsed onto it. At the threshold itself they are fully collapsed, which
    // is what makes the swap about to happen here invisible.
    const excess = this._nError[node] / this._splitThreshold;
    const childMorph = Math.min(Math.max((MORPH_START - excess) / (MORPH_START - 1), 0), 1);

    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        this._consider(
          ox + hrx * i + hux * j,
          oy + hry * i + huy * j,
          oz + hrz * i + huz * j,
          hrx, hry, hrz,
          hux, huy, huz,
          level, childMorph,
        );
      }
    }
  }

  _emitNode(node) {
    const i3 = node * 3;
    this._emit(
      this._nOrigin[i3], this._nOrigin[i3 + 1], this._nOrigin[i3 + 2],
      this._nRight[i3], this._nRight[i3 + 1], this._nRight[i3 + 2],
      this._nUp[i3], this._nUp[i3 + 1], this._nUp[i3 + 2],
      this._nLevel[node], this._nMorph[node],
    );
  }
}
