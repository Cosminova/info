/**
 * Planet classification and appearance.
 *
 * A catalogue entry for an exoplanet gives at most a mass, a radius, an orbit
 * and an equilibrium temperature. Everything you would need to draw it — colour,
 * whether it has an ocean, whether the poles are frozen, how thick the air is —
 * has to be inferred. Inventing those directly produces either a uniform field
 * of grey balls or a circus, so this follows the composable scheme SpaceEngine
 * uses, where a planet's class is the product of four independent axes and the
 * appearance falls out of the class:
 *
 *   [temperature] [volatiles] [mass prefix][bulk composition]
 *
 * The numeric boundaries are physical rather than decorative. 90 K is where
 * nitrogen and methane liquefy, 170 K the water snow line, 250 K Earth's
 * equilibrium temperature and roughly the floor for a temperate surface, 330 K
 * near Earth's maximum and the assumed onset of a runaway greenhouse. The
 * higher two are admittedly arbitrary.
 *
 * Anything not measured is drawn from a hash of the planet's name, so a given
 * planet looks the same on every visit and on every machine, and two planets in
 * a system never come out identical.
 */

const EARTH_RADIUS_KM = 6371;
const EARTH_DENSITY = 5.51; // g/cm3

// --- deterministic per-planet randomness ---------------------------------

