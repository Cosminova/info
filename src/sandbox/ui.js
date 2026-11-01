import {
  fmtMass, fmtDist, fmtSpeed, fmtDuration, fmtTemp, fmtRate, sci, G, M_SUN, L_SUN, YEAR, M_EARTH,
} from './constants.js';
import { isStar, isHole, HEAT_W, HEAT_H } from './physics.js';
import { CATEGORIES, TEMPLATES, PRESETS } from './catalog.js';
import { thumbnailUrl } from './textures.js';

const ICON = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  play: '<path d="M8 5l11 7-11 7z" fill="currentColor"/>',
  pause: '<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor"/>',
  slower: '<path d="M12 6l-7 6 7 6zM20 6l-7 6 7 6z" fill="currentColor"/>',
  faster: '<path d="M4 6l7 6-7 6zM12 6l7 6-7 6z" fill="currentColor"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  sim: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  view: '<path d="M12 4l9 5-9 5-9-5z"/><path d="M3 14l9 5 9-5"/>',
  tools: '<path d="M14.5 5.5a4 4 0 0 0-5.2 5.2L4 16v4h4l5.3-5.3a4 4 0 0 0 5.2-5.2l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  laser: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  select: '<path d="M6 3l12 9-5.5 1L15 20l-2.5 1-2.5-7L6 17z"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  delete: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  explode: '<path d="M12 2l2 6 6-2-4 5 5 4-6 0 1 6-4-5-4 5 1-6H3l5-4-4-5 6 2z"/>',
  material: '<circle cx="7" cy="17" r="2"/><circle cx="12" cy="12" r="1.6"/><circle cx="16" cy="8" r="1.3"/><circle cx="19.5" cy="4.5" r="1"/>',
  focus: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};

