import { PROVINCE_QUANTILE } from './terrain-glsl.js';

/**
 * Regional geology per body.
 *
 * The terrain shader can build craters, fractures, ridges, lava plains, rifts and
 * shield volcanoes, all of them statistically uniform over whatever area they are
 * given. What decides whether a body reads as a place rather than as a texture is
 * which of those processes acted on it, how much of it they covered, and how deep
 * they went — and that is not something to derive from noise. It is the body's
 * history, and for the bodies we have visited it is known.
 *
 * So this follows the same split as the figures: measured values where a spacecraft
 * has been, and a derivation from physical properties where one has not. The
 * measured numbers are the point. Mars is not a rocky planet with some volcanoes
 * on it, it is a planet with one hemisphere five kilometres below the other, a
 * volcanic province on one side and a rift a quarter of the way round the equator,
 * and those three facts are most of what it looks like from orbit.
 *
 * Bodies absent from the table get nothing rather than a guess. A body with a
 * measured elevation map already has its real geology in the map — flooding the
 * Moon procedurally would lay invented mare on top of the actual ones — and a body
 * we know little about is better left as the cratered surface it is presumed to be
 * than given features nobody has seen.
 */

/**
 * Coverage is the fraction of the body's surface a process reached, taken low
 * ground first. Depths and heights are kilometres. Frequencies are in cycles per
 * radian, so a body's own radius divided by the frequency is the feature spacing
 * in kilometres.
 */
const MEASURED_GEOLOGY = {
  /**
   * The dichotomy dominates: the northern lowlands sit some five kilometres below
   * the southern highlands, which is the largest single feature on any terrestrial
   * planet. The lowlands are then filled — Vastitas Borealis is the flattest
   * surface in the solar system — Tharsis carries the largest volcanoes anywhere,
   * and Valles Marineris cuts seven kilometres deep for four thousand along the
   * equator.
   */
  mars: {
    crustRelief: 4.2,
    // Rather over half the northern basin is under fill, which leaves the margins
    // standing as the cratered, partly drowned ground they are.
    flood: { coverage: 0.34, fill: 0.55, wrinkle: 0.11, softness: 0.3 },
    rift: { coverage: 0.13, frequency: 2.6, depth: 7.0, width: 0.055 },
    volcano: { coverage: 0.1, frequency: 4.6, height: 26.0, density: 0.34 },
  },

  /**
   * Smooth volcanic plains cover something like a quarter of Mercury, most of it
   * in the north and around Caloris, and they are crossed by wrinkle ridges from
   * the same contraction that produced the lobate scarps. No rift: Mercury's crust
   * has been in compression through its whole history, having shrunk as the core
   * cooled, so it has thrust faults where Mars has a graben. Its volcanism was
   * flood volcanism rather than edifice-building, so there are plains but no
   * mountains to speak of.
   */
  mercury: {
    // Mercury's topography spans about ten kilometres, and its plains are both
    // extensive and among the smoothest surfaces anywhere — thick flood basalt
    // ponded in large basins rather than a thin veneer, so the fill is nearly to
    // the province rim. At a shallower crust than this the basins do not sit below
    // the lava at all and no plains form, which is measurable: the check reports
    // the share of the surface that is plains, and it was three per cent.
    crustRelief: 3.0,
    flood: { coverage: 0.28, fill: 0.95, wrinkle: 0.14, softness: 0.22 },
    rift: null,
    volcano: null,
  },

  /**
   * Some four fifths of Venus is volcanic plain, resurfaced recently and almost
   * uniformly, which is why it has so few craters. Relief is modest for the same
   * reason. The chasmata are extensional rifts, and there are more volcanic
   * edifices than on any other planet, though mostly low.
   */
  venus: {
    crustRelief: 1.9,
    // Venus is the most completely resurfaced surface of the four, which is why it
    // has so few craters left to show.
    flood: { coverage: 0.72, fill: 0.82, wrinkle: 0.09, softness: 0.25 },
    rift: { coverage: 0.18, frequency: 3.4, depth: 2.6, width: 0.07 },
    volcano: { coverage: 0.26, frequency: 6.5, height: 5.5, density: 0.4 },
  },

  /**
   * The most volcanically active body known, and the only surface in the solar
   * system with no impact craters at all: it is repaved faster than craters
   * accumulate. Almost the whole surface is volcanic plain, studded with paterae —
   * broad shallow calderas rather than tall cones, since Io's lavas are extremely
   * fluid.
   */
  io: {
    crustRelief: 1.4,
    flood: { coverage: 0.88, fill: 0.9, wrinkle: 0.05, softness: 0.3 },
    rift: null,
    volcano: { coverage: 0.45, frequency: 7.0, height: 4.0, density: 0.45 },
  },
};

const NO_FLOOD = [0, 0, 0, 1];
const NO_RIFT = [0, 1, 0, 1];
const NO_VOLCANO = [0, 1, 0, 0];

/**
 * Elevation of the crust field at the edge of a province covering this fraction of
 * the body, in kilometres. Mirrors the quantile inversion the shader's province
 * mask uses, so the two agree about where the province ends.
 */
function provinceEdgeKm(coverage, crustRelief) {
  if (coverage <= 0.001 || coverage >= 0.999) return 0;
  return crustRelief * PROVINCE_QUANTILE * Math.log(coverage / (1 - coverage));
}

