/**
 * The universe explorer's interface.
 *
 * This is the composition root: it builds the regions, owns the panels, holds
 * the shortcut table, and is the only thing space.js has to talk to. The layout
 * rule it enforces is that nothing is ever placed in the centre column — panels
 * dock to the left beside the navigation rail, the inspector docks right, the
 * readouts sit along the bottom, and the middle of the screen belongs to the
 * view.
 *
 * Per-frame work is deliberately small. `frame()` computes a handful of derived
 * values, hands strings to readouts that compare before writing, and runs the
 * label layer on a fixed interval rather than every frame. Panels that are
 * closed do no work at all.
 */

import { el, text, css, show, append, reconcile } from './dom.js';
import { createPrefs } from './prefs.js';
import { createShortcuts, prettyChord } from './shortcuts.js';
import {
  panel, slider, check, segmented, createTooltips, createMenu, dialog, icon,
} from './components.js';
import { createSearch } from './search.js';
import { createInspector, describe } from './inspector.js';
import { createHud, createTimeBar, createScaleBar } from './hud.js';
import { createLabelLayer } from './labels.js';
import { createQualityPanel } from './quality-panel.js';
import { createFlightControls } from './flight-controls.js';
import { createIntro } from './intro.js';
import { VIEW_GROUPS } from './view-options.js';
import { AU_KM, formatDistance } from '../engine/units.js';

const CAMERA_MODES = [
  {
    value: 'orbit',
    label: 'Orbit',
    title: 'Circle the selected body. Drag to swing around it, scroll to close in.',
  },
  {
    value: 'free',
    label: 'Fly',
    title: 'Thrust with WASD and Q/E, still measured from the selected body.',
  },
  {
    value: 'track',
    label: 'Track',
    title: 'Thrust with WASD, but the view stays locked on the selected body.',
  },
  {
    value: 'roam',
    label: 'Roam',
    title:
      'Let go of the body entirely and fly through open space. '
      + 'Drag turns you on the spot, the wheel sets your speed.',
  },
];

