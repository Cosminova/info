import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Sphere,
  SphereGeometry,
  Vector3,
} from 'three';
import { TERRAIN_GLSL } from './terrain-glsl.js';

/**
 * The Sun: an emissive photosphere plus a corona billboard.
 *
 * The photosphere is limb darkened with the standard quadratic law, which is a
 * large effect at visible wavelengths — the edge of the disc is about a third
 * the brightness of the centre — and it is most of what stops a star reading as
 * a flat circle. Granulation and faculae come from noise keyed to the surface
 * texture.
 */

const SURFACE_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

    #include <logdepthbuf_vertex>
  }
`;

const SURFACE_FRAGMENT = /* glsl */ `
  precision highp float;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform vec3 uColour;
  uniform float uIntensity;
  uniform float uTime;
  uniform vec3 uCameraLocal;

  varying vec3 vDir;

  ${TERRAIN_GLSL}

  void main() {
    #include <logdepthbuf_fragment>

    vec3 dir = normalize(vDir);
    vec2 uv = vec2(0.5 + atan(dir.z, -dir.x) / 6.2831853, 0.5 + asin(clamp(dir.y, -1.0, 1.0)) / 3.14159265);

    vec3 base = uHasMap > 0.5 ? texture2D(uMap, uv).rgb : uColour;

    // Convective granulation: a fine boiling field over larger supergranules.
    // Contrast is kept high so the photosphere still reads as a surface once
    // you are close enough for the disc to fill the frame, instead of a flat
    // glowing ball.
    float gran = fbmd(dir * 420.0 + vec3(0.0, uTime * 0.03, 0.0), 5, 2.03, 0.52).x;
    float cells = fbmd(dir * 70.0 + vec3(uTime * 0.012, 0.0, 0.0), 4, 2.1, 0.5).x;
    float supergran = fbmd(dir * 18.0, 3, 2.07, 0.45).x;
    float spots = smoothstep(0.62, 0.82, fbmd(dir * 28.0 + 9.0, 3, 2.15, 0.5).x);
    float faculae = smoothstep(0.55, 0.9, gran) * (1.0 - spots);
    base *= 0.72 + 0.38 * gran + 0.16 * cells + 0.10 * supergran;
    base *= 1.0 - spots * 0.55;
    base += uColour * faculae * 0.22;

    // Quadratic limb darkening, coefficients for the visible band.
    float mu = clamp(dot(dir, normalize(uCameraLocal)), 0.0, 1.0);
    float limb = 1.0 - 0.32 * (1.0 - mu) - 0.23 * (1.0 - mu) * (1.0 - mu);

    gl_FragColor = vec4(base * uIntensity * limb, 1.0);
  }
`;

const CORONA_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  uniform float uScale;
  varying vec2 vUv;
  void main() {
    vUv = position.xy;
    // View-space billboard so the corona always faces us.
    vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    centre.xy += position.xy * uScale;
    gl_Position = projectionMatrix * centre;

    // The scene runs on a logarithmic depth buffer, and the corona has to write
    // its depth the same way as everything else or it cannot be compared against
    // anything. Without this it had to be drawn with depth testing switched off,
    // which meant the Sun's glow came through whatever was in front of it: stand
    // over the night side of a planet with the Sun behind it and the Sun was
    // painted across the planet.
    #include <logdepthbuf_vertex>
  }
`;

const CORONA_FRAGMENT = /* glsl */ `
  precision highp float;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uColour;
  uniform float uIntensity;
  uniform float uDiscFraction;   // photosphere radius as a fraction of the quad
  varying vec2 vUv;

  void main() {
    float d = length(vUv);
    if (d >= 1.0) discard;

    #include <logdepthbuf_fragment>


    // Measured outwards from the limb rather than from the centre, so the glow
    // begins where the star's edge actually is and the falloff does not change
    // shape as the billboard is resized with distance.
    float s = clamp((d - uDiscFraction) / max(1.0 - uDiscFraction, 1e-3), 0.0, 1.0);

    // A tight inner glow riding on a broad faint halo, which is roughly how a
    // bright source spreads through a real optic.
    float glow = exp(-s * 7.0) * 0.9 + exp(-s * 1.7) * 0.22;

    // Coronal streamers, as a sum of three harmonics that share no common
    // factor. A single cosine, which is what this was, produces a fixed number
    // of identical spokes and reads unmistakably as a pinwheel; beating three
    // together gives lobes of differing width and spacing that never repeat
    // around the disc. They also grow outwards from the limb, because that is
    // where a real corona has structure — the photosphere itself is smooth.
    float angle = atan(vUv.y, vUv.x);
    float streamers = 1.0
      + 0.10 * sin(angle * 3.0 + 1.3)
      + 0.07 * sin(angle * 7.0 + 0.6)
      + 0.05 * sin(angle * 11.0 + 2.2);
    glow *= mix(1.0, streamers, smoothstep(0.0, 0.35, s));

    // Faded to nothing at the billboard's edge. Left to itself the outer halo is
    // still a few per cent bright where the quad ends, and cutting it there drew
    // a hard circle around the star.
    glow *= pow(1.0 - s, 1.5);

    // Held back across the photosphere so the disc keeps its granulation and
    // limb darkening instead of being washed flat by the glow painted over it.
    glow *= smoothstep(uDiscFraction * 0.8, uDiscFraction * 1.04, d);

    gl_FragColor = vec4(uColour * uIntensity * glow, 1.0);
  }
`;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * How a light source too small to resolve is drawn.
 *
 * Past a certain distance a star stops being a disc and becomes a point, and
 * the two want drawing quite differently. A disc has its light spread over its
 * own angular size; a point has the same light concentrated into whatever the
 * eye or the optic spreads it into, which is why the Sun is blinding from
 * Saturn even though it is a twentieth of a pixel across there.
 *
 * So size comes from brightness rather than from geometry, and only
 * logarithmically, the way a bright star's image spreads on a plate: a hot
 * giant reads brighter than a red dwarf without becoming a dinner plate.
 *
 * @param brightness the light arriving at the camera, at the exposure the rest
 *   of the frame is drawn at. 1 is full sunlight at Earth.
 */
