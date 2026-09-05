import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { craftExtent, craftGeometry, createCraftMaterial } from './craft-models.js';

/**
 * Drawing the spacecraft.
 *
 * A spacecraft is between one and a hundred metres across in a scene that runs
 * out to billions of kilometres, so for almost every viewpoint it is far below
 * one pixel. Two representations cover that range and hand over to each other:
 *
 *   marker   A small point, one vertex in a single shared buffer, for craft
 *            that are too small to draw. All the markers in the scene are one
 *            draw call. They are deliberately dim and small: a spacecraft is
 *            not a star, and turning it into a glowing blob would make the
 *            Solar System look like it is full of them.
 *
 *   mesh     The model, once it covers enough pixels to be worth drawing. Made
 *            on first approach and kept, since the geometry is shared per model
 *            and the mesh itself is a few hundred bytes.
 *
 * The marker fades out over the same range the mesh fades in, so there is no
 * frame where a craft is both a dot and a model, and none where it is neither.
 *
 * Only craft close enough to matter get a mesh, so a hundred spacecraft cost a
 * hundred points and typically zero to three meshes.
 */

const MAX_MARKERS = 256;

// A craft starts being drawn as geometry at this apparent size and the marker
// is gone by the upper bound. Below a pixel there is nothing a mesh can show
// that a point cannot.
const MESH_FADE_IN = 1.2;
const MESH_FADE_OUT = 3.5;

const MARKER_VERTEX = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float size;
  attribute float alpha;
  attribute vec3 tint;
  uniform float uPixelRatio;
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    vAlpha = alpha;
    vTint = tint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(size * uPixelRatio, 1.0, 7.0);
    #include <logdepthbuf_vertex>
  }
`;

const MARKER_FRAGMENT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    // A hard little dot with a soft edge, not a glow.
    float core = smoothstep(1.0, 0.35, r);
    gl_FragColor = vec4(vTint * core, core * vAlpha);
  }
`;

