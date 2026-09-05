import {
  AddEquation,
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Camera,
  Color,
  CustomBlending,
  FloatType,
  FrontSide,
  Group,
  Mesh,
  NearestFilter,
  Points,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Sphere,
  SphereGeometry,
  SrcColorFactor,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  ZeroFactor,
} from 'three';
import { CubeSphere } from './cubesphere.js';
import { hydrostaticAxes, isLocked, rotationalAxes } from './figures.js';
import { bodyGeology } from './geology.js';
import { SHADOW_GLSL } from './shadow-glsl.js';
import { CRATER_DETAIL_MARGIN, CRATER_LACUNARITY, TERRAIN_GLSL } from './terrain-glsl.js';

/** Patch budget for a body that does not ask for its own. */
const DEFAULT_MAX_PATCHES = 2400;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * A single solid body: adaptive cube-sphere terrain, real imagery, real
 * elevation where we have it, procedural relief below the data's resolution,
 * and an optional atmosphere shell.
 *
 * Positions are in kilometres, in the body's own frame. The caller is
 * responsible for placing the group relative to the camera each frame — see
 * Scene, which keeps the camera at the origin so that float32 vertex positions
 * stay precise no matter how far from the Sun we are.
 */

/**
 * Ground colours for bodies with no imagery, by what the body is made of.
 *
 * A named surface class is easier to be right about than four hand-picked
 * colours per body, and there are close to two hundred moons to cover. The
 * classes are the ones that actually recur in the solar system, and the colours
 * come from the mapped members of each: 'ice' from Rhea and Dione, 'dirtyIce'
 * from Ganymede's dark terrain, 'carbon' from Phoebe and the Jovian retrograde
 * groups, which are among the darkest surfaces known, 'rock' from the Moon's
 * highlands and maria.
 *
 * Each class gives the two province colours, an accent that appears in patches
 * within them, and the colour of frost.
 */
const SURFACE_CLASSES = {
  rock: [[0.42, 0.40, 0.37], [0.28, 0.26, 0.25], [0.52, 0.49, 0.45], [0.8, 0.8, 0.82]],
  ice: [[0.82, 0.84, 0.87], [0.66, 0.70, 0.75], [0.92, 0.94, 0.96], [0.96, 0.97, 1.0]],
  dirtyIce: [[0.55, 0.53, 0.50], [0.38, 0.36, 0.35], [0.72, 0.72, 0.71], [0.88, 0.9, 0.93]],
  // Carbonaceous: reflects a few per cent of the light falling on it, and what it
  // does reflect is slightly red.
  carbon: [[0.13, 0.11, 0.10], [0.09, 0.08, 0.075], [0.2, 0.17, 0.14], [0.5, 0.5, 0.52]],
  metal: [[0.45, 0.42, 0.38], [0.33, 0.31, 0.29], [0.58, 0.54, 0.48], [0.8, 0.8, 0.8]],
  // Iron-oxide dust, as on Mars and the redder asteroids.
  rust: [[0.55, 0.36, 0.24], [0.40, 0.25, 0.17], [0.68, 0.48, 0.33], [0.9, 0.9, 0.92]],
  // Tholins: organic haze products, which are what make Titan, Triton's poles and
  // parts of Pluto orange.
  tholin: [[0.62, 0.42, 0.26], [0.45, 0.30, 0.20], [0.76, 0.58, 0.38], [0.92, 0.9, 0.86]],
  sulphur: [[0.82, 0.72, 0.36], [0.62, 0.52, 0.24], [0.9, 0.85, 0.55], [0.95, 0.95, 0.9]],
};

/**
 * A stable pseudo-random offset per body, so that two moons sharing a surface
 * class do not come out with identical markings. Derived from the key rather
 * than drawn at random, so a given body looks the same on every visit.
 */
function seedFromKey(key = '') {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100;
}

/**
 * What shape a body ended up in, from the physics that decides it.
 *
 * Self gravity pulls a body towards hydrostatic equilibrium and the strength of
 * its material resists. Which one wins is a question of size, and the crossover
 * for rock and ice sits a few hundred kilometres across: Ceres is round, Vesta
 * is nearly round with one enormous basin flattening its south, Hyperion and
 * Phobos never relaxed at all. Ice is the weaker material, so icy bodies round
 * off smaller — Mimas is a sphere at 198 km where a rocky body that size would
 * not be.
 *
 * Above the crossover only the equilibrium figure matters, and that is solved
 * from the body's own mass in figures.js. Below it the body keeps whatever
 * triaxial shape its last large collision left, which is why a random ellipsoid
 * and low-frequency relief both scale with how far below the crossover it sits.
 * The randomness is seeded from the body's key, so a given moon has one shape
 * rather than a new one per visit.
 */
function bodyShape(spec) {
  const r = spec.radiusKm ?? 1000;
  const seed = spec.surfaceSeed ?? seedFromKey(spec.key);
  const rnd = (n) => {
    const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };

  // Icy and rubble-pile bodies relax at smaller sizes than competent rock, and
  // a body we know to be geologically active has had heat to help it along.
  const weak = spec.surfaceClass === 'ice' || spec.surfaceClass === 'enceladus';
  const strength = (weak ? 0.62 : 1) * (spec.resurfaced ? 0.75 : 1);

  // Triaxiality survives to larger sizes than sharp relief does: gravity
  // smooths topography long before it pulls the whole body round.
  const triaxial = 1 - smoothstep(150 * strength, 520 * strength, r);
  const unrelaxed = 1 - smoothstep(60 * strength, 400 * strength, r);

  const flatten = spec.flattening ?? 0;
  // Published figure first, then the equilibrium one its mass implies, then a
  // collision shape. Which of the two equilibrium forms applies is a question of
  // whether the body keeps one face to its primary: a locked moon is stretched
  // along that line and the tidal term dominates, and anything else only has its
  // own spin.
  let [sx, sy, sz] = spec.axes
    ?? (triaxial < 0.5 && !flatten
      ? (isLocked(spec) ? hydrostaticAxes(spec) : rotationalAxes(spec)) ?? [1, 1, 1]
      : [1, 1, 1]);
  if (!spec.axes && triaxial >= 0.5) {
    // A collision leaves an ordered set of axes, not three independent ones, and
    // which axis ends up where is not free either: a body spinning about its
    // longest axis is not in its lowest rotational energy state for its angular
    // momentum, and internal friction rounds it into spinning about the shortest
    // one long before we see it. So the shortest axis is the spin axis, which is
    // y here. Drawing the three independently instead lets the long axis land on
    // the pole, which is a configuration nothing in the sky is actually in.
    const e = 0.3 * triaxial;
    const bOverA = 1 - e * (0.35 + 0.5 * rnd(1));
    const cOverB = 1 - e * (0.2 + 0.45 * rnd(2));
    const a = 1;
    const b = a * bOverA;
    const c = b * cOverB;
    const mean = Math.cbrt(a * b * c);
    sx = a / mean;
    sy = c / mean;
    sz = b / mean;
  }
  sy *= 1 - flatten;

  const irregular = spec.irregular ?? 0.17 * unrelaxed * unrelaxed;

  // A close-in moon is stretched along the line to its primary by the tidal
  // quadrupole, and only a body too small for its own gravity to pull that bulge
  // back in keeps it. Phobos and Amalthea are the cases this is drawn for.
  let tidal = spec.tidal ?? 0;
  if (spec.tidal === undefined && spec.parent && spec.parent !== 'sun' && spec.orbitKm) {
    tidal = 0.05 * triaxial * (1 - smoothstep(30000, 300000, spec.orbitKm));
  }
  return { irregular, axis: [sx, sy, sz], tidal: clamp(tidal, 0, 0.12) };
}

/**
 * The giant-impact-basin scale.
 *
 * Only for small airless bodies. A body with measured elevation already carries
 * its real basins, and inventing more on top would fight the data; a body with
 * an atmosphere or active resurfacing has erased its own. What is left is the
 * moons and asteroids, where the largest impacts are a substantial fraction of
 * the body and are what gives each one its recognisable outline.
 *
 * Frequency is in cells per radius, so roughly one basin per cell puts three or
 * four of them across a hemisphere, which is the observed count. Depth is small
 * because basins are shallow for their width — a hundred-kilometre basin is a
 * few kilometres deep, where a hundred-metre crater is twenty metres deep — and
 * because the body cannot support relief much deeper than that.
 */
function basinUniforms(spec) {
  const r = spec.radiusKm ?? 1000;
  const eligible = (spec.craterOctaves ?? 6) > 0 && !spec.dem && !spec.atmosphere && r < 1400;
  // Crater density is already this catalogue's record of how saturated a surface
  // is, so it doubles as the test for whether basins survived: Enceladus is
  // resurfaced and sits at 0.14, where the battered moons sit near 0.65. Larger
  // bodies keep basins too, but relative to their size they are shallower and
  // fewer, and their ordinary crater field is doing more of the work already.
  const saturation = smoothstep(0.15, 0.5, spec.craterDensity ?? 0.55);
  const scale = (1 - smoothstep(300, 1400, r)) * saturation;
  return {
    uBasinFreq: { value: spec.basinFreq ?? 2.6 },
    uBasinDepth: { value: spec.basinDepth ?? (eligible ? 0.22 * scale : 0) },
  };
}

function paletteUniforms(spec) {
  const classed = SURFACE_CLASSES[spec.surfaceClass ?? 'rock'] ?? SURFACE_CLASSES.rock;
  const palette = spec.palette ?? classed;
  const [a, b, c, d] = palette;
  return {
    uPaletteA: { value: new Color(...a) },
    uPaletteB: { value: new Color(...b) },
    uPaletteC: { value: new Color(...c) },
    uPaletteD: { value: new Color(...d) },
    // Provinces scale with the body: the same number of them across a 10 km
    // moonlet and a 2,000 km one, which is roughly what impact and resurfacing
    // history produces.
    uPaletteFreq: { value: spec.paletteFreq ?? 2.6 },
    uIceLatitude: { value: spec.iceLatitude ?? 0 },
    uSurfaceSeed: { value: spec.surfaceSeed ?? seedFromKey(spec.key) },
  };
}

/**
 * Fracture relief, shared by both shader stages so the geometry the vertex
 * shader builds and the normals the fragment shader shades it with cannot
 * disagree.
 */
const FRACTURE_GLSL = /* glsl */ `
  uniform float uFractureFreq;
  uniform float uFractureOctaves;
  uniform float uFractureDepth;
  uniform float uFractureWidth;

  vec4 fractureHeight(vec3 d, float pixelAngle) {
    if (uFractureDepth < 0.001) return vec4(0.0);

    // Same reasoning as the crater limit: an octave whose features land inside a
    // couple of pixels can only shimmer, so it is faded out instead.
    float limit =
      log2(1.0 / max(uFractureFreq * pixelAngle * CRATER_DETAIL_MARGIN * 2.0, 1e-9)) / log2(2.3);
    float octaves = clamp(min(uFractureOctaves, limit), 0.0, 5.0);
    if (octaves <= 0.05) return vec4(0.0);

    float cellKm = uRadius / uFractureFreq;
    return fractureTerrain(d, uFractureFreq, octaves, uFractureWidth) * cellKm * uFractureDepth;
  }
`;