export function pointGlare(brightness) {
  const light = clamp(brightness, 0.03, 6);
  return {
    pixels: clamp(5 + 4.5 * Math.log10(1 + light * 9), 4.5, 26),
    // Enough to clip at the core. A star that does not saturate the few pixels
    // it covers does not read as a star; it reads as a grey smudge, which is
    // what the Sun looked like from Saturn.
    intensity: 4.2 * clamp(light, 0.7, 2.4),
  };
}

export class Star {
  constructor({ radiusKm, colour = [1.0, 0.94, 0.86], intensity = 2.8 }) {
    this.radius = radiusKm;
    this.group = new Group();

    const geometry = new SphereGeometry(radiusKm, 128, 64);
    geometry.boundingSphere = new Sphere(new Vector3(), radiusKm);
    this.material = new ShaderMaterial({
      uniforms: {
        uMap: { value: null },
        uHasMap: { value: 0 },
        uColour: { value: new Color(...colour) },
        uIntensity: { value: intensity },
        uTime: { value: 0 },
        uCameraLocal: { value: new Vector3(0, 0, radiusKm * 4) },
      },
      vertexShader: SURFACE_VERTEX,
      fragmentShader: SURFACE_FRAGMENT,
    });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    this.baseCorona = intensity * 0.22;
    this.coronaMaterial = new ShaderMaterial({
      uniforms: {
        uColour: { value: new Color(...colour) },
        uIntensity: { value: this.baseCorona },
        uScale: { value: radiusKm * 3 },
        uDiscFraction: { value: 1 / 3 },
      },
      vertexShader: CORONA_VERTEX,
      fragmentShader: CORONA_FRAGMENT,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.corona = new Mesh(new PlaneGeometry(2, 2), this.coronaMaterial);
    this.corona.frustumCulled = false;
    this.corona.renderOrder = 20;
    this.group.add(this.corona);
  }

  setMap(texture) {
    this.material.uniforms.uMap.value = texture;
    this.material.uniforms.uHasMap.value = texture ? 1 : 0;
  }

  /**
   * @param pixelsPerRadian screen scale, so the star can tell whether its disc
   *   is resolved; 0 leaves it drawn as a disc at any size.
   * @param brightness this star's light where the camera is, at the exposure
   *   the rest of the frame is being drawn at. 1 is full sunlight at Earth.
   */
  update({ cameraLocal, time, distanceKm, pixelsPerRadian = 0, brightness = 1 }) {
    this.material.uniforms.uCameraLocal.value.copy(cameraLocal);
    this.material.uniforms.uTime.value = time;
    // The corona is sized in world units, so it has to grow with distance to
    // hold a constant angular size; capped so it never swallows the disc when
    // you are close.
    const discScale = Math.max(this.radius * 1.6, Math.min(distanceKm * 0.06, this.radius * 40));
    const discPixels = pixelsPerRadian ? (this.radius / distanceKm) * pixelsPerRadian * 2 : Infinity;

    /*
     * Sizing the glow off the star's own geometry, which is all this did, makes
     * its light shrink away with the disc: the Sun came out a grey speck from
     * Earth and nothing at all from Saturn, and every host star went the same
     * way seen from its own planets. Once unresolved it is drawn from the light
     * arriving instead. For the Sun the distance cancels, which is right — it
     * is the same blazing point from every planet, because the camera is opened
     * up for the fainter sunlight out there.
     */
    const glare = pointGlare(brightness);
    const glareScale = pixelsPerRadian
      ? (glare.pixels * distanceKm) / (2 * pixelsPerRadian)
      : discScale;

    // Crossed over between about three and eight pixels of disc, so the change
    // of treatment is not a pop as you approach.
    const point = 1 - clamp((discPixels - 3) / 5, 0, 1);
    const scale = discScale + (glareScale - discScale) * point;
    this.coronaMaterial.uniforms.uScale.value = scale;
    this.coronaMaterial.uniforms.uDiscFraction.value = clamp(this.radius / scale, 0.004, 0.9);
    this.coronaMaterial.uniforms.uIntensity.value =
      this.baseCorona + (glare.intensity - this.baseCorona) * point;
  }
}
