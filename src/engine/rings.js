import { Color, DoubleSide, Mesh, RingGeometry, ShaderMaterial, Sphere, Vector3 } from 'three';

import { SHADOW_GLSL } from './shadow-glsl.js';
import { platform } from './platform.js';

/**
 * Planetary rings as real geometry in the equatorial plane.
 *
 * The texture is a one-dimensional radial profile — Cassini division, the
 * B ring's opacity, the faint outer A ring — sampled by normalised radius. Two
 * things make it read as a ring system rather than a decal: the planet's shadow
 * falls across the far side, and the rings are lit differently depending on
 * whether you see them front-lit or back-lit through their own thickness.
 */

const VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

    #include <logdepthbuf_vertex>
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform sampler2D uMap;
  uniform float uInner;
  uniform float uOuter;
  uniform float uPlanetRadius;
  uniform vec3 uSunDir;        // unit, ring frame
  uniform vec3 uCameraLocal;   // km, ring frame
  uniform vec3 uSunColour;
  uniform float uSunIntensity;
  uniform float uPixelsPerRadian;
  uniform float uSunAngular;
  uniform float uOpticalDepth;
  uniform float uAlbedo;
  uniform float uMultipleScattering;

  varying vec3 vLocal;

  ${SHADOW_GLSL}

  float hash1(float n) {
    // Wrapped before hashing. The finest octaves index cells tens of thousands
    // out from the planet's centre, and a sine-based hash loses all precision at
    // arguments that large: instead of noise it returns a stepped mess, which
    // showed up as dark speckles and dashes across the ring plane. The repeat
    // period is far larger than anything visible in one view.
    return fract(sin(mod(n, 2048.0) * 127.1) * 43758.5453);
  }

  float valueNoise(float x) {
    float i = floor(x);
    float f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(hash1(i), hash1(i + 1.0), f) * 2.0 - 1.0;
  }

  /**
   * Ringlet structure below the profile texture's resolution.
   *
   * The radial profile is about a thousand samples across seventy thousand
   * kilometres, so from a distance it is right and from close up the rings are a
   * smooth wash. What Cassini actually found is structure at every scale it could
   * resolve: thousands of ringlets, gaps, and density waves, all of it radial.
   * Octaves of radial noise continue that trend down to whatever the screen can
   * resolve, so flying into the ring plane keeps revealing finer banding instead
   * of dissolving into grey. The macro structure — Cassini division, the B ring's
   * opacity — stays with the texture; this only modulates it.
   */
  float ringlets(float r, float pixelKm) {
    float modulation = 1.0;
    float wavelength = 3000.0;
    float amp = 0.13;

    for (int i = 0; i < 7; i++) {
      // A band narrower than a couple of pixels can only alias, so it fades out
      // instead of being drawn.
      float fade = smoothstep(1.5, 4.0, wavelength / max(pixelKm, 1e-4));
      if (fade <= 0.001) break;
      modulation *= 1.0 + amp * fade * valueNoise(r / wavelength);
      wavelength *= 0.42;
      amp *= 0.86;
    }

    return modulation;
  }

  void main() {
    #include <logdepthbuf_fragment>

    float r = length(vLocal.xz);
    float t = (r - uInner) / (uOuter - uInner);
    if (t < 0.0 || t > 1.0) discard;

    vec4 ring = texture2D(uMap, vec2(t, 0.5));
    float opacity = ring.a * (0.30 * ring.r + 0.59 * ring.g + 0.11 * ring.b + 0.2);

    // Foreshortening matters more here than anywhere: seen nearly edge on, one
    // pixel covers an enormous radial distance, and detail has to be filtered to
    // that or the ring plane turns into a shimmering mess towards the horizon.
    vec3 toCamera = uCameraLocal - vLocal;
    float cameraDistance = max(length(toCamera), 1.0);
    float slant = max(abs(normalize(toCamera).y), 0.02);
    float pixelKm = cameraDistance / uPixelsPerRadian / slant;
    opacity = clamp(opacity * ringlets(r, pixelKm), 0.0, 1.0);
    float az = atan(vLocal.z, vLocal.x);
    float clumps = 0.88 + 0.12 * valueNoise(az * 18.0 + r * 0.00004);
    opacity *= clumps;
    if (opacity < 0.002) discard;

    // Planet shadow. How much of the Sun this ring particle can see, with the
    // planet as an occulting sphere centred on the origin of the ring frame. The
    // same calculation the surface shader uses for eclipses, so the shadow has a
    // real umbra that reaches zero and a penumbra exactly as wide as the Sun's
    // disc at Saturn's distance — a few hundred kilometres, which is a soft but
    // clearly defined edge across a ring seventy thousand kilometres wide.
    float sunAng = max(uSunAngular, 1e-5);
    float shadow = 1.0 - sunCoveredBySphere(-vLocal, uPlanetRadius, uSunDir, sunAng);

    vec3 view = normalize(uCameraLocal - vLocal);

    /*
     * Single-scattering through the ring plane.
     *
     * The rings are a slab of ice one particle deep in optical terms, and how
     * bright they look depends on the Sun's elevation and the viewer's elevation
     * separately, not on a Lambert term. Two cases, both from the classical
     * single-scattering solution for a slab:
     *
     * - Seen from the sunlit side, light scatters back out of the layer it
     *   entered, and a thicker ring is brighter until it saturates.
     * - Seen from the dark side, light has to cross the whole slab, so the thin
     *   parts glow and the dense B ring goes dark. That inversion — the Cassini
     *   division brighter than the B ring — is the signature of back-lit rings,
     *   and it falls out of the maths rather than being painted in.
     *
     * The previous model floored the illumination at 5%, which meant rings never
     * went dark with the Sun in their plane and never inverted when back-lit.
     */
    float mu0 = max(abs(uSunDir.y), 0.0015);   // sine of the Sun's elevation
    float mu = max(abs(view.y), 0.0015);       // sine of the viewer's elevation
    float tau = opacity * uOpticalDepth;
    bool backlit = (uSunDir.y * view.y) < 0.0;

    float scattered;
    if (backlit) {
      // Transmitted. The difference of the two exponentials, with the removable
      // singularity at mu == mu0 handled by its limit.
      float difference = mu0 - mu;
      scattered = abs(difference) < 1e-4
        ? (tau / mu0) * exp(-tau / mu0)
        : (mu0 / difference) * (exp(-tau / mu0) - exp(-tau / mu));
    } else {
      // Reflected.
      scattered = (mu0 / (mu0 + mu)) * (1.0 - exp(-tau * (1.0 / mu + 1.0 / mu0)));
    }
    // The factor of a quarter belongs to the single-scattering solution; the
    // albedo is the ice's, which is high, because this is fresh water ice.
    //
    // uMultipleScattering makes up what single scattering leaves out. At an
    // optical depth of two and an albedo near one, most of the light leaving the
    // B ring has bounced between particles several times, and the particles
    // backscatter strongly rather than isotropically — both of which the solution
    // above omits, and together they are most of the ring's brightness. Modelling
    // them properly means a radiative transfer solution; one calibrated factor
    // buys the observed brightness while leaving the parts that are solved here —
    // the dependence on the Sun's and the viewer's elevation, and the inversion
    // when back-lit — doing the work.
    float brightness = clamp(scattered * uAlbedo * 0.25 * uMultipleScattering, 0.0, 4.0);

    vec3 colour = ring.rgb * uSunColour * uSunIntensity * brightness * shadow;

    // Opacity as the viewer sees it: a grazing view looks through a longer path
    // and the rings go opaque.
    float coverage = clamp(1.0 - exp(-tau / mu), 0.0, 1.0);
    gl_FragColor = vec4(colour, coverage);
  }
