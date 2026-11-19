import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  FloatType,
  HalfFloatType,
  Mesh,
  NearestFilter,
  RedFormat,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import { CRATER_LACUNARITY } from './terrain-glsl.js';

/**
 * Procedural relief near the camera, built once and then read back.
 *
 * Standing on a cratered world, every pixel used to rebuild six octaves of
 * craters from scratch, every frame, at a cost of eighty milliseconds a frame on
 * the Moon. Almost none of that work changes from one frame to the next: the
 * ground does not move, only the eye does. So the relief is baked into a stack
 * of square textures centred under the camera, each covering twice the ground
 * of the one before at half the resolution, and the surface shader reads it
 * instead of computing it. Walking only exposes thin strips at the edges of each
 * level, so that is all that is rebuilt, and the textures wrap toroidally so
 * nothing already built has to move.
 *
 * Heights are kept, not just slopes, so that shadows come from marching the real
 * height field towards the sun. That replaces the per-crater rim test, and gives
 * every relief a shadow — a rim falling across the next crater, a hill across
 * the plain — rather than only a crater's own floor.
 */

export const CACHE_LEVELS = 12;
const CACHE_RES = 512;
// Texel of the finest level. Craters finer than a few of these are left to the
// per-pixel stones and soil.
const FINEST_KM = 0.00003;
// How far the eye may wander from the projection centre before the whole stack
// is re-centred. The lattice coordinates stay exact to a millimetre out to here.
const MAX_ANCHOR_ANGLE = 0.012;
// Texels rebuilt in one frame when whole levels are missing, so arriving at the
// ground costs a few slow frames rather than one long stall.
const FRAME_BUDGET = CACHE_RES * CACHE_RES + 1;
const ACTIVE_ALTITUDE_KM = 20;
const MAX_RECTS = CACHE_LEVELS * 5;
const CRATER_OCTAVE_SLOTS = 7;

