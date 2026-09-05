/**
 * Object inspector: the panel that describes whatever is selected.
 *
 * The interesting part is that the rows differ by class. A moon's primary and
 * tidal locking matter and its distance from the Sun does not; a galaxy has a
 * morphology and a recession velocity and no surface gravity at all. So each
 * class gets its own row builder rather than one table with most of the cells
 * empty, which is what makes the panel read like an astronomy reference instead
 * of a database dump.
 *
 * Rows come in two flavours. Numbers are right-aligned and monospaced so they
 * line up down the column; prose — a morphology class, a list of moons — is
 * left-aligned in the body face, because a right-aligned monospace sentence is
 * unreadable.
 */

import { el, text, reconcile, css } from './dom.js';
import { AU_KM, LY_KM, MPC_KM, PC_KM, formatDistance } from '../engine/units.js';
import { BODY_BY_KEY } from '../engine/bodies-data.js';
import { MOONS } from '../engine/moons-data.js';
import { physicalFor, surfaceGravity, meanDensity, escapeVelocity } from '../engine/physical-data.js';

const num = (value, digits = 0) =>
  value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Scientific notation with a proper superscript exponent. */
const SUPERS = { '-': '\u207b', 0: '\u2070', 1: '\u00b9', 2: '\u00b2', 3: '\u00b3', 4: '\u2074', 5: '\u2075', 6: '\u2076', 7: '\u2077', 8: '\u2078', 9: '\u2079' };

export function sci(value, digits = 2) {
  if (value === 0) return '0';
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  const mantissa = value / Math.pow(10, exponent);
  const sup = String(exponent).split('').map((c) => SUPERS[c] ?? c).join('');
  return `${mantissa.toFixed(digits)} \u00d7 10${sup}`;
}

function kelvin(k) {
  return `${num(k)} K \u00b7 ${num(k - 273.15)} \u00b0C`;
}

function rotation(hours) {
  const h = Math.abs(hours);
  const retro = hours < 0 ? ' retrograde' : '';
  if (h > 48) return `${num(h / 24, 2)} d${retro}`;
  return `${num(h, 2)} h${retro}`;
}

/** Stars are the only primaries that are not bodies, and they are namespaced. */
const isStarKey = (key) => key === 'sun' || String(key).startsWith('star:');

/**
 * Whether a body orbits a planet rather than a star, which is what makes it a
 * moon. The test used to be "has a primary, and that primary is not the Sun",
 * which says the same thing only for as long as the Sun is the only star in the
 * scene. Every exoplanet has a primary and it is its own host star, so all seven
 * thousand of them classified as moons of it: a world the size of Jupiter was
 * described as a "Major moon" whose primary was a star, and the panel then
 * printed that star's raw key because it looked for it among the planets.
 */
const orbitsAPlanet = (spec) => Boolean(spec.parent) && !isStarKey(spec.parent);

/**
 * Human class name for a body, from what the renderer already knows about it.
 * Nothing here is stored on the spec: the distinction between a rocky planet and
 * a gas giant is recoverable from radius and primary, and duplicating it as a
 * field would mean two places to keep in step.
 */
export function classifyBody(spec, key) {
  if (key === 'sun') return 'G-type main sequence star';
  const isMoon = orbitsAPlanet(spec);
  const r = spec.radiusKm;
  if (!isMoon) {
    if (r > 40000) return 'Gas giant';
    if (r > 20000) return 'Ice giant';
    if (key === 'pluto' || key === 'ceres' || key === 'eris') return 'Dwarf planet';
    if (r > 2000) return 'Terrestrial planet';
    return 'Minor planet';
  }
  // Below roughly 200 km a body's own gravity cannot pull it round, which is the
  // real physical line between a moon and a captured rock.
  if (r < 10) return 'Irregular moonlet';
  if (r < 200) return 'Irregular moon';
  if (r > 1500) return 'Major moon';
  return 'Regular moon';
}

function badge(kind) {
  return el('span', { class: `badge k-${kind}`, text: kind.replace('-', ' ') });
}

