/**
 * Everything in the explorer that can be switched off, declared once.
 *
 * The list is the single source of three things that used to be written out
 * separately and drifted apart: the checkboxes in the Display panel, the
 * defaults stored in preferences, and the switch in the renderer that applies
 * them. Adding an option means adding a row here and a case in `setView`.
 *
 * Most of these will not make the frame arrive sooner — the surface shader
 * dominates, and it is not on this list. They are here because a picture with
 * fewer things drawn on it is easier to look at, which is a reason of its own.
 * The few that do cost something say so in their tooltip.
 */

export const VIEW_GROUPS = [
  {
    title: 'Names',
    options: [
      { key: 'labelPlanets', label: 'Planets and moons', default: true },
      {
        key: 'labelStars',
        label: 'Stars',
        default: false,
        title: 'Names of catalogue stars. Off by default — at any distance from '
          + 'the sun there are enough of them to cover the sky in text.',
      },
      { key: 'labelGalaxies', label: 'Galaxies', default: true },
      { key: 'labelBlackHoles', label: 'Black holes', default: true },
      { key: 'labelCraft', label: 'Spacecraft', default: true },
      { key: 'labelExo', label: 'Exoplanets', default: true },
    ],
  },
  {
    title: 'Sky',
    options: [
      { key: 'stars', label: 'Background stars', default: true },
      { key: 'galaxies', label: 'Galaxies', default: true },
      { key: 'milkyWay', label: 'Milky Way', default: true },
      { key: 'blackHoles', label: 'Black holes', default: true },
      {
        key: 'distantMarkers',
        label: 'Distant body markers',
        default: true,
        title: 'The points that stand in for planets too small to draw as discs',
      },
    ],
  },
  {
    title: 'Worlds',
    options: [
      { key: 'atmospheres', label: 'Atmospheres', default: true },
      { key: 'rings', label: 'Rings', default: true },
      { key: 'nightLights', label: 'City lights', default: true },
      {
        key: 'terrainShadows',
        label: 'Terrain shadows',
        default: true,
        title: 'Shadows cast by craters and ridges onto their own surface. '
          + 'Costs frame time close to the ground.',
      },
    ],
  },
  {
    title: 'Spacecraft',
    options: [
      { key: 'craft', label: 'Spacecraft', default: true },
      { key: 'trajectories', label: 'Trajectories', default: true },
      { key: 'craftVectors', label: 'Velocity vectors', default: true },
    ],
  },
  {
    title: 'Effects',
    options: [
      { key: 'bloom', label: 'Bloom', default: true, title: 'Glow around bright objects' },
      { key: 'dither', label: 'Dither', default: true, title: 'Hides banding in dark gradients' },
      { key: 'music', label: 'Music', default: true },
    ],
  },
];

/** Flat `{ key: default }` for the preferences file. */
export const VIEW_DEFAULTS = Object.fromEntries(
  VIEW_GROUPS.flatMap((group) => group.options.map((option) => [option.key, option.default])),
);

export const VIEW_KEYS = Object.keys(VIEW_DEFAULTS);
