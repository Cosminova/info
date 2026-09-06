/**
 * Shell for the planetarium.
 *
 * The planetarium's controls are wired by element id inside main.js and work
 * well; what it lacked was the shell around them — a navigation rail, panels
 * that collapse and remember whether they were open, an immersive mode, a
 * shortcut table you can rebind, and the appearance settings. This adds those on
 * top of the existing markup rather than taking the wiring over, so there is one
 * place that owns each control.
 *
 * Panels are addressed through their existing ids, and where main.js already
 * toggles one (the options panel from its own button) this drives the same
 * element, so the two cannot disagree about whether it is open.
 */

import { el, css, show, append, text } from './dom.js';
import { createPrefs } from './prefs.js';
import { createShortcuts, prettyChord } from './shortcuts.js';
import { platform } from '../engine/platform.js';
import { createTooltips, slider, icon, dialog } from './components.js';

const $ = (id) => document.getElementById(id);

const RAIL = [
  { id: 'search', label: 'Search', icon: 'search', action: 'search' },
  { id: 'selection', label: 'Selection', icon: 'planet', action: 'panel' },
  { id: 'readout', label: 'Coordinates', icon: 'compass', action: 'panel' },
  'sep',
  { id: 'options', label: 'Options', icon: 'eye', action: 'panel' },
  { id: 'settings', label: 'Interface', icon: 'settings', action: 'dialog' },
  { id: 'help', label: 'Help', icon: 'help', action: 'dialog' },
];

