import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import { equatorialToVector } from './astro.js';

const QUAD = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);

const VERTEX = /* glsl */ `
  uniform vec3 center;        // unit direction in the sky frame
  uniform float shellRadius;
  uniform float halfExtent;   // angular half-size of the quad, radians

  varying vec2 vUv;
  varying vec3 vWorld;

  void main() {
    vec3 world = (modelMatrix * vec4(center * shellRadius, 1.0)).xyz;
    vWorld = world;
    vec4 viewCenter = viewMatrix * vec4(world, 1.0);
    vec3 viewPos = viewCenter.xyz + vec3(position.xy * halfExtent * shellRadius, 0.0);
    vUv = position.xy;
    gl_Position = projectionMatrix * vec4(viewPos, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 bodyColor;
  uniform float discFraction;   // disc radius as a fraction of the quad half-size
  uniform float discRadiance;   // surface brightness of the lit disc
  uniform float glare;          // peak radiance of the PSF halo
  uniform vec2 sunScreenDir;    // unit screen direction towards the Sun
  uniform float sunDepth;       // component of the sun direction along the view axis
  uniform float phaseEnabled;
  uniform float surfaceDetail;  // 0 = smooth, 1 = show procedural maria
  uniform float ringInner;
  uniform float ringOuter;
  uniform float ringSinTilt;
  uniform vec2 ringAxis;
  uniform float extinctionScale;
  uniform float horizonFade;
  uniform float showDisc;

  varying vec2 vUv;
  varying vec3 vWorld;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.03;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    float quadR = length(vUv);
    if (quadR > 1.0) discard;

    vec3 color = vec3(0.0);

    // --- glare: the same point-spread profile the stars use, so a planet at
    // --- low zoom is indistinguishable in character from a bright star.
    float g = quadR / max(discFraction, 1e-5);
    float psf = exp(-g * g * 0.6) + exp(-g * 1.6) * 0.09 + exp(-g * 0.5) * 0.012;
    color += bodyColor * glare * psf;

    if (showDisc > 0.5) {
      vec2 dUv = vUv / max(discFraction, 1e-5);
      float d = length(dUv);

      // --- rings (Saturn) ---
      if (ringOuter > 0.0) {
        vec2 axis = normalize(ringAxis);
        vec2 perp = vec2(-axis.y, axis.x);
        vec2 ringUv = vec2(dot(dUv, axis), dot(dUv, perp));
        float r = length(vec2(ringUv.x, ringUv.y / max(abs(ringSinTilt), 0.035)));
        if (r > ringInner && r < ringOuter) {
          float band = smoothstep(ringInner, ringInner + 0.08, r) *
                       (1.0 - smoothstep(ringOuter - 0.12, ringOuter, r));
          // Cassini division.
          band *= 1.0 - 0.75 * exp(-pow((r - 1.95) / 0.06, 2.0));
          float nearSide = ringUv.y * sign(ringSinTilt);
          bool hiddenByPlanet = d < 1.0 && nearSide < 0.0;
          if (!hiddenByPlanet) {
            color += bodyColor * discRadiance * band * 0.55;
          }
        }
      }

      if (d < 1.0) {
        float z = sqrt(max(0.0, 1.0 - d * d));
        vec3 normal = vec3(dUv, z);
        vec3 lightDir = normalize(vec3(sunScreenDir * sqrt(max(0.0, 1.0 - sunDepth * sunDepth)), sunDepth));
        // Surface relief makes the terminator ragged instead of a clean arc,
        // which is most of what sells a magnified crescent.
        float relief = surfaceDetail > 0.0 ? (fbm(dUv * 9.0 + 4.1) - 0.5) * 0.07 : 0.0;
        float lambert = phaseEnabled > 0.5 ? max(0.0, dot(normal, lightDir) + relief) : 1.0;
        // Soften the terminator so it does not alias into a hard staircase.
        lambert = smoothstep(0.0, 0.09, lambert) * lambert;
        float limb = 0.62 + 0.38 * pow(z, 0.45);

        float albedo = 1.0;
        if (surfaceDetail > 0.0) {
          // Broad low-contrast plains plus fine speckle. Tighter contrast here
          // made the Moon look like a cloudy planet rather than dark maria on
          // bright highlands.
          float m = fbm(dUv * 2.1 + 11.3);
          float maria = smoothstep(0.40, 0.70, m);
          float speckle = (fbm(dUv * 16.0) - 0.5) * 0.10;
          albedo = mix(1.0, 0.70, maria * surfaceDetail) + speckle * surfaceDetail;
        }

        float edge = 1.0 - smoothstep(0.985, 1.0, d);
        color += bodyColor * discRadiance * lambert * limb * albedo * edge;
      }
    }

    color *= extinctionScale;
    if (horizonFade > 0.5) {
      color *= smoothstep(-0.03, 0.02, normalize(vWorld).y);
    }

    gl_FragColor = vec4(color, 1.0);
  }
`;

