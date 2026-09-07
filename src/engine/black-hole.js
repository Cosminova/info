import {
  AdditiveBlending,
  BackSide,
  Color,
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Sphere,
  SphereGeometry,
  Vector3,
} from 'three';
import { AU_KM, equatorialToEcliptic, PC_KM } from './units.js';
import { equatorialToVector } from '../astro.js';
import { platform } from './platform.js';
import { pointGlare } from './star.js';

/** Schwarzschild radius of one solar mass, km. */
export const RS_KM_PER_SOL = 2.953;

/**
 * Catalogued holes at measured sky positions. Masses set the event-horizon
 * size; the same mesh shader is used for a stellar-mass binary and for M87*.
 */
export const BLACK_HOLES = [
  {
    key: 'sgr-a',
    name: 'Sagittarius A*',
    ra: 266.41684,
    dec: -29.00781,
    distPc: 8178,
    massSol: 4.3e6,
    spin: 0.94,
    inclinationDeg: 74,
    jet: 0,
  },
  {
    key: 'cygnus-x1',
    name: 'Cygnus X-1',
    ra: 299.5903,
    dec: 35.20173,
    distPc: 2240,
    massSol: 21.2,
    spin: 0.97,
    inclinationDeg: 27,
    jet: 0,
  },
  {
    key: 'm87-star',
    name: 'M87*',
    ra: 187.70593,
    dec: 12.39112,
    distPc: 16.8e6,
    massSol: 6.5e9,
    spin: 0.9,
    inclinationDeg: 17,
    jet: 1,
  },
];

export function schwarzschildKm(massSol) {
  return RS_KM_PER_SOL * massSol;
}

export function blackHoleWorld(spec, out = new Vector3()) {
  equatorialToVector(spec.ra, spec.dec, out);
  equatorialToEcliptic(out);
  return out.multiplyScalar(spec.distPc * PC_KM);
}

const VOLUME_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

/**
 * The hole itself, ray-marched through the bounding sphere.
 *
 * The thing that makes a black hole look like a black hole is not the disk but
 * what the light bending does to it: the far side of the disk is lifted over
 * the top of the shadow and the near underside is folded up beneath it, so a
 * flat ring seen nearly edge-on reads as a bright arc wrapping a dark sphere.
 * That only appears if the rays are actually integrated, so they are — each one
 * followed as a null geodesic rather than pushed sideways by a fudge factor.
 *
 * For a Schwarzschild metric the shape of a photon path in Cartesian
 * coordinates obeys
 *
 *   a = -3/2 · h² · p / r⁵      with h = |p × v| conserved along the ray
 *
 * which is cheap — one cross product per ray, then two multiplies per step —
 * and correct enough to produce the photon ring at 1.5 rs without it having to
 * be drawn in by hand.
 */
