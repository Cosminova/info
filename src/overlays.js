import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { DEG, equatorialToVector } from './astro.js';

/**
 * Screen-space-width line layer. Fat lines matter here because 1px GL lines
 * look broken on high-DPI displays and cannot be softened.
 */
export function createLineLayer(positions, options = {}) {
  const {
    color = 0x5c7fa8,
    linewidth = 1.4,
    opacity = 0.5,
    dashed = false,
    dashSize = 0.02,
    gapSize = 0.02,
    depthTest = true,
    renderOrder = 5,
    radius = 100,
  } = options;

  const scaled =
    radius === 1 ? positions : positions.map ? positions.map((v) => v * radius) : positions;
  const scaledArray =
    scaled instanceof Float32Array ? scaled : Float32Array.from(scaled);

  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(scaledArray);

  const material = new LineMaterial({
    color: new Color(color),
    linewidth,
    opacity,
    transparent: true,
    dashed,
    dashSize,
    gapSize,
    depthTest,
    depthWrite: false,
    worldUnits: false,
  });

  // Lines are additive and depth-independent, so from the ground they would
  // otherwise be drawn straight across the landscape. Each segment is short
  // enough after subdivision that fading by its midpoint altitude is smooth.
  const horizonFade = { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHorizonFade = horizonFade;
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      `varying float vHorizonY;
       void main() {
         vHorizonY = normalize((modelMatrix * vec4((instanceStart + instanceEnd) * 0.5, 1.0)).xyz).y;`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `varying float vHorizonY;
         uniform float uHorizonFade;
         void main() {`,
      )
      .replace(
        'gl_FragColor = vec4( diffuseColor.rgb, alpha );',
        `if (uHorizonFade > 0.5) alpha *= smoothstep(-0.035, 0.01, vHorizonY);
         if (alpha <= 0.0) discard;
         gl_FragColor = vec4( diffuseColor.rgb, alpha );`,
      );
  };

  const object = new LineSegments2(geometry, material);
  object.frustumCulled = false;
  object.renderOrder = renderOrder;
  object.computeLineDistances();

  return {
    object,
    material,
    setOpacity(value) {
      material.opacity = value;
      object.visible = value > 0.004;
    },
    setHorizonFade(enabled) {
      horizonFade.value = enabled ? 1 : 0;
    },
    setResolution(width, height) {
      material.resolution.set(width, height);
    },
  };
}

/** Great-circle arc segments between two directions, subdivided for smoothness. */
function pushArc(out, from, to, steps) {
  let prev = from.clone().normalize();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const next = new Vector3()
      .copy(from)
      .lerp(to, t)
      .normalize();
    out.push(prev.x, prev.y, prev.z, next.x, next.y, next.z);
    prev = next;
  }
}

