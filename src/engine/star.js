import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Sphere,
  SphereGeometry,
  Vector2,
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

  uniform float uLumpy;
  uniform float uSeed;
  uniform float uTime;
  varying vec3 vDir;
  varying float vLift;

  ${TERRAIN_GLSL}

  void main() {
    vDir = normalize(position);
    // The giant cells heave the surface in and out, slowly.
    float lift = 0.0;
    if (uLumpy > 0.0) {
      lift = fbmd(vDir * 1.7 + vec3(uSeed, uTime * 0.002, -uSeed), 3, 2.1, 0.5).x - 0.5;
    }
    vLift = lift;
    vec3 p = position * (1.0 + lift * uLumpy * 2.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);

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
  uniform float uGranScale;
  uniform float uGranContrast;
  uniform float uSpots;
  uniform vec2 uLimb;
  uniform float uSeed;
  uniform float uLumpy;

  varying vec3 vDir;
  varying float vLift;

  ${TERRAIN_GLSL}

  void main() {
    #include <logdepthbuf_fragment>

    vec3 dir = normalize(vDir);
    vec2 uv = vec2(0.5 + atan(dir.z, -dir.x) / 6.2831853, 0.5 + asin(clamp(dir.y, -1.0, 1.0)) / 3.14159265);

    // Gradient taken the short way round where u wraps, or the seam reads the
    // coarsest mip and draws a line down the disc.
    vec2 gx = dFdx(uv);
    vec2 gy = dFdy(uv);
    gx.x -= floor(gx.x + 0.5);
    gy.x -= floor(gy.x + 0.5);
    vec3 base = uHasMap > 0.5 ? textureGrad(uMap, uv, gx, gy).rgb : uColour;

    // Convective granulation: a fine boiling field over larger supergranules,
    // its scale and contrast set by the star (see starLook in stellar.js). The
    // lanes between granules are cooler, so they go redder as well as darker.
    float gran = fbmd(dir * uGranScale + vec3(uSeed, uTime * 0.03, 0.0), 5, 2.03, 0.52).x;
    float cells = fbmd(dir * uGranScale * 0.17 + vec3(uTime * 0.012, uSeed, 0.0), 4, 2.1, 0.5).x;
    float supergran = fbmd(dir * max(uGranScale * 0.043, 1.5) + uSeed, 3, 2.07, 0.45).x;
    float texture = 0.38 * gran + 0.16 * cells + 0.10 * supergran;
    base *= max(1.0 + (texture - 0.32) * uGranContrast * 2.2, 0.5);
    base *= mix(vec3(1.0), vec3(1.0, 0.86, 0.72), (1.0 - gran) * uGranContrast * 0.35);

    // Starspots: dark, cool umbrae inside a lighter penumbra, in belts either
    // side of the equator the way the Sun's sit, wider on a heavily spotted star.
    float belt = exp(-pow((abs(dir.y) - 0.3) / mix(0.12, 0.45, uSpots), 2.0));
    float field = fbmd(dir * 9.0 + 7.0 + uSeed * 3.0, 4, 2.15, 0.5).x;
    float spotMask = smoothstep(0.7 - uSpots * 0.5, 0.76 - uSpots * 0.5, field) * belt * step(0.001, uSpots);
    float umbra = smoothstep(0.78 - uSpots * 0.5, 0.84 - uSpots * 0.5, field) * belt * step(0.001, uSpots);
    base *= mix(vec3(1.0), vec3(0.62, 0.5, 0.4), spotMask * 0.7);
    base *= mix(vec3(1.0), vec3(0.32, 0.22, 0.16), umbra);
    float faculae = smoothstep(0.55, 0.9, gran) * (1.0 - spotMask) * uGranContrast;
    base += uColour * faculae * 0.45;
    // Where the cells rise the gas is hotter and brighter, where it sinks dark
    // and red: the mottling a supergiant's disc is covered in.
    if (uLumpy > 0.0) {
      float heave = clamp(vLift * 2.4, -1.0, 1.0);
      vec3 mottle = mix(vec3(0.6, 0.44, 0.32), vec3(1.55, 1.36, 1.05), smoothstep(-0.8, 0.8, heave));
      base *= mix(vec3(1.0), mottle, min(uLumpy * 18.0, 1.0));
    }

    // Quadratic limb darkening, coefficients by temperature.
    float mu = clamp(dot(dir, normalize(uCameraLocal)), 0.0, 1.0);
    float limb = max(1.0 - uLimb.x * (1.0 - mu) - uLimb.y * (1.0 - mu) * (1.0 - mu), 0.05);
    // The limb of a cool star is redder as well as darker: you are seeing
    // higher, cooler layers there.
    base *= mix(vec3(1.0), vec3(1.0, 0.8, 0.62), (1.0 - mu) * uLimb.x * 0.6);

    gl_FragColor = vec4(base * uIntensity * limb, 1.0);
  }
`;

const CORONA_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  uniform float uScale;
  uniform float uLensOffset;
  varying vec2 vUv;
  void main() {
    vUv = position.xy;
    // View-space billboard so the corona always faces us.
    vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    // Move along the eye-to-source ray, preserving the projected centre and
    // angular size. A Z-only shift displaces off-axis glare from its star.
    float lensScale = max(0.01, 1.0 - uLensOffset / max(-centre.z, 1e-6));
    centre.xyz *= lensScale;
    centre.xy += position.xy * uScale * lensScale;
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
  uniform float uShell;
  uniform float uSeed;
  varying vec2 vUv;

  float shellHash(float n) { return fract(sin(n) * 43758.5453); }

  void main() {
    float d = length(vUv);
    if (d >= 1.0) discard;

    #include <logdepthbuf_fragment>

    // Dust a supergiant has shed: broken arcs at a few radii, lit by the star
    // from inside, dull orange. In star radii, so they hold their place on the
    // disc however the billboard is scaled.
    float shellLight = 0.0;
    if (uShell > 0.0) {
      float rs = d / max(uDiscFraction, 1e-4);
      float ang = atan(vUv.y, vUv.x);
      for (int k = 0; k < 4; k++) {
        float fk = float(k);
        float rk = 1.6 + fk * (0.9 + shellHash(uSeed + fk) * 0.9);
        float wk = 0.08 + 0.12 * shellHash(uSeed * 1.7 + fk);
        float arc = exp(-pow((rs - rk) / wk, 2.0));
        // Each shell only part of the way round, lopsided like real ones.
        float span = smoothstep(-0.2, 0.7, sin(ang * (1.0 + fk) + shellHash(uSeed + fk * 3.1) * 6.28));
        shellLight += arc * span / (1.0 + fk * 0.6);
      }
      shellLight *= uShell * (1.0 - smoothstep(0.85, 1.0, d));
    }


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

    vec3 dust = vec3(1.0, 0.55, 0.28) * shellLight * 0.35 * smoothstep(uDiscFraction * 1.1, uDiscFraction * 1.5, d);
    gl_FragColor = vec4(uColour * uIntensity * glow + dust * uIntensity, 1.0);
  }
`;

/*
 * The glare a bright star throws across the lens: a wide soft halo, four
 * diffraction spikes from the vanes holding a secondary mirror, and a faint
 * ghost ring. Sized in pixels from the light arriving, so a host star seen from
 * its own planet floods a good part of the frame and a far one is a spiked
 * point, which is how a camera rather than a diagram sees a star.
 */
const FLARE_FRAGMENT = /* glsl */ `
  precision highp float;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uColour;
  uniform float uIntensity;
  uniform float uSpikes;
  uniform float uResolved;
  uniform float uAngle;
  uniform float uDiscFraction;
  varying vec2 vUv;

  void main() {
    float d = length(vUv);
    if (d >= 1.0) discard;

    #include <logdepthbuf_fragment>

    float limb = clamp((d - uDiscFraction) / max(1.0 - uDiscFraction, 1e-3), 0.0, 1.0);
    float edge = pow(1.0 - d, 2.0);
    float halo = (exp(-limb * 10.0) * 0.5 + exp(-limb * 3.5) * 0.25 + exp(-limb * 1.4) * 0.07) * edge;

    // A starburst of fine rays of uneven strength, the way scattering in a
    // real lens breaks up a bright point, rather than four clean vanes.
    float ang = atan(vUv.y, vUv.x) + uAngle;
    float rays = pow(0.5 + 0.5 * sin(ang * 23.0 + 1.3), 10.0) * 0.6
      + pow(0.5 + 0.5 * sin(ang * 37.0 + 4.1), 14.0) * 0.5
      + pow(0.5 + 0.5 * sin(ang * 11.0 + 2.2), 8.0) * 0.45;
    rays *= exp(-limb * 2.8) * pow(1.0 - d, 1.3);
    // A long, thin horizontal streak through the core: screen-horizontal
    // whichever way the camera faces, since the quad is a view billboard.
    float streak = exp(-pow(vUv.y / (0.004 + 0.01 * abs(vUv.x)), 2.0)) * pow(max(1.0 - abs(vUv.x), 0.0), 2.2);
    // Wavelength-separated lens halo, strongest across the horizontal axis.
    // It is an optical artifact, never part of a planet's atmosphere/material.
    vec3 ghost = vec3(exp(-pow((d-.62)/.09,2.0)),
                      exp(-pow((d-.68)/.085,2.0)),
                      exp(-pow((d-.73)/.085,2.0)));
    ghost *= 0.045 * (0.2 + 0.8 * pow(abs(cos(ang-uAngle)),4.0));
    float core = exp(-pow(d / 0.055, 2.0)) * 4.0 * (1.0-uResolved);

    // The halo is kept off a resolved disc so a close star keeps its surface;
    // point-source rays fade away as the stellar surface becomes resolved.
    float off = mix(1.0, smoothstep(uDiscFraction * 0.85, uDiscFraction * 1.15, d), uResolved);
    vec3 tint = mix(uColour, vec3(1.0), 0.35 * exp(-d * 6.0));
    float lens = (rays * 0.38 + streak * 1.05) * uSpikes * off;
    gl_FragColor = vec4(uIntensity * (tint * (halo * off + lens) + vec3(core) + ghost * off * mix(1.0,.3,uResolved)), 1.0);
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
// Visible fraction of a stellar disc behind a spherical foreground body.
// Lens artifacts respond to the source as a whole, not the billboard's depth.
export function lensTransmission(camera, star, starRadius, body, bodyRadius) {
  const toStar=star.clone().sub(camera),toBody=body.clone().sub(camera);
  const ds=toStar.length(),db=toBody.length();
  if(db-bodyRadius>=ds || ds<=starRadius || db<=0)return 1;
  const a=Math.asin(Math.min(starRadius/ds,1)),b=Math.asin(Math.min(bodyRadius/db,1));
  const separation=Math.acos(Math.max(-1,Math.min(1,toStar.dot(toBody)/(ds*db))));
  if(separation>=a+b)return 1;
  if(separation<=Math.abs(b-a))return b>=a?0:1-b*b/(a*a);
  const d=separation/a,r=b/a;
  const x=Math.acos(Math.max(-1,Math.min(1,(d*d+1-r*r)/(2*d))));
  const y=Math.acos(Math.max(-1,Math.min(1,(d*d+r*r-1)/(2*d*r))));
  const area=x+r*r*y-.5*Math.sqrt(Math.max(0,(-d+1+r)*(d+1-r)*(d-1+r)*(d+1+r)));
  return Math.max(0,Math.min(1,1-area/Math.PI));
}

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

/**
 * 0-1, how visible a point source of this luminosity is from this far away,
 * by its apparent magnitude against the faintest the frame shows. The glare
 * keeps a floor of brightness so a far Sun still reads as a star, and without
 * this the floor held from anywhere: a bright point at the edge of the universe.
 */
export function pointVisibility(luminositySol, distanceKm, limitMagnitude = 8.7) {
  const pc = Math.max(distanceKm / 3.0856775814913673e13, 1e-9);
  const m = 4.83 - 2.5 * Math.log10(Math.max(luminositySol, 1e-12)) + 5 * Math.log10(pc) - 5;
  return clamp((limitMagnitude - m) / 3, 0, 1);
}

export class Star {
  constructor({ radiusKm, colour = [1.0, 0.94, 0.86], intensity = 2.8, look = null }) {
    const surface = look ?? { granScale: 420, granContrast: 0.46, spots: 0.12, limb: [0.32, 0.23], seed: 0 };
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
        uGranScale: { value: surface.granScale },
        uGranContrast: { value: surface.granContrast },
        uSpots: { value: surface.spots },
        uLimb: { value: new Vector2(...surface.limb) },
        uSeed: { value: surface.seed },
        uLumpy: { value: surface.lumpy ?? 0 },
      },
      vertexShader: SURFACE_VERTEX,
      fragmentShader: SURFACE_FRAGMENT,
    });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.baseIntensity = intensity;

    this.baseCorona = intensity * 0.22 * (surface.glow ?? 1);
    // The glow of a swollen star reaches several of its own radii out, and
    // its dust shells further still.
    this.coronaReach = (surface.shell ?? 0) > 0 ? 7 : (surface.glow ?? 1) > 1.3 ? 3.5 : 1.6;
    this.coronaMaterial = new ShaderMaterial({
      uniforms: {
        uLensOffset: { value: 0 },
        uColour: { value: new Color(...colour) },
        uIntensity: { value: this.baseCorona },
        uScale: { value: radiusKm * 3 },
        uDiscFraction: { value: 1 / 3 },
        uShell: { value: surface.shell ?? 0 },
        uSeed: { value: surface.seed },
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

    this.flareMaterial = new ShaderMaterial({
      uniforms: {
        uColour: { value: new Color(...colour) },
        uIntensity: { value: 0 },
        uScale: { value: radiusKm * 6 },
        uLensOffset: { value: radiusKm * 1.01 },
        uSpikes: { value: 1 },
        uResolved: { value: 0 },
        uAngle: { value: 0.26 },
        uDiscFraction: { value: 0 },
      },
      vertexShader: CORONA_VERTEX,
      fragmentShader: FLARE_FRAGMENT,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.flare = new Mesh(new PlaneGeometry(2, 2), this.flareMaterial);
    this.flare.frustumCulled = false;
    this.flare.renderOrder = 21;
    this.group.add(this.flare);
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
  update({ cameraLocal, time, distanceKm, pixelsPerRadian = 0, brightness = 1, visibility = 1, flare = true, lensTransmission = 1 }) {
    this.material.uniforms.uCameraLocal.value.copy(cameraLocal);
    this.material.uniforms.uTime.value = time;
    // The corona is sized in world units, so it has to grow with distance to
    // hold a constant angular size; capped so it never swallows the disc when
    // you are close.
    const discScale = Math.max(this.radius * this.coronaReach, Math.min(distanceKm * 0.06, this.radius * 40));
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
      (this.baseCorona + (glare.intensity - this.baseCorona) * point) * visibility;
    this.mesh.visible = visibility > 0.002;
    this.corona.visible = this.mesh.visible;

    // Visible stellar meshes retain a faint optical response even when the
    // exposure is set by a much brighter binary companion.
    const light = Math.max(clamp(brightness, 0, 4), .025*visibility);
    // A sun a few dozen pixels across, the way a host star stands in its own
    // planet's sky, clips to white in any camera; drawn at surface brightness
    // it came out a grey disc. Close enough to fill the view it is a surface
    // again and keeps its detail.
    const discRadius = discPixels / 2;
    const blowout = 1 + 1.2 * (1 - clamp((discRadius - 15) / 120, 0, 1)) * clamp(light, 0, 1);
    this.material.uniforms.uIntensity.value = this.baseIntensity * blowout;
    // Every star whose disc is drawn has its glare: the camera's response to
    // a bright source does not stop because the source is the one selected,
    // or because a lens in front of it has dimmed it.
    this.flare.visible = flare && this.mesh.visible && pixelsPerRadian > 0;
    if (this.flare.visible) {
      const discRadiusPx = discPixels / 2;
      const flarePx = Math.max(110 + 400 * Math.log10(1 + Math.max(light, 0.05) * 4), discRadiusPx * 2.6);
      const flareScale = (flarePx * distanceKm) / pixelsPerRadian;
      const f = this.flareMaterial.uniforms;
      f.uScale.value = flareScale;
      f.uDiscFraction.value = clamp(this.radius / flareScale, 0, 0.9);
      f.uSpikes.value = Math.max(1 - clamp((discRadiusPx - 4) / 30, 0, 1), 0.45);
      f.uResolved.value = clamp((discRadiusPx - 14) / 30, 0, 1);
      f.uIntensity.value = Math.min(1.4, 0.85 * Math.pow(Math.max(light, 0.05), 0.6))
        * (1 - 0.45 * f.uResolved.value) * Math.max(visibility, 0.2) * Math.max(lensTransmission, 0.35);
    }
  }
}
