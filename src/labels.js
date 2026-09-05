import { Vector3 } from 'three';

/**
 * DOM overlay labels.
 *
 * Text is kept in HTML rather than drawn into the WebGL scene so it stays
 * crisp at any device pixel ratio and remains selectable and accessible. A
 * fixed pool of elements is reused every frame, and a coarse occupancy grid
 * suppresses overlaps so dense regions do not turn into a wall of text.
 */
export class LabelLayer {
  constructor(container, { poolSize = 220, cellSize = 92 } = {}) {
    this.container = container;
    this.cellSize = cellSize;
    this.pool = [];
    this.poolSize = poolSize;
    for (let i = 0; i < poolSize; i++) {
      const el = document.createElement('div');
      el.className = 'sky-label';
      el.style.display = 'none';
      container.appendChild(el);
      this.pool.push(el);
    }
    this._occupied = new Set();
    this._projected = new Vector3();
  }

  /**
   * @param items array of { position: Vector3 (world space), text, kind,
   *                         priority (lower = more important), offset }
   */
  update(camera, width, height, items) {
    this._occupied.clear();
    const cols = Math.ceil(width / this.cellSize);
    const forward = camera.getWorldDirection(new Vector3());

    const candidates = [];
    for (const item of items) {
      const dir = item.position;
      // Cheap rejection before the projection matrix multiply.
      if (forward.dot(dir) <= 0.02) continue;

      this._projected.copy(dir).project(camera);
      if (this._projected.z > 1) continue;
      const x = (this._projected.x * 0.5 + 0.5) * width;
      const y = (-this._projected.y * 0.5 + 0.5) * height;
      if (x < -40 || x > width + 40 || y < -20 || y > height + 20) continue;
      candidates.push({ item, x, y });
    }

    candidates.sort((a, b) => a.item.priority - b.item.priority);

    let used = 0;
    for (const candidate of candidates) {
      if (used >= this.poolSize) break;
      const cx = Math.floor(candidate.x / this.cellSize);
      const cy = Math.floor(candidate.y / this.cellSize);
      const key = cy * cols + cx;
      if (this._occupied.has(key)) continue;
      this._occupied.add(key);

      const el = this.pool[used++];
      const item = candidate.item;
      if (el._text !== item.text) {
        el.textContent = item.text;
        el._text = item.text;
      }
      const cls = `sky-label ${item.kind}`;
      if (el._cls !== cls) {
        el.className = cls;
        el._cls = cls;
      }
      const offset = item.offset ?? 9;
      el.style.transform = `translate3d(${Math.round(candidate.x + offset)}px, ${Math.round(
        candidate.y - 8,
      )}px, 0)`;
      if (el.style.display !== 'block') el.style.display = 'block';
    }

    for (let i = used; i < this.poolSize; i++) {
      const el = this.pool[i];
      if (el.style.display !== 'none') el.style.display = 'none';
    }
  }

  clear() {
    for (const el of this.pool) el.style.display = 'none';
  }
}

/**
 * Nearest-object picking against a view direction.
 *
 * Brightness is folded into the score so clicking near Orion's belt selects a
 * belt star rather than an unrelated 9th-magnitude neighbour that happens to
 * be a few arcseconds closer to the cursor.
 */
export function pickSky({
  direction,
  toleranceRadians,
  starPositions,
  starMagnitudes,
  starCount,
  namedByIndex,
  dsoLayer,
  dsoVisibleCount,
  skyMatrix,
}) {
  const inverse = skyMatrix.clone().invert();
  const local = direction.clone().applyMatrix4(inverse).normalize();
  const cosTolerance = Math.cos(toleranceRadians);

  let best = null;
  let bestScore = -Infinity;

  for (let i = 0; i < starCount; i++) {
    const dot =
      local.x * starPositions[i * 3] +
      local.y * starPositions[i * 3 + 1] +
      local.z * starPositions[i * 3 + 2];
    if (dot < cosTolerance) continue;
    const separation = Math.acos(Math.min(1, dot));
    // Prefer bright and close; magnitude term is worth ~0.06 tolerance per mag.
    const score = -separation / toleranceRadians - starMagnitudes[i] * 0.06;
    if (score > bestScore) {
      bestScore = score;
      best = { type: 'star', index: i, separation };
    }
  }

  if (dsoLayer && dsoVisibleCount > 0) {
    for (let i = 0; i < dsoVisibleCount; i++) {
      const p = dsoLayer.positions[i];
      const dot = local.dot(p);
      const reach = Math.max(toleranceRadians, dsoLayer.records[i].rMaj);
      if (dot < Math.cos(reach)) continue;
      const separation = Math.acos(Math.min(1, dot));
      const score = -separation / reach - dsoLayer.magnitudes[i] * 0.04 + 0.12;
      if (score > bestScore) {
        bestScore = score;
        best = { type: 'dso', index: i, separation };
      }
    }
  }

  if (!best) return null;
  if (best.type === 'star') {
    return { ...best, named: namedByIndex.get(best.index) ?? null };
  }
  return { ...best, record: dsoLayer.records[best.index] };
}
