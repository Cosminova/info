import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Points,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import { buildColorLookup } from './color.js';

// log2(10^0.4): converts a magnitude difference into a base-2 flux exponent.
const MAG_TO_LOG2_FLUX = 1.3287712;

const STAR_VERTEX = /* glsl */ `
  attribute float magnitude;
  attribute vec3 starColor;

  uniform float limitMagnitude;
  uniform float exposure;
  uniform float pixelRatio;
  uniform float coreSize;
  uniform float sizeExponent;
  uniform float maxSize;
  uniform float hdrKnee;
  uniform float gain;
  uniform float extinction;     // magnitudes of extinction at zenith, 0 = vacuum
  uniform float twinkle;        // 0 = no atmosphere
  uniform float time;
  uniform float spikeThreshold;
  uniform float spikeStrength;
  uniform float horizonCut;     // 1 = hide everything below the horizon

  varying vec3 vColor;
  varying float vSpike;
  varying float vSizePx;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vec3 dir = normalize(worldPos.xyz);
    float sinAlt = dir.y;

    float mag = magnitude;

    if (extinction > 0.0) {
      // Pickering (2002) airmass, finite through and below the horizon.
      float altDeg = degrees(asin(clamp(sinAlt, -1.0, 1.0)));
      float h = max(altDeg, -2.0);
      float am = 1.0 / sin(radians(h + 244.0 / (165.0 + 47.0 * pow(max(h, 0.0) + 0.001, 1.1))));
      am = clamp(am, 1.0, 40.0);
      mag += extinction * (am - 1.0);
    }

    float rel = limitMagnitude - mag;
    float intensity = exp2(rel * ${MAG_TO_LOG2_FLUX}) * exposure;

    if (twinkle > 0.0) {
      // Scintillation grows towards the horizon as the light path lengthens.
      float lowSky = clamp(1.0 - max(sinAlt, 0.0), 0.0, 1.0);
      float amp = twinkle * (0.18 + 0.82 * lowSky * lowSky);
      float phase = dot(position, vec3(37.13, 61.72, 91.37)) * 12.9898;
      float n =
        sin(time * 8.7 + phase) * 0.5 +
        sin(time * 15.3 + phase * 1.73) * 0.3 +
        sin(time * 24.1 + phase * 2.91) * 0.2;
      intensity *= max(0.05, 1.0 + amp * n);
    }

    // Soft ceiling keeps Sirius blazing without letting bloom swallow the frame.
    intensity = intensity / (1.0 + intensity / hdrKnee);

    // Fade in over roughly a magnitude so stars never pop into existence.
    float visibility = smoothstep(-1.15, 0.3, rel);
    if (horizonCut > 0.5) {
      visibility *= smoothstep(-0.035, 0.01, sinAlt);
    }
    intensity *= visibility;

    // The sprite only has to be large enough to hold the star's visible wings;
    // the core itself is a fixed number of pixels across (see the fragment
    // shader), which is what keeps bright stars looking like intense points
    // rather than inflated fuzzy discs.
    float sizePx = clamp(coreSize * pow(max(intensity, 1e-4), sizeExponent), coreSize, maxSize);

    vColor = starColor * intensity * gain;
    vSizePx = sizePx;
    vSpike = smoothstep(spikeThreshold, spikeThreshold * 10.0, intensity) * spikeStrength;

    gl_PointSize = sizePx * pixelRatio;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const STAR_FRAGMENT = /* glsl */ `
  uniform float coreSigma;   // radius of the diffraction core, in pixels

  varying vec3 vColor;
  varying float vSpike;
  varying float vSizePx;

  void main() {
    vec2 pc = (gl_PointCoord - 0.5) * 2.0;
    float d2 = dot(pc, pc);
    if (d2 > 1.0) discard;
    float d = sqrt(d2);

    // Work in pixels, not in sprite-relative units. A real star image has a
    // core whose width is set by optics and seeing, so it stays the same size
    // for every star; only the surrounding halo reaches further out as the
    // star gets brighter.
    float radiusPx = vSizePx * 0.5;
    float dPx = d * radiusPx;

    float core = exp(-(dPx * dPx) / (2.0 * coreSigma * coreSigma));
    float halo = exp(-dPx / 1.35) * 0.30;
    float wing = exp(-dPx / max(radiusPx * 0.42, 0.6)) * 0.045;
    float psf = core + halo + wing;

    float spikes = 0.0;
    if (vSpike > 0.0) {
      vec2 a = abs(pc);
      float horiz = exp(-a.y * a.y * 300.0) * pow(max(0.0, 1.0 - a.x), 2.2);
      float vert = exp(-a.x * a.x * 300.0) * pow(max(0.0, 1.0 - a.y), 2.2);
      vec2 r = abs(vec2(pc.x + pc.y, pc.x - pc.y)) * 0.70710678;
      float diag =
        exp(-r.y * r.y * 340.0) * pow(max(0.0, 1.0 - r.x), 2.6) +
        exp(-r.x * r.x * 340.0) * pow(max(0.0, 1.0 - r.y), 2.6);
      spikes = (horiz + vert + diag * 0.5) * vSpike;
    }

    float edge = 1.0 - smoothstep(0.82, 1.0, d);
    gl_FragColor = vec4(vColor * (psf + spikes) * edge, 1.0);
  }
