import { Sim, isStar, isHole } from './physics.js';
import { Renderer } from './render.js';
import { UI, sliderToAccuracy, accuracyToSlider } from './ui.js';
import { PRESETS, TEMPLATES, TEMPLATE_BY_KEY, fromTemplate, zeroMomentum } from './catalog.js';
import { preload } from './textures.js';
import { Tutorial } from './tutorial.js';
import { count } from '../counter.js';
import {
  G, SPEEDS, YEAR, fmtSpeed, sci,
} from './constants.js';

const canvas = document.getElementById('view');
const sim = new Sim();
const renderer = new Renderer(canvas, document.getElementById('label-layer'));

const state = {
  playing: true,
  speed: 86400,
  reverse: false,
  actualRate: 0,
  limited: false,
  selected: null,
  hover: null,
  propsOpen: false,
  tool: 'select',
  addKey: 'earth',
  autoOrbit: true,
  laserPower: 1e28,
  material: 'rock',
  materialMass: 1e18,
  explodeFactor: 4,
  view: {
    labels: true, trails: true, orbits: true, grid: false, habitable: false, markers: true, bloom: true, background: true, lighting: 'realistic',
  },
  resetTrails: false,
  presetKey: 'solar',
  savedData: null,
  epoch: new Date(),
  pendingExplode: null,
};

const cam = {
  mode: 'body',
  focusId: null,
  free: [0, 0, 0],
  yaw: 0.6,
  pitch: 0.5,
  dist: 1e9,
  fov: 50,
  trans: null,
  pos: [0, 0, 0],
  target: [0, 0, 0],
  trailRef: null,
};

// -----------------------------------------------------------------------------
// App API used by the interface

