/**
 * Object labels for the explorer.
 *
 * Two things keep this from becoming the wall of text that labelled star charts
 * usually turn into. First, candidates are ranked and only the best few dozen
 * survive — the target and the selection always, then major bodies, then
 * whatever is close to the centre of the screen, then whatever is simply near.
 * Second, survivors are placed into a coarse screen grid and a cell can hold
 * only one label, which is what stops a crowded moon system from stacking six
 * names on top of each other.
 *
 * Elements come from a pool and are moved with transforms. Nothing is created or
 * destroyed while panning, and a label whose text has not changed is not
 * written to.
 */

import { Vector3 } from 'three';
import { el, text, css } from './dom.js';
import { formatDistance } from '../engine/units.js';

const POOL = 48;

/**
 * The footprint a placed label occupies, in pixels.
 *
 * Two stacked lines — a name and a distance — running right of the anchor. The
 * width is the same figure the edge margin below is built on, so a label never
 * claims space it would not also be allowed to hang in.
 */
const LABEL_W = 120;
const LABEL_H = 32;

export function createLabelLayer(container) {
  const pool = [];
  for (let i = 0; i < POOL; i++) {
    const name = el('span', { class: 'l-name' });
    const dist = el('span', { class: 'l-dist' });
    const node = el('div', { class: 'obj-label', hidden: true }, [name, document.createElement('br'), dist]);
    container.append(node);
    pool.push({ node, name, dist, shown: false });
  }

  const local = new Vector3();
  const projected = new Vector3();
  const forward = new Vector3();
  const candidates = [];
  const placed = [];

  /**
   * @param {object} options
   * @param {Array} options.items `{ key, name, position, radius, major, kind }`,
   *   optionally with `offset`: the camera-relative vector already worked out,
   *   for anything whose absolute position is too large to subtract usefully.
   * @param {number} options.density 0..1, scales how many labels survive
   */
  function update({ camera, cameraWorld, width, height, items, targetKey, density = 0.5 }) {
    candidates.length = 0;
    camera.getWorldDirection(forward);
    const halfHeight = height / 2;
    const pixelsPerRadian = height / ((camera.fov * Math.PI) / 180);

    for (const item of items) {
      if (item.offset) local.copy(item.offset);
      else local.subVectors(item.position, cameraWorld);
      const distance = local.length();
      if (distance < 1e-9) continue;

      // Behind the camera. Checked before projecting, because the perspective
      // divide puts points behind the eye back inside the frustum.
      if (forward.dot(local) <= 0) continue;

      projected.copy(local).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
      if (projected.z < -1 || projected.z > 1) continue;
      const sx = (projected.x * 0.5 + 0.5) * width;
      const sy = (-projected.y * 0.5 + 0.5) * height;
      // The label is two lines tall and vertically centred on this point, and it
      // extends to the right of it, so the margins have to allow for the text
      // rather than the anchor — otherwise a label near an edge hangs outside the
      // window.
      if (sx < 8 || sx > width - 120 || sy < 22 || sy > height - 22) continue;

      // Angular size in pixels. Something already filling the screen does not
      // need naming — you can see what it is — and something subpixel is not
      // worth a label either.
      const pixels = (item.radius / distance) * pixelsPerRadian;
      if (pixels > height * 0.9) continue;

      const fromCentre = Math.hypot(sx - width / 2, sy - halfHeight) / halfHeight;

      let rank = 0;
      if (item.key === targetKey) rank += 1000;
      if (item.major) rank += 120;
      rank += 60 * (1 - Math.min(fromCentre, 1));
      // Apparent size stands in for "near", and does it across scales: a moon
      // ten thousand kilometres away and a galaxy ten megaparsecs away both rank
      // by how big they look rather than by raw distance.
      rank += 40 * Math.min(Math.log10(Math.max(pixels, 0.01)) / 3, 1);

      candidates.push({ item, sx, sy, distance, pixels, rank });
    }

    candidates.sort((a, b) => b.rank - a.rank);

    const budget = Math.round(6 + density * (POOL - 6));
    placed.length = 0;
    let used = 0;

    for (const candidate of candidates) {
      if (used >= budget) break;
      const offset = Math.min(candidate.pixels * 0.5 + 8, 40);
      // Where the block will actually land: to the right of the anchor, centred
      // on it vertically, which is what the transform below does.
      const x0 = candidate.sx + offset;
      const y0 = candidate.sy - LABEL_H / 2;

      // The target keeps its label even where it would overlap something that
      // outranked it, because losing the label on the thing you are flying to is
      // the one case that is always wrong.
      const isTarget = candidate.item.key === targetKey;
      if (!isTarget) {
        // Tested against the labels already placed, rather than by bucketing
        // positions into a grid.
        //
        // The grid this replaces could not do the job it was there for. Two
        // labels in neighbouring cells can sit a pixel apart and still both be
        // allowed, so names kept overlapping in a crowded system; and reshaping
        // the cells only moved which pairs collided. The real test is whether
        // the blocks intersect, and with at most a few dozen labels surviving,
        // asking that directly costs nothing worth measuring.
        let hit = false;
        for (let i = 0; i < placed.length; i++) {
          const r = placed[i];
          if (x0 < r.x1 && r.x0 < x0 + LABEL_W && y0 < r.y1 && r.y0 < y0 + LABEL_H) {
            hit = true;
            break;
          }
        }
        if (hit) continue;
      }
      placed.push({ x0, y0, x1: x0 + LABEL_W, y1: y0 + LABEL_H });

      const slotView = pool[used++];
      slotView.node.style.transform = `translate(${Math.round(x0)}px, ${Math.round(candidate.sy)}px) translateY(-50%)`;
      text(slotView.name, candidate.item.name);
      text(slotView.dist, formatDistance(candidate.distance));
      css(slotView.node, 'is-target', isTarget);
      if (!slotView.shown) {
        slotView.node.hidden = false;
        slotView.shown = true;
      }
    }

    for (let i = used; i < pool.length; i++) {
      if (!pool[i].shown) continue;
      pool[i].node.hidden = true;
      pool[i].shown = false;
    }
  }

  function clear() {
    for (const slot of pool) {
      if (!slot.shown) continue;
      slot.node.hidden = true;
      slot.shown = false;
    }
  }

  return { update, clear };
}