`;

function createStarMaterial(maxPointSize) {
  return new ShaderMaterial({
    uniforms: {
      limitMagnitude: { value: 6.2 },
      exposure: { value: 1 },
      pixelRatio: { value: 1 },
      coreSize: { value: 2.6 },
      coreSigma: { value: 0.72 },
      sizeExponent: { value: 0.22 },
      maxSize: { value: maxPointSize },
      hdrKnee: { value: 140 },
      gain: { value: 0.05 },
      extinction: { value: 0 },
      twinkle: { value: 0 },
      time: { value: 0 },
      spikeThreshold: { value: 55 },
      spikeStrength: { value: 0.06 },
      horizonCut: { value: 0 },
    },
    vertexShader: STAR_VERTEX,
    fragmentShader: STAR_FRAGMENT,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
}

/** Largest index with magnitude <= value, assuming ascending order. */
function countBrighterThan(magnitudes, value) {
  let lo = 0;
  let hi = magnitudes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (magnitudes[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Renders the real catalogue plus an optional synthetic faint population.
 *
 * The catalogue is complete to roughly magnitude 10, so once deep zoom pushes
 * the limiting magnitude past that the view would look unnaturally empty. The
 * synthetic layer fills in magnitudes 10.5-17 with a realistic luminosity
 * function and Milky Way concentration so deep zoom keeps revealing structure.
 */
export class StarField {
  constructor({ catalog, maxPointSize = 90, faintCount = 600000, colorSaturation = 0.85 }) {
    this.colorLookup = buildColorLookup(1024, colorSaturation);
    this.material = createStarMaterial(maxPointSize);

    this.catalogMagnitudes = catalog.magnitude;
    this.catalogPositions = catalog.position;
    this.catalogColorIndex = catalog.colorIndex;
    this.catalogDistance = catalog.distanceParsec;

    this.catalogPoints = this._buildPoints(
      catalog.position,
      catalog.magnitude,
      catalog.colorIndex,
    );
    this.catalogPoints.name = 'stars-catalog';

    this.faint = faintCount > 0 ? this._buildFaintPopulation(faintCount) : null;
    if (this.faint) this.faint.points.name = 'stars-synthetic';

    this.objects = [this.catalogPoints, ...(this.faint ? [this.faint.points] : [])];
  }

  _buildPoints(positions, magnitudes, colorIndex) {
    const count = magnitudes.length;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.colorLookup.sample(colorIndex[i], colors, i * 3);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('magnitude', new BufferAttribute(magnitudes, 1));
    geometry.setAttribute('starColor', new BufferAttribute(colors, 3));
    // Every star sits on the unit sphere, so the bounds are known up front.
    // Pinning them skips a 120k-point pass and keeps depth sorting happy.
    geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), 1.001);
    geometry.computeBoundingSphere = () => {};
    geometry.setDrawRange(0, 0);

    const points = new Points(geometry, this.material);
    points.frustumCulled = false;
    points.renderOrder = 10;
    return points;
  }

  /**
   * Synthetic faint stars: uniform sphere sampling weighted by galactic
   * latitude and bulge proximity, magnitudes drawn from N(<m) proportional to
   * 10^(0.32 m).
   */
  _buildFaintPopulation(count) {
    const MAG_START = 10.4;
    const MAG_END = 17.0;
    const SLOPE = 0.32;

    const random = mulberry32(0x5eed1);
    const positions = new Float32Array(count * 3);
    const magnitudes = new Float32Array(count);

    // Galactic centre direction in world coordinates, for bulge weighting.
    const gcRa = 266.405 * (Math.PI / 180);
    const gcDec = -28.936 * (Math.PI / 180);
    const gcx = Math.cos(gcDec) * Math.cos(gcRa);
    const gcy = Math.sin(gcDec);
    const gcz = -Math.cos(gcDec) * Math.sin(gcRa);

    // North galactic pole, so |dot| gives sin(galactic latitude) directly.
    const ngpRa = 192.85948 * (Math.PI / 180);
    const ngpDec = 27.12825 * (Math.PI / 180);
    const npx = Math.cos(ngpDec) * Math.cos(ngpRa);
    const npy = Math.sin(ngpDec);
    const npz = -Math.cos(ngpDec) * Math.sin(ngpRa);

    let written = 0;
    let guard = 0;
    while (written < count && guard < count * 60) {
      guard++;
      // Uniform direction on the sphere.
      const u = random() * 2 - 1;
      const phi = random() * Math.PI * 2;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      const x = s * Math.cos(phi);
      const y = u;
      const z = s * Math.sin(phi);

      const sinB = Math.abs(x * npx + y * npy + z * npz);
      const bDeg = Math.asin(Math.min(1, sinB)) * (180 / Math.PI);
      let weight = 0.08 + 0.92 * Math.exp(-bDeg / 15);

      const cosGc = x * gcx + y * gcy + z * gcz;
      const gcDeg = Math.acos(Math.min(1, Math.max(-1, cosGc))) * (180 / Math.PI);
      weight *= 1 + 1.1 * Math.exp(-gcDeg / 32);

      if (random() * 2.2 > weight) continue;

      positions[written * 3] = x;
      positions[written * 3 + 1] = y;
      positions[written * 3 + 2] = z;
      written++;
    }

    const span = Math.pow(10, SLOPE * (MAG_END - MAG_START)) - 1;
    for (let i = 0; i < written; i++) {
      const r = random();
      magnitudes[i] = MAG_START + Math.log10(1 + r * span) / SLOPE;
    }
    const used = magnitudes.subarray(0, written);
    used.sort();

    // Faint field stars skew towards cool dwarfs.
    const colorIndex = new Float32Array(written);
    for (let i = 0; i < written; i++) {
      colorIndex[i] = 0.35 + 1.35 * Math.pow(random(), 0.65);
    }

    const points = this._buildPoints(
      positions.subarray(0, written * 3),
      used,
      colorIndex,
    );
    return { points, magnitudes: used, count: written };
  }

  /** Keeps fragment cost proportional to what is actually visible. */
  update({ limitMagnitude, exposure, pixelRatio, time, atmosphere }) {
    const u = this.material.uniforms;
    u.limitMagnitude.value = limitMagnitude;
    u.exposure.value = exposure;
    u.pixelRatio.value = pixelRatio;
    u.time.value = time;
    u.extinction.value = atmosphere ? atmosphere.extinction : 0;
    u.twinkle.value = atmosphere ? atmosphere.twinkle : 0;
    u.horizonCut.value = atmosphere ? 1 : 0;

    const cutoff = limitMagnitude + 0.35;
    this.catalogPoints.geometry.setDrawRange(
      0,
      countBrighterThan(this.catalogMagnitudes, cutoff),
    );
    if (this.faint) {
      this.faint.points.geometry.setDrawRange(
        0,
        countBrighterThan(this.faint.magnitudes, cutoff),
      );
    }
  }

  setFaintVisible(visible) {
    if (this.faint) this.faint.points.visible = visible;
  }

  setSpikes(strength) {
    this.material.uniforms.spikeStrength.value = strength;
  }

  setStyle({ coreSize, gain, hdrKnee }) {
    const u = this.material.uniforms;
    if (coreSize !== undefined) u.coreSize.value = coreSize;
    if (gain !== undefined) u.gain.value = gain;
    if (hdrKnee !== undefined) u.hdrKnee.value = hdrKnee;
  }

  get visibleCount() {
    let n = this.catalogPoints.geometry.drawRange.count;
    if (this.faint && this.faint.points.visible) {
      n += this.faint.points.geometry.drawRange.count;
    }
    return n;
  }
}