const app = {
  sim,
  state,
  cam,

  loadPreset(key) {
    const preset = PRESETS.find((p) => p.key === key) || PRESETS[0];
    resetSettings();
    sim.clear();
    state.epoch = new Date();
    const setup = preset.build(sim, state.epoch);
    sim.settleTemperatures();
    state.presetKey = preset.key;
    state.savedData = null;
    state.selected = null;
    state.propsOpen = false;
    state.reverse = false;
    state.pendingExplode = setup.explode ? { name: setup.explode.name, at: performance.now() + setup.explode.after * 1000 } : null;
    applyCamera(setup);
    app.setSpeed(setup.speed);
    state.playing = true;
    state.resetTrails = true;
    ui.notify(preset.name);
  },

  restart() {
    if (state.savedData) app.loadData(state.savedData);
    else app.loadPreset(state.presetKey);
  },

  loadData(data) {
    resetSettings();
    sim.load(data.sim);
    state.epoch = new Date(data.epoch);
    state.savedData = data;
    state.selected = null;
    state.propsOpen = false;
    Object.assign(cam, { yaw: data.cam.yaw, pitch: data.cam.pitch, dist: data.cam.dist, trans: null });
    const f = data.cam.focusName ? sim.bodies.find((b) => b.name === data.cam.focusName) : null;
    cam.mode = f ? 'body' : 'com';
    cam.focusId = f ? f.id : null;
    cam.trailRef = cam.focusId;
    app.setSpeed(data.speed || 86400);
    state.resetTrails = true;
  },

  save() {
    const name = window.prompt('Name this simulation', PRESETS.find((p) => p.key === state.presetKey)?.name || 'My simulation');
    if (!name) return;
    const focus = cam.focusId ? sim.byId(cam.focusId) : null;
    const data = {
      sim: sim.serialize(),
      epoch: state.epoch.getTime(),
      speed: state.speed,
      cam: { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, focusName: focus?.name || null },
    };
    const list = readSaves();
    list.unshift({ key: String(Date.now()), name, when: new Date().toLocaleString(), count: data.sim.bodies.length, data });
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(list.slice(0, 12)));
      ui.notify(`Saved “${name}”`);
    } catch {
      ui.notify('Not enough browser storage to save this one — try deleting fragments first');
    }
  },

  savedList() {
    return readSaves();
  },

  loadSaved(key) {
    const s = readSaves().find((x) => x.key === key);
    if (s) {
      app.loadData(s.data);
      ui.notify(`Opened “${s.name}”`);
    }
  },

  select(id) {
    state.selected = id;
    state.propsOpen = id != null;
    ui.refreshProps(true);
  },

  focus(id) {
    const b = id != null ? sim.byId(id) : null;
    if (!b) return;
    startTransition('body', b.id, focusDistance(b, cam.dist));
  },

  setTool(tool, toggle = false) {
    state.tool = toggle && state.tool === tool && tool !== 'select' ? 'select' : tool;
    ui.renderToolOpts();
    const hints = {
      add: `Click to place ${TEMPLATE_BY_KEY.get(state.addKey)?.name || 'an object'} · drag to throw it`,
      move: 'Drag an object to move it · Shift+drag to set its velocity',
      delete: 'Click an object to delete it',
      laser: 'Hold the mouse on an object to fire the laser',
      explode: 'Click an object to explode it',
      material: 'Drag in space to spray material',
    };
    ui.hint(hints[state.tool] || '');
    canvas.dataset.tool = state.tool;
  },

  setSetting(key, el) {
    const s = sim.settings;
    if (el.type === 'checkbox') s[key] = el.checked;
    else if (key === 'gMult') s.gMult = Math.pow(10, Number(el.value));
    else if (key === 'accuracy') s.accuracy = sliderToAccuracy(Number(el.value));
    else if (key === 'maxFragments') s.maxFragments = Number(el.value);
    else s[key] = el.value;
    sim.accValid = false;
    ui.setText('gMult', `${sci(s.gMult)}×`);
    ui.setText('accuracy', `${Math.round(accuracyToSlider(s.accuracy) * 100)}%`);
    ui.setText('maxFragments', String(s.maxFragments));
  },

  setOpt(key, el) {
    if (key === 'laserPower') {
      state.laserPower = Math.pow(10, Number(el.value));
      ui.setText('laserPower', `${sci(state.laserPower)} W`);
    } else if (key === 'materialMass') {
      state.materialMass = Math.pow(10, Number(el.value));
      ui.setText('materialMass', `${sci(state.materialMass)} kg`);
    } else if (key === 'explodeFactor') {
      state.explodeFactor = Number(el.value);
      ui.setText('explodeFactor', `${state.explodeFactor.toFixed(1)}× binding`);
    } else {
      state[key] = el.value;
    }
  },

  setProp(key, el) {
    const b = sim.byId(state.selected);
    if (!b) return;
    if (key === 'name') {
      b.name = el.value.trim() || b.name;
      return;
    }
    const v = Number(el.value);
    if (key === 'mass') {
      b.mass = Math.pow(10, v);
      b.initMass = b.mass;
      b.rocheChunk = 0;
      if (b.msStar) sim.updateStar(b);
      if (isHole(b)) b.radius = 2 * G * b.mass / (299792458 ** 2);
    } else if (key === 'radius') {
      b.radius = Math.pow(10, v);
      if (isStar(b)) {
        b.msStar = false;
        b.lum = 4 * Math.PI * b.radius ** 2 * 5.670374e-8 * b.temp ** 4;
      }
      b.rocheChunk = 0;
    } else if (key === 'temp') {
      if (b.heat) {
        b.heat.fill(v);
        b.heatVersion++;
      }
      b.temp = v;
      if (v > 600) b.clouds = null;
      if (v > 2200) b.atmo = null;
    }
    sim.accValid = false;
  },

  motion(kind) {
    const b = sim.byId(state.selected);
    if (!b) return;
    const p = sim.dominant(b);
    const base = p ? [p.vx, p.vy, p.vz] : [0, 0, 0];
    const rel = [b.vx - base[0], b.vy - base[1], b.vz - base[2]];
    const set = (f) => {
      b.vx = base[0] + rel[0] * f;
      b.vy = base[1] + rel[1] * f;
      b.vz = base[2] + rel[2] * f;
    };
    if (kind === 'circularize') sim.circularize(b, p);
    else if (kind === 'stop') set(0);
    else if (kind === 'reverse') set(-1);
    else if (kind === 'faster') set(1.1);
    else if (kind === 'slower') set(0.9);
    else if (kind === 'atmo') b.atmo = null;
    sim.accValid = false;
    state.resetTrails = true;
  },

  explodeSelected() {
    const b = sim.byId(state.selected);
    if (b) sim.explode(b, state.explodeFactor);
  },

  deleteSelected() {
    const b = sim.byId(state.selected);
    if (b) sim.remove(b);
  },

  togglePlay() {
    state.playing = !state.playing;
  },

  toggleReverse() {
    state.reverse = !state.reverse;
    ui.notify(state.reverse ? 'Time reversed' : 'Time running forward');
  },

  step() {
    state.playing = false;
    if (!sim.accValid) sim.computeAcc();
    sim.advance(sim.maxDt * (state.reverse ? -1 : 1), 50);
    state.simAdvanced = true;
  },

  changeSpeed(dir) {
    let i = SPEEDS.findIndex((s) => s >= state.speed * 0.999);
    if (i < 0) i = SPEEDS.length - 1;
    if (dir > 0 && SPEEDS[i] <= state.speed * 1.001) i++;
    else if (dir < 0) i--;
    state.speed = SPEEDS[Math.min(Math.max(i, 0), SPEEDS.length - 1)];
  },

  setSpeed(v) {
    state.speed = v;
  },

  clearFragments() {
    for (const b of sim.minors) b.dead = true;
    sim.listDirty = true;
    sim.accValid = false;
  },

  balance() {
    zeroMomentum(sim);
    sim.accValid = false;
    state.resetTrails = true;
  },

  reverseAll() {
    for (const b of sim.bodies) {
      b.vx = -b.vx;
      b.vy = -b.vy;
      b.vz = -b.vz;
    }
    sim.accValid = false;
    state.resetTrails = true;
  },

  orbitAll() {
    const order = [...sim.majors].sort((a, b) => b.mass - a.mass);
    for (const b of order) {
      const p = sim.dominant(b);
      if (p) sim.circularize(b, p);
    }
    state.resetTrails = true;
  },

  overview() {
    sim.refreshLists();
    const com = centreOfMass(sim.majors);
    let ext = 0;
    for (const b of sim.majors) ext = Math.max(ext, Math.hypot(b.x - com[0], b.y - com[1], b.z - com[2]) + b.radius);
    startTransition('com', null, Math.max(ext * 2.6, 1e7));
  },

  dateLabel() {
    const t = sim.time;
    if (Math.abs(t) < 8000 * YEAR) {
      const d = new Date(state.epoch.getTime() + t * 1000);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    const years = state.epoch.getFullYear() + t / YEAR;
    return `Year ${Math.round(years).toLocaleString()}`;
  },
};