function createMarkers() {
  const positions = new Float32Array(MAX_MARKERS * 3);
  const tints = new Float32Array(MAX_MARKERS * 3);
  const sizes = new Float32Array(MAX_MARKERS);
  const alphas = new Float32Array(MAX_MARKERS);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('tint', new BufferAttribute(tints, 3));
  geometry.setAttribute('size', new BufferAttribute(sizes, 1));
  geometry.setAttribute('alpha', new BufferAttribute(alphas, 1));

  const material = new ShaderMaterial({
    uniforms: { uPixelRatio: { value: 1 } },
    vertexShader: MARKER_VERTEX,
    fragmentShader: MARKER_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 5;
  points.name = 'craft-markers';

  let count = 0;
  return {
    object: points,
    begin() { count = 0; },
    add(rel, rgb, size, alpha) {
      if (count >= MAX_MARKERS) return;
      const i = count++;
      positions[i * 3] = rel.x;
      positions[i * 3 + 1] = rel.y;
      positions[i * 3 + 2] = rel.z;
      tints[i * 3] = rgb[0];
      tints[i * 3 + 1] = rgb[1];
      tints[i * 3 + 2] = rgb[2];
      sizes[i] = size;
      alphas[i] = alpha;
    },
    end(pixelRatio) {
      material.uniforms.uPixelRatio.value = pixelRatio;
      geometry.setDrawRange(0, count);
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.tint.needsUpdate = true;
      geometry.attributes.size.needsUpdate = true;
      geometry.attributes.alpha.needsUpdate = true;
      points.visible = count > 0;
    },
  };
}

/** Marker colour by craft kind, so a rover reads differently from a station. */
const KIND_TINT = {
  station: [0.75, 0.86, 1.0],
  telescope: [0.72, 0.94, 0.9],
  orbiter: [0.95, 0.85, 0.6],
  probe: [1.0, 0.78, 0.5],
  flyby: [1.0, 0.7, 0.55],
  rover: [0.95, 0.72, 0.62],
  lander: [0.9, 0.78, 0.68],
  capsule: [0.8, 0.9, 1.0],
  stage: [0.65, 0.66, 0.7],
  satellite: [0.7, 0.82, 0.95],
  debris: [0.6, 0.6, 0.62],
};

function tintFor(kind) {
  return KIND_TINT[kind] ?? [0.85, 0.85, 0.9];
}

/**
 * The trajectory of one craft.
 *
 * Past and future are one line with a colour ramp rather than two lines, so
 * there is no seam at the present, and the vertex buffer is rebuilt from
 * float64 world positions each frame because the camera is the origin.
 */
function createTrajectory() {
  const geometry = new BufferGeometry();
  const material = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    opacity: 0.85,
  });
  const line = new Line(geometry, material);
  line.frustumCulled = false;
  line.visible = false;
  line.renderOrder = 3;
  line.name = 'craft-trajectory';

  let source = null;
  let scratch = null;
  let colours = null;

  return {
    object: line,
    /** Adopts a new path. `points` is float64 absolute world km. */
    set(path) {
      source = path;
      if (!path) {
        line.visible = false;
        return;
      }
      const n = path.points.length / 3;
      if (!scratch || scratch.length !== path.points.length) {
        scratch = new Float32Array(path.points.length);
        colours = new Float32Array(path.points.length);
        geometry.setAttribute('position', new BufferAttribute(scratch, 3));
        geometry.setAttribute('color', new BufferAttribute(colours, 3));
      }
      for (let i = 0; i < n; i++) {
        // Flown path bright, path still to come dimmer: the same line, so the
        // present is a gradient rather than a join.
        const flown = i <= path.split;
        const f = flown ? 1 : 0.32;
        colours[i * 3] = 0.55 * f + 0.1;
        colours[i * 3 + 1] = 0.78 * f + 0.1;
        colours[i * 3 + 2] = 0.95 * f + 0.12;
      }
      geometry.attributes.color.needsUpdate = true;
    },
    rebase(cameraWorld) {
      if (!source) return;
      const p = source.points;
      const n = p.length;
      for (let i = 0; i < n; i += 3) {
        scratch[i] = p[i] - cameraWorld.x;
        scratch[i + 1] = p[i + 1] - cameraWorld.y;
        scratch[i + 2] = p[i + 2] - cameraWorld.z;
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.computeBoundingSphere();
      line.visible = true;
    },
    clear() {
      source = null;
      line.visible = false;
    },
  };
}

/** A short line showing where a craft is going and how fast. */
function createVelocityVector() {
  const geometry = new BufferGeometry();
  const positions = new Float32Array(6);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const material = new LineBasicMaterial({
    color: 0xffcc66, transparent: true, opacity: 0.9, depthWrite: false,
  });
  const line = new Line(geometry, material);
  line.frustumCulled = false;
  line.visible = false;
  line.name = 'craft-velocity';
  return {
    object: line,
    set(rel, velocity, lengthKm) {
      const v = velocity.length();
      if (v < 1e-9 || !(lengthKm > 0)) { line.visible = false; return; }
      positions[0] = rel.x;
      positions[1] = rel.y;
      positions[2] = rel.z;
      positions[3] = rel.x + (velocity.x / v) * lengthKm;
      positions[4] = rel.y + (velocity.y / v) * lengthKm;
      positions[5] = rel.z + (velocity.z / v) * lengthKm;
      geometry.attributes.position.needsUpdate = true;
      geometry.computeBoundingSphere();
      line.visible = true;
    },
    clear() { line.visible = false; },
  };
}

export function createCraftRenderer(field) {
  const group = new Group();
  group.name = 'craft';
  const meshGroup = new Group();
  const markers = createMarkers();
  const trajectory = createTrajectory();
  const velocity = createVelocityVector();
  const material = createCraftMaterial();

  group.add(meshGroup);
  group.add(markers.object);
  group.add(trajectory.object);
  group.add(velocity.object);

  const meshes = new Map();
  // Last frame's level-of-detail decision per craft, so the check harness can
  // ask what was drawn rather than inferring it from the scene graph.
  const detail = new Map();
  const rel = new Vector3();
  const sunView = new Vector3();
  const viewRotation = new Quaternion();
  const visible = [];
  let trajectoryKey = null;

  function meshFor(state) {
    let mesh = meshes.get(state.key);
    if (mesh) return mesh;
    const geometry = craftGeometry(state.spec.model);
    mesh = new Mesh(geometry, material);
    // Models are built in metres and the scene is kilometres, and the model is
    // stretched or shrunk to the craft's real longest dimension on the way, so
    // what is drawn is the size the mission record says it is.
    const extent = craftExtent(state.spec.model);
    const sizeM = state.spec.sizeM ?? extent;
    mesh.scale.setScalar((extent > 1e-6 ? sizeM / extent : 1) * 0.001);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.name = `craft-${state.key}`;
    meshes.set(state.key, mesh);
    meshGroup.add(mesh);
    return mesh;
  }

  return {
    object: group,
    material,

    /**
     * Places every spacecraft for this frame and decides how each is drawn.
     *
     * `pixelsPerRadian` converts an angular size into pixels, which is the only
     * honest way to decide detail: a rover a kilometre away and a space station
     * four hundred kilometres away want the same treatment if they cover the
     * same part of the screen.
     *
     * `frame` is the body the camera is anchored to and its exact offset from
     * that body's centre, when there is one. Craft in that body's frame are
     * placed from it rather than by subtracting two absolute positions, which is
     * the difference between standing next to a probe and standing inside it.
     */
    update({
      universe, cameraWorld, camera, pixelsPerRadian, pixelRatio = 1,
      selectedKey = null, showTrajectories = true, showCraft = true, showVectors = true, date,
      frame = null,
    }) {
      group.visible = showCraft;
      visible.length = 0;
      detail.clear();
      if (!showCraft) {
        markers.begin();
        markers.end(pixelRatio);
        for (const mesh of meshes.values()) mesh.visible = false;
        trajectory.clear();
        velocity.clear();
        return visible;
      }

      // Sunlight direction in view space, since the material has no light. The
      // camera sits at the origin, so its world rotation inverted is all that
      // is needed to get from world into view.
      sunView.copy(cameraWorld).negate().normalize();
      viewRotation.copy(camera.quaternion).invert();
      sunView.applyQuaternion(viewRotation);
      material.uniforms.uSunDirView.value.copy(sunView);

      markers.begin();
      for (const mesh of meshes.values()) mesh.visible = false;

      for (const state of field.list) {
        if (!state.present) continue;
        if (frame && frame.key && state.centreKey === frame.key) {
          rel.copy(state.local).sub(frame.offset);
        } else {
          rel.copy(state.position).sub(cameraWorld);
        }
        const distance = rel.length();
        if (!(distance > 0)) continue;
        const sizeKm = (state.spec.sizeM ?? 5) / 1000;
        const apparent = (sizeKm / distance) * pixelsPerRadian;

        visible.push({ state, distance, apparent });

        const meshFade = smooth(apparent, MESH_FADE_IN, MESH_FADE_OUT);
        if (meshFade > 0.01) {
          const mesh = meshFor(state);
          mesh.visible = true;
          mesh.position.copy(rel);
          mesh.quaternion.copy(state.orientation);
        }
        const markerAlpha = (1 - meshFade) * 0.85;
        detail.set(state.key, { distance, apparent, meshFade, markerAlpha });
        if (markerAlpha > 0.01) {
          const selected = state.key === selectedKey;
          markers.add(
            rel,
            tintFor(state.spec.kind),
            selected ? 5 : 2.6,
            selected ? Math.max(markerAlpha, 0.55) : markerAlpha,
          );
        }
      }
      markers.end(pixelRatio);

      // Trajectory and velocity vector, for the selected craft only. Drawing
      // every craft's path at once is unreadable and expensive; drawing one is
      // the thing that is actually useful.
      if (showTrajectories && selectedKey && field.hasPath(selectedKey)) {
        if (trajectoryKey !== selectedKey) {
          trajectory.set(field.trajectory(selectedKey, date, universe));
          trajectoryKey = selectedKey;
        }
        trajectory.rebase(cameraWorld);
        const state = field.get(selectedKey);
        if (state?.present) {
          if (frame && frame.key && state.centreKey === frame.key) {
            rel.copy(state.local).sub(frame.offset);
          } else {
            rel.copy(state.position).sub(cameraWorld);
          }
          if (showVectors) velocity.set(rel, state.velocity, Math.max(distanceScale(rel.length()), 0));
          else velocity.clear();
        } else {
          velocity.clear();
        }
      } else {
        trajectory.clear();
        velocity.clear();
        trajectoryKey = null;
      }

      material.uniforms.uFade.value = 1;
      return visible;
    },

    /** Forces the trajectory to be rebuilt, after a date or target change. */
    invalidateTrajectory() {
      trajectoryKey = null;
    },

    /**
     * Releases the meshes of craft that no longer exist, which is what happens
     * when a procedural system is unloaded. The geometry is shared per model and
     * stays; only the instances go.
     */
    forget(keys) {
      for (const key of keys) {
        const mesh = meshes.get(key);
        if (!mesh) continue;
        meshGroup.remove(mesh);
        meshes.delete(key);
        detail.delete(key);
        if (trajectoryKey === key) trajectoryKey = null;
      }
    },

    /** How a craft was drawn last frame: apparent size and the two fade weights. */
    detailFor(key) {
      return detail.get(key) ?? null;
    },

    dispose() {
      for (const mesh of meshes.values()) meshGroup.remove(mesh);
      meshes.clear();
      material.dispose();
    },
  };
}

/** Velocity arrows scale with viewing distance so they stay legible. */
function distanceScale(distanceKm) {
  return distanceKm * 0.12;
}

function smooth(x, a, b) {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