export const CACHE_GLSL = /* glsl */ `
  const int CACHE_RES = ${CACHE_RES};
  const int CACHE_LEVELS = ${CACHE_LEVELS};
  uniform float uCacheOn;
  uniform sampler2D uCacheHeight;
  uniform sampler2D uCacheSlope;
  uniform vec3 uCacheA;
  uniform vec3 uCacheE;
  uniform vec3 uCacheN;
  // The eye, unsquashed, on (E, N, A), km.
  uniform vec3 uCacheEye;
  uniform float uCacheT0;
  uniform vec2 uCacheLow[CACHE_LEVELS];
  uniform float uCacheValid[CACHE_LEVELS];

  // Gnomonic coordinates about the anchor, radians. Taken from the offset to the
  // eye rather than from the direction, because a direction in single float is
  // ten centimetres coarse on the Moon and this has to resolve millimetres.
  vec2 cachePlane(vec3 rel) {
    vec3 p = rel / uAxisScale;
    vec3 proj = uCacheEye + vec3(dot(p, uCacheE), dot(p, uCacheN), dot(p, uCacheA));
    return proj.xy / proj.z;
  }

  float cacheTexel(int level) {
    return uCacheT0 * exp2(float(level));
  }

  // Distance from a level's centre, in half widths of that level.
  float cacheReach(vec2 g, int level) {
    vec2 s = g / cacheTexel(level) - (uCacheLow[level] + float(CACHE_RES) * 0.5);
    return max(abs(s.x), abs(s.y)) / (float(CACHE_RES) * 0.5);
  }

  bool cacheUsable(int level) {
    return level < CACHE_LEVELS && uCacheValid[level] > 0.5;
  }

  ivec2 cacheCell(vec2 world, int level) {
    vec2 k = mod(world, float(CACHE_RES));
    return ivec2(k) + ivec2(0, level * CACHE_RES);
  }

  // Filtered by hand: the levels share one texture and wrap, so the hardware
  // would blend across both the tile edges and the wrap seam.
  void cacheTaps(vec2 g, int level, out ivec2 a, out ivec2 b, out vec2 f) {
    vec2 s = g / cacheTexel(level) - 0.5;
    vec2 i0 = floor(s);
    f = s - i0;
    a = cacheCell(i0, level);
    b = cacheCell(i0 + 1.0, level);
  }

  float cacheHeight(vec2 g, int level) {
    ivec2 a;
    ivec2 b;
    vec2 f;
    cacheTaps(g, level, a, b, f);
    float h00 = texelFetch(uCacheHeight, a, 0).r;
    float h10 = texelFetch(uCacheHeight, ivec2(b.x, a.y), 0).r;
    float h01 = texelFetch(uCacheHeight, ivec2(a.x, b.y), 0).r;
    float h11 = texelFetch(uCacheHeight, b, 0).r;
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
  }

  // (slope along E, slope along N, bright marks, dark marks)
  vec4 cacheRelief(vec2 g, int level, out float height) {
    ivec2 a;
    ivec2 b;
    vec2 f;
    cacheTaps(g, level, a, b, f);
    ivec2 c10 = ivec2(b.x, a.y);
    ivec2 c01 = ivec2(a.x, b.y);
    height = mix(
      mix(texelFetch(uCacheHeight, a, 0).r, texelFetch(uCacheHeight, c10, 0).r, f.x),
      mix(texelFetch(uCacheHeight, c01, 0).r, texelFetch(uCacheHeight, b, 0).r, f.x),
      f.y
    );
    return mix(
      mix(texelFetch(uCacheSlope, a, 0), texelFetch(uCacheSlope, c10, 0), f.x),
      mix(texelFetch(uCacheSlope, c01, 0), texelFetch(uCacheSlope, b, 0), f.x),
      f.y
    );
  }

  /**
   * How much of the sun the relief hides, marching the cached heights towards
   * it. Steps grow geometrically and read coarser levels as they go, so the
   * march reaches kilometres in a couple of dozen fetches.
   */
  float cacheShadow(vec2 g, vec3 dir, float h0, vec2 slope, int level) {
    float sinEl = dot(uSunDir, dir);
    vec3 sunFlat = uSunDir - dir * sinEl;
    float cosEl = length(sunFlat);
    if (sinEl <= 0.0 || cosEl < 0.02) return 0.0;
    vec2 sun2 = vec2(dot(sunFlat, uCacheE), dot(sunFlat, uCacheN));
    sun2 /= max(length(sun2), 1e-9);
    float tanEl = sinEl / cosEl;
    // Ground turned away from the sun is unlit whatever stands in the way.
    if (dot(slope, sun2) / uRadius >= tanEl) return 0.0;

    float dist = cacheTexel(level) * 1.5;
    float clearance = 1e9;
    // The point's own height is re-read at whichever level the step reads, so
    // each comparison is between two heights built the same way. Coarser levels
    // carry fewer small craters and sit higher or lower by their depth, and
    // against a fine-level start that difference shadowed lit ground in a
    // speckle of texel-sized squares.
    int startLevel = -1;
    float start = h0;
    float bias = 0.0;
    // The sun is a disc, so the edge of a shadow is a penumbra its width.
    float sunSpread = uSunAngular / max(cosEl * cosEl, 0.05);
    // Each step reads a level with a texel about a thirtieth of the distance
    // gone. Coarser than that, at a low sun the terminator follows the bilinear
    // facets of the heights and the shadows come out in texel-sized squares.
    for (int k = 0; k < 30; k++) {
      vec2 q = g + sun2 * dist;
      int l = max(level, int(floor(log2(max(dist / (32.0 * uCacheT0), 1.0)))));
      if (l < CACHE_LEVELS && cacheReach(q, l) > 0.94) l += 1;
      if (!cacheUsable(l)) break;
      if (l != startLevel) {
        startLevel = l;
        start = l == level ? h0 : cacheHeight(g, l);
        // A texel's worth of slack, so a lit slope does not shadow itself
        // through the filtering of its own heights.
        bias = cacheTexel(l) * uRadius * 0.35;
      }
      float run = dist * uRadius;
      // Less the fall of the ground away from this point's horizon plane.
      // Past the first few steps the penumbra below is wider than half a texel
      // of slope, so the nearest texel does as well as four filtered ones.
      float ground = k < 6 ? cacheHeight(q, l)
        : texelFetch(uCacheHeight, cacheCell(floor(q / cacheTexel(l)), l), 0).r;
      float rise = ground - start - bias - run * run / (2.0 * uRadius);
      // Clearance in units of the penumbra, widened by how far this level's
      // filtered heights can be trusted at this distance.
      float spread = sunSpread + 0.5 * cacheTexel(l) / dist;
      clearance = min(clearance, (tanEl - rise / run) / spread);
      if (clearance < -1.0) break;
      dist *= 1.25;
    }
    return 1.0 - smoothstep(-1.0, 1.0, clearance);
  }
`;