const ui = new UI(document.getElementById('ui-root'), app);
const tour = new Tutorial(app, ui);
app.startTutorial = () => tour.start();
window.sandbox = { app, sim, renderer, cam, ui, tour };

const SAVE_KEY = 'cosminova-sandbox-saves';
function readSaves() {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY) || '[]');
  } catch {
    return [];
  }
}

function resetSettings() {
  Object.assign(sim.settings, {
    gravity: true, collide: true, fragment: true, temperature: true, mode: 'realistic', accuracy: 0.02, gMult: 1, maxFragments: 3000, softening: 0, roche: true,
  });
}

// -----------------------------------------------------------------------------
// Camera

function centreOfMass(list) {
  let m = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const b of list) {
    m += b.mass;
    x += b.mass * b.x;
    y += b.mass * b.y;
    z += b.mass * b.z;
  }
  return m ? [x / m, y / m, z / m] : [0, 0, 0];
}

function baseTarget() {
  if (cam.mode === 'body') {
    const f = sim.byId(cam.focusId);
    if (f) return [f.x, f.y, f.z];
    cam.mode = 'free';
    cam.free = [...cam.target];
  }
  if (cam.mode === 'com') {
    sim.refreshLists();
    return centreOfMass(sim.majors.length ? sim.majors : sim.bodies);
  }
  return cam.free;
}