const CRAFT_CLASS = {
  station: 'Crewed space station',
  telescope: 'Space telescope',
  orbiter: 'Orbiter',
  probe: 'Deep-space probe',
  flyby: 'Flyby probe',
  rover: 'Surface rover',
  lander: 'Lander',
  capsule: 'Crew capsule',
  stage: 'Spent upper stage',
  satellite: 'Satellite',
  debris: 'Derelict',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** `1977-09-05` as `5 September 1977`, which is how a launch date should read. */
function longDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y) return String(iso);
  if (!m) return String(y);
  return d ? `${d} ${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${y}`;
}

function shortDate(dateObj) {
  return `${MONTHS[dateObj.getUTCMonth()].slice(0, 3)} ${dateObj.getUTCFullYear()}`;
}

function years(days) {
  if (days < 90) return `${num(days, 0)} d`;
  const y = days / 365.25;
  return y < 1 ? `${num(days, 0)} d` : `${num(y, 1)} yr \u00b7 ${num(days, 0)} d`;
}

/**
 * Build the rows for a resolved object.
 *
 * @returns {{title: string, className: string, kind: string, rows: Array}}
 *   Rows are `[label, value, isProse]`.
 */
export function describe(resolved, context = {}) {
  const { galaxyRecord, craftRecord, cameraDistanceKm, sunDistanceKm, date, nameOf } = context;
  const rows = [];
  const add = (label, value, prose = false) => {
    if (value !== null && value !== undefined && value !== '') rows.push([label, value, prose]);
  };

  if (cameraDistanceKm !== undefined) add('Distance', formatDistance(cameraDistanceKm));

  if (resolved.kind === 'galaxy') {
    const g = galaxyRecord;
    const mpc = g?.d ?? 0;
    add('Type', g?.morph ? `Galaxy \u00b7 ${g.morph}` : 'Galaxy', true);
    if (mpc) {
      add('Light travel', `${num(mpc * 3.26156, 2)} Mly`);
      // Hubble flow only; meaningless for the Local Group members, so it is
      // suppressed where peculiar motion dominates.
      if (mpc > 3) add('Recession', `${num(mpc * 70, 0)} km/s`);
    }
    add('Magnitude', g?.mag != null ? num(g.mag, 1) : null);
    if (g?.radiusKm) add('Radius', `${num(g.radiusKm / LY_KM, 0)} ly`);
    return { title: resolved.name, className: g?.morph ? `Galaxy, type ${g.morph}` : 'Galaxy', kind: 'galaxy', rows };
  }

  if (resolved.kind === 'craft') {
    const c = craftRecord;
    if (!c) return { title: resolved.name, className: 'Spacecraft', kind: 'craft', rows };
    add('Class', CRAFT_CLASS[c.kind] ?? 'Spacecraft', true);
    add('Mission', c.mission, true);
    add('Agency', c.agency, true);
    add('Launched', c.launched ? longDate(c.launched) : null);
    add('Destination', c.targetName, true);
    add('Location', c.locationName, true);
    add('Status', c.phase, true);
    if (c.durationDays !== null) {
      // Elapsed for a live mission, total for one that has ended; the label says
      // which, because "18,003 days" means different things for Voyager 1 and
      // for Cassini.
      add(c.stillFlying ? 'Elapsed' : 'Mission duration', years(c.durationDays));
    }
    if (c.ended) add('Ended', longDate(c.ended));
    if (c.speedKms !== null && !c.onSurface) {
      add('Speed', `${num(c.speedKms, c.speedKms < 10 ? 3 : 2)} km/s`, false);
    }
    if (c.distanceFromSunKm !== null) add('From Sun', `${num(c.distanceFromSunKm / AU_KM, 3)} AU`);
    if (c.distanceFromEarthKm !== null) add('From Earth', formatDistance(c.distanceFromEarthKm));
    if (c.distanceFromOriginKm != null) {
      add(`From ${c.originName}`, `${num(c.distanceFromOriginKm / AU_KM, 3)} AU`);
    }
    if (c.distanceToTargetKm !== null && c.targetKey !== 'earth') {
      add(`To ${c.targetName}`, formatDistance(c.distanceToTargetKm));
    }
    // The provenance row is not decoration. Everything above it is a number, and
    // this is the row that says how much of a number it is.
    //
    // Label and note go in one row. They used to be two, the second with an
    // empty label, which is why the spacecraft panel did not look like the
    // planet panel: no other row anywhere in the inspector has a value with
    // nothing in the column beside it, so it read as a caption that had come
    // loose. They are one fact in two sentences — what the position is, and how
    // well it is known — so they belong on one line together.
    add('Data', [c.dataLabel, c.dataNote].filter(Boolean).join(' \u2014 '), true);
    if (c.coverage) {
      add('Solution covers', `${shortDate(c.coverage.from)} \u2013 ${shortDate(c.coverage.to)}`, true);
    }
    add('Note', c.note, true);
    return {
      title: c.name,
      className: [CRAFT_CLASS[c.kind] ?? 'Spacecraft', c.agency].filter(Boolean).join(' \u00b7 '),
      kind: 'craft',
      rows,
    };
  }

  if (resolved.kind === 'black-hole') {
    const s = resolved.spec;
    const rs = s.massSol * 2.953;
    add('Class', s.massSol > 1e5 ? 'Supermassive black hole' : 'Stellar-mass black hole', true);
    add('Mass', s.massSol >= 1e6 ? `${num(s.massSol / 1e6, 2)} \u00d7 10\u2076 M\u2609` : `${num(s.massSol, 1)} M\u2609`);
    add('Schwarzschild radius', formatDistance(rs));
    // The photon sphere and the innermost stable circular orbit are the two
    // radii you can actually see the effect of in the render.
    add('Photon sphere', formatDistance(rs * 1.5));
    add('Spin', `a\u002f\u004d = ${num(s.spin, 2)}`);
    return {
      title: resolved.name,
      className: s.massSol > 1e5 ? 'Supermassive black hole' : 'Black hole',
      kind: 'black-hole',
      rows,
    };
  }

  if (resolved.kind === 'star') {
    const dest = resolved.dest ?? {};
    const system = dest.system;
    add('Class', dest.spect ? `Star, type ${dest.spect}` : 'Star', true);
    if (dest.distPc) {
      add('Distance from Sun', `${num(dest.distPc, 2)} pc \u00b7 ${num(dest.distPc * 3.26156, 2)} ly`);
    }
    add('Apparent magnitude', dest.mag != null ? num(dest.mag, 2) : null);
    if (dest.distPc && dest.mag != null) {
      // Absolute magnitude, which is what lets you compare it to the Sun's 4.83.
      add('Absolute magnitude', num(dest.mag - 5 * (Math.log10(dest.distPc) - 1), 2));
    }
    // The catalogue holds no radius for a named star, so unless the exoplanet
    // tables measured one it is worked out from the luminosity and the spectral
    // type. Which of the two you are reading is worth saying: one is a
    // measurement and the other is an inference from a temperature scale.
    const profile = resolved.profile;
    const radiusSol = profile?.radiusSol ?? system?.radiusSol;
    add(
      'Radius',
      radiusSol
        ? `${num(radiusSol, radiusSol < 10 ? 2 : 0)} R\u2609${profile && !profile.measured ? ' (derived)' : ''}`
        : null,
    );
    add('Effective temperature', system?.teff ?? profile?.teff ? `${num(system?.teff ?? profile.teff)} K` : null);
    add('Luminosity', profile?.luminositySol ? `${num(profile.luminositySol, profile.luminositySol < 10 ? 2 : 0)} L\u2609` : null);
    add('Known planets', system?.planets?.length ? String(system.planets.length) : null);
    if (system?.planets?.length) {
      add('System', system.planets.map((p) => p.name).join(', '), true);
    }
    return { title: resolved.name, className: dest.spect ? `Star \u00b7 ${dest.spect}` : 'Star', kind: 'star', rows };
  }

  // Everything else is a solid body: a planet, a moon, or an exoplanet.
  const spec = resolved.spec ?? {};
  const key = resolved.key;
  const isMoon = orbitsAPlanet(spec);
  const className = classifyBody(spec, key);
  const phys = physicalFor(key);

  add('Class', className, true);

  if (isMoon) {
    // Resolved through the caller, because a moon of an invented world has a
    // primary that exists only while its system is loaded and is therefore not
    // in the solar-system tables. Falling through to the key printed a slug.
    const parent = BODY_BY_KEY.get(spec.parent);
    add('Primary', parent?.name ?? nameOf?.(spec.parent) ?? spec.parent, true);
  } else if (spec.parent && isStarKey(spec.parent) && spec.parent !== 'sun') {
    add('Primary', nameOf?.(spec.parent) ?? String(spec.parent).replace(/^star:/, ''), true);
  } else if (sunDistanceKm !== undefined && key !== 'sun') {
    // Scaled rather than fixed to AU: an exoplanet is a few million AU away at
    // the nearest and a world in another galaxy is a few trillion, and neither
    // reads as a distance written out in full.
    add('From Sun', formatDistance(sunDistanceKm));
  }

  add('Radius', `${num(spec.radiusKm, spec.radiusKm < 100 ? 1 : 0)} km`);
  if (spec.flattening) add('Flattening', `1 : ${num(1 / spec.flattening, 0)}`);

  if (phys?.mass) {
    add('Mass', `${sci(phys.mass)} kg`);
    const g = surfaceGravity(phys.mass, spec.radiusKm);
    const rho = meanDensity(phys.mass, spec.radiusKm);
    const vEsc = escapeVelocity(phys.mass, spec.radiusKm);
    add('Surface gravity', `${num(g, 2)} m/s\u00b2 \u00b7 ${num(g / 9.80665, 3)} g`);
    add('Mean density', `${num(rho, 2)} g/cm\u00b3`);
    add('Escape velocity', `${num(vEsc, 2)} km/s`);
  }

  if (phys?.temperatureK) {
    add(phys.note === 'photosphere' ? 'Photosphere' : 'Temperature', kelvin(phys.temperatureK));
  }
  add('Geometric albedo', phys?.albedo != null ? num(phys.albedo, 3) : null);
  add('Atmosphere', phys?.atmosphere, true);

  if (spec.rotationHours) {
    const tidallyLocked =
      isMoon && spec.orbitDays && Math.abs(Math.abs(spec.rotationHours) / 24 - spec.orbitDays) < 0.02;
    add('Rotation', tidallyLocked ? `${rotation(spec.rotationHours)} \u00b7 tidally locked` : rotation(spec.rotationHours));
  }
  if (spec.tiltDeg !== undefined) add('Axial tilt', `${num(spec.tiltDeg, 2)}\u00b0`);

  if (spec.orbitKm) {
    add('Semi-major axis', formatDistance(spec.orbitKm));
    add('Orbital period', spec.orbitDays > 700 ? `${num(spec.orbitDays / 365.25, 2)} yr` : `${num(spec.orbitDays, 2)} d`);
    if (spec.orbitDays) {
      // Mean orbital speed, from the circular approximation the ephemeris uses.
      add('Orbital speed', `${num((2 * Math.PI * spec.orbitKm) / (spec.orbitDays * 86400), 2)} km/s`);
    }
    if (spec.eccentricity) add('Eccentricity', num(spec.eccentricity, 4));
    if (spec.inclinationDeg !== undefined) {
      const inc = spec.inclinationDeg;
      add('Inclination', `${num(inc, 2)}\u00b0${inc > 90 ? ' \u00b7 retrograde' : ''}`);
    }
  }

  if (spec.dem) add('Elevation model', 'Measured (LOLA)', true);
  else if (spec.craterOctaves) add('Surface', 'Procedural relief', true);

  const moons = MOONS.filter((m) => m.parent === key).sort((a, b) => b.radiusKm - a.radiusKm);
  const carried = [...BODY_BY_KEY.values()].filter((b) => b.parent === key && b.key !== key);
  // Deduplicated by key, because these two lists overlap completely: the body
  // table is built as the planets plus the moons, so every moon was counted once
  // from there and again from the moon table. Mars read "Satellites 4" and
  // "Largest Phobos, Phobos", and so did every other planet that has any.
  const byKey = new Map();
  for (const item of [...carried, ...moons]) if (!byKey.has(item.key)) byKey.set(item.key, item);
  const satellites = [...byKey.values()].sort((a, b) => b.radiusKm - a.radiusKm);
  if (satellites.length) {
    const named = satellites.filter((m) => m.radiusKm >= 8).slice(0, 10);
    const extra = satellites.length - named.length;
    add('Satellites', `${satellites.length}`);
    if (named.length) {
      add('Largest', named.map((m) => m.name).join(', ') + (extra > 0 ? `, +${extra} smaller` : ''), true);
    }
  }

  return { title: resolved.name, className, kind: isMoon ? 'moon' : key === 'sun' ? 'star' : 'planet', rows };
}

