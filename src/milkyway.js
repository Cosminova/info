import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Mesh,
  RepeatWrapping,
  ShaderMaterial,
} from 'three';
import { galacticToEquatorial, equatorialToVector, DEG } from './astro.js';
import { Vector3 } from 'three';

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D panorama;
  uniform float intensity;
  uniform float exposure;
  uniform float extinction;
  uniform float horizonCut;
  uniform vec3 tint;
  uniform float gamma;

  varying vec2 vUv;
  varying vec3 vWorld;

  void main() {
    vec3 srgb = texture2D(panorama, vUv).rgb;
    // The panorama is a display-referred JPEG; linearise before scaling it.
    vec3 linear = pow(max(srgb, vec3(0.0)), vec3(gamma));

    float value = intensity * exposure;

    if (extinction > 0.0 || horizonCut > 0.5) {
      vec3 dir = normalize(vWorld);
      float sinAlt = dir.y;
      if (extinction > 0.0) {
        float altDeg = degrees(asin(clamp(sinAlt, -1.0, 1.0)));
        float h = max(altDeg, -2.0);
        float am = 1.0 / sin(radians(h + 244.0 / (165.0 + 47.0 * pow(max(h, 0.0) + 0.001, 1.1))));
        am = clamp(am, 1.0, 40.0);
        value *= exp2(-extinction * (am - 1.0) * ${(1.3287712).toFixed(7)});
      }
      if (horizonCut > 0.5) {
        value *= smoothstep(-0.02, 0.05, sinAlt);
      }
    }

    gl_FragColor = vec4(linear * tint * value, 1.0);
  }
`;

/**
 * Sky sphere carrying the ESO GigaGalaxy Zoom panorama.
 *
 * The mesh is generated on a galactic (l, b) grid and each vertex is then
 * placed at its equatorial world direction. That makes the texture mapping
 * exact instead of an interpolated approximation, and because longitude runs
 * monotonically across the grid there is no wrap seam to hide.
 */
export function createMilkyWay({ texture, longitudeSign = -1, radius = 900, segments = 256 }) {
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;

  const cols = segments;
  const rows = Math.max(2, Math.round(segments / 2));
  const vertexCount = (cols + 1) * (rows + 1);

  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = [];
  const tmp = new Vector3();

  let p = 0;
  let t = 0;
  for (let iy = 0; iy <= rows; iy++) {
    const b = 90 - (180 * iy) / rows;
    for (let ix = 0; ix <= cols; ix++) {
      const l = (360 * ix) / cols;
      const { ra, dec } = galacticToEquatorial(l, b);
      equatorialToVector(ra, dec, tmp).multiplyScalar(radius);
      positions[p++] = tmp.x;
      positions[p++] = tmp.y;
      positions[p++] = tmp.z;
      uvs[t++] = 0.5 + (longitudeSign * l) / 360;
      uvs[t++] = 0.5 + b / 180;
    }
  }

  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const a = iy * (cols + 1) + ix;
      const bIdx = a + 1;
      const c = a + (cols + 1);
      const d = c + 1;
      indices.push(a, c, bIdx, bIdx, c, d);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);

  const material = new ShaderMaterial({
    uniforms: {
      panorama: { value: texture },
      intensity: { value: 0.55 },
      exposure: { value: 1 },
      extinction: { value: 0 },
      horizonCut: { value: 0 },
      gamma: { value: 2.2 },
      // A touch warm and slightly green-suppressed, matching long-exposure
      // wide-field photography of the galactic plane.
      tint: { value: new Vector3(1.04, 0.99, 1.03) },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: BackSide,
    depthTest: false,
    depthWrite: false,
    blending: 2, // AdditiveBlending
    transparent: true,
  });

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.name = 'milky-way';

  return {
    mesh,
    material,
    setTexture(next) {
      next.wrapS = RepeatWrapping;
      next.wrapT = RepeatWrapping;
      next.anisotropy = 8;
      material.uniforms.panorama.value = next;
    },
    update({ exposure, intensity, atmosphere }) {
      const u = material.uniforms;
      u.exposure.value = exposure;
      if (intensity !== undefined) u.intensity.value = intensity;
      u.extinction.value = atmosphere ? atmosphere.extinction : 0;
      u.horizonCut.value = atmosphere ? 1 : 0;
    },
  };
}

/** Great-circle line marking the galactic plane, useful as an overlay. */
export function galacticEquatorPoints(steps = 720, radius = 1) {
  const out = new Float32Array(steps * 2 * 3);
  const tmp = new Vector3();
  let w = 0;
  for (let i = 0; i < steps; i++) {
    for (const l of [(360 * i) / steps, (360 * (i + 1)) / steps]) {
      const { ra, dec } = galacticToEquatorial(l, 0);
      equatorialToVector(ra, dec, tmp).multiplyScalar(radius);
      out[w++] = tmp.x;
      out[w++] = tmp.y;
      out[w++] = tmp.z;
    }
  }
  return out;
}

export const ECLIPTIC_OBLIQUITY = 23.4392911 * DEG;