function focusDistance(b, current) {
  if (isHole(b)) return Math.max(b.radius * 40, Math.min(current, b.radius * 400));
  const want = b.radius * (isStar(b) ? 6 : b.minor ? 10 : 4.5);
  return want;
}

function startTransition(mode, id, dist) {
  const from = [...cam.target];
  cam.mode = mode;
  cam.focusId = id;
  cam.trailRef = mode === 'body' ? id : null;
  const base = baseTarget();
  cam.trans = {
    offset: [from[0] - base[0], from[1] - base[1], from[2] - base[2]],
    t: 0,
    d0: cam.dist,
    d1: dist,
  };
}

function applyCamera(setup) {
  const f = setup.focus ? sim.bodies.find((b) => b.name === setup.focus) : null;
  cam.yaw = setup.yaw ?? 0.5;
  cam.pitch = setup.pitch ?? 0.4;
  cam.dist = setup.dist;
  cam.trans = null;
  if (setup.focusCOM || !f) {
    cam.mode = 'com';
    cam.focusId = null;
    cam.trailRef = null;
    if (!f && !sim.bodies.length) {
      cam.mode = 'free';
      cam.free = [0, 0, 0];
    }
  } else {
    cam.mode = 'body';
    cam.focusId = f.id;
    cam.trailRef = f.id;
  }
}

function minDistance() {
  if (cam.mode !== 'body') return 1;
  const f = sim.byId(cam.focusId);
  if (!f) return 1;
  return isHole(f) ? f.radius * 3 : f.radius * 1.06;
}

function updateCamera(dtReal) {
  let t = baseTarget();
  if (cam.trans) {
    cam.trans.t = Math.min(1, cam.trans.t + dtReal / 1.1);
    const e = 1 - Math.pow(1 - cam.trans.t, 3);
    const o = cam.trans.offset;
    t = [t[0] + o[0] * (1 - e), t[1] + o[1] * (1 - e), t[2] + o[2] * (1 - e)];
    cam.dist = Math.exp(Math.log(cam.trans.d0) + (Math.log(cam.trans.d1) - Math.log(cam.trans.d0)) * e);
    if (cam.trans.t >= 1) cam.trans = null;
  }
  cam.dist = Math.min(Math.max(cam.dist, minDistance()), 1e24);
  cam.target = t;
  const cp = Math.cos(cam.pitch);
  cam.pos = [
    t[0] + cam.dist * cp * Math.sin(cam.yaw),
    t[1] + cam.dist * Math.sin(cam.pitch),
    t[2] + cam.dist * cp * Math.cos(cam.yaw),
  ];
}

// -----------------------------------------------------------------------------
// Input

const pointers = new Map();
let drag = null;
let lastPick = 0;
let lastClick = { id: null, time: 0 };
let laser = null;
let spray = null;
let pinch = null;

/**
 * Where the ray through (x, y) meets the grid plane through `at`. Seen nearly
 * edge-on that plane runs off to infinity, so use the plane facing the camera.
 */