// Saturn's ring plane pole, J2000 equatorial.
const SATURN_POLE_RA = 40.589;
const SATURN_POLE_DEC = 83.537;

// Soft ceiling on point-source flux, matched to the star field's own knee so a
// planet and a star of equal magnitude render with equal intensity.
const POINT_KNEE = 140;
// Calibrates the compressed surface-brightness response for resolved discs.
const SURFACE_GAIN = 0.085;

// `padding` is how much larger the sprite is than the disc, leaving room for
// the glare halo. `minPixels` matches the star core radius so an unresolved
// planet is indistinguishable from a star of the same brightness.
const BODY_STYLE = {
  sun: { padding: 26, phase: false, detail: 0, minPixels: 1.4 },
  moon: { padding: 5.5, phase: true, detail: 1, minPixels: 1.4 },
  mercury: { padding: 12, phase: true, detail: 0.25, minPixels: 1.3 },
  venus: { padding: 16, phase: true, detail: 0, minPixels: 1.3 },
  mars: { padding: 12, phase: true, detail: 0.5, minPixels: 1.3 },
  jupiter: { padding: 10, phase: true, detail: 0.2, minPixels: 1.3 },
  saturn: { padding: 12, phase: true, detail: 0.12, minPixels: 1.3 },
  uranus: { padding: 10, phase: true, detail: 0, minPixels: 1.3 },
  neptune: { padding: 10, phase: true, detail: 0, minPixels: 1.3 },
};