function bakeFragment(chunks) {
  return /* glsl */ `
  precision highp float;
  uniform vec3 uSunDir;
  uniform float uSunAngular;
  ${chunks}
  ${CACHE_GLSL}

  layout(location = 1) out highp vec4 cacheSlopeOut;

  // The elevation map's texel under the anchor, whole and fractional, in double
  // from the CPU side.
  uniform vec2 uCacheDemBase;
  uniform vec2 uCacheDemFrac;

  /**
   * Measured elevation at the anchor plus delta, read to a fraction of a
   * millimetre. Through dirToUv the longitude and latitude are single floats,
   * which on a 4096-texel map of the Moon lands within sixty centimetres: a few
   * centimetres of random height on any slope, which is nothing to the eye and
   * everything to a low sun, which shadowed the ground in speckles.
   */
  float demHeightExact(vec3 delta) {
    if (uHasDem < 0.5) return 0.0;
    // Longitude is measured in the (-x, z) plane, latitude against its length.
    vec2 a = vec2(-uCacheA.x, uCacheA.z);
    vec2 d = vec2(-delta.x, delta.z);
    float dLon = atan(a.x * d.y - a.y * d.x, dot(a, a) + dot(a, d));
    float hA = length(a);
    float dh = (2.0 * dot(a, d) + dot(d, d)) / (length(a + d) + hA);
    float dLat = atan(hA * delta.y - uCacheA.y * dh, hA * (hA + dh) + uCacheA.y * (uCacheA.y + delta.y));

    ivec2 size = textureSize(uDemMap, 0);
    vec2 local = uCacheDemFrac + vec2(dLon / 6.2831853, dLat / 3.14159265) * vec2(size) - 0.5;
    vec2 whole = floor(local);
    vec2 f = local - whole;
    ivec2 c = ivec2(uCacheDemBase) + ivec2(whole);
    return mix(
      mix(texelAt(uDemMap, c, size).r, texelAt(uDemMap, c + ivec2(1, 0), size).r, f.x),
      mix(texelAt(uDemMap, c + ivec2(0, 1), size).r, texelAt(uDemMap, c + ivec2(1, 1), size).r, f.x),
      f.y
    );
  }

  void main() {
    vec2 px = floor(gl_FragCoord.xy);
    int level = int(px.y) / CACHE_RES;
    vec2 storage = vec2(px.x, px.y - float(level * CACHE_RES));
    vec2 low = uCacheLow[level];
    vec2 world = low + mod(storage - low, float(CACHE_RES));
    float t = cacheTexel(level);
    vec2 g = (world + 0.5) * t;

    // The offset from the anchor, kept apart from the anchor itself so the
    // crater lattice can be placed to well under a millimetre.
    float g2 = dot(g, g);
    float s = sqrt(1.0 + g2);
    vec3 delta = (g.x * uCacheE + g.y * uCacheN) / s - uCacheA * (g2 / (s * (1.0 + s)));
    vec3 dir = normalize(uCacheA + delta);
    gCraterDelta = delta;
    gCraterPrecise = 1.0;

    float shade;
    vec2 marks;
    float fracture;
    float fill;
    vec4 terrain = proceduralTerrain(dir, t, uSunDir, 0.0, shade, marks, fracture, fill);
    // Every level's texel is far finer than the elevation map's, so it is always
    // read at full resolution.
    float height = demHeightExact(delta) * uDemStrength + terrain.x;

    vec3 east = normalize(uCacheE - dir * dot(dir, uCacheE));
    vec3 north = normalize(uCacheN - dir * dot(dir, uCacheN));
    gl_FragColor = vec4(height, 0.0, 0.0, 1.0);
    cacheSlopeOut = vec4(dot(terrain.yzw, east), dot(terrain.yzw, north), marks);
  }
`;
}