function planePoint(x, y, at = cam.target) {
  const d = renderer.ray(x, y);
  const o = cam.pos;
  const rel = [at[0] - o[0], at[1] - o[1], at[2] - o[2]];
  const range = Math.hypot(rel[0], rel[1], rel[2]) || cam.dist;
  const f = [cam.target[0] - o[0], cam.target[1] - o[1], cam.target[2] - o[2]];
  const fl = Math.hypot(f[0], f[1], f[2]) || 1;
  let t = -1;
  if (Math.abs(f[1] / fl) > 0.25 && Math.abs(d[1]) > 1e-6) t = rel[1] / d[1];
  if (!(t > 0) || t > range * 8) {
    const fd = (d[0] * f[0] + d[1] * f[1] + d[2] * f[2]) / fl;
    t = fd > 1e-6 ? (rel[0] * f[0] + rel[1] * f[1] + rel[2] * f[2]) / fl / fd : range;
  }
  return [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
}

/** Velocity for something released at A after a drag to B. */
function throwVelocity(A, B) {
  const p = sim.dominantAt(A[0], A[1], A[2]);
  let base = [0, 0, 0];
  let vref;
  let lref = cam.dist * 0.3;
  if (p) {
    base = [p.vx, p.vy, p.vz];
    const r = Math.max(Math.hypot(A[0] - p.x, A[1] - p.y, A[2] - p.z), p.radius);
    vref = Math.sqrt((G * sim.settings.gMult * p.mass) / r);
    lref = Math.max(r * 0.35, cam.dist * 0.05);
  } else {
    vref = Math.sqrt(cam.dist) * 0.5;
  }
  const k = vref / lref;
  return [base[0] + (B[0] - A[0]) * k, base[1] + (B[1] - A[1]) * k, base[2] + (B[2] - A[2]) * k];
}

function uniqueName(name) {
  if (!sim.bodies.some((b) => b.name === name)) return name;
  for (let i = 2; ; i++) if (!sim.bodies.some((b) => b.name === `${name} ${i}`)) return `${name} ${i}`;
}

function placeObject(A, B) {
  const t = TEMPLATE_BY_KEY.get(state.addKey);
  if (!t) return;
  const spec = fromTemplate(state.addKey, { x: A[0], y: A[1], z: A[2], name: uniqueName(t.name) });
  for (const o of sim.majors) {
    if (Math.hypot(o.x - A[0], o.y - A[1], o.z - A[2]) < o.radius + spec.radius) {
      ui.notify(`Too close to ${o.name} — place it further out`);
      return;
    }
  }
  let v;
  if (B) {
    v = throwVelocity(A, B);
  } else {
    const p = sim.dominantAt(A[0], A[1], A[2]);
    v = p ? [p.vx, p.vy, p.vz] : [0, 0, 0];
    if (p && state.autoOrbit && p.mass > spec.mass) {
      spec.vx = v[0];
      spec.vy = v[1];
      spec.vz = v[2];
      const b = sim.add(spec);
      sim.settleTemperatures([b]);
      sim.circularize(b, p);
      ui.notify(`${b.name} placed in orbit around ${p.name}`);
      return;
    }
  }
  spec.vx = v[0];
  spec.vy = v[1];
  spec.vz = v[2];
  const b = sim.add(spec);
  sim.settleTemperatures([b]);
  const p = sim.dominant(b);
  const rel = p ? Math.hypot(v[0] - p.vx, v[1] - p.vy, v[2] - p.vz) : Math.hypot(v[0], v[1], v[2]);
  ui.notify(B ? `${b.name} thrown at ${fmtSpeed(rel)}${p ? ` relative to ${p.name}` : ''}` : `${b.name} added`);
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  ui.closePops();
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: cam.dist };
    drag = null;
    return;
  }
  const x = e.clientX;
  const y = e.clientY;
  drag = { x0: x, y0: y, x, y, button: e.button, moved: false, mode: 'camera', shift: e.shiftKey };
  if (e.button !== 0) return;
  const tool = state.tool;
  if (tool === 'add') {
    drag.mode = 'add';
    drag.A = planePoint(x, y);
    drag.ref = [...cam.target];
  } else if (tool === 'move') {
    const b = renderer.pick(sim, x, y);
    if (b) {
      drag.mode = e.shiftKey ? 'fling' : 'move';
      drag.body = b.id;
      drag.planeAt = [b.x, b.y, b.z];
      app.select(b.id);
    }
  } else if (tool === 'laser') {
    drag.mode = 'laser';
    laser = { x, y };
  } else if (tool === 'material') {
    drag.mode = 'material';
    spray = { A: planePoint(x, y), B: null, acc: 0 };
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (p) {
    p.x = e.clientX;
    p.y = e.clientY;
  }
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    cam.dist = pinch.dist * (pinch.d / Math.max(d, 1));
    cam.trans = null;
    return;
  }
  const x = e.clientX;
  const y = e.clientY;
  if (!drag) {
    const now = performance.now();
    if (now - lastPick > 40) {
      lastPick = now;
      const b = renderer.pick(sim, x, y);
      state.hover = b ? b.id : null;
      canvas.style.cursor = b && state.tool !== 'add' && state.tool !== 'material' ? 'pointer' : '';
    }
    if (state.tool === 'add') {
      const A = planePoint(x, y);
      showGhost(A);
    }
    return;
  }
  const dx = x - drag.x;
  const dy = y - drag.y;
  drag.x = x;
  drag.y = y;
  if (Math.hypot(x - drag.x0, y - drag.y0) > 4) drag.moved = true;
  if (drag.mode === 'camera') {
    if (!drag.moved) return;
    cam.yaw -= dx * 0.0055;
    cam.pitch = Math.min(1.55, Math.max(-1.55, cam.pitch + dy * 0.0055));
  } else if (drag.mode === 'add') {
    if (drag.moved) {
      const B = planePoint(x, y, drag.A);
      renderer.setArrow(drag.A, B);
      drag.B = B;
    }
    showGhost(drag.A);
  } else if (drag.mode === 'move') {
    const b = sim.byId(drag.body);
    if (!b) return;
    const P = planePoint(x, y, drag.planeAt);
    b.x = P[0];
    b.y = P[1];
    b.z = P[2];
    sim.accValid = false;
    state.resetTrails = true;
  } else if (drag.mode === 'fling') {
    const b = sim.byId(drag.body);
    if (!b) return;
    drag.B = planePoint(x, y, [b.x, b.y, b.z]);
    renderer.setArrow([b.x, b.y, b.z], drag.B);
  } else if (drag.mode === 'laser') {
    laser = { x, y };
  } else if (drag.mode === 'material') {
    spray.B = planePoint(x, y, spray.A);
    renderer.setArrow(spray.A, spray.B);
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pinch) {
    if (pointers.size < 2) pinch = null;
    drag = null;
    return;
  }
  if (!drag) return;
  const d = drag;
  drag = null;
  renderer.setArrow(null);
  laser = null;
  if (d.mode === 'material') {
    spray = null;
    return;
  }
  if (d.mode === 'add') {
    placeObject(d.A, d.moved ? d.B : null);
    return;
  }
  if (d.mode === 'fling') {
    const b = sim.byId(d.body);
    if (b && d.B) {
      const v = throwVelocity([b.x, b.y, b.z], d.B);
      b.vx = v[0];
      b.vy = v[1];
      b.vz = v[2];
      sim.accValid = false;
      state.resetTrails = true;
    }
    return;
  }
  if (d.mode === 'move' || d.mode === 'laser') return;
  if (d.moved) return;

  // A click.
  const b = renderer.pick(sim, e.clientX, e.clientY);
  if (d.button === 2) {
    if (b) {
      app.select(b.id);
      state.propsOpen = true;
    }
    return;
  }
  if (state.tool === 'delete') {
    if (b) sim.remove(b);
    return;
  }
  if (state.tool === 'explode') {
    if (b) sim.explode(b, state.explodeFactor);
    return;
  }
  const now = performance.now();
  if (b) {
    if ((lastClick.id === b.id && now - lastClick.time < 450) || state.selected === b.id) {
      app.focus(b.id);
    }
    app.select(b.id);
    lastClick = { id: b.id, time: now };
  } else if (state.selected) {
    app.select(null);
  }
}

canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const k = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
  if (cam.trans) {
    cam.trans.d1 *= k;
  } else {
    cam.dist *= k;
  }
}, { passive: false });

function showGhost(A) {
  const t = TEMPLATE_BY_KEY.get(state.addKey);
  if (!t) return;
  const spec = fromTemplate(state.addKey);
  const p = sim.dominantAt(A[0], A[1], A[2]);
  renderer.setGhost({
    pos: A,
    radius: spec.radius,
    color: spec.color,
    parent: p ? [p.x, p.y, p.z] : null,
    orbitR: p && state.autoOrbit ? Math.hypot(A[0] - p.x, A[2] - p.z) : 0,
  });
}

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  const k = e.key;
  if (k === ' ') {
    e.preventDefault();
    app.togglePlay();
  } else if (k === ',' || k === '[' || k === '-') app.changeSpeed(-1);
  else if (k === '.' || k === ']' || k === '=' || k === '+') app.changeSpeed(1);
  else if (k === 'f' || k === 'F') app.focus(state.selected);
  else if (k === 'Delete' || k === 'Backspace') app.deleteSelected();
  else if (k === 'Escape') {
    ui.closePops();
    ui.closeModals();
    app.setTool('select');
  } else if (k === 'a' || k === 'A') app.setTool('add');
  else if (k === 'm' || k === 'M') app.setTool('move');
  else if (k === 'x' || k === 'X') app.setTool('laser');
  else if (k === 't' || k === 'T') state.view.trails = !state.view.trails;
  else if (k === 'o' || k === 'O') state.view.orbits = !state.view.orbits;
  else if (k === 'l' || k === 'L') state.view.labels = !state.view.labels;
  else if (k === 'g' || k === 'G') state.view.grid = !state.view.grid;
  else if (k === 'r' || k === 'R') app.toggleReverse();
  else return;
  ui.syncView();
});

