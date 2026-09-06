import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import { galacticToEquatorial } from '../astro.js';
import { equatorialToEcliptic, KPC_KM, MPC_KM, PC_KM } from './units.js';
import { platform } from './platform.js';

const MAG_TO_LOG2_FLUX = 1.3287712;

// A galaxy narrower than this many pixels is not drawn, fading in over the gap
// to the second figure. This is only about aliasing — a sub-pixel disc can
// only be a flickering white dot — so it is set as low as it can be while
// still doing that, which also spares the fill of a few thousand quads that
// were never visible.
const GALAXY_MIN_PX = 2;
const GALAXY_FULL_PX = 6;

const STAR_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float absMag;
  attribute vec3 starColor;

  uniform float limitMagnitude;
  uniform float exposure;
  uniform float pixelRatio;
  uniform float coreSize;
  uniform float sizeExponent;
  uniform float maxSize;
  uniform float hdrKnee;
  uniform float gain;
  uniform float hideInsideKm;

  varying vec3 vColor;
  varying float vSizePx;

  void main() {
    float dist = length(position);
    if (dist < hideInsideKm) {
      gl_PointSize = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vColor = vec3(0.0);
      return;
    }

    float distPc = max(dist / 3.085677581e13, 1e-8);
    float mag = absMag + 5.0 * log(distPc) / log(10.0) - 5.0;
    float rel = limitMagnitude - mag;
    float intensity = exp2(rel * ${MAG_TO_LOG2_FLUX}) * exposure;
    intensity = intensity / (1.0 + intensity / hdrKnee);
    float visibility = smoothstep(-1.15, 0.3, rel);
    intensity *= visibility;

    float sizePx = clamp(coreSize * pow(max(intensity, 1e-4), sizeExponent), 1.2, maxSize);
    vColor = starColor * intensity * gain;
    vSizePx = sizePx;
    gl_PointSize = sizePx * pixelRatio;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const STAR_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float coreSigma;
  varying vec3 vColor;
  varying float vSizePx;

  void main() {
    vec2 pc = (gl_PointCoord - 0.5) * 2.0;
    float d2 = dot(pc, pc);
    if (d2 > 1.0) discard;
    float d = sqrt(d2);
    float radiusPx = vSizePx * 0.5;
    float dPx = d * radiusPx;
    float core = exp(-(dPx * dPx) / (2.0 * coreSigma * coreSigma));
    // A wider, stronger skirt than the bare core had. The glow around a bright
    // star is most of what the eye reads its brightness from, and without it
    // every star in the field was the same two-pixel dot whatever its
    // magnitude — a scatter of identical specks rather than a sky with an
    // order to it.
    float halo = exp(-dPx / 1.15) * 0.26;
    float wing = exp(-dPx / max(radiusPx * 0.34, 0.5)) * 0.04;
    // No diffraction spikes here, deliberately. The sky view draws them, but
    // its sprites reach ninety pixels; the knee that keeps this field's
    // brightest star inside a nine-pixel sprite leaves the arms nowhere to go,
    // so they cost a branch per star and render as nothing.
    float edge = 1.0 - smoothstep(0.82, 1.0, d);
    gl_FragColor = vec4(vColor * (core + halo + wing) * edge, 1.0);
    #include <logdepthbuf_fragment>
  }
`;

const GALAXY_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 iOffset;
  attribute vec3 iAxisU;
  attribute vec3 iAxisV;
  attribute vec2 iSize;
  attribute vec3 iColor;
  attribute vec3 iParams;

  uniform float uPxPerRad;
  uniform vec2 uSizeGate;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAspect;
  varying float vMorph;
  varying float vSeed;
  varying float vLum;
  varying float vFade;
  varying float vPx;

  void main() {
    vUv = position.xy;
    vColor = iColor;
    vAspect = iSize.y / max(iSize.x, 1.0);
    vMorph = iParams.x;
    vSeed = iParams.y;
    vLum = iParams.z;

    // How wide this disc lands on screen. The fragment stage needs this to
    // size its detail in pixels rather than in fractions of the quad, and a
    // disc thinner than a pixel or two has nothing to draw but an aliased
    // white dot, so it is dropped: the catalogue holds nearly four thousand
    // galaxies and from outside the Milky Way almost all of them are that
    // small.
    vPx = 2.0 * length(iAxisU) * uPxPerRad / max(length(iOffset), 1.0);
    vFade = smoothstep(uSizeGate.x, uSizeGate.y, vPx);
    if (vFade <= 0.0) {
      // Off the clip volume entirely, so the quad costs no fragments.
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec3 world = iOffset + iAxisU * position.x + iAxisV * position.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const GALAXY_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAspect;
  varying float vMorph;
  varying float vSeed;
  varying float vLum;
  varying float vFade;
  varying float vPx;

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }
  float fbm(vec2 p) {
    float a = 0.0;
    float w = 0.5;
    for (int i = 0; i < 4; i++) {
      a += w * noise(p);
      p *= 2.07;
      w *= 0.5;
    }
    return a;
  }

  void main() {
    vec2 q = vUv;
    float aspect = max(vAspect, 0.08);
    vec2 p = q;
    p.y /= aspect;
    float r = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x);
    float edgeOn = 1.0 - smoothstep(0.18, 0.55, aspect);
    float n = fbm(p * 5.5 + vSeed * 8.0);

    float elliptical = 1.0 - smoothstep(0.4, 1.4, vMorph);
    float spiral = smoothstep(0.8, 2.2, vMorph) * (1.0 - smoothstep(5.4, 6.2, vMorph));
    float barred = smoothstep(3.4, 4.2, vMorph) * (1.0 - smoothstep(5.4, 6.1, vMorph));
    float irregular = smoothstep(5.4, 6.0, vMorph);

    float nucleus = exp(-r * r * 280.0);
    float bulge = exp(-pow(r * 8.5, 0.9));
    float disc = exp(-r * 2.15) * (0.48 + 0.52 * n);

    float arms = 0.0;
    float pitch = mix(6.5, 11.5, smoothstep(2.0, 3.5, vMorph));
    for (int k = 0; k < 2; k++) {
      float a = ang + float(k) * 3.14159265 + r * pitch + vSeed * 6.2831853;
      float ridge = exp(-pow(sin(a), 2.0) * mix(14.0, 9.0, smoothstep(2.0, 3.5, vMorph)));
      arms += ridge * exp(-r * 1.55);
    }
    arms *= spiral * (1.0 - edgeOn * 0.85);
    disc *= mix(1.0, 0.38 + 0.9 * arms, spiral * (1.0 - edgeOn));

    float bar = exp(-p.y * p.y * 55.0) * exp(-p.x * p.x * 3.2)
      * (1.0 - smoothstep(0.32, 0.55, r)) * barred * (1.0 - edgeOn);

    float dustLane = exp(-pow(q.y * mix(8.0, 42.0, edgeOn), 2.0)) * exp(-r * 1.4);
    float dust = dustLane * mix(0.18, 0.72, edgeOn) + arms * 0.22 * (1.0 - edgeOn);
    float clumps = pow(n, 3.0) * disc * mix(0.15, 1.4, irregular);

    vec3 bulgeCol = vec3(1.00, 0.76, 0.48);
    vec3 discCol = mix(vec3(0.55, 0.52, 0.45), vec3(0.38, 0.55, 0.82), spiral);
    vec3 armCol = vec3(0.40, 0.68, 0.95);
    vec3 hii = vec3(0.85, 0.28, 0.36);

    vec3 colour = vec3(0.0);
    colour += bulgeCol * nucleus * 0.28;
    colour += bulgeCol * bulge * mix(0.18, 0.07, spiral);
    colour += discCol * disc * mix(0.16, 0.07, elliptical);
    colour += armCol * arms * 0.1;
    colour += bulgeCol * bar * 0.1;
    colour += hii * clumps * 0.05;
    colour *= 1.0 - dust * 0.55;
    colour *= vColor * vLum;

    // Invented field stars, in cells sized to stay a pixel or two wide however
    // close the disc is. A fixed 260 cells across the quad grew with it: from
    // inside a galaxy, with the billboard covering the sky, every lit cell was
    // a hard white slab a dozen pixels across, all tilted to the disc's
    // position angle. That is the field of white marks reported around the
    // Magellanic Clouds, and it is the same grid at every distance.
    float cells = clamp(vPx * 0.31, 80.0, 5000.0);
    float speckle = hash21(floor(p * cells) + vSeed * 17.0);
    // Nearer still, the host-star particle layer draws this galaxy's stars for
    // real, so the painted ones bow out instead of competing with them.
    float painted = 1.0 - smoothstep(900.0, 2600.0, vPx);
    float fieldStars = step(0.987, speckle) * pow(speckle, 6.0) * exp(-r * 1.15) * painted;
    colour += vec3(0.92, 0.94, 1.0) * fieldStars * mix(0.35, 0.9, spiral);

    float edge = 1.0 - smoothstep(0.86, 1.0, r);
    colour *= edge * vFade;
    if (dot(colour, vec3(0.3, 0.5, 0.2)) < 0.0004) discard;
    gl_FragColor = vec4(colour, 1.0);
    #include <logdepthbuf_fragment>
  }
`;

const MW_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 starColor;
  uniform float opacity;
  uniform float pixelRatio;
  varying vec3 vColor;
  void main() {
    vColor = starColor * opacity;
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = clip;
    gl_PointSize = 1.15 * pixelRatio;
    #include <logdepthbuf_vertex>
  }
`;

const MW_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec3 vColor;
  void main() {
    vec2 pc = (gl_PointCoord - 0.5) * 2.0;
    float d = dot(pc, pc);
    if (d > 1.0) discard;
    gl_FragColor = vec4(vColor * (1.0 - d), 1.0);
    #include <logdepthbuf_fragment>
  }
`;

const HOST_STAR_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 local;
  attribute vec3 starColor;
  uniform vec3 uCenter;
  uniform vec3 uU;
  uniform vec3 uV;
  uniform vec3 uN;
  uniform float uOpacity;
  uniform float pixelRatio;
  varying vec3 vColor;
  void main() {
    vec3 pos = uCenter + uU * local.x + uV * local.y + uN * local.z;
    vColor = starColor * uOpacity;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    float bulge = exp(-dot(local.xy, local.xy) * 3.5);
    gl_PointSize = (1.7 + bulge * 2.2) * pixelRatio;
    #include <logdepthbuf_vertex>
  }
`;

const HOST_STAR_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec3 vColor;
  void main() {
    vec2 pc = (gl_PointCoord - 0.5) * 2.0;
    float d2 = dot(pc, pc);
    if (d2 > 1.0) discard;
    float core = exp(-d2 * 4.2);
    gl_FragColor = vec4(vColor * core, 1.0);
    #include <logdepthbuf_fragment>
  }
`;

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

function morphColour(morph = '') {
  const m = morph.toUpperCase();
  if (m.startsWith('E') || m.startsWith('S0')) return [1.0, 0.82, 0.58];
  if (m.includes('IRR') || m.startsWith('IB') || m.startsWith('I')) return [0.7, 0.78, 0.92];
  if (m.startsWith('SB') || m.startsWith('SA')) return [0.78, 0.8, 0.88];
  return [0.82, 0.8, 0.78];
}

function morphCode(morph = '') {
  const m = morph.toUpperCase();
  if (m.startsWith('E')) return 0;
  if (m.startsWith('S0') || m.startsWith('L')) return 1;
  if (m.includes('SB')) {
    if (m.includes('C') || m.includes('D') || m.includes('M')) return 5;
    return 4;
  }
  if (m.startsWith('S') || m.startsWith('SA')) {
    if (m.includes('C') || m.includes('D') || m.includes('M')) return 3;
    return 2;
  }
  if (m.includes('IRR') || m.startsWith('I')) return 6;
  return 2.2;
}

function hashId(id = '') {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

const _los = new Vector3();
const _north = new Vector3();
const _east = new Vector3();
const _major = new Vector3();
const _minor = new Vector3();

function galaxyDiscAxes(los, paDeg, aMaj, aMin, flip) {
  _los.copy(los).normalize();
  _north.set(0, 1, 0);
  equatorialToEcliptic(_north);
  _north.addScaledVector(_los, -_north.dot(_los));
  if (_north.lengthSq() < 1e-10) _north.set(0, 0, 1);
  _north.normalize();
  _east.crossVectors(_los, _north).normalize();
  const pa = ((paDeg ?? 0) * Math.PI) / 180;
  const c = Math.cos(pa);
  const s = Math.sin(pa);
  _major.copy(_north).multiplyScalar(c).addScaledVector(_east, s).normalize();
  const cosI = Math.max(0.08, Math.min((aMin ?? aMaj * 0.35) / Math.max(aMaj, 1e-6), 0.97));
  const sinI = Math.sqrt(Math.max(0, 1 - cosI * cosI)) * (flip ? -1 : 1);
  _minor
    .copy(_north)
    .multiplyScalar(-s)
    .addScaledVector(_east, c)
    .multiplyScalar(cosI)
    .addScaledVector(_los, sinI)
    .normalize();
  return { major: _major, minor: _minor };
}

/**
 * The sky beyond the solar system: catalogue stars at true heliocentric
 * distance, galaxies as elliptical billboards, and a particle stand-in for
 * the Milky Way that appears once you have backed far enough to see the disc
 * from outside.
 */
export class DeepField {
  constructor({ catalog, galaxies, colorLookup, maxPointSize = 90 }) {
    this.count = catalog.count;
    this.world = new Float64Array(catalog.count * 3);
    this.relative = new Float32Array(catalog.count * 3);
    this.absMag = new Float32Array(catalog.count);

    const pos = catalog.position;
    const dist = catalog.distanceParsec;
    const mag = catalog.magnitude;
    const tmp = new Vector3();
    for (let i = 0; i < catalog.count; i++) {
      let pc = dist[i];
      if (!(pc > 0) || pc > 5e4) pc = 1e4;
      tmp.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      const len = tmp.length() || 1;
      tmp.multiplyScalar((pc * PC_KM) / len);
      equatorialToEcliptic(tmp);
      this.world[i * 3] = tmp.x;
      this.world[i * 3 + 1] = tmp.y;
      this.world[i * 3 + 2] = tmp.z;
      this.absMag[i] = mag[i] - 5 * Math.log10(Math.max(pc, 1e-6)) + 5;
    }

    const colors = new Float32Array(catalog.count * 3);
    for (let i = 0; i < catalog.count; i++) {
      colorLookup.sample(catalog.colorIndex[i], colors, i * 3);
    }

    this.starMaterial = new ShaderMaterial({
      uniforms: {
        limitMagnitude: { value: 8 },
        exposure: { value: 1 },
        pixelRatio: { value: 1 },
        coreSize: { value: 2.1 },
        coreSigma: { value: 0.62 },
        // Size spread across magnitude. At 0.18 a first-magnitude star and a
        // tenth-magnitude one differed by about a pixel, which is why the field
        // read as uniform grain: the brightness hierarchy the catalogue carries
        // was there in the data and nowhere on screen.
        sizeExponent: { value: 0.27 },
        maxSize: { value: Math.min(maxPointSize, 46) },
        // Room above the knee for the bright end to actually be bright.
        hdrKnee: { value: 190 },
        gain: { value: 0.05 },
        hideInsideKm: { value: 2e7 },
      },
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      blending: AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      transparent: true,
    });

    const starGeom = new BufferGeometry();
    this.relAttr = new BufferAttribute(this.relative, 3);
    this.relAttr.setUsage(35048);
    starGeom.setAttribute('position', this.relAttr);
    starGeom.setAttribute('absMag', new BufferAttribute(this.absMag, 1));
    starGeom.setAttribute('starColor', new BufferAttribute(colors, 3));
    starGeom.computeBoundingSphere = () => {};
    this.stars = new Points(starGeom, this.starMaterial);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = 2;
    this.stars.frustumCulled = false;

    this.galaxies = this._buildGalaxies(galaxies);
    this.milkyWay = this._buildMilkyWay();
    this.hostStars = this._buildHostStars();

    this.objects = [this.milkyWay.points, this.galaxies.mesh, this.stars, this.hostStars.points];
    this._tmp = new Vector3();
    this._lastCam = new Vector3(NaN, NaN, NaN);
  }

  _buildGalaxies(payload) {
    const list = payload?.galaxies ?? [];
    this.galaxyRecords = list;
    const count = list.length;
    const offsets = new Float32Array(count * 3);
    const sizes = new Float32Array(count * 2);
    const colors = new Float32Array(count * 3);
    const params = new Float32Array(count * 3);
    const axisU = new Float32Array(count * 3);
    const axisV = new Float32Array(count * 3);
    this.galaxyWorld = new Float64Array(count * 3);
    this.galaxySizeKm = new Float32Array(count);
    this.galaxyAxisU = axisU;
    this.galaxyAxisV = axisV;
    const tmp = new Vector3();

    for (let i = 0; i < count; i++) {
      const g = list[i];
      const distKm = g.d * MPC_KM;
      tmp.set(g.p[0], g.p[1], g.p[2]);
      const len = tmp.length() || 1;
      tmp.multiplyScalar(distKm / len);
      equatorialToEcliptic(tmp);
      this.galaxyWorld[i * 3] = tmp.x;
      this.galaxyWorld[i * 3 + 1] = tmp.y;
      this.galaxyWorld[i * 3 + 2] = tmp.z;
      const majRad = ((g.aMaj ?? 0.1) * Math.PI) / 180;
      const minRad = ((g.aMin ?? g.aMaj * 0.4) * Math.PI) / 180;
      const majKm = Math.tan(majRad / 2) * distKm * 2;
      const minKm = Math.tan(minRad / 2) * distKm * 2;
      this.galaxySizeKm[i] = Math.max(majKm, 1e10);
      sizes[i * 2] = Math.max(majKm * 0.82, 1);
      sizes[i * 2 + 1] = Math.max(minKm * 0.82, 1);
      tmp.set(this.galaxyWorld[i * 3], this.galaxyWorld[i * 3 + 1], this.galaxyWorld[i * 3 + 2]);
      const { major, minor } = galaxyDiscAxes(tmp, g.pa ?? 0, g.aMaj ?? 0.1, g.aMin, hashId(g.id) > 0.5);
      axisU[i * 3] = major.x * sizes[i * 2];
      axisU[i * 3 + 1] = major.y * sizes[i * 2];
      axisU[i * 3 + 2] = major.z * sizes[i * 2];
      axisV[i * 3] = minor.x * sizes[i * 2 + 1];
      axisV[i * 3 + 1] = minor.y * sizes[i * 2 + 1];
      axisV[i * 3 + 2] = minor.z * sizes[i * 2 + 1];
      const c = morphColour(g.morph);
      colors[i * 3] = c[0];
      colors[i * 3 + 1] = c[1];
      colors[i * 3 + 2] = c[2];
      // Surface brightness, not total magnitude: a bright nearby galaxy is
      // large and faint, not a white floodlight. Mag only trims the distant
      // ones so the sky is not tiled with equally bright smudges.
      const mag = g.mag ?? 12;
      const lum = 0.22 * Math.min(1.0, Math.pow(10, -0.12 * Math.max(mag - 3.5, 0)));
      params[i * 3] = morphCode(g.morph);
      params[i * 3 + 1] = hashId(g.id);
      params[i * 3 + 2] = Math.max(0.12, Math.min(0.32, lum));
    }

    const plane = new PlaneGeometry(2, 2);
    const geometry = new InstancedBufferGeometry();
    geometry.index = plane.index;
    geometry.setAttribute('position', plane.attributes.position);
    geometry.setAttribute('uv', plane.attributes.uv);
    this.galaxyOffsetAttr = new InstancedBufferAttribute(offsets, 3);
    this.galaxyOffsetAttr.setUsage(35048);
    geometry.setAttribute('iOffset', this.galaxyOffsetAttr);
    geometry.setAttribute('iAxisU', new InstancedBufferAttribute(axisU, 3));
    geometry.setAttribute('iAxisV', new InstancedBufferAttribute(axisV, 3));
    geometry.setAttribute('iSize', new InstancedBufferAttribute(sizes, 2));
    geometry.setAttribute('iColor', new InstancedBufferAttribute(colors, 3));
    geometry.setAttribute('iParams', new InstancedBufferAttribute(params, 3));
    geometry.instanceCount = count;

    const material = new ShaderMaterial({
      uniforms: {
        uPxPerRad: { value: 600 },
        // Nothing below the first figure is drawn; between the two it fades in.
        // Both are apparent widths in CSS pixels.
        uSizeGate: { value: new Vector2(GALAXY_MIN_PX, GALAXY_FULL_PX) },
      },
      vertexShader: GALAXY_VERTEX,
      fragmentShader: GALAXY_FRAGMENT,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // A galaxy has no back. These are single quads carrying the disc's real
      // orientation, and the default front-face culling meant each one was
      // invisible from one entire hemisphere — which never showed up while they
      // were specks on the sky seen only from Earth, and is ruinous once you can
      // fly to them, because half of every approach arrives at nothing at all.
      side: DoubleSide,
    });
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    this.galaxyMaterial = material;
    return { mesh, offsets, sizes, count };
  }

  _buildMilkyWay() {
    const count = platform.milkyWayParticles;
    const random = mulberry32(0x4d696c6b);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const tmp = new Vector3();
    const sunGc = 8.178;

    for (let i = 0; i < count; i++) {
      const bulge = random() < 0.18;
      let x;
      let y;
      let z;
      if (bulge) {
        const u = random() * 2 - 1;
        const v = random() * 2 - 1;
        const w = random() * 2 - 1;
        const r = Math.pow(random(), 0.55) * 1.6;
        x = u * r;
        y = v * r;
        z = w * r * 0.55;
      } else {
        const R = -3.5 * Math.log(Math.max(random(), 1e-6));
        const theta = random() * Math.PI * 2;
        x = R * Math.cos(theta);
        y = R * Math.sin(theta);
        z = (random() + random() + random() - 1.5) * 0.22 * Math.exp(-R / 4);
        const arm = Math.floor(random() * 4);
        const a = theta + arm * (Math.PI / 2) + R * 0.55;
        x = R * Math.cos(a);
        y = R * Math.sin(a);
      }
      const helioX = x + sunGc;
      const helioY = y;
      const helioZ = z + 0.02;
      const r = Math.hypot(helioX, helioY, helioZ) || 1;
      const l = (Math.atan2(helioY, helioX) * 180) / Math.PI;
      const b = (Math.asin(clamp(helioZ / r, -1, 1)) * 180) / Math.PI;
      const { ra, dec } = galacticToEquatorial(l, b);
      const cd = Math.cos((dec * Math.PI) / 180);
      tmp.set(
        cd * Math.cos((ra * Math.PI) / 180),
        Math.sin((dec * Math.PI) / 180),
        -cd * Math.sin((ra * Math.PI) / 180),
      );
      equatorialToEcliptic(tmp);
      tmp.multiplyScalar(r * KPC_KM);
      positions[i * 3] = tmp.x;
      positions[i * 3 + 1] = tmp.y;
      positions[i * 3 + 2] = tmp.z;

      const warm = bulge ? 0.55 : 0.15;
      colors[i * 3] = (0.55 + warm) * 0.55;
      colors[i * 3 + 1] = (0.62 + warm * 0.4) * 0.55;
      colors[i * 3 + 2] = (0.78 - warm * 0.35) * 0.55;
    }

    this.mwWorld = new Float64Array(count * 3);
    this.mwRelative = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) this.mwWorld[i] = positions[i];

    this.mwMaterial = new ShaderMaterial({
      uniforms: {
        opacity: { value: 0 },
        pixelRatio: { value: 1 },
      },
      vertexShader: MW_VERTEX,
      fragmentShader: MW_FRAGMENT,
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      transparent: true,
    });
    const geometry = new BufferGeometry();
    this.mwRelAttr = new BufferAttribute(this.mwRelative, 3);
    this.mwRelAttr.setUsage(35048);
    geometry.setAttribute('position', this.mwRelAttr);
    geometry.setAttribute('starColor', new BufferAttribute(colors, 3));
    geometry.computeBoundingSphere = () => {};
    const points = new Points(geometry, this.mwMaterial);
    points.frustumCulled = false;
    points.renderOrder = 0;
    points.visible = false;
    return { points, count };
  }

  _buildHostStars() {
    const count = platform.hostGalaxyStars;
    const random = mulberry32(0x53746172);
    const local = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const kind = random();
      let x;
      let y;
      let z;
      if (kind < 0.14) {
        const r = Math.pow(random(), 0.5) * 0.32;
        const th = random() * Math.PI * 2;
        const ph = Math.acos(random() * 2 - 1);
        x = r * Math.sin(ph) * Math.cos(th);
        y = r * Math.sin(ph) * Math.sin(th);
        z = r * Math.cos(ph) * 0.75;
      } else if (kind < 0.28) {
        const r = 0.35 + Math.pow(random(), 0.7) * 0.9;
        const th = random() * Math.PI * 2;
        const ph = Math.acos(random() * 2 - 1);
        x = r * Math.sin(ph) * Math.cos(th) * 0.7;
        y = r * Math.sin(ph) * Math.sin(th) * 0.7;
        z = r * Math.cos(ph) * 0.55;
      } else {
        const R = Math.min(-0.62 * Math.log(Math.max(random(), 1e-5)), 0.98);
        const arm = Math.floor(random() * 2);
        const theta = random() * Math.PI * 2 + arm * Math.PI + R * 8.5;
        x = R * Math.cos(theta);
        y = R * Math.sin(theta);
        z = (random() + random() + random() - 1.5) * 0.07 * Math.exp(-R * 1.2);
      }
      local[i * 3] = x;
      local[i * 3 + 1] = y;
      local[i * 3 + 2] = z;
      const Rxy = Math.hypot(x, y);
      const warm = kind < 0.14 ? 0.62 : Math.exp(-Rxy * 1.4) * 0.22;
      const bright = kind < 0.14 ? 0.85 + random() * 0.5 : 0.38 + random() * 0.7;
      colors[i * 3] = (0.95 + warm * 0.2) * bright;
      colors[i * 3 + 1] = (0.88 + warm * 0.05) * bright;
      colors[i * 3 + 2] = (0.82 + (1.0 - warm) * 0.4) * bright;
    }

    this.hostMaterial = new ShaderMaterial({
      uniforms: {
        uCenter: { value: new Vector3() },
        uU: { value: new Vector3() },
        uV: { value: new Vector3() },
        uN: { value: new Vector3() },
        uOpacity: { value: 0 },
        pixelRatio: { value: 1 },
      },
      vertexShader: HOST_STAR_VERTEX,
      fragmentShader: HOST_STAR_FRAGMENT,
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      transparent: true,
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('local', new BufferAttribute(local, 3));
    geometry.setAttribute('starColor', new BufferAttribute(colors, 3));
    geometry.computeBoundingSphere = () => {};
    const points = new Points(geometry, this.hostMaterial);
    points.frustumCulled = false;
    points.renderOrder = 3;
    points.visible = false;
    return { points, count };
  }

  /**
   * Writes camera-relative positions. Only the arrays that are currently
   * visible are touched, so a close-up of a crater does not rewrite 70k
   * galaxy-scale particles every frame.
   */
  update({
    cameraWorld, pixelRatio, sunDistanceKm, limitMagnitude = 7.0, gain,
    focusGalaxyIndex = -1, viewPxPerRad,
  }) {
    this.starMaterial.uniforms.pixelRatio.value = pixelRatio;
    this.starMaterial.uniforms.limitMagnitude.value = limitMagnitude;
    if (gain !== undefined) this.starMaterial.uniforms.gain.value = gain;
    this.mwMaterial.uniforms.pixelRatio.value = pixelRatio;
    this.hostMaterial.uniforms.pixelRatio.value = pixelRatio;
    // Zoom changes the field of view, so the size gate has to be told the
    // scale every frame rather than only on resize.
    if (viewPxPerRad > 0) this.galaxyMaterial.uniforms.uPxPerRad.value = viewPxPerRad;

    const cx = cameraWorld.x;
    const cy = cameraWorld.y;
    const cz = cameraWorld.z;

    const farFromSun = sunDistanceKm > 8 * KPC_KM;
    const rel = this.relative;
    const world = this.world;
    for (let i = 0, n = this.count; i < n; i++) {
      const i3 = i * 3;
      const wx = world[i3];
      const wy = world[i3 + 1];
      const wz = world[i3 + 2];
      if (farFromSun) {
        rel[i3] = wx;
        rel[i3 + 1] = wy;
        rel[i3 + 2] = wz;
      } else {
        rel[i3] = wx - cx;
        rel[i3 + 1] = wy - cy;
        rel[i3 + 2] = wz - cz;
      }
    }
    this.relAttr.needsUpdate = true;

    const go = this.galaxies.offsets;
    const gw = this.galaxyWorld;
    for (let i = 0, n = this.galaxies.count; i < n; i++) {
      const i3 = i * 3;
      go[i3] = gw[i3] - cx;
      go[i3 + 1] = gw[i3 + 1] - cy;
      go[i3 + 2] = gw[i3 + 2] - cz;
    }
    this.galaxyOffsetAttr.needsUpdate = true;

    const kpc = sunDistanceKm / KPC_KM;
    const mwFade = clamp((Math.log10(Math.max(kpc, 1e-6)) + 0.3) / 1.4, 0, 1);
    this.mwMaterial.uniforms.opacity.value = mwFade * 0.14;
    this.milkyWay.points.visible = mwFade > 0.02;
    if (this.milkyWay.points.visible) {
      const mw = this.mwRelative;
      const ww = this.mwWorld;
      for (let i = 0, n = this.milkyWay.count; i < n; i++) {
        const i3 = i * 3;
        mw[i3] = ww[i3] - cx;
        mw[i3 + 1] = ww[i3 + 1] - cy;
        mw[i3 + 2] = ww[i3 + 2] - cz;
      }
      this.mwRelAttr.needsUpdate = true;
    }

    let host = focusGalaxyIndex;
    if (!(host >= 0) || host >= this.galaxies.count) {
      host = -1;
      let best = Infinity;
      for (let i = 0; i < this.galaxies.count; i++) {
        const dx = gw[i * 3] - cx;
        const dy = gw[i * 3 + 1] - cy;
        const dz = gw[i * 3 + 2] - cz;
        const dist = Math.hypot(dx, dy, dz);
        const limit = this.galaxySizeKm[i] * 8;
        if (dist < limit && dist < best) {
          best = dist;
          host = i;
        }
      }
    }
    if (host >= 0) {
      const dx = gw[host * 3] - cx;
      const dy = gw[host * 3 + 1] - cy;
      const dz = gw[host * 3 + 2] - cz;
      const dist = Math.hypot(dx, dy, dz);
      const radius = this.galaxySizeKm[host] * 0.5;
      const fade = clamp((12 - dist / Math.max(radius, 1)) / 9, 0, 1);
      const u = this.hostMaterial.uniforms;
      u.uCenter.value.set(dx, dy, dz);
      u.uU.value.set(this.galaxyAxisU[host * 3], this.galaxyAxisU[host * 3 + 1], this.galaxyAxisU[host * 3 + 2]);
      u.uV.value.set(this.galaxyAxisV[host * 3], this.galaxyAxisV[host * 3 + 1], this.galaxyAxisV[host * 3 + 2]);
      u.uN.value
        .copy(u.uU.value)
        .cross(u.uV.value)
        .normalize()
        .multiplyScalar(this.galaxySizeKm[host] * 0.07);
      u.uOpacity.value = fade * 1.35;
      this.hostStars.points.visible = fade > 0.03;
    } else {
      this.hostStars.points.visible = false;
    }
  }

  galaxyAt(index) {
    const g = this.galaxyRecords[index];
    if (!g) return null;
    const i3 = index * 3;
    // The disc's normal, from the two axes the billboard is built on. A galaxy
    // is a flat thing carrying the orientation it has in the real sky, which is
    // fine to look at from Earth and a coin toss once you can fly to it: half
    // of all approaches arrive in the plane of the disc and see it edge-on as a
    // line. Handing the normal out lets the flight code arrive somewhere worth
    // arriving.
    const u = { x: this.galaxyAxisU[i3], y: this.galaxyAxisU[i3 + 1], z: this.galaxyAxisU[i3 + 2] };
    const v = { x: this.galaxyAxisV[i3], y: this.galaxyAxisV[i3 + 1], z: this.galaxyAxisV[i3 + 2] };
    const n = {
      x: u.y * v.z - u.z * v.y,
      y: u.z * v.x - u.x * v.z,
      z: u.x * v.y - u.y * v.x,
    };
    const len = Math.hypot(n.x, n.y, n.z) || 1;
    return {
      key: `gal:${g.id}`,
      name: g.name || g.id,
      kind: 'galaxy',
      radiusKm: this.galaxySizeKm[index] * 0.5,
      x: this.galaxyWorld[i3],
      y: this.galaxyWorld[i3 + 1],
      z: this.galaxyWorld[i3 + 2],
      normal: { x: n.x / len, y: n.y / len, z: n.z / len },
      record: g,
    };
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
