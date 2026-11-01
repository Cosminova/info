/**
 * The guided tour. Each step sets the scene, points at what to use and waits
 * for the visitor to actually do it, so the sandbox is learned by playing.
 */

const DONE_KEY = 'cosminova-sandbox-tour-done';

export class Tutorial {
  constructor(app, ui) {
    this.app = app;
    this.ui = ui;
    this.active = false;
    this.i = 0;
    this.lastImpact = 0;
    this.el = document.createElement('div');
    this.el.className = 'sb-tour';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="sb-tour-spot" hidden></div>
      <div class="sb-tour-gesture" hidden><i></i></div>
      <div class="sb-tour-card">
        <div class="sb-tour-top"><span class="sb-tour-step"></span><button class="sb-tour-x" data-tour="skip" title="End tutorial">✕</button></div>
        <h3></h3>
        <p></p>
        <div class="sb-tour-task"><i></i><span></span></div>
        <div class="sb-tour-dots"></div>
        <div class="sb-tour-actions">
          <button class="sb-tour-ghost" data-tour="skip">Skip tutorial</button>
          <button class="sb-tour-next" data-tour="next">Next</button>
        </div>
      </div>`;
    document.body.appendChild(this.el);
    this.card = this.el.querySelector('.sb-tour-card');
    this.spot = this.el.querySelector('.sb-tour-spot');
    this.gesture = this.el.querySelector('.sb-tour-gesture');
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tour]');
      if (!b) return;
      if (b.dataset.tour === 'skip') this.end(false);
      else if (b.dataset.tour === 'next') this.next();
      else if (b.dataset.tour === 'start') this.start();
      else if (b.dataset.tour === 'later') this.end(false);
    });
    this.steps = buildSteps();
  }

  /** On a first visit, invite rather than impose. */
  offer() {
    if (this.active) return;
    let done = false;
    try {
      done = localStorage.getItem(DONE_KEY) === '1';
    } catch { /* private mode */ }
    if (done) return;
    this.el.hidden = false;
    this.el.classList.add('is-offer');
    this.card.querySelector('.sb-tour-step').textContent = 'Welcome';
    this.card.querySelector('h3').textContent = 'New to the sandbox?';
    this.card.querySelector('p').textContent = 'A two-minute hands-on tour: fly the camera, bend time, throw an asteroid at Earth and melt a planet with a laser.';
    this.card.querySelector('.sb-tour-task').hidden = true;
    this.card.querySelector('.sb-tour-dots').innerHTML = '';
    this.card.querySelector('.sb-tour-actions').innerHTML = '<button class="sb-tour-ghost" data-tour="later">No thanks</button><button class="sb-tour-next" data-tour="start">Start the tour</button>';
  }

  start() {
    this.active = true;
    this.i = 0;
    this.el.hidden = false;
    this.el.classList.remove('is-offer');
    this.card.querySelector('.sb-tour-actions').innerHTML = '<button class="sb-tour-ghost" data-tour="skip">Skip tutorial</button><button class="sb-tour-next" data-tour="next">Next</button>';
    this.ui.closePops();
    this.ui.closeModals();
    this.enter();
  }

  end(completed) {
    this.active = false;
    this.el.hidden = true;
    this.el.classList.remove('is-offer');
    this.spot.hidden = true;
    this.gesture.hidden = true;
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch { /* private mode */ }
    if (completed) this.ui.notify('Tutorial complete — the universe is yours');
  }

  next() {
    if (!this.active) return;
    const s = this.steps[this.i];
    s.leave?.(this.app, this.ui, this.ctx);
    this.i++;
    if (this.i >= this.steps.length) {
      this.end(true);
      return;
    }
    this.enter();
  }

  enter() {
    const s = this.steps[this.i];
    this.ctx = { t0: performance.now(), done: false, doneAt: 0, tour: this };
    s.enter?.(this.app, this.ui, this.ctx);
    this.card.classList.remove('is-in');
    void this.card.offsetWidth;
    this.card.classList.add('is-in');
    this.card.querySelector('.sb-tour-step').textContent = `Step ${this.i + 1} of ${this.steps.length}`;
    this.card.querySelector('h3').textContent = s.title;
    this.card.querySelector('p').innerHTML = s.text;
    const task = this.card.querySelector('.sb-tour-task');
    task.hidden = !s.task;
    task.classList.remove('is-done');
    task.querySelector('span').innerHTML = s.task || '';
    this.card.querySelector('.sb-tour-dots').innerHTML = this.steps.map((_, k) => `<i class="${k < this.i ? 'is-past' : k === this.i ? 'is-now' : ''}"></i>`).join('');
    const nextBtn = this.card.querySelector('.sb-tour-next');
    nextBtn.textContent = this.i === this.steps.length - 1 ? 'Finish' : s.check ? 'Skip step' : 'Next';
    nextBtn.classList.toggle('is-soft', !!s.check);
    this.gesture.hidden = !s.gesture;
    this.gesture.dataset.kind = s.gesture || '';
  }

  /** Every frame: follow the target, and move on once the task is done. */
  update(now) {
    if (!this.active) return;
    const s = this.steps[this.i];
    const target = s.target ? [...document.querySelectorAll(s.target)].find((n) => n.getClientRects().length > 0) : null;
    if (target) {
      const r = target.getBoundingClientRect();
      const pad = 6;
      Object.assign(this.spot.style, {
        left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
      });
      this.spot.hidden = false;
    } else {
      this.spot.hidden = true;
    }
    if (s.gestureAt) {
      const p = s.gestureAt(this.app);
      if (p) {
        this.gesture.style.left = `${p[0]}px`;
        this.gesture.style.top = `${p[1]}px`;
      }
    } else {
      this.gesture.style.left = '50%';
      this.gesture.style.top = '52%';
    }
    if (s.check && !this.ctx.done && s.check(this.app, this.ui, this.ctx)) {
      this.ctx.done = true;
      this.ctx.doneAt = now;
      this.card.querySelector('.sb-tour-task').classList.add('is-done');
      this.gesture.hidden = true;
    }
    if (this.ctx.done && now - this.ctx.doneAt > (s.linger ?? 1100)) this.next();
  }

  onEvent(ev) {
    if (this.active && ev.type === 'impact' && ev.major) this.lastImpact = performance.now();
  }
}

function find(app, name) {
  return app.sim.bodies.find((b) => b.name === name && !b.dead);
}

function screenOf(app, name) {
  const b = find(app, name);
  if (!b) return null;
  const p = window.sandbox.renderer.project(b);
  return p ? [p.x, p.y] : null;
}

function buildSteps() {
  return [
    {
      title: 'A universe that runs on real physics',
      text: 'Everything here moves by gravity, step by step — orbits, collisions, melting rock, exploding stars. Nothing is scripted. This is Earth and the Moon, at their real sizes and distance.',
      enter(app) {
        app.loadPreset('earthmoon');
        app.setSpeed(3600);
        app.state.selected = null;
        const cam = app.cam;
        cam.dist = 6e9;
        app.focus(app.sim.bodies.find((b) => b.name === 'Earth')?.id);
        cam.trans.d1 = 1.1e9;
      },
    },
    {
      title: 'Look around',
      text: 'Drag anywhere in space to swing the camera around Earth. On a phone, drag with one finger.',
      task: 'Drag to rotate the view',
      gesture: 'drag',
      enter(app, ui, ctx) {
        ctx.yaw = app.cam.yaw;
        ctx.pitch = app.cam.pitch;
      },
      check: (app, ui, ctx) => Math.abs(app.cam.yaw - ctx.yaw) + Math.abs(app.cam.pitch - ctx.pitch) > 1.2,
    },
    {
      title: 'Zoom',
      text: 'Scroll, or pinch on a trackpad or phone, to move in and out. You can go from the surface of a world out to whole galaxies.',
      task: 'Zoom in close to Earth',
      gesture: 'scroll',
      enter(app, ui, ctx) {
        ctx.d = app.cam.trans?.d1 ?? app.cam.dist;
      },
      check: (app, ui, ctx) => app.cam.dist < ctx.d * 0.3,
    },
    {
      title: 'Bend time',
      text: 'Down here is the clock. The arrows change how fast time runs — from real time up to millions of years per second. The <b>,</b> and <b>.</b> keys do the same.',
      task: 'Speed time up to a day per second or more',
      target: '.sb-bar [data-act="faster"]',
      enter(app) {
        app.setSpeed(600);
        app.state.playing = true;
      },
      check: (app) => app.state.speed >= 86400 && app.state.playing,
    },
    {
      title: 'Pick something',
      text: 'Click any object to open its properties: mass, gravity, orbit, temperature and what it is made of. Everything can be edited.',
      task: 'Click the Moon',
      gesture: 'tap',
      gestureAt: (app) => screenOf(app, 'Moon'),
      enter(app) {
        app.setTool('select');
        app.setSpeed(3600);
        app.overview();
      },
      check: (app) => app.state.selected === find(app, 'Moon')?.id,
    },
    {
      title: 'The properties panel',
      text: 'This is the real Moon: 7.3×10²² kg, 1,737 km across. The Motion tab shows its orbit, and its buttons push it faster, slower or backwards.',
      task: 'Open the Motion tab',
      target: '.sb-props-tabs [data-tab="motion"]',
      check: (app, ui) => ui.tab === 'motion',
    },
    {
      title: 'Add your own objects',
      text: 'Stars, black holes, planets, moons and asteroids are all in here. Real ones, and made-up ones like lava worlds and hot Jupiters.',
      task: 'Open the Add menu',
      target: '.sb-add-btn',
      enter(app) {
        app.select(null);
      },
      check: (app, ui) => ui.open === 'add',
    },
    {
      title: 'Choose a weapon',
      text: 'Open <b>Small Bodies</b> and pick the <b>Giant Asteroid</b> — 700 km of rock. Any object works, though.',
      task: 'Choose an object to add',
      target: '#sb-add-tabs [data-cat="small"], .sb-obj[data-add="bigasteroid"]',
      check: (app) => app.state.tool === 'add',
    },
    {
      title: 'Throw it at Earth',
      text: 'Press in empty space, drag towards Earth and let go. The arrow is the velocity you are giving it. A plain click would place it gently in orbit instead.',
      task: 'Drag from space toward Earth to throw it',
      gesture: 'throw',
      gestureAt: (app) => {
        const e = screenOf(app, 'Earth');
        return e ? [e[0] - 160, e[1] - 70] : null;
      },
      enter(app, ui, ctx) {
        ctx.n = app.sim.bodies.length;
        app.setSpeed(600);
        app.state.playing = true;
        app.focus(find(app, 'Earth')?.id);
        app.cam.trans.d1 = 9e7;
      },
      check: (app, ui, ctx) => app.sim.bodies.length > ctx.n,
      linger: 600,
    },
    {
      title: 'Wait for it…',
      text: 'Collisions here follow real impact physics. The energy of the hit sets how much rock melts, how much is thrown off as debris, and whether anything survives. Time is sped up a little so you are not kept waiting.',
      task: 'Watch it hit — or skip ahead',
      enter(app) {
        app.setSpeed(Math.max(app.state.speed, 1800));
      },
      check: (app, ui, ctx) => ctx.tour.lastImpact > ctx.t0 - 2000,
      linger: 4500,
    },
    {
      title: 'The real thing: the Moon hits Earth',
      text: 'Here the Moon is on a collision course and by impact it is moving at over 10 km/s. Watch the impact site turn to lava and debris spray into space, some of it falling back and some becoming new moonlets.',
      task: 'Watch the impact',
      enter(app) {
        app.loadPreset('moonimpact');
      },
      check: (app, ui, ctx) => ctx.tour.lastImpact > ctx.t0,
      linger: 7000,
    },
    {
      title: 'Fire the laser',
      text: 'The laser pours energy into whatever it touches. Rock heats up, melts and boils off into space. Hold it long enough and the planet comes apart.',
      task: 'Pick Laser, then hold the mouse on Earth',
      target: '.sb-bar [data-tool="laser"]',
      gesture: 'hold',
      gestureAt: (app) => (app.state.tool === 'laser' ? screenOf(app, 'Earth') : null),
      enter(app, ui, ctx) {
        app.loadPreset('earthmoon');
        app.setSpeed(60);
        app.focus(find(app, 'Earth')?.id);
        app.cam.trans.d1 = 3.2e7;
        ctx.power = app.state.laserPower;
        app.state.laserPower = 1e25;
        ctx.firing = 0;
        ctx.last = performance.now();
      },
      check: (app, ui, ctx) => {
        const now = performance.now();
        if (app.state.laserFiring) ctx.firing += now - ctx.last;
        ctx.last = now;
        return ctx.firing > 2500;
      },
      leave(app, ui, ctx) {
        app.state.laserPower = ctx.power;
        app.setTool('select');
      },
      linger: 1500,
    },
    {
      title: 'Your universe now',
      text: 'Home → <b>Open simulation</b> has more: a supernova, a rogue black hole crossing the Solar System, a world torn into a ring, colliding galaxies. <b>Sim</b> changes the laws themselves — gravity, collisions, accuracy. Have fun breaking things.',
      target: '.sb-home-btn',
    },
  ];
}