function createBodyMesh(key) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(QUAD, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  const material = new ShaderMaterial({
    uniforms: {
      center: { value: new Vector3(1, 0, 0) },
      shellRadius: { value: 80 },
      halfExtent: { value: 0.01 },
      bodyColor: { value: new Vector3(1, 1, 1) },
      discFraction: { value: 0.2 },
      discRadiance: { value: 1 },
      glare: { value: 1 },
      sunScreenDir: { value: new Vector2(1, 0) },
      sunDepth: { value: 0 },
      phaseEnabled: { value: 1 },
      surfaceDetail: { value: 0 },
      ringInner: { value: 0 },
      ringOuter: { value: 0 },
      ringSinTilt: { value: 0.4 },
      ringAxis: { value: new Vector2(1, 0) },
      extinctionScale: { value: 1 },
      horizonFade: { value: 0 },
      showDisc: { value: 1 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    blending: AdditiveBlending,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  mesh.name = `body-${key}`;
  return mesh;
}

/**
 * Sun, Moon and planets. Each body is one small billboard that blends a
 * point-spread glare with a shaded disc, so the same object reads as a bright
 * "star" at wide field and resolves into a phase-lit sphere as you zoom in.
 */
export class SolarSystemLayer {
  constructor({ shellRadius = 80 } = {}) {
    this.shellRadius = shellRadius;
    this.meshes = new Map();
    this.objects = [];
    this.state = [];

    for (const key of Object.keys(BODY_STYLE)) {
      const mesh = createBodyMesh(key);
      mesh.material.uniforms.shellRadius.value = shellRadius;
      this.meshes.set(key, mesh);
      this.objects.push(mesh);
    }

    this._dir = new Vector3();
    this._sunDir = new Vector3();
    this._tmp = new Vector3();
    this._ringPole = new Vector3();
  }

  setVisible(visible) {
    for (const mesh of this.meshes.values()) mesh.visible = visible;
  }

  /**
   * @param options.ephemeris result of solarSystemAt()
   * @param options.skyMatrix sky container matrix (equatorial -> world)
   * @param options.camera live perspective camera
   */
  update({
    ephemeris,
    limitMagnitude,
    surfaceRefMagnitude,
    radPerPixel,
    camera,
    skyMatrix,
    atmosphere,
    showSun = true,
    skip = null,
  }) {
    this.state = [];
    const viewMatrix = camera.matrixWorldInverse;

    // Geocentric positions in AU, needed for real terminator orientation.
    const positions = new Map();
    for (const body of ephemeris.bodies) {
      const dir = equatorialToVector(body.ra, body.dec, new Vector3());
      positions.set(body.key, dir.clone().multiplyScalar(body.distanceAu));
      body._dir = dir;
    }
    const sunPosition = positions.get('sun');

    for (const body of ephemeris.bodies) {
      const mesh = this.meshes.get(body.key);
      if (!mesh) continue;
      const style = BODY_STYLE[body.key];
      const u = mesh.material.uniforms;

      if (body.key === 'sun' && !showSun) {
        mesh.visible = false;
        continue;
      }

      // Magnified far enough that real geometry has taken this body over. The
      // sprite carries no detail the terrain does not, and drawing both would
      // put a flat shaded circle over the surface.
      if (skip?.has(body.key)) {
        mesh.visible = false;
        continue;
      }

      // Point-like flux tracks the current depth (a bigger aperture really does
      // make a point source brighter); surface flux is referenced to a fixed
      // magnitude, because magnification never raises surface brightness.
      const fluxPoint = Math.pow(2, (limitMagnitude - body.magnitude) * 1.3287712);
      const fluxSurface = Math.pow(2, (surfaceRefMagnitude - body.magnitude) * 1.3287712);
      if (fluxPoint < 0.02) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;

      // The disc never shrinks below about a star's core, otherwise a faint
      // planet would disappear into sub-pixel geometry at wide field.
      const minRadius = radPerPixel * style.minPixels;
      const discRadius = Math.max(body.angularRadius, minRadius);
      let halfExtent = discRadius * style.padding;
      if (body.key === 'saturn') halfExtent = Math.max(halfExtent, discRadius * 3.2);

      u.center.value.copy(body._dir);
      u.halfExtent.value = halfExtent;
      u.discFraction.value = discRadius / halfExtent;
      u.bodyColor.value.set(body.color[0], body.color[1], body.color[2]);
      u.surfaceDetail.value = style.detail;
      u.phaseEnabled.value = style.phase ? 1 : 0;
      u.showDisc.value = 1;

      const kneed = fluxPoint / (1 + fluxPoint / POINT_KNEE);
      const resolved = body.angularRadius > radPerPixel * 2.5;

      if (resolved) {
        // The Moon and Venus are millions of times brighter per unit area than
        // a threshold star, so linear surface brightness clips to flat white.
        // A fourth-root response keeps their relative order while leaving
        // shading, phase and limb darkening visible at the default exposure.
        const arcminRadius = body.angularRadius * 3437.7468;
        const rawSurface = fluxSurface / Math.max(Math.PI * arcminRadius * arcminRadius, 1e-4);
        const radiance = Math.pow(Math.max(rawSurface, 0), 0.25) * SURFACE_GAIN;
        u.discRadiance.value = radiance;
        // Tie the halo to the disc rather than to the raw flux. Driving it from
        // flux made the Moon's glare brighter than the Moon, which washed the
        // whole frame to white.
        u.glare.value = radiance * 0.12;
      } else {
        // Unresolved: behave exactly like a star of the same magnitude.
        u.discRadiance.value = kneed * 0.05;
        u.glare.value = kneed * 0.05;
      }

      // Sun direction relative to the body, expressed in view space, drives
      // both the terminator angle and how much of the lit side faces us.
      if (style.phase && sunPosition) {
        const bodyPosition = positions.get(body.key);
        this._sunDir.copy(sunPosition).sub(bodyPosition).normalize();
        // Direction vectors: rotate by the sky matrix, then into view space.
        this._tmp
          .copy(this._sunDir)
          .transformDirection(skyMatrix)
          .transformDirection(viewMatrix);
        // The disc normal is built with +Z out of the screen, which is exactly
        // view space's +Z, so the sun direction is used with its sign intact.
        const depth = this._tmp.z;
        const planar = Math.hypot(this._tmp.x, this._tmp.y) || 1e-6;
        u.sunScreenDir.value.set(this._tmp.x / planar, this._tmp.y / planar);
        u.sunDepth.value = Math.max(-1, Math.min(1, depth));
      } else {
        u.sunDepth.value = 1;
      }

      if (body.key === 'saturn') {
        equatorialToVector(SATURN_POLE_RA, SATURN_POLE_DEC, this._ringPole);
        const pole = this._ringPole
          .clone()
          .transformDirection(skyMatrix)
          .transformDirection(viewMatrix);
        // Ring opening: how far the pole is tipped away from the line of sight.
        const sinTilt = Math.max(-1, Math.min(1, -pole.z));
        u.ringSinTilt.value = sinTilt;
        // Major axis lies along the projected ring plane, perpendicular to the
        // projected pole.
        const planar = Math.hypot(pole.x, pole.y) || 1e-6;
        u.ringAxis.value.set(-pole.y / planar, pole.x / planar);
        u.ringInner.value = 1.24;
        u.ringOuter.value = 2.27;
      }

      if (atmosphere) {
        const altitudeSin = this._dir
          .copy(body._dir)
          .transformDirection(skyMatrix).y;
        const altitudeDeg = Math.asin(Math.max(-1, Math.min(1, altitudeSin))) * (180 / Math.PI);
        const h = Math.max(altitudeDeg, -2);
        const am = Math.min(
          40,
          1 /
            Math.sin(
              ((h + 244 / (165 + 47 * Math.pow(Math.max(h, 0) + 0.001, 1.1))) * Math.PI) / 180,
            ),
        );
        u.extinctionScale.value = Math.pow(2, -atmosphere.extinction * (am - 1) * 1.3287712);
        u.horizonFade.value = 1;
      } else {
        u.extinctionScale.value = 1;
        u.horizonFade.value = 0;
      }

      this.state.push(body);
    }
  }
}
