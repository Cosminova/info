/**
 * Shared GLSL for procedural surface relief.
 *
 * Everything here returns a height *and its analytic gradient*, packed as
 * vec4(height, d/dx, d/dy, d/dz). That matters: the same code runs in the
 * vertex shader to displace geometry and in the fragment shader to build a
 * normal, and taking finite differences per pixel would multiply an already
 * expensive function by four. Carrying derivatives through keeps it at 1x.
 *
 * The crater model follows the approach SpaceEngine describes: craters live on
 * a jittered 3D grid, and octaves are applied from large to small so that a
 * newer, smaller crater *replaces* the terrain it lands on instead of adding to
 * it. Summing octaves instead produces a bubbly mess with no clear rims; the
 * destructive form is what gives real crater floors and the ghost craters you
 * see flooded by lunar mare.
 */

/**
 * Size ratio between consecutive crater octaves.
 *
 * Each octave costs a 27-cell neighbourhood walk per pixel, so the number of
 * octaves needed to cover the span between the largest crater and one that is
 * a pixel across is the dominant term in the surface shader. A wider ratio
 * covers that span in fewer octaves: at 2.15 it takes five to span a factor of
 * 46, at 2.9 it takes four. The cost is a slightly coarser sampling of the
 * crater size distribution, which is hidden by the fact that each octave draws
 * its radii randomly across a 2.4x range anyway, so the sizes still overlap
 * between octaves rather than leaving gaps.
 */
export const CRATER_LACUNARITY = 2.9;

/**
 * Maps a province's coverage fraction to a threshold on the crust field: the
 * field's standard deviation times the logistic approximation to the normal
 * quantile. Exported so the geology tables invert the same mapping.
 */
export const PROVINCE_QUANTILE = 0.19 * 0.5513;

/**
 * How many pixels across a crater has to be before it is worth drawing.
 *
 * This is the knob that decides how detailed a surface looks. Set high, the
 * finest craters only appear once they are large on screen, and a body mapped at
 * a kilometre per pixel is a smooth grey blur at every distance in between. Set
 * too low, octaves are evaluated whose features land inside a single pixel and
 * shimmer as the camera moves. Two pixels is about the honest limit for a
 * feature that has to survive being resolved.
 */
export const CRATER_DETAIL_MARGIN = 2.0;

/**
 * What the crater profile's own depth is divided by before craterDepth scales
 * it, which sets how deep a crater ends up relative to its width.
 *
 * The profile is written in units of crater radius and a fresh simple crater in
 * it is 0.42 of one deep, so on its own it already carries a depth-to-diameter
 * of 0.21 — the real figure. The per-body craterDepth then multiplied that a
 * second time, and since it is documented as the depth-to-diameter ratio itself,
 * the two together landed near a fifth of what either meant: craters came out
 * 0.03 of their width deep against a real 0.2, with walls a fifth as steep. That
 * is why close ground looked flat. The relief was all there and correctly shaped,
 * and too shallow to shade — from a few metres up, Mars was a smooth plain with
 * faint dimples pressed into it.
 *
 * Dividing the full 0.21 back out overshoots, though, and this is why the figure
 * is not simply that. Six or seven self-similar octaves stack here, and giving
 * every one of them a real crater's depth compounds into ground far rougher than
 * any real surface: it comes out as overlapping blisters rather than craters,
 * because a single crater's proportions are not the proportions of a surface
 * saturated with them at every scale. Real regolith fills its own small craters
 * and erases them, which is the physics that keeps a genuine surface smooth at
 * fine scales, and none of it is modelled. Damping the ratio stands in for that
 * erasure, so a single crater is shallower than a real one while the surface as
 * a whole reads correctly, which is the way round that matters. Chosen by
 * looking: at 1.0 the ground is flat, at 0.21 it is bubbles, and here it reads
 * as cratered ground from seven metres up and from orbit.
 */
export const CRATER_DEPTH_REFERENCE = 0.5;

// Amplitude falls as 1/lacunarity, which is what makes the surface self-similar:
// a crater half the width is half as deep. The 1.12 keeps the slightly
// exaggerated relief the bodies were tuned with at the old ratio.
const CRATER_GAIN = (1 / CRATER_LACUNARITY) * 1.12;