const BAKE_VERTEX = /* glsl */ `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

function floatMod(x, m) {
  return x - m * Math.floor(x / m);
}

export class TerrainCache {
  /**
   * @param {object} options
   * @param {object} options.uniforms the surface material's uniforms; the cache's
   *   own are added to it, and the bake reads the same objects
   * @param {string} options.chunks GLSL that defines proceduralTerrain and demHeight
   * @param {number} options.radiusKm
   */
  constructor({ uniforms, chunks, radiusKm }) {
    this.radius = radiusKm;
    this.surface = uniforms;
    this.chunks = chunks;
    this.t0 = FINEST_KM / radiusKm;
    this.valid = new Array(CACHE_LEVELS).fill(false);
    this.low = Array.from({ length: CACHE_LEVELS }, () => new Vector2());
    this.anchored = false;
    this.signature = '';
    this.supported = null;

    this.uniforms = {
      uCacheOn: { value: 0 },
      uCacheHeight: { value: null },
      uCacheSlope: { value: null },
      uCacheA: { value: new Vector3(0, 1, 0) },
      uCacheE: { value: new Vector3(1, 0, 0) },
      uCacheN: { value: new Vector3(0, 0, 1) },
      uCacheEye: { value: new Vector3() },
      uCacheT0: { value: this.t0 },
      uCacheLow: { value: this.low },
      uCacheValid: { value: new Float32Array(CACHE_LEVELS) },
      uCraterOriginI: { value: Array.from({ length: CRATER_OCTAVE_SLOTS }, () => new Vector3()) },
      uCraterOriginF: { value: Array.from({ length: CRATER_OCTAVE_SLOTS }, () => new Vector3()) },
      uCacheDemBase: { value: new Vector2() },
      uCacheDemFrac: { value: new Vector2() },
    };
    Object.assign(uniforms, this.uniforms);

    this._eye = new Vector3();
    this._dir = new Vector3();
  }

  /** Which bodies the bake can stand in for: dry, cratered or worn, and nothing it does not store. */
  static suits(spec, uniforms) {
    return ((spec.craterOctaves ?? 0) > 0 || (spec.erosion ?? 0) > 0) &&
      !(uniforms.uSeaLevelKm.value > 0) &&
      !(uniforms.uHasOcean?.value > 0.5) &&
      !(uniforms.uFractureDepth?.value > 0.001) &&
      !(uniforms.uFloodCoverage?.value > 0.001) &&
      !((uniforms.uBanding?.value ?? 0) > 0.001);
  }

  invalidate() {
    this.valid.fill(false);
  }

  _ensure(renderer) {
    if (this.supported !== null) return this.supported;
    this.supported = renderer.capabilities.isWebGL2 !== false &&
      renderer.extensions.has('EXT_color_buffer_float');
    if (!this.supported) return false;

    const target = new WebGLRenderTarget(CACHE_RES, CACHE_RES * CACHE_LEVELS, {
      count: 2,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
    });
    const [height, slope] = target.textures;
    height.format = RedFormat;
    height.type = FloatType;
    slope.format = RGBAFormat;
    slope.type = HalfFloatType;
    this.target = target;
    this.uniforms.uCacheHeight.value = height;
    this.uniforms.uCacheSlope.value = slope;

    this.positions = new Float32Array(MAX_RECTS * 6 * 3);
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.material = new ShaderMaterial({
      uniforms: this.surface,
      vertexShader: BAKE_VERTEX,
      fragmentShader: bakeFragment(this.chunks),
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene = new Scene();
    this.scene.add(mesh);
    this.camera = new Camera();
    return true;
  }

  /** Re-centres the projection under the eye; everything baked so far is void. */
  _anchor(dir) {
    const u = this.uniforms;
    const a = u.uCacheA.value.copy(dir);
    const up = Math.abs(a.y) < 0.95 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
    const e = u.uCacheE.value.crossVectors(up, a).normalize();
    u.uCacheN.value.crossVectors(a, e).normalize();

    // Each crater octave's lattice point under the anchor, in double, split
    // into whole cells and a remainder. Frequencies follow the shader's own
    // single-float products so the lattice matches the one drawn further out.
    const s = this.surface;
    const seed = Math.fround(s.uSurfaceSeed.value);
    const craterSeed = [
      floatMod(Math.fround(seed * Math.fround(1.37)), 91),
      floatMod(Math.fround(seed * Math.fround(2.71)), 87),
      floatMod(Math.fround(seed * Math.fround(3.53)), 83),
    ];
    let freq = Math.fround(s.uCraterFreq.value);
    const lacunarity = Math.fround(CRATER_LACUNARITY);
    for (let i = 0; i < CRATER_OCTAVE_SLOTS; i++) {
      const whole = u.uCraterOriginI.value[i];
      const rest = u.uCraterOriginF.value[i];
      for (const [k, axis] of ['x', 'y', 'z'].entries()) {
        const value = a[axis] * freq + craterSeed[k];
        const cell = Math.floor(value);
        whole.setComponent(k, cell);
        rest.setComponent(k, value - cell);
      }
      freq = Math.fround(freq * lacunarity);
    }
    this.anchored = true;
    this.invalidate();
  }

  _signature() {
    const s = this.surface;
    const dem = s.uDem.value;
    return [
      s.uCraterOctaves.value, s.uCraterDepth.value, s.uCraterDensity.value, s.uRoughness.value,
      s.uDemStrength.value, s.uHasDem.value, s.uSurfaceSeed.value, s.uMacroRelief.value,
      s.uBasinDepth.value, s.uCraterFreq.value, s.uDemMap.value?.uuid ?? '',
      s.uErosion.value, s.uErosionFreq.value, s.uHighlandSplit.value, s.uHighlandMap.value?.uuid ?? '',
      dem[0], dem[1], dem[2], dem[3],
    ].join('|');
  }

  /**
   * Brings the stack up to date for this eye position and points the surface
   * shader at it. Called once per draw of the surface; repeat calls in a frame
   * find nothing to do.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {Vector3} eye camera in the surface mesh's frame, km
   */
  update(renderer, eye) {
    const u = this.uniforms;
    const scale = this.surface.uAxisScale.value;
    const p = this._eye.copy(eye).divide(scale);
    if (p.length() - this.radius > ACTIVE_ALTITUDE_KM || !this._ensure(renderer)) {
      u.uCacheOn.value = 0;
      return;
    }

    const signature = this._signature();
    if (signature !== this.signature) {
      this.signature = signature;
      this.invalidate();
    }
    const dir = this._dir.copy(p).normalize();
    if (!this.anchored || dir.angleTo(u.uCacheA.value) > MAX_ANCHOR_ANGLE) this._anchor(dir);

    const e = u.uCacheE.value;
    const n = u.uCacheN.value;
    const a = u.uCacheA.value;
    const image = this.surface.uDemMap.value?.image;
    if (image?.width) {
      const lon = Math.atan2(a.z, -a.x);
      const lat = Math.asin(Math.max(-1, Math.min(1, a.y)));
      const sx = (0.5 + lon / (2 * Math.PI)) * image.width;
      const sy = (0.5 + lat / Math.PI) * image.height;
      u.uCacheDemBase.value.set(Math.floor(sx), Math.floor(sy));
      u.uCacheDemFrac.value.set(sx - Math.floor(sx), sy - Math.floor(sy));
    }
    const pe = p.dot(e);
    const pn = p.dot(n);
    const pa = p.dot(a);
    u.uCacheEye.value.set(pe, pn, pa);
    const gx = pe / pa;
    const gy = pn / pa;

    const rects = [];
    let budget = FRAME_BUDGET;
    for (let level = 0; level < CACHE_LEVELS; level++) {
      const t = this.t0 * 2 ** level;
      const lowX = Math.round(gx / t) - CACHE_RES / 2;
      const lowY = Math.round(gy / t) - CACHE_RES / 2;
      const old = this.low[level];
      const y0 = level * CACHE_RES;

      if (this.valid[level]) {
        const dx = lowX - old.x;
        const dy = lowY - old.y;
        if (Math.abs(dx) > CACHE_RES / 4 || Math.abs(dy) > CACHE_RES / 4) {
          this.valid[level] = false;
        } else {
          // Newly exposed columns, full height, and rows, full width. A corner
          // both expose is built twice, which is cheaper than working it out.
          if (dx !== 0) {
            const from = dx > 0 ? old.x + CACHE_RES : lowX;
            this._pushWrapped(rects, from, Math.abs(dx), (x0, w) => [x0, y0, w, CACHE_RES]);
          }
          if (dy !== 0) {
            const from = dy > 0 ? old.y + CACHE_RES : lowY;
            this._pushWrapped(rects, from, Math.abs(dy), (s0, h) => [0, y0 + s0, CACHE_RES, h]);
          }
          old.set(lowX, lowY);
        }
      }
      if (!this.valid[level] && budget >= CACHE_RES * CACHE_RES) {
        budget -= CACHE_RES * CACHE_RES;
        rects.push([0, y0, CACHE_RES, CACHE_RES]);
        old.set(lowX, lowY);
        this.valid[level] = true;
      }
      u.uCacheValid.value[level] = this.valid[level] ? 1 : 0;
    }

    u.uCacheOn.value = this.valid.some(Boolean) ? 1 : 0;
    if (rects.length) this._draw(renderer, rects);
  }

  _pushWrapped(rects, worldStart, count, make) {
    const start = floatMod(worldStart, CACHE_RES);
    const first = Math.min(count, CACHE_RES - start);
    rects.push(make(start, first));
    if (count > first) rects.push(make(0, count - first));
  }

  _draw(renderer, rects) {
    const w = CACHE_RES;
    const h = CACHE_RES * CACHE_LEVELS;
    const pos = this.positions;
    let v = 0;
    for (const [x, y, rw, rh] of rects.slice(0, MAX_RECTS)) {
      const x0 = (x / w) * 2 - 1;
      const x1 = ((x + rw) / w) * 2 - 1;
      const y0 = (y / h) * 2 - 1;
      const y1 = ((y + rh) / h) * 2 - 1;
      for (const [px, py] of [[x0, y0], [x1, y0], [x1, y1], [x0, y0], [x1, y1], [x0, y1]]) {
        pos[v++] = px;
        pos[v++] = py;
        pos[v++] = 0;
      }
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.setDrawRange(0, v / 3);

    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previous);
    renderer.autoClear = autoClear;
  }
}