`;

export function createRings({
  innerKm,
  outerKm,
  planetRadiusKm,
  texture,
  // Normal optical depth where the radial profile is fully opaque, and the
  // single-scattering albedo of the particles. Saturn's B ring reaches about 2.5,
  // and its ice is among the brightest material in the solar system.
  opticalDepth = 2.5,
  albedo = 0.6,
  // Set so that the sunlit rings sit at roughly the brightness of Saturn's cloud
  // tops, which is where the spacecraft imagery puts them.
  multipleScattering = 4.2,
}) {
  const geometry = new RingGeometry(innerKm, outerKm, platform.ringSegments, 8);
  // RingGeometry is built in the XY plane; rings belong in the equator.
  geometry.rotateX(-Math.PI / 2);
  geometry.boundingSphere = new Sphere(new Vector3(), outerKm);

  const material = new ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uInner: { value: innerKm },
      uOuter: { value: outerKm },
      uPlanetRadius: { value: planetRadiusKm },
      uSunDir: { value: new Vector3(1, 0, 0) },
      uCameraLocal: { value: new Vector3() },
      uSunColour: { value: new Color(1, 0.97, 0.92) },
      uSunIntensity: { value: 1 },
      uPixelsPerRadian: { value: 1000 },
      uSunAngular: { value: 0.0005 },
      uOpticalDepth: { value: opticalDepth },
      uAlbedo: { value: albedo },
      uMultipleScattering: { value: multipleScattering },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
  });

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  mesh.name = 'rings';
  return { mesh, material };
}
