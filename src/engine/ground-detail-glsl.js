/**
 * Ground detail at the scale of a person standing on it, from photo-scanned
 * ground and rock (ambientCG, CC0; packed by scripts/build-ground-textures.py).
 * Brightness and relief only: the colour stays the planet's own.
 *
 * Everything else in the terrain is built from the unit direction, which in
 * single float is good to about a ten-millionth of a radian — tens of
 * centimetres on a planet. That is fine for mountains and useless for a pebble,
 * so this layer is built from metres counted from the render anchor instead:
 * an integer cell (`uDetailCell`, exact) plus a fractional remainder
 * (`uDetailFrac`), with the fragment's own offset added to the remainder only.
 * The textures are laid on a 1024 m block taken from the integer part by a
 * shift, and every scale repeats a whole number of times across it, so the
 * pattern a point gets does not depend on where the anchor happens to be.
 *
 * The caller passes metres with the land's height taken out, so the pattern
 * sits on the point's place on the map and not on how high the mesh under the
 * current level of detail puts it there.
 */
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  TextureLoader,
} from 'three';

const flat = () => {
  const texture = new DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1);
  texture.needsUpdate = true;
  return texture;
};
const placeholder = { tone: flat(), normal: flat() };
const waiting = [];
let loaded = null;

function loadAll() {
  loaded = {};
  const loader = new TextureLoader();
  for (const kind of ['tone', 'normal']) {
    loader.load(`textures/ground/ground-${kind}.webp`, (texture) => {
      texture.wrapS = texture.wrapT = RepeatWrapping;
      texture.colorSpace = NoColorSpace;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.magFilter = LinearFilter;
      texture.anisotropy = 8;
      loaded[kind] = texture;
      for (const uniforms of waiting) uniforms[kind === 'tone' ? 'uGroundTone' : 'uGroundNormal'].value = texture;
    });
  }
}

/** Uniforms for the ground textures: a flat stand-in until the photos arrive. */
export function groundTextureUniforms() {
  if (!loaded) loadAll();
  const uniforms = {
    uGroundTone: { value: loaded.tone ?? placeholder.tone },
    uGroundNormal: { value: loaded.normal ?? placeholder.normal },
  };
  waiting.push(uniforms);
  return uniforms;
}