// A custom ShaderMaterial does not get the logarithmic depth buffer for free:
// the renderer only defines USE_LOGDEPTHBUF, and the shader has to include the
// chunks that actually write gl_FragDepth. Without them the terrain falls back
// to hardware depth across a range of 1 metre to 1e11 km, and z-fighting eats
// the surface at grazing angles.
/**
 * Procedural relief, shared by both shader stages for the same reason the
 * fractures are: the vertex stage displaces the geometry with the height and the
 * fragment stage shades it with the gradient, and if the two are separate copies
 * of the arithmetic they drift. They had drifted — the two lists of terms had to
 * be kept in step by hand, and a body lit from slightly the wrong direction is
 * what that looks like when it goes wrong.
 *
 * It also has to be one function rather than two because volcanic flooding is an
 * operator on the terrain rather than a contribution to it, and taking a maximum
 * against a datum needs the height and the gradient at the same time.
 */
const RELIEF_GLSL = /* glsl */ `
  // One uniform per knob rather than packed vectors, so that every process can be
  // switched off by itself from a test or a diagnostic view. Telling a procedural
  // artefact apart from a measured one means being able to render the same frame
  // with one term missing, and that is worth more than nine saved uniforms.
  uniform float uCrustRelief;      // km, highland against lowland
  uniform float uFloodCoverage;    // fraction of the body the lava reached
  uniform float uFloodLevel;       // km, where the fill sits
  uniform float uFloodWrinkle;     // km, compressional ridges on the plains
  uniform float uFloodSoftness;    // km, how sharp the shoreline is
  uniform float uRiftCoverage;
  uniform float uRiftFreq;
  uniform float uRiftDepth;        // km
  uniform float uRiftWidth;
  uniform float uVolcanoCoverage;
  uniform float uVolcanoFreq;
  uniform float uVolcanoHeight;    // km
  uniform float uVolcanoDensity;
  uniform float uDebugGeology;

  // Written by proceduralTerrain purely so a diagnostic can draw them.
  float gFloodMask;
  float gTerrainHeight;
  vec4 proceduralTerrain(
    vec3 d, float pixelAngle, vec3 sunDir, float wantShadow,
    out float shade, out vec2 marks, out float fracture, out float fill
  ) {
    shade = 0.0;
    marks = vec2(0.0);
    fracture = 0.0;
    fill = 0.0;
    if (uCraterOctaves < 0.05 && uRoughness < 0.001 && uFractureDepth < 0.001 &&
        uIrregular < 0.001 && uMacroRelief < 0.001 && uBasinDepth < 0.001 &&
        uCrustRelief < 0.001 && uFloodCoverage < 0.001 && uRiftCoverage < 0.001 &&
        uVolcanoCoverage < 0.001) return vec4(0.0);

    float cellKm = uRadius / uCraterFreq;
    float octaves = clamp(
      min(uCraterOctaves, craterOctaveLimit(uCraterFreq, pixelAngle * CRATER_DETAIL_MARGIN)), 0.0, 7.0);

    vec4 t = vec4(0.0);

    // The crust comes first, because everything regional is positioned by it: it
    // is both the largest relief on the body and the field that decides where the
    // lava goes, where the rift opens and where the volcanoes stand.
    vec4 crust = vec4(0.0);
    bool regional = uCrustRelief > 0.001 || uFloodCoverage > 0.001 ||
                    uRiftCoverage > 0.001 || uVolcanoCoverage > 0.001;
    if (regional) {
      crust = crustField(d, uSurfaceSeed);
      t += crust * uCrustRelief;
    }
    // Giant impact basins. The crater octaves below start at a cell of a
    // kilometre or two and only get finer, which is the right range for the
    // craters that cover a surface but leaves out the few impacts large enough
    // to have reshaped the whole body: Herschel across a third of Mimas,
    // Rheasilvia taking the south of Vesta, Stickney on Phobos. Those have their
    // own statistics — a handful of them, far shallower for their width than a
    // small crater, and complex without exception — so they get a coarse pass of
    // their own rather than more octaves on the same one.
    if (uBasinDepth > 0.001) {
      // A basin is wide enough to be resolved from any distance the body itself
      // is, so this pass never fades out.
      float basinShade;
      vec2 basinMarks;
      float basinCellKm = uRadius / uBasinFreq;
      t += craterTerrain(
        d, uBasinFreq, 1.0, 0.3, basinCellKm, 0.0,
        sunDir, wantShadow * uBasinDepth, basinShade, basinMarks
      ) * (basinCellKm * uBasinDepth);
      shade = basinShade;
      marks = basinMarks;
    }
    if (octaves > 0.05) {
      // Heights are exaggerated relative to the horizontal scale, so shadow
      // geometry uses the same factor or the shadows will not match the relief
      // casting them.
      float craterShade;
      vec2 craterMarks;
      float craterScale = uCraterDepth * CRATER_DEPTH_NORM;
      t += craterTerrain(
        d, uCraterFreq, octaves, uCraterDensity, cellKm, uComplexKm,
        sunDir, wantShadow * craterScale, craterShade, craterMarks
      ) * (cellKm * craterScale);
      // Shadows from every scale compound: a boulder field inside a shadowed
      // crater floor is not lit twice.
      shade = shade + craterShade * (1.0 - shade);
      marks = max(marks, craterMarks);
    }
    float roughFade = smoothstep(2.0, 6.0, 1.0 / max(uCraterFreq * 0.6 * pixelAngle, 1e-9));
    if (uRoughness > 0.001 && roughFade > 0.001) {
      vec4 rough = fbmd(d * uCraterFreq * 0.6, 5, 2.03, 0.5);
      float scale = cellKm * uRoughness * roughFade;
      t.x += rough.x * scale;
      t.yzw += rough.yzw * uCraterFreq * 0.6 * scale;
    }
    // How deep into a fracture the point sits is handed back for colouring: fresh
    // ice exposed in a trough is brighter than the surrounding surface on
    // Enceladus and darker on Europa, and either way the lines are as much a
    // colour feature as a shape one.
    vec4 fractures = fractureHeight(d, pixelAngle);
    t += fractures;
    fracture = clamp(-fractures.x / max(uRadius / uFractureFreq * uFractureDepth, 1e-6), 0.0, 1.0);
    if (uMacroRelief > 0.001) {
      vec4 ridges = ridgedd(d * 2.2 + uSurfaceSeed * 0.01, 5);
      float scale = uRadius * uMacroRelief;
      t.x += ridges.x * scale;
      t.yzw += ridges.yzw * 2.2 * scale;
    }
    if (uIrregular > 0.001) {
      vec4 n1 = noised(d * 1.55 + uSurfaceSeed);
      vec4 n2 = noised(d * vec3(2.7, 2.1, 3.4) + 5.2);
      vec4 n3 = noised(d * vec3(4.8, 3.3, 2.4) + 11.0);
      float scale = uRadius * uIrregular;
      t.x += (n1.x * 0.52 + n2.x * 0.33 + n3.x * 0.15) * scale;
      // Each octave is stretched along different axes, so the chain rule brings
      // back its own frequency vector rather than one shared scalar.
      t.yzw += (n1.yzw * 1.55 * 0.52
              + n2.yzw * vec3(2.7, 2.1, 3.4) * 0.33
              + n3.yzw * vec3(4.8, 3.3, 2.4) * 0.15) * scale;
    }

    if (regional) {
      // Lava first, because it buries what came before it: the craters above are
      // older than the plains, and the ones near the shoreline should be standing
      // in it up to their rims.
      if (uFloodCoverage > 0.001) {
        float before = t.x;
        vec4 lavaMask = provinceMask(crust, uFloodCoverage, 0.05);
        t = floodPlains(
          t, d, lavaMask, uFloodLevel, uFloodWrinkle, max(uFloodSoftness, 1e-4)
        );
        fill = t.x - before;
        gFloodMask = lavaMask.x;
        gTerrainHeight = before;
      }
      // Then the rift, which is younger than the plains it cuts through, and the
      // volcanoes, which stand on top of them.
      if (uRiftCoverage > 0.001) {
        t += riftTerrain(
          d, provinceMask(crust, uRiftCoverage, 0.04),
          uRiftFreq, uRiftDepth, max(uRiftWidth, 1e-4)
        );
      }
      if (uVolcanoCoverage > 0.001) {
        // On high ground, unlike the lava and the rift. A volcanic province is
        // built up by its own output and sits on a rise — Tharsis stands several
        // kilometres above the datum it erupted onto — so the mask is taken
        // against the inverted crust field.
        t += shieldVolcanoes(
          d, provinceMask(vec4(-crust.x, -crust.yzw), uVolcanoCoverage, 0.05),
          uVolcanoFreq, uVolcanoHeight, uVolcanoDensity
        );
      }
    }

    return t;
  }

  float proceduralHeight(vec3 d, float pixelAngle) {
    // Shadows and albedo marks are shading terms and belong per pixel, not per
    // vertex, so no sun direction is supplied here.
    float ignoredShade;
    vec2 ignoredMarks;
    float ignoredFracture;
    float ignoredFill;
    return proceduralTerrain(
      d, pixelAngle, vec3(0.0, 1.0, 0.0), 0.0,
      ignoredShade, ignoredMarks, ignoredFracture, ignoredFill
    ).x;
  }
`;

/**
 * Everything the height of the surface is built from, in one place because two
 * programs need it: the terrain's own vertex stage, and the ground probe that
 * reads heights back for anything which has to stand on that terrain.
 *
 * The sharing is the whole point. A lander positioned from a second copy of this
 * arithmetic sits wherever the two copies disagree, and they disagree by
 * kilometres: the Apollo landers were placed on the reference sphere plus the
 * measured map, while the surface being drawn was that plus procedural relief,
 * which put them underground.
 */
const SURFACE_UNIFORMS_GLSL = /* glsl */ `
  uniform float uRadius;
  uniform float uDemStrength;
  uniform vec4 uDem;              // scaleKm, offsetKm, texelU, texelV
  uniform sampler2D uDemMap;
  uniform float uHasDem;
  uniform float uDemLodBias;
  uniform vec3 uCameraLocal;      // body frame, km
  uniform float uPixelsPerRadian;
  uniform float uCraterFreq;
  uniform float uCraterOctaves;
  uniform float uCraterDepth;
  uniform float uCraterDensity;
  uniform float uComplexKm;
  uniform float uBasinFreq;
  uniform float uBasinDepth;
  uniform float uRoughness;
  uniform float uMacroRelief;
  uniform float uIrregular;
  uniform float uSurfaceSeed;
  uniform float uSeaLevelKm;      // 0 for a dry world
`;

const HEIGHT_GLSL = /* glsl */ `
  vec2 dirToUv(vec3 d) {
    // Equirectangular, matching the source maps: u from longitude measured off
    // the -X axis, v from latitude. Bodies are built so that +Y is north.
    float lon = atan(d.z, -d.x);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    return vec2(0.5 + lon / 6.2831853, 0.5 + lat / 3.14159265);
  }

  /**
   * Measured elevation in kilometres, read at the resolution this vertex spacing
   * can actually carry. A vertex shader gets no automatic mip selection, so the
   * level is computed here; asking for the full-resolution map where quads span
   * kilometres corrugates the surface, because each row of vertices lands on a
   * different phase of terrain it is too coarse to represent.
   */
  float demHeight(vec3 d, float pixelAngle) {
    if (uHasDem < 0.5) return 0.0;
    float texelAngle = 6.2831853 * uDem.z;
    // Vertices are several pixels apart by design, so the level follows the quad
    // spacing rather than the pixel spacing.
    float lod = max(log2(max(pixelAngle * 5.0, 1e-9) / texelAngle), 0.0) + uDemLodBias;
    lod = max(lod, 0.0);
    return textureLod(uDemMap, dirToUv(d), lod).r;
  }

  /**
   * Angular size of a screen pixel at a point on the sphere. This is a smooth
   * field over the surface, which is the whole point: it decides how much relief
   * gets built, and if that decision came from the patch's own subdivision level
   * instead, two patches meeting at a seam would build different terrain and
   * leave a cliff along every LOD boundary.
   */
  float pixelAngleAt(vec3 d) {
    vec3 toCamera = uCameraLocal - d * uRadius;
    float dist = max(length(toCamera), 1e-4);
    // Foreshortening: seen edge on, a quad covers far more ground along the view
    // direction than across it, and relief has to be filtered to the larger of
    // the two. Without this the ground towards the horizon is sampled far finer
    // than it can carry and corrugates into streaks along the view direction.
    float grazing = max(dot(d, toCamera / dist), 0.03);
    return (dist / uRadius) / uPixelsPerRadian * min(1.0 / grazing, 32.0);
  }

  /** Height of the drawn surface above the reference radius, in kilometres. */
  float surfaceHeightKm(vec3 d, float pixelAngle) {
    float h = demHeight(d, pixelAngle) * uDemStrength + proceduralHeight(d, pixelAngle);
    // A sea is drawn by flooding the terrain rather than by laying a second
    // sphere over it: below the waterline the drawn surface is the waterline.
    // Doing it here rather than only in the fragment stage is what makes the
    // horizon of an ocean world straight, and what stops a seabed trench from
    // showing through the water as a dent in the silhouette.
    return uSeaLevelKm > 0.0 ? max(h, uSeaLevelKm) : h;
  }
`;