export const TERRAIN_GLSL = /* glsl */ `
  const float CRATER_LACUNARITY = ${CRATER_LACUNARITY.toFixed(4)};
  const float CRATER_GAIN = ${CRATER_GAIN.toFixed(5)};
  const float CRATER_DETAIL_MARGIN = ${CRATER_DETAIL_MARGIN.toFixed(2)};
  const float CRATER_DEPTH_NORM = ${(1 / CRATER_DEPTH_REFERENCE).toFixed(5)};

  /**
   * Integer hashing (PCG3D).
   *
   * The usual fract(sin(dot(p, k)) * large) hash cannot be used here. The finest
   * crater octave samples a grid tens of thousands of cells across, and sin() of
   * an argument that large has no precision left in 32-bit float, so the hash
   * becomes correlated and the terrain collapses into visible streaks. Integer
   * arithmetic on the lattice coordinate is exact instead, with no tiling and no
   * degradation at any scale — lattice coordinates stay whole numbers well inside
   * the 24-bit range a float can represent exactly.
   */
  uvec3 pcg3d(uvec3 v) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z;
    v.y += v.z * v.x;
    v.z += v.x * v.y;
    return v;
  }

  vec3 hash33(vec3 p) {
    return vec3(pcg3d(uvec3(ivec3(floor(p))))) * (1.0 / 4294967296.0);
  }

  float hash13(vec3 p) {
    return float(pcg3d(uvec3(ivec3(floor(p)))).x) * (1.0 / 4294967296.0);
  }

  /**
   * Five independent values from one hash.
   *
   * A crater cell needs a survival draw, three jitter components and a radius.
   * Taken as five separate hash calls, or even two, hashing dominates the frame:
   * the inner loop visits 27 cells per octave and up to five octaves per pixel.
   * One PCG3D call produces 96 well-mixed bits, which is ample for five values
   * at 16-bit resolution — far finer than a crater position needs.
   *
   * Which bits go where matters. The survival draw must not share bits with the
   * jitter, or the surviving craters all sit to one side of their cell: the draw
   * and the coordinate would be the same number read twice.
   */
  void craterCell(
    vec3 cell, out float select, out vec3 jitter, out float radius, out float freshness
  ) {
    uvec3 v = pcg3d(uvec3(ivec3(cell)));
    const float inv16 = 1.0 / 65536.0;
    select = float(v.x & 0xffffu) * inv16;
    jitter = vec3(float(v.x >> 16u), float(v.y & 0xffffu), float(v.y >> 16u)) * inv16;
    radius = float(v.z & 0xffffu) * inv16;
    freshness = float(v.z >> 16u) * inv16;
  }

  // Value noise with analytic gradient. The quintic fade keeps the second
  // derivative continuous, so lighting off the gradient does not show grid
  // creases the way a cubic fade does.
  vec4 noised(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

    float a = hash13(i + vec3(0.0, 0.0, 0.0));
    float b = hash13(i + vec3(1.0, 0.0, 0.0));
    float c = hash13(i + vec3(0.0, 1.0, 0.0));
    float d = hash13(i + vec3(1.0, 1.0, 0.0));
    float e = hash13(i + vec3(0.0, 0.0, 1.0));
    float g = hash13(i + vec3(1.0, 0.0, 1.0));
    float h = hash13(i + vec3(0.0, 1.0, 1.0));
    float j = hash13(i + vec3(1.0, 1.0, 1.0));

    float k0 = a;
    float k1 = b - a;
    float k2 = c - a;
    float k3 = e - a;
    float k4 = a - b - c + d;
    float k5 = a - c - e + h;
    float k6 = a - b - e + g;
    float k7 = -a + b + c - d + e - g - h + j;

    float value =
      k0 + k1 * u.x + k2 * u.y + k3 * u.z +
      k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x +
      k7 * u.x * u.y * u.z;

    vec3 gradient = du * vec3(
      k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
      k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
      k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y
    );

    return vec4(value * 2.0 - 1.0, gradient * 2.0);
  }

  // Fractal sum with rotation between octaves to break up axis alignment.
  vec4 fbmd(vec3 p, int octaves, float lacunarity, float gain) {
    vec4 sum = vec4(0.0);
    float amp = 0.5;
    float freq = 1.0;
    mat3 rot = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
    mat3 accum = mat3(1.0);
    for (int i = 0; i < 8; i++) {
      if (i >= octaves) break;
      vec4 n = noised(p * freq);
      sum.x += amp * n.x;
      sum.yzw += amp * freq * (accum * n.yzw);
      accum = rot * accum;
      p = rot * p;
      freq *= lacunarity;
      amp *= gain;
    }
    return sum;
  }

  // Ridged variant: |noise| flipped, which turns the zero crossings into sharp
  // ridge lines. Used for mountain belts and asteroid facets.
  vec4 ridgedd(vec3 p, int octaves) {
    vec4 sum = vec4(0.0);
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 8; i++) {
      if (i >= octaves) break;
      vec4 n = noised(p * freq);
      float s = sign(n.x);
      sum.x += amp * (1.0 - abs(n.x));
      sum.yzw -= amp * freq * s * n.yzw;
      freq *= 2.03;
      amp *= 0.5;
    }
    return sum;
  }

  // --- crater profile -------------------------------------------------------

  // Smooth min/max carrying derivatives. vec4 in, vec4 out: (value, gradient).
  vec4 smoothMinD(vec4 a, vec4 b, float k) {
    float e = 0.5 + 0.5 * (b.x - a.x) / k;
    float h = clamp(e, 0.0, 1.0);
    vec3 dh = (e > 0.0 && e < 1.0) ? 0.5 * (b.yzw - a.yzw) / k : vec3(0.0);
    vec3 grad =
      mix(b.yzw, a.yzw, h) + (a.x - b.x) * dh - k * (1.0 - 2.0 * h) * dh;
    return vec4(mix(b.x, a.x, h) - k * h * (1.0 - h), grad);
  }

  vec4 smoothMaxD(vec4 a, vec4 b, float k) {
    vec4 neg = smoothMinD(vec4(-a.x, -a.yzw), vec4(-b.x, -b.yzw), k);
    return vec4(-neg.x, -neg.yzw);
  }

  /**
   * Radial profile of an impact crater, in units of its own radius.
   *
   * Returned as two parts, because that is what lets overlapping craters
   * combine correctly: the interior is the cavity, zero or negative and confined
   * inside the rim, and the exterior is the raised rim and its ejecta blanket,
   * zero or positive. Craters in one octave then take the minimum of the
   * interiors and the maximum of the exteriors, so a younger crater cuts through
   * an older floor and its rim overprints the older ejecta, rather than the two
   * summing into a double-deep hole with a double-height rim.
   *
   * The shape follows measured crater morphometry rather than a bowl:
   *
   *  - depth/diameter near 0.2 for small craters, falling with size as the
   *    walls of larger ones collapse under their own weight
   *  - a flat floor, wider in larger craters, from that same collapse
   *  - walls steepest just below the rim, which is what makes the crest a
   *    visible break in slope instead of a rounded hump
   *  - terraces on the walls of large craters: concentric slump blocks
   *  - a central peak in large craters, rebounded from the floor
   *  - ejecta falling off as roughly the inverse cube of distance
   *
   * complexity runs 0 for a small simple bowl to 1 for a large terraced crater
   * with a central peak, and is set by the caller from the crater's actual
   * diameter.
   *
   * x is distance from the centre over the crater radius, so the rim crest is
   * at x = 1. Derivatives are with respect to x.
   */
  void craterProfile(
    float x, float complexity, float freshness,
    out vec2 interior, out vec2 exterior, out float crest
  ) {
    float age = 1.0 - freshness;
    float depth = mix(0.42, 0.15, complexity) * mix(1.0, 0.38, age * age);
    float rimHeight = mix(0.085, 0.04, complexity) * mix(1.0, 0.18, age);
    float floorEdge = mix(0.10, 0.55, complexity);
    float fill = 0.55 * age * depth;

    // Height of the crest, which is this profile evaluated at x = 1: the wall has
    // climbed the full depth back to the fill level and the rim sits on top of
    // that. Reported rather than left for the caller to reconstruct, because the
    // shadow test needs it and a second expression for the same rim is a second
    // rim — the two drifted apart before, and a crest guessed slightly too tall
    // never falls to meet the ground at the crater's edge, so the shadow it cast
    // divided by a vanishing distance and every complex crater came out ringed
    // with hard black.
    crest = fill + rimHeight;

    interior = vec2(0.0);
    exterior = vec2(0.0);

    if (x < 1.0) {
      if (x < floorEdge) {
        interior = vec2(-depth + fill, 0.0);
      } else {
        // Wall: rises from the floor to the crest. The exponent puts the
        // steepest ground just under the crest.
        float u = (x - floorEdge) / (1.0 - floorEdge);
        float du = 1.0 / (1.0 - floorEdge);
        float shape = pow(u, 2.2);
        interior = vec2(-depth + fill + depth * shape, depth * 2.2 * pow(u, 1.2) * du);

        // Terraces: slump blocks stepped down the wall, only in craters big
        // enough to have collapsed. Amplitude tapers to nothing at the crest so
        // the rim itself stays a clean line.
        //
        // How many blocks a wall broke into, and where the first one sits,
        // differ from crater to crater — no real crater has the same three
        // evenly spaced rings as its neighbour. Both are taken off the crater's
        // freshness, which is already a per-crater draw, so the variation costs
        // nothing. Old walls have slumped to rubble and buried their own
        // terraces, so the amplitude goes with freshness too; without that, a
        // basin wide enough to show its terraces at full size reads as a set of
        // concentric grooves stamped onto the body.
        //
        // Amplitude falls with the number of steps, so the riser between two of
        // them keeps the same slope however many the wall broke into. Left
        // un-normalised, a four-terrace wall has risers four times steeper than
        // a two-terrace one, and on a crater wide enough to be drawn with real
        // geometry — an impact basin — that is a step the vertex grid cannot
        // resolve, so it comes out as a field of facets rather than terraces.
        float terraces = 2.0 + floor(freshness * 3.0);
        float offset = fract(freshness * 7.31) * 6.2831853;
        float peak = 0.02 * complexity * freshness * (3.0 / terraces);
        float amplitude = peak * (1.0 - u);
        float phase = terraces * 6.2831853 * u + offset;
        interior.x += amplitude * sin(phase);
        interior.y +=
          amplitude * cos(phase) * terraces * 6.2831853 * du -
          peak * du * sin(phase);
      }

      // Central peak: material rebounded up through the floor after the impact.
      float peakEdge = 0.3 * complexity;
      if (x < peakEdge && peakEdge > 0.01) {
        float u = 1.0 - x / peakEdge;
        float height = 0.55 * depth * complexity;
        interior.x += height * u * u;
        interior.y += -2.0 * height * u / peakEdge;
      }
    }

    // Rim and ejecta. Peaks at the crest and decays outward as an inverse cube,
    // cut off where it becomes invisible; inside the crest it drops away quickly
    // so it does not fill the cavity it belongs to.
    const float EJECTA_EDGE = 2.5;
    const float TAIL = 1.0 / (EJECTA_EDGE * EJECTA_EDGE * EJECTA_EDGE);
    if (x > 0.8) {
      if (x <= 1.0) {
        // Inner flank of the rim crest.
        float u = (x - 0.8) * 5.0;
        exterior = vec2(rimHeight * u * u, rimHeight * 2.0 * u * 5.0);
      } else if (x < EJECTA_EDGE) {
        float inv = 1.0 / (x * x * x);
        float scale = rimHeight / (1.0 - TAIL);
        exterior = vec2(scale * (inv - TAIL), scale * (-3.0 / (x * x * x * x)));
      }
    }
  }

  /**
   * One octave of craters. p is scaled so that one grid cell holds one crater;
   * the returned height is in the same units as one cell, and is negative
   * inside a bowl.
   */
  /**
   * Whether a crater's rim casts a shadow over a point inside it.
   *
   * A shadow is the strongest cue that a crater is a hole rather than a
   * painted-on ring, and the cheapest place to find one is the crater the point
   * is already standing in: its rim is the nearest thing tall enough to block
   * the sun. Marching the height field toward the sun would cost as much as
   * building it in the first place, several times over; this is closed form.
   *
   * All of it happens in the crater's own plane. Walk from the point along the
   * sun's horizontal direction to where it crosses the rim, compare the height
   * the sun has climbed over that distance against how far the rim stands above
   * the point, and the shadow follows. Lengths are in grid cells, and heights
   * are scaled by the same exaggeration the surface itself uses.
   */
  float craterShade(
    vec3 q, vec3 up, vec3 sunTangent, float tanElevation,
    float radius, float x, float pointHeight, float rimHeight, float heightScale
  ) {
    // Only the part of the offset that lies along the surface matters: the grid
    // is three-dimensional, and its radial component is what varies the craters
    // rather than anything you could walk along.
    //
    // The walk starts from the radius the profile was evaluated at, not from the
    // length of the offset, even though the two describe the same point. They
    // are not interchangeable: the profile reads a jittered radius, taken off a
    // per-crater hash of the direction, so that no crater is a perfect circle.
    // Measuring the height at one radius and the distance to the rim at another
    // put the crest in two places at once — the height said the point was still
    // on the wall while the geometry said it had already reached the rim, so a
    // real rise got divided by no run at all. It went black, and it went black in
    // whatever angular pattern the jitter happened to have, which is why the
    // rims came out ringed with dashes rather than shaded.
    vec3 tangential = q - up * dot(q, up);
    float len = length(tangential);
    float here = x * radius;
    float along = len > 1e-9 ? dot(tangential / len, sunTangent) * here : 0.0;

    // Distance from the point to the rim, going towards the sun. Both this and
    // the rise vanish together at the crest, which is what keeps the ratio below
    // finite there; the floor is a fraction of the crater rather than an absolute
    // so that it means the same thing at every octave.
    float inside = max(radius * radius - here * here + along * along, 0.0);
    float run = max(sqrt(inside) - along, radius * 1e-3);

    // Scaled by the crater's radius because the profile is written in units of
    // it, while the run above is in grid cells. Without that the comparison had
    // a crater's worth of scale missing from one side of it, so the rim appeared
    // two to three times taller than the one drawn and shadow reached across
    // ground the light plainly gets to. It also made the error size-dependent,
    // which is why no single choice of the constant this replaces ever looked
    // right at more than one octave at a time.
    float rise = (rimHeight - pointHeight) * radius * heightScale;
    // Softened generously, because the quantity below is a difference of slopes
    // and a narrow band on it is a hard edge on the ground: the shadow's own
    // terminator is where the rise and the sun's climb cross, and either side of
    // that crossing the smoothstep saturates within a fraction of a crater. A
    // wide band is also the cheapest antialiasing available here — the edge is
    // resolution-independent, so it cannot stair-step however close the camera
    // gets, and a crater shadow with a soft edge is what one looks like anyway.
    return smoothstep(-0.2, 0.2, (rise - run * tanElevation) / max(run, 1e-6));
  }

  vec4 craterOctave(
    vec3 p, float density, float complexity,
    vec3 up, vec3 sunTangent, float tanElevation, float shadowScale, inout float shade,
    inout vec2 marks
  ) {
    vec3 ip = floor(p);
    vec3 fp = fract(p);

    // Deepest cavity and highest rim seen so far, each with its gradient. The
    // winner is taken outright rather than blended: where two crater rims cross,
    // a crease is the correct answer, and it is what the eye reads as one impact
    // having landed on another.
    vec4 cavity = vec4(0.0);
    vec4 relief = vec4(0.0);

    // How far ejecta rays run out from the crater, in crater radii. The relief
    // stops well before this; only the albedo reaches out here.
    const float EJECTA_REACH = 2.5;
    // Widest a crater can reach: the largest radius times that reach. Used to
    // reject whole cells geometrically, before hashing.
    const float MAX_REACH = 0.72 * EJECTA_REACH;

    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        for (int k = -1; k <= 1; k++) {
          vec3 cell = vec3(float(i), float(j), float(k));

          // A crater centre lies somewhere in the middle 70% of its cell, so the
          // nearest point of this cell that could hold one is a known box. If
          // even that is out of reach, nothing in the cell can contribute and
          // the hash is not worth paying for. Costs a handful of flops and skips
          // the far corners of the 27-cell neighbourhood.
          vec3 outside = max(max(cell + 0.15 - fp, fp - cell - 0.85), 0.0);
          if (dot(outside, outside) > MAX_REACH * MAX_REACH) continue;

          float select;
          vec3 jitter;
          float radiusDraw;
          float freshness;
          craterCell(ip + cell, select, jitter, radiusDraw, freshness);
          // Skip most cells so craters do not tile uniformly; the surviving
          // fraction is the crater density.
          if (select > density) continue;

          vec3 centre = cell + 0.15 + 0.7 * jitter;
          vec3 q = fp - centre;
          vec3 axis = jitter - up * dot(jitter, up);
          float axisLen = length(axis);
          if (axisLen > 0.04) {
            axis /= axisLen;
            float ecc = 0.28 * clamp(hash13(ip + cell + 19.0) - 0.22, 0.0, 1.0);
            q -= axis * dot(q, axis) * ecc;
          }
          float radius = 0.30 + 0.42 * radiusDraw;

          // Range test on the squared distance, so cells that contribute nothing
          // never pay for a square root.
          float reachDistance = EJECTA_REACH * radius;
          float d2 = dot(q, q);
          if (d2 > reachDistance * reachDistance) continue;

          float d = sqrt(d2) + 1e-6;
          float x = d / radius;
          // No crater is a perfect circle, so the radius wobbles with the
          // direction from the centre. Smooth noise rather than a hash: a hash
          // of the direction is white noise in it, which quantises the outline
          // into angular blocks about five degrees wide. Those are far below a
          // pixel from orbit, which is where this was judged, but from low
          // altitude one block spans many pixels and the rim reads as a cog
          // rather than a crater — and once the shadow started following the
          // same radius, as it must, the blocks became hard black wedges thrown
          // across the floor. Value noise has the continuous derivative the
          // shading wants anyway.
          x *= 1.0 + 0.07 * noised(normalize(q) * 2.0 + jitter * 13.0).x * freshness;
          vec3 dx = q / (d * radius);

          vec2 interior;
          vec2 exterior;
          float crest;
          craterProfile(x, complexity, freshness, interior, exterior, crest);
          float inner = interior.x * radius;
          if (inner < cavity.x) cavity = vec4(inner, interior.y * radius * dx);
          float outer = exterior.x * radius;
          if (outer > relief.x) relief = vec4(outer, exterior.y * radius * dx);

          // Albedo marks, which carry as much of the look of a cratered surface
          // as the relief does. A fresh impact exposes unweathered material: a
          // bright rim and rays streaming outward, fading over time as the
          // surface darkens again. Old craters leave shape but no contrast.
          // Floors are darker than their surroundings whatever their age, being
          // where dust collects and where the walls shade them.
          float fresh = smoothstep(0.55, 1.0, freshness);
          if (fresh > 0.0 && x > 0.7 && x < EJECTA_REACH) {
            // Rays: an angular pattern around the crater, coherent per crater
            // and stretched radially, which is what ejecta actually looks like.
            float rays = 0.55 + 0.45 * hash13(vec3(normalize(q) * 9.0 + jitter * 4.0));
            float fade = 1.0 - smoothstep(0.9, EJECTA_REACH, x);
            marks.x = max(marks.x, fresh * fade * rays);
          }
          if (x < 0.9) {
            marks.y = max(marks.y, (1.0 - smoothstep(0.4, 0.9, x)) * (0.45 + 0.55 * (1.0 - fresh)));
          }

          // Shadow cast by this crater's own rim. Only points inside the rim are
          // tested: the geometry below assumes the rim encircles the point, and
          // outside it the ejecta blanket is too shallow to shadow anything.
          if (shadowScale > 0.0 && x < 1.0) {
            shade = max(
              shade,
              craterShade(
                q, up, sunTangent, tanElevation, radius, x,
                interior.x + exterior.x, crest, shadowScale
              )
            );
          }
        }
      }
    }

    return cavity + relief;
  }

  /**
   * Full crater terrain: octaves from large to small, each one destroying the
   * terrain it lands on rather than adding to it. strength is the height of the
   * largest craters as a fraction of the body radius.
   */
  vec4 craterTerrain(
    vec3 dir, float baseFreq, float octaves, float density, float cellKm, float complexKm,
    vec3 sunLocal, float shadowScale, vec3 seed, out float shade, out vec2 marks
  ) {
    vec4 height = vec4(0.0);
    float freq = baseFreq;
    float amp = 1.0;
    float cell = cellKm;
    shade = 0.0;
    marks = vec2(0.0);

    // Sun geometry in the surface frame at this point, shared by every octave:
    // its elevation as a tangent, and the horizontal direction its shadows run.
    float sinElevation = dot(sunLocal, dir);
    vec3 sunFlat = sunLocal - dir * sinElevation;
    float cosElevation = length(sunFlat);
    vec3 sunTangent = cosElevation > 1e-5 ? sunFlat / cosElevation : vec3(0.0);
    float tanElevation = sinElevation / max(cosElevation, 1e-5);
    // No shadows once the sun is below the horizon: the surface is unlit anyway,
    // and the geometry above would run backwards.
    float wantShade = (sinElevation > 0.0 && cosElevation > 1e-5) ? shadowScale : 0.0;

    for (int i = 0; i < 7; i++) {
      // Fractional octave counts let the finest layer fade in with distance
      // instead of appearing all at once as you approach.
      float weight = clamp(octaves - float(i), 0.0, 1.0);
      if (weight <= 0.0) break;

      // Whether this octave's craters are large enough to have collapsed into
      // terraced, flat-floored, central-peaked complex craters. One grid cell is
      // about one crater diameter.
      float complexity = smoothstep(0.5, 4.0, cell / max(complexKm, 1e-6));

      // Shadows and colour marks are high-contrast, and a crater only a couple
      // of pixels wide cannot carry them: it collapses into a dark speck, and
      // because every cell produces one, the specks line up on the grid and read
      // as a screen door laid over the surface. Relief has no such problem —
      // an unresolved crater just tilts the ground slightly — so the two are
      // held back by an octave while relief runs all the way down.
      float contrastFade = clamp(octaves - float(i) - 1.0, 0.0, 1.0);

      float octaveShade = 0.0;
      vec2 octaveMarks = vec2(0.0);
      // The fade is applied to the shadow, not to the rim casting it.
      //
      // This used to hand the fade in as the height scale, which fades a
      // shadow in by shrinking the rim rather than by making the shadow fainter.
      // Those are not the same thing. A shortened rim casts no shadow at all
      // until it clears the sun's elevation, and then casts a full one, so the
      // term jumped from nothing to solid black over a hair's width of the fade.
      // Since the fade is driven by each fragment's own footprint, the jump
      // landed wherever across the frame that footprint crossed the threshold,
      // and the crater rims came out ringed with hard black steps instead of
      // shaded. Passing the true rim height and fading the result below gives
      // the smooth appearance the fade was written for.
      // The lattice is shifted per body. Without this every world is struck in
      // the same places: the cells are hashed off their own coordinates, so two
      // planets sharing a crater frequency share their whole crater population,
      // which is the single most recognisable way two procedural surfaces give
      // themselves away as the same surface.
      vec4 layer = craterOctave(
        dir * freq + seed, density, complexity,
        dir, sunTangent, tanElevation,
        contrastFade > 0.0 ? wantShade : 0.0, octaveShade, octaveMarks
      );

      // Finer craters overprint coarser ones, so their marks win where they
      // exist, faded in with the octave itself.
      marks = mix(marks, max(marks, octaveMarks), weight * contrastFade);

      // Shadows from every scale compound: a boulder field inside a shadowed
      // crater floor is not lit twice. Weighted by the same two fades as the
      // octave's relief and marks, so a scale too fine to resolve contributes
      // nothing rather than arriving at full strength.
      shade = shade + octaveShade * contrastFade * weight * (1.0 - shade);
      layer.yzw *= freq;
      layer *= amp * weight;

      // Destructive blend: where this octave has carved a bowl it replaces the
      // existing height rather than summing with it, so a fresh crater cuts
      // through an older rim instead of riding on top of it. Summing octaves
      // gives a bubbled surface with no readable crater floors.
      float bite = clamp(-layer.x * 1.6, 0.0, 1.0);
      height = mix(height + layer, layer, bite * 0.75);

      freq *= CRATER_LACUNARITY;
      amp *= CRATER_GAIN;
      cell /= CRATER_LACUNARITY;
    }
    return height;
  }

  // --- fractures ------------------------------------------------------------

  /**
   * Tectonic fractures: the troughs, grooves and double ridges that cover the
   * icy satellites.
   *
   * Craters are the wrong model for these bodies. Enceladus, Europa, Ganymede
   * and Dione are not saturated cratered ground — their surfaces are young and
   * have been pulled apart, and what you see from close up is a network of long
   * curving fissures, often with raised flanks, crossing and cutting each other.
   * Rendering them as cratered rock is the single largest thing that makes an
   * icy moon look wrong.
   *
   * The lines come from the zero crossings of a noise field, which is what makes
   * them long and continuous rather than a scatter of blobs: taking the absolute
   * value turns each crossing into a crease, and a narrow band either side of it
   * becomes one fracture. The field is warped by a coarser noise first, so the
   * fractures curve instead of running straight, and octaves at rotated
   * orientations give a network rather than one family of parallel lines.
   *
   * width is the fracture's half-width as a fraction of one cell. Returned as
   * (height, gradient), with height negative in the trough.
   */
  vec4 fractureTerrain(vec3 dir, float freq, float octaves, float width) {
    vec4 total = vec4(0.0);
    float amp = 1.0;
    float scale = freq;
    mat3 rot = mat3(0.6, 0.8, 0.0, -0.8, 0.6, 0.0, 0.0, 0.0, 1.0);
    vec3 p = dir;

    for (int i = 0; i < 5; i++) {
      float weight = clamp(octaves - float(i), 0.0, 1.0);
      if (weight <= 0.0) break;

      // Warp: displacing the sample point by a coarser noise bends the fracture
      // lines into arcs, which is what real ones look like where they follow
      // stress fields rather than a straight crack in glass.
      vec4 warp = noised(p * scale * 0.35);
      vec3 warped = p * scale + warp.x * 0.6;

      // The zero set of a noise field is a connected maze, and a surface covered
      // in it looks like reptile skin rather than a moon. Real fracture sets are
      // provincial: Enceladus has four tiger stripes across one polar region and
      // smooth plains elsewhere, Ganymede has bands of grooves between patches of
      // untouched dark crust. A coarse mask per octave concentrates each family
      // into part of the body and leaves the rest alone.
      float province = smoothstep(0.08, 0.62, noised(p * scale * 0.05).x + 0.18);
      if (province <= 0.001) {
        p = rot * p;
        scale *= 2.3;
        amp *= 0.42;
        continue;
      }
      weight *= province;

      vec4 field = noised(warped);
      float distance = abs(field.x);
      // Chain rule through the absolute value and the warp. The warp's own
      // gradient is small compared with the field's, and is left out: including
      // it costs another multiply per component for a correction well below the
      // amplitude of the next octave.
      vec3 gradient = sign(field.x) * field.yzw * scale;

      float u = distance / width;
      if (u < 1.7) {
        float height = 0.0;
        float slope = 0.0;
        if (u < 1.0) {
          // The trough itself, deepest along the line.
          float t = 1.0 - u;
          height -= t * t;
          slope += 2.0 * t;
        }
        // Raised flanks. Europa's lineae are double ridges with a central
        // groove, built from material pushed up either side, and most of the
        // grooved terrain elsewhere shows the same profile.
        float flank = 1.0 - abs(u - 1.15) / 0.55;
        if (flank > 0.0) {
          height += 0.45 * flank * flank;
          slope -= 0.45 * 2.0 * flank * sign(u - 1.15) / 0.55;
        }
        total.x += amp * height * weight;
        total.yzw += amp * slope * gradient / width * weight;
      }

      p = rot * p;
      scale *= 2.3;
      amp *= 0.42;
    }

    return total;
  }

  // --- provinces ------------------------------------------------------------

  /**
   * The crust: one smooth field per body dividing it into high ground and low.
   *
   * Nothing above this point knows where it is. Craters, fractures and ridged
   * relief are all statistically identical everywhere on a body, and a surface
   * built that way reads as one texture wrapped round a sphere however good the
   * individual features are. Real surfaces are nothing like that. The Moon is
   * half dark smooth mare and half bright saturated highland, and which half you
   * are looking at is the first thing anyone notices about it. Mars has an entire
   * hemisphere sitting several kilometres below the other. Those divisions are
   * the largest features on their bodies and they are what the eye reads as a
   * place rather than a pattern.
   *
   * So one coarse field is built first and everything regional keys off it: where
   * lava ponds, where rifts open, where volcanoes stand. Two octaves, because
   * this is meant to be the shape of a hemisphere and not a landscape.
   *
   * Returns (value, gradient), value near -1 for the deepest basins and +1 for
   * the highest crust.
   */
  vec4 crustField(vec3 dir, float seed) {
    vec4 broad = noised(dir * 0.85 + seed);
    vec4 detail = noised(dir * 1.9 - seed * 0.7);
    return vec4(broad.x * 0.78 + detail.x * 0.34, broad.yzw * 0.78 + detail.yzw * 0.34 * 1.9);
  }

  /**
   * Whether a regional process acts here, from the crust field.
   *
   * coverage is the fraction of the body affected, which is the number worth
   * exposing per body: the mare cover about a third of the lunar near side,
   * Mercury's smooth plains rather more, and Callisto none at all. It is
   * converted into a threshold on the crust field, low ground first, because that
   * is the physical order — lava fills basins, it does not coat summits.
   */
  vec4 provinceMask(vec4 crust, float coverage, float edge) {
    if (coverage <= 0.001) return vec4(0.0);
    if (coverage >= 0.999) return vec4(1.0, 0.0, 0.0, 0.0);

    // The threshold has to be the coverage-th quantile of the crust field, and
    // the field is nowhere near uniform: it is a sum of two smooth noises, so it
    // piles up near zero and has almost nothing out at its extremes. Spreading
    // coverage linearly across the field's range therefore does not put a third
    // of the body under lava when asked for a third, it puts a few per cent — and
    // for a process covering a tenth of a body, like a rift, it lands out in the
    // tail and the feature simply never appears.
    //
    // A sum of smooth noises is close enough to normal to invert properly, and the
    // logistic approximation to the normal quantile is accurate to a couple of per
    // cent over the range that matters here and costs one logarithm.
    //
    // The constant is the field's standard deviation times 0.5513, and it has to be
    // the measured one. Interpolated value noise is far narrower than its own range
    // suggests — about 0.19 here, not the 0.31 a first guess gives — and being high
    // by that factor puts every threshold well out into the tail, so a province
    // asked to cover a quarter of a body covers a twelfth. It must stay in step
    // with provinceEdgeKm in geology.js, which inverts the same mapping.
    float threshold = ${PROVINCE_QUANTILE.toFixed(4)} * log(coverage / (1.0 - coverage));

    // Low ground first, because that is the physical order: lava fills basins, it
    // does not coat summits, and a rift opens where the crust is already thin.
    float span = max(2.0 * edge, 1e-5);
    float t = (crust.x - threshold + edge) / span;
    if (t <= 0.0) return vec4(1.0, 0.0, 0.0, 0.0);
    if (t >= 1.0) return vec4(0.0);
    float s = t * t * (3.0 - 2.0 * t);
    float ds = 6.0 * t * (1.0 - t);
    return vec4(1.0 - s, -crust.yzw * ds / span);
  }

  // --- volcanic resurfacing -------------------------------------------------

  /**
   * Lava ponding to a level and burying everything below it.
   *
   * This is the one geological process that has to be applied as an operator on
   * the terrain rather than added to it. Every other term here contributes relief;
   * flooding *removes* it, and that is the entire point. The lunar mare are not a
   * layer of smooth ground laid on top of the highlands, they are the highlands
   * with three kilometres of basalt poured into the low parts, and what makes
   * them convincing is the craters that are half drowned at the shoreline and the
   * ghost craters showing faintly through where the fill only just covered them.
   * Adding a smooth plain on top produces none of that; taking a smooth maximum
   * against a datum produces all of it for free.
   *
   * The datum is not flat. A ponded surface follows an equipotential, so it is
   * given a very slight long-wavelength tilt, and wrinkle ridges — the low
   * sinuous compressional ridges that cross every mare on the Moon and every
   * smooth plain on Mercury, formed as the cooling fill contracted. Without them
   * a flooded basin is a suspiciously perfect surface, and they are the detail
   * that says lava rather than paint.
   *
   * level is where the fill sits, in the same units as the terrain, measured
   * against the crust field's zero.
   */
  vec4 floodPlains(vec4 terrain, vec3 dir, vec4 mask, float level, float ridges, float softness) {
    if (mask.x <= 0.001) return terrain;

    // Wrinkle ridges: long, low, sinuous. Built from the zero set of a warped
    // noise field the same way fractures are, but positive and much gentler —
    // these stand tens of metres above a plain hundreds of kilometres across.
    vec4 datum = vec4(level, 0.0, 0.0, 0.0);
    if (ridges > 0.0) {
      vec4 warp = noised(dir * 3.1);
      vec4 field = noised(dir * 7.3 + warp.x * 0.8);
      float ridge = 1.0 - abs(field.x);
      // Sharpened so the ridges stay narrow instead of reading as broad swells.
      float shaped = ridge * ridge * ridge;
      datum.x += ridges * shaped;
      datum.yzw += ridges * 3.0 * ridge * ridge * (-sign(field.x)) * field.yzw * 7.3;
    }

    // Flood, then fade the result back out towards the untouched terrain at the
    // province margin.
    //
    // The obvious alternative — pulling the datum far below the terrain outside the
    // province so the maximum becomes a no-op — does not work, and failed silently
    // for a long time. A sentinel low enough to be safely out of the way is orders
    // of magnitude larger than the terrain, so as soon as the mask is anywhere
    // between nothing and one the interpolated datum is dominated by the sentinel
    // and lands far below the ground. Flooding then happens only where the mask is
    // exactly one, which is a fraction of the province it was asked for, with a
    // hard edge and no shoreline at all.
    //
    // Blending the two heights instead gives a shoreline that thins out, and it
    // keeps what matters about the operator: inside the province the fill is a
    // maximum against the datum, so a crater rim standing above the lava stays
    // standing rather than fading out, which is what makes a drowned crater read
    // as drowned.
    vec4 flooded = smoothMaxD(terrain, datum, softness);
    return vec4(
      mix(terrain.x, flooded.x, mask.x),
      mix(terrain.yzw, flooded.yzw, mask.x) + (flooded.x - terrain.x) * mask.yzw
    );
  }

  // --- rifts ----------------------------------------------------------------

  /**
   * Rift canyons: flat-floored, steep-walled troughs kilometres deep.
   *
   * Not the same feature as fractureTerrain, which makes the narrow grooved
   * networks that cover the icy satellites. A rift is a single enormous
   * structure — Valles Marineris runs a quarter of the way round Mars and is
   * seven kilometres deep, Ithaca Chasma most of the way round Tethys — and the
   * things that make it read correctly are the flat floor, the walls breaking
   * away in terraced scarps, and the fact that there is one of them rather than a
   * network. Rendering it as a deeper fracture gives a V-shaped notch, which is
   * what a crack looks like and not what a collapsed graben looks like.
   *
   * Confined to a province, because a rift system that circles the whole body in
   * every direction is the specific failure this is meant to avoid.
   */
  vec4 riftTerrain(vec3 dir, vec4 mask, float freq, float depth, float width) {
    if (mask.x <= 0.001 || depth <= 0.0) return vec4(0.0);

    // Warped so the rift curves and branches rather than running as a great
    // circle. The warp is coarse relative to the field, which bends the line
    // without breaking it into pieces.
    vec4 warp = noised(dir * freq * 0.4);
    vec4 field = noised(dir * freq + warp.x * 0.9);
    float distance = abs(field.x);
    vec3 gradient = sign(field.x) * field.yzw * freq;

    float u = distance / width;
    if (u > 1.5) return vec4(0.0);

    float height = 0.0;
    float slope = 0.0;
    if (u < 0.45) {
      // Floor. Flat, with a hint of fill so it is not mathematically level.
      height = -1.0;
      slope = 0.0;
    } else if (u < 1.0) {
      // Wall. Steep, and stepped: the terraces are slump blocks, the same
      // failure mode as a large crater wall and for the same reason.
      float t = (u - 0.45) / 0.55;
      float dt = 1.0 / 0.55;
      float ramp = t * t * (3.0 - 2.0 * t);
      float dramp = 6.0 * t * (1.0 - t) * dt;
      float steps = 0.055 * sin(t * 12.566371);
      float dsteps = 0.055 * cos(t * 12.566371) * 12.566371 * dt;
      height = -1.0 + ramp + steps;
      slope = dramp + dsteps;
    } else {
      // Shoulder: the flexural bulge either side of the trough, uplifted as the
      // floor dropped. Small, but it is what stops the rim reading as a cut.
      float t = (u - 1.0) / 0.5;
      float bump = 1.0 - t;
      height = 0.06 * bump * bump;
      slope = -0.12 * bump / 0.5;
    }

    float scale = depth * mask.x;
    return vec4(height * scale, slope * scale * gradient / width);
  }

  // --- volcanoes ------------------------------------------------------------

  /**
   * Shield volcanoes: broad low cones with a summit caldera.
   *
   * Olympus Mons is six hundred kilometres across and twenty-two high, which is a
   * slope of about four degrees — a shield volcano is an almost imperceptible
   * dome, not a peak, and drawing it as a mountain gets it wrong in the most
   * visible way. What identifies one is the profile: convex-up flanks, a
   * distinct break in slope at the summit, and a caldera sunk into the top, often
   * nested. The basal scarp where the flanks end is the other signature.
   *
   * Placed on a jittered grid like craters, but sparse, and confined to a
   * province: volcanic activity concentrates into provinces like Tharsis rather
   * than spreading evenly over a planet.
   */
  vec4 shieldVolcanoes(vec3 dir, vec4 mask, float freq, float height, float density) {
    if (mask.x <= 0.001 || height <= 0.0) return vec4(0.0);

    vec3 p = dir * freq;
    vec3 ip = floor(p);
    vec3 fp = fract(p);
    vec4 total = vec4(0.0);

    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        for (int k = -1; k <= 1; k++) {
          vec3 cell = vec3(float(i), float(j), float(k));
          float select;
          vec3 jitter;
          float radiusDraw;
          float freshness;
          craterCell(ip + cell, select, jitter, radiusDraw, freshness);
          if (select > density) continue;

          vec3 q = fp - (cell + 0.2 + 0.6 * jitter);
          float radius = 0.28 + 0.30 * radiusDraw;
          float d2 = dot(q, q);
          if (d2 > radius * radius) continue;

          float d = sqrt(d2) + 1e-6;
          float x = d / radius;
          vec3 dx = q / (d * radius);

          // Flank: convex up, so the slope steepens outward from the summit and
          // then cuts off at the basal scarp.
          float flank = 1.0 - x * x;
          float value = flank * flank * (0.55 + 0.45 * freshness);
          float slope = -4.0 * x * flank * (0.55 + 0.45 * freshness);

          // Caldera: a flat-floored collapse pit sunk into the summit, sized as a
          // fraction of the edifice.
          float rim = 0.13 + 0.09 * freshness;
          if (x < rim) {
            float t = x / rim;
            float pit = 0.42 * (1.0 - smoothstep(0.55, 1.0, t));
            value -= pit;
            slope += 0.42 * 6.0 * clamp((t - 0.55) / 0.45, 0.0, 1.0) *
                     (1.0 - clamp((t - 0.55) / 0.45, 0.0, 1.0)) / (0.45 * rim);
          }

          if (value > total.x) total = vec4(value, slope * dx * freq);
        }
      }
    }

    float scale = height * mask.x;
    return vec4(total.x * scale, total.yzw * scale);
  }

  /**
   * Deepest crater octave worth evaluating for a feature of angular size
   * sampleAngle radians: any octave whose cells fall below two samples across
   * cannot be represented and would only alias.
   *
   * Callers scale sampleAngle by CRATER_DETAIL_MARGIN before passing it in,
   * which is how much wider than a pixel a crater has to be before it is drawn.
   */
  float craterOctaveLimit(float baseFreq, float sampleAngle) {
    return log2(1.0 / max(baseFreq * sampleAngle * 2.0, 1e-9)) / log2(CRATER_LACUNARITY);
  }
`;