/** RA meridians every hour, declination parallels every 15 degrees. */
export function buildEquatorialGrid() {
  const out = [];
  const a = new Vector3();
  const b = new Vector3();

  for (let hour = 0; hour < 24; hour++) {
    const ra = hour * 15;
    for (let dec = -90; dec < 90; dec += 3) {
      equatorialToVector(ra, dec, a);
      equatorialToVector(ra, dec + 3, b);
      out.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  for (let dec = -75; dec <= 75; dec += 15) {
    for (let ra = 0; ra < 360; ra += 3) {
      equatorialToVector(ra, dec, a);
      equatorialToVector(ra + 3, dec, b);
      out.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  return new Float32Array(out);
}

/** The ecliptic: the Sun's annual path, and the lane the planets stay near. */
export function buildEclipticLine() {
  const out = [];
  const obliquity = 23.4392911 * DEG;
  const point = (lambdaDeg) => {
    const lambda = lambdaDeg * DEG;
    const dec = Math.asin(Math.sin(obliquity) * Math.sin(lambda));
    const ra = Math.atan2(Math.cos(obliquity) * Math.sin(lambda), Math.cos(lambda)) / DEG;
    return equatorialToVector(ra, dec / DEG, new Vector3());
  };
  for (let l = 0; l < 360; l += 1) {
    const a = point(l);
    const b = point(l + 1);
    out.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  return new Float32Array(out);
}

/**
 * Alt-azimuth grid. Lives in the horizontal frame (the scene root) rather than
 * the sky container, so it stays fixed while the sky rotates.
 */
export function buildHorizontalGrid() {
  const out = [];
  const dir = (altDeg, azDeg) => {
    const alt = altDeg * DEG;
    const az = azDeg * DEG;
    const ca = Math.cos(alt);
    return new Vector3(-ca * Math.sin(az), Math.sin(alt), ca * Math.cos(az));
  };

  for (let az = 0; az < 360; az += 15) {
    for (let alt = 0; alt < 90; alt += 3) {
      pushArcRaw(out, dir(alt, az), dir(alt + 3, az));
    }
  }
  for (let alt = 0; alt <= 75; alt += 15) {
    for (let az = 0; az < 360; az += 3) {
      pushArcRaw(out, dir(alt, az), dir(alt, az + 3));
    }
  }
  return new Float32Array(out);
}

function pushArcRaw(out, a, b) {
  out.push(a.x, a.y, a.z, b.x, b.y, b.z);
}

/** Emphasised horizon circle. */
export function buildHorizonRing() {
  const out = [];
  for (let az = 0; az < 360; az += 1) {
    const a = az * DEG;
    const b = (az + 1) * DEG;
    out.push(-Math.sin(a), 0, Math.cos(a), -Math.sin(b), 0, Math.cos(b));
  }
  return new Float32Array(out);
}

export const CARDINAL_POINTS = [
  { label: 'N', azimuth: 0 },
  { label: 'NE', azimuth: 45 },
  { label: 'E', azimuth: 90 },
  { label: 'SE', azimuth: 135 },
  { label: 'S', azimuth: 180 },
  { label: 'SW', azimuth: 225 },
  { label: 'W', azimuth: 270 },
  { label: 'NW', azimuth: 315 },
].map((c) => {
  const az = c.azimuth * DEG;
  return { ...c, position: new Vector3(-Math.sin(az), 0.012, Math.cos(az)).multiplyScalar(60) };
});

// ------------------------------------------------------------------- ground

const GROUND_VERTEX = /* glsl */ `
  varying vec3 vLocal;
  void main() {
    vLocal = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GROUND_FRAGMENT = /* glsl */ `
  uniform vec3 nearColor;
  uniform vec3 farColor;
  uniform float opacity;

  varying vec3 vLocal;

  // Cheap value noise for a suggestion of terrain texture near the horizon.
  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(17.31, 41.77, 91.13))) * 43758.5453);
  }

  void main() {
    float depth = clamp(-vLocal.y, 0.0, 1.0);
    vec3 color = mix(farColor, nearColor, pow(depth, 0.6));
    float grain = hash(floor(vLocal * 260.0)) * 0.035;
    color += grain * (1.0 - depth);
    gl_FragColor = vec4(color, opacity);
  }
`;

/**
 * Opaque ground dome. It sits closer to the camera than the overlay sphere so
 * depth testing alone hides constellation lines and deep sky markers that have
 * set, without any per-layer clipping logic.
 */
export function createGround({ radius = 50 } = {}) {
  const geometry = new SphereGeometry(radius, 96, 32, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const material = new ShaderMaterial({
    uniforms: {
      nearColor: { value: new Color(0x05060a) },
      farColor: { value: new Color(0x0d1219) },
      opacity: { value: 1 },
    },
    vertexShader: GROUND_VERTEX,
    fragmentShader: GROUND_FRAGMENT,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = 0;
  mesh.name = 'ground';
  return { mesh, material };
}

const HAZE_VERTEX = /* glsl */ `
  varying vec3 vLocal;
  void main() {
    vLocal = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const HAZE_FRAGMENT = /* glsl */ `
  uniform vec3 color;
  uniform float strength;
  uniform float falloff;

  varying vec3 vLocal;

  void main() {
    float alt = asin(clamp(vLocal.y, -1.0, 1.0));
    float band = exp(-max(alt, 0.0) / falloff);
    band *= smoothstep(-0.02, 0.03, vLocal.y);
    gl_FragColor = vec4(color * band * strength, 1.0);
  }
`;

/**
 * Airglow and light pollution: a faint band hugging the horizon. Even a very
 * dark site has this, and its absence is one of the things that makes a
 * rendered night sky read as fake.
 */
export function createHorizonGlow({ radius = 120 } = {}) {
  // A full sphere, not a band: any truncation leaves a hard geometry edge in
  // the sky that the shader's smooth altitude falloff cannot hide.
  const geometry = new SphereGeometry(radius, 96, 48);
  const material = new ShaderMaterial({
    uniforms: {
      color: { value: new Color(0x2a3d4f) },
      strength: { value: 0.16 },
      falloff: { value: 0.19 },
    },
    vertexShader: HAZE_VERTEX,
    fragmentShader: HAZE_FRAGMENT,
    blending: AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: 2,
  });
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = -5;
  mesh.name = 'horizon-glow';
  return { mesh, material };
}

export function positionsToBufferGeometry(positions) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  return geometry;
}
