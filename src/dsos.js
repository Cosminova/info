import {
  AdditiveBlending,
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';

const CLASS_INDEX = {
  galaxy: 0,
  'galaxy-group': 0,
  'globular-cluster': 1,
  'open-cluster': 2,
  'planetary-nebula': 3,
  nebula: 4,
  'emission-nebula': 4,
  'star-forming-region': 4,
  'reflection-nebula': 5,
  'dark-nebula': 6,
  'supernova-remnant': 7,
  other: 8,
};

export const DSO_CLASS_LABEL = {
  0: 'Galaxy',
  1: 'Globular cluster',
  2: 'Open cluster',
  3: 'Planetary nebula',
  4: 'Emission nebula',
  5: 'Reflection nebula',
  6: 'Dark nebula',
  7: 'Supernova remnant',
  8: 'Deep sky object',
};

const VERTEX = /* glsl */ `
  attribute vec3 instanceCenter;   // unit direction, equatorial frame
  attribute vec2 instanceRadius;   // angular semi-axes, radians
  attribute float instanceMag;
  attribute float instanceClass;
  attribute float instanceRank;    // visibility rank from the data build

  uniform float shellRadius;
  uniform float radPerPixel;       // angular size of one pixel at current zoom
  uniform float minPixels;         // smallest on-screen marker
  uniform float limitMagnitude;    // depth reachable at the current zoom
  uniform float surfaceRefMagnitude; // zoom-independent reference
  uniform float surfaceGain;
  uniform float pointGain;
  uniform float knee;
  uniform float clusterSymbol;
  uniform float fovRadians;
  uniform float horizonCut;        // 1 = hide everything below the horizon

  varying vec2 vUv;
  varying float vClass;
  varying float vRadiance;
  varying float vMarker;           // 1 = drawn as a symbol, 0 = resolved extent
  varying float vSeed;

  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(27.13, 61.71, 13.37))) * 43758.5453);
  }

  void main() {
    float trueMaj = max(instanceRadius.x, 1e-6);
    float trueMin = max(instanceRadius.y, 1e-6);

    float floorRadius = radPerPixel * minPixels;
    float maj = max(trueMaj, floorRadius);
    float minr = max(trueMin, floorRadius * (trueMin / trueMaj));
    minr = max(minr, floorRadius * 0.45);

    // Surface brightness of an extended object does not change with
    // magnification: a bigger aperture makes it larger, not brighter. So the
    // resolved case is referenced to a fixed magnitude and only responds to the
    // exposure control, while a point-like object is referenced to the current
    // limiting magnitude and does brighten as you zoom in.
    float fluxSurface = exp2((surfaceRefMagnitude - instanceMag) * 1.3287712);
    float fluxPoint = exp2((limitMagnitude - instanceMag) * 1.3287712);

    float areaArcmin = 3.14159265 * (trueMaj * 3437.7468) * (trueMin * 3437.7468);
    float surface = fluxSurface / max(areaArcmin, 0.35) * surfaceGain;
    float point = fluxPoint * pointGain;

    float marker = 1.0 - smoothstep(0.9, 2.4, trueMaj / max(floorRadius, 1e-9));
    vMarker = marker;

    float radiance = mix(surface, point, marker);

    // An open cluster ring is a chart symbol, not light: the cluster's actual
    // brightness comes from its member stars, which the catalogue layer already
    // draws. Giving it surface brightness painted huge white halos over places
    // like Orion's belt.
    if (instanceClass > 1.5 && instanceClass < 2.5) radiance = clusterSymbol;

    // A ring symbol only means anything when the whole ring is on screen. Zoomed
    // deep into Orion, Barnard's Loop and Collinder 70 are tens of fields wide
    // and their outlines cross the frame as unexplained bright bands.
    bool ringClass = (instanceClass > 1.5 && instanceClass < 2.5) || instanceClass > 6.5;
    if (ringClass) {
      radiance *= 1.0 - smoothstep(0.35, 0.8, trueMaj / max(fovRadians, 1e-6));
    }

    radiance = radiance / (1.0 + radiance / knee);
    // Fade out near the depth limit rather than clipping objects on and off.
    radiance *= smoothstep(1.6, -0.3, instanceRank - limitMagnitude);
    vRadiance = radiance;

    float angle = hash(instanceCenter) * 6.2831853;
    float ca = cos(angle);
    float sa = sin(angle);
    vec2 offset = vec2(position.x * maj, position.y * minr);
    offset = vec2(offset.x * ca - offset.y * sa, offset.x * sa + offset.y * ca);

    vec3 world = (modelMatrix * vec4(instanceCenter * shellRadius, 1.0)).xyz;
    if (horizonCut > 0.5) {
      vRadiance *= smoothstep(-0.03, 0.01, normalize(world).y);
    }
    vec4 viewCenter = viewMatrix * vec4(world, 1.0);
    // tan(theta) ~ theta at these angular scales
    vec3 viewPos = viewCenter.xyz + vec3(offset * shellRadius, 0.0);

    vUv = position.xy;
    vClass = instanceClass;
    vSeed = hash(instanceCenter.yzx + 3.7);
    gl_Position = projectionMatrix * vec4(viewPos, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  varying float vClass;
  varying float vRadiance;
  varying float vMarker;
  varying float vSeed;

  uniform float markerOpacity;
  uniform float clusterOpacity;

  float vhash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(vhash(i), vhash(i + vec2(1.0, 0.0)), u.x),
      mix(vhash(i + vec2(0.0, 1.0)), vhash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 5; i++) {
      sum += amp * vnoise(p);
      p *= 2.03;
      amp *= 0.5;
    }
    return sum;
  }

  vec3 classTint(float c) {
    if (c < 0.5) return vec3(1.00, 0.93, 0.80);   // galaxies: old stellar light
    if (c < 1.5) return vec3(1.00, 0.95, 0.86);   // globulars
    if (c < 2.5) return vec3(0.80, 0.90, 1.00);   // open clusters: young + blue
    if (c < 3.5) return vec3(0.45, 1.00, 0.85);   // planetary nebulae: OIII
    if (c < 4.5) return vec3(1.00, 0.52, 0.52);   // emission nebulae: H-alpha
    if (c < 5.5) return vec3(0.60, 0.74, 1.00);   // reflection nebulae
    if (c < 6.5) return vec3(0.35, 0.28, 0.26);   // dark nebulae
    if (c < 7.5) return vec3(0.62, 0.95, 1.00);   // supernova remnants
    return vec3(0.88, 0.92, 1.00);
  }

  float ring(float d, float r, float w) {
    return exp(-pow((d - r) / w, 2.0));
  }

  void main() {
    float d = length(vUv);
    if (d > 1.0) discard;

    vec2 q = vUv * 2.3 + vSeed * 31.0;

    float profile;
    if (vClass < 0.5) {
      // de Vaucouleurs-ish bulge plus an exponential disc, mottled just enough
      // that a magnified galaxy is not a bare gradient.
      profile = exp(-7.0 * pow(d, 0.35)) * 2.2 + exp(-d * 4.0) * 0.55;
      profile *= 0.82 + 0.36 * fbm(q * 1.7);
    } else if (vClass < 1.5) {
      profile = exp(-pow(d * 2.3, 1.6)) * 1.5 + exp(-d * 5.5) * 0.4;
    } else if (vClass < 2.5) {
      // A thin outline. Anything heavier competes with the member stars it is
      // supposed to be pointing at.
      profile = ring(d, 0.9, 0.05) * 0.5;
    } else if (vClass < 3.5) {
      profile = ring(d, 0.55, 0.30) * 1.5 + exp(-d * d * 6.0) * 0.5;
    } else if (vClass < 6.5) {
      // Turbulent cloud. The falloff sets the overall shape while warped noise
      // supplies the filaments and dark lanes, so the object still looks like
      // gas when it is magnified to fill the frame.
      float turb = fbm(q);
      float fil = fbm(q * 3.3 + turb * 1.6);
      float core = exp(-pow(d * 1.75, 1.7)) + exp(-pow(d * 3.4, 2.0)) * 0.5;
      float texture_ = 0.30 + 1.30 * pow(turb, 1.7) + 0.60 * pow(fil, 3.0);
      profile = core * texture_;
    } else {
      profile = ring(d, 0.7, 0.26) * 0.9 + exp(-d * 3.5) * 0.2;
    }

    // Clouds get a wide fade so the quad's oval boundary never reads as an edge.
    float fadeStart = (vClass > 3.5 && vClass < 6.5) ? 0.45 : 0.85;
    float edge = 1.0 - smoothstep(fadeStart, 1.0, d);
    vec3 color = classTint(vClass) * vRadiance * profile * edge;
    color *= mix(1.0, markerOpacity, vMarker);

    // Open cluster rings mark stars that the catalogue layer already draws, so
    // they only earn their clutter once the field is narrow enough to need them.
    if (vClass > 1.5 && vClass < 2.5) color *= clusterOpacity;

    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * Deep sky catalogue as one instanced draw call. Objects are billboarded in
 * view space and sized by their real angular dimensions, with a minimum
 * on-screen size so they remain findable when zoomed out.
 */
export class DeepSkyLayer {
  constructor(records, { shellRadius = 90 } = {}) {
    this.records = records;
    const count = records.length;

    const centers = new Float32Array(count * 3);
    const radii = new Float32Array(count * 2);
    const mags = new Float32Array(count);
    const classes = new Float32Array(count);
    const ranks = new Float32Array(count);

    this.positions = [];
    for (let i = 0; i < count; i++) {
      const r = records[i];
      centers[i * 3] = r.p[0];
      centers[i * 3 + 1] = r.p[1];
      centers[i * 3 + 2] = r.p[2];
      radii[i * 2] = r.rMaj;
      radii[i * 2 + 1] = r.rMin;
      mags[i] = r.mag;
      classes[i] = CLASS_INDEX[r.cls] ?? 8;
      ranks[i] = r.rank ?? r.mag;
      this.positions.push(new Vector3(r.p[0], r.p[1], r.p[2]));
    }
    this.magnitudes = mags;
    this.classes = classes;
    this.ranks = ranks;

    const geometry = new InstancedBufferGeometry();
    // Shared (non-instanced) unit quad; every instance reuses these 4 corners.
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('instanceCenter', new InstancedBufferAttribute(centers, 3));
    geometry.setAttribute('instanceRadius', new InstancedBufferAttribute(radii, 2));
    geometry.setAttribute('instanceMag', new InstancedBufferAttribute(mags, 1));
    geometry.setAttribute('instanceClass', new InstancedBufferAttribute(classes, 1));
    geometry.setAttribute('instanceRank', new InstancedBufferAttribute(ranks, 1));
    geometry.instanceCount = count;
    // Instances are placed in the vertex shader, so derived bounds would be
    // meaningless; a fixed sphere covering the shell is both correct and free.
    geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), shellRadius * 1.5);
    geometry.computeBoundingSphere = () => {};

    this.material = new ShaderMaterial({
      uniforms: {
        shellRadius: { value: shellRadius },
        radPerPixel: { value: 0.001 },
        minPixels: { value: 2.2 },
        limitMagnitude: { value: 6.2 },
        surfaceRefMagnitude: { value: 6.35 },
        surfaceGain: { value: 160 },
        pointGain: { value: 0.05 },
        knee: { value: 12 },
        clusterSymbol: { value: 0 },
        fovRadians: { value: 1 },
        horizonCut: { value: 0 },
        markerOpacity: { value: 0.6 },
        clusterOpacity: { value: 1 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      blending: AdditiveBlending,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.name = 'deep-sky';
    this.geometry = geometry;
  }

  setClusterMarkers(enabled) {
    this.material.uniforms.clusterSymbol.value = enabled ? 0.16 : 0;
  }

  update({ limitMagnitude, surfaceRefMagnitude, radPerPixel, fovDegrees = 60, horizonCut = false }) {
    const u = this.material.uniforms;
    u.horizonCut.value = horizonCut ? 1 : 0;
    u.limitMagnitude.value = limitMagnitude;
    u.surfaceRefMagnitude.value = surfaceRefMagnitude;
    u.radPerPixel.value = radPerPixel;
    u.fovRadians.value = (fovDegrees * Math.PI) / 180;
    u.clusterOpacity.value = fovDegrees < 32 ? 1 : Math.max(0, (45 - fovDegrees) / 13);

    // Records are sorted by visibility rank, so a prefix covers everything
    // that could be visible at this depth.
    const cutoff = limitMagnitude + 1.2;
    let lo = 0;
    let hi = this.ranks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ranks[mid] <= cutoff) lo = mid + 1;
      else hi = mid;
    }
    this.geometry.instanceCount = lo;
    this.visibleCount = lo;
  }
}
