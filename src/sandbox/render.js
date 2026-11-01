import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { HEAT_W, HEAT_H, isStar, isHole } from './physics.js';
import { RENDER_SCALE as S, blackbody, AU, L_SUN } from './constants.js';
import { bodyTexture, proceduralTexture, skyTexture, glowTexture } from './textures.js';

const GLSL_HEAT = /* glsl */ `
vec3 bbColor(float T) {
  T = clamp(T, 800.0, 30000.0) / 100.0;
  float r = T <= 66.0 ? 1.0 : clamp(1.2929 * pow(T - 60.0, -0.1332), 0.0, 1.0);
  float g = T <= 66.0 ? clamp(0.3901 * log(T) - 0.6318, 0.0, 1.0) : clamp(1.1298 * pow(T - 60.0, -0.0755), 0.0, 1.0);
  float b = T >= 66.0 ? 1.0 : (T <= 19.0 ? 0.0 : clamp(0.5432 * log(T - 10.0) - 1.1963, 0.0, 1.0));
  return pow(vec3(r, g, b), vec3(2.2));
}
float heatGlow(float T) {
  return smoothstep(750.0, 1500.0, T) * (0.3 + 0.9 * smoothstep(1500.0, 5000.0, T));
}
`;

const TRAIL_N = 500;
const ORBIT_N = 180;
const SPHERE = new THREE.SphereGeometry(1, 72, 36);
const SPHERE_LO = new THREE.SphereGeometry(1, 32, 16);
const ROCK = new THREE.IcosahedronGeometry(1, 1);

function lin(c) {
  return new THREE.Color(c[0], c[1], c[2]);
}

function normColor(rgb, scale = 1) {
  const m = Math.max(rgb[0], rgb[1], rgb[2], 1e-6);
  return [(rgb[0] / m) * scale, (rgb[1] / m) * scale, (rgb[2] / m) * scale];
}

