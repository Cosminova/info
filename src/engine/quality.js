/**
 * How much work a frame is allowed to cost.
 *
 * Measurement, not intuition, decided what belongs in here. Profiling the
 * explorer at a Retina pixel count found the close-surface views spending 60 to
 * 110 ms a frame while every subsystem that looked expensive — the 119k-star
 * deep field, the spacecraft, the labels, the dither pass — came to under a
 * millisecond each. Turning all of them off together bought about 5%. The cost
 * is fragment shading of the terrain, and only two things move it: how many
 * fragments there are, and how much procedural relief each one evaluates. Those
 * are the two knobs here. Everything else in this file exists so that a person
 * who wants a quieter picture can have one, not because it will make the frame
 * arrive sooner.
 *
 * The auto mode is a closed loop rather than a hardware guess. Asking the
 * browser what GPU it has tells you a marketing string; measuring the frame it
 * just drew tells you what the machine does with this scene at this altitude,
 * which is the only question that matters, and it keeps working when the answer
 * changes halfway through a descent.
 */

/**
 * Levels run 0 (cheapest) to 1 (everything on). The mapping is deliberately not
 * linear in either knob: resolution is worth more than terrain detail per unit
 * of ugliness, so it is spent last and recovered first.
 */
export const FLOOR = 0;
export const CEILING = 1;

/** Resolution is quantised because changing it reallocates every render target. */
const SCALE_STEPS = [0.5, 0.58, 0.67, 0.75, 0.85, 1];

function stepFor(value) {
  let best = SCALE_STEPS[0];
  for (const step of SCALE_STEPS) if (step <= value + 1e-6) best = step;
  return best;
}

/**
 * The shape of a level. Terrain detail is a multiplier on the pixels-per-radian
 * figure the surface shader uses to pick its octave count, so 0.5 means "treat
 * every pixel as twice as wide" and drops roughly one octave of crater field.
 */
function derive(level) {
  const t = Math.max(0, Math.min(1, level));
  return {
    level: t,
    // Held at full resolution until detail has already been given up, because a
    // soft image reads as broken in a way that a smoother hillside does not.
    renderScale: stepFor(0.5 + 0.5 * Math.max(0, (t - 0.35) / 0.65)),
    terrainDetail: 0.42 + 0.58 * t,
    patchScale: 0.45 + 0.55 * t,
    // The pebble field is a four-octave noise per fragment that is only visible
    // with your face against the ground. It is the first thing to go.
    microDetail: t > 0.55,
  };
}

export const PRESETS = {
  low: 0.1,
  medium: 0.45,
  high: 0.75,
  ultra: 1,
};