const VERTEX = /* glsl */ `
  precision highp float;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  attribute vec2 grid;
  attribute float skirt;
  attribute vec3 iOrigin;
  attribute vec3 iRight;
  attribute vec3 iUp;
  attribute float iLevel;
  attribute float iMorph;

  uniform float uFlattening;
  uniform float uPatchResolution;
  // Negative to use each patch's own morph, which is what rendering does. Pinning
  // it instead is how the terrain continuity check measures the size of the pop
  // the morph removes, by holding the camera still and comparing a tessellation
  // against the same one with a level added.
  //
  // uMorphLevel picks which level the pinned value applies to; every other level
  // is unmorphed. That targeting is the whole point. Pinning all levels at once
  // would collapse each of them onto its own parent, so the deep patches would be
  // measured against a coarsened version of the thing they are supposed to match
  // rather than against the thing itself. Negative applies it to every level.
  uniform float uMorphOverride;
  uniform float uMorphLevel;
  uniform float uSkirtScale;
  uniform vec3 uAxisScale;
  uniform vec3 uTideDir;
  uniform float uTidal;

  varying vec3 vDir;
  varying float vLevel;
  varying float vHeight;
  varying vec3 vLocal;

  ${SURFACE_UNIFORMS_GLSL}
  ${TERRAIN_GLSL}
  ${FRACTURE_GLSL}
  ${RELIEF_GLSL}
  ${HEIGHT_GLSL}

  void main() {
    // Slide this vertex onto the parent patch's lattice, by iMorph.
    //
    // A child patch has the same vertex count as its parent over half the span,
    // so every other one of its vertices sits exactly on a parent vertex and the
    // ones between do not. Rounding each index to the nearest even one therefore
    // collapses the in-between vertices onto their neighbours, and the surface
    // that survives passes only through points the parent also has: at iMorph = 1
    // the child is the parent, triangle for triangle, and the moment the quadtree
    // swaps one for the other nothing on screen moves.
    //
    // Rounding rather than averaging is the point. Averaging would put the vertex
    // halfway along the parent's edge in cube space, which is not where the
    // parent's surface is — the parent interpolates its own two vertices linearly,
    // and the sphere and its relief both curve away from that line.
    float morph = iMorph;
    if (uMorphOverride >= 0.0) {
      morph = (uMorphLevel < 0.0 || abs(iLevel - uMorphLevel) < 0.5) ? uMorphOverride : 0.0;
    }
    vec2 lattice = floor(grid * uPatchResolution * 0.5 + 0.5) * 2.0 / uPatchResolution;
    vec2 warped = mix(grid, lattice, morph);

    vec3 cube = iOrigin + warped.x * iRight + warped.y * iUp;
    vec3 dir = normalize(cube);

    float pixelAngle = pixelAngleAt(dir);
    float height = surfaceHeightKm(dir, pixelAngle);

    // Skirt vertices drop below the surface so the curtain fills any crack
    // against a coarser neighbour. The gap it has to cover is the relief across
    // one quad, not across the whole patch, so the depth is scaled by the quad
    // spacing; sizing it off the patch made curtains deep enough to show through
    // the limb as a hatched band.
    float quadArc = length(iRight) / uPatchResolution;
    if (skirt > 0.5) height -= (quadArc * uRadius * 0.25 + 0.004) * uSkirtScale;

    vec3 local = dir * (uRadius + height);
    local *= uAxisScale;
    if (uTidal > 0.001) {
      float c = dot(dir, uTideDir);
      local += dir * (uRadius * uTidal * (3.0 * c * c - 1.0));
    }

    vDir = dir;
    vLevel = iLevel;
    vHeight = height;
    vLocal = local;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(local, 1.0);

    #include <logdepthbuf_vertex>
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform float uRadius;
  uniform sampler2D uColourMap;
  uniform sampler2D uNightMap;
  uniform sampler2D uOceanMap;
  uniform sampler2D uDemMap;
  uniform sampler2D uNormalMap;
  uniform vec4 uDem;
  uniform float uHasDem;
  uniform float uHasNormal;
  uniform float uHasColourMap;
  uniform float uHasNight;
  uniform float uHasOcean;
  uniform vec3 uPaletteA;         // base ground
  uniform vec3 uPaletteB;         // the other province
  uniform vec3 uPaletteC;         // patchy accent within both
  uniform vec3 uPaletteD;         // frost
  uniform float uPaletteFreq;
  uniform float uIceLatitude;     // |sin(latitude)| where frost begins, 0 for none
  uniform float uSurfaceSeed;
  uniform float uDemStrength;
  uniform float uCraterFreq;
  uniform float uCraterOctaves;
  uniform float uCraterDepth;
  uniform float uCraterDensity;
  uniform float uComplexKm;
  uniform float uMarkContrast;
  uniform float uFractureTint;
  uniform float uRoughness;
  uniform vec3 uSunDir;           // body frame, unit
  uniform vec3 uSunColour;
  uniform float uSunIntensity;
  uniform vec3 uCameraLocal;      // body frame, km
  uniform float uAlbedoBoost;
  uniform float uPhotometry;      // 0 = lambert, 1 = Lommel-Seeliger regolith
  uniform vec3 uAtmosphereTint;
  uniform float uAtmosphereDensity;
  uniform float uSpecular;
  uniform float uPixelsPerRadian;
  uniform float uPolarSmooth;
  uniform float uBanding;         // 0 for a solid surface, 1 for zonal cloud
  uniform float uMacroRelief;
  uniform float uIrregular;
  uniform vec3 uAxisScale;
  uniform vec3 uTideDir;
  uniform float uTidal;
  uniform float uBasinFreq;
  uniform float uBasinDepth;
  uniform float uMicroDetail;
  uniform float uTerrainShadows;
  uniform float uSeaLevelKm;
  uniform vec3 uSeaDeep;
  uniform vec3 uSeaShallow;
  uniform float uCloudCover;
  uniform float uCloudFreq;
  uniform float uCloudHeight;
  uniform float uCloudSeed;
  uniform vec3 uCloudTint;
  uniform float uSlopeRock;
  uniform float uHasRings;
  uniform float uRingInner;
  uniform float uRingOuter;
  uniform sampler2D uRingMap;
  uniform float uHasRingMap;
  uniform float uSunAngular;
  uniform vec4 uOcculter;
  uniform vec4 uOcculter2;
  uniform vec3 uUmbraColour;
  uniform float uUmbraLight;
  uniform float uRingTau;
  uniform vec3 uShineDir;
  uniform vec3 uShineColour;
  uniform float uShine;

  varying vec3 vDir;
  varying float vLevel;
  varying float vHeight;
  varying vec3 vLocal;

  ${SHADOW_GLSL}
  ${TERRAIN_GLSL}
  ${FRACTURE_GLSL}
  ${RELIEF_GLSL}

  vec2 dirToUv(vec3 d) {
    float lon = atan(d.z, -d.x);
    float lat = asin(clamp(d.y, -1.0, 1.0));
    return vec2(0.5 + lon / 6.2831853, 0.5 + lat / 3.14159265);
  }

  /**
   * Colour-map sample that does not pinch at the poles.
   *
   * Equirectangular maps put the whole pole on one row of texels. Sampling
   * that row as longitude winds around it draws a swirl — the circular blotch
   * on Saturn's north pole. Near the pole we average around the parallel, and we
   * never read the last percent of the image, where the source maps themselves
   * are stretched into noise.
   */
  vec3 sampleColourMap(vec3 dir, vec2 uv) {
    vec2 clamped = vec2(uv.x, clamp(uv.y, 0.06, 0.94));
    vec3 albedo = texture2D(uColourMap, clamped).rgb;
    if (uPolarSmooth < 0.01) return albedo;
    float pole = smoothstep(0.55, 0.80, abs(dir.y));
    if (pole < 0.01) return albedo;
    vec3 ring = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float u = (float(i) + 0.5) / 8.0;
      ring += texture2D(uColourMap, vec2(u, clamped.y)).rgb;
    }
    ring *= 0.125;
    return mix(albedo, ring, pole * uPolarSmooth);
  }

  /**
   * Albedo for a body we have never photographed.
   *
   * Almost everything this renderer can reach falls into that category. Nineteen
   * moons have been mapped; there are getting on for two hundred named ones, and
   * beyond them several thousand known planets around other stars and an
   * unbounded number of invented ones. Refusing to draw a body without imagery
   * would leave the great majority of the sky empty, so the colour comes from the
   * same noise the relief does.
   *
   * The structure is deliberately the one real bodies have: broad provinces of
   * differing material — lunar maria against highlands, Iapetus' two hemispheres,
   * Pluto's nitrogen plains — rather than uniform tinting. Latitude decides where
   * frost sits, since that is a temperature boundary and follows lines of
   * latitude on any body with an atmosphere or an ice budget.
   */
  /**
   * Cloud-top colour for a world with no surface.
   *
   * A giant's markings follow its rotation rather than any geography: zonal
   * jets shear cloud into belts that run the whole way round, so colour is
   * very nearly a function of latitude alone. The isotropic field that gives a
   * rocky world its continents is exactly the wrong structure here, and using
   * it was half of why these planets did not read as planets — blotches where
   * there should be bands, and nothing at all once the exposure clipped.
   *
   * Belt widths come from noise in latitude rather than a periodic function,
   * so they vary instead of repeating; the latitude fed in is displaced by a
   * broad field so the boundaries meander instead of ruling straight lines;
   * and the eddies inside a belt are sampled from a field squashed across
   * latitude, which stretches them along the flow the way shear does.
   */
  vec3 zonalAlbedo(vec3 dir) {
    float latitude = clamp(dir.y, -1.0, 1.0);

    // Boundaries waver. Perfect rings read as a machined object, not weather.
    float meander = fbmd(dir * 1.9 + uSurfaceSeed, 3, 2.1, 0.5).x;
    float zone = latitude + meander * 0.045;

    // Sampled along the axis only, so each parallel is one colour. Two scales
    // give broad belts with narrower ones inside them.
    float wide = fbmd(vec3(0.0, zone * 3.6, 0.0) + uSurfaceSeed, 3, 2.0, 0.5).x;
    float fine = fbmd(vec3(0.0, zone * 12.0, 0.0) + uSurfaceSeed * 1.7, 2, 2.0, 0.5).x;
    float belt = clamp(0.5 + 0.60 * wide + 0.24 * fine, 0.0, 1.0);

    vec3 colour = mix(uPaletteA, uPaletteB, smoothstep(0.30, 0.70, belt));

    // Eddies, stretched along the flow: squashing the sample across latitude
    // makes each feature many times longer in longitude than it is deep.
    vec3 sheared = vec3(dir.x, dir.y * 4.5, dir.z) * (uPaletteFreq * 2.4) + uSurfaceSeed;
    float storm = fbmd(sheared, 4, 2.17, 0.5).x * 0.5 + 0.5;
    colour = mix(colour, uPaletteC, smoothstep(0.60, 0.94, storm) * 0.6);

    // The poles run out of zonal structure and go flat and a little darker,
    // which is what the polar hoods of both solar-system giants do.
    float hood = smoothstep(0.70, 0.99, abs(latitude));
    colour = mix(colour, mix(uPaletteA, uPaletteB, 0.5) * 0.86, hood * 0.7);

    return colour;
  }

  vec3 proceduralAlbedo(vec3 dir) {
    if (uBanding > 0.001) return zonalAlbedo(dir);

    vec3 p = dir * uPaletteFreq + uSurfaceSeed;

    // Two independent fields: one broad enough to make continents, one finer for
    // the patchiness within them. Using one field for both would tie the size of
    // a province to the size of the mottling inside it.
    float province = fbmd(p, 4, 2.11, 0.5).x * 0.5 + 0.5;
    float mottle = fbmd(p * 4.3 + 17.0, 3, 2.31, 0.5).x * 0.5 + 0.5;

    vec3 colour = mix(uPaletteA, uPaletteB, smoothstep(0.28, 0.72, province));
    colour = mix(colour, uPaletteC, smoothstep(0.58, 0.95, mottle) * 0.75);

    if (uIceLatitude > 0.0 && uIceLatitude < 1.0) {
      // Caps are ragged, not drawn with a compass: the noise that breaks up the
      // surface also breaks up where frost survives, which is what gives real
      // polar caps their fingers reaching down towards the equator.
      float latitude = abs(dir.y);
      float edge = latitude + (mottle - 0.5) * 0.18;
      colour = mix(colour, uPaletteD, smoothstep(uIceLatitude - 0.1, uIceLatitude + 0.06, edge));
    }

    return colour;
  }

  /**
   * Surface normal. The procedural terms contribute their analytic gradients and
   * the measured elevation contributes a baked normal, both faded to what this
   * fragment can resolve. Also returns how much of the sun the local relief
   * blocks, which is computed here because it falls out of the same crater walk.
   */
  float gFloodFill;

  vec3 surfaceNormal(
    vec3 dir, float pixelAngle, out float shadow, out vec2 marks, out float fracture,
    out float groundKm
  ) {
    // Accumulated as a dimensionless slope, kilometres of rise per kilometre of
    // run. The procedural terms differentiate with respect to direction, so they
    // arrive as km per radian and have to be divided by the radius to become a
    // slope; the baked normal is already a slope.
    float perRadian = 1.0 / uRadius;

    // The same arithmetic the vertex stage displaced with, so the shading agrees
    // with the silhouette. Getting these out of step reads as a body lit from
    // slightly the wrong direction.
    //
    // Octave count comes from this fragment's own distance, not the body's. At
    // low altitude the ground underfoot and the horizon differ by orders of
    // magnitude, so a single figure for the whole body either aliases in the
    // distance or throws away detail nearby.
    vec4 terrain = proceduralTerrain(
      dir, pixelAngle, uSunDir, uTerrainShadows, shadow, marks, fracture, gFloodFill);
    // The seabed, before any flooding: the caller needs the depth of the water
    // over this point, and reading it back from the flooded height would give
    // zero everywhere under the sea. Procedural relief only, which is all a
    // flooded world has — the bodies with a measured elevation map are the ones
    // with a measured ocean mask, and they take the other path.
    groundKm = terrain.x;
    vec3 slope = terrain.yzw * perRadian;

    if (uTidal > 0.001) {
      slope += 6.0 * uTidal * dot(dir, uTideDir) * uTideDir;
    }
    float microFade = smoothstep(3.5e-4, 6e-5, pixelAngle);
    if (uMicroDetail > 0.001 && microFade > 0.001) {
      vec4 pebbles = fbmd(dir * 280.0 + uSurfaceSeed, 4, 2.07, 0.48);
      slope += pebbles.yzw * 280.0 * uMicroDetail * microFade;
    }

    if (uHasNormal > 0.5 && uDemStrength > 0.001) {
      // Measured slopes come from a baked normal map rather than differences of
      // the packed elevation. That map is an ordinary 8-bit texture, so the
      // hardware mipmaps and anisotropically filters it: shading stays sharp
      // underfoot and quiet at the limb, whereas differencing the elevation
      // needed a stencil wide enough to smear the surface into streaks.
      vec3 packed = normalize(texture2D(uNormalMap, dirToUv(dir)).xyz * 2.0 - 1.0);
      vec3 north = normalize(vec3(0.0, 1.0, 0.0) - dir * dir.y);
      vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), dir));
      // The floor on the vertical component bounds the slope this can produce.
      // Filtering shortens a normal and JPEG softens it, either of which drives
      // the vertical component towards zero; dividing by it unguarded turned
      // ordinary hillsides into slopes of hundreds, drawn as hard bright ridges
      // wherever the mip level changed.
      float z = max(packed.z, 0.25);
      slope += (east * (-packed.x / z) + north * (packed.y / z)) * uDemStrength;
    }

    // Tangential slope tilts the sphere normal away from the radial direction.
    vec3 tangential = slope - dot(slope, dir) * dir;
    // The vertex stage squashes the sphere onto a triaxial ellipsoid, so the
    // normal has to be carried through the same map. Normals transform by the
    // inverse transpose, which for a diagonal scale is the reciprocal.
    return normalize((dir - tangential) / uAxisScale);
  }

  void main() {
    #include <logdepthbuf_fragment>

    vec3 dir = normalize(vDir);
    vec2 uv = dirToUv(dir);
    vec3 view = normalize(uCameraLocal - vLocal);

    // A pixel near the limb covers far more ground than one at the sub-camera
    // point, by roughly one over the cosine of the incidence angle. Procedural
    // detail is faded out over that wider footprint rather than sampled through
    // it, which is what stops the foreshortened part of the disc from aliasing.
    float grazing = max(dot(dir, view), 0.02);
    float footprintScale = min(1.0 / grazing, 24.0);
    // Angular size of one pixel projected onto this fragment's own surface.
    float pixelAngle = (length(uCameraLocal - vLocal) / uRadius) / uPixelsPerRadian * footprintScale;
    float craterShadow;
    vec2 craterMarks;
    float fractureDepth;
    float groundKm;
    vec3 normal = surfaceNormal(dir, pixelAngle, craterShadow, craterMarks, fractureDepth, groundKm);

    // How far under water this point is, and how much of the sea's own character
    // it should take on. Shallow water keeps the colour of what is below it,
    // which is what draws the shelf around a coastline; deep water does not.
    float depthKm = uSeaLevelKm > 0.0 ? uSeaLevelKm - groundKm : -1.0;
    float wet = uSeaLevelKm > 0.0
      ? smoothstep(0.0, max(uSeaLevelKm * 0.012, 0.02), depthKm)
      : 0.0;
    if (wet > 0.0) {
      // Water is flat. Taking the sphere normal back over the seabed's is what
      // makes a sea read as a sea rather than as blue-painted hills, and it is
      // also what lets the sun glint hold together across it.
      normal = normalize(mix(normal, dir, wet));
      craterShadow *= 1.0 - wet;
    }

    // The colour map runs out of resolution long before the geometry does: on a
    // moon mapped at a kilometre per pixel, everything below a kilometre is a
    // blur. Procedural craters already carry the relief below that scale, and
    // these marks carry its albedo — bright ejecta from fresh impacts, dark
    // crater floors — so the surface keeps contrast at scales the spacecraft
    // never resolved instead of dissolving into a smooth grey wash.
    vec3 albedo = (uHasColourMap > 0.5 ? sampleColourMap(dir, uv) : proceduralAlbedo(dir))
      * uAlbedoBoost;
    // Kept deliberately gentle. Relief and its shadows are what make a crater
    // read as a crater; colour marks are a supporting cue, and pushed any harder
    // they turn a cratered plain into a field of painted spots.
    albedo *= 1.0 + craterMarks.x * uMarkContrast * 0.3;
    albedo *= 1.0 - craterMarks.y * uMarkContrast * 0.12;
    albedo *= 1.0 + fractureDepth * uFractureTint;

    float steep = 1.0 - max(dot(normal, dir), 0.0);
    if (uSlopeRock > 0.001) {
      vec3 rock = mix(uPaletteC, uPaletteB, 0.35);
      albedo = mix(albedo, rock, smoothstep(0.08, 0.42, steep) * uSlopeRock);
    }
    if (uIceLatitude > 0.01 && uHasColourMap < 0.5) {
      albedo = mix(albedo, uPaletteD, smoothstep(uIceLatitude - 0.08, uIceLatitude + 0.04, abs(dir.y)) * (1.0 - steep * 0.7));
    }
    if (wet > 0.0) {
      // Deep ocean and continental shelf. The shelf colour is mixed with what is
      // under it so a sandy coast shows through the shallows and a dark one
      // does not, which is most of what makes a coastline look like one.
      float deep = smoothstep(0.0, max(uSeaLevelKm * 0.35, 0.2), depthKm);
      vec3 shelf = mix(albedo * 0.55 + uSeaShallow * 0.6, uSeaShallow, 0.55);
      albedo = mix(albedo, mix(shelf, uSeaDeep, deep), wet);
    }

    float mu0 = dot(normal, uSunDir);
    float mu = max(dot(normal, view), 0.02);

    // Shadow geometry works off the body's smooth figure rather than vLocal.
    // Relief is metres to kilometres against a terminator set by the sun's
    // half-degree disc and against occulters tens of thousands of kilometres
    // away, so it cannot honestly move either edge — but vLocal carries it
    // faceted at the patch grid's resolution, and both transitions are narrow
    // enough that those facets showed up as a staircase along the edge. Relief
    // that genuinely shadows itself is the crater walk's job, and that works per
    // pixel.
    vec3 figure = dir * uAxisScale * uRadius;

    // Geometric night: the body's own bulk blocks the Sun. Perturbed crater
    // walls on the far side can still face the sun vector; they must not be lit.
    // The soft edge is the Sun's disc rising across the local horizon, so the
    // width of the terminator is the Sun's angular size and nothing else.
    float sunAng = max(uSunAngular, 4e-4);
    float horizon = sunAboveHorizon(dot(normalize(figure), uSunDir), sunAng);

    // Eclipses. Each occulter is a sphere in this body's frame — for a moon that
    // is its planet, for a planet one of its moons — and what it removes is a
    // fraction of the Sun's disc, so umbra, penumbra and the annular case are all
    // the same calculation. Two slots, because a moon can be eclipsed by its
    // planet while sitting in another moon's shadow.
    //
    // Worked out per surface point rather than for the body as a whole, which is
    // what gives the shadow's edge its curve as it crosses the disc.
    float eclipse = 1.0;
    if (uOcculter.w > 1.0) {
      eclipse *= 1.0 - sunCoveredBySphere(uOcculter.xyz - figure, uOcculter.w, uSunDir, sunAng);
    }
    if (uOcculter2.w > 1.0) {
      eclipse *= 1.0 - sunCoveredBySphere(uOcculter2.xyz - figure, uOcculter2.w, uSunDir, sunAng);
    }

    float sunVis = horizon * eclipse;

    float NdotL = max(mu0, 0.0);
    float lit = NdotL * sunVis;

    float lambert = lit;
    float lommel = lit / max(lit + mu, 0.03) * 2.0;
    float shade = mix(lambert, lommel * mu, uPhotometry);
    shade *= 1.0 - craterShadow * 0.88 * sunVis;

    // Ring shadow. Sunlight reaching this point has crossed the ring plane, so
    // what survives is Beer-Lambert transmission through the rings' optical depth
    // along a slanted path. That is why the shadow is a narrow dark line when the
    // Sun is near the ring plane and a broad soft band when it is high: the same
    // optical depth, crossed at a different angle. A stencil with a fixed floor
    // cannot do either, and can never let the B ring go properly dark.
    float ringShade = 1.0;
    if (uHasRings > 0.5 && abs(uSunDir.y) > 0.004) {
      float tHit = -vLocal.y / uSunDir.y;
      if (tHit > 1.0) {
        vec3 onPlane = vLocal + uSunDir * tHit;
        float rr = length(onPlane.xz);
        float tt = (rr - uRingInner) / max(uRingOuter - uRingInner, 1.0);
        if (tt > 0.0 && tt < 1.0) {
          float optical = uHasRingMap > 0.5
            ? texture2D(uRingMap, vec2(tt, 0.5)).a * 0.85
            : smoothstep(0.02, 0.12, tt) * smoothstep(0.98, 0.82, tt) * 0.7;
          ringShade = slabTransmission(optical * uRingTau, uSunDir.y);
        }
      }
    }
    shade *= ringShade;

    vec3 colour = albedo * uSunColour * uSunIntensity * shade;

    // Reflected light from the host planet — earthshine, and its equivalent on
    // the moons of the giants. Scaled by the same exposure as direct sunlight, so
    // that changing the exposure moves both together instead of leaving this
    // floating at a fixed screen brightness.
    //
    // Restricted to the night side. On the day side it is four orders of
    // magnitude below the sunlight already there, so it would only add a wash.
    // Light refracted into the umbra through the occulting body's atmosphere.
    //
    // This is why a totally eclipsed Moon is a dim copper disc rather than
    // nothing at all: the Earth blocks the Sun, but its atmosphere bends a little
    // sunlight around the limb into the shadow, and the same scattering that
    // reddens a sunset reddens that light on the way through. It arrives from the
    // Sun's direction, because it comes from around the occulter that stands in
    // front of the Sun, so it uses the same illumination geometry as sunlight and
    // differs only in colour and in being confined to the shadow.
    //
    // Without it a total eclipse simply switches the body off, which is both the
    // wrong colour and, for the most-watched event in the sky, the wrong picture.
    if (uUmbraLight > 0.0) {
      float refracted = NdotL * horizon * (1.0 - eclipse) * uUmbraLight;
      colour += albedo * uUmbraColour * uSunIntensity * refracted;
    }

    float night = 1.0 - sunVis;
    float bounce = max(dot(normal, uShineDir), 0.0) * uShine * night;
    colour += albedo * uShineColour * uSunIntensity * bounce;

    // Sun glint off water. The mask comes from a measured ocean map where there
    // is one and from the flooded terrain where there is not, so an invented
    // world gets the same highlight as Earth does.
    float water = uHasOcean > 0.5 ? texture2D(uOceanMap, uv).r : wet;
    if (water > 0.001 && uSpecular > 0.0) {
      vec3 halfway = normalize(uSunDir + view);
      float spec = pow(max(dot(normal, halfway), 0.0), 220.0);
      colour += uSunColour * spec * water * uSpecular * step(0.001, lit);
    }

    // Cloud deck.
    //
    // Drawn into the surface rather than onto a shell of its own. A second
    // sphere would give real parallax and a limb you can see the deck edge-on
    // through, and it would also double the draw and the fragment cost of every
    // world that has weather. The offset below buys most of the parallax for
    // none of that: the cloud field is sampled along the view direction at the
    // deck's altitude, so it slides against the ground as you move, which is the
    // part the eye actually reads.
    if (uCloudCover > 0.001) {
      vec3 look = normalize(dir * (1.0 + uCloudHeight) - view * uCloudHeight * 1.4);
      // Sampled faster in latitude than in longitude, so systems come out drawn
      // out east-west the way rotation actually shears weather, instead of as
      // isotropic blobs.
      vec3 q = look * uCloudFreq * vec3(1.0, 2.4, 1.0) + uCloudSeed;
      float f = fbmd(q, 5, 2.17, 0.52).x * 0.5 + 0.5;
      float wisp = fbmd(q * 3.7 + 41.0, 3, 2.4, 0.5).x * 0.5 + 0.5;
      float deck = clamp(f * 0.78 + wisp * 0.22, 0.0, 1.0);
      // Detail added on approach, at the rate the deck's own cells outgrow a
      // pixel. Without it the field keeps the size it had from orbit and low
      // altitude flies under a single smear that covers the sky; with it, the
      // pattern seen from orbit is unchanged and closing on it resolves cloud
      // into cloud. Costs nothing until the fragments are actually close.
      float near = clamp(log2(max(2.0e-3 / max(pixelAngle, 1e-7), 1.0)) * 0.22, 0.0, 1.0);
      if (near > 0.004) {
        float fine = fbmd(q * 8.5 + 137.0, 4, 2.31, 0.55).x * 0.5 + 0.5;
        deck = mix(deck, deck * 0.6 + fine * 0.4, near);
      }
      // An fbm's values crowd around the middle, so a threshold placed there
      // flips almost the whole field at once and the planet goes overcast in one
      // step. Spread the distribution first, then take the threshold from the
      // upper tail: at low cover only the peaks survive, which is what makes
      // weather read as separate storms with clear sky between them.
      deck = clamp((deck - 0.5) * 1.9 + 0.5, 0.0, 1.0);
      float edge = mix(0.93, 0.28, uCloudCover);
      float cover = smoothstep(edge, edge + 0.21, deck);
      // Clouds thin out at the poles and pile up along the tropics, which is the
      // banding that stops a planet from looking speckled.
      cover *= 0.55 + 0.45 * (1.0 - abs(dir.y));
      if (cover > 0.002) {
        float shade = max(dot(dir, uSunDir), 0.0);
        vec3 cloudLit = uCloudTint * uSunColour * uSunIntensity
          * (shade * horizon * sunVis + 0.035 * uAtmosphereDensity);
        colour = mix(colour, cloudLit, cover * 0.88);
      }
    }

    if (uHasNight > 0.5) {
      // City lights, strongest where the sun is well below the horizon.
      float night = 1.0 - smoothstep(-0.12, 0.10, mu0);
      colour += texture2D(uNightMap, uv).rgb * night * 0.9;
    }

    if (uAtmosphereDensity > 0.0) {
      // Haze over the disc only. A term that peaks at the silhouette reads as a
      // bright outline against space, so keep this interior and dim.
      float grazing = max(dot(dir, view), 0.0);
      float haze = pow(1.0 - grazing, 1.8) * smoothstep(0.0, 0.22, grazing);
      colour += uAtmosphereTint * uAtmosphereDensity * haze * lit * 0.12;
    }

    if (uDebugGeology > 0.5) {
      // Fill depth as a map, so the question of whether the lava is reaching the
      // ground can be answered by looking rather than inferred from shading that
      // the albedo marks may be masking. Blue where the fill is deep, black where
      // there is none.
      // Red is how much of the province reaches this point, blue is how deep the
      // lava actually ended up. Red without blue means the operator is failing
      // where it is being asked to act; black everywhere means the camera is
      // simply not over a province.
      float depth = clamp(gFloodFill / 3.0, 0.0, 1.0);
      gl_FragColor = vec4(gFloodMask, clamp(gTerrainHeight / 6.0 + 0.5, 0.0, 1.0) * 0.35, depth, 1.0);
      return;
    }

    gl_FragColor = vec4(colour, 1.0);
  }
`;