const VOLUME_FRAGMENT = /* glsl */ `
  precision highp float;
  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uCameraLocal;
  uniform float uRs;
  uniform float uTime;
  uniform float uSpin;
  uniform float uJet;
  uniform float uBrightness;
  uniform float uCoreTempK;
  uniform float uRimTempK;

  varying vec3 vLocal;

  const float R_IN = 2.6;      // rs, inner edge of the disk
  const float R_OUT = 24.0;    // rs, outer edge
  const float BOUND = 55.0;    // rs, the mesh this is drawn on

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

  /**
   * The same, repeating every "period" cells across x.
   *
   * The disk's structure is sampled in azimuth, and azimuth wraps: where atan
   * comes back round it jumps from +pi to -pi, and an ordinary lattice returns
   * a different cell either side of a line that is not there. It showed as a
   * seam running straight out from the shadow across every ring, the one place
   * the disk did not look like one piece. Wrapping the lattice instead of the
   * coordinate keeps the bands continuous all the way round, and leaves the
   * pattern free to shear with the orbital motion.
   */
  float ringNoise(vec2 p, float period) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float x0 = mod(i.x, period);
    float x1 = mod(i.x + 1.0, period);
    return mix(
      mix(hash(vec2(x0, i.y)), hash(vec2(x1, i.y)), f.x),
      mix(hash(vec2(x0, i.y + 1.0)), hash(vec2(x1, i.y + 1.0)), f.x),
      f.y);
  }

  /**
   * Colour of a blackbody at a given temperature. Helland's fit to the
   * Planckian locus, which holds from about 1000 K to 40000 K.
   */
  vec3 blackbody(float kelvin) {
    float t = clamp(kelvin, 1000.0, 40000.0) / 100.0;
    float r = t <= 66.0 ? 255.0 : 329.7 * pow(t - 60.0, -0.1332);
    float g = t <= 66.0 ? 99.47 * log(t) - 161.1 : 288.1 * pow(t - 60.0, -0.0755);
    float b = t >= 66.0 ? 255.0 : (t <= 19.0 ? 0.0 : 138.5 * log(t - 10.0) - 305.0);
    return clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
  }

  /**
   * Disk emission at one crossing.
   *
   * Temperature follows the standard thin-disk profile, falling off as the
   * three-quarter power of radius. Where that profile starts is set by the
   * hole's mass, and it is the only reason two holes look different from each
   * other: a stellar-mass disk runs hot enough to be blue-white from its inner
   * edge to its rim, while a supermassive one is cool enough to keep amber at
   * the outside. See the temperatures worked out in the constructor.
   */
  vec3 diskColour(float rho) {
    float ramp = pow(clamp(R_IN / max(rho, R_IN), 0.0, 1.0), 0.75);
    float kelvin = mix(uRimTempK, uCoreTempK, ramp);
    // Hotter annuli are brighter too. Stefan-Boltzmann's fourth power would
    // leave nothing visible but the innermost ring, so this is much gentler.
    return blackbody(kelvin) * (0.75 + 0.85 * pow(ramp, 0.5));
  }

  void main() {
    float rs = uRs;
    vec3 ro = uCameraLocal / rs;         // everything in units of rs
    vec3 rd = normalize(vLocal - uCameraLocal);

    // Start at the camera when it is already inside the bounding sphere, and at
    // the near intersection when it is outside. Getting this wrong is invisible
    // from a distance and hides the entire disk from close up, because the ray
    // begins on the far side and marches away.
    float bDot = dot(ro, rd);
    float disc = bDot * bDot - (dot(ro, ro) - BOUND * BOUND);
    if (disc < 0.0) discard;
    float root = sqrt(disc);
    float tStart = max(-bDot - root, 0.0);
    vec3 p = ro + rd * tStart;

    // Conserved along the geodesic, so it is computed once rather than per step.
    float h2 = dot(cross(p, rd), cross(p, rd));

    vec3 colour = vec3(0.0);
    float alpha = 0.0;
    bool captured = false;

    for (int i = 0; i < ${platform.blackHoleSteps}; i++) {
      float r = length(p);
      if (r < 1.0) { captured = true; break; }
      if (r > BOUND * 1.2 && dot(p, rd) > 0.0) break;

      // Short steps where the path curves, long ones where it does not. A fixed
      // step either misses the photon ring or spends a hundred iterations
      // crossing empty space to reach it.
      float step = clamp(0.055 * r * r / max(r - 0.9, 0.35), 0.035, 1.6);
      vec3 next = p + rd * step;
      rd = normalize(rd - 1.5 * h2 * p / pow(dot(p, p), 2.5) * step);

      // Disk crossing, found by the sign change of the height above its plane.
      if (p.y * next.y < 0.0) {
        vec3 hit = mix(p, next, p.y / (p.y - next.y));
        float rho = length(hit.xz);
        if (rho > R_IN && rho < R_OUT) {
          float phi = atan(hit.z, hit.x);
          // Keplerian shear: the inner disk laps the outer one, which is what
          // stops the pattern from turning as a rigid wheel.
          float omega = 0.7 / pow(rho, 1.5);
          float u = phi / 6.2831853 + uTime * omega;
          float bands = ringNoise(vec2(u * 26.0, rho * 1.7), 26.0) * 0.55
                      + ringNoise(vec2(u * 61.0, rho * 4.1), 61.0) * 0.3;
          float dens = smoothstep(R_OUT, R_OUT * 0.45, rho)
                     * smoothstep(R_IN, R_IN * 1.35, rho)
                     * (0.55 + 0.9 * bands);

          // Orbital speed as a fraction of c for a circular orbit, and the
          // beaming it produces. This is the asymmetry that makes one side of
          // the ring far brighter than the other, and it is the single most
          // recognisable thing about the picture.
          float beta = min(sqrt(0.5 / rho), 0.72);
          vec3 vhat = normalize(vec3(-hit.z, 0.0, hit.x)) * sign(uSpin + 0.001);
          float mu = dot(vhat, -rd);
          float boost = 1.0 / pow(max(1.0 - beta * mu, 0.12), 3.0);
          // Light climbing out of the well arrives redder and fainter.
          float grav = sqrt(max(1.0 - 1.0 / rho, 0.02));
          float g = clamp(boost * grav, 0.05, 5.5);

          // Scaled so the rim sits below white and only the beamed inner edge
          // clips. A real disc outshines this by orders of magnitude, but drive
          // the whole annulus past one and every channel saturates together:
          // the temperature gradient is there in the numbers and invisible on
          // screen, and the hole reads as a white smear whatever its mass.
          vec3 emit = diskColour(rho) * dens * g * uBrightness * 0.42;
          colour += emit * (1.0 - alpha);
          alpha += clamp(dens * 0.7, 0.0, 1.0) * (1.0 - alpha);
        }
      }

      // Bipolar jet. Drawn as a hollow cone rather than a filled one: a real
      // jet is a sheath around a faster spine, so it is brightest at its walls,
      // and drawing it solid gives two searchlight beams instead.
      if (uJet > 0.5) {
        float height = abs(p.y);
        float rho = length(p.xz);
        // Opening angle of about four degrees, widening slowly with height.
        float wall = 0.055 * height + 0.5;
        float across = rho / max(wall, 1e-4);
        float sheath = exp(-pow((across - 0.72) * 2.6, 2.0)) + 0.35 * exp(-pow(across * 2.2, 2.0));
        float along = smoothstep(1.2, 4.0, height) * exp(-height / 26.0);
        float flicker = 0.7 + 0.3 * noise(vec2(height * 0.5 - uTime * 1.1, rho * 0.8));
        float jet = sheath * along * flicker;
        if (jet > 0.001) {
          colour += vec3(0.55, 0.78, 1.3) * jet * 0.5 * uBrightness * step * (1.0 - alpha);
          alpha += jet * step * 0.02 * (1.0 - alpha);
        }
      }

      p = next;
    }

    if (captured) {
      // Anything in front of the hole is still seen; the horizon behind it is
      // not, so this is opaque black plus whatever the ray picked up on the way.
      gl_FragColor = vec4(colour, 1.0);
    } else {
      if (alpha < 0.002) discard;
      gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
    }
    #include <logdepthbuf_fragment>
  }
`;

