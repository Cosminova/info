/**
 * Ground detail at the scale of a person standing on it, from photo-scanned
 * ground and rock (ambientCG, CC0; packed by scripts/build-ground-textures.py).
 * Brightness and relief only: the colour stays the planet's own.
 *
 * Everything else in the terrain is built from the unit direction, which in
 * single float is good to about a ten-millionth of a radian — tens of
 * centimetres on a planet. That is fine for mountains and useless for a pebble,
 * so this layer uses metre offsets on a local tangent plane. Its anchor is
 * projected in CPU double precision, then wrapped to a block before
 * adding the fragment's small offset. The enhanced preset uses 8192 m and
 * periodic modulation to keep its mountain-scale layers stable; other worlds
 * keep their existing 1024 m mapping and material response.
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
  uniform float uGroundRelief;
  // How stony the soil is, for worlds of fine dust or ice.
  uniform float uStones;
  // Rows: the ground plane's along, across and up, in the body frame.
  uniform mat3 uMapBasis;
  // The render anchor's place on that plane, metres, wrapped to 8192.
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
  void unrepeated(vec2 uv, float pick, vec2 parallax, out vec4 tone, out vec4 nrm) {
    vec2 dx = dFdx(uv), dy = dFdy(uv);
    float l = pick * 8.0;
    float ia = floor(l);
    float f = fract(l);
    vec2 offA = sin(vec2(3.0, 7.0) * ia);
    vec2 offB = sin(vec2(3.0, 7.0) * (ia + 1.0));
    // Two bounded relief iterations, only for nearby primary material layers.
    // Keep the original gradients: parallax must not corrupt mip selection.
    if (dot(parallax, parallax) > 1e-10) {
      vec2 rayUv = uv;
      for (int i = 0; i < 2; i++) {
        vec4 h = mix(textureGrad(uGroundTone, uv + offA, dx, dy),
                     textureGrad(uGroundTone, uv + offB, dx, dy), smoothstep(0.2, 0.8, f));
        uv = rayUv + parallax * (mix(h.b, h.a, 0.5) - 0.5);
      }
    }
    vec4 toneA = textureGrad(uGroundTone, uv + offA, dx, dy);
    vec4 toneB = textureGrad(uGroundTone, uv + offB, dx, dy);
    float blend = smoothstep(0.2, 0.8, f - 0.3 * (toneA.b - toneB.b));
    tone = mix(toneA, toneB, blend);
    nrm = mix(textureGrad(uGroundNormal, uv + offA, dx, dy), textureGrad(uGroundNormal, uv + offB, dx, dy), blend);
  }

  vec4 groundLayer(vec3 block, vec3 w, float tiles, vec3 viewLocal, float relief, out vec3 groundSlope, out vec3 rockSlope) {
    // The wandering value: the soil's own height, blurred and spread over
    // eight tiles.
    float pick = textureLod(uGroundTone, block.xy * tiles * mix(0.11, 0.125, uGroundRelief) + 0.37, 3.0).b * 2.0;
    vec4 tone = vec4(0.0);
    groundSlope = vec3(0.0);
    rockSlope = vec3(0.0);
    for (int a = 0; a < 3; a++) {
      float wa = a == 0 ? w.x : a == 1 ? w.y : w.z;
      if (wa < 0.02) continue;
      vec2 uv = (a == 0 ? block.yz : a == 1 ? block.zx : block.xy) * tiles;
      vec4 t, n;
      vec2 alongView = a == 0 ? viewLocal.yz : a == 1 ? viewLocal.zx : viewLocal.xy;
      float facing = abs(a == 0 ? viewLocal.x : a == 1 ? viewLocal.y : viewLocal.z);
      vec2 shift = alongView / max(facing, 0.3) * relief;
      if (tiles < 1.0) {
        // A mountain-scale tile does not visibly repeat in a walking view.
        // Avoid the doubled anti-tiling samples on these broad layers.
        t = textureGrad(uGroundTone, uv, dFdx(uv), dFdy(uv));
        n = textureGrad(uGroundNormal, uv, dFdx(uv), dFdy(uv));
      } else {
        unrepeated(uv, pick, shift, t, n);
      }
      n = n * 2.0 - 1.0;
      tone += vec4(t.r, t.b, t.g, t.a) * wa;
      // XY stores a unit normal, not a height gradient. Reconstruct Z before
      // converting to rise/run, bounded to avoid sparkling at sharp cracks.
      vec2 g = -n.xy / mix(1.0, max(sqrt(max(1.0 - dot(n.xy, n.xy), 0.0)), 0.45), uGroundRelief);
      vec2 r = -n.zw / mix(1.0, max(sqrt(max(1.0 - dot(n.zw, n.zw), 0.0)), 0.45), uGroundRelief);
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
  float groundDetail(vec3 dir, vec3 rel, float heightM, float fp, float weight, vec3 view, inout vec3 normal) {
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
    float rockBias = smoothstep(mix(0.08, 0.025, uGroundRelief), mix(0.3, 0.19, uGroundRelief), steep);
    vec3 viewLocal = uMapBasis * view;
    float closeRelief = uGroundRelief * (1.0 - smoothstep(0.006, 0.035, fp)) * weight;

    float groundFactor = 1.0;
    float rockFactor = 1.0;
    vec3 groundSlope = vec3(0.0);
    vec3 rockSlope = vec3(0.0);
    float groundH = 0.5, rockH = 0.5;
    // Tiles per 1024 m: soil at its own size, 2 m, and again at 10.6 m for
    // broad light and dark only, which breaks up the repeat without blowing
    // the stones up to boulders; rock at 4 m, 28 m, 146 m and 512 m, the
    // larger for the faces of mountains seen from far off. Gliese adds
    // 2 km and 8 km layers to carry weathering onto the broad slopes.
    const float SOIL[2] = float[2](512.0, 97.0);
    const float ROCK[6] = float[6](256.0, 37.0, 7.0, 2.0, 0.5, 0.125);
    float stony = mix(0.45, 1.0, uStones);
    for (int i = 0; i < 2; i++) {
      float f = fadeBelow(fp, 1024.0 / SOIL[i]) * weight;
      if (f < 0.01) continue;
      vec3 gs, rs;
      vec4 t = groundLayer(block, w, SOIL[i], viewLocal, i == 0 ? closeRelief * 0.035 : 0.0, gs, rs);
      groundFactor *= 1.0 + (t.x * 2.0 - 1.0) * f * stony * (i == 0 ? 1.0 : 0.35);
      groundSlope += gs * f * stony * (i == 0 ? 0.6 : 0.12);
      if (i == 0) groundH = mix(0.5, t.y, f);
    }
    for (int i = 0; i < 6; i++) {
      if (i >= 4 && uGroundRelief < 0.01) break;
      float f = fadeBelow(fp, 1024.0 / ROCK[i]) * weight;
      if (f < 0.01) continue;
      vec3 gs, rs;
      vec4 t = groundLayer(block, w, ROCK[i], viewLocal, i == 0 ? closeRelief * 0.06 : 0.0, gs, rs);
      rockFactor *= 1.0 + (t.z * 2.0 - 1.0) * f * (i >= 4 ? 0.45 : mix(0.8, 0.85, uGroundRelief));
      rockSlope += rs * f * (i == 0 ? 0.9 : i >= 4 ? 0.32 : 0.6);
      if (i == 1) rockH = mix(0.5, t.w, f);
      // Weathered bedrock also modulates the dusty slopes at middle distance;
      // without this, only cliffs have any structure beyond the 10 m soil tile.
      if (i >= 2) {
        groundFactor *= 1.0 + (t.z * 2.0 - 1.0) * f * 0.5 * uGroundRelief;
        groundSlope += rs * f * 0.22 * uGroundRelief;
      }
    }
    float rock = smoothstep(0.35, 0.65, rockBias + (rockH - groundH) * 0.6 - 0.1 + uRockDensity * 0.1);

    // Sub-metre modulation resolves grains without enlarging pebbles into
    // boulders. It disappears before a pixel can undersample it.
    float grain = fadeBelow(fp, 0.25) * uGroundRelief * weight;
    if (grain > 0.01) {
      vec3 gs, rs;
      vec4 fine = groundLayer(block, w, 4096.0, viewLocal, 0.0, gs, rs);
      groundFactor *= 1.0 + (fine.x * 2.0 - 1.0) * grain * 0.22;
      rockFactor *= 1.0 + (fine.z * 2.0 - 1.0) * grain * 0.18;
      groundSlope += gs * grain * 0.15;
      rockSlope += rs * grain * 0.18;
    }
    // Height-derived crevice occlusion, kept subtle so sunlit stone stays stone.
    float cavity = mix(groundH, rockH, rock);
    float occlusion = mix(1.0, smoothstep(0.12, 0.62, cavity) * 0.24 + 0.76,
                          uGroundRelief * weight);
    vec3 slope = transpose(uMapBasis) * mix(groundSlope, rockSlope, rock);
    vec3 basisNormal = normalize(mix(dir, normal, uGroundRelief));
    vec3 tangential = slope - dot(slope, basisNormal) * basisNormal;
    normal = normalize(normal - tangential * mix(0.8, 0.55, uGroundRelief));
    // Rock is a touch darker than the soil it sheds.
    float shade = mix(groundFactor, rockFactor * 0.85, rock);
    return mix(shade, clamp(shade * occlusion, 0.22, 2.4), uGroundRelief);
  }
`;