function pointsMaterial(additive = true) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {},
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float size;
      attribute vec4 rgba;
      attribute float ring;
      varying vec4 vColor;
      varying float vRing;
      void main() {
        vColor = rgba;
        vRing = ring;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = size;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec4 vColor;
      varying float vRing;
      void main() {
        #include <logdepthbuf_fragment>
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r = length(p);
        if (r > 1.0) discard;
        float a;
        if (vRing > 0.5) {
          a = smoothstep(1.0, 0.82, r) * smoothstep(0.52, 0.7, r);
        } else {
          a = pow(max(1.0 - r, 0.0), 1.6);
        }
        gl_FragColor = vec4(vColor.rgb, vColor.a * a);
      }`,
  });
}

class PointLayer {
  constructor(scene, additive, cap = 1024) {
    this.scene = scene;
    this.additive = additive;
    this.material = pointsMaterial(additive);
    this.alloc(cap);
  }

  alloc(cap) {
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
    }
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.rgba = new Float32Array(cap * 4);
    this.size = new Float32Array(cap);
    this.ring = new Float32Array(cap);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('rgba', new THREE.BufferAttribute(this.rgba, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('ring', new THREE.BufferAttribute(this.ring, 1).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.scene.add(this.points);
    this.n = 0;
  }

  begin() {
    this.n = 0;
  }

  push(x, y, z, r, g, b, a, size, ring = 0) {
    if (this.n >= this.cap) this.grow();
    const i = this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.rgba[i * 4] = r;
    this.rgba[i * 4 + 1] = g;
    this.rgba[i * 4 + 2] = b;
    this.rgba[i * 4 + 3] = a;
    this.size[i] = size;
    this.ring[i] = ring;
  }

  grow() {
    const old = { pos: this.pos, rgba: this.rgba, size: this.size, ring: this.ring, n: this.n };
    this.alloc(this.cap * 2);
    this.pos.set(old.pos);
    this.rgba.set(old.rgba);
    this.size.set(old.size);
    this.ring.set(old.ring);
    this.n = old.n;
  }

  end() {
    const g = this.points.geometry;
    g.setDrawRange(0, this.n);
    for (const k of ['position', 'rgba', 'size', 'ring']) g.attributes[k].needsUpdate = true;
  }
}

export class Renderer {
  constructor(canvas, labelLayer) {
    this.canvas = canvas;
    this.labelLayer = labelLayer;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.pr = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.pr);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 1e-6, 1e18);
    this.camera.position.set(0, 0, 0);
    this.scene.add(this.camera);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.55, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.ambient = new THREE.AmbientLight(0xffffff, 0.05);
    this.scene.add(this.ambient);
    this.lights = [];
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 0, 0);
      this.scene.add(l);
      this.lights.push(l);
    }

    this.buildSky();
    this.views = new Map();
    this.trails = new Map();
    this.orbits = new Map();
    this.labels = new Map();
    this.flashes = [];
    this.zones = new Map();

    this.rockCap = 0;
    this.allocRocks(2048);
    this.glow = new PointLayer(this.scene, true, 2048);
    this.markers = new PointLayer(this.scene, false, 256);

    this.buildGrid();
    this.buildTools();
    this.trailRefId = undefined;
    this.resize();
  }

  // ---------------------------------------------------------------------------
  // Static scenery

  buildSky() {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1e16, 64, 32),
      new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, depthWrite: false, color: new THREE.Color(0.55, 0.55, 0.6) }),
    );
    sky.renderOrder = -10;
    // The galactic plane tilted against the ecliptic, roughly as it is.
    sky.rotation.set(-1.05, 0.0, 0.42);
    this.sky = sky;
    this.scene.add(sky);

    const n = 5000;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const z = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      pos[i * 3] = s * Math.cos(t) * 5e15;
      pos[i * 3 + 1] = z * 5e15;
      pos[i * 3 + 2] = s * Math.sin(t) * 5e15;
      const temp = 3000 + Math.pow(Math.random(), 2) * 15000;
      const c = normColor(blackbody(temp), 0.35 + Math.pow(Math.random(), 6) * 1.4);
      col.set(c, i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.starfield = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false, transparent: true }));
    this.starfield.renderOrder = -9;
    this.scene.add(this.starfield);
  }

  buildGrid() {
    const pts = [];
    const seg = 128;
    for (let r = 1; r <= 10; r++) {
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2;
        const a1 = ((i + 1) / seg) * Math.PI * 2;
        pts.push(Math.cos(a0) * r, 0, Math.sin(a0) * r, Math.cos(a1) * r, 0, Math.sin(a1) * r);
      }
    }
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      pts.push(Math.cos(a) * 1, 0, Math.sin(a) * 1, Math.cos(a) * 10, 0, Math.sin(a) * 10);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.grids = [0, 1].map(() => {
      const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x6f8fb8, transparent: true, opacity: 0.12, depthWrite: false }));
      m.frustumCulled = false;
      this.scene.add(m);
      return m;
    });
  }

  buildTools() {
    this.ghost = new THREE.Mesh(SPHERE_LO, new THREE.MeshBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.35, wireframe: true, depthWrite: false }));
    this.ghost.visible = false;
    this.scene.add(this.ghost);
    const lineMat = (color, opacity = 0.8) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    this.ghostLine = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), lineMat(0x8fd3ff, 0.5));
    this.ghostOrbit = new THREE.LineLoop(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(128 * 3), 3)), lineMat(0x8fd3ff, 0.35));
    this.arrow = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), lineMat(0xffd24a, 0.95));
    this.beam = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), new THREE.LineBasicMaterial({ color: new THREE.Color(4, 0.4, 0.3), transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }));
    for (const o of [this.ghostLine, this.ghostOrbit, this.arrow, this.beam]) {
      o.visible = false;
      o.frustumCulled = false;
      this.scene.add(o);
    }
    this.beamGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(6, 1.2, 0.6), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.beamGlow.visible = false;
    this.scene.add(this.beamGlow);
  }

  allocRocks(cap) {
    if (this.rocks) {
      this.scene.remove(this.rocks);
      this.rocks.dispose();
    }
    this.rockCap = cap;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, color: 0xffffff });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aHeat;\nvarying float vHeat;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeat = aHeat;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vHeat;\n${GLSL_HEAT}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          diffuseColor.rgb *= mix(1.0, 0.35, smoothstep(700.0, 1500.0, vHeat));
          totalEmissiveRadiance += bbColor(vHeat) * heatGlow(vHeat) + diffuseColor.rgb * 0.04;`);
    };
    this.rockHeat = new Float32Array(cap);
    const geo = ROCK.clone();
    geo.setAttribute('aHeat', new THREE.InstancedBufferAttribute(this.rockHeat, 1).setUsage(THREE.DynamicDrawUsage));
    this.rocks = new THREE.InstancedMesh(geo, mat, cap);
    this.rocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rocks.setColorAt(0, new THREE.Color(1, 1, 1));
    this.rocks.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.rocks.frustumCulled = false;
    this.rocks.count = 0;
    this.scene.add(this.rocks);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------------------
  // Per-body views

  makeView(b) {
    const group = new THREE.Group();
    const tilt = new THREE.Group();
    const spin = new THREE.Group();
    group.add(tilt);
    tilt.add(spin);
    this.scene.add(group);
    const v = { group, tilt, spin, kind: b.kind, key: viewKey(b) };

    if (isHole(b)) {
      v.core = new THREE.Mesh(SPHERE_LO, new THREE.MeshBasicMaterial({ color: 0x000000 }));
      group.add(v.core);
      v.ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), color: new THREE.Color(2.2, 1.6, 1.1), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      group.add(v.ring);
      v.disk = new THREE.Mesh(radialRing(3, 18), new THREE.MeshBasicMaterial({ map: diskTexture(), color: new THREE.Color(3, 1.4, 0.6), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      v.disk.rotation.x = -Math.PI / 2;
      tilt.add(v.disk);
    } else if (isStar(b)) {
      const map = b.kind === 'star' || b.kind === 'giant' ? bodyTexture('sun-colour') : null;
      v.mat = new THREE.MeshBasicMaterial({ map, color: 0xffffff });
      v.mesh = new THREE.Mesh(SPHERE, v.mat);
      spin.add(v.mesh);
      v.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      group.add(v.halo);
    } else {
      const map = b.tex ? bodyTexture(b.tex) : b.proc ? proceduralTexture(b.proc) : null;
      v.mat = new THREE.MeshStandardMaterial({ map, color: map ? 0xffffff : lin(b.color), roughness: 0.92, metalness: 0 });
      v.heatData = new Uint8Array(HEAT_W * HEAT_H);
      v.heatTex = new THREE.DataTexture(v.heatData, HEAT_W, HEAT_H, THREE.RedFormat, THREE.UnsignedByteType);
      v.heatTex.magFilter = THREE.LinearFilter;
      v.heatTex.minFilter = THREE.LinearFilter;
      v.heatTex.wrapS = THREE.RepeatWrapping;
      v.heatTex.needsUpdate = true;
      v.heatVersion = -1;
      v.sunDir = { value: new THREE.Vector3(1, 0, 0) };
      v.nightOn = { value: b.night ? 1 : 0 };
      if (b.night) {
        v.mat.emissiveMap = bodyTexture(b.night);
        v.mat.emissive = new THREE.Color(1, 0.82, 0.55);
        v.mat.emissiveIntensity = 1.2;
      }
      const heatTex = v.heatTex;
      v.mat.onBeforeCompile = (shader) => {
        shader.uniforms.heatMap = { value: heatTex };
        shader.uniforms.sunDirV = v.sunDir;
        shader.uniforms.nightOn = v.nightOn;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec2 vHeatUv;')
          .replace('#include <uv_vertex>', '#include <uv_vertex>\nvHeatUv = uv;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nuniform sampler2D heatMap;\nuniform vec3 sunDirV;\nuniform float nightOn;\nvarying vec2 vHeatUv;\n${GLSL_HEAT}`)
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
            float hT = texture2D(heatMap, vHeatUv).r * 5000.0;
            float dark = smoothstep(0.12, -0.25, dot(normal, sunDirV));
            totalEmissiveRadiance *= dark * nightOn * (1.0 - smoothstep(320.0, 600.0, hT));
            float tl = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
            float crack = 0.5 + 0.5 * sin(vHeatUv.x * 211.0 + sin(vHeatUv.y * 97.0) * 3.0) * sin(vHeatUv.y * 157.0 + sin(vHeatUv.x * 131.0) * 2.0);
            float melt = smoothstep(1800.0, 4200.0, hT);
            float lava = mix(smoothstep(0.55, 1.0, crack) * 1.6 + 0.12, 1.0, melt) * mix(0.55, 1.5, smoothstep(0.05, 0.55, tl));
            diffuseColor.rgb *= mix(1.0, 0.22, smoothstep(600.0, 1500.0, hT));
            totalEmissiveRadiance += bbColor(hT) * heatGlow(hT) * lava;`);
      };
      v.mesh = new THREE.Mesh(SPHERE, v.mat);
      spin.add(v.mesh);
    }
    this.views.set(b.id, v);
    return v;
  }

  syncDecor(b, v) {
    // Clouds, atmosphere and rings come and go with the body's state.
    if (b.clouds && !v.clouds) {
      v.clouds = new THREE.Mesh(SPHERE, new THREE.MeshStandardMaterial({ color: 0xffffff, alphaMap: bodyTexture(b.clouds, { color: false }), transparent: true, depthWrite: false, roughness: 1 }));
      v.clouds.scale.setScalar(1.006);
      v.spin.add(v.clouds);
    } else if (!b.clouds && v.clouds) {
      v.spin.remove(v.clouds);
      v.clouds = null;
    }
    if (b.atmo && !v.atmo) {
      v.atmoMat = atmosphereMaterial(b.atmo);
      v.atmo = new THREE.Mesh(SPHERE_LO, v.atmoMat);
      v.atmo.scale.setScalar(b.comp.gas > 0.5 ? 1.012 : 1.03);
      v.tilt.add(v.atmo);
    } else if (!b.atmo && v.atmo) {
      v.tilt.remove(v.atmo);
      v.atmo = null;
    }
    if (b.rings && !v.rings) {
      const inner = b.rings.inner / b.radius;
      const outer = b.rings.outer / b.radius;
      const geo = new THREE.RingGeometry(inner, outer, 160, 1);
      const pos = geo.attributes.position;
      const uv = geo.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getY(i));
        uv.setXY(i, (r - inner) / (outer - inner), 0.5);
      }
      const tex = bodyTexture(b.rings.tex);
      v.rings = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, roughness: 1, depthWrite: false, alphaTest: 0.02 }));
      v.rings.rotation.x = -Math.PI / 2;
      v.tilt.add(v.rings);
    } else if (!b.rings && v.rings) {
      v.tilt.remove(v.rings);
      v.rings = null;
    }
  }

  disposeView(id, v) {
    this.scene.remove(v.group);
    v.heatTex?.dispose();
    this.views.delete(id);
  }

  // ---------------------------------------------------------------------------
  // Frame

  /** Pixels per render unit at render-space distance d. */
  pxPerUnit(d) {
    return this.height / (2 * Math.tan((this.camera.fov * Math.PI) / 360) * Math.max(d, 1e-9));
  }

  update(sim, cam, view, state) {
    const cx = cam.pos[0];
    const cy = cam.pos[1];
    const cz = cam.pos[2];
    this.cam = cam;
    const camera = this.camera;
    camera.fov = cam.fov;
    camera.updateProjectionMatrix();
    const tx = (cam.target[0] - cx) * S;
    const ty = (cam.target[1] - cy) * S;
    const tz = (cam.target[2] - cz) * S;
    camera.up.set(0, 1, 0);
    camera.lookAt(tx, ty, tz);
    camera.updateMatrixWorld();
    const viewInv = camera.matrixWorldInverse;

    sim.refreshLists();
    const majors = sim.majors;
    const minors = sim.minors;
    const seen = new Set();

    // Lights: the four stars that light the camera's target the most.
    const stars = majors.filter((b) => b.lum > 0);
    const ranked = stars
      .map((s) => ({ s, f: s.lum / ((s.x - cam.target[0]) ** 2 + (s.y - cam.target[1]) ** 2 + (s.z - cam.target[2]) ** 2 + 1) }))
      .sort((a, b) => b.f - a.f);
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const r = ranked[i];
      if (!r) {
        l.intensity = 0;
        continue;
      }
      l.position.set((r.s.x - cx) * S, (r.s.y - cy) * S, (r.s.z - cz) * S);
      const c = normColor(blackbody(r.s.temp));
      l.color.setRGB(c[0], c[1], c[2]);
      l.intensity = i === 0 ? 3.2 : 3.2 * Math.min(1, Math.sqrt(r.f / ranked[0].f) * 1.5);
    }
    this.ambient.intensity = view.lighting === 'flat' ? 1.4 : 0.05;

    const tmp = new THREE.Vector3();
    this.markers.begin();
    this.glow.begin();

    for (const b of majors) {
      let v = this.views.get(b.id);
      if (v && v.key !== viewKey(b)) {
        this.disposeView(b.id, v);
        v = null;
      }
      if (!v) v = this.makeView(b);
      seen.add(b.id);
      const px = (b.x - cx) * S;
      const py = (b.y - cy) * S;
      const pz = (b.z - cz) * S;
      v.group.position.set(px, py, pz);
      const d = Math.hypot(px, py, pz);
      const ppu = this.pxPerUnit(d);
      const R = b.radius * S;
      const projR = R * ppu;
      b._projR = projR;

      if (isHole(b)) {
        const coreR = Math.max(R, 3.5 / ppu);
        v.core.scale.setScalar(coreR);
        const ringR = Math.max(R * 5.4, 15 / ppu);
        v.ring.scale.setScalar(ringR);
        v.disk.scale.setScalar(Math.max(R, 4 / ppu));
        v.disk.material.opacity = Math.min(1, (b.feed || 0) * 1.5);
        v.disk.visible = (b.feed || 0) > 0.01;
        v.tilt.rotation.x = b.tilt;
      } else if (isStar(b)) {
        v.mesh.scale.setScalar(R);
        v.tilt.rotation.x = b.tilt;
        v.spin.rotation.y = b.spinAngle;
        const c = normColor(blackbody(b.temp), b.kind === 'neutron' ? 6 : 2.2);
        v.mat.color.setRGB(c[0], c[1], c[2]);
        const lumBoost = Math.min(3, Math.max(0.6, 1 + 0.12 * Math.log10(b.lum / L_SUN + 1e-9)));
        v.halo.scale.setScalar(Math.max(R * 7, (38 * lumBoost) / ppu));
        v.halo.material.color.setRGB(c[0] * 0.75, c[1] * 0.75, c[2] * 0.75);
      } else {
        this.syncDecor(b, v);
        v.mesh.scale.setScalar(R);
        if (v.clouds) {
          v.clouds.scale.setScalar(R * 1.006);
          v.clouds.rotation.y += 0.00002;
        }
        if (v.atmo) {
          v.atmo.scale.setScalar(R * (b.comp.gas > 0.5 ? 1.012 : 1.03));
          v.atmoMat.uniforms.strength.value = b.atmo.strength;
        }
        if (v.rings) v.rings.scale.setScalar(R);
        v.tilt.rotation.x = b.tilt;
        v.spin.rotation.y = b.spinAngle;
        // Heat map upload.
        if (v.heatVersion !== b.heatVersion && b.heat) {
          const data = v.heatData;
          const heat = b.heat;
          for (let k = 0; k < data.length; k++) data[k] = Math.min(255, (heat[k] / 5000) * 255);
          v.heatTex.needsUpdate = true;
          v.heatVersion = b.heatVersion;
        }
        // Direction to the brightest light, in view space, for night lights and the atmosphere.
        const src = ranked[0]?.s;
        if (src) {
          tmp.set(src.x - b.x, src.y - b.y, src.z - b.z).normalize().transformDirection(viewInv);
          v.sunDir.value.copy(tmp);
          if (v.atmoMat) v.atmoMat.uniforms.sunDirV.value.copy(tmp);
        }
        v.mat.color.set(b.tex || b.proc ? 0xffffff : lin(b.color));
      }

      // Marker for anything too small to see as a disc.
      const sel = state.selected === b.id;
      const hover = state.hover === b.id;
      if (view.markers && projR < 4 && !isStar(b)) {
        const c = b.color;
        this.markers.push(px, py, pz, Math.min(1, c[0] * 1.3 + 0.2), Math.min(1, c[1] * 1.3 + 0.2), Math.min(1, c[2] * 1.3 + 0.2), 0.75, 9 * this.pr, 1);
      }
      if (sel || hover) {
        const s = Math.max(projR * 2 + 14, 22) * this.pr;
        this.markers.push(px, py, pz, 0.45, 0.8, 1, sel ? 0.95 : 0.5, Math.min(s, 2000), 1);
      }
      if (b.comet) this.cometTail(b, ranked[0]?.s, px, py, pz, ppu);
    }

    for (const [id, v] of this.views) if (!seen.has(id)) this.disposeView(id, v);

    // Minor bodies: rocks are instanced meshes, plasma and stars are glows.
    let rn = 0;
    const need = minors.length;
    if (need > this.rockCap) this.allocRocks(Math.max(need, this.rockCap * 2));
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const color = new THREE.Color();
    const axis = new THREE.Vector3(0.3, 1, 0.2).normalize();
    for (const b of minors) {
      const px = (b.x - cx) * S;
      const py = (b.y - cy) * S;
      const pz = (b.z - cz) * S;
      const d = Math.hypot(px, py, pz);
      const ppu = this.pxPerUnit(d);
      if (b.kind === 'plasma') {
        const f = Math.min(1, (b.temp - 900) / 9000);
        const c = normColor(blackbody(b.temp), 1.6 * f);
        this.glow.push(px, py, pz, c[0], c[1], c[2], 0.9, 7 * this.pr);
        continue;
      }
      if (b.kind === 'starp') {
        const c = normColor(blackbody(b.temp), 0.5);
        this.glow.push(px, py, pz, c[0], c[1], c[2], 0.7, 2.4 * this.pr);
        continue;
      }
      const r = Math.max(b.radius * S, 1.3 / ppu);
      tmp.set(px, py, pz);
      q.setFromAxisAngle(axis, b.spinAngle + b.id);
      scl.setScalar(r);
      m4.compose(tmp, q, scl);
      this.rocks.setMatrixAt(rn, m4);
      color.setRGB(b.color[0], b.color[1], b.color[2]);
      this.rocks.setColorAt(rn, color);
      this.rockHeat[rn] = b.temp;
      rn++;
      if (b.temp > 1300 && b.radius * S * ppu < 3) {
        const c = normColor(blackbody(b.temp), Math.min(1.5, (b.temp - 1200) / 1500));
        this.glow.push(px, py, pz, c[0], c[1], c[2], 0.8, 4 * this.pr);
      }
      if (state.selected === b.id) {
        this.markers.push(px, py, pz, 0.45, 0.8, 1, 0.95, 22 * this.pr, 1);
      }
    }
    this.rocks.count = rn;
    this.rocks.instanceMatrix.needsUpdate = true;
    if (this.rocks.instanceColor) this.rocks.instanceColor.needsUpdate = true;
    this.rocks.geometry.attributes.aHeat.needsUpdate = true;

    this.updateTrails(sim, cam, view, state);
    this.updateOrbits(sim, cam, view);
    this.updateGrid(cam, view);
    this.updateZones(sim, cam, view, stars);
    this.updateFlashes(sim, cam, state.dtReal);
    this.updateLabels(sim, cam, view, state);

    this.markers.end();
    this.glow.end();
    this.bloom.enabled = view.bloom;
    this.sky.visible = view.background;
    this.starfield.visible = view.background;
    this.composer.render();
  }

  cometTail(b, star, px, py, pz, ppu) {
    if (!star) return;
    const dx = b.x - star.x;
    const dy = b.y - star.y;
    const dz = b.z - star.z;
    const d = Math.hypot(dx, dy, dz);
    const au = d / AU;
    if (au > 6) return;
    const len = Math.min(3e10, (1.5e10 / (au * au)) * Math.sqrt(star.lum / L_SUN)) * S;
    const steps = 14;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const k = (len * t) / d;
      const a = (1 - t) * Math.min(1, 1.5 / au);
      this.glow.push(px + dx * k, py + dy * k, pz + dz * k, 0.55 * a, 0.75 * a, 1 * a, 0.8, Math.max(4, 14 * (1 - t)) * this.pr);
    }
    void ppu;
  }

  updateTrails(sim, cam, view, state) {
    const ref = cam.trailRef ? sim.byId(cam.trailRef) : null;
    const refId = ref ? ref.id : 0;
    if (refId !== this.trailRefId || state.resetTrails) {
      for (const t of this.trails.values()) this.scene.remove(t.line);
      this.trails.clear();
      this.trailRefId = refId;
    }
    const rx = ref ? ref.x : 0;
    const ry = ref ? ref.y : 0;
    const rz = ref ? ref.z : 0;
    const alive = new Set();
    for (const b of sim.majors) {
      if (b === ref) continue;
      alive.add(b.id);
      let t = this.trails.get(b.id);
      if (!t) {
        const geo = new THREE.BufferGeometry();
        const pos = new Float32Array(TRAIL_N * 3);
        const col = new Float32Array(TRAIL_N * 4);
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
        line.frustumCulled = false;
        this.scene.add(line);
        t = { line, buf: new Float64Array(TRAIL_N * 3), n: 0, head: 0, lastT: -Infinity };
        this.trails.set(b.id, t);
      }
      if (state.simAdvanced) {
        const ox = b.x - rx;
        const oy = b.y - ry;
        const oz = b.z - rz;
        let push = true;
        if (t.n > 0) {
          const li = ((t.head - 1 + TRAIL_N) % TRAIL_N) * 3;
          const step = Math.hypot(ox - t.buf[li], oy - t.buf[li + 1], oz - t.buf[li + 2]);
          push = step > b.radius * 0.5;
        }
        if (push) {
          t.buf[t.head * 3] = ox;
          t.buf[t.head * 3 + 1] = oy;
          t.buf[t.head * 3 + 2] = oz;
          t.head = (t.head + 1) % TRAIL_N;
          t.n = Math.min(TRAIL_N, t.n + 1);
        }
      }
      t.line.visible = view.trails && t.n > 1;
      if (!t.line.visible) continue;
      const pos = t.line.geometry.attributes.position.array;
      const col = t.line.geometry.attributes.color.array;
      const c = b.color;
      for (let i = 0; i < t.n; i++) {
        const k = ((t.head - t.n + i + TRAIL_N) % TRAIL_N) * 3;
        pos[i * 3] = (t.buf[k] + rx - cam.pos[0]) * S;
        pos[i * 3 + 1] = (t.buf[k + 1] + ry - cam.pos[1]) * S;
        pos[i * 3 + 2] = (t.buf[k + 2] + rz - cam.pos[2]) * S;
        const a = (i / t.n) ** 1.5 * 0.85;
        col[i * 4] = Math.min(1, c[0] * 1.2 + 0.15);
        col[i * 4 + 1] = Math.min(1, c[1] * 1.2 + 0.15);
        col[i * 4 + 2] = Math.min(1, c[2] * 1.2 + 0.15);
        col[i * 4 + 3] = a;
      }
      t.line.geometry.setDrawRange(0, t.n);
      t.line.geometry.attributes.position.needsUpdate = true;
      t.line.geometry.attributes.color.needsUpdate = true;
    }
    for (const [id, t] of this.trails) {
      if (!alive.has(id)) {
        this.scene.remove(t.line);
        this.trails.delete(id);
      }
    }
  }

  updateOrbits(sim, cam, view) {
    const alive = new Set();
    if (view.orbits) {
      for (const b of sim.majors) {
        if (isHole(b) && b.mass > 1e36) continue;
        const el = sim.orbitalElements(b);
        if (!el || !el.bound || el.a > 1e22) continue;
        alive.add(b.id);
        let o = this.orbits.get(b.id);
        if (!o) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ORBIT_N * 3), 3).setUsage(THREE.DynamicDrawUsage));
          const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.32, depthWrite: false }));
          line.frustumCulled = false;
          this.scene.add(line);
          o = { line };
          this.orbits.set(b.id, o);
        }
        const c = b.color;
        o.line.material.color.setRGB(Math.min(1, c[0] + 0.25), Math.min(1, c[1] + 0.25), Math.min(1, c[2] + 0.25));
        const { a, e, h, evec, parent } = el;
        const hl = Math.hypot(...h) || 1;
        const hx = h[0] / hl;
        const hy = h[1] / hl;
        const hz = h[2] / hl;
        let px;
        let py;
        let pz;
        if (e > 1e-7) {
          px = evec[0] / e;
          py = evec[1] / e;
          pz = evec[2] / e;
        } else {
          px = (b.x - parent.x) / el.r;
          py = (b.y - parent.y) / el.r;
          pz = (b.z - parent.z) / el.r;
        }
        const qx = hy * pz - hz * py;
        const qy = hz * px - hx * pz;
        const qz = hx * py - hy * px;
        const pos = o.line.geometry.attributes.position.array;
        const p = a * (1 - e * e);
        for (let i = 0; i < ORBIT_N; i++) {
          const th = (i / ORBIT_N) * Math.PI * 2;
          const r = p / (1 + e * Math.cos(th));
          const ct = Math.cos(th) * r;
          const st = Math.sin(th) * r;
          pos[i * 3] = (parent.x + px * ct + qx * st - cam.pos[0]) * S;
          pos[i * 3 + 1] = (parent.y + py * ct + qy * st - cam.pos[1]) * S;
          pos[i * 3 + 2] = (parent.z + pz * ct + qz * st - cam.pos[2]) * S;
        }
        o.line.geometry.attributes.position.needsUpdate = true;
        o.line.visible = true;
      }
    }
    for (const [id, o] of this.orbits) {
      if (!alive.has(id)) {
        this.scene.remove(o.line);
        o.line.geometry.dispose();
        this.orbits.delete(id);
      }
    }
  }

  updateGrid(cam, view) {
    const dist = Math.hypot(cam.pos[0] - cam.target[0], cam.pos[1] - cam.target[1], cam.pos[2] - cam.target[2]);
    const l = Math.log10(Math.max(dist, 1) / 4);
    const base = Math.floor(l);
    const frac = l - base;
    for (let i = 0; i < 2; i++) {
      const g = this.grids[i];
      g.visible = view.grid;
      if (!view.grid) continue;
      const spacing = Math.pow(10, base + i);
      g.position.set((cam.target[0] - cam.pos[0]) * S, (cam.target[1] - cam.pos[1]) * S, (cam.target[2] - cam.pos[2]) * S);
      g.scale.setScalar(spacing * S);
      g.material.opacity = 0.16 * (i === 0 ? 1 - frac : frac);
    }
  }

  updateZones(sim, cam, view, stars) {
    const alive = new Set();
    if (view.habitable) {
      for (const s of stars) {
        if (s.kind === 'neutron') continue;
        alive.add(s.id);
        let z = this.zones.get(s.id);
        if (!z) {
          z = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.37, 128, 1), new THREE.MeshBasicMaterial({ color: 0x3bd16f, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
          z.rotation.x = -Math.PI / 2;
          this.scene.add(z);
          this.zones.set(s.id, z);
        }
        z.position.set((s.x - cam.pos[0]) * S, (s.y - cam.pos[1]) * S, (s.z - cam.pos[2]) * S);
        z.scale.setScalar(Math.sqrt(s.lum / L_SUN) * AU * S);
      }
    }
    for (const [id, z] of this.zones) {
      if (!alive.has(id)) {
        this.scene.remove(z);
        this.zones.delete(id);
      }
    }
  }

  addFlash(ev) {
    const big = ev.type === 'supernova';
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(),
      color: big ? new THREE.Color(2.6, 2.2, 1.9) : new THREE.Color(2.2, 1.25, 0.55),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }));
    this.scene.add(sprite);
    const strength = Math.max(0.3, Math.min(3, Math.log10(Math.max(ev.energy, 1)) / 12 - 1.5));
    this.flashes.push({ sprite, x: ev.x, y: ev.y, z: ev.z, size: ev.size * (big ? 4 : 3), age: 0, life: big ? 3.5 : 1.2 + strength * 0.4, strength, big });
  }

  updateFlashes(sim, cam, dt) {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.age += dt;
      const t = f.age / f.life;
      if (t >= 1) {
        this.scene.remove(f.sprite);
        f.sprite.material.dispose();
        this.flashes.splice(i, 1);
        continue;
      }
      const px = (f.x - cam.pos[0]) * S;
      const py = (f.y - cam.pos[1]) * S;
      const pz = (f.z - cam.pos[2]) * S;
      f.sprite.position.set(px, py, pz);
      const ppu = this.pxPerUnit(Math.hypot(px, py, pz));
      const grow = f.big ? 0.3 + t * 3 : 0.6 + t * 1.2;
      const want = Math.max(f.size * S * grow, ((f.big ? 260 : 40) * f.strength * grow) / ppu);
      const capPx = f.big ? this.height * 0.9 : 110 * Math.min(1.5, f.strength);
      f.sprite.scale.setScalar(Math.min(want, capPx / ppu));
      f.sprite.material.opacity = f.big ? (1 - t) ** 3 : (1 - t) ** 2;
    }
  }

  updateLabels(sim, cam, view, state) {
    const layer = this.labelLayer;
    const alive = new Set();
    if (view.labels) {
      const occupied = [];
      const v = new THREE.Vector3();
      const list = [...sim.majors].sort((a, b) => (b.id === state.selected) - (a.id === state.selected) || b.mass - a.mass);
      for (const b of list) {
        v.set((b.x - cam.pos[0]) * S, (b.y - cam.pos[1]) * S, (b.z - cam.pos[2]) * S);
        v.applyMatrix4(this.camera.matrixWorldInverse);
        if (v.z > 0) continue;
        v.applyMatrix4(this.camera.projectionMatrix);
        const x = (v.x * 0.5 + 0.5) * this.width;
        const y = (-v.y * 0.5 + 0.5) * this.height;
        if (x < -50 || x > this.width + 50 || y < -20 || y > this.height + 20) continue;
        const r = Math.min(b._projR || 0, 4000);
        const lx = x + Math.max(r * 0.72, 7) + 4;
        const ly = y - Math.max(r * 0.72, 0) - 8;
        if (occupied.some((o) => Math.abs(o[0] - lx) < 60 && Math.abs(o[1] - ly) < 13) && b.id !== state.selected) continue;
        occupied.push([lx, ly]);
        alive.add(b.id);
        let el = this.labels.get(b.id);
        if (!el) {
          el = document.createElement('div');
          el.className = 'sb-label';
          layer.appendChild(el);
          this.labels.set(b.id, el);
        }
        if (el.textContent !== b.name) el.textContent = b.name;
        el.style.transform = `translate(${lx.toFixed(1)}px, ${ly.toFixed(1)}px)`;
        el.classList.toggle('is-selected', b.id === state.selected);
      }
    }
    for (const [id, el] of this.labels) {
      if (!alive.has(id)) {
        el.remove();
        this.labels.delete(id);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tools overlay

  setGhost(g) {
    const show = !!g;
    this.ghost.visible = show;
    this.ghostLine.visible = show && !!g.parent;
    this.ghostOrbit.visible = show && !!g.orbitR;
    if (!show || !this.cam) return;
    const c = this.cam.pos;
    const gx = (g.pos[0] - c[0]) * S;
    const gy = (g.pos[1] - c[1]) * S;
    const gz = (g.pos[2] - c[2]) * S;
    this.ghost.position.set(gx, gy, gz);
    const ppu = this.pxPerUnit(Math.hypot(gx, gy, gz));
    this.ghost.scale.setScalar(Math.max(g.radius * S, 6 / ppu));
    this.ghost.material.color.setRGB(g.color[0] * 0.6 + 0.4, g.color[1] * 0.6 + 0.4, g.color[2] * 0.6 + 0.4);
    if (g.parent) {
      const a = this.ghostLine.geometry.attributes.position.array;
      a.set([gx, gy, gz, (g.parent[0] - c[0]) * S, (g.parent[1] - c[1]) * S, (g.parent[2] - c[2]) * S]);
      this.ghostLine.geometry.attributes.position.needsUpdate = true;
    }
    if (g.orbitR) {
      const a = this.ghostOrbit.geometry.attributes.position.array;
      const n = a.length / 3;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        a[i * 3] = (g.parent[0] + Math.cos(t) * g.orbitR - c[0]) * S;
        a[i * 3 + 1] = (g.parent[1] - c[1]) * S;
        a[i * 3 + 2] = (g.parent[2] + Math.sin(t) * g.orbitR - c[2]) * S;
      }
      this.ghostOrbit.geometry.attributes.position.needsUpdate = true;
    }
  }

  setArrow(from, to) {
    this.arrow.visible = !!from;
    if (!from || !this.cam) return;
    const c = this.cam.pos;
    this.arrow.geometry.attributes.position.array.set([
      (from[0] - c[0]) * S, (from[1] - c[1]) * S, (from[2] - c[2]) * S,
      (to[0] - c[0]) * S, (to[1] - c[1]) * S, (to[2] - c[2]) * S,
    ]);
    this.arrow.geometry.attributes.position.needsUpdate = true;
  }

  setBeam(hit) {
    this.beam.visible = !!hit;
    this.beamGlow.visible = !!hit;
    if (!hit || !this.cam) return;
    const c = this.cam.pos;
    const hx = (hit[0] - c[0]) * S;
    const hy = (hit[1] - c[1]) * S;
    const hz = (hit[2] - c[2]) * S;
    // The beam leaves from just below and right of the eye.
    const start = new THREE.Vector3(0.35, -0.4, -1).applyMatrix4(this.camera.matrixWorld);
    const d = Math.hypot(hx, hy, hz);
    start.multiplyScalar(Math.min(d * 0.05, 1));
    this.beam.geometry.attributes.position.array.set([start.x, start.y, start.z, hx, hy, hz]);
    this.beam.geometry.attributes.position.needsUpdate = true;
    this.beamGlow.position.set(hx, hy, hz);
    this.beamGlow.scale.setScalar(26 / this.pxPerUnit(d));
  }

  // ---------------------------------------------------------------------------
  // Picking

  /** World-space (double) ray direction through screen point (x, y). */
  ray(x, y) {
    const v = new THREE.Vector3((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1, 0.5);
    v.unproject(this.camera);
    v.normalize();
    return [v.x, v.y, v.z];
  }

  project(b) {
    const v = new THREE.Vector3((b.x - this.cam.pos[0]) * S, (b.y - this.cam.pos[1]) * S, (b.z - this.cam.pos[2]) * S);
    const d = v.length();
    v.applyMatrix4(this.camera.matrixWorldInverse);
    if (v.z > 0) return null;
    v.applyMatrix4(this.camera.projectionMatrix);
    return {
      x: (v.x * 0.5 + 0.5) * this.width,
      y: (-v.y * 0.5 + 0.5) * this.height,
      r: b.radius * S * this.pxPerUnit(d),
      d,
    };
  }

  pick(sim, x, y, { minorsToo = true } = {}) {
    let best = null;
    let bestScore = Infinity;
    const list = minorsToo ? sim.bodies : sim.majors;
    for (const b of list) {
      if (b.dead) continue;
      const p = this.project(b);
      if (!p) continue;
      const hitR = Math.max(p.r, b.minor ? 6 : 12);
      const dd = Math.hypot(p.x - x, p.y - y);
      if (dd > hitR) continue;
      const score = (dd / hitR) * (b.minor ? 1.6 : 1) + (dd < p.r ? -1 + p.d * 1e-12 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best;
  }

  /** Where the ray through (x, y) first meets body b's sphere, as a world point, or null. */
  hitSphere(b, x, y) {
    const d = this.ray(x, y);
    const o = this.cam.pos;
    const ox = o[0] - b.x;
    const oy = o[1] - b.y;
    const oz = o[2] - b.z;
    const B = ox * d[0] + oy * d[1] + oz * d[2];
    const C = ox * ox + oy * oy + oz * oz - b.radius * b.radius;
    const disc = B * B - C;
    if (disc < 0) return null;
    const t = -B - Math.sqrt(disc);
    if (t < 0) return null;
    return [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  }
}

function radialRing(inner, outer) {
  const geo = new THREE.RingGeometry(inner, outer, 128, 1);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, (Math.hypot(pos.getX(i), pos.getY(i)) - inner) / (outer - inner), 0.5);
  }
  return geo;
}

function viewKey(b) {
  return `${b.kind}:${b.tex}:${b.proc ? b.proc.type + b.proc.seed : ''}:${b.night}`;
}

function atmosphereMaterial(atmo) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      color: { value: lin(atmo.color) },
      strength: { value: atmo.strength },
      sunDirV: { value: new THREE.Vector3(1, 0, 0) },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 color;
      uniform float strength;
      uniform vec3 sunDirV;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 n = normalize(vN);
        float rim = 1.0 - max(dot(n, normalize(vV)), 0.0);
        float day = smoothstep(-0.3, 0.45, dot(n, sunDirV));
        float a = pow(rim, 2.6) * strength * (0.08 + 0.92 * day) * 1.4;
        gl_FragColor = vec4(color * a, a);
      }`,
  });
}

let ringTex = null;
function ringTexture() {
  if (ringTex) return ringTex;
  const s = 256;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.3, 'rgba(0,0,0,0)');
  g.addColorStop(0.36, 'rgba(255,240,220,1)');
  g.addColorStop(0.42, 'rgba(255,200,150,0.35)');
  g.addColorStop(0.7, 'rgba(255,180,120,0.06)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  ringTex = new THREE.CanvasTexture(canvas);
  return ringTex;
}

let diskTex = null;
function diskTexture() {
  if (diskTex) return diskTex;
  const w = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = 8;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.15, 'rgba(255,210,150,0.9)');
  g.addColorStop(0.5, 'rgba(255,120,50,0.35)');
  g.addColorStop(1, 'rgba(255,60,20,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, 8);
  diskTex = new THREE.CanvasTexture(canvas);
  return diskTex;
}