/** FNV-1a, so a name maps to a stable 32-bit seed independent of the platform. */
export function hashName(name) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A small deterministic generator, so draws are repeatable and independent. */
export function rng(seed) {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

// --- the four axes --------------------------------------------------------

const TEMPERATURE_BANDS = [
  [90, 'frigid'],
  [170, 'cold'],
  [250, 'cool'],
  [330, 'temperate'],
  [500, 'warm'],
  [1000, 'hot'],
  [Infinity, 'torrid'],
];

export function temperatureClass(kelvin) {
  for (const [ceiling, name] of TEMPERATURE_BANDS) if (kelvin < ceiling) return name;
  return 'torrid';
}

/**
 * Bulk composition from density, with mass deciding which family of thresholds
 * applies. Density is the only handle on interior composition there is: a planet
 * denser than iron-rock cannot be anything but metal-rich, and one much less
 * dense than rock must be carrying ice or gas.
 */
export function bulkClass({ massEarth, radiusEarth, densityGcc }) {
  const density =
    densityGcc ?? (massEarth && radiusEarth ? EARTH_DENSITY * (massEarth / radiusEarth ** 3) : null);

  // Above about 2 Jupiter radii nothing is a planet, and above ~50 Earth masses
  // at low density the envelope is hydrogen and helium.
  if (radiusEarth >= 8 || (massEarth ?? 0) >= 50) {
    return (massEarth ?? 0) >= 100 || radiusEarth >= 9 ? 'jupiter' : 'neptune';
  }
  if (radiusEarth >= 3.5) return 'neptune';
  if (density === null) return radiusEarth >= 1.8 ? 'neptune' : 'terra';
  if (density > 7.5) return 'ferria';
  if (density < 3.2) return 'aquaria';
  return 'terra';
}

const MASS_PREFIXES = {
  solid: [
    [0.002, 'micro'],
    [0.02, 'mini'],
    [0.2, 'sub'],
    [2, ''],
    [10, 'super'],
    [Infinity, 'mega'],
  ],
  neptune: [
    [4, 'mini'],
    [10, 'sub'],
    [25, ''],
    [62.5, 'super'],
    [Infinity, 'mega'],
  ],
  // In Jupiter masses.
  jupiter: [
    [0.2, 'sub'],
    [2, ''],
    [10, 'super'],
    [Infinity, 'mega'],
  ],
};

export function massPrefix(bulk, massEarth) {
  if (!massEarth) return '';
  const family = bulk === 'jupiter' ? 'jupiter' : bulk === 'neptune' ? 'neptune' : 'solid';
  const value = family === 'jupiter' ? massEarth / 317.8 : massEarth;
  for (const [ceiling, prefix] of MASS_PREFIXES[family]) if (value < ceiling) return prefix;
  return '';
}

/**
 * Volatiles: the atmosphere and any surface liquid, taken together, since one
 * cannot exist without the other. Nothing in the catalogue measures this for a
 * rocky planet, so it is inferred from temperature and gravity — a small warm
 * planet loses its air, a cool massive one keeps it — and the draw is
 * deterministic per planet.
 */
export function volatileClass({ bulk, temperatureK, massEarth, radiusEarth }, random) {
  if (bulk === 'jupiter' || bulk === 'neptune') return 'gaseous';

  // Escape velocity relative to Earth's, which is what sets whether an
  // atmosphere survives at a given temperature.
  const escape = massEarth && radiusEarth ? Math.sqrt(massEarth / radiusEarth) : 1;
  const retention = escape / Math.sqrt(Math.max(temperatureK, 20) / 255);

  if (retention < 0.55 || temperatureK > 900) return 'airless';
  if (temperatureK > 380) return 'desertic';
  if (temperatureK < 150) return random() < 0.25 ? 'desertic' : 'airless';

  // In the band where water can be liquid, how much of it there is is a genuine
  // unknown; ocean worlds are common in formation models, so the draw is not
  // heavily weighted against them.
  const draw = random();
  if (bulk === 'aquaria') return draw < 0.7 ? 'oceanic' : 'marine';
  if (temperatureK > 330) return draw < 0.7 ? 'desertic' : 'lacustrine';
  if (draw < 0.3) return 'desertic';
  if (draw < 0.5) return 'lacustrine';
  if (draw < 0.8) return 'marine';
  return 'oceanic';
}

// --- appearance -----------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;
const mixColour = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Hue rotation, saturation and lightness on an RGB triple.
 *
 * Two worlds of the same composition are not the same colour: how much dust is
 * on the plains, how oxidised the iron is and how long the surface has been
 * exposed all move the hue a little without changing what the rock is. Working
 * in HSV rather than scaling the channels keeps the shift a shift — scaling red
 * turns every mineral orange, whereas rotating the hue moves rust towards
 * ochre and basalt towards slate, which is what those surfaces actually do.
 */
function shift([r, g, b], { hue = 0, saturation = 1, value = 1 }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  let h = 0;
  if (span > 1e-6) {
    if (max === r) h = ((g - b) / span) % 6;
    else if (max === g) h = (b - r) / span + 2;
    else h = (r - g) / span + 4;
    h /= 6;
  }
  const s = clamp01((max > 1e-6 ? span / max : 0) * saturation);
  const v = clamp01(max * value);
  h = (h + hue + 1) % 1;

  const sector = h * 6;
  const i = Math.floor(sector);
  const f = sector - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/**
 * What the ground is made of, as the colour of its low plains, its uplands and
 * its highest exposed rock.
 *
 * Bulk composition — which is all the catalogue can tell you — fixes the
 * interior, not the surface. Mars and the Moon are both rock over iron and look
 * nothing alike, because what you see is the top few metres: how oxidised the
 * iron is, whether lava resurfaced the plains, whether organics or salts or
 * frost have collected on top. That is unmeasurable at interstellar distance,
 * so it is drawn per planet from these, weighted by the conditions each
 * mineralogy needs.
 */
const MINERALS = {
  // Fresh volcanic rock, the darkest common surface: the lunar maria.
  basalt: { low: [0.08, 0.08, 0.09], mid: [0.19, 0.19, 0.2], high: [0.44, 0.43, 0.45] },
  // Oxidised iron. Needs only a trace of atmosphere and a long time.
  rust: { low: [0.25, 0.11, 0.06], mid: [0.45, 0.22, 0.12], high: [0.7, 0.47, 0.33] },
  // Wind-laid silicate dust over anything else, which is most of Mars.
  ochre: { low: [0.3, 0.24, 0.15], mid: [0.51, 0.42, 0.26], high: [0.76, 0.69, 0.51] },
  // Vegetation. Only where there is liquid water and a temperate surface.
  verdant: { low: [0.12, 0.21, 0.1], mid: [0.27, 0.35, 0.15], high: [0.57, 0.53, 0.39] },
  // Olivine and serpentine, the green-grey of ultramafic crust.
  jade: { low: [0.1, 0.19, 0.17], mid: [0.23, 0.37, 0.31], high: [0.55, 0.62, 0.55] },
  // Volcanic sulphur, as on Io: brilliant yellow, and it needs the heat.
  sulphur: { low: [0.35, 0.26, 0.07], mid: [0.64, 0.53, 0.13], high: [0.88, 0.82, 0.42] },
  // Organic haze fallout. Titan's colour, and it wants cold and an atmosphere.
  tholin: { low: [0.28, 0.15, 0.07], mid: [0.56, 0.32, 0.13], high: [0.82, 0.61, 0.33] },
  // Water and nitrogen frost.
  frost: { low: [0.45, 0.51, 0.58], mid: [0.69, 0.75, 0.81], high: [0.93, 0.96, 0.99] },
  // Carbon. The old carbon-planet idea, and the colour of a burnt-out surface.
  graphite: { low: [0.05, 0.05, 0.06], mid: [0.11, 0.11, 0.12], high: [0.27, 0.26, 0.28] },
  // Feldspar highlands: the pale pink-grey of the lunar far side.
  granite: { low: [0.29, 0.23, 0.22], mid: [0.48, 0.41, 0.39], high: [0.74, 0.68, 0.63] },
  // Evaporite flats, left where a sea has gone.
  saline: { low: [0.41, 0.39, 0.34], mid: [0.64, 0.62, 0.56], high: [0.9, 0.89, 0.84] },
};

/** Weighted draw over the mineralogies the conditions allow. */
function mineralFor({ bulk, temperatureK, volatiles, oceanLevel }, random) {
  const weights = new Map();
  const add = (name, weight) => weights.set(name, (weights.get(name) ?? 0) + weight);

  if (bulk === 'ferria') {
    add('rust', 3);
    add('basalt', 2);
    add('granite', 1.2);
    add('graphite', 0.6);
  } else if (bulk === 'aquaria') {
    add('frost', 2.6);
    add('jade', 1.4);
    add('saline', 1.2);
    add('ochre', 0.8);
  } else {
    add('basalt', 2);
    add('ochre', 2.2);
    add('rust', 1.8);
    add('granite', 1.4);
    add('jade', 1);
  }

  if (temperatureK < 150) {
    add('frost', 3);
    add('tholin', volatiles === 'airless' ? 0.6 : 2);
    add('graphite', 0.5);
  } else if (temperatureK < 260) {
    add('frost', 1.2);
    add('tholin', 0.9);
    add('saline', 0.6);
  } else if (temperatureK > 700) {
    add('graphite', 2.4);
    add('basalt', 2);
    add('sulphur', 1.6);
  } else if (temperatureK > 420) {
    add('sulphur', 1.6);
    add('basalt', 1.4);
    add('rust', 1);
  }
  // Life is the one surface colour with a hard precondition: standing water at
  // a temperature where it stays standing.
  if (oceanLevel > 0 && temperatureK > 250 && temperatureK < 330) add('verdant', 2.6);
  if (oceanLevel > 0.3) add('saline', 0.8);
  if (volatiles === 'airless') {
    add('basalt', 1.5);
    add('graphite', 0.7);
    weights.delete('verdant');
    weights.delete('tholin');
  }

  let total = 0;
  for (const weight of weights.values()) total += weight;
  let draw = random() * total;
  for (const [name, weight] of weights) {
    draw -= weight;
    if (draw <= 0) return MINERALS[name];
  }
  return MINERALS.basalt;
}

/**
 * Eight stops from the deepest sea to the highest peak, the same ordering
 * SpaceEngine's surface palettes use. Anything without an ocean simply never
 * samples the first stops.
 */
function rockPalette({ bulk, temperatureK, volatiles, oceanLevel }, random) {
  const mineral = mineralFor({ bulk, temperatureK, volatiles, oceanLevel }, random);
  // One shift for the whole palette, so the stops stay a set rather than
  // drifting apart into a surface that cannot have formed.
  const weathering = {
    hue: (random() - 0.5) * 0.1,
    saturation: 0.7 + random() * 0.65,
    value: 0.82 + random() * 0.38,
  };
  const low = shift(mineral.low, weathering);
  const mid = shift(mineral.mid, weathering);
  const high = shift(mineral.high, weathering);

  // Whatever the sea is made of. Below the water line it can only be methane
  // and ethane, which are the colour of weak tea over a dark bed, not blue.
  const hydrocarbon = temperatureK < 200;
  const sea = hydrocarbon ? [0.05, 0.035, 0.025] : [0.02, 0.05, 0.12];
  const shelf = hydrocarbon ? [0.12, 0.09, 0.05] : [0.05, 0.14, 0.25];

  return {
    sea,
    shelf,
    beach: mixColour(mid, high, 0.5),
    desert: mixColour(low, mid, 0.8),
    lowland: low,
    upland: mid,
    rock: mixColour(mid, high, 0.25),
    snow: mixColour(high, [0.93, 0.95, 0.97], temperatureK < 260 ? 0.7 : 0.45),
  };
}

/** Cloud-top and haze colours for the gas families, biased by temperature. */
function giantPalette(temperatureK, random) {
  // Cold giants are pale blue-white ammonia; the belts turn brown then red as
  // they warm, and the hottest are dark with sodium and silicate cloud.
  const cold = [0.62, 0.72, 0.82];
  const cool = [0.85, 0.82, 0.72];
  const warm = [0.78, 0.6, 0.42];
  const hot = [0.35, 0.18, 0.14];
  let base;
  if (temperatureK < 120) base = cold;
  else if (temperatureK < 300) base = mixColour(cold, cool, (temperatureK - 120) / 180);
  else if (temperatureK < 800) base = mixColour(cool, warm, (temperatureK - 300) / 500);
  else base = mixColour(warm, hot, Math.min((temperatureK - 800) / 700, 1));

  const tint = 0.9 + random() * 0.2;
  // The three the band renderer reads are `desert`, `lowland` and `beach`: the
  // pale zone, the dark belt, and the accent for storms. They need real
  // separation to be seen as banding at all — Jupiter's belts are about twice
  // the depth of its zones — where the ten per cent spread these once had
  // vanished the moment any shading was applied.
  const zone = base.map((c) => Math.min(c * 1.16 * tint, 1));
  const belt = base.map((c) => c * 0.55 * tint);
  const accent = base.map((c, i) => Math.min(c * (i === 0 ? 1.3 : i === 1 ? 1.05 : 0.85) * tint, 1));
  return {
    sea: base.map((c) => c * 0.55 * tint),
    shelf: base.map((c) => c * 0.65 * tint),
    beach: accent,
    desert: zone,
    lowland: belt,
    upland: base.map((c) => c * 1.0 * tint),
    rock: base.map((c) => c * 1.1 * tint),
    snow: base.map((c) => Math.min(c * 1.3 * tint, 1)),
  };
}

/**
 * Full description of a catalogue planet: its class, and the parameters the
 * surface renderer needs. Radius is the one thing usually measured, so it is
 * taken as given; mass and temperature fall back to relations rather than
 * being invented outright.
 */
export function describePlanet(entry, { starTeff, aAu } = {}) {
  const random = rng(hashName(entry.name ?? 'unnamed'));

  const radiusEarth = entry.radiusEarth ?? (entry.massEarth ? entry.massEarth ** 0.29 : 1);
  // Equilibrium temperature if the archive has none: the standard relation for a
  // grey body at this distance from a star of this temperature, with Earth's
  // albedo assumed.
  const temperatureK =
    entry.equilibriumK ??
    (starTeff && aAu ? 0.7 * starTeff * Math.sqrt(0.00465047 / (2 * aAu)) : 255);

  const bulk = bulkClass({
    massEarth: entry.massEarth,
    radiusEarth,
    densityGcc: entry.densityGcc,
  });
  const temperature = temperatureClass(temperatureK);
  const volatiles = volatileClass(
    { bulk, temperatureK, massEarth: entry.massEarth, radiusEarth },
    random,
  );
  const prefix = massPrefix(bulk, entry.massEarth);
  const gaseous = bulk === 'jupiter' || bulk === 'neptune';

  const oceanLevel =
    volatiles === 'oceanic' ? 0.62 : volatiles === 'marine' ? 0.42 : volatiles === 'lacustrine' ? 0.2 : 0;
  const palette = gaseous
    ? giantPalette(temperatureK, random)
    : rockPalette({ bulk, temperatureK, volatiles, oceanLevel }, random);
  // Ice reaches down from the poles once it is cold enough for water to freeze
  // on the surface, and covers the planet outright below the nitrogen line.
  const icecapLatitude =
    temperatureK > 330 ? 1 : temperatureK < 170 ? 0 : (temperatureK - 170) / 160;

  const label = [temperature, volatiles, `${prefix}${bulk}`].filter(Boolean).join(' ');

  return {
    label,
    temperature,
    volatiles,
    bulk,
    prefix,
    gaseous,
    temperatureK,
    radiusEarth,
    radiusKm: radiusEarth * EARTH_RADIUS_KM,
    palette,
    oceanLevel,
    icecapLatitude,
    // Terrain vigour: small bodies keep their craters, large ones resurface, and
    // gas giants have no surface at all. Air erases the record twice over — it
    // burns up the small impactors and it weathers what the large ones leave —
    // and running water finishes the job, so a wet temperate world should not
    // read as a cratered one.
    craterDensity: gaseous
      ? 0
      : (radiusEarth < 0.6 ? 0.6 : 0.3 / radiusEarth)
        * (volatiles === 'airless' ? 1 : oceanLevel > 0 ? 0.12 : 0.4),
    roughness: gaseous ? 0 : 0.08 + random() * 0.1,
    cloudCover: gaseous ? 1 : volatiles === 'airless' ? 0 : 0.18 + random() * 0.37,
    // How the surface is laid out, which is as unmeasured as its colour. A few
    // large provinces or many small ones; a crater population sitting on a
    // coarse lattice or a fine one; sharp young craters or soft filled ones.
    // Left at one value each, every world of a class comes out with the same
    // continents in the same places.
    // The colour of the air seen edge on. Thin clear air over a cool world
    // scatters blue like Earth's; below the water line the haze is organic and
    // orange, as Titan's is; a hot thick one is the white-yellow of Venus.
    hazeTint: shift(
      temperatureK < 200
        ? [0.82, 0.55, 0.32]
        : temperatureK > 420
          ? [0.95, 0.82, 0.58]
          : [0.38, 0.58, 1],
      { hue: (random() - 0.5) * 0.06, saturation: 0.8 + random() * 0.5, value: 0.9 + random() * 0.2 },
    ),
    provinceScale: 1.5 + random() * 2.9,
    craterScale: 0.5 + random() * 1.3,
    craterDepth: gaseous ? 0 : 0.11 + random() * 0.19,
    craterOctaves: gaseous ? 0 : 5 + Math.floor(random() * 3),
    // Whichever way the planet ended up, its axis and rotation are unmeasured.
    tiltDeg: random() * 45,
    rotationHours: gaseous ? 8 + random() * 12 : 12 + random() * 60,
  };
}
