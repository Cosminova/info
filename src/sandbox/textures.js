import * as THREE from 'three';

const BASE = import.meta.env.BASE_URL || './';
const loader = new THREE.TextureLoader();
const cache = new Map();

/** A surface map from the app's own set (public/textures/bodies), by file stem. */
export function bodyTexture(stem, { color = true } = {}) {
  const key = `b:${stem}`;
  if (cache.has(key)) return cache.get(key);
  const url = stem.endsWith('.png') ? `${BASE}textures/bodies/${stem}` : `${BASE}textures/bodies/${stem}-far.jpg`;
  const tex = loader.load(url);
  if (color) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

export function preload(stems, onProgress) {
  let done = 0;
  return Promise.all(stems.map((stem) => new Promise((resolve) => {
    const url = stem.endsWith('.png') ? `${BASE}textures/bodies/${stem}` : `${BASE}textures/bodies/${stem}-far.jpg`;
    loader.load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      cache.set(`b:${stem}`, tex);
      onProgress?.(++done / stems.length);
      resolve();
    }, undefined, () => {
      onProgress?.(++done / stems.length);
      resolve();
    });
  })));
}

export function skyTexture() {
  const key = 'sky';
  if (cache.has(key)) return cache.get(key);
  const tex = loader.load(`${BASE}textures/milkyway-2k.jpg`);
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, tex);
  return tex;
}

// -----------------------------------------------------------------------------
// Procedural worlds, painted on the sphere so the seam and poles are clean.

function hash(x, y, z, seed) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144269504) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise3(x, y, z, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash(xi + dx, yi + dy, zi + dz, seed);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

function fbm(x, y, z, seed, oct = 5) {
  let a = 0.5;
  let f = 1;
  let s = 0;
  for (let i = 0; i < oct; i++) {
    s += a * noise3(x * f, y * f, z * f, seed + i * 17);
    a *= 0.5;
    f *= 2.03;
  }
  return s / (1 - Math.pow(0.5, oct));
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp01 = (t) => Math.min(1, Math.max(0, t));

const PAINTERS = {
  rock(x, y, z, s) {
    const n = fbm(x * 3, y * 3, z * 3, s);
    const d = fbm(x * 12, y * 12, z * 12, s + 5, 3);
    const base = mix([0.33, 0.3, 0.27], [0.58, 0.53, 0.47], n);
    return base.map((c) => c * (0.75 + 0.4 * d));
  },
  desert(x, y, z, s) {
    const n = fbm(x * 2.5, y * 2.5, z * 2.5, s);
    const dune = 0.5 + 0.5 * Math.sin((x * 9 + fbm(x * 4, y * 4, z * 4, s + 3) * 6) * 3);
    return mix([0.72, 0.52, 0.32], [0.93, 0.78, 0.55], n * 0.7 + dune * 0.3);
  },
  ocean(x, y, z, s) {
    const n = fbm(x * 1.8, y * 1.8, z * 1.8, s);
    const lat = Math.abs(y);
    if (lat > 0.86 + (n - 0.5) * 0.1) return [0.92, 0.95, 0.98];
    if (n > 0.56) {
      const h = clamp01((n - 0.56) * 5);
      return mix([0.24, 0.42, 0.18], [0.55, 0.47, 0.32], h);
    }
    return mix([0.03, 0.12, 0.32], [0.08, 0.3, 0.5], clamp01((n - 0.35) * 4));
  },
  lava(x, y, z, s) {
    const n = fbm(x * 3, y * 3, z * 3, s);
    const crack = Math.abs(fbm(x * 6, y * 6, z * 6, s + 9) - 0.5);
    if (crack < 0.035) return [1, 0.45, 0.08];
    return mix([0.08, 0.06, 0.05], [0.28, 0.2, 0.16], n);
  },
  ice(x, y, z, s) {
    const n = fbm(x * 3, y * 3, z * 3, s);
    const crack = Math.abs(fbm(x * 5, y * 5, z * 5, s + 2) - 0.5) < 0.02;
    const base = mix([0.72, 0.8, 0.9], [0.95, 0.97, 1], n);
    return crack ? base.map((c) => c * 0.65) : base;
  },
  gas(x, y, z, s) {
    const turb = fbm(x * 3, y * 3, z * 3, s) - 0.5;
    const band = 0.5 + 0.5 * Math.sin((y + turb * 0.18) * 22 + s);
    return mix([0.55, 0.6, 0.75], [0.88, 0.86, 0.82], band);
  },
  hotgas(x, y, z, s) {
    const turb = fbm(x * 3, y * 3, z * 3, s) - 0.5;
    const band = 0.5 + 0.5 * Math.sin((y + turb * 0.25) * 16 + s);
    return mix([0.25, 0.1, 0.07], [0.6, 0.3, 0.16], band);
  },
  comet(x, y, z, s) {
    const n = fbm(x * 4, y * 4, z * 4, s);
    return mix([0.12, 0.11, 0.1], [0.32, 0.3, 0.28], n);
  },
};

export function proceduralTexture(proc) {
  const key = `p:${proc.type}:${proc.seed}`;
  if (cache.has(key)) return cache.get(key);
  const W = 512;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const paint = PAINTERS[proc.type] || PAINTERS.rock;
  for (let j = 0; j < H; j++) {
    const theta = (Math.PI * (j + 0.5)) / H;
    for (let i = 0; i < W; i++) {
      const phi = ((i + 0.5) / W) * Math.PI * 2;
      // Same parameterisation as three's SphereGeometry.
      const x = -Math.cos(phi) * Math.sin(theta);
      const y = Math.cos(theta);
      const z = Math.sin(phi) * Math.sin(theta);
      const c = paint(x + 5, y + 5, z + 5, proc.seed);
      const k = (j * W + i) * 4;
      img.data[k] = Math.min(255, c[0] * 255);
      img.data[k + 1] = Math.min(255, c[1] * 255);
      img.data[k + 2] = Math.min(255, c[2] * 255);
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

/** A thumbnail for the Add panel: the texture shaded as a lit ball. */
export function thumbnailUrl(template) {
  if (template.tex) {
    return `${BASE}textures/bodies/${template.tex}-far.jpg`;
  }
  if (template.proc) {
    const tex = proceduralTexture(template.proc);
    return tex.image.toDataURL('image/jpeg', 0.8);
  }
  return null;
}

/** Soft round sprite, for glows and flashes. */
export function glowTexture() {
  if (cache.has('glow')) return cache.get('glow');
  const s = 128;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.08, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.28)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.06)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(canvas);
  cache.set('glow', tex);
  return tex;
}
