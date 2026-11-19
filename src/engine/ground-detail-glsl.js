/**
 * Ground detail at the scale of a person standing on it: boulders, rocks and
 * pebbles with the shadows they cast, and the grain of the soil between them.
 *
 * Everything else in the terrain is built from the unit direction, which in
 * single float is good to about a ten-millionth of a radian — tens of
 * centimetres on a planet. That is fine for mountains and useless for a pebble,
 * so this layer is built from metres counted from the render anchor instead:
 * an integer cell (`uDetailCell`, exact) plus a fractional remainder
 * (`uDetailFrac`), with the fragment's own offset added to the remainder only.
 * Every lattice below is a power of two metres, so the integer part can be
 * carried into each one by shifting, and the pattern a point gets does not
 * depend on where the anchor happens to be.
 *
 * Depends on pcg3d from the terrain chunk.
 */
export const GROUND_DETAIL_GLSL = /* glsl */ `
  uniform ivec3 uDetailCell;
  uniform vec3 uDetailFrac;
  uniform float uRockDensity;
  // Stones on top of the soil, separately from the soil itself, which every
  // world with ground keeps.
  uniform float uStones;

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

  float detailHash(ivec3 c) {
    return float(pcg3d(uvec3(c)).x) * (1.0 / 4294967296.0);
  }

  // Value noise with gradient, as noised() but on the split lattice.
  vec4 detailNoise(ivec3 base, vec3 q) {
    vec3 i = floor(q);
    vec3 f = q - i;
    ivec3 c = base + ivec3(i);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    float a = detailHash(c);
    float b = detailHash(c + ivec3(1, 0, 0));
    float cc = detailHash(c + ivec3(0, 1, 0));
    float d = detailHash(c + ivec3(1, 1, 0));
    float e = detailHash(c + ivec3(0, 0, 1));
    float g = detailHash(c + ivec3(1, 0, 1));
    float h = detailHash(c + ivec3(0, 1, 1));
    float j = detailHash(c + ivec3(1, 1, 1));
    float k1 = b - a, k2 = cc - a, k3 = e - a;
    float k4 = a - b - cc + d, k5 = a - cc - e + h, k6 = a - b - e + g;
    float k7 = -a + b + cc - d + e - g - h + j;
    float value = a + k1 * u.x + k2 * u.y + k3 * u.z
      + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
    vec3 grad = du * vec3(
      k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
      k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
      k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
    return vec4(value * 2.0 - 1.0, grad * 2.0);
  }

  /**
   * One field of rocks on a 2^k metre lattice. Each cell may hold a rock: a
   * sphere seated in the ground, so the ground cuts it at a different height
   * every time and no two outlines match. Returns the slope it adds (rise over
   * run), and through the out parameters how much of this point is rock, how
   * dark it is, and whether a rock stands between it and the sun.
   */
  vec3 rockField(
    int k, vec3 metres, float density, vec3 sunTan, float sunCot,
    inout float rockMask, inout float tone, inout float shade
  ) {
    ivec3 base;
    vec3 q;
    detailLattice(k, metres, base, q);
    vec3 i = floor(q);
    vec3 f = q - i;
    ivec3 o = ivec3(step(0.5, f)) - 1;
    float best = 0.0;
    vec3 slope = vec3(0.0);
    for (int n = 0; n < 8; n++) {
      ivec3 offset = o + ivec3(n & 1, (n >> 1) & 1, (n >> 2) & 1);
      uvec3 h = pcg3d(uvec3(base + ivec3(i) + offset));
      const float inv16 = 1.0 / 65536.0;
      if (float(h.x & 0xffffu) * inv16 > density) continue;
      vec3 centre = vec3(offset) + vec3(float(h.x >> 16u), float(h.y & 0xffffu), float(h.y >> 16u)) * inv16 * 0.6 + 0.2;
      float radius = mix(0.12, 0.44, pow(float(h.z & 0xffffu) * inv16, 1.8));
      vec3 d = f - centre;
      // An irregular outline: the radius swells and pinches with direction,
      // by a few lobes set from the hash, so no two stones are the same egg.
      vec3 lobe = vec3(h.zyx & 0xffu) / 127.5 - 1.0;
      vec3 dn = d / max(length(d), 1e-5);
      float shapeMod = 1.0 + 0.28 * dot(dn, lobe) + 0.14 * sin(dot(dn, lobe.yzx) * 7.0 + lobe.z * 6.0);
      float rr = radius * shapeMod;
      float r2 = dot(d, d) / (rr * rr);
      if (r2 < 1.0) {
        // Squat, flat-topped and steep-sided: rocks settle and break, and a
        // full hemisphere reads as a bubble.
        float body = 1.0 - r2;
        float lift = rr * 0.42;
        float height = lift * min(body * 2.2, 1.0) * (0.75 + 0.25 * body);
        if (height > best) {
          best = height;
          float edge = body * 2.2 < 1.0 ? 2.2 * (0.75 + 0.25 * body) + 0.25 * body * 2.2 : 0.25;
          slope = -d * (lift * edge * 2.0 / (rr * rr));
          rockMask = max(rockMask, smoothstep(1.0, 0.8, r2));
          tone = mix(0.55, 1.15, float(h.z >> 16u) * inv16);
        }
      } else {
        // Soil gathers in the angle at the foot of a rock, and the light does not.
        shade *= 1.0 - 0.28 * smoothstep(1.9, 1.0, r2);
        // Shadow: the ray to the sun from here passes over the rock if the
        // segment of it short enough to clear the rock's height comes within
        // the rock's outline.
        float reach = rr * 0.42 * sunCot;
        float t = clamp(dot(-d, sunTan), 0.0, reach);
        vec3 nearest = d + sunTan * t;
        float lit = smoothstep(rr * 0.7, rr * 1.02, length(nearest));
        shade *= mix(1.0, lit, 0.82);
      }
    }
    return slope;
  }

  /**
   * Adds the detail to a lit point: tilts the normal and returns the factor
   * the albedo takes. fp is the pixel footprint in metres, which decides which
   * scales are resolved here and fades the rest out before they can alias.
   */
  float groundDetail(vec3 dir, vec3 metres, float fp, float weight, inout vec3 normal) {
    vec3 sunTan = uSunDir - dir * dot(uSunDir, dir);
    float sinE = dot(uSunDir, dir);
    float cosE = length(sunTan);
    sunTan = cosE > 1e-4 ? sunTan / cosE : vec3(0.0);
    // Capped so a shadow stays inside the cells searched for the rock casting it.
    float sunCot = clamp(cosE / max(sinE, 0.02), 0.0, 2.6);
    if (sinE < 0.0) sunCot = 0.0;

    float rockMask = 0.0;
    float tone = 1.0;
    float shade = 1.0;
    vec3 slope = vec3(0.0);

    // Stones gather in fields and thin out between them, so the density
    // itself wanders, on a lattice of 32 m.
    ivec3 base;
    vec3 q;
    detailLattice(5, metres, base, q);
    float field = clamp(0.55 + detailNoise(base, q).x * 0.9, 0.08, 1.4);

    float wBoulder = weight * uStones * (1.0 - smoothstep(1.0, 3.5, fp));
    if (wBoulder > 0.001) {
      float s = 1.0;
      slope += rockField(3, metres, uRockDensity * 0.12 * field, sunTan, sunCot, rockMask, tone, s) * wBoulder;
      shade *= mix(1.0, s, wBoulder);
    }
    float wStone = weight * uStones * (1.0 - smoothstep(0.3, 1.0, fp));
    if (wStone > 0.001) {
      float s = 1.0;
      slope += rockField(1, metres, uRockDensity * 0.3 * field, sunTan, sunCot, rockMask, tone, s) * wStone;
      shade *= mix(1.0, s, wStone);
    }
    float wRock = weight * uStones * (1.0 - smoothstep(0.08, 0.28, fp));
    if (wRock > 0.001) {
      float s = 1.0;
      slope += rockField(-1, metres, uRockDensity * 0.5 * field, sunTan, sunCot, rockMask, tone, s) * wRock;
      shade *= mix(1.0, s, wRock);
    }
    float wPebble = weight * uStones * (1.0 - smoothstep(0.02, 0.07, fp));
    if (wPebble > 0.001) {
      float s = 1.0;
      slope += rockField(-3, metres, uRockDensity * 0.8, sunTan, sunCot, rockMask, tone, s) * wPebble * 0.8;
      shade *= mix(1.0, s, wPebble * 0.8);
    }

    // Rough, fractured faces on the stones themselves.
    if (rockMask > 0.01 && fp < 0.15) {
      detailLattice(-3, metres, base, q);
      slope += detailNoise(base, q).yzw * 0.09 * rockMask * (1.0 - smoothstep(0.04, 0.15, fp));
    }

    // The grain of the soil: two octaves at a few centimetres and a few
    // decimetres, for the texture of the ground between the stones.
    float grain = 0.0;
    float wGrain = weight * (1.0 - smoothstep(0.03, 0.12, fp));
    if (wGrain > 0.001) {
      detailLattice(-1, metres, base, q);
      vec4 coarse = detailNoise(base, q);
      detailLattice(-4, metres, base, q);
      vec4 fine = detailNoise(base, q);
      slope += (coarse.yzw * 0.035 + fine.yzw * 0.02) * wGrain;
      grain = (coarse.x * 0.6 + fine.x * 0.4) * wGrain;
    }
    // Ripples and drifts at the scale of a stride, and blotches of darker and
    // lighter soil, wide enough to carry the texture out past the stones.
    float patches = 0.0;
    float wDrift = weight * (1.0 - smoothstep(1.0, 6.0, fp));
    if (wDrift > 0.001) {
      detailLattice(2, metres, base, q);
      vec4 drift = detailNoise(base, q);
      detailLattice(4, metres, base, q);
      vec4 broad = detailNoise(base, q);
      slope += (drift.yzw * 0.04 + broad.yzw * 0.03) * wDrift;
      patches = (drift.x * 0.5 + broad.x * 0.5) * wDrift;
    }

    vec3 tangential = slope - dot(slope, dir) * dir;
    normal = normalize(normal - tangential);
    float rockTone = mix(1.0, tone, rockMask);
    return shade * rockTone * (1.0 + grain * 0.22) * (1.0 + patches * 0.18);
  }
`;