const icon = (name, cls = '') => `<svg class="sb-ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

const TOOLS = [
  { key: 'select', label: 'Select', hint: 'Click an object to select it. Click it again, or double-click, to focus.' },
  { key: 'add', label: 'Add', hint: 'Pick an object, then click in space to place it. Drag to throw it.' },
  { key: 'move', label: 'Move', hint: 'Drag an object to move it. Hold Shift and drag to set its velocity.' },
  { key: 'delete', label: 'Delete', hint: 'Click an object to remove it.' },
  { key: 'laser', label: 'Laser', hint: 'Hold the mouse on an object to heat it, melt it and blow it apart.' },
  { key: 'explode', label: 'Explode', hint: 'Click an object to explode it. Stars go supernova.' },
  { key: 'material', label: 'Material', hint: 'Drag in space to spray a stream of material. Longer drag, faster stream.' },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class UI {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.open = null;
    this.tab = 'overview';
    this.propsFor = null;
    this.lastSlow = 0;
    this.build();
  }

  build() {
    this.root.innerHTML = `
      <div class="sb-top">
        <button class="sb-btn sb-home-btn" data-pop="home" title="Home">${icon('menu')}</button>
        <div class="sb-brand">COSMINOVA <span>SANDBOX</span></div>
      </div>
      <div class="sb-hint" id="sb-hint"></div>
      <div class="sb-notices" id="sb-notices"></div>

      <div class="sb-pop sb-pop-home" data-for="home">
        <button class="sb-item" data-act="open">Open simulation…</button>
        <button class="sb-item" data-act="new">New (empty space)</button>
        <button class="sb-item" data-act="restart">Restart</button>
        <div class="sb-sep"></div>
        <button class="sb-item" data-act="save">Save</button>
        <button class="sb-item" data-act="loadlist">My saved sims…</button>
        <div class="sb-sep"></div>
        <button class="sb-item" data-act="tutorial">Tutorial</button>
        <button class="sb-item" data-act="help">Controls</button>
      </div>

      <div class="sb-modal" id="sb-open" hidden>
        <div class="sb-modal-card">
          <div class="sb-modal-head"><h2>Open simulation</h2><button class="sb-btn" data-act="closemodal">${icon('close')}</button></div>
          <div class="sb-sims" id="sb-sims"></div>
        </div>
      </div>
      <div class="sb-modal" id="sb-help" hidden>
        <div class="sb-modal-card sb-help-card">
          <div class="sb-modal-head"><h2>Controls</h2><button class="sb-btn" data-act="closemodal">${icon('close')}</button></div>
          <div class="sb-help">
            <div><b>Drag</b> rotate the view</div><div><b>Scroll / pinch</b> zoom</div>
            <div><b>Click</b> select · <b>click again</b> focus</div><div><b>Right-click</b> properties</div>
            <div><b>Space</b> play / pause</div><div><b>, .</b> slower / faster</div>
            <div><b>F</b> focus selected</div><div><b>Del</b> delete selected</div>
            <div><b>A</b> add · <b>M</b> move · <b>X</b> laser</div><div><b>T O L G</b> trails, orbits, labels, grid</div>
            <div><b>R</b> reverse time</div><div><b>Esc</b> back to Select</div>
          </div>
        </div>
      </div>

      <aside class="sb-props" id="sb-props" hidden></aside>

      <div class="sb-pop sb-pop-time" data-for="time">
        <div class="sb-pop-title">Time</div>
        <div class="sb-row"><span>Target speed</span><b data-k="target"></b></div>
        <div class="sb-row"><span>Actual speed</span><b data-k="actual"></b></div>
        <div class="sb-row"><span>Elapsed</span><b data-k="elapsed"></b></div>
        <div class="sb-row"><span>Time step</span><b data-k="step"></b></div>
        <div class="sb-grid2">
          <button class="sb-chip" data-act="restart">Restart</button>
          <button class="sb-chip" data-act="reverse">Reverse time</button>
          <button class="sb-chip" data-act="step">Step</button>
          <button class="sb-chip" data-act="realtime">Real time</button>
        </div>
      </div>

      <div class="sb-pop sb-pop-sim" data-for="sim">
        <div class="sb-pop-title">Simulation</div>
        <div class="sb-stats"><div><b data-k="objects">0</b><span>Objects</span></div><div><b data-k="attracting">0</b><span>Attracting</span></div><div><b data-k="frags">0</b><span>Fragments</span></div></div>
        <input class="sb-search" id="sb-search" placeholder="Search objects…" />
        <div class="sb-results" id="sb-results"></div>
        ${this.toggle('gravity', 'Gravity')}
        ${this.toggle('collide', 'Collide')}
        ${this.toggle('fragment', 'Fragment')}
        ${this.toggle('temperature', 'Temperature')}
        ${this.toggle('roche', 'Roche breakup')}
        <div class="sb-row"><span>Collisions</span>
          <select data-set="mode"><option value="realistic">Realistic</option><option value="merge">Merge</option></select></div>
        <div class="sb-row sb-slider-row"><span>Gravity strength</span><input type="range" min="-2" max="2" step="0.01" data-set="gMult" /><b data-k="gMult"></b></div>
        <div class="sb-row sb-slider-row"><span>Accuracy</span><input type="range" min="0" max="1" step="0.01" data-set="accuracy" /><b data-k="accuracy"></b></div>
        <div class="sb-row sb-slider-row"><span>Max fragments</span><input type="range" min="200" max="6000" step="100" data-set="maxFragments" /><b data-k="maxFragments"></b></div>
        <div class="sb-grid2">
          <button class="sb-chip" data-act="clearfrags">Delete fragments</button>
          <button class="sb-chip" data-act="balance">Balance momentum</button>
          <button class="sb-chip" data-act="reverseall">Reverse velocities</button>
          <button class="sb-chip" data-act="autoorbit">Orbit all</button>
        </div>
      </div>

      <div class="sb-pop sb-pop-view" data-for="view">
        <div class="sb-pop-title">View</div>
        ${this.vtoggle('labels', 'Labels')}
        ${this.vtoggle('trails', 'Trails')}
        ${this.vtoggle('orbits', 'Orbits')}
        ${this.vtoggle('grid', 'Grid')}
        ${this.vtoggle('habitable', 'Habitable zones')}
        ${this.vtoggle('markers', 'Always show objects')}
        ${this.vtoggle('bloom', 'Glow')}
        ${this.vtoggle('background', 'Milky Way background')}
        <div class="sb-row"><span>Lighting</span><select data-view="lighting"><option value="realistic">Realistic</option><option value="flat">Illuminate all</option></select></div>
        <div class="sb-grid2">
          <button class="sb-chip" data-act="overview">Camera: overview</button>
          <button class="sb-chip" data-act="clearTrails">Clear trails</button>
        </div>
      </div>

      <div class="sb-pop sb-pop-tools" data-for="tools">
        <div class="sb-pop-title">Tools</div>
        <div class="sb-tools">${TOOLS.map((t) => `<button class="sb-tool" data-tool="${t.key}">${icon(t.key)}<span>${t.label}</span></button>`).join('')}</div>
        <div class="sb-tool-opts" id="sb-tool-opts"></div>
      </div>

      <div class="sb-pop sb-pop-add" data-for="add">
        <div class="sb-tabs" id="sb-add-tabs">${CATEGORIES.map((c, i) => `<button class="sb-tab${i === 2 ? ' is-on' : ''}" data-cat="${c.key}">${c.label}</button>`).join('')}</div>
        <div class="sb-add-grid" id="sb-add-grid"></div>
        <div class="sb-add-foot">
          <label class="sb-check"><input type="checkbox" id="sb-autoorbit" checked /> Auto-orbit what it's placed near</label>
          <span class="sb-dim">Click to place · drag to throw</span>
        </div>
      </div>

      <div class="sb-bar">
        <button class="sb-btn sb-play" data-act="play" title="Play / pause (Space)">${icon('pause')}</button>
        <button class="sb-time" data-pop="time">
          <span class="sb-date" data-k="date"></span>
          <span class="sb-rate" data-k="rate"></span>
        </button>
        <button class="sb-btn" data-act="slower" title="Slower (,)">${icon('slower')}</button>
        <button class="sb-btn" data-act="faster" title="Faster (.)">${icon('faster')}</button>
        <div class="sb-bar-mid">
          <button class="sb-add-btn" data-pop="add">${icon('add')}<span>Add</span></button>
        </div>
        <div class="sb-bar-right">
          <button class="sb-labbtn" data-pop="sim">${icon('sim')}<span>Sim</span></button>
          <button class="sb-labbtn" data-pop="view">${icon('view')}<span>View</span></button>
          <button class="sb-labbtn" data-pop="tools">${icon('tools')}<span>Tools</span></button>
          <button class="sb-labbtn" data-tool="laser">${icon('laser')}<span>Laser</span></button>
        </div>
      </div>
    `;
    this.q = (s) => this.root.querySelector(s);
    this.props = this.q('#sb-props');
    this.renderAddGrid('planet');
    this.renderSims();
    this.bind();
  }

  toggle(key, label) {
    return `<label class="sb-row sb-toggle"><span>${label}</span><input type="checkbox" data-set="${key}" /><i></i></label>`;
  }

  vtoggle(key, label) {
    return `<label class="sb-row sb-toggle"><span>${label}</span><input type="checkbox" data-view="${key}" /><i></i></label>`;
  }

  renderSims() {
    this.q('#sb-sims').innerHTML = PRESETS.map((p) => `
      <button class="sb-sim" data-preset="${p.key}">
        <b>${esc(p.name)}</b><span>${esc(p.desc)}</span>
      </button>`).join('');
  }

  renderAddGrid(cat) {
    const items = TEMPLATES.filter((t) => t.cat === cat);
    this.q('#sb-add-grid').innerHTML = items.map((t) => {
      const url = thumbnailUrl(t);
      const bg = url ? `background-image:url('${url}')` : `background:${thumbColor(t)}`;
      return `<button class="sb-obj${this.app.state.addKey === t.key ? ' is-on' : ''}" data-add="${t.key}" title="${esc(t.desc || t.name)}">
        <i class="sb-ball sb-ball-${t.kind || t.cat}" style="${bg}"></i><span>${esc(t.name)}</span></button>`;
    }).join('');
  }

  bind() {
    const app = this.app;
    this.root.addEventListener('click', (e) => {
      const t = e.target.closest('button, [data-preset]');
      if (!t) return;
      if (t.dataset.pop) {
        this.togglePop(t.dataset.pop);
        return;
      }
      if (t.dataset.tool) {
        app.setTool(t.dataset.tool, true);
        if (t.closest('.sb-bar')) this.closePops();
        return;
      }
      if (t.dataset.cat) {
        this.root.querySelectorAll('#sb-add-tabs .sb-tab').forEach((b) => b.classList.toggle('is-on', b === t));
        this.renderAddGrid(t.dataset.cat);
        return;
      }
      if (t.dataset.add) {
        app.state.addKey = t.dataset.add;
        app.setTool('add');
        this.root.querySelectorAll('.sb-obj').forEach((b) => b.classList.toggle('is-on', b === t));
        this.closePops();
        return;
      }
      if (t.dataset.preset) {
        this.closeModals();
        app.loadPreset(t.dataset.preset);
        return;
      }
      if (t.dataset.tab) {
        this.tab = t.dataset.tab;
        this.propsFor = null;
        this.refreshProps(true);
        return;
      }
      if (t.dataset.load) {
        this.closeModals();
        app.loadSaved(t.dataset.load);
        return;
      }
      if (t.dataset.focus) {
        app.select(Number(t.dataset.focus));
        app.focus(Number(t.dataset.focus));
        return;
      }
      const act = t.dataset.act;
      if (act) this.action(act, t);
    });

    this.root.addEventListener('input', (e) => {
      const el = e.target;
      if (el.dataset.set) app.setSetting(el.dataset.set, el);
      if (el.dataset.view) {
        app.state.view[el.dataset.view] = el.type === 'checkbox' ? el.checked : el.value;
      }
      if (el.dataset.prop) app.setProp(el.dataset.prop, el);
      if (el.dataset.opt) app.setOpt(el.dataset.opt, el);
      if (el.id === 'sb-search') this.renderSearch();
      if (el.id === 'sb-autoorbit') app.state.autoOrbit = el.checked;
    });
    this.root.addEventListener('change', (e) => {
      const el = e.target;
      if (el.dataset.prop === 'name') app.setProp('name', el);
    });
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.root.addEventListener('wheel', (e) => {
      if (e.target.closest('.sb-pop, .sb-props, .sb-modal')) e.stopPropagation();
    }, { passive: true });
  }

  action(act, el) {
    const app = this.app;
    switch (act) {
      case 'play': app.togglePlay(); break;
      case 'slower': app.changeSpeed(-1); break;
      case 'faster': app.changeSpeed(1); break;
      case 'open': this.closePops(); this.q('#sb-open').hidden = false; this.q('#sb-open h2').textContent = 'Open simulation'; this.renderSims(); break;
      case 'new': this.closePops(); app.loadPreset('empty'); break;
      case 'restart': this.closePops(); app.restart(); break;
      case 'save': this.closePops(); app.save(); break;
      case 'loadlist': this.closePops(); this.showSaved(); break;
      case 'help': this.closePops(); this.q('#sb-help').hidden = false; break;
      case 'tutorial': this.closePops(); app.startTutorial(); break;
      case 'closemodal': this.closeModals(); break;
      case 'reverse': app.toggleReverse(); break;
      case 'step': app.step(); break;
      case 'realtime': app.setSpeed(1); break;
      case 'clearfrags': app.clearFragments(); break;
      case 'balance': app.balance(); break;
      case 'reverseall': app.reverseAll(); break;
      case 'autoorbit': app.orbitAll(); break;
      case 'overview': app.overview(); break;
      case 'clearTrails': app.state.resetTrails = true; break;
      case 'p-focus': app.focus(app.state.selected); break;
      case 'p-explode': app.explodeSelected(); break;
      case 'p-delete': app.deleteSelected(); break;
      case 'p-close': app.select(null); break;
      case 'p-circ': app.motion('circularize'); break;
      case 'p-stop': app.motion('stop'); break;
      case 'p-reverse': app.motion('reverse'); break;
      case 'p-faster': app.motion('faster'); break;
      case 'p-slower': app.motion('slower'); break;
      case 'p-atmo': app.motion('atmo'); break;
      case 'p-supernova': app.explodeSelected(); break;
      default: void el;
    }
  }

  showSaved() {
    const list = this.app.savedList();
    const box = this.q('#sb-sims');
    this.q('#sb-open h2').textContent = 'My saved sims';
    box.innerHTML = list.length
      ? list.map((s) => `<button class="sb-sim" data-load="${esc(s.key)}"><b>${esc(s.name)}</b><span>${esc(s.when)} · ${s.count} objects</span></button>`).join('')
      : '<p class="sb-dim">Nothing saved yet. Use Home → Save.</p>';
    this.q('#sb-open').hidden = false;
  }

  closeModals() {
    this.root.querySelectorAll('.sb-modal').forEach((m) => { m.hidden = true; });
  }

  togglePop(name) {
    if (this.open === name) {
      this.closePops();
      return;
    }
    this.closePops();
    this.open = name;
    const pop = this.root.querySelector(`.sb-pop[data-for="${name}"]`);
    pop?.classList.add('is-open');
    this.root.querySelectorAll(`[data-pop="${name}"]`).forEach((b) => b.classList.add('is-on'));
    if (name === 'sim') {
      this.syncSettings();
      this.renderSearch();
    }
    if (name === 'view') this.syncView();
    if (name === 'tools') this.renderToolOpts();
  }

  closePops() {
    this.open = null;
    this.root.querySelectorAll('.sb-pop.is-open').forEach((p) => p.classList.remove('is-open'));
    this.root.querySelectorAll('[data-pop].is-on').forEach((b) => b.classList.remove('is-on'));
  }

  syncSettings() {
    const s = this.app.sim.settings;
    this.root.querySelectorAll('[data-set]').forEach((el) => {
      const k = el.dataset.set;
      if (el.type === 'checkbox') el.checked = !!s[k];
      else if (k === 'gMult') el.value = Math.log10(s.gMult);
      else if (k === 'accuracy') el.value = accuracyToSlider(s.accuracy);
      else el.value = s[k];
    });
    this.setText('gMult', `${sci(s.gMult)}×`);
    this.setText('accuracy', `${Math.round(accuracyToSlider(s.accuracy) * 100)}%`);
    this.setText('maxFragments', String(s.maxFragments));
  }

  syncView() {
    const v = this.app.state.view;
    this.root.querySelectorAll('[data-view]').forEach((el) => {
      if (el.type === 'checkbox') el.checked = !!v[el.dataset.view];
      else el.value = v[el.dataset.view];
    });
  }

  renderSearch() {
    const qv = (this.q('#sb-search').value || '').toLowerCase();
    const list = this.app.sim.majors.filter((b) => !qv || b.name.toLowerCase().includes(qv)).slice(0, 40);
    this.q('#sb-results').innerHTML = list.map((b) => `<button class="sb-result" data-focus="${b.id}"><i style="background:${cssColor(b.color)}"></i>${esc(b.name)}<span>${kindLabel(b)}</span></button>`).join('');
  }

  renderToolOpts() {
    const st = this.app.state;
    const box = this.q('#sb-tool-opts');
    const tool = TOOLS.find((t) => t.key === st.tool);
    let extra = '';
    if (st.tool === 'laser') {
      extra = `<div class="sb-row sb-slider-row"><span>Power</span><input type="range" min="15" max="34" step="0.1" value="${Math.log10(st.laserPower)}" data-opt="laserPower" /><b data-k="laserPower">${sci(st.laserPower)} W</b></div>`;
    } else if (st.tool === 'material') {
      extra = `<div class="sb-row"><span>Material</span><select data-opt="material">${['rock', 'iron', 'water', 'ice'].map((m) => `<option ${st.material === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        <div class="sb-row sb-slider-row"><span>Particle mass</span><input type="range" min="12" max="22" step="0.1" value="${Math.log10(st.materialMass)}" data-opt="materialMass" /><b data-k="materialMass">${sci(st.materialMass)} kg</b></div>`;
    } else if (st.tool === 'explode') {
      extra = `<div class="sb-row sb-slider-row"><span>Strength</span><input type="range" min="1.1" max="20" step="0.1" value="${st.explodeFactor}" data-opt="explodeFactor" /><b data-k="explodeFactor">${st.explodeFactor.toFixed(1)}× binding</b></div>`;
    }
    box.innerHTML = `<p class="sb-dim">${tool ? tool.hint : ''}</p>${extra}`;
    this.root.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('is-on', b.dataset.tool === st.tool));
  }

  hint(text) {
    const el = this.q('#sb-hint');
    el.textContent = text || '';
    el.classList.toggle('is-on', !!text);
  }

  notify(text) {
    const box = this.q('#sb-notices');
    const el = document.createElement('div');
    el.className = 'sb-notice';
    el.textContent = text;
    box.prepend(el);
    while (box.children.length > 4) box.lastChild.remove();
    setTimeout(() => el.classList.add('is-going'), 4200);
    setTimeout(() => el.remove(), 4800);
  }

  setText(k, text, scope = this.root) {
    scope.querySelectorAll(`[data-k="${k}"]`).forEach((el) => {
      if (el.textContent !== text) el.textContent = text;
    });
  }

  /** Called every frame; the heavy parts run a few times a second. */
  update(now) {
    const app = this.app;
    const st = app.state;
    this.setText('date', app.dateLabel());
    this.setText('rate', `${st.playing ? '' : 'Paused · '}${fmtRate(st.speed * (st.reverse ? -1 : 1))}`);
    this.q('.sb-rate').classList.toggle('is-limited', st.playing && st.limited);
    const play = this.q('.sb-play');
    const want = st.playing ? 'pause' : 'play';
    if (play.dataset.icon !== want) {
      play.dataset.icon = want;
      play.innerHTML = icon(want);
    }
    if (now - this.lastSlow < 250) return;
    this.lastSlow = now;
    const sim = app.sim;
    if (this.open === 'time') {
      this.setText('target', fmtRate(st.speed * (st.reverse ? -1 : 1)));
      this.setText('actual', fmtRate(st.actualRate));
      this.setText('elapsed', fmtDuration(Math.abs(sim.time)));
      this.setText('step', `${fmtDuration(sim.maxDt)} × ${sim.lastSteps}`);
    }
    if (this.open === 'sim') {
      this.setText('objects', String(sim.bodies.length));
      this.setText('attracting', String(sim.bodies.length));
      this.setText('frags', String(sim.minors.length));
    }
    this.refreshProps(false);
  }

  // ---------------------------------------------------------------------------
  // Properties panel

  refreshProps(force) {
    const app = this.app;
    const b = app.state.selected ? app.sim.byId(app.state.selected) : null;
    if (!b || !app.state.propsOpen) {
      if (!this.props.hidden) this.props.hidden = true;
      this.propsFor = null;
      return;
    }
    this.props.hidden = false;
    const sig = `${b.id}:${this.tab}:${b.kind}:${b.minor}:${!!b.atmo}`;
    if (force || this.propsFor !== sig) {
      this.propsFor = sig;
      this.props.innerHTML = this.propsHTML(b);
    }
    this.propsValues(b);
  }

  propsHTML(b) {
    const star = isStar(b);
    const hole = isHole(b);
    const tabs = [['overview', 'Overview'], ['motion', 'Motion']];
    if (!hole) tabs.push(['temp', 'Temperature']);
    if (!star && !hole) tabs.push(['comp', 'Composition']);
    if (!tabs.some(([k]) => k === this.tab)) this.tab = 'overview';
    const row = (label, k) => `<div class="sb-row"><span>${label}</span><b data-k="${k}"></b></div>`;
    const slider = (label, k, min, max, step = 0.01) => `<div class="sb-prop-slider"><div class="sb-row"><span>${label}</span><b data-k="${k}"></b></div><input type="range" min="${min}" max="${max}" step="${step}" data-prop="${k}" /></div>`;
    let body = '';
    if (this.tab === 'overview') {
      body += slider('Mass', 'mass', 8, 42);
      if (!hole) body += slider('Radius', 'radius', 0, 13);
      else body += row('Event horizon', 'radius');
      body += row('Density', 'density');
      if (!hole) body += row('Surface gravity', 'gravity');
      body += row('Escape velocity', 'vesc');
      if (star) body += row('Luminosity', 'lum') + row('Surface temperature', 'stemp') + row('Type', 'stype');
      if (hole) body += row('Mass in Suns', 'msun');
    } else if (this.tab === 'motion') {
      body += row('Orbiting', 'parent') + row('Distance', 'pdist') + row('Speed', 'pspeed') + row('Orbital period', 'period')
        + row('Semi-major axis', 'sma') + row('Eccentricity', 'ecc') + row('Inclination', 'incl') + row('Speed (absolute)', 'aspeed');
      body += `<div class="sb-grid2">
        <button class="sb-chip" data-act="p-circ">Circular orbit</button>
        <button class="sb-chip" data-act="p-stop">Stop relative</button>
        <button class="sb-chip" data-act="p-faster">+10% speed</button>
        <button class="sb-chip" data-act="p-slower">−10% speed</button>
        <button class="sb-chip" data-act="p-reverse">Reverse direction</button>
      </div>`;
    } else if (this.tab === 'temp') {
      if (!star) body += slider('Surface temperature', 'temp', 0, 4000, 1);
      else body += row('Surface temperature', 'temp');
      body += row('Hottest point', 'tmax') + row('From starlight', 'teq') + row('Surface state', 'state');
      if (!star) body += `<div class="sb-heatbar"><canvas width="${HEAT_W}" height="${HEAT_H}" id="sb-heatmap"></canvas><span>Surface heat map</span></div>`;
    } else if (this.tab === 'comp') {
      body += ['iron', 'rock', 'water', 'gas'].map((k) => `<div class="sb-bar-row"><span>${k[0].toUpperCase() + k.slice(1)}</span><div class="sb-meter"><i class="m-${k}" data-meter="${k}"></i></div><b data-k="c-${k}"></b></div>`).join('');
      body += row('Atmosphere', 'atmo') + row('Rings', 'rings');
      if (b.atmo) body += '<div class="sb-grid2"><button class="sb-chip" data-act="p-atmo">Strip atmosphere</button></div>';
    }
    return `
      <div class="sb-props-head">
        <i class="sb-swatch" style="background:${cssColor(b.color)}"></i>
        <input class="sb-name" data-prop="name" value="${esc(b.name)}" spellcheck="false" />
        <button class="sb-btn" data-act="p-close" title="Close">${icon('close')}</button>
      </div>
      <div class="sb-kind" data-k="kind"></div>
      <div class="sb-props-actions">
        <button class="sb-chip" data-act="p-focus">${icon('focus')} Focus</button>
        ${hole ? '' : `<button class="sb-chip sb-danger" data-act="p-explode">${icon('explode')} ${star ? 'Supernova' : 'Explode'}</button>`}
        <button class="sb-chip" data-act="p-delete">${icon('delete')} Delete</button>
      </div>
      <div class="sb-tabs sb-props-tabs">${tabs.map(([k, l]) => `<button class="sb-tab${k === this.tab ? ' is-on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
      <div class="sb-props-body">${body}</div>`;
  }

  propsValues(b) {
    const P = this.props;
    const sim = this.app.sim;
    const set = (k, v) => this.setText(k, v, P);
    const slide = (k, v) => {
      const el = P.querySelector(`input[data-prop="${k}"]`);
      if (el && document.activeElement !== el && !el.matches(':active')) el.value = v;
    };
    set('kind', kindLabel(b));
    if (this.tab === 'overview') {
      set('mass', `${fmtMass(b.mass)}${b.mass < 0.01 * M_SUN ? '' : ''} · ${sci(b.mass)} kg`);
      slide('mass', Math.log10(b.mass));
      set('radius', fmtDist(b.radius));
      slide('radius', Math.log10(b.radius));
      const rho = b.mass / ((4 / 3) * Math.PI * b.radius ** 3);
      set('density', rho > 1e6 ? `${sci(rho)} kg/m³` : `${sci(rho / 1000)} g/cm³`);
      const g = (G * b.mass) / (b.radius * b.radius);
      set('gravity', `${sci(g)} m/s² (${sci(g / 9.81)} g)`);
      set('vesc', fmtSpeed(Math.sqrt((2 * G * b.mass) / b.radius)));
      if (isStar(b)) {
        set('lum', `${sci(b.lum / L_SUN)} L☉`);
        set('stemp', `${Math.round(b.temp).toLocaleString()} K`);
        set('stype', starType(b));
      }
      if (isHole(b)) set('msun', `${sci(b.mass / M_SUN)}`);
    } else if (this.tab === 'motion') {
      const el = sim.orbitalElements(b);
      if (el) {
        set('parent', el.parent.name);
        set('pdist', fmtDist(el.r));
        set('pspeed', fmtSpeed(el.speed));
        set('period', el.bound ? fmtDuration(el.period) : 'escaping');
        set('sma', el.bound ? fmtDist(el.a) : '—');
        set('ecc', el.e.toFixed(4));
        set('incl', `${(el.incl * 180 / Math.PI).toFixed(2)}°`);
      } else {
        ['parent', 'pdist', 'pspeed', 'period', 'sma', 'ecc', 'incl'].forEach((k) => set(k, '—'));
      }
      set('aspeed', fmtSpeed(Math.hypot(b.vx, b.vy, b.vz)));
    } else if (this.tab === 'temp') {
      set('temp', fmtTemp(b.temp));
      slide('temp', b.temp);
      let tmax = b.temp;
      if (b.heat) for (let k = 0; k < b.heat.length; k++) if (b.heat[k] > tmax) tmax = b.heat[k];
      set('tmax', fmtTemp(tmax));
      set('teq', b.teq ? fmtTemp(b.teq) : '—');
      set('state', surfaceState(b, tmax));
      const cv = P.querySelector('#sb-heatmap');
      if (cv && b.heat) drawHeat(cv, b.heat);
    } else if (this.tab === 'comp') {
      for (const k of ['iron', 'rock', 'water', 'gas']) {
        const v = b.comp[k] || 0;
        set(`c-${k}`, `${(v * 100).toFixed(1)}%`);
        const m = P.querySelector(`[data-meter="${k}"]`);
        if (m) m.style.width = `${v * 100}%`;
      }
      set('atmo', b.atmo ? 'Yes' : 'None');
      set('rings', b.rings ? 'Yes' : 'None');
    }
  }
}

export function accuracyToSlider(a) {
  // 0.1 (fast, rough) .. 0.002 (slow, precise), log scale.
  return (Math.log10(0.1) - Math.log10(a)) / (Math.log10(0.1) - Math.log10(0.002));
}

export function sliderToAccuracy(s) {
  return Math.pow(10, Math.log10(0.1) - s * (Math.log10(0.1) - Math.log10(0.002)));
}

function cssColor(c) {
  return `rgb(${Math.round(Math.min(1, c[0] * 1.2) * 255)},${Math.round(Math.min(1, c[1] * 1.2) * 255)},${Math.round(Math.min(1, c[2] * 1.2) * 255)})`;
}

function thumbColor(t) {
  if (t.kind === 'blackhole') return 'radial-gradient(circle at 50% 50%, #000 38%, #ffd7a8 44%, #3a2414 60%, #000 72%)';
  return `radial-gradient(circle at 35% 35%, #fff, ${cssColor(t.color)} 45%, #222 100%)`;
}

export function kindLabel(b) {
  if (b.minor) return b.kind === 'plasma' ? 'Supernova ejecta' : b.kind === 'starp' ? 'Star' : 'Fragment';
  switch (b.kind) {
    case 'star': return 'Main-sequence star';
    case 'giant': return 'Giant star';
    case 'whitedwarf': return 'White dwarf';
    case 'neutron': return 'Neutron star';
    case 'blackhole': return 'Black hole';
    case 'moon': return 'Moon';
    case 'asteroid': return 'Small body';
    default: return b.mass > 50 * M_EARTH ? 'Gas giant' : 'Planet';
  }
}

function starType(b) {
  if (b.kind !== 'star') return kindLabel(b);
  const T = b.temp;
  const cls = T > 30000 ? 'O' : T > 10000 ? 'B' : T > 7500 ? 'A' : T > 6000 ? 'F' : T > 5200 ? 'G' : T > 3700 ? 'K' : 'M';
  return `${cls}-type main sequence`;
}

function surfaceState(b, tmax) {
  if (isStar(b)) return 'Plasma';
  const T = b.temp;
  if (tmax > 2500) return 'Molten, rock vaporising';
  if (tmax > 1400) return T > 1400 ? 'Global magma ocean' : 'Molten in places';
  if (b.comp.gas > 0.5) return 'Gas envelope';
  if (T > 373 && b.comp.water > 0.001) return 'Too hot for liquid water';
  if (T >= 273 && T <= 373 && b.comp.water > 0.001) return 'Liquid water possible';
  if (T < 273 && b.comp.water > 0.001) return 'Frozen';
  return 'Solid rock';
}

function drawHeat(cv, heat) {
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(HEAT_W, HEAT_H);
  for (let j = 0; j < HEAT_H; j++) {
    for (let i = 0; i < HEAT_W; i++) {
      const T = heat[(HEAT_H - 1 - j) * HEAT_W + i];
      const t = Math.min(1, Math.max(0, (T - 100) / 3000));
      const k = (j * HEAT_W + i) * 4;
      img.data[k] = 255 * Math.min(1, t * 2.2);
      img.data[k + 1] = 255 * Math.max(0, Math.min(1, t * 2.2 - 0.9));
      img.data[k + 2] = 255 * Math.max(0.15 - t, 0) * 5 + 255 * Math.max(0, t * 3 - 2.4);
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export { YEAR };