const ATMOSPHERE_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

    #include <logdepthbuf_vertex>
  }
`;

/**
 * Atmospheric shell. Drawn from inside a slightly larger sphere. Additive
 * haze stays on the disc; rays that miss the planet are discarded so the
 * silhouette never gets a bright outline.
 */
const ATMOSPHERE_FRAGMENT = /* glsl */ `
  precision highp float;

  #include <common>
  #include <logdepthbuf_pars_fragment>

  uniform vec3 uSunDir;
  uniform vec3 uCameraLocal;
  uniform float uRadius;
  uniform float uShellRadius;
  uniform vec3 uTint;
  uniform float uDensity;
  uniform vec3 uSunColour;
  uniform float uSunIntensity;
  uniform float uFlattening;

  varying vec3 vLocal;

  void main() {
    #include <logdepthbuf_fragment>

    float flatten = max(1.0 - uFlattening, 0.5);
    vec3 stretch = vec3(1.0, 1.0 / flatten, 1.0);
    vec3 worldPos = vec3(vLocal.x, vLocal.y * flatten, vLocal.z);
    vec3 origin = uCameraLocal * stretch;
    vec3 ray = normalize((worldPos - uCameraLocal) * stretch);

    float b = dot(origin, ray);
    float c = dot(origin, origin) - uShellRadius * uShellRadius;
    float disc = b * b - c;
    if (disc < 0.0) discard;
    float sq = sqrt(disc);
    float near = -b - sq;
    float far = -b + sq;
    near = max(near, 0.0);

    float thickness = max(uShellRadius - uRadius, 1e-4);
    float cSurface = dot(origin, origin) - uRadius * uRadius;
    float discSurface = b * b - cSurface;
    bool hitsGround = false;
    if (discSurface > 0.0) {
      float hit = -b - sqrt(discSurface);
      if (hit > 0.0) {
        far = min(far, hit);
        hitsGround = true;
      }
    }
    float path = max(far - near, 0.0);
    if (path < 1e-6) discard;

    if (!hitsGround) discard;
    float chord = 1.0 - exp(-min(path / thickness, 4.0) * 0.4);

    vec3 mid = origin + ray * (near + path * 0.5);
    float altitude = (length(mid) - uRadius) / thickness;
    float density = exp(-altitude * 4.0);

    float mu = dot(normalize(mid / stretch), uSunDir);
    float daylight = smoothstep(0.0, 0.16, mu);
    float cosSun = dot(normalize(worldPos - uCameraLocal), uSunDir);
    float phase = 0.65 + 0.35 * cosSun * cosSun;

    vec3 colour = uTint * uSunColour * min(uSunIntensity, 1.8) * uDensity
      * density * daylight * phase * chord * 0.028;
    float peak = max(max(colour.r, colour.g), colour.b);
    if (peak > 0.35) colour *= 0.35 / peak;

    gl_FragColor = vec4(colour, 1.0);
  }