/**
 * The inspector panel body. Rebuilds its rows only when the set of labels
 * changes, and otherwise writes the changed values in place — so the distance
 * row can tick every frame without the panel being reconstructed around it.
 */
export function createInspector({ onAction }) {
  const name = el('h2', { class: 'obj-name', text: '\u2014' });
  const cls = el('span');
  const kindBadge = el('span', { class: 'badge k-planet', text: 'body' });
  const facts = el('dl', { class: 'kv' });
  const empty = el('p', {
    class: 'obj-empty',
    text: 'Nothing selected. Click an object, or search for one, to see what it is.',
  });

  const ACTIONS = [
    ['goto', 'Go to'],
    ['orbit', 'Orbit'],
    ['follow', 'Follow'],
    ['track', 'Track'],
    ['land', 'Land'],
    ['onboard', 'View from spacecraft'],
    ['center', 'Center'],
    ['target', 'Set target'],
  ];
  const buttons = new Map();
  const actionRow = el('div', { class: 'obj-actions' }, ACTIONS.map(([id, label]) => {
    const button = el('button', { type: 'button', class: 'btn', text: label, onClick: () => onAction(id) });
    buttons.set(id, button);
    return button;
  }));

  const root = el('div', {}, [
    el('div', { class: 'obj-head' }, [
      name,
      el('div', { class: 'obj-class' }, [kindBadge, cls]),
    ]),
    facts,
    actionRow,
    empty,
  ]);

  let lastKey = null;

  return {
    root,

    /** @param {ReturnType<typeof describe>|null} described */
    render(described, key) {
      const has = Boolean(described);
      empty.hidden = has;
      facts.hidden = !has;
      actionRow.hidden = !has;
      root.querySelector('.obj-head').hidden = !has;
      if (!has) {
        // Emptied, not merely hidden. A body can fail to resolve for a frame or
        // two while its system loads, and leaving the previous object's mass and
        // temperature sitting in the DOM means they flash back on the next frame
        // under the new object's name.
        if (facts.__sig !== null) {
          facts.replaceChildren();
          facts.__sig = null;
          facts.__cells = new Map();
        }
        lastKey = null;
        return;
      }

      text(name, described.title);
      text(cls, described.className);
      text(kindBadge, described.kind.replace('-', ' '));
      kindBadge.className = `badge k-${described.kind}`;

      // The row skeleton is keyed on the labels plus the object, so selecting a
      // different object of the same class still rebuilds (its values are all
      // different) but a distance tick does not.
      const signature = `${key}|${described.rows.map((r) => r[0]).join(',')}`;
      const rebuilt = reconcile(facts, signature, () =>
        described.rows.flatMap(([label, , prose]) => {
          const dd = el('dd', { class: prose ? 'is-text' : '' });
          dd.dataset.row = label;
          return [el('dt', { text: label }), dd];
        }),
      );

      if (rebuilt) facts.__cells = new Map([...facts.querySelectorAll('dd')].map((dd) => [dd.dataset.row, dd]));
      const cells = facts.__cells;
      for (const [label, value] of described.rows) text(cells.get(label), value);

      lastKey = key;
    },

    /** Landing only makes sense on something with a surface. */
    setCapabilities({ canLand, canFollow, canRide, riding }) {
      css(buttons.get('land'), 'is-hidden', false);
      buttons.get('land').disabled = !canLand;
      buttons.get('follow').disabled = !canFollow;
      buttons.get('track').disabled = !canFollow;
      const onboard = buttons.get('onboard');
      css(onboard, 'is-hidden', !canRide);
      css(onboard, 'is-active', Boolean(riding));
      text(onboard, riding ? 'Leave spacecraft' : 'View from spacecraft');
    },

    setMode(mode) {
      for (const [id, button] of buttons) {
        if (id === 'follow' || id === 'track' || id === 'orbit') css(button, 'is-active', mode === id);
      }
    },

    get key() {
      return lastKey;
    },
  };
}