export function createSkyUI({ controls, state, onModeChange, setRate, getRate }) {
  const prefs = createPrefs();
  prefs.applyAppearance();
  const shortcuts = createShortcuts(prefs);
  createTooltips();

  // ------------------------------------------------------------------ panels

  /** Panels are the existing `<aside>` elements, found by their id. */
  const panels = new Map([
    ['options', $('panel')],
    ['selection', $('selection')],
    ['readout', $('readout-panel')],
  ]);

  for (const [id, node] of panels) {
    if (!node) continue;
    // The selection panel is opened by main.js when something is picked, so its
    // visibility is not a preference; the other two are.
    if (id !== 'selection') show(node, prefs.get(`panels.${id}`, id === 'readout'));

    const head = node.querySelector('.panel-head');
    head?.addEventListener('click', (event) => {
      if (event.target.closest('button, input, a')) return;
      const collapsed = !node.classList.contains('is-collapsed');
      css(node, 'is-collapsed', collapsed);
      prefs.set(`collapsed.${id}`, collapsed);
    });
    if (prefs.get(`collapsed.${id}`, false)) css(node, 'is-collapsed', true);
  }

  function togglePanel(id, force) {
    const node = panels.get(id);
    if (!node) return;
    const next = force === undefined ? node.hidden : force;
    show(node, next);
    if (id !== 'selection') prefs.set(`panels.${id}`, next);
    syncRail();
  }

  // main.js toggles the options panel from its own button; watch for that so the
  // rail's active state and the saved preference stay honest.
  $('btn-panel')?.addEventListener('click', () => {
    // Runs after main.js's own handler has flipped it.
    setTimeout(() => {
      prefs.set('panels.options', !$('panel').hidden);
      syncRail();
    }, 0);
  });

  // --------------------------------------------------------------------- rail

  const railItems = new Map();
  const rail = $('rail');
  append(rail, RAIL.map((entry) => {
    if (entry === 'sep') return el('div', { class: 'rail-sep' });
    const button = el('button', {
      type: 'button',
      class: 'rail-item',
      onClick: () => {
        if (entry.action === 'search') $('search-input').focus();
        else if (entry.action === 'panel') togglePanel(entry.id);
        else toggleDialog(entry.id);
      },
    }, [icon(entry.icon), el('span', { class: 'rail-label', text: entry.label })]);
    button.dataset.tip = entry.label;
    railItems.set(entry.id, button);
    return button;
  }));

  $('rail-toggle')?.addEventListener('click', () => {
    prefs.set('rail', prefs.get('rail') === 'labels' ? 'icons' : 'labels');
    syncRail();
  });

  function syncRail() {
    css(rail, 'is-open', prefs.get('rail') === 'labels');
    for (const [id, button] of railItems) {
      const node = panels.get(id);
      if (node) css(button, 'is-active', !node.hidden);
      else if (id === 'help') css(button, 'is-active', !$('help').hidden);
      else if (id === 'settings') css(button, 'is-active', !settings.root.hidden);
      const binding = shortcuts.binding(`open.${id}`);
      if (binding) button.dataset.tipKey = prettyChord(binding);
    }
  }

  // ------------------------------------------------------------------ dialogs

  const scaleSlider = slider({
    label: 'Interface scale', min: 0.8, max: 1.6, step: 0.05, value: prefs.get('scale'),
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => prefs.set('scale', v),
  });
  const alphaSlider = slider({
    label: 'Panel opacity', min: 0.3, max: 1, step: 0.02, value: prefs.get('alpha'),
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => prefs.set('alpha', v),
  });
  const accentSlider = slider({
    label: 'Accent colour', min: 0, max: 360, step: 1, value: prefs.get('accent'),
    format: (v) => `${v}\u00b0`,
    onInput: (v) => prefs.set('accent', v),
  });

  const settings = dialog({
    title: 'Interface',
    placement: 'right',
    onClose: () => toggleDialog('settings', false),
    body: [
      scaleSlider.root, alphaSlider.root, accentSlider.root,
      el('p', { class: 'prose', text: 'Panel visibility and these appearance settings are saved between sessions, and are shared with the universe explorer.' }),
      el('button', {
        type: 'button', class: 'btn', text: 'Reset interface to defaults',
        onClick: () => {
          prefs.reset();
          scaleSlider.set(prefs.get('scale'));
          alphaSlider.set(prefs.get('alpha'));
          accentSlider.set(prefs.get('accent'));
          buildHelpKeys();
          syncRail();
        },
      }),
    ],
  });
  document.body.append(settings.root);
  show(settings.root, false);

  function toggleDialog(id, force) {
    if (id === 'help') {
      const next = force === undefined ? $('help').hidden : force;
      show($('help'), next);
      if (next) show(settings.root, false);
    } else if (id === 'settings') {
      const next = force === undefined ? settings.root.hidden : force;
      show(settings.root, next);
      // One at a time: two translucent dialogs over a starfield are illegible.
      if (next) show($('help'), false);
    }
    syncRail();
  }

  // Keep the rail in step with main.js's own help button and backdrop close.
  for (const id of ['btn-help', 'help-close', 'help']) {
    $(id)?.addEventListener('click', () => setTimeout(syncRail, 0));
  }

  // ---------------------------------------------------------------- immersive

  /* Assigned below, and only on touch, which is the only host that needs it. */
  let immersiveHint = null;

  function setImmersive(on, instant = false) {
    if (instant) {
      css(document.body, 'no-ui-anim', true);
      void document.body.offsetWidth;
    }
    css(document.body, 'immersive', on);
    // Kept off the captures, for the reason given in ui/explorer-ui.js.
    if (immersiveHint) css(immersiveHint, 'is-silent', instant);
    if (instant) {
      void document.body.offsetWidth;
      css(document.body, 'no-ui-anim', false);
    }
    if (on) {
      show($('help'), false);
      show(settings.root, false);
      show($('search-results'), false);
    }
  }

  const isImmersive = () => document.body.classList.contains('immersive');
  $('btn-immersive')?.addEventListener('click', () => setImmersive(true));

  /*
   * The way back out. On a desktop it is F11 or Esc and this view never said so,
   * which was survivable there; on touch neither key exists, and the button just
   * pressed to get in here has faded out with the rest of the interface. So the
   * mode was a door that only locked.
   *
   * The explorer answers this with a hint that is itself the way out, and the
   * rules that keep it visible and tappable are in theme.css, which this page
   * already loads — so the fix is the same element, not a second mechanism.
   */
  if (platform.touch) {
    immersiveHint = el('div', {
      class: 'immersive-hint is-touch',
      text: 'immersive mode \u2014 tap here to bring the interface back',
      onClick: () => setImmersive(false),
    });
    document.body.append(immersiveHint);
  }

  // ---------------------------------------------------------------- overlays

  function syncOverlays() {
    const labels = prefs.get('labels');
    $('labels').style.display = labels ? '' : 'none';
    $('ui-reticle').style.display = prefs.get('reticle') ? '' : 'none';
  }

  // ---------------------------------------------------------------- shortcuts

  /**
   * The same keys as the explorer where the action exists in both, so moving
   * between the two views does not mean learning a second set. Keys that main.js
   * already owns for sky-specific actions — arrows, Z, T, R, C, G, F — are left to
   * it and documented here rather than re-registered.
   */
  shortcuts.register({ id: 'open.help', key: 'F1', label: 'Help and controls', group: 'Interface', run: () => toggleDialog('help') });
  shortcuts.register({ id: 'open.search', key: 'F2', label: 'Search', group: 'Interface', allowInInput: true, run: () => $('search-input').focus() });
  shortcuts.register({ id: 'open.selection', key: 'F3', label: 'Selection panel', group: 'Interface', run: () => togglePanel('selection') });
  shortcuts.register({ id: 'open.readout', key: 'F4', label: 'Coordinates panel', group: 'Interface', run: () => togglePanel('readout') });
  shortcuts.register({ id: 'toggle.labels', key: 'F5', label: 'Sky labels', group: 'Interface', run: () => { prefs.toggle('labels'); syncOverlays(); } });
  shortcuts.register({ id: 'open.options', key: 'F9', label: 'Options panel', group: 'Interface', run: () => togglePanel('options') });
  shortcuts.register({ id: 'open.settings', key: 'F10', label: 'Interface settings', group: 'Interface', run: () => toggleDialog('settings') });
  shortcuts.register({ id: 'toggle.immersive', key: 'F11', label: 'Immersive mode', group: 'Interface', allowInInput: true, run: () => setImmersive(!isImmersive()) });

  shortcuts.register({ id: 'time.now', key: 'N', label: 'Jump to the present', group: 'Simulation', run: () => { state.date = new Date(); setRate(1); } });
  shortcuts.register({
    id: 'time.reverse', key: 'Shift+R', label: 'Reverse the current rate', group: 'Simulation',
    run: () => setRate(-(getRate() || 1)),
  });

  shortcuts.register({
    id: 'close.any', key: 'Esc', label: 'Close the topmost panel or menu', group: 'Interface', allowInInput: true,
    run: () => {
      if (!$('search-results').hidden) return show($('search-results'), false);
      if (!$('help').hidden) return show($('help'), false);
      if (!settings.root.hidden) return show(settings.root, false);
      if (isImmersive()) return setImmersive(false);
      return undefined;
    },
  });

  const helpKeys = $('help-keys');

  function buildHelpKeys() {
    if (!helpKeys) return;
    helpKeys.replaceChildren();
    for (const [group, actions] of shortcuts.list()) {
      append(helpKeys, [
        el('div', { class: 'section-title', style: { gridColumn: '1 / -1' }, text: group }),
        ...actions.flatMap((action) => [
          el('button', {
            type: 'button', class: 'rebind', text: prettyChord(action.binding) || 'unset',
            title: 'Click, then press the key you want',
            onClick: (event) => listenForRebind(event.currentTarget, action.id),
          }),
          el('span', { text: action.label }),
        ]),
      ]);
    }
    // These belong to the sky view itself and are handled in main.js. They are
    // listed so this panel is a complete reference, and they are deliberately not
    // registered here — two handlers for one key would fire twice.
    append(helpKeys, [
      el('div', { class: 'section-title', style: { gridColumn: '1 / -1' }, text: 'Sky (fixed)' }),
      ...[
        ['\u2190 \u2192 \u2191 \u2193', 'Pan the view'],
        ['+ \u2212', 'Zoom in and out'],
        ['Space', 'Pause or resume time'],
        ['G', 'Ground view'],
        ['F', 'Free space'],
        ['C', 'Constellation figures'],
        ['Z', 'Frame the selection'],
        ['T', 'Let go of the selection'],
        ['R', 'Reset the view'],
      ].flatMap(([key, label]) => [
        el('kbd', { text: key }),
        el('span', { text: label }),
      ]),
    ]);
  }

  function listenForRebind(button, id) {
    css(button, 'is-listening', true);
    text(button, 'press\u2026');
    const capture = (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.removeEventListener('keydown', capture, true);
      if (event.key !== 'Escape') {
        const parts = [];
        if (event.ctrlKey) parts.push('Ctrl');
        if (event.metaKey) parts.push('Meta');
        if (event.altKey) parts.push('Alt');
        if (event.shiftKey) parts.push('Shift');
        let key = event.key;
        if (key === ' ') key = 'Space';
        else if (key.length === 1) key = key.toUpperCase();
        parts.push(key);
        shortcuts.rebind(id, parts.join('+'));
      }
      buildHelpKeys();
      syncRail();
    };
    window.addEventListener('keydown', capture, true);
  }

  buildHelpKeys();
  syncOverlays();
  syncRail();

  return {
    prefs,
    shortcuts,
    setImmersive,
    togglePanel,
    toggleDialog,
    syncRail,
    /** Called by main.js when it opens the selection panel itself. */
    notifySelection() {
      syncRail();
    },
  };
}
