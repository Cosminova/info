import {
  DataTexture,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  RedFormat,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
} from 'three';

/** IEEE 754 binary16 bits for a finite float, for upload as a filterable texture. */
function toHalf(value) {
  const f = new Float32Array(1);
  const i = new Uint32Array(f.buffer);
  f[0] = value;
  const bits = i[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = ((bits >>> 23) & 0xff) - 112;
  const mantissa = bits & 0x7fffff;
  if (exponent <= 0) return sign;
  if (exponent >= 0x1f) return sign | 0x7bff;
  return sign | (exponent << 10) | (mantissa >>> 13);
}

/** The inverse, for reading a decoded elevation map back on the CPU. */
function fromHalf(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * Math.pow(2, -24) * mantissa;
  if (exponent === 0x1f) return mantissa ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 25) * (0x400 + mantissa);
}

/**
 * Manifest-driven texture loading with two tiers.
 *
 * The small tier for every body is fetched up front so nothing is ever
 * untextured, and the large tier is fetched only once the camera is close
 * enough to resolve it. Without that split, opening the app would mean pulling
 * eighty megabytes before the first frame.
 */
export class BodyTextures {
  constructor(manifest, { basePath = 'textures/', anisotropy = 8 } = {}) {
    this.manifest = manifest;
    this.basePath = basePath;
    this.anisotropy = anisotropy;
    this.loader = new TextureLoader();
    this.cache = new Map();
    this.pending = new Set();
  }

  entry(body, kind, tier) {
    return this.manifest?.[body]?.[kind]?.[tier] ?? null;
  }

  /**
   * Measured elevation in kilometres at a point on a body, read off the same
   * decoded map the vertex shader displaces with, or null where there is none.
   *
   * The mip chain is built on the CPU and kept, so this is a lookup rather than
   * a read back from the GPU. Anything that has to sit on the ground needs it:
   * a lander placed at the reference radius floats or sinks by however much the
   * local datum differs from the sphere, which at Tranquillity Base is 1.5 km.
   *
   * `dir` is a unit vector in the body frame, and the mapping matches dirToUv
   * in the terrain shader so the answer agrees with what is drawn.
   */
  elevationKm(body, dir) {
    // The finest level already resident, and no request for a better one: this
    // runs per craft per frame and must not pull a sixteen-megabyte map to
    // answer where a lander's feet are.
    let texture = null;
    for (const width of this.levels(body, 'dem')) {
      texture = this.cache.get(`${body}/dem/${width}`) ?? texture;
    }
    const level = texture?.mipmaps?.[0];
    if (!level) return null;
    const { data, width, height } = level;
    const u = 0.5 + Math.atan2(dir.z, -dir.x) / (2 * Math.PI);
    const v = 0.5 + Math.asin(Math.max(-1, Math.min(1, dir.y))) / Math.PI;

    // Bilinear, on texel centres, wrapping in longitude and clamping in
    // latitude exactly as the sampler is configured to.
    const x = u * width - 0.5;
    const y = v * height - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const wrap = (i) => ((i % width) + width) % width;
    const clampRow = (j) => Math.max(0, Math.min(height - 1, j));
    const at = (i, j) => fromHalf(data[clampRow(j) * width + wrap(i)]);
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  }

  /** Best tier already resident, or null. */
  best(body, kind) {
    const near = this.cache.get(`${body}/${kind}/near`);
    if (near) return { texture: near, tier: 'near', info: this.entry(body, kind, 'near') };
    const far = this.cache.get(`${body}/${kind}/far`);
    if (far) return { texture: far, tier: 'far', info: this.entry(body, kind, 'far') };
    return null;
  }