const GLARE_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  uniform float uScale;
  varying vec2 vUv;
  void main() {
    vUv = position.xy;
    vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    centre.xy += position.xy * uScale;
    gl_Position = projectionMatrix * centre;

    #include <logdepthbuf_vertex>
  }
`;

const GLARE_FRAGMENT = /* glsl */ `
  precision highp float;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uColour;
  uniform float uIntensity;
  varying vec2 vUv;

  void main() {
    float d = length(vUv);
    if (d >= 1.0) discard;

    #include <logdepthbuf_fragment>

    // A saturated core inside a broad faint halo: the shape a bright point
    // takes in any real optic.
    float glow = exp(-d * 7.0) * 0.9 + exp(-d * 1.7) * 0.2;
    glow *= pow(1.0 - d, 1.5);
    gl_FragColor = vec4(uColour * uIntensity * glow, 1.0);
  }
`;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Solar luminosities a hole of this mass puts out accreting at its limit. */
function eddingtonLuminositySol(massSol) {
  return 3.2e4 * massSol;
}

export class BlackHole {
  constructor(spec) {
    this.spec = spec;
    this.rs = schwarzschildKm(spec.massSol);
    this.radius = this.rs;
    // Thin-disk temperature at the inner edge goes as the inverse fourth root
    // of mass for an Eddington-fed hole: around ten million kelvin for a
    // stellar-mass one, tens of thousands for the largest. All of that is past
    // blue-white and off the end of what a screen can show, so what is kept
    // here is the ordering rather than the absolute value — the smallest holes
    // come out blue-white throughout, the largest keep an amber rim.
    const hot = Math.pow(21 / Math.max(spec.massSol, 1), 0.25) ** 0.55;
    this.coreTempK = 9000 + 21000 * hot;
    this.rimTempK = 2400 + 5200 * hot;
    this.outerKm = this.rs * 55;
    this.world = blackHoleWorld(spec);
    this.group = new Group();
    this.group.rotateX(((spec.inclinationDeg ?? 70) * Math.PI) / 180);
    this.group.updateMatrix();

    const geometry = new SphereGeometry(this.outerKm, 48, 32);
    geometry.boundingSphere = new Sphere(new Vector3(), this.outerKm);
    this.material = new ShaderMaterial({
      uniforms: {
        uCameraLocal: { value: new Vector3(0, 0, this.rs * 20) },
        uRs: { value: this.rs },
        uTime: { value: 0 },
        uSpin: { value: spec.spin ?? 0.8 },
        uJet: { value: spec.jet ?? 0 },
        uBrightness: { value: spec.brightness ?? 1 },
        uCoreTempK: { value: this.coreTempK },
        uRimTempK: { value: this.rimTempK },
      },
      vertexShader: VOLUME_VERTEX,
      fragmentShader: VOLUME_FRAGMENT,
      side: BackSide,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.group.add(this.mesh);

    /*
     * What the hole looks like from far enough away to be a point.
     *
     * The ray-marched volume stops at 55 Schwarzschild radii, which for a
     * stellar-mass hole is a few thousand kilometres: from the worlds put in
     * orbit around Cygnus X-1, a couple of hundred au out, it covers a
     * ten-millionth of a pixel and nothing is drawn at all. But an accreting
     * hole is one of the brightest things there is, so at that range it should
     * be the brightest point in their sky, not an absence.
     */
    this.glareMaterial = new ShaderMaterial({
      uniforms: {
        uColour: { value: new Color(1, 0.93, 0.86) },
        uIntensity: { value: 0 },
        uScale: { value: this.outerKm },
      },
      vertexShader: GLARE_VERTEX,
      fragmentShader: GLARE_FRAGMENT,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.glare = new Mesh(new PlaneGeometry(2, 2), this.glareMaterial);
    this.glare.frustumCulled = false;
    this.glare.renderOrder = 20;
    this.group.add(this.glare);
    this.luminositySol = eddingtonLuminositySol(spec.massSol);
  }

  /**
   * A world-frame direction to approach from: twelve degrees above the disk,
   * which is where the lensed arc over the shadow is widest.
   */
  viewDirection(out = new Vector3()) {
    const tilt = (12 * Math.PI) / 180;
    return out
      .set(Math.cos(tilt), Math.sin(tilt), 0.35 * Math.cos(tilt))
      .applyQuaternion(this.group.quaternion)
      .normalize();
  }

  update({ cameraLocal, time, visible = true, pixelsPerRadian = 0, exposure = 1 }) {
    this.material.uniforms.uCameraLocal.value.copy(cameraLocal);
    this.material.uniforms.uTime.value = time;
    this.group.visible = visible;

    const distanceKm = Math.max(cameraLocal.length(), 1);
    const volumePixels = pixelsPerRadian ? (this.outerKm / distanceKm) * pixelsPerRadian * 2 : Infinity;
    // Handed over between four and fourteen pixels, so the point does not sit
    // on top of a disk that has become big enough to draw itself.
    const point = 1 - clamp((volumePixels - 4) / 10, 0, 1);
    this.glare.visible = point > 0.01;
    if (!this.glare.visible) return;
    const au = distanceKm / AU_KM;
    const glare = pointGlare((this.luminositySol / Math.max(au * au, 1e-9)) * exposure);
    this.glareMaterial.uniforms.uScale.value = (glare.pixels * distanceKm) / (2 * pixelsPerRadian);
    this.glareMaterial.uniforms.uIntensity.value = glare.intensity * point;
  }
}