export function createQuality({ onResolutionChange } = {}) {
  const settings = {
    /** 'auto' | 'low' | 'medium' | 'high' | 'ultra' */
    preset: 'auto',
    targetFps: 60,
    /** Ceiling the auto loop may not climb past, and the value manual mode uses. */
    maxRenderScale: 1,
  };

  let level = 0.75;
  let applied = derive(level);
  // What the loop has learned this machine can hold. Starts optimistic and is
  // pulled down by each overrun, so the climb back up cannot re-enter a range
  // that has already been shown not to work.
  let ceiling = CEILING;
  let nextProbe = 0;

  const window_ = new Float32Array(24);
  let filled = 0;
  let cursor = 0;
  let quietUntil = 0;
  let lastChange = 0;
  /** The frame time that justified the most recent downgrade, so it can be judged. */
  let pending = null;

  /**
   * Frame times are noisy in a way that punishes a mean: a texture upload or a
   * garbage collection doubles one frame in twenty, and reacting to it drops the
   * resolution of a scene that was comfortably inside budget. The median ignores
   * those and still tracks a real slowdown within half a second.
   */
  function median() {
    if (filled < window_.length) return 0;
    const copy = Array.from(window_).sort((a, b) => a - b);
    return copy[copy.length >> 1];
  }

  /** Terrain streaming makes the frames right after a jump meaningless. */
  function settle(ms = 1200) {
    quietUntil = performance.now() + ms;
    filled = 0;
    cursor = 0;
  }

  function apply(next) {
    const before = applied.renderScale;
    applied = derive(next);
    applied.renderScale = Math.min(applied.renderScale, settings.maxRenderScale);
    level = next;
    if (Math.abs(applied.renderScale - before) > 1e-3) onResolutionChange?.(applied.renderScale);
  }

  function setPreset(name) {
    settings.preset = name;
    if (name !== 'auto') apply(PRESETS[name] ?? 0.75);
    else {
      ceiling = CEILING;
      nextProbe = 0;
      settle();
    }
  }

  return {
    settings,
    get renderScale() { return applied.renderScale; },
    get terrainDetail() { return applied.terrainDetail; },
    get patchScale() { return applied.patchScale; },
    get microDetail() { return applied.microDetail; },
    get level() { return level; },
    get auto() { return settings.preset === 'auto'; },
    setPreset,
    setTargetFps(fps) {
      settings.targetFps = fps;
      settle();
    },
    setMaxRenderScale(value) {
      settings.maxRenderScale = value;
      apply(level);
    },
    settle,

    /**
     * Called once a frame with the interval that just elapsed. Returns nothing;
     * the frame loop reads the getters above.
     */
    sample(dtMs) {
      if (settings.preset !== 'auto') return;
      const now = performance.now();
      if (now < quietUntil) return;
      // A tab that was in the background reports one enormous interval. Feeding
      // it in would drop the quality of a scene nobody was watching.
      if (dtMs > 400) { settle(600); return; }
      window_[cursor] = dtMs;
      cursor = (cursor + 1) % window_.length;
      filled = Math.min(filled + 1, window_.length);

      const observed = median();
      if (!observed) return;
      const budget = 1000 / settings.targetFps;
      // Resolution changes cost a frame of their own, so the loop is not allowed
      // to chase every wobble.
      if (now - lastChange < 700) return;

      // Some scenes are not slow because of anything this can turn down — a
      // fragment-bound surface at a Retina pixel count on a laptop is one — and
      // the loop's instinct in that situation is to spend every step it has and
      // arrive at the floor still missing the target. So each downgrade is
      // judged against the frame time that prompted it, and one that bought
      // almost nothing is given back. Better to sit at 40 fps looking right than
      // at 41 fps looking coarse.
      if (pending) {
        const gain = (pending.before - observed) / pending.before;
        const wasted = gain < 0.07;
        if (wasted) {
          ceiling = pending.from;
          nextProbe = now + 20000;
          apply(pending.from);
          lastChange = now;
          pending = null;
          settle(900);
          return;
        }
        pending = null;
      }

      if (observed > budget * 1.18) {
        if (level <= FLOOR) return;
        // Step in proportion to the overshoot: a scene at 9 fps should not take
        // four seconds of visible degradation steps to get where it is going.
        const overshoot = Math.min(observed / budget, 6);
        const next = Math.max(FLOOR, level - 0.06 * overshoot);
        ceiling = Math.max(FLOOR, Math.min(ceiling, next + 0.05));
        nextProbe = now + 9000;
        pending = { from: level, before: observed };
        apply(next);
        lastChange = now;
        settle(500);
      } else if (observed < budget * 1.04 && level < ceiling - 1e-3) {
        apply(Math.min(ceiling, level + 0.05));
        lastChange = now;
        settle(500);
      } else if (observed < budget * 1.04 && now > nextProbe && ceiling < CEILING) {
        // Nothing has struggled for a while; allow one step back into territory
        // that used to be too expensive. Altitude changes what the scene costs,
        // so a ceiling learned on a surface should not stick in orbit.
        ceiling = Math.min(CEILING, ceiling + 0.1);
        nextProbe = now + 9000;
      }
    },
  };
}