/**
 * Where a lava surface sits, from how far up the basin it reached.
 *
 * `fill` is the fraction of the province's depth that is under lava, which is the
 * form that behaves. An absolute thickness does not: the province's floor lies
 * several kilometres below its rim, so a datum set a little above the rim — which
 * sounds like a modest fill — drowns the entire interior under more lava than the
 * relief is tall, and the result is a body with no craters anywhere near its
 * plains and no shoreline either. Every crater buried is a crater that cannot show
 * as a ghost, and the ghosts and the half-drowned rims are the whole reason for
 * doing this as an operator.
 *
 * At a fill of one the lava reaches the province edge and the province is
 * completely resurfaced. Below that the margins stay above water, and it is those
 * margins that carry the drowned craters.
 */
function floodLevel(flood, crustRelief) {
  const edge = provinceEdgeKm(flood.coverage, crustRelief);
  // Half the crust relief stands in for the province's depth below its own edge,
  // the field being roughly symmetric about zero.
  return edge - (1 - flood.fill) * crustRelief * 0.5;
}

function pack(geology) {
  const crustRelief = geology.crustRelief ?? 0;
  return {
    crustRelief,
    flood: geology.flood
      ? [geology.flood.coverage, floodLevel(geology.flood, crustRelief),
         geology.flood.wrinkle, geology.flood.softness]
      : NO_FLOOD,
    rift: geology.rift
      ? [geology.rift.coverage, geology.rift.frequency, geology.rift.depth,
         geology.rift.width]
      : NO_RIFT,
    volcano: geology.volcano
      ? [geology.volcano.coverage, geology.volcano.frequency, geology.volcano.height,
         geology.volcano.density]
      : NO_VOLCANO,
  };
}

/**
 * Plausible geology for a body nobody has visited, from what can be known about
 * it at a distance.
 *
 * This is a model, not a measurement, and it is built round the one thing that
 * actually governs the answer: how long the body stayed hot. A planet resurfaces
 * itself while it still has heat to drive the process, it loses that heat through
 * its surface while generating it throughout its volume, and so the timescale goes
 * with the volume-to-area ratio — with radius. Small bodies froze early and kept
 * every crater they ever took; large ones are still going. That single argument
 * puts the Moon and Mercury at one end, Venus and Earth at the other, and Mars in
 * between, which is the observed order.
 *
 * Tidal heating overrides it where present, which is why Io is molten at a quarter
 * of Earth's radius while Callisto, larger, is a dead cratered iceball.
 */
export function deriveGeology(spec) {
  const radiusKm = spec.radiusKm ?? 0;
  if (radiusKm < 350) return pack({});

  // Earth radii, as the scale the argument above is calibrated on. The floor at
  // a fifth of an Earth radius is where the observed bodies stop having any
  // resurfacing left to show: below it everything is saturated with craters.
  const size = radiusKm / 6371;
  const retained = Math.min(Math.max((size - 0.2) / 0.8, 0), 1);

  // Tidal heating, if the caller knows of any. Expressed as a multiplier on
  // retained heat rather than added to it, since it drives the same machinery.
  const tidal = Math.min(spec.tidalHeating ?? 0, 1);
  const heat = Math.min(retained + tidal * (1 - retained) * 1.6, 1);
  if (heat < 0.12) return pack({});

  // An icy body's ductile shell relaxes its relief away and fractures rather than
  // rifting, which the fracture terms already cover, so only the flooding applies.
  const icy = (spec.bulk ?? 'rock') === 'ice';


  return pack({
    // Relief a body can hold up scales with its strength against its own gravity,
    // so larger planets carry proportionally less. Mars holds a five-kilometre
    // dichotomy; Earth's crust could not. The ramp takes it away again at the
    // small end, where a body is too little to organise its crust into provinces
    // at all and its shape is set by how it was broken instead.
    crustRelief:
      Math.min(2.6 / Math.max(size, 0.15), 9) *
      Math.min(Math.max((radiusKm - 350) / 550, 0), 1) *
      (icy ? 0.5 : 1),
    flood: {
      coverage: 0.15 + 0.68 * heat * heat,
      // A hotter body erupted more and filled its basins further up.
      fill: Math.min(0.35 + 0.6 * heat, 0.95),
      wrinkle: 0.13 * (1 - 0.5 * heat),
      softness: 0.25,
    },
    rift: icy || heat < 0.35 ? null : {
      coverage: 0.1 + 0.12 * heat,
      frequency: 2.4 + 1.6 * heat,
      depth: 5.5 * heat / Math.max(size, 0.2),
      width: 0.06,
    },
    volcano: heat < 0.3 ? null : {
      coverage: 0.08 + 0.36 * heat,
      frequency: 4.5 + 3 * heat,
      // Edifice height is limited by the crust's strength under its own weight,
      // so a low-gravity body builds the tall ones: Olympus Mons could not stand
      // on Earth.
      height: Math.min(22 * heat / Math.max(size, 0.15), 30),
      density: 0.3 + 0.2 * heat,
    },
  });
}

/**
 * Geology for a body: measured if we have been there, taken from the spec if the
 * generator supplied one, derived otherwise.
 */
export function bodyGeology(spec) {
  const measured = MEASURED_GEOLOGY[spec.key];
  if (measured) return pack(measured);
  if (spec.geology) return pack(spec.geology);
  if (spec.geology === null) return pack({});
  // A measured elevation map already contains the body's real geology.
  if (spec.dem) return pack({});
  return spec.deriveGeology ? deriveGeology(spec) : pack({});
}

export const MEASURED_GEOLOGY_KEYS = Object.keys(MEASURED_GEOLOGY);