`;

// ----------------------------------------------------------------------- sky

/**
 * The same shell, seen from inside it.
 *
 * The shader above is a haze that only draws where the ray hits the ground, so
 * from a surface — looking up, or out at the horizon — it drew nothing at all
 * and the sky was black with the stars still in it. There was no sunset
 * anywhere in the solar system, because a sunset is not a property of the Sun:
 * it is what a long path through air does to the light coming down it.
 *
 * So this is the single-scattering integral, which is the cheapest form of the
 * thing that is actually happening. Along the view ray, at each step, take the
 * air density, ask how much sunlight reaches that point after its own trip in
 * through the atmosphere, scatter a fraction of it towards the camera, and
 * attenuate the result on the way back. Two scatterers with different phase
 * functions and different scale heights:
 *
 *   Rayleigh, off the molecules themselves, which goes as the inverse fourth
 *   power of wavelength. This is why the daytime sky is blue and why the light
 *   left over after a long path through it is red.
 *
 *   Mie, off aerosol, which is grey and strongly forward-scattering. This is
 *   the white glare around the sun and the pale band along the horizon.
 *
 * The part that makes it a sunset rather than a tinted dome is the shadow test:
 * a sample whose path to the sun passes through the planet contributes nothing.
 * As the sun goes down the lit part of the sky climbs, the surviving light has
 * come through more and more air, and the colour falls down the spectrum on its
 * own. Nothing here is keyed to elevation angle or told to turn orange.
 *
 * Two passes, because extinction is multiplicative and in-scattering is
 * additive, and doing both in one blend would mean picking one. The first
 * multiplies whatever is behind the air — stars, another planet — by the
 * transmittance, which is what reddens the low sun's disc itself. The second
 * adds the light scattered into the ray.
 */
const SKY_COMMON = /* glsl */ `
  precision highp float;

  uniform vec3 uSunDir;
  uniform vec3 uCameraLocal;
  uniform float uRadius;
  uniform float uShellRadius;
  uniform float uFlattening;
  uniform vec3 uRayleigh;
  uniform float uMie;
  uniform float uMieG;
  uniform float uScaleHeight;
  uniform float uMieHeight;

  varying vec3 vLocal;

  /** Both roots of a ray against a sphere at the origin; x > y means a miss. */
  vec2 sphereSpan(vec3 o, vec3 d, float r) {
    float b = dot(o, d);
    float c = dot(o, o) - r * r;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(1.0, -1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
  }

  /**
   * Rayleigh and Mie column densities along a segment.
   *
   * The samples are bunched towards the start because that is where the air is
   * densest: a grazing path leaving the ground is a thousand kilometres long,
   * and spacing the samples evenly along it puts the first one so far out that
   * the whole dense near end goes uncounted.
   */
  vec2 columnAlong(vec3 o, vec3 d, float len) {
    const int N = 6;
    vec2 sum = vec2(0.0);
    float prev = 0.0;
    for (int i = 0; i < N; i++) {
      float f = float(i + 1) / float(N);
      float edge = len * f * f;
      float dt = edge - prev;
      float h = max(length(o + d * (prev + dt * 0.5)) - uRadius, 0.0);
      sum += vec2(exp(-h / uScaleHeight), exp(-h / uMieHeight)) * dt;
      prev = edge;
    }
    return sum;
  }

  /**
   * The stretch undoes the shell's oblateness so everything downstream can work
   * against a sphere, which is what the haze pass does too.
   */
  bool viewSegment(out vec3 origin, out vec3 ray, out float near, out float len) {
    float flatten = max(1.0 - uFlattening, 0.5);
    vec3 stretch = vec3(1.0, 1.0 / flatten, 1.0);
    vec3 surface = vec3(vLocal.x, vLocal.y * flatten, vLocal.z);
    origin = uCameraLocal * stretch;
    ray = normalize((surface - uCameraLocal) * stretch);

    vec2 shell = sphereSpan(origin, ray, uShellRadius);
    if (shell.y <= 0.0) return false;
    near = max(shell.x, 0.0);
    float far = shell.y;
    // Stop at the ground: air beyond it is not on this ray.
    vec2 ground = sphereSpan(origin, ray, uRadius);
    if (ground.x > 0.0 && ground.y > ground.x) far = min(far, ground.x);
    len = far - near;
    return len > 1e-6;
  }
`;

const SKY_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

    #include <logdepthbuf_vertex>
  }
`;

const SKY_EXTINCTION_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  ${SKY_COMMON}

  void main() {
    #include <logdepthbuf_fragment>

    vec3 origin, ray;
    float near, len;
    if (!viewSegment(origin, ray, near, len)) discard;

    vec2 column = columnAlong(origin + ray * near, ray, len);
    vec3 tau = uRayleigh * column.x + vec3(uMie * column.y);
    // Multiplied into the framebuffer, so the colour *is* the transmittance.
    gl_FragColor = vec4(exp(-tau), 1.0);
  }
`;

const SKY_INSCATTER_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>

  ${SKY_COMMON}

  uniform vec3 uSunColour;
  uniform float uSunIntensity;
  uniform float uBrightness;

  void main() {
    #include <logdepthbuf_fragment>

    vec3 origin, ray;
    float near, len;
    if (!viewSegment(origin, ray, near, len)) discard;

    const int STEPS = 24;

    float mu = dot(ray, uSunDir);
    // Rayleigh: 3/(16 pi) (1 + cos^2). Mie: Henyey-Greenstein.
    float phaseR = 0.0596831 * (1.0 + mu * mu);
    float g = uMieG;
    float hg = 1.0 + g * g - 2.0 * g * mu;
    float phaseM = (1.0 - g * g) / (12.5663706 * pow(max(hg, 1e-4), 1.5));

    vec2 viewColumn = vec2(0.0);
    vec3 sumR = vec3(0.0);
    vec3 sumM = vec3(0.0);

    float prev = 0.0;
    for (int i = 0; i < STEPS; i++) {
      // Same bunching as columnAlong, and for the same reason.
      float f = float(i + 1) / float(STEPS);
      float edge = len * f * f;
      float dt = edge - prev;
      vec3 p = origin + ray * (near + prev + dt * 0.5);
      prev = edge;

      float h = max(length(p) - uRadius, 0.0);
      vec2 density = vec2(exp(-h / uScaleHeight), exp(-h / uMieHeight));
      viewColumn += density * dt;

      // In the planet's own shadow: the sun is below this sample's horizon.
      vec2 blocked = sphereSpan(p, uSunDir, uRadius);
      if (blocked.x > 0.0 && blocked.y > blocked.x) continue;

      vec2 toSun = sphereSpan(p, uSunDir, uShellRadius);
      vec2 lightColumn = columnAlong(p, uSunDir, max(toSun.y, 0.0));
      vec3 tau = uRayleigh * (viewColumn.x + lightColumn.x)
        + vec3(uMie * (viewColumn.y + lightColumn.y));
      vec3 transmittance = exp(-tau);
      sumR += density.x * transmittance * dt;
      sumM += density.y * transmittance * dt;
    }

    vec3 colour = (sumR * uRayleigh * phaseR + sumM * uMie * phaseM)
      * uSunColour * min(uSunIntensity, 2.4) * uBrightness;
    gl_FragColor = vec4(colour, 1.0);
  }
`;

// --------------------------------------------------------------- ground probe

// One pixel per query, and the strip is read back whole, so this is also the
// batch size. Sixty-four covers every landing site in the solar system with room
// to spare, and a body with more of them simply takes a second pass.
const PROBE_SLOTS = 64;

/**
 * Reads surface heights back out of the terrain shader.
 *
 * Anything that stands on a surface — a lander, a rover, a camera in ground
 * view — has to know where the ground is, and the only authority on that is the
 * shader that displaces the geometry. Measured elevation can be sampled on the
 * CPU, but the procedural relief laid over it cannot: it is a hundred lines of
 * noise, crater and province arithmetic that would have to be maintained twice
 * and would drift, and the drift is not small. On the Moon it was a kilometre.
 *
 * So the height is evaluated by the same GLSL, one point per query into a
 * one-pixel-tall float target, and read back. It is a query rather than a
 * constant because the relief itself is not constant: octaves fade in as the
 * camera approaches, so the ground rises to meet it, and whatever is standing
 * there has to rise with it.
 */
const PROBE_VERTEX = /* glsl */ `
  precision highp float;

  attribute float aSlot;

  varying float vGround;

  ${SURFACE_UNIFORMS_GLSL}
  ${TERRAIN_GLSL}
  ${FRACTURE_GLSL}
  ${RELIEF_GLSL}
  ${HEIGHT_GLSL}

  void main() {
    vec3 d = normalize(position);
    vGround = surfaceHeightKm(d, pixelAngleAt(d));
    // Slot i lands dead centre of pixel i of the strip.
    gl_Position = vec4((aSlot + 0.5) / float(${PROBE_SLOTS}) * 2.0 - 1.0, 0.0, 0.0, 1.0);
    gl_PointSize = 1.0;
  }
`;

const PROBE_FRAGMENT = /* glsl */ `
  precision highp float;
  varying float vGround;
  void main() {
    gl_FragColor = vec4(vGround, 0.0, 0.0, 1.0);
  }
`;

let probeState = null;

function groundProbe() {
  if (probeState) return probeState;
  const geometry = new BufferGeometry();
  const dirs = new Float32Array(PROBE_SLOTS * 3);
  const slots = new Float32Array(PROBE_SLOTS);
  for (let i = 0; i < PROBE_SLOTS; i++) {
    slots[i] = i;
    dirs[i * 3 + 1] = 1;
  }
  geometry.setAttribute('position', new BufferAttribute(dirs, 3));
  geometry.setAttribute('aSlot', new BufferAttribute(slots, 1));
  const points = new Points(geometry, null);
  points.frustumCulled = false;
  const scene = new Scene();
  scene.add(points);
  probeState = {
    geometry,
    dirs,
    points,
    scene,
    camera: new Camera(),
    pixels: new Float32Array(PROBE_SLOTS * 4),
    target: new WebGLRenderTarget(PROBE_SLOTS, 1, {
      type: FloatType,
      format: RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
    }),
  };
  return probeState;
}

export class Planet {
  /**
   * @param {object} spec see BODIES in bodies-data.js
   */
  constructor(spec) {
    this.spec = spec;
    this.radius = spec.radiusKm;
    this.group = new Group();
    this.group.name = spec.key;
    // The body's own spin axis and rotation live on this inner group, so the
    // outer group can stay aligned with the camera-relative world.
    this.spin = new Group();
    this.group.add(this.spin);

    this.sphere = new CubeSphere({
      resolution: spec.patchResolution ?? 24,
      maxLevel: spec.maxLevel ?? 14,
      maxPatches: spec.maxPatches ?? DEFAULT_MAX_PATCHES,
      pixelsPerQuad: spec.pixelsPerQuad ?? 7,
    });

    const dem = spec.dem ?? null;
    const shape = bodyShape(spec);
    const geology = bodyGeology(spec);
    this.material = new ShaderMaterial({
      uniforms: {
        uRadius: { value: this.radius },
        uFlattening: { value: spec.flattening ?? 0 },
        uColourMap: { value: null },
        uNightMap: { value: null },
        uOceanMap: { value: null },
        uDemMap: { value: null },
        uNormalMap: { value: null },
        uDem: { value: [0, 0, 1 / 2048, 1 / 1024] },
        uHasDem: { value: 0 },
        uHasNormal: { value: 0 },
        uHasColourMap: { value: 0 },
        uHasNight: { value: 0 },
        uHasOcean: { value: 0 },
        ...paletteUniforms(spec),
        uDemStrength: { value: spec.demStrength ?? 1 },
        uCraterFreq: { value: spec.craterFreq ?? 400 },
        uCraterOctaves: { value: 0 },
        uCraterDepth: { value: spec.craterDepth ?? 0.22 },
        uCraterDensity: { value: spec.craterDensity ?? 0.55 },
        // Diameter at which craters stop being simple bowls and start
        // collapsing into terraced, flat-floored, central-peaked ones. The
        // transition is set by gravity, which for bodies of similar density
        // goes with radius, so it scales off the Moon's 18 km: a few kilometres
        // on Mercury, tens on a mid-sized icy moon.
        uComplexKm: { value: spec.complexKm ?? 18 * (1737.4 / (spec.radiusKm ?? 1737.4)) },
        ...basinUniforms(spec),
        // How strongly procedural craters mark the surface colour. Airless
        // bodies with dry regolith show this plainly; anything with an
        // atmosphere or active resurfacing scrubs it away, so the default
        // follows the same photometry figure that says how regolith-like the
        // surface is.
        uMarkContrast: { value: spec.markContrast ?? spec.photometry ?? 0.6 },
        // Fractures, in cells per radius, how many scales of them, how deep
        // relative to one cell, and how wide relative to one cell. Off unless a
        // body asks for them.
        uFractureFreq: { value: spec.fractureFreq ?? 80 },
        uFractureOctaves: { value: spec.fractureOctaves ?? 0 },
        uFractureDepth: { value: spec.fractureDepth ?? 0 },
        uFractureWidth: { value: spec.fractureWidth ?? 0.12 },
        // Positive brightens the trough, negative darkens it: Enceladus exposes
        // fresh bright ice, Europa's lineae are stained with salts and are
        // darker and redder than the plains around them.
        uFractureTint: { value: spec.fractureTint ?? 0 },
        uRoughness: { value: spec.roughness ?? 0.05 },
        // Read back off the sphere rather than from the spec: it rounds the
        // resolution to even, and the morph in the vertex shader needs the value
        // the geometry was actually built with.
        uPatchResolution: { value: this.sphere.resolution },
        uMorphOverride: { value: -1 },
        uMorphLevel: { value: -1 },
        uSkirtScale: { value: 1 },
        uDemLodBias: { value: 0 },
        uPixelsPerRadian: { value: 1000 },
        uSunDir: { value: new Vector3(1, 0, 0) },
        uSunColour: { value: new Color(1, 0.97, 0.92) },
        uSunIntensity: { value: 1 },
        uCameraLocal: { value: new Vector3() },
        uAlbedoBoost: { value: spec.albedoBoost ?? 1 },
        uPhotometry: { value: spec.photometry ?? 1 },
        uAtmosphereTint: { value: new Color(...(spec.atmosphere?.tint ?? [0.35, 0.55, 1])) },
        uAtmosphereDensity: { value: spec.atmosphere ? spec.atmosphere.density : 0 },
        uSpecular: { value: spec.specular ?? 0 },
        uPolarSmooth: { value: spec.polarSmooth ?? 0 },
        uBanding: { value: spec.banding ?? 0 },
        // Ridged noise over the whole body, which is the crude stand-in for
        // regional relief that the crust field replaces. A body with real geology
        // does not get both: the ridged term is a few thousandths of the radius
        // and always positive, so on Mars it lifts the entire surface some seven
        // kilometres above where the crust field puts it — far above any lava
        // level — and no basin ever floods. That is what kept the plains from
        // appearing at all.
        //
        // A measured elevation map is regional relief, so it rules the stand-in
        // out for the same reason, and more strongly: the map is the body's real
        // topography, and adding seven kilometres of invented swell to it both
        // wastes the data and moves the ground away from every position derived
        // from it. On the Moon it lifted the surface above the Apollo landers.
        uMacroRelief: {
          value:
            spec.macroRelief ??
            (geology.crustRelief > 0 || dem
              ? 0
              : spec.craterOctaves > 0 && spec.radiusKm < 8000
                ? 0.004
                : 0),
        },
        uIrregular: { value: shape.irregular },
        uCrustRelief: { value: geology.crustRelief },
        uFloodCoverage: { value: geology.flood[0] },
        uFloodLevel: { value: geology.flood[1] },
        uFloodWrinkle: { value: geology.flood[2] },
        uFloodSoftness: { value: geology.flood[3] },
        uRiftCoverage: { value: geology.rift[0] },
        uRiftFreq: { value: geology.rift[1] },
        uRiftDepth: { value: geology.rift[2] },
        uRiftWidth: { value: geology.rift[3] },
        uVolcanoCoverage: { value: geology.volcano[0] },
        uVolcanoFreq: { value: geology.volcano[1] },
        uVolcanoHeight: { value: geology.volcano[2] },
        uVolcanoDensity: { value: geology.volcano[3] },
        uDebugGeology: { value: 0 },
        uMicroDetail: { value: spec.microDetail ?? (spec.photometry > 0.4 ? 0.00035 : 0) },
        uTerrainShadows: { value: 1 },
        // Sea level is in kilometres above the reference radius, so it is set by
        // whoever knows how much relief the body has. See seaLevelKm below.
        uSeaLevelKm: { value: spec.seaLevelKm ?? 0 },
        uSeaDeep: { value: new Color(...(spec.seaDeep ?? [0.012, 0.045, 0.11])) },
        uSeaShallow: { value: new Color(...(spec.seaShallow ?? [0.06, 0.22, 0.30])) },
        uCloudCover: { value: spec.cloudCover ?? 0 },
        uCloudFreq: { value: spec.cloudFreq ?? 3.1 },
        uCloudHeight: { value: spec.cloudHeight ?? 0.0022 },
        uCloudSeed: { value: spec.cloudSeed ?? seedFromKey(`${spec.key}-cloud`) },
        uCloudTint: { value: new Color(...(spec.cloudTint ?? [1, 0.99, 0.97])) },
        uSlopeRock: { value: spec.slopeRock ?? (spec.photometry > 0.5 ? 0.45 : 0.15) },
        uHasRings: { value: spec.rings ? 1 : 0 },
        uRingInner: { value: spec.rings?.innerKm ?? 0 },
        uRingOuter: { value: spec.rings?.outerKm ?? 1 },
        uRingMap: { value: null },
        uHasRingMap: { value: 0 },
        uAxisScale: { value: new Vector3(...shape.axis) },
        uTideDir: { value: new Vector3(1, 0, 0) },
        uTidal: { value: shape.tidal },
        uSunAngular: { value: 0.00465 },
        uOcculter: { value: new Vector4(0, 0, 0, 0) },
        uOcculter2: { value: new Vector4(0, 0, 0, 0) },
        // The colour of sunlight that has passed twice through the length of an
        // atmosphere, which is the colour of every sunset and of the umbra.
        uUmbraColour: { value: new Color(1.0, 0.34, 0.16) },
        uUmbraLight: { value: 0 },
        // Normal optical depth the ring profile's opacity stands for. Saturn's B
        // ring reaches about 2.5, which is opaque enough to cast a genuinely dark
        // shadow; the profile's alpha scales this.
        uRingTau: { value: spec.rings?.opticalDepth ?? 2.5 },
        uShineDir: { value: new Vector3(0, 1, 0) },
        uShineColour: { value: new Color(1.0, 0.88, 0.72) },
        uShine: { value: 0 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: FrontSide,
    });

    this.mesh = new Mesh(this.sphere.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = `${spec.key}-surface`;
    this.spin.add(this.mesh);

    if (spec.atmosphere) {
      const shellRadius = this.radius * (1 + spec.atmosphere.height);
      this.atmosphereMaterial = new ShaderMaterial({
        uniforms: {
          uSunDir: { value: new Vector3(1, 0, 0) },
          uCameraLocal: { value: new Vector3() },
          uRadius: { value: this.radius },
          uShellRadius: { value: shellRadius },
          uTint: { value: new Color(...spec.atmosphere.tint) },
          uDensity: { value: spec.atmosphere.density },
          uSunColour: { value: new Color(1, 0.97, 0.92) },
          uSunIntensity: { value: 1 },
          uFlattening: { value: spec.flattening ?? 0 },
        },
        vertexShader: ATMOSPHERE_VERTEX,
        fragmentShader: ATMOSPHERE_FRAGMENT,
        side: BackSide,
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
      });
      const geometry = new SphereGeometry(shellRadius, 96, 48);
      geometry.boundingSphere = new Sphere(new Vector3(), shellRadius);
      this.atmosphere = new Mesh(geometry, this.atmosphereMaterial);
      this.atmosphere.scale.set(1, 1 - (spec.flattening ?? 0), 1);
      this.atmosphere.frustumCulled = false;
      this.atmosphere.renderOrder = 5;
      this.atmosphere.name = `${spec.key}-atmosphere`;
      this.spin.add(this.atmosphere);
      this._buildSky(spec, shellRadius, geometry);
    }

    this._cameraLocal = new Vector3();
    this._sunLocal = new Vector3();
  }

  /**
   * The sky, as two shells sharing the haze shell's geometry.
   *
   * Scattering coefficients are derived from the two numbers the body tables
   * already carry, rather than added as a third set to keep in step. `tint` is
   * the colour the air scatters, so normalised it is the Rayleigh coefficient's
   * shape; `density` scales the whole column. The constant is set by Earth,
   * whose Rayleigh optical depth straight up is about 0.23 in the blue and
   * whose density figure here is 1.6 — so 0.14 per unit of density puts Earth's
   * sky at the right depth, and every other body then follows from its own two
   * numbers. Mars comes out thin and dusty, Titan deep and orange, without any
   * of them being described twice.
   *
   * The aerosol sits in the bottom quarter of the air, as it does on Earth,
   * which is what keeps the Mie glare along the horizon instead of spreading it
   * over the whole dome.
   */
  _buildSky(spec, shellRadius, geometry) {
    const air = spec.atmosphere;
    const thicknessKm = Math.max(shellRadius - this.radius, 1e-3);
    // Earth's shell is set at 102 km and its air has a scale height of 8.5, so
    // an eighth of the modelled thickness is about right and puts the top of the
    // shell twelve scale heights up, where there is nothing left to scatter.
    const scaleHeightKm = thicknessKm / 8;
    // Aerosol sits far lower than the gas — on Earth about 1.2 km against 8.5.
    // Keeping it low is what holds the white glare down onto the horizon rather
    // than letting it wash the whole dome grey.
    const mieHeightKm = scaleHeightKm / 7;
    const tint = air.tint ?? [0.35, 0.55, 1];
    const peak = Math.max(tint[0], tint[1], tint[2]) || 1;
    const zenith = 0.14 * air.density;
    const uniforms = {
      uSunDir: { value: new Vector3(1, 0, 0) },
      uCameraLocal: { value: new Vector3() },
      uRadius: { value: this.radius },
      uShellRadius: { value: shellRadius },
      uFlattening: { value: spec.flattening ?? 0 },
      uRayleigh: {
        value: new Vector3(
          (zenith * tint[0]) / peak / scaleHeightKm,
          (zenith * tint[1]) / peak / scaleHeightKm,
          (zenith * tint[2]) / peak / scaleHeightKm,
        ),
      },
      // Clear-air aerosol: an optical depth of a few hundredths straight up.
      uMie: { value: (0.02 * air.density) / mieHeightKm },
      uMieG: { value: air.mieG ?? 0.76 },
      uScaleHeight: { value: scaleHeightKm },
      uMieHeight: { value: mieHeightKm },
    };

    this.skyUniforms = uniforms;
    this.skyExtinctionMaterial = new ShaderMaterial({
      uniforms,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_EXTINCTION_FRAGMENT,
      side: BackSide,
      // dst *= src. The pass carries transmittance as its colour, so this is
      // per-channel extinction of everything already drawn behind the air.
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: ZeroFactor,
      blendDst: SrcColorFactor,
      transparent: true,
      depthWrite: false,
      // Not depth tested. The air is in front of the ground as much as it is in
      // front of the stars, so both belong behind it — which is what makes the
      // ground go hazy with distance instead of staying crisp to the horizon.
      // Depth testing it against the terrain also produced a wireframe of the
      // patch grid: the skirts that hide the cracks between LOD levels are
      // radial walls, and seen at a grazing angle from low down they win the
      // depth test along every patch edge while the ground between them loses.
      depthTest: false,
    });
    this.skyInscatterMaterial = new ShaderMaterial({
      uniforms: {
        ...uniforms,
        uSunColour: { value: new Color(1, 0.97, 0.92) },
        uSunIntensity: { value: 1 },
        // Radiance relative to the sun's own irradiance, which is what the
        // terrain shader is scaled against too. A saturated path can only reach
        // the phase function's value, about 0.12, so this puts the brightest
        // part of a sunset horizon just under clipping and leaves the rest of
        // the sky in range beneath it.
        uBrightness: { value: air.skyBrightness ?? 5 },
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_INSCATTER_FRAGMENT,
      side: BackSide,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });

    this.sky = new Group();
    for (const [material, order] of [
      [this.skyExtinctionMaterial, 6],
      [this.skyInscatterMaterial, 7],
    ]) {
      const mesh = new Mesh(geometry, material);
      mesh.scale.set(1, 1 - (spec.flattening ?? 0), 1);
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      this.sky.add(mesh);
    }
    this.sky.name = `${spec.key}-sky`;
    this.sky.visible = false;
    this.spin.add(this.sky);
  }

  setColourMap(texture) {
    this.material.uniforms.uColourMap.value = texture;
    this.material.uniforms.uHasColourMap.value = texture ? 1 : 0;
  }

  setNightMap(texture) {
    this._nightMap = texture ?? null;
    this.material.uniforms.uNightMap.value = this._nightLights === false ? null : texture;
    this.material.uniforms.uHasNight.value = texture && this._nightLights !== false ? 1 : 0;
  }

  /** City lights on the unlit side. Kept so the map can be reinstated later. */
  setNightLights(enabled) {
    this._nightLights = enabled;
    this.setNightMap(this._nightMap ?? null);
  }

  /**
   * Shadows cast by the procedural relief onto itself.
   *
   * This is the one appearance switch that buys real frame time: the crater walk
   * computes the shadow term alongside the height, and turning it off skips that
   * half of the walk for every fragment of ground.
   */
  setTerrainShadows(enabled) {
    this.material.uniforms.uTerrainShadows.value = enabled ? 1 : 0;
  }

  setOceanMap(texture) {
    this.material.uniforms.uOceanMap.value = texture;
    this.material.uniforms.uHasOcean.value = texture ? 1 : 0;
  }

  setDemMap(texture, info) {
    const u = this.material.uniforms;
    if (texture === u.uDemMap.value) return;
    u.uDemMap.value = texture;
    u.uHasDem.value = texture ? 1 : 0;
    if (info) {
      // Heights arrive already in kilometres, so only the texel size is needed.
      u.uDem.value = [0, 0, 1 / info.width, 1 / info.height];
      this.demWidth = info.width;
    }
  }

  setNormalMap(texture) {
    const u = this.material.uniforms;
    if (texture === u.uNormalMap.value) return;
    u.uNormalMap.value = texture;
    u.uHasNormal.value = texture ? 1 : 0;
  }

  setRings(texture, innerKm, outerKm) {
    const u = this.material.uniforms;
    u.uHasRings.value = 1;
    u.uRingInner.value = innerKm;
    u.uRingOuter.value = outerKm;
    if (texture) {
      u.uRingMap.value = texture;
      u.uHasRingMap.value = 1;
    }
  }

  /**
   * Heights of the drawn surface above the reference radius, in kilometres, at
   * the given directions in this body's own frame.
   *
   * One draw and one readback per call, and a readback stalls the pipeline, so
   * callers batch their queries and cache the answers rather than asking per
   * frame. The heights follow the relief the camera is currently being shown, so
   * they do move: see the probe shader above.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {Vector3[]} dirs unit vectors in the body frame
   * @param {Float32Array} [out]
   */
  groundHeightsKm(renderer, dirs, out = new Float32Array(dirs.length)) {
    const probe = groundProbe();
    this._probeMaterial ??= new ShaderMaterial({
      // The same uniform objects, not copies: the probe has to answer for the
      // surface as it is being drawn this frame, not as it was when it was set up.
      uniforms: this.material.uniforms,
      vertexShader: PROBE_VERTEX,
      fragmentShader: PROBE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    const previous = renderer.getRenderTarget();
    for (let base = 0; base < dirs.length; base += PROBE_SLOTS) {
      const count = Math.min(PROBE_SLOTS, dirs.length - base);
      for (let i = 0; i < count; i++) {
        const dir = dirs[base + i];
        probe.dirs[i * 3] = dir.x;
        probe.dirs[i * 3 + 1] = dir.y;
        probe.dirs[i * 3 + 2] = dir.z;
      }
      probe.geometry.getAttribute('position').needsUpdate = true;
      probe.geometry.setDrawRange(0, count);
      probe.points.material = this._probeMaterial;
      renderer.setRenderTarget(probe.target);
      renderer.render(probe.scene, probe.camera);
      renderer.readRenderTargetPixels(probe.target, 0, 0, count, 1, probe.pixels);
      for (let i = 0; i < count; i++) out[base + i] = probe.pixels[i * 4];
    }
    renderer.setRenderTarget(previous);
    return out;
  }

  /**
   * Puts the waterline where the asked-for fraction of the surface ends up
   * under it.
   *
   * Choosing it as a fraction of the height range instead does not work: the
   * relief field is a sum of ridged and billowed noise whose height
   * distribution is lopsided, and lopsided differently on every world, so the
   * same fraction of the range floods a fifth of one planet and four fifths of
   * the next. Sampling elevations and taking the quantile asks the question the
   * right way round.
   *
   * One shot per planet, eight small draws. Fine octaves shift slightly with
   * viewing detail, but they average out; the macro relief this is measuring
   * does not move.
   *
   * @param {import('three').WebGLRenderer} renderer
   * @param {number} fraction 0-1 of the surface to place under water
   * @returns {number} the waterline, km above the reference sphere
   */
  calibrateSeaLevel(renderer, fraction, samples = 512) {
    const uniform = this.material.uniforms.uSeaLevelKm;
    if (!uniform || !(fraction > 0)) return 0;
    // Probe the seabed, not the flooded surface: the height function clamps to
    // whatever waterline is currently set, which would hide what we are asking.
    const held = uniform.value;
    uniform.value = 0;

    // Fibonacci sphere, so each sample stands for the same area and the
    // quantile is a fraction of the surface rather than of the sample list.
    const dirs = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < samples; i++) {
      const y = 1 - (2 * i + 1) / samples;
      const r = Math.sqrt(Math.max(1 - y * y, 0));
      const theta = golden * i;
      dirs.push(new Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r));
    }
    const heights = this.groundHeightsKm(renderer, dirs);
    uniform.value = held;

    const sorted = Array.from(heights).sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
    uniform.value = sorted[index];
    return uniform.value;
  }

  /**
   * Elevation resolution worth loading: one texel per terrain vertex. Asking for
   * more would alias, since the geometry cannot carry detail finer than its own
   * spacing, and asking for less would leave visible faceting.
   */
  desiredDemWidth() {
    const spacingRadians = Math.PI / 2 / (2 ** this.sphere.deepestLevel * this.sphere.resolution);
    return Math.min(8192, 2 ** Math.ceil(Math.log2((2 * Math.PI) / spacingRadians)));
  }

  /**
   * @param {Vector3} cameraLocal camera position in the body's rotating frame, km
   * @param {Vector3} sunLocal unit vector to the sun in the same frame
   * @param {number} pixelsPerRadian
   */
  update({
    cameraLocal, sunLocal, pixelsPerRadian, sunColour, sunIntensity, viewLocal, coneCos,
    occluder, occluder2, umbraLight, sunAngular, shineDir, shine, shineColour, tideDir,
    detailScale = 1, patchScale = 1, microDetail = true,
  }) {
    const u = this.material.uniforms;
    u.uCameraLocal.value.copy(cameraLocal);
    u.uSunDir.value.copy(sunLocal);
    if (sunColour) u.uSunColour.value.copy(sunColour);
    if (sunIntensity !== undefined) u.uSunIntensity.value = sunIntensity;
    if (sunAngular !== undefined) u.uSunAngular.value = sunAngular;
    if (occluder) u.uOcculter.value.copy(occluder);
    else u.uOcculter.value.w = 0;
    if (occluder2) u.uOcculter2.value.copy(occluder2);
    else u.uOcculter2.value.w = 0;
    u.uUmbraLight.value = umbraLight ?? 0;
    if (shineDir) u.uShineDir.value.copy(shineDir);
    if (shine !== undefined) u.uShine.value = shine;
    if (shineColour) u.uShineColour.value.copy(shineColour);
    if (tideDir) u.uTideDir.value.copy(tideDir);

    const spec = this.spec;
    const distance = Math.max(cameraLocal.length() - this.radius, 1e-4);
    // Quality enters the surface shader as a lie about how sharp the screen is.
    // Every procedural term picks its octave count from the angular size of a
    // pixel, so telling it the pixels are wider than they are drops octaves in
    // the order they stop being visible — the finest first — rather than
    // clipping the terrain at some arbitrary count.
    u.uPixelsPerRadian.value = pixelsPerRadian * detailScale;
    if (this._microDetail === undefined) this._microDetail = u.uMicroDetail.value;
    u.uMicroDetail.value = microDetail ? this._microDetail : 0;
    const altitudeRadii = distance / this.radius;
    const quad = (this.spec.pixelsPerQuad ?? 7) / Math.max(patchScale, 0.05);
    this.sphere.pixelsPerQuad = altitudeRadii < 0.05 ? Math.max(3.5, quad * 0.55) : quad;
    this.sphere.maxPatches = Math.max(
      256,
      Math.round((this.spec.maxPatches ?? DEFAULT_MAX_PATCHES) * patchScale),
    );

    // How wide one screen pixel is on the surface at the sub-camera point. The
    // shaders refine this per fragment and per patch; this is the base figure.
    const pixelFootprintKm = distance / pixelsPerRadian;
    const cellKm = this.radius / (spec.craterFreq ?? 400);
    this.lodOctaves = spec.craterOctaves
      ? clamp(
          Math.log(Math.max(cellKm / pixelFootprintKm, 1e-3) / CRATER_DETAIL_MARGIN) / Math.log(CRATER_LACUNARITY),
          0,
          spec.craterOctaves,
        )
      : 0;
    u.uCraterOctaves.value = spec.craterOctaves ?? 0;

    if (this.atmosphereMaterial) {
      const a = this.atmosphereMaterial.uniforms;
      a.uCameraLocal.value.copy(cameraLocal);
      a.uSunDir.value.copy(sunLocal);
      if (sunColour) a.uSunColour.value.copy(sunColour);
      if (sunIntensity !== undefined) a.uSunIntensity.value = sunIntensity;

      // One or the other, never both: the haze is the view of the air from
      // outside it and the sky is the view from within, and they are two
      // renderings of the same column of gas.
      const inside = cameraLocal.length() < a.uShellRadius.value;
      this.atmosphere.visible = !inside;
      this.sky.visible = inside;
      if (inside) {
        const s = this.skyUniforms;
        s.uCameraLocal.value.copy(cameraLocal);
        s.uSunDir.value.copy(sunLocal);
        const light = this.skyInscatterMaterial.uniforms;
        if (sunColour) light.uSunColour.value.copy(sunColour);
        if (sunIntensity !== undefined) light.uSunIntensity.value = sunIntensity;
      }
    }

    // Cube-sphere works in radius units; convert once here.
    const scaled = this._cameraLocal.copy(cameraLocal).divideScalar(this.radius);
    return this.sphere.update(scaled, pixelsPerRadian, viewLocal ?? null, coneCos ?? -1);
  }
}