window.addEventListener('resize', () => renderer.resize());

// -----------------------------------------------------------------------------
// Loop

let last = performance.now();
let impactNotices = 0;
let lastNotice = 0;

function handleEvents() {
  let flashes = 0;
  for (const ev of sim.events) {
    tour.onEvent(ev);
    if (ev.type === 'impact') {
      if (ev.major) {
        renderer.addFlash(ev);
        if (impactNotices < 2) {
          ui.notify(`${ev.bName} hit ${ev.aName} at ${fmtSpeed(ev.v)}`);
          impactNotices++;
        }
      } else if (flashes < 8) {
        renderer.addFlash({ ...ev, energy: ev.energy * 1e-3 });
        flashes++;
      }
    } else if (ev.type === 'flash' || ev.type === 'supernova') {
      renderer.addFlash(ev);
    } else if (ev.type === 'merged') {
      if (state.selected === ev.from) state.selected = ev.into || null;
      if (cam.mode === 'body' && cam.focusId === ev.from && ev.into) {
        cam.focusId = ev.into;
        cam.trailRef = ev.into;
      }
    } else if (ev.type === 'removed') {
      if (state.selected === ev.id) app.select(null);
    } else if (ev.type === 'notice') {
      const now = performance.now();
      if (now - lastNotice > 1400) {
        lastNotice = now;
        ui.notify(ev.text);
      }
    }
  }
  sim.events.length = 0;
}

