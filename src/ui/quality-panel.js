/**
 * The performance panel.
 *
 * Kept apart from the rest of the Display panel because it answers a different
 * question. The checkboxes there are about what you want to see; these are
 * about what your machine can afford, and the readout at the bottom is here so
 * that choice can be made from a number rather than a feeling.
 */

import { el, text } from './dom.js';
import { panel, segmented, slider } from './components.js';

const PRESETS = [
  { value: 'auto', label: 'Auto', title: 'Measure the frames this machine produces and spend what it can afford' },
  { value: 'low', label: 'Low', title: 'Half resolution and the coarsest terrain' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'ultra', label: 'Ultra', title: 'Full resolution and every octave of terrain. Expensive near a surface.' },
];

const TARGETS = [
  { value: 30, label: '30' },
  { value: 60, label: '60' },
  { value: 120, label: '120' },
];

export function createQualityPanel({ prefs, hooks }) {
  const presetControl = segmented({
    options: PRESETS,
    value: prefs.get('quality.preset', 'auto'),
    onChange: (value) => {
      prefs.set('quality.preset', value);
      hooks.setQualityPreset?.(value);
      syncMode(value);
    },
  });

  const targetControl = segmented({
    options: TARGETS,
    value: prefs.get('quality.targetFps', 60),
    onChange: (value) => {
      prefs.set('quality.targetFps', value);
      hooks.setTargetFps?.(value);
    },
  });

  const scaleSlider = slider({
    label: 'Resolution limit',
    min: 0.5,
    max: 1,
    step: 0.05,
    value: prefs.get('quality.maxRenderScale', 1),
    format: (v) => `${Math.round(v * 100)}%`,
    title: 'The most the scene may be drawn at, as a fraction of your display. '
      + 'The largest single cost in the renderer — half the resolution is close '
      + 'to half the frame time.',
    onInput: (v) => {
      prefs.set('quality.maxRenderScale', v);
      hooks.setMaxRenderScale?.(v);
    },
  });

  const targetRow = el('div', { class: 'field is-row' }, [
    el('span', { class: 'field-label', text: 'Target frame rate' }),
    targetControl.root,
  ]);

  const readout = el('div', { class: 'quality-readout' });

  function syncMode(preset) {
    // The target frame rate only means anything to the loop that is chasing it.
    targetRow.style.display = preset === 'auto' ? '' : 'none';
  }
  syncMode(prefs.get('quality.preset', 'auto'));

  const made = panel({
    id: 'quality',
    title: 'Performance',
    body: [
      presetControl.root,
      targetRow,
      scaleSlider.root,
      readout,
    ],
  });

  return {
    panel: made,
    /**
     * Called from the frame loop's throttled interface tick. Shows what the
     * auto loop settled on, which is the only way to tell a scene that is
     * expensive from one that is being drawn small.
     */
    update(stats) {
      if (!stats) return;
      const parts = [`${Math.round(stats.fps)} fps`, `${Math.round(stats.renderScale * 100)}% resolution`];
      if (stats.preset === 'auto') parts.push(`quality ${Math.round(stats.quality * 100)}%`);
      text(readout, parts.join('  \u00b7  '));
    },
  };
}
