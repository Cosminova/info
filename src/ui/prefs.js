/**
 * Interface preferences, persisted to localStorage.
 *
 * Anything the user can change about the interface itself lives here — scale,
 * accent, opacity, which panels are open, label and HUD visibility, camera
 * sensitivities, keybindings. Rendering options that belong to the simulation
 * (exposure, bloom) stay in the app's own state; this is only the chrome.
 *
 * Appearance values are pushed straight onto the document element as custom
 * properties, so a change retints and rescales the whole interface in one write
 * without any stylesheet or component knowing it happened.
 */

import { VIEW_DEFAULTS } from './view-options.js';

const KEY = 'skyview.ui.v1';

export const DEFAULTS = {
  scale: 1,
  alpha: 0.72,
  accent: 199,
  labels: true,
  labelDensity: 0.5,
  hud: true,
  reticle: true,
  // What is drawn. Declared in view-options.js next to the checkboxes that set
  // them, because a default that lives away from its label goes stale.
  view: VIEW_DEFAULTS,
  quality: {
    // Auto measures the frames this machine actually produces and spends the
    // resolution it can afford, which beats any guess made from the hardware
    // string the browser reports.
    preset: 'auto',
    targetFps: 60,
    maxRenderScale: 1,
  },
  // Which panels start open. Both views share this file, and a panel named here
  // by one is simply unused by the other.
  panels: {
    navigation: true,
    inspector: true,
    camera: false,
    time: true,
    options: false,
    readout: true,
  },
  // Whether the first-run card has been shown. It has to be declared here even
  // though it starts false, because `merge` drops any saved key it does not
  // find in these defaults — so an undeclared flag is written on dismissal,
  // discarded on load, and the card greets you again every single visit.
  seenIntro: false,
  collapsed: {},
  // Labelled to begin with. Eleven icons down the side of the screen are only
  // legible to someone who already knows what they open — a compass and a
  // planet and an eye do not say "navigation", "object" and "display" to
  // anyone on their first visit, and a tooltip cannot be read before you have
  // guessed which icon to hover. The rail still collapses to icons for anyone
  // who has learned them, from the button in the top bar.
  rail: 'labels',
  camera: {
    fov: 52,
    flySpeed: 0.55,
    orbitSensitivity: 0.0045,
    lookSensitivity: 0.0032,
    zoomSpeed: 0.0016,
    damping: 0.9,
    autoCenter: true,
    followTarget: true,
  },
  keys: {},
  bookmarks: [],
};

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

/** Merge saved values over defaults one level into plain objects. */
function merge(base, saved) {
  const out = clone(base);
  if (!saved || typeof saved !== 'object') return out;
  for (const [key, value] of Object.entries(saved)) {
    if (!(key in out)) continue;
    const fallback = out[key];
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      out[key] = { ...fallback, ...(value && typeof value === 'object' ? value : {}) };
    } else if (value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out;
}

export function createPrefs() {
  let values;
  try {
    values = merge(DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    // Private browsing, a full quota, or a value written by an older build with
    // an incompatible shape. None of those are worth failing to start over.
    values = clone(DEFAULTS);
  }

  const listeners = new Set();
  let saveTimer = 0;

  function persist() {
    // Debounced: dragging the scale slider fires input on every pixel and a
    // synchronous localStorage write per event is enough to make it stutter.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(values));
      } catch {
        // Storage unavailable. Preferences still apply for this session.
      }
    }, 220);
  }

  function applyAppearance() {
    const root = document.documentElement.style;
    root.setProperty('--ui-scale', String(values.scale));
    root.setProperty('--ui-alpha', String(values.alpha));
    root.setProperty('--ui-accent-h', String(values.accent));
  }

  function emit(path) {
    for (const fn of listeners) fn(path, values);
  }

  return {
    get all() {
      return values;
    },

    get(path, fallback) {
      const parts = path.split('.');
      let node = values;
      for (const part of parts) {
        if (node === undefined || node === null) return fallback;
        node = node[part];
      }
      return node === undefined ? fallback : node;
    },

    set(path, value) {
      const parts = path.split('.');
      let node = values;
      for (let i = 0; i < parts.length - 1; i++) {
        if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
        node = node[parts[i]];
      }
      const leaf = parts[parts.length - 1];
      if (node[leaf] === value) return value;
      node[leaf] = value;
      if (path === 'scale' || path === 'alpha' || path === 'accent') applyAppearance();
      persist();
      emit(path);
      return value;
    },

    toggle(path) {
      return this.set(path, !this.get(path));
    },

    reset() {
      values = clone(DEFAULTS);
      applyAppearance();
      persist();
      emit('*');
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    applyAppearance,
  };
}