export const GROUND_DETAIL_GLSL = /* glsl */ `
  uniform ivec3 uDetailCell;
  uniform vec3 uDetailFrac;
  uniform float uRockDensity;
  // How stony the soil is, for worlds of fine dust or ice.
  uniform float uStones;
  // Rows: the ground plane's along, across and up, in the body frame.
  uniform mat3 uMapBasis;
  // The render anchor's place on that plane, metres, wrapped to 1024.
  uniform vec3 uMapFrac;
  // R ground tone, G rock tone, B ground height, A rock height.
  uniform sampler2D uGroundTone;
  // RG ground normal, BA rock normal.
  uniform sampler2D uGroundNormal;

  // Lattice of 2^k metres: integer cell base and position within it.
  void detailLattice(int k, vec3 metres, out ivec3 base, out vec3 q) {
    if (k >= 0) {
      base = uDetailCell >> k;
      ivec3 rem = uDetailCell - (base << k);
      q = (vec3(rem) + metres) / float(1 << k);
    } else {
      base = uDetailCell << (-k);
      q = metres * float(1 << (-k));
    }
  }

  // One scale of both materials, projected along whichever body axes face
  // the ground. Returns ground tone, ground height, rock tone, rock height,
  // and the two materials' slopes, rise over run in the body frame.
  // A tile repeated across open ground shows as a grid. Each tile instead
  // takes one of eight offsets, picked by a slowly wandering value and
  // cross-faded where it changes, with the gradients of the unshifted
  // coordinates so the fade does not show as a seam in the mip level.
  void unrepeated(vec2 uv, float pick, out vec4 tone, out vec4 nrm) {
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    float l = pick * 8.0;
    float ia = floor(l);
    float f = fract(l);
    vec2 offA = sin(vec2(3.0, 7.0) * ia);
    vec2 offB = sin(vec2(3.0, 7.0) * (ia + 1.0));
    vec4 toneA = textureGrad(uGroundTone, uv + offA, dx, dy);
    vec4 toneB = textureGrad(uGroundTone, uv + offB, dx, dy);
    float blend = smoothstep(0.2, 0.8, f - 0.3 * (toneA.b - toneB.b));
    tone = mix(toneA, toneB, blend);
    nrm = mix(textureGrad(uGroundNormal, uv + offA, dx, dy), textureGrad(uGroundNormal, uv + offB, dx, dy), blend);
  }

  vec4 groundLayer(vec3 block, vec3 w, float tiles, out vec3 groundSlope, out vec3 rockSlope) {
    // The wandering value: the soil's own height, blurred and spread over
    // about nine tiles.
    float pick = textureLod(uGroundTone, block.xy * tiles * 0.11 + 0.37, 3.0).b * 2.0;
    vec4 tone = vec4(0.0);
    groundSlope = vec3(0.0);
    rockSlope = vec3(0.0);
    for (int a = 0; a < 3; a++) {
      float wa = a == 0 ? w.x : a == 1 ? w.y : w.z;
      if (wa < 0.02) continue;
      vec2 uv = (a == 0 ? block.yz : a == 1 ? block.zx : block.xy) * tiles;
      vec4 t, n;
      unrepeated(uv, pick, t, n);
      n = n * 2.0 - 1.0;
      tone += vec4(t.r, t.b, t.g, t.a) * wa;
      vec2 g = -n.xy, r = -n.zw;
      groundSlope += wa * (a == 0 ? vec3(0.0, g) : a == 1 ? vec3(g.y, 0.0, g.x) : vec3(g, 0.0));
      rockSlope += wa * (a == 0 ? vec3(0.0, r) : a == 1 ? vec3(r.y, 0.0, r.x) : vec3(r, 0.0));
    }
    return tone;
  }

  float fadeBelow(float fp, float tileM) {
    return 1.0 - smoothstep(tileM * 0.12, tileM * 0.4, fp);
  }

  /**
   * Adds the detail to a lit point: tilts the normal and returns the factor
   * the albedo takes. fp is the pixel footprint in metres; past a scale's own
   * mip chain it has nothing left to add, so it is skipped there.
   */
  float groundDetail(vec3 dir, vec3 rel, float heightM, float fp, float weight, inout vec3 normal) {
    // Along, across and up on the map plane. Flat ground reads from the first
    // two with the land's height taken out, so it sits on the point's place on
    // the map and not on how high the current level of detail puts the mesh.
    vec3 local = uMapBasis * rel;
    vec2 across = local.xy - (uMapBasis * dir).xy * heightM;
    vec3 block = (uMapFrac + vec3(across, local.z)) / 1024.0;
    // Projections by how squarely each axis meets the surface, sharpened so
    // most of the ground reads from one of them; cliffs from the side.
    vec3 w = pow(abs(uMapBasis * normal), vec3(6.0));
    w /= w.x + w.y + w.z;

    // Bare rock on the steep ground and in outcrops between, broken up by
    // the materials' own heights so the edge follows the stones.
    float steep = 1.0 - clamp(dot(normal, dir), 0.0, 1.0);
    float rockBias = smoothstep(0.08, 0.3, steep);

    float groundFactor = 1.0;
    float rockFactor = 1.0;
    vec3 groundSlope = vec3(0.0);
    vec3 rockSlope = vec3(0.0);
    float groundH = 0.5, rockH = 0.5;
    // Tiles per 1024 m: soil at its own size, 2 m, and again at 10.6 m for
    // broad light and dark only, which breaks up the repeat without blowing
    // the stones up to boulders; rock at 4 m, 28 m, 146 m and 512 m, the
    // larger for the faces of mountains seen from far off.
    const float SOIL[2] = float[2](512.0, 97.0);
    const float ROCK[4] = float[4](256.0, 37.0, 7.0, 2.0);
    float stony = mix(0.45, 1.0, uStones);
    for (int i = 0; i < 2; i++) {
      float f = fadeBelow(fp, 1024.0 / SOIL[i]) * weight;
      if (f < 0.01) continue;
      vec3 gs, rs;
      vec4 t = groundLayer(block, w, SOIL[i], gs, rs);
      groundFactor *= 1.0 + (t.x * 2.0 - 1.0) * f * stony * (i == 0 ? 1.0 : 0.35);
      groundSlope += gs * f * stony * (i == 0 ? 0.6 : 0.12);
      if (i == 0) groundH = mix(0.5, t.y, f);
    }
    for (int i = 0; i < 4; i++) {
      float f = fadeBelow(fp, 1024.0 / ROCK[i]) * weight;
      if (f < 0.01) continue;
      vec3 gs, rs;
      vec4 t = groundLayer(block, w, ROCK[i], gs, rs);
      rockFactor *= 1.0 + (t.z * 2.0 - 1.0) * f * 0.8;
      rockSlope += rs * f * (i == 0 ? 0.9 : 0.6);
      if (i == 1) rockH = mix(0.5, t.w, f);
    }
    float rock = smoothstep(0.35, 0.65, rockBias + (rockH - groundH) * 0.6 - 0.1 + uRockDensity * 0.1);

    vec3 slope = transpose(uMapBasis) * mix(groundSlope, rockSlope, rock);
    vec3 tangential = slope - dot(slope, dir) * dir;
    normal = normalize(normal - tangential * 0.8);
    // Rock is a touch darker than the soil it sheds.
    return mix(groundFactor, rockFactor * 0.85, rock);
  }
`;