function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  state.simAdvanced = state.simAdvanced || false;

  let achieved = 0;
  if (state.playing && dtReal > 0) {
    const want = state.speed * dtReal * (state.reverse ? -1 : 1);
    achieved = sim.advance(want, 14);
    state.limited = sim.limited;
    state.actualRate = state.actualRate * 0.9 + (achieved / dtReal) * 0.1;
    state.simAdvanced = achieved !== 0;
  } else {
    state.actualRate = 0;
  }

  if (state.pendingExplode && now > state.pendingExplode.at && state.playing) {
    const b = sim.bodies.find((o) => o.name === state.pendingExplode.name);
    state.pendingExplode = null;
    if (b) sim.explode(b);
  }

  updateCamera(dtReal);
  // A throw is aimed on screen, so its points ride along with the camera
  // while the focused world moves on under it.
  if (drag?.mode === 'add' && drag.ref) {
    const d = [cam.target[0] - drag.ref[0], cam.target[1] - drag.ref[1], cam.target[2] - drag.ref[2]];
    drag.ref = [...cam.target];
    for (const P of [drag.A, drag.B]) {
      if (P) for (let k = 0; k < 3; k++) P[k] += d[k];
    }
    if (drag.B) renderer.setArrow(drag.A, drag.B);
    showGhost(drag.A);
  }

  if (laser && state.tool === 'laser') {
    const b = renderer.pick(sim, laser.x, laser.y, { minorsToo: false });
    if (b) {
      const hit = renderer.hitSphere(b, laser.x, laser.y) || towardCamera(b);
      const n = [hit[0] - b.x, hit[1] - b.y, hit[2] - b.z];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      const dtLaser = state.playing ? Math.abs(achieved) : dtReal * state.speed;
      sim.laser(b, [n[0] / l, n[1] / l, n[2] / l], state.laserPower, dtLaser);
      renderer.setBeam(hit);
    } else {
      renderer.setBeam(null);
    }
    state.laserFiring = !!b;
  } else {
    renderer.setBeam(null);
    state.laserFiring = false;
  }

  if (spray && spray.B) {
    spray.acc += dtReal * 30;
    const v = throwVelocity(spray.A, spray.B);
    while (spray.acc >= 1) {
      spray.acc -= 1;
      sim.emit(spray.A[0], spray.A[1], spray.A[2], v[0], v[1], v[2], state.materialMass, state.material);
    }
  }

  if (state.tool !== 'add' || ui.open !== 'add') {
    if (state.tool !== 'add') renderer.setGhost(null);
  }

  handleEvents();
  impactNotices = Math.max(0, impactNotices - dtReal * 0.5);

  renderer.update(sim, cam, state.view, {
    selected: state.selected,
    hover: state.hover,
    simAdvanced: state.simAdvanced,
    resetTrails: state.resetTrails,
    dtReal,
  });
  state.resetTrails = false;
  state.simAdvanced = false;
  ui.update(now);
  tour.update(now);
  requestAnimationFrame(frame);
}

function towardCamera(b) {
  const d = [cam.pos[0] - b.x, cam.pos[1] - b.y, cam.pos[2] - b.z];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [b.x + (d[0] / l) * b.radius, b.y + (d[1] / l) * b.radius, b.z + (d[2] / l) * b.radius];
}

// -----------------------------------------------------------------------------
// Start: the same cover and start screen as the app.

async function boot() {
  const fill = document.getElementById('loading-fill');
  const status = document.getElementById('loading-status');
  const stems = new Set(['sun-colour']);
  for (const t of TEMPLATES) {
    if (t.tex) stems.add(t.tex);
    if (t.night) stems.add(t.night);
    if (t.clouds) stems.add(t.clouds);
    if (t.rings) stems.add(t.rings.tex);
  }
  if (status) status.textContent = 'loading worlds…';
  await preload([...stems], (f) => {
    if (fill) fill.style.width = `${Math.round(f * 100)}%`;
  });
  app.loadPreset('solar');
  requestAnimationFrame(frame);
  const cover = document.getElementById('loading');
  cover?.classList.add('is-done');
  setTimeout(() => {
    if (cover) cover.hidden = true;
  }, 600);

  const home = document.getElementById('home');
  const start = document.getElementById('home-start');
  const backdrop = document.getElementById('home-backdrop');
  if (backdrop) {
    const img = new Image();
    img.onload = () => {
      backdrop.style.backgroundImage = `url("${img.src}")`;
      backdrop.classList.add('is-loaded');
    };
    img.src = `${import.meta.env.BASE_URL || './'}home/saturn.jpg`;
  }
  if (start && home) {
    start.disabled = false;
    start.textContent = matchMedia('(pointer: coarse)').matches ? 'Tap to start' : 'Click to start';
    start.classList.add('is-ready');
    home.classList.add('is-ready');
    start.focus({ preventScroll: true });
    let gone = false;
    const go = () => {
      if (gone) return;
      gone = true;
      home.classList.add('is-going');
      setTimeout(() => home.remove(), 700);
      setTimeout(() => tour.offer(), 1400);
      count('players');
    };
    start.addEventListener('click', go);
    home.addEventListener('click', go);
  }
}

boot();