  /**
   * Decodes a packed elevation PNG into a single-channel half-float texture of
   * kilometres.
   *
   * The delivered file splits each 16-bit height across two 8-bit channels,
   * which no hardware filter can touch: averaging a high byte with a low byte
   * invents kilometre cliffs. Unpacking to half-float buys back mipmapping, and
   * that is what lets the vertex shader ask for elevation at the resolution its
   * own tessellation can carry. Sampling the full-resolution map with quads
   * kilometres wide, as the packed form forced, corrugates distant terrain into
   * stripes.
   */
  async loadElevation(body, tier) {
    const key = `${body}/dem/${tier}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const entry = this.entry(body, 'dem', tier);
    if (!entry || this.pending.has(key)) return null;
    this.pending.add(key);

    try {
      const response = await fetch(`${this.basePath}${entry.file}`);
      const bitmap = await createImageBitmap(await response.blob());
      const { width, height } = bitmap;
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, width, height).data;
      bitmap.close();

      const { scaleKm = 1, offsetKm = 0 } = entry;
      let heights = new Float32Array(width * height);
      let minKm = Infinity;
      let maxKm = -Infinity;
      for (let i = 0; i < heights.length; i++) {
        const raw = (pixels[i * 4] << 8) | pixels[i * 4 + 1];
        const km = raw * scaleKm + offsetKm;
        if (km < minKm) minKm = km;
        if (km > maxKm) maxKm = km;
        heights[i] = km;
      }

      // The mip chain is built here rather than by the driver: a single-channel
      // half-float texture is not colour-renderable, so generateMipmap does
      // nothing for it, and every request for a coarser level silently returned
      // full resolution. Terrain then sampled elevation far finer than its
      // vertices could carry and corrugated into ridges wherever it was seen at
      // a shallow angle.
      const mipmaps = [];
      let w = width;
      let h = height;
      while (true) {
        const level = new Uint16Array(heights.length);
        for (let i = 0; i < heights.length; i++) level[i] = toHalf(heights[i]);
        mipmaps.push({ data: level, width: w, height: h });
        if (w === 1 && h === 1) break;

        const nw = Math.max(1, w >> 1);
        const nh = Math.max(1, h >> 1);
        const next = new Float32Array(nw * nh);
        for (let y = 0; y < nh; y++) {
          const y0 = Math.min(y * 2, h - 1);
          const y1 = Math.min(y * 2 + 1, h - 1);
          for (let x = 0; x < nw; x++) {
            const x0 = Math.min(x * 2, w - 1);
            const x1 = Math.min(x * 2 + 1, w - 1);
            next[y * nw + x] =
              (heights[y0 * w + x0] +
                heights[y0 * w + x1] +
                heights[y1 * w + x0] +
                heights[y1 * w + x1]) *
              0.25;
          }
        }
        heights = next;
        w = nw;
        h = nh;
      }

      const texture = new DataTexture(mipmaps[0].data, width, height, RedFormat, HalfFloatType);
      texture.mipmaps = mipmaps;
      texture.wrapS = RepeatWrapping;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.magFilter = LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      texture.userData.reliefKm = [minKm, maxKm];
      this.cache.set(key, texture);
      return texture;
    } catch {
      return null;
    } finally {
      this.pending.delete(key);
    }
  }

  load(body, kind, tier) {
    if (kind === 'dem') return this.loadElevation(body, tier);
    const key = `${body}/${kind}/${tier}`;
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    const entry = this.entry(body, kind, tier);
    if (!entry) return Promise.resolve(null);
    if (this.pending.has(key)) return Promise.resolve(null);
    this.pending.add(key);

    return new Promise((resolve) => {
      this.loader.load(
        `${this.basePath}${entry.file}`,
        (texture) => {
          // Equirectangular maps wrap in longitude and clamp in latitude; the
          // default clamp on both axes leaves a seam down the prime meridian.
          texture.wrapS = RepeatWrapping;
          texture.minFilter = LinearMipmapLinearFilter;
          texture.magFilter = LinearFilter;
          texture.generateMipmaps = true;
          // Surfaces are seen at extreme grazing angles near the limb, where
          // anisotropic filtering is the difference between detail and moire.
          texture.anisotropy = this.anisotropy;
          // Photographic maps are stored sRGB-encoded. Left unflagged they are
          // read as if linear, which brightens every midtone by more than a stop
          // and washes surfaces out towards white.
          if (kind !== 'norm') texture.colorSpace = SRGBColorSpace;
          this.cache.set(key, texture);
          this.pending.delete(key);
          resolve(texture);
        },
        undefined,
        () => {
          this.pending.delete(key);
          resolve(null);
        },
      );
    });
  }

  /** Widths of the available levels of a width-keyed kind, coarsest first. */
  levels(body, kind) {
    const levels = this.manifest?.[body]?.[kind];
    if (!levels) return [];
    return Object.keys(levels)
      .map(Number)
      .sort((a, b) => a - b);
  }

  /**
   * Finest resident level no finer than `wanted`, and a request for the level
   * that was actually wanted so the next frames can improve. Handing back
   * something coarse immediately is what keeps approach smooth instead of flat
   * until a download lands.
   */
  level(body, kind, wanted) {
    const levels = this.levels(body, kind);
    if (!levels.length) return null;

    const target = levels.reduce(
      (best, width) => (width <= wanted || best === null ? width : best),
      null,
    );
    if (!this.cache.has(`${body}/${kind}/${target}`)) this.load(body, kind, String(target));

    let resident = null;
    for (const width of levels) {
      if (width > target) break;
      const texture = this.cache.get(`${body}/${kind}/${width}`);
      if (texture) resident = { texture, info: this.entry(body, kind, String(width)) };
    }
    return resident;
  }

  demLevels(body) {
    return this.levels(body, 'dem');
  }

  demLevel(body, wanted) {
    return this.level(body, 'dem', wanted);
  }

  /** Everything a body needs at the small tier. */
  async loadFar(body) {
    const kinds = Object.keys(this.manifest?.[body] ?? {});
    const results = {};
    await Promise.all(
      kinds.map(async (kind) => {
        if (kind === 'dem' || kind === 'norm') {
          // Only the coarsest level up front; the rest arrive on approach.
          const coarsest = this.levels(body, kind)[0];
          results[kind] = await this.load(body, kind, String(coarsest));
          results[`${kind}Info`] = this.entry(body, kind, String(coarsest));
          return;
        }
        results[kind] = await this.load(body, kind, this.entry(body, kind, 'far') ? 'far' : 'near');
      }),
    );
    return results;
  }

  /** Kicks off the large tier; resolves immediately if already loading. */
  ensureNear(body, kinds) {
    const list = kinds ?? Object.keys(this.manifest?.[body] ?? {});
    return Promise.all(list.map((kind) => this.load(body, kind, 'near')));
  }
}