export function createExplorerUI(config) {
  const {
    root, labelRoot, canvas, controls, camera, state,
    destinations, quickTargets, resolveWorld, hooks,
  } = config;

  const prefs = createPrefs();
  prefs.applyAppearance();
  const shortcuts = createShortcuts(prefs);
  createTooltips();
  const menu = createMenu();

  // ------------------------------------------------------------------ regions

  const regionTop = el('div', { class: 'region-top' });
  const regionLeft = el('div', { class: 'region-left' });
  // The rail and the panels it opens are siblings in a row, and the panels
  // themselves stack in a column beside it. Without the inner column the panels
  // would lay out along the rail and march across the middle of the view.
  const dockLeft = el('div', { class: 'dock' });
  const regionRight = el('div', { class: 'region-right' });
  const regionBottom = el('div', { class: 'region-bottom' });
  const regionCenter = el('div', { class: 'region-center' });
  const layer = el('div', { class: 'ui-layer' }, [
    regionTop, regionLeft, regionCenter, regionRight, regionBottom,
  ]);
  root.append(layer);

  // ------------------------------------------------------------------ reticle

  const reticle = el('div', { class: 'reticle' });
  regionCenter.append(reticle);

  const hoverBox = el('div', { class: 'hover-box' });
  const hoverName = el('div', { class: 'hover-name' });
  const hover = el('div', { class: 'hover-target', hidden: true }, [hoverBox, hoverName]);
  document.body.append(hover);

  // ------------------------------------------------------------------- search

  const search = createSearch({
    destinations,
    resolve: (key) => {
      const resolved = resolveWorld(key);
      if (!resolved) return null;
      return {
        ...resolved,
        cameraDistanceKm: resolved.position.distanceTo(controls.worldPosition),
      };
    },
    craftStatus: (key) => hooks.craftRecord?.(key),
    onPick: (key) => hooks.selectTarget(key, { fly: true }),
    onAction: (key, action) => runAction(action, key),
    prefs,
  });

  // -------------------------------------------------------------------- panels

  /**
   * Panels are registered so the rail, the shortcuts and the saved preferences
   * all address them the same way, and so restoring visibility at startup is one
   * loop rather than a line per panel.
   */
  const panels = new Map();

  function registerPanel(id, made, region) {
    panels.set(id, made);
    region.append(made.root);
    show(made.root, prefs.get(`panels.${id}`, false));
    return made;
  }

  function togglePanel(id, force) {
    const made = panels.get(id);
    if (!made) return;
    const next = force === undefined ? made.root.hidden : force;
    show(made.root, next);
    prefs.set(`panels.${id}`, next);
    if (next) made.root.classList.add('is-entering');
    syncRail();
  }

  // ---- navigation panel

  const modeControl = segmented({
    options: CAMERA_MODES,
    value: 'orbit',
    onChange: (value) => setCameraMode(value),
  });

  const navActions = el('div', { class: 'obj-actions' });
  const quickList = el('div', { class: 'quick-list' });

  const navPanel = registerPanel('navigation', panel({
    id: 'navigation',
    title: 'Navigation',
    collapsed: false,
    onToggle: (collapsed) => prefs.set('collapsed.navigation', collapsed),
    body: [
      el('div', { class: 'section-title', text: 'Camera mode' }),
      modeControl.root,
      el('div', { class: 'section' }, [
        el('div', { class: 'section-title', text: 'Destinations' }),
        quickList,
      ]),
      el('div', { class: 'section' }, [
        el('div', { class: 'section-title', text: 'Views' }),
        el('div', { class: 'obj-actions', style: { borderTop: '0', paddingTop: '0', marginTop: '0' } }, [
          el('button', { type: 'button', class: 'btn', text: 'From Earth', title: 'Stand on Earth and look at the target',
            onClick: () => hooks.setViewFromEarth(!state.viewFromEarth) }),
          el('button', { type: 'button', class: 'btn', text: 'Zoom out', title: 'Continuous exponential pull-back',
            onClick: () => hooks.tour() }),
          el('button', { type: 'button', class: 'btn', text: 'Earth \u2192 Saturn', title: 'Fly the real-scale cruise',
            onClick: () => hooks.saturnRun() }),
        ]),
      ]),
    ],
  }), dockLeft);

  for (const entry of quickTargets) {
    quickList.append(el('button', {
      type: 'button',
      class: 'btn quick',
      text: entry.name,
      // Say that clicking one travels rather than merely selecting. It is the
      // shortest route into the scene and the one most likely to be tried
      // first, so it should not be a button whose effect you find out by
      // pressing it.
      dataset: { key: entry.key, tip: `Fly to ${entry.name}` },
      onClick: () => hooks.selectTarget(entry.key, { fly: !state.viewFromEarth }),
    }));
  }

  // ---- camera panel

  const cam = prefs.get('camera');
  controls.setFov(cam.fov);
  controls.flySpeed = cam.flySpeed;
  controls.orbitSensitivity = cam.orbitSensitivity;
  controls.lookSensitivity = cam.lookSensitivity;
  controls.zoomSpeed = cam.zoomSpeed;
  controls.autoCenter = cam.autoCenter;

  const fovSlider = slider({
    label: 'Field of view',
    min: controls.minFov, max: controls.maxFov, step: 0.5, value: controls.fov,
    format: (v) => `${v.toFixed(1)}\u00b0`,
    onInput: (v) => { controls.setFov(v); prefs.set('camera.fov', controls.fov); },
  });

  const speedSlider = slider({
    label: 'Camera speed',
    min: 0.05, max: 4, step: 0.05, value: controls.flySpeed,
    format: (v) => `${v.toFixed(2)}\u00d7`,
    title: 'How fast W/A/S/D moves you. Scaled by altitude, so it feels the same at every distance.',
    onInput: (v) => { controls.flySpeed = v; prefs.set('camera.flySpeed', v); },
  });

  const rotateSlider = slider({
    label: 'Rotation speed',
    min: 0.001, max: 0.02, step: 0.0005, value: controls.orbitSensitivity,
    format: (v) => `${(v * 1000).toFixed(1)}`,
    title: 'Drag sensitivity when orbiting.',
    onInput: (v) => { controls.orbitSensitivity = v; prefs.set('camera.orbitSensitivity', v); },
  });

  const lookSlider = slider({
    label: 'Look sensitivity',
    min: 0.001, max: 0.012, step: 0.0002, value: controls.lookSensitivity,
    format: (v) => `${(v * 1000).toFixed(1)}`,
    title: 'Drag sensitivity when looking around (right-drag or shift-drag).',
    onInput: (v) => { controls.lookSensitivity = v; prefs.set('camera.lookSensitivity', v); },
  });

  const zoomSlider = slider({
    label: 'Zoom sensitivity',
    min: 0.0004, max: 0.006, step: 0.0002, value: controls.zoomSpeed,
    format: (v) => `${(v * 1000).toFixed(1)}`,
    onInput: (v) => { controls.zoomSpeed = v; prefs.set('camera.zoomSpeed', v); },
  });

  const autoCenterCheck = check({
    label: 'Auto-center on target',
    checked: controls.autoCenter,
    title: 'Ease the view back onto the target after you look away.',
    onChange: (v) => { controls.autoCenter = v; prefs.set('camera.autoCenter', v); },
  });

  registerPanel('camera', panel({
    id: 'camera',
    title: 'Camera',
    body: [
      fovSlider.root, speedSlider.root, rotateSlider.root, lookSlider.root, zoomSlider.root,
      autoCenterCheck.root,
      el('div', { class: 'section' }, [
        el('div', { class: 'section-title', text: 'Surface' }),
        el('button', {
          type: 'button', class: 'btn', text: 'Descend to surface',
          title: 'Drop to just above the surface of the target and look around',
          onClick: () => runAction('land'),
        }),
      ]),
    ],
  }), dockLeft);

  // ---- display panel

  const labelCheck = check({
    label: 'Object labels',
    checked: prefs.get('labels'),
    onChange: (v) => { prefs.set('labels', v); syncDisplay(); },
  });
  const densitySlider = slider({
    label: 'Label density',
    min: 0, max: 1, step: 0.05, value: prefs.get('labelDensity'),
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => prefs.set('labelDensity', v),
  });
  const hudCheck = check({
    label: 'Bottom readouts',
    checked: prefs.get('hud'),
    onChange: (v) => { prefs.set('hud', v); syncDisplay(); },
  });
  const reticleCheck = check({
    label: 'Center reticle',
    checked: prefs.get('reticle'),
    onChange: (v) => { prefs.set('reticle', v); syncDisplay(); },
  });
  const exposureSlider = slider({
    label: 'Exposure',
    min: 0.2, max: 3, step: 0.05, value: state.exposure,
    onInput: (v) => hooks.setExposure(v),
  });

  // One checkbox per row of the options table, and the same call used to apply
  // the saved value at startup. Written this way so a toggle cannot end up
  // showing one thing while the renderer does another.
  const viewChecks = new Map();
  function setViewOption(key, value) {
    prefs.set(`view.${key}`, value);
    viewChecks.get(key)?.set(value);
    hooks.setView?.(key, value);
  }
  const viewSections = VIEW_GROUPS.map((group) => el('div', { class: 'section' }, [
    el('div', { class: 'section-title', text: group.title }),
    ...group.options.map((option) => {
      const box = check({
        label: option.label,
        title: option.title,
        checked: prefs.get(`view.${option.key}`, option.default),
        onChange: (value) => setViewOption(option.key, value),
      });
      viewChecks.set(option.key, box);
      return box.root;
    }),
  ]));

  registerPanel('display', panel({
    id: 'display',
    title: 'Display',
    body: [
      exposureSlider.root,
      el('div', { class: 'section' }, [
        el('div', { class: 'section-title', text: 'Interface' }),
        labelCheck.root, densitySlider.root, hudCheck.root, reticleCheck.root,
      ]),
      ...viewSections,
    ],
  }), dockLeft);

  // ---- performance panel

  const quality = createQualityPanel({ prefs, hooks });
  registerPanel('quality', quality.panel, dockLeft);

  // ---- inspector

  const inspector = createInspector({ onAction: (action) => runAction(action) });
  const inspectorPanel = registerPanel('inspector', panel({
    id: 'inspector',
    title: 'Object',
    body: [inspector.root],
  }), regionRight);

  // ---- system panel: the satellites of whatever system you are in

  const systemTree = el('div', { class: 'system-tree' });
  registerPanel('system', panel({
    id: 'system',
    title: 'Planetary system',
    body: [systemTree],
  }), regionRight);

  // ---- bookmarks

  const bookmarkList = el('div', { class: 'bookmark-list' });
  registerPanel('bookmarks', panel({
    id: 'bookmarks',
    title: 'Bookmarks',
    body: [
      bookmarkList,
      el('button', {
        type: 'button', class: 'btn', text: 'Bookmark current target',
        onClick: () => runAction('bookmark'),
      }),
    ],
  }), regionRight);

  // ------------------------------------------------------------------- top bar

  const railToggle = el('button', {
    type: 'button',
    class: 'btn is-icon is-quiet',
    'aria-label': 'Expand navigation',
    text: '\u2630',
    onClick: () => {
      const open = prefs.get('rail') !== 'labels';
      prefs.set('rail', open ? 'labels' : 'icons');
      syncRail();
    },
  });
  railToggle.dataset.tip = 'Expand the navigation rail';

  const timeBar = createTimeBar({
    getRate: () => state.timeRate,
    setRate: (rate) => { state.timeRate = rate; },
    getPlaying: () => state.playing,
    setPlaying: (playing) => { state.playing = playing; },
    getDate: () => state.date,
    setDate: (date) => hooks.setDate(date),
    onCustom: () => openCustomRate(),
  });

  append(regionTop, [
    el('div', { class: 'topbar' }, [
      railToggle,
      el('div', { class: 'brand' }, [
        el('span', { class: 'brand-name', text: 'COSMINOVA' }),
        el('span', { class: 'brand-sub', text: 'universe explorer' }),
      ]),
      search.root,
      el('div', { class: 'topbar-spacer' }),
      timeBar.root,
    ]),
  ]);

  // -------------------------------------------------------------------- bottom

  const hud = createHud();
  const scaleBar = createScaleBar();
  regionCenter.append(scaleBar.root);

  const bottomRight = el('div', { class: 'bottom-right' }, [
    el('button', {
      type: 'button', class: 'btn', text: 'Immersive',
      title: 'Hide the entire interface',
      onClick: () => setImmersive(true),
    }),
    el('button', {
      type: 'button', class: 'btn is-icon', text: '?',
      'aria-label': 'Help',
      onClick: () => toggleDialog('help'),
    }),
  ]);
  // Between the readouts and the buttons, so switching to a flight mode makes
  // the controls appear next to the speed and altitude they change.
  const flight = createFlightControls({ controls, prefs });
  append(regionBottom, [hud.root, flight.root, bottomRight]);

  const immersiveHint = el('div', {
    class: 'immersive-hint',
    text: 'immersive mode \u2014 press F11 to bring the interface back',
  });
  document.body.append(immersiveHint);

  const intro = createIntro({
    prefs,
    // Earth rather than anywhere more spectacular: the point of the button is to
    // demonstrate that clicking a name travels somewhere, and the destination
    // list is right there to be tried next.
    onStart: () => hooks.selectTarget('earth', { fly: true }),
    onGuide: () => toggleDialog('help', true),
  });
  document.body.append(intro.root);

  // --------------------------------------------------------------------- rail

  const RAIL = [
    { id: 'search', label: 'Search', icon: 'search', action: 'search' },
    { id: 'navigation', label: 'Navigation', icon: 'compass', action: 'panel' },
    { id: 'camera', label: 'Camera', icon: 'camera', action: 'panel' },
    { id: 'inspector', label: 'Object', icon: 'planet', action: 'panel' },
    // `short` is what the rail shows when it is open; `label` is what the
    // tooltip says and what the panel is called. Only one entry needs the
    // distinction, and it needs it because the rail is now open by default and
    // "Planetary system" is wider than the rail is worth.
    { id: 'system', label: 'Planetary system', short: 'System', icon: 'system', action: 'panel' },
    'sep',
    { id: 'catalog', label: 'Catalog', icon: 'catalog', action: 'dialog' },
    { id: 'bookmarks', label: 'Bookmarks', icon: 'bookmark', action: 'panel' },
    'sep',
    { id: 'display', label: 'Display', icon: 'eye', action: 'panel' },
    { id: 'quality', label: 'Performance', icon: 'gauge', action: 'panel' },
    { id: 'settings', label: 'Settings', icon: 'settings', action: 'dialog' },
    { id: 'help', label: 'Help', icon: 'help', action: 'dialog' },
  ];

  const railItems = new Map();
  const rail = el('div', { class: 'rail panel takes-pointer' }, RAIL.map((entry) => {
    if (entry === 'sep') return el('div', { class: 'rail-sep' });
    const button = el('button', {
      type: 'button',
      class: 'rail-item',
      onClick: () => {
        if (entry.action === 'search') search.focus();
        else if (entry.action === 'panel') togglePanel(entry.id);
        else toggleDialog(entry.id);
      },
    }, [icon(entry.icon), el('span', { class: 'rail-label', text: entry.short ?? entry.label })]);
    button.dataset.tip = entry.label;
    railItems.set(entry.id, button);
    return button;
  }));
  regionLeft.append(rail, dockLeft);

  function syncRail() {
    css(rail, 'is-open', prefs.get('rail') === 'labels');
    for (const [id, button] of railItems) {
      const made = panels.get(id);
      if (made) css(button, 'is-active', !made.root.hidden);
      else css(button, 'is-active', dialogs.get(id) ? !dialogs.get(id).root.hidden : false);
      // Tooltips carry the shortcut where there is one, so the keys are
      // discoverable without opening the help panel.
      const binding = shortcuts.binding(`open.${id}`);
      if (binding) button.dataset.tipKey = prettyChord(binding);
    }
  }

  // ------------------------------------------------------------------ dialogs

  const dialogs = new Map();

  function registerDialog(id, made) {
    dialogs.set(id, made);
    document.body.append(made.root);
    show(made.root, false);
    return made;
  }

  function toggleDialog(id, force) {
    const made = dialogs.get(id);
    if (!made) return;
    const next = force === undefined ? made.root.hidden : force;
    // Only one dialog at a time; two overlapping translucent dialogs over a
    // starfield are illegible.
    for (const [otherId, other] of dialogs) if (otherId !== id) show(other.root, false);
    show(made.root, next);
    if (id === 'catalog' && next) buildCatalog();
    syncRail();
  }

  // ---- help / shortcuts

  const helpKeys = el('div', { class: 'help-keys' });
  registerDialog('help', dialog({
    title: 'Cosminova \u2014 how to get around',
    placement: 'center',
    onClose: () => toggleDialog('help', false),
    body: [
      el('div', { class: 'help-grid' }, [
        el('div', {}, [
          /*
           * This dialog used to open on "Pointer" and a list of gestures. That
           * tells someone who already knows what they are trying to do which
           * button to hold; it does not tell someone who has just arrived in
           * front of a black screen full of stars what to do first. So the
           * first thing in it is now the shortest path to somewhere worth
           * being, and the gestures follow.
           */
          el('div', { class: 'section-title', text: 'Getting somewhere' }),
          el('p', { class: 'prose', html:
            'Pick anything in <b>Navigation \u203a Destinations</b> and you will fly to it. '
            + 'Or type a name into the search box at the top \u2014 any of five thousand stars, '
            + 'the named moons, a few thousand galaxies, or a planet around another sun. '
            + 'Everything in the scene is somewhere you can actually go.' }),
          el('p', { class: 'prose', html:
            'Once you are there: <b>drag</b> to swing around it, <b>scroll</b> to close in or pull back, '
            + 'and <b>Land</b> in the Object panel to drop to the surface and stand on it.' }),

          el('div', { class: 'section-title', text: 'The four camera modes' }),
          el('p', { class: 'prose', html:
            '<b>Orbit</b> circles whatever is selected \u2014 the mode you arrive in. '
            + '<b>Fly</b> adds thrust on <b>W A S D</b>, still measured from that body. '
            + '<b>Track</b> is the same but keeps the body centred while you move. '
            + '<b>Roam</b> lets go of it completely: no target, no orbit, just open space. '
            + 'Drag turns you on the spot, the wheel sets your speed, and how fast you go '
            + 'scales with whatever happens to be nearest \u2014 so you slow to a crawl on '
            + 'the way in to something and cross the system when nothing is close.' }),

          el('div', { class: 'section-title', text: 'Pointer and keys' }),
          el('p', { class: 'prose', html:
            '<b>Drag</b> orbits the target. <b>Right-drag</b> or <b>shift-drag</b> looks around. '
            + '<b>Scroll</b> zooms exponentially and keeps coasting, from metres above a crater out past the Local Group. '
            + '<b>Click</b> selects and travels; <b>right-click</b> opens the object menu. '
            + '<b>W A S D</b> with <b>Q</b>/<b>E</b> flies and <b>shift</b> boosts. '
            + 'Hover any control to be told what it does.' }),
          el('div', { class: 'section-title', text: 'What you are looking at' }),
          el('p', { class: 'prose', text:
            'One continuous scene at true scale. Surfaces are spacecraft imagery where it exists \u2014 LROC and LOLA for '
            + 'the Moon, Voyager and Galileo for the Jovian moons, Cassini for Titan \u2014 and procedural relief below '
            + 'that. Named moons, nearby stars with confirmed planets and a few thousand galaxies sit at their measured '
            + 'distances.' }),
          el('p', { class: 'prose is-credits', text:
            'Imagery: NASA/GSFC/Arizona State University (LROC, LOLA), NASA/JPL/USGS, Solar System Scope (CC BY 4.0). '
            + 'Stars: HYG v4.1. Galaxies: UNGC, Cosmicflows-3, RC3. Exoplanets: NASA Exoplanet Archive. Milky Way '
            + 'panorama: ESO/S. Brunier.' }),
        ]),
        el('div', {}, [
          el('div', { class: 'section-title', text: 'Keyboard \u2014 click a key to rebind' }),
          helpKeys,
          el('div', { class: 'section' }, [
            el('button', {
              type: 'button',
              class: 'btn',
              text: 'Show the welcome card again',
              dataset: { tip: 'The three-step card from your first visit' },
              onClick: () => {
                toggleDialog('help', false);
                intro.show();
              },
            }),
          ]),
        ]),
      ]),
    ],
  }));

  // ---- settings

  const scaleSlider = slider({
    label: 'Interface scale',
    min: 0.8, max: 1.6, step: 0.05, value: prefs.get('scale'),
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => prefs.set('scale', v),
  });
  const alphaSlider = slider({
    label: 'Panel opacity',
    min: 0.3, max: 1, step: 0.02, value: prefs.get('alpha'),
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => prefs.set('alpha', v),
  });
  const accentSlider = slider({
    label: 'Accent colour',
    min: 0, max: 360, step: 1, value: prefs.get('accent'),
    format: (v) => `${v}\u00b0`,
    onInput: (v) => prefs.set('accent', v),
  });

  registerDialog('settings', dialog({
    title: 'Interface',
    placement: 'right',
    onClose: () => toggleDialog('settings', false),
    body: [
      scaleSlider.root, alphaSlider.root, accentSlider.root,
      el('p', { class: 'prose', text: 'Panel visibility, camera sensitivities and these appearance settings are saved between sessions.' }),
      el('div', { class: 'section' }, [
        el('button', {
          type: 'button', class: 'btn', text: 'Reset interface to defaults',
          onClick: () => {
            prefs.reset();
            scaleSlider.set(prefs.get('scale'));
            alphaSlider.set(prefs.get('alpha'));
            accentSlider.set(prefs.get('accent'));
            for (const [id, made] of panels) show(made.root, prefs.get(`panels.${id}`, false));
            syncRail();
            syncDisplay();
            buildHelpKeys();
          },
        }),
      ]),
    ],
  }));

  // ---- catalog

  const catalogBody = el('div', { class: 'catalog' });
  registerDialog('catalog', dialog({
    title: 'Catalog',
    placement: 'center',
    onClose: () => toggleDialog('catalog', false),
    body: [catalogBody],
  }));

  function buildCatalog() {
    // Grouped by the catalogue's own grouping, capped per group: the full list is
    // tens of thousands of entries and belongs to search, not to a browse view.
    const groups = new Map();
    for (const dest of destinations) {
      if (!groups.has(dest.group)) groups.set(dest.group, []);
      groups.get(dest.group).push(dest);
    }
    reconcile(catalogBody, `${groups.size}`, () =>
      [...groups.entries()].map(([group, entries]) => el('div', { class: 'section' }, [
        el('div', { class: 'section-title', text: `${group} \u00b7 ${entries.length}` }),
        el('div', { class: 'catalog-grid' }, entries.slice(0, 60).map((dest) =>
          el('button', {
            type: 'button', class: 'btn', text: dest.name,
            onClick: () => { toggleDialog('catalog', false); hooks.selectTarget(dest.key, { fly: true }); },
          }))),
      ])),
    );
  }

  // ------------------------------------------------------------------- actions

  /** The verbs shared by the inspector, the context menu and search. */
  function runAction(action, key = state.target) {
    const resolved = resolveWorld(key);
    switch (action) {
      case 'goto':
        hooks.selectTarget(key, { fly: true });
        break;
      case 'center':
      case 'target':
        hooks.selectTarget(key, { fly: false });
        break;
      case 'orbit':
        hooks.selectTarget(key, { fly: false });
        setCameraMode('orbit');
        break;
      case 'track':
        hooks.selectTarget(key, { fly: false });
        setCameraMode('track');
        break;
      case 'land':
        hooks.selectTarget(key, { fly: false });
        controls.descendToSurface();
        break;
      case 'onboard':
        hooks.viewFromCraft?.(key);
        break;
      case 'info':
        hooks.selectTarget(key, { fly: false });
        togglePanel('inspector', true);
        break;
      case 'bookmark':
        addBookmark(key, resolved?.name ?? key);
        break;
      case 'parent': {
        const parent = resolved?.spec?.parent;
        if (parent) hooks.selectTarget(parent, { fly: true });
        break;
      }
      default:
        break;
    }
  }

  function setCameraMode(mode) {
    // Leaving roam has to hand the target back before anything else reads the
    // distance, since roaming leaves the camera somewhere no bearing describes.
    if (mode !== 'roam') controls.stopRoam();
    if (mode === 'orbit') {
      controls.mode = 'orbit';
      controls.trackTarget = false;
    } else if (mode === 'free') {
      controls.mode = 'fly';
      controls.trackTarget = false;
    } else if (mode === 'track') {
      controls.mode = 'fly';
      controls.trackTarget = true;
    } else if (mode === 'roam') {
      controls.trackTarget = false;
      controls.startRoam();
    }
    modeControl.set(mode);
    // Orbit has nothing for thrust to do, so the pad only exists in the modes
    // where pressing a key moves you.
    flight.setVisible(mode !== 'orbit');
    flight.setRoaming(mode === 'roam');
  }

  function currentMode() {
    if (controls.mode === 'roam') return 'roam';
    if (state.viewFromEarth) return 'orbit';
    if (controls.mode === 'fly') return controls.trackTarget ? 'track' : 'free';
    return 'orbit';
  }

  // ----------------------------------------------------------------- bookmarks

  function addBookmark(key, name) {
    const list = prefs.get('bookmarks', []).slice();
    if (list.some((b) => b.key === key)) return;
    list.push({ key, name });
    prefs.set('bookmarks', list);
    buildBookmarks();
    togglePanel('bookmarks', true);
  }

  function removeBookmark(key) {
    prefs.set('bookmarks', prefs.get('bookmarks', []).filter((b) => b.key !== key));
    buildBookmarks();
  }

  function buildBookmarks() {
    const list = prefs.get('bookmarks', []);
    reconcile(bookmarkList, list.map((b) => b.key).join('|') || 'empty', () =>
      list.length
        ? list.map((b) => el('div', { class: 'bookmark-row' }, [
            el('button', {
              type: 'button', class: 'btn is-quiet bookmark-go', text: b.name,
              onClick: () => hooks.selectTarget(b.key, { fly: true }),
            }),
            el('button', {
              type: 'button', class: 'btn is-icon is-quiet', text: '\u00d7',
              'aria-label': `Remove ${b.name}`,
              onClick: () => removeBookmark(b.key),
            }),
          ]))
        : [el('p', { class: 'obj-empty', text: 'No bookmarks yet. Bookmark an object from its menu or from search.' })],
    );
  }

  // -------------------------------------------------------------- context menu

  function openObjectMenu(x, y, key) {
    const resolved = resolveWorld(key);
    if (!resolved) return;
    const described = describeFor(key, resolved);
    const spec = resolved.spec;
    const parentKey = spec?.parent && spec.parent !== 'sun' ? spec.parent : null;
    const satellites = hooks.satellitesOf(key);

    menu.open({
      x, y,
      title: resolved.name,
      subtitle: described?.className,
      items: [
        { label: 'Go to', run: () => runAction('goto', key), shortcut: prettyChord(shortcuts.binding('nav.goto')) },
        { label: 'Orbit', run: () => runAction('orbit', key) },
        { label: 'Track', run: () => runAction('track', key) },
        { label: 'Land', run: () => runAction('land', key), disabled: resolved.kind !== 'body' },
        '-',
        { label: 'View information', run: () => runAction('info', key) },
        { label: 'Set as target', run: () => runAction('target', key) },
        { label: 'Add bookmark', run: () => runAction('bookmark', key) },
        '-',
        { label: 'Find parent', run: () => runAction('parent', key), disabled: !parentKey },
        {
          label: satellites.length ? `Find moons (${satellites.length})` : 'Find moons',
          disabled: !satellites.length,
          // Opens a second menu in place rather than a hover submenu, which is
          // fiddly to hit and needs its own timing logic.
          run: () => menu.open({
            x, y,
            title: `${resolved.name} \u00b7 satellites`,
            items: satellites.slice(0, 24).map((moon) => ({
              label: moon.name,
              run: () => hooks.selectTarget(moon.key, { fly: true }),
            })),
          }),
        },
      ],
    });
  }

  // ------------------------------------------------------------------ system

  function buildSystemTree(resolved) {
    if (!resolved) return;
    const spec = resolved.spec;
    // The system shown is the one you are in: the primary of a moon, or the body
    // itself when it has satellites of its own.
    const rootKey = spec?.parent && spec.parent !== 'sun' ? spec.parent : resolved.key;
    const rootResolved = resolveWorld(rootKey);
    const satellites = hooks.satellitesOf(rootKey);
    const signature = `${rootKey}|${state.target}|${satellites.length}`;

    reconcile(systemTree, signature, () => {
      if (!rootResolved) return [el('p', { class: 'obj-empty', text: 'No system here.' })];
      const rows = [el('button', {
        type: 'button',
        class: `btn is-quiet tree-root${state.target === rootKey ? ' is-active' : ''}`,
        text: rootResolved.name,
        onClick: () => hooks.selectTarget(rootKey, { fly: true }),
      })];
      if (!satellites.length) {
        rows.push(el('p', { class: 'obj-empty', text: 'No known satellites.' }));
        return rows;
      }
      rows.push(el('div', { class: 'tree-kids' }, satellites.slice(0, 40).map((moon) =>
        el('button', {
          type: 'button',
          class: `btn is-quiet tree-kid${state.target === moon.key ? ' is-active' : ''}`,
          onClick: () => hooks.selectTarget(moon.key, { fly: true }),
        }, [
          el('span', { class: 'tree-name', text: moon.name }),
          el('span', { class: 'tree-size', text: `${Math.round(moon.radiusKm)} km` }),
        ]))));
      return rows;
    });
  }

  // ------------------------------------------------------------------ display

  const labelLayer = createLabelLayer(labelRoot);

  function syncDisplay() {
    show(hud.root, prefs.get('hud'));
    css(reticle, 'is-hidden', !prefs.get('reticle'));
    reticle.style.display = prefs.get('reticle') ? '' : 'none';
    labelRoot.style.display = prefs.get('labels') ? '' : 'none';
    if (!prefs.get('labels')) labelLayer.clear();
  }

  // ---------------------------------------------------------------- immersive

  /**
   * @param {boolean} on
   * @param {boolean} [instant] skip the fade. Capture scripts need the interface
   *   to be provably gone by the time they take the shot, and a transition only
   *   completes if frames are being serviced — which, on a machine slow enough to
   *   be rendering this scene in software, is not something to rely on.
   */
  function setImmersive(on, instant = false) {
    if (instant) {
      css(document.body, 'no-ui-anim', true);
      // Force a style flush so the transition-free rule is in effect before the
      // state change, rather than being batched with it.
      void document.body.offsetWidth;
    }
    css(document.body, 'immersive', on);
    if (instant) {
      void document.body.offsetWidth;
      css(document.body, 'no-ui-anim', false);
    }
    if (on) {
      menu.close();
      search.close();
      for (const made of dialogs.values()) show(made.root, false);
    }
  }

  function isImmersive() {
    return document.body.classList.contains('immersive');
  }

  // ---------------------------------------------------------------- shortcuts

  function anyDialogOpen() {
    for (const made of dialogs.values()) if (!made.root.hidden) return true;
    return false;
  }

  shortcuts.register({ id: 'open.help', key: 'F1', label: 'Help and controls', group: 'Interface', run: () => toggleDialog('help') });
  shortcuts.register({ id: 'open.search', key: 'F2', label: 'Search', group: 'Interface', allowInInput: true, run: () => search.focus() });
  shortcuts.register({ id: 'open.inspector', key: 'F3', label: 'Object information', group: 'Interface', run: () => togglePanel('inspector') });
  shortcuts.register({ id: 'open.navigation', key: 'F4', label: 'Navigation panel', group: 'Interface', run: () => togglePanel('navigation') });
  shortcuts.register({ id: 'toggle.labels', key: 'F5', label: 'Object labels', group: 'Interface', run: () => { prefs.toggle('labels'); labelCheck.set(prefs.get('labels')); syncDisplay(); } });
  shortcuts.register({ id: 'open.camera', key: 'F6', label: 'Camera panel', group: 'Interface', run: () => togglePanel('camera') });
  shortcuts.register({ id: 'open.system', key: 'F7', label: 'Planetary system', group: 'Interface', run: () => togglePanel('system') });
  shortcuts.register({ id: 'open.bookmarks', key: 'F8', label: 'Bookmarks', group: 'Interface', run: () => togglePanel('bookmarks') });
  shortcuts.register({ id: 'open.display', key: 'F9', label: 'Display panel', group: 'Interface', run: () => togglePanel('display') });
  shortcuts.register({ id: 'open.settings', key: 'F10', label: 'Interface settings', group: 'Interface', run: () => toggleDialog('settings') });
  shortcuts.register({ id: 'toggle.immersive', key: 'F11', label: 'Immersive mode', group: 'Interface', allowInInput: true, run: () => setImmersive(!isImmersive()) });
  shortcuts.register({ id: 'toggle.hud', key: 'H', label: 'Bottom readouts', group: 'Interface', run: () => { prefs.toggle('hud'); hudCheck.set(prefs.get('hud')); syncDisplay(); } });

  shortcuts.register({ id: 'time.pause', key: 'Space', label: 'Pause or resume time', group: 'Simulation', run: () => { state.playing = !state.playing; timeBar.sync(); } });
  shortcuts.register({ id: 'time.faster', key: '.', label: 'Faster', group: 'Simulation', run: () => timeBar.setRateAndPlay(nextRate(1)) });
  shortcuts.register({ id: 'time.slower', key: ',', label: 'Slower or reverse', group: 'Simulation', run: () => timeBar.setRateAndPlay(nextRate(-1)) });
  shortcuts.register({ id: 'time.now', key: 'N', label: 'Jump to the present', group: 'Simulation', run: () => { hooks.setDate(new Date()); timeBar.setRateAndPlay(1); } });

  shortcuts.register({ id: 'nav.goto', key: 'G', label: 'Travel to the selection', group: 'Navigation', run: () => runAction('goto') });
  shortcuts.register({ id: 'nav.orbit', key: 'O', label: 'Orbit the selection', group: 'Navigation', run: () => runAction('orbit') });
  shortcuts.register({ id: 'nav.track', key: 'T', label: 'Track the selection', group: 'Navigation', run: () => setCameraMode(currentMode() === 'track' ? 'free' : 'track') });
  shortcuts.register({ id: 'nav.roam', key: 'R', label: 'Roam free of any target', group: 'Navigation', run: () => setCameraMode(currentMode() === 'roam' ? 'orbit' : 'roam') });
  shortcuts.register({ id: 'nav.land', key: 'L', label: 'Descend to the surface', group: 'Navigation', run: () => runAction('land') });
  shortcuts.register({ id: 'nav.bookmark', key: 'B', label: 'Bookmark the selection', group: 'Navigation', run: () => runAction('bookmark') });

  // Esc unwinds one layer at a time, topmost first, so it is always the way back
  // out of whatever is in front of you rather than a blunt close-everything.
  shortcuts.register({
    id: 'close.any', key: 'Esc', label: 'Close the topmost panel or menu', group: 'Interface', allowInInput: true,
    run: () => {
      if (!ratePopover.hidden) return show(ratePopover, false);
      if (menu.isOpen) return menu.close();
      if (search.isOpen) return search.close();
      if (anyDialogOpen()) { for (const [id] of dialogs) toggleDialog(id, false); return; }
      if (isImmersive()) return setImmersive(false);
      return undefined;
    },
  });

  function nextRate(direction) {
    const magnitude = Math.abs(state.timeRate) || 1;
    const sign = Math.sign(state.timeRate) || 1;
    return direction > 0 ? magnitude * 10 * sign : Math.max(magnitude / 10, 1) * sign;
  }

  function buildHelpKeys() {
    const groups = shortcuts.list();
    helpKeys.replaceChildren();
    for (const [group, actions] of groups) {
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
  }

  function listenForRebind(button, id) {
    css(button, 'is-listening', true);
    text(button, 'press\u2026');
    const capture = (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.removeEventListener('keydown', capture, true);
      if (event.key !== 'Escape') {
        // Chord is computed the same way dispatch computes it, so what is stored
        // is guaranteed to match what a press produces.
        const parts = [];
        if (event.ctrlKey) parts.push('Ctrl');
        if (event.metaKey) parts.push('Meta');
        if (event.altKey) parts.push('Alt');
        if (event.shiftKey) parts.push('Shift');
        let key = event.key;
        if (key === ' ') key = 'Space';
        else if (key.length === 1) key = key.toUpperCase();
        else if (key === 'Escape') key = 'Esc';
        parts.push(key);
        shortcuts.rebind(id, parts.join('+'));
      }
      buildHelpKeys();
      syncRail();
    };
    window.addEventListener('keydown', capture, true);
  }

  // --------------------------------------------------------------- custom rate

  /**
   * Custom multiplier, as a small popover anchored to the clock rather than a
   * browser prompt. A native dialog is the wrong texture for this interface, and
   * it stops the render loop while it is up.
   */
  const rateInput = el('input', {
    class: 'input',
    type: 'number',
    step: 'any',
    'aria-label': 'Simulation seconds per real second',
  });
  const ratePopover = el('div', { class: 'menu rate-popover takes-pointer', hidden: true }, [
    el('div', { class: 'menu-head' }, [
      el('div', { class: 't', text: 'Time multiplier' }),
      el('div', { class: 's', text: 'sim seconds per real second' }),
    ]),
    rateInput,
    el('p', { class: 'prose', text: 'Negative values run time backwards.' }),
  ]);
  document.body.append(ratePopover);

  function commitRate() {
    const value = Number(rateInput.value);
    show(ratePopover, false);
    if (!Number.isFinite(value)) return;
    timeBar.setRateAndPlay(value);
  }

  rateInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commitRate();
    else if (event.key === 'Escape') show(ratePopover, false);
    event.stopPropagation();
  });
  rateInput.addEventListener('blur', () => commitRate());

  function openCustomRate() {
    rateInput.value = String(state.timeRate || 1);
    show(ratePopover, true);
    const anchor = timeBar.root.getBoundingClientRect();
    const own = ratePopover.getBoundingClientRect();
    ratePopover.style.left = `${Math.max(8, Math.min(anchor.right - own.width, window.innerWidth - own.width - 8))}px`;
    ratePopover.style.top = `${anchor.bottom + 8}px`;
    rateInput.focus();
    rateInput.select();
  }

  // ------------------------------------------------------------------ picking

  controls.onContextMenu = (x, y) => {
    const key = hooks.pick(x, y);
    if (key) openObjectMenu(x, y, key);
  };

  let hoverKey = null;
  let hoverAt = { x: 0, y: 0 };
  controls.onHover = (x, y) => {
    hoverAt.x = x;
    hoverAt.y = y;
  };
  canvas.addEventListener('pointerleave', () => {
    hoverKey = null;
    show(hover, false);
  });

  // -------------------------------------------------------------------- frame

  let described = null;
  let describedKey = null;
  const lastWorld = { x: 0, y: 0, z: 0, set: false };
  let velocity = 0;
  let labelClock = 0;
  let describeClock = 0;

  function describeFor(key, resolved) {
    return describe(resolved, {
      galaxyRecord: hooks.galaxyRecord(key),
      craftRecord: resolved.kind === 'craft' ? hooks.craftRecord(key) : null,
      cameraDistanceKm: resolved.position.distanceTo(controls.worldPosition),
      sunDistanceKm: hooks.sunDistanceTo(resolved.position),
      nameOf: hooks.bodyName,
    });
  }

  /**
   * Called once per rendered frame from space.js.
   *
   * The expensive parts are on their own clocks: the label layer projects a few
   * dozen candidates six times a second, and the hover probe runs at the same
   * rate, because neither benefits from being recomputed between two frames the
   * camera has barely moved through.
   */
  function frame({ dt, resolved, fps, patches, sunDistanceKm, width, height }) {
    if (isImmersive()) {
      labelLayer.clear();
      show(hover, false);
      return;
    }

    const cameraWorld = controls.worldPosition;

    // Speed from the actual change in world position, which is the only thing
    // that accounts for orbiting, flying, cruising and a scripted flight alike.
    if (lastWorld.set && dt > 0) {
      const moved = Math.hypot(
        cameraWorld.x - lastWorld.x,
        cameraWorld.y - lastWorld.y,
        cameraWorld.z - lastWorld.z,
      );
      // Smoothed, or it is unreadable: exponential zoom changes speed by orders
      // of magnitude between consecutive frames.
      velocity = velocity * 0.9 + (moved / dt) * 0.1;
    }
    lastWorld.x = cameraWorld.x;
    lastWorld.y = cameraWorld.y;
    lastWorld.z = cameraWorld.z;
    lastWorld.set = true;

    if (prefs.get('hud')) {
      hud.set('target', resolved?.name ?? state.target);
      hud.set('distance', formatDistance(Math.max(controls.altitudeKm, 0)));
      hud.set('velocity', velocity > 1e5 ? `${(velocity / 299792.458).toFixed(2)} c` : `${velocity.toFixed(velocity < 10 ? 2 : 0)} km/s`);
      hud.set('heading', `${(((controls.yaw * 180) / Math.PI % 360) + 360) % 360 | 0}\u00b0`);
      hud.set('fov', `${controls.fov.toFixed(1)}\u00b0`);
      // AU is the readable unit across the solar system and nowhere else, so it
      // is bounded at both ends and formatDistance takes over outside them —
      // metres and kilometres on a surface, parsecs and megaparsecs once the
      // camera has left. Bounded below only, a world in another galaxy read out
      // as three and a half trillion AU, to three decimal places.
      const sunAu = sunDistanceKm / AU_KM;
      hud.set('sun', sunAu > 0.01 && sunAu < 1000
        ? `${sunAu.toFixed(3)} AU`
        : formatDistance(sunDistanceKm));
      hud.set('mode', state.viewFromEarth ? 'GROUND' : currentMode().toUpperCase());
      hud.set('fps', fps.toFixed(0));
    }

    scaleBar.update(controls.distanceKm);
    timeBar.frame();
    modeControl.set(currentMode());
    // The mode can change without the mode control being touched: thrusting
    // from orbit switches to flight, and so does F. Reconciled from the
    // controls rather than from the last button press, so the pad turns up
    // whenever thrust is live however that happened. Both calls no-op when
    // nothing has changed.
    // Roaming is thrust too, and this reconciliation used to name only 'fly' —
    // so entering roam raised the pad and the next frame took it away again.
    flight.setVisible(
      !state.viewFromEarth && (controls.mode === 'fly' || controls.mode === 'roam'),
    );
    flight.setRoaming(controls.mode === 'roam');
    flight.sync();
    if (!quality.panel.root.hidden) quality.update(hooks.qualityStats?.());

    // The inspector's numbers move; its structure does not. Rebuild the
    // description only when the selection changes or a few times a second.
    const key = state.target;
    describeClock += dt;
    if (key !== describedKey || describeClock > 0.16) {
      describeClock = 0;
      if (resolved) {
        described = describeFor(key, resolved);
        describedKey = key;
      } else {
        described = null;
        describedKey = null;
      }
    }

    if (!inspectorPanel.root.hidden) {
      inspector.render(described, key);
      inspector.setCapabilities({
        canLand: resolved?.kind === 'body',
        canFollow: Boolean(resolved),
        canRide: resolved?.kind === 'craft' && !resolved.craft?.onSurface,
        riding: hooks.isRiding?.() === resolved?.craft?.key,
      });
      inspector.setMode(currentMode());
    }

    for (const button of quickList.children) css(button, 'is-active', button.dataset.key === key);

    if (!panels.get('system').root.hidden) buildSystemTree(resolved);

    labelClock += dt;
    if (labelClock > 0.16) {
      labelClock = 0;
      if (prefs.get('labels')) {
        labelLayer.update({
          camera,
          cameraWorld,
          width,
          height,
          items: hooks.collectLabelItems(),
          targetKey: key,
          density: prefs.get('labelDensity'),
        });
      }
      // Hover probe on the same clock. Picking walks the destination list, which
      // is not something to do every frame for a decoration.
      if (hoverAt.x || hoverAt.y) {
        const hit = hooks.pick(hoverAt.x, hoverAt.y);
        hoverKey = hit;
        if (hit) {
          const hitResolved = resolveWorld(hit);
          if (hitResolved) {
            const distance = hitResolved.position.distanceTo(cameraWorld);
            const pixels = (hitResolved.radius / Math.max(distance, 1)) * (height / ((camera.fov * Math.PI) / 180));
            const size = Math.max(Math.min(pixels * 2.2, 220), 22);
            hover.style.left = `${hoverAt.x}px`;
            hover.style.top = `${hoverAt.y}px`;
            hoverBox.style.width = `${size}px`;
            hoverBox.style.height = `${size}px`;
            text(hoverName, hitResolved.name);
            show(hover, true);
          }
        } else {
          show(hover, false);
        }
      }
    }
  }

  // ---------------------------------------------------------------- lifecycle

  function syncCamera() {
    fovSlider.set(controls.fov);
    modeControl.set(currentMode());
  }

  buildHelpKeys();
  buildBookmarks();
  syncDisplay();
  syncRail();
  setCameraMode('orbit');

  /**
   * Pushes the saved options into the renderer, so there is one direction of
   * travel: preferences decide, the scene follows.
   *
   * Called by the app rather than run here, because half of what these switches
   * reach — the bloom pass, the dither pass — is built after the interface is,
   * and a checkbox restored against a post-processing chain that does not exist
   * yet fails at startup.
   */
  function applyViewPrefs() {
    for (const group of VIEW_GROUPS) {
      for (const option of group.options) {
        hooks.setView?.(option.key, prefs.get(`view.${option.key}`, option.default));
      }
    }
    hooks.setMaxRenderScale?.(prefs.get('quality.maxRenderScale', 1));
    hooks.setTargetFps?.(prefs.get('quality.targetFps', 60));
    hooks.setQualityPreset?.(prefs.get('quality.preset', 'auto'));
  }

  return {
    frame,
    syncCamera,
    applyViewPrefs,
    prefs,
    shortcuts,
    setImmersive,
    togglePanel,
    toggleDialog,
    focusSearch: () => search.focus(),
    // Called once the loading screen is out of the way, so the card is not
    // competing with a progress bar for the same middle of the screen.
    showIntroIfNew: () => intro.maybeShow(),
    setCameraMode,
    currentMode,
    runAction,
    openObjectMenu,
  };
}
