import { AdditiveBlending, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';

const VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 sunDirection;      // unit vector in the horizontal frame
  uniform float sunAltitude;      // degrees
  uniform float turbidity;
  uniform float brightness;
  uniform float airglow;
  uniform float exposure;

  varying vec3 vDir;

  float airmass(float altDeg) {
    float h = max(altDeg, -3.0);
    float denom = sin(radians(h + 244.0 / (165.0 + 47.0 * pow(max(h, 0.0) + 0.001, 1.1))));
    return clamp(1.0 / denom, 1.0, 42.0);
  }

  void main() {
    vec3 dir = normalize(vDir);
    float viewAltDeg = degrees(asin(clamp(dir.y, -1.0, 1.0)));

    // Daylight fades through civil, nautical and astronomical twilight.
    float day = sunAltitude >= 0.0 ? 1.0 : exp(sunAltitude / 4.2);
    day = clamp(day, 0.0, 1.0);

    float cosTheta = clamp(dot(dir, sunDirection), -1.0, 1.0);
    float rayleighPhase = 0.75 * (1.0 + cosTheta * cosTheta);
    float miePhase = pow(max(cosTheta, 0.0), 12.0);

    float viewAm = airmass(viewAltDeg);
    float sunAm = airmass(sunAltitude);

    // Sunlight reddens as it grazes a longer path through the atmosphere.
    vec3 sunTransmittance = exp(-vec3(0.11, 0.26, 0.58) * (sunAm - 1.0) * turbidity);

    // Single-scattering build-up along the view ray.
    float depth = 1.0 - exp(-viewAm * 0.33);
    vec3 rayleigh = vec3(0.16, 0.33, 0.78) * rayleighPhase * depth;
    vec3 mie = vec3(0.95, 0.86, 0.72) * miePhase * depth * (0.28 * turbidity);

    vec3 sky = (rayleigh + mie) * sunTransmittance * day * brightness;

    // Natural airglow keeps a moonless sky from being pure black.
    vec3 glow = vec3(0.20, 0.30, 0.34) * airglow * (0.35 + 0.65 * (1.0 - exp(-viewAm * 0.22)));
    sky += glow;

    sky *= smoothstep(-0.06, 0.02, dir.y);

    gl_FragColor = vec4(sky * exposure, 1.0);
  }
`;

/**
 * Analytic single-scattering sky.
 *
 * This is what makes the difference between "stars on black" and a night sky:
 * a real sky has airglow, and if the Sun is anywhere within 18 degrees of the
 * horizon it has a twilight gradient that drowns out faint stars. Scrubbing
 * time through dawn is only convincing with this layer present.
 */
export function createAtmosphere({ radius = 300 } = {}) {
  const geometry = new SphereGeometry(radius, 64, 40);
  const material = new ShaderMaterial({
    uniforms: {
      sunDirection: { value: new Vector3(0, -1, 0) },
      sunAltitude: { value: -40 },
      turbidity: { value: 1.0 },
      brightness: { value: 5.2 },
      airglow: { value: 0.05 },
      exposure: { value: 1 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: 1, // BackSide
    blending: AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -8;
  mesh.name = 'atmosphere';

  return {
    mesh,
    material,
    /**
     * Returns an estimate of how many magnitudes of sky glow the atmosphere is
     * adding, so the limiting magnitude can respond to twilight.
     */
    update({ sunDirection, sunAltitude, exposure, airglow, turbidity }) {
      const u = material.uniforms;
      u.sunDirection.value.copy(sunDirection);
      u.sunAltitude.value = sunAltitude;
      u.exposure.value = exposure;
      if (airglow !== undefined) u.airglow.value = airglow;
      if (turbidity !== undefined) u.turbidity.value = turbidity;

      const day = sunAltitude >= 0 ? 1 : Math.exp(sunAltitude / 4.2);
      // Roughly: full daylight costs about 13 magnitudes of limiting depth.
      return Math.max(0, 13.5 * Math.pow(Math.min(1, day), 0.42));
    },
  };
}
