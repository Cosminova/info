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

// Eight stops from the deepest sea to the highest peak, the same ordering
// SpaceEngine's surface palettes use. Anything without an ocean simply never
// samples the first stops.
const PALETTES = {
  ferria: {
    sea: [0.06, 0.05, 0.05],
    shelf: [0.09, 0.07, 0.06],
    beach: [0.24, 0.16, 0.12],
    desert: [0.35, 0.2, 0.14],
    lowland: [0.3, 0.18, 0.14],
    upland: [0.26, 0.17, 0.15],
    rock: [0.2, 0.15, 0.14],
    snow: [0.5, 0.42, 0.38],
  },
  terra: {
    sea: [0.02, 0.05, 0.12],
    shelf: [0.05, 0.13, 0.24],
    beach: [0.5, 0.45, 0.33],
    desert: [0.44, 0.36, 0.24],
    lowland: [0.2, 0.26, 0.14],
    upland: [0.26, 0.24, 0.17],
    rock: [0.3, 0.28, 0.25],
    snow: [0.86, 0.88, 0.9],
  },
  aquaria: {
    sea: [0.03, 0.08, 0.16],
    shelf: [0.08, 0.2, 0.3],
    beach: [0.55, 0.58, 0.6],
    desert: [0.5, 0.52, 0.55],
    lowland: [0.42, 0.48, 0.52],
    upland: [0.5, 0.55, 0.58],
    rock: [0.44, 0.47, 0.5],
    snow: [0.92, 0.94, 0.97],
  },
  carbonia: {
    sea: [0.04, 0.03, 0.03],
    shelf: [0.07, 0.06, 0.05],
    beach: [0.16, 0.14, 0.12],
    desert: [0.2, 0.17, 0.14],
    lowland: [0.12, 0.11, 0.1],
    upland: [0.15, 0.14, 0.13],
    rock: [0.1, 0.1, 0.1],
    snow: [0.35, 0.34, 0.33],
  },
};

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
  return {
    sea: base.map((c) => c * 0.55 * tint),
    shelf: base.map((c) => c * 0.65 * tint),
    beach: base.map((c) => c * 0.8 * tint),
    desert: base.map((c) => c * 0.95 * tint),
    lowland: base.map((c) => c * 0.85 * tint),
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

  const palette = gaseous ? giantPalette(temperatureK, random) : PALETTES[bulk] ?? PALETTES.terra;
  const oceanLevel =
    volatiles === 'oceanic' ? 0.62 : volatiles === 'marine' ? 0.42 : volatiles === 'lacustrine' ? 0.2 : 0;
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
    // Whichever way the planet ended up, its axis and rotation are unmeasured.
    tiltDeg: random() * 45,
    rotationHours: gaseous ? 8 + random() * 12 : 12 + random() * 60,
  };
}
