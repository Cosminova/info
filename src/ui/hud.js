/**
 * Bottom bar: navigation readouts, the simulation clock, and the scale bar.
 *
 * Every readout here changes continuously, which makes this the one place where
 * the "only write when the value changed" rule earns its keep — and where the
 * formatting has to be chosen so values do not flicker. Distances are formatted
 * to a fixed number of significant figures rather than decimals, and the strings
 * are compared before being written, so a readout that is settling only touches
 * the DOM when a displayed digit actually turns over.
 */

import { el, text, css } from './dom.js';
import { formatDistance, scaleStep } from '../engine/units.js';

/** Readouts, in the order they are dropped as the window narrows. */
const FIELDS = [
  { id: 'target', label: 'Target', drop: 0 },
  { id: 'distance', label: 'Distance', drop: 0 },
  { id: 'velocity', label: 'Velocity', drop: 3 },
  { id: 'heading', label: 'Heading', drop: 3 },
  { id: 'fov', label: 'FOV', drop: 2 },
  { id: 'sun', label: 'From Sun', drop: 2 },
  { id: 'mode', label: 'Mode', drop: 1 },
  { id: 'fps', label: 'FPS', drop: 1 },
];

export function createHud() {
  const cells = new Map();
  const root = el('div', { class: 'hud takes-pointer' }, FIELDS.map((field) => {
    const value = el('span', { class: 'v', text: '\u2014' });
    cells.set(field.id, value);
    return el('div', {
      class: 'readout',
      dataset: field.drop ? { opt: String(field.drop) } : {},
    }, [el('span', { class: 'k', text: field.label }), value]);
  }));

  return {
    root,
    set(id, value) {
      text(cells.get(id), value);
    },
  };
}

/**
 * Compact simulation clock.
 *
 * Rates are signed, so reverse is the same control as forward rather than a
 * separate mode. The step buttons walk a ladder of multipliers instead of
 * offering a free-form number, because the useful rates span nine orders of
 * magnitude and a slider over that range is unusable; a custom multiplier is
 * available for the case where you want a specific one.
 */
const LADDER = [1, 10, 60, 600, 3600, 36000, 864000, 8640000, 86400000];

export function formatRate(rate) {
  if (rate === 0) return 'paused';
  const sign = rate < 0 ? '\u2212' : '';
  const magnitude = Math.abs(rate);
  if (magnitude === 1) return `${sign}realtime`;
  if (magnitude < 60) return `${sign}${magnitude}\u00d7`;
  if (magnitude < 3600) return `${sign}${(magnitude / 60).toFixed(0)} min/s`;
  if (magnitude < 86400) return `${sign}${(magnitude / 3600).toFixed(0)} h/s`;
  if (magnitude < 31557600) return `${sign}${(magnitude / 86400).toFixed(0)} d/s`;
  return `${sign}${(magnitude / 31557600).toFixed(1)} yr/s`;
}

export function createTimeBar({ getRate, setRate, getPlaying, setPlaying, getDate, setDate, onCustom }) {
  const dateLabel = el('span', { class: 'time-date', text: '\u2014' });
  const rateLabel = el('span', { class: 'time-rate', text: 'realtime' });

  const play = el('button', {
    type: 'button',
    class: 'btn is-icon',
    'aria-label': 'Play or pause',
    text: '\u258c\u258c',
  });
  play.dataset.tip = 'Play / pause';

  function step(direction) {
    const rate = getRate();
    const sign = Math.sign(rate) || 1;
    const magnitude = Math.abs(rate) || 1;
    let index = LADDER.findIndex((value) => value >= magnitude - 1e-9);
    if (index < 0) index = LADDER.length - 1;
    // Stepping down past realtime crosses zero into reverse rather than
    // stopping, so speeding up backwards is the same gesture as speeding up.
    if (direction > 0) {
      if (sign > 0) index = Math.min(index + 1, LADDER.length - 1);
      else if (index === 0) return setRateAndPlay(1);
      else index -= 1;
    } else if (sign > 0) {
      if (index === 0) return setRateAndPlay(-1);
      index -= 1;
    } else {
      index = Math.min(index + 1, LADDER.length - 1);
    }
    setRateAndPlay(LADDER[index] * (direction > 0 ? sign || 1 : sign || 1));
  }

  function setRateAndPlay(rate) {
    setRate(rate);
    setPlaying(rate !== 0);
    sync();
  }

  const slower = el('button', { type: 'button', class: 'btn time-step', text: '\u25c0', onClick: () => step(-1) });
  slower.dataset.tip = 'Slower, then reverse';
  const faster = el('button', { type: 'button', class: 'btn time-step', text: '\u25b6', onClick: () => step(1) });
  faster.dataset.tip = 'Faster';

  const now = el('button', {
    type: 'button',
    class: 'btn',
    text: 'now',
    onClick: () => { setDate(new Date()); setRateAndPlay(1); },
  });
  now.dataset.tip = 'Jump to the present';

  const custom = el('button', { type: 'button', class: 'btn', text: '\u00d7?', onClick: () => onCustom?.() });
  custom.dataset.tip = 'Custom multiplier';

  play.addEventListener('click', () => {
    setPlaying(!getPlaying());
    sync();
  });

  const root = el('div', { class: 'timebar takes-pointer' }, [
    play, slower, faster, rateLabel,
    el('span', { class: 'rule' }),
    dateLabel, now, custom,
  ]);

  function sync() {
    const playing = getPlaying();
    text(play, playing ? '\u258c\u258c' : '\u25b6');
    css(play, 'is-active', !playing);
    text(rateLabel, playing ? formatRate(getRate()) : 'paused');
  }

  function frame() {
    const date = getDate();
    // Seconds resolution: the clock is a readout, not a stopwatch, and writing
    // milliseconds would repaint it every frame at every rate.
    text(dateLabel, `${date.toISOString().slice(0, 19).replace('T', '  ')}`);
  }

  sync();
  return { root, sync, frame, setRateAndPlay };
}

export function createScaleBar() {
  const label = el('span', { class: 's-label', text: '\u2014' });
  const readout = el('span', { class: 'num s-readout', text: '\u2014' });
  const root = el('div', { class: 'scalebar' }, [
    label,
    el('div', { class: 's-track' }),
    readout,
  ]);
  return {
    root,
    update(distanceKm) {
      const step = scaleStep(Math.max(distanceKm, 1e-6));
      text(label, step.label);
      text(readout, formatDistance(distanceKm));
    },
  };
}
