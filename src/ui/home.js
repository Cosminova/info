/**
 * The start screen: a view of somewhere, the name, and a way in.
 *
 * It is a photograph for as long as it has to be and the live scene as soon as
 * it can be. The still is there at first paint; the scene behind it is a
 * catalogue download and a surface mosaic away, and when it arrives the screen
 * dissolves into the same shot and turns slowly around it — a black hole, a
 * planet, or a horizon at dawn. Tapping stops the turn and hands the view over
 * where it stands, so the app opens on the place it was showing.
 *
 * It exists because the web version has a cold start the native apps do not.
 * Opening the app in a browser meant watching a progress bar that, on this
 * page, was never even wired up — the explorer only ever hid it, so it sat at
 * zero while catalogues and surface imagery came down — and then being dropped
 * into the middle of the solar system with the camera already moving. This
 * covers that with something worth looking at and hands over on a gesture.
 *
 * A gesture rather than a timer, and that turns out to matter for more than
 * pacing:
 *
 *   - The ambient score cannot start until the page has been interacted with;
 *     browsers refuse audio before that, which is why space.js arms it on the
 *     first pointerdown or keydown. Someone who arrived and simply watched used
 *     to get silence. Now the way in is itself that first gesture.
 *   - The first visit's welcome card used to be raised while the loading cover
 *     was still fading, so it was already sitting there before anyone had
 *     looked at the scene. It now waits for this screen to be dismissed.
 *
 * The markup is in index.html rather than built here, because this is the first
 * paint and it should not wait for a module. What this file does is decide
 * whether it applies at all, dress it, and turn it into a door.
 */
import { platform } from '../engine/platform.js';

const BASE = import.meta.env.BASE_URL ?? '/';

/** `?home=` — read once, and used by both the gate and the subject below. */
const HOME_PARAM = new URLSearchParams(window.location.search).get('home');

/**
 * The three front doors, each a still and the shot it was rendered from.
 *
 * The still comes first because it needs nothing but a decoded JPEG, and the
 * scene behind is minutes of catalogue and imagery away. Once the scene is
 * there the picture gives way to it and the same shot carries on live, turning
 * slowly. Framing them from one table is what makes that a dissolve rather
 * than a cut: `frame` here is the call `scripts/site-stills.mjs` makes for the
 * `home` group, so the photograph and the live view are the same view.
 *
 * Named rather than globbed so a half-written public/home cannot put a missing
 * file on the front door.
 */
const SUBJECTS = [
  {
    name: 'm87',
    // A black hole needs no imagery, so this one goes live almost at once.
    frame: (api) => {
      api.lookAtBlackHole('m87-star', 30);
      api.controls.fov = 38;
    },
  },
  {
    name: 'saturn',
    detail: 'saturn',
    frame: (api) => {
      api.lookFromSun('saturn', 4.2, 45, 26);
      api.controls.fov = 40;
    },
  },
  {
    name: 'earth-ground',
    detail: 'earth',
    // Standing on a world rather than orbiting one: the drift below turns the
    // heading instead of the orbit, so the horizon pans past at dawn.
    frame: (api) => api.standAt('earth', {
      sunElevationDeg: 0.6, altitudeKm: 2.5, viewElevationDeg: 7, fov: 58,
    }),
  },
];

/** Remembers only the last one shown, so a visit is not the same picture twice. */
const LAST_KEY = 'cosminova.home.last';

/**
 * How fast the view goes round, in radians a second.
 *
 * A full turn takes about four minutes. The brief was slow, and slow here has
 * a floor as well as a ceiling: below about a hundredth of a radian a second
 * the movement stops reading as movement and the screen just looks like a
 * photograph that will not sit still.
 */
const DRIFT_RATE = 0.026;

/**
 * Which subject, avoiding the one before it.
 *
 * Written straight to localStorage rather than through ui/prefs.js, which is
 * the app's store for everything else: prefs belongs to the interface and is
 * built well after this, and one string is not worth loading the interface
 * early for. Wrapped because storage throws rather than returning null in a
 * private window, and a start screen must not be what breaks the app.
 */
function pickSubject() {
  // Named in the URL, which is how the check drives all three: which one comes
  // up is otherwise a coin toss, and they do not take the same time to go live
  // — a black hole needs no imagery and a planet needs a surface mosaic.
  const asked = SUBJECTS.find((subject) => subject.name === HOME_PARAM);
  if (asked) return asked;

  let last = null;
  try {
    last = window.localStorage.getItem(LAST_KEY);
  } catch {
    last = null;
  }
  const fresh = SUBJECTS.filter((subject) => subject.name !== last);
  const chosen = fresh[Math.floor(Math.random() * fresh.length)] ?? SUBJECTS[0];
  try {
    window.localStorage.setItem(LAST_KEY, chosen.name);
  } catch {
    /* Nothing to remember it with; a repeat is not worth caring about. */
  }
  return chosen;
}

/**
 * Whether to show it at all.
 *
 * Every host that has a person in front of it does, which is the answer after
 * having it the other way round for a while: it began as the web version's
 * screen, on the reasoning that an app launched from an icon has already been
 * started once and a second door is a door in the middle of a room. That is
 * true and it was still the wrong trade. The screen is how this app introduces
 * itself, and an app whose iPhone version opens differently from its web
 * version has two front doors to keep in step rather than one.
 *
 * So the only exception left is automation. Every capture and check script in
 * scripts/ drives this page in headless Chrome, waits for
 * `window.cosminova.ready`, and then photographs or clicks the scene; a cover
 * over that would have quietly turned the store screenshots, the site stills
 * and the interaction checks into pictures of a start screen, and every one of
 * them would have gone on passing. `navigator.webdriver` is the one thing that
 * separates them from a visitor, and it is set for all of them.
 *
 * `?home=1` and `?home=0` override both ways: the first is how the check script
 * sees the screen the rule above would otherwise hide from it, and the second is
 * for linking somebody straight into the scene. `?home=<subject>` shows it with
 * one of the three named above rather than whichever the visit picked.
 */
function shouldShow() {
  if (HOME_PARAM === '0') return false;
  if (HOME_PARAM === '1') return true;
  if (SUBJECTS.some((subject) => subject.name === HOME_PARAM)) return true;
  return !navigator.webdriver;
}

export function createHome() {
  const root = document.getElementById('home');
  const started = { resolve: null };
  const whenStarted = new Promise((resolve) => {
    started.resolve = resolve;
  });

  if (!root) return { shown: false, ready: () => {}, whenStarted: Promise.resolve() };

  if (!shouldShow()) {
    root.remove();
    return { shown: false, ready: () => {}, whenStarted: Promise.resolve() };
  }

  const backdrop = document.getElementById('home-backdrop');
  const button = document.getElementById('home-start');
  const subject = pickSubject();

  // Loaded through an Image so the fade begins on a picture that is ready to be
  // shown rather than on one still arriving, which on a slow connection is the
  // difference between a photograph appearing and a photograph unrolling.
  const file = `${BASE.replace(/\/$/, '')}/home/${subject.name}.jpg`;
  const image = new Image();
  image.decoding = 'async';
  image.addEventListener('load', () => {
    backdrop.style.backgroundImage = `url("${file}")`;
    backdrop.classList.add('is-loaded');
  });
  // No error branch: the gradient underneath is a complete screen on its own,
  // and it is the one thing here that cannot fail to load.
  image.src = file;

  let open = false;
  let drift = 0;
  /* The app's surface, once the screen has gone live and hidden its interface —
     and the record that it has to be given back on the way in. */
  let hidden = null;
  /* Whether the visitor has already gone in. Read after the awaits in `goLive`,
     which can outlast the screen: somebody who taps while the surface imagery is
     still coming down would otherwise be dropped into the app and then, seconds
     later, have its interface hidden and its camera set turning by a start
     screen that is no longer on the page. */
  let gone = false;

  /**
   * Turn the live view slowly, for as long as the screen is up.
   *
   * `yaw` is the azimuth in both of the modes these shots use, so one line
   * covers both: orbiting a body it walks the camera round it, and standing on
   * one it turns the heading and pans the horizon. Driven from here on its own
   * frame callback rather than from the render loop, which should not have to
   * know that a start screen exists.
   */
  function startDrift(api) {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let previous = performance.now();
    const step = (now) => {
      if (!drift) return;
      // Clamped because a backgrounded tab hands back one enormous step, which
      // would otherwise arrive as a jump rather than as the drift it is.
      const dt = Math.min((now - previous) / 1000, 0.1);
      previous = now;
      api.controls.yaw += DRIFT_RATE * dt;
      drift = requestAnimationFrame(step);
    };
    drift = requestAnimationFrame(step);
  }

  /**
   * Swap the photograph for the scene it was rendered from.
   *
   * Wrapped, and silent when it fails. Every call inside can refuse — a body
   * whose imagery has not arrived, a `standAt` that cannot find a level spot —
   * and the still is a complete start screen on its own, so the cost of
   * failing here should be the screen not coming alive, nothing more.
   */
  async function goLive(api) {
    if (!api?.controls) return false;
    try {
      // Waited on before framing: `standAt` needs the surface to place the
      // camera against, and framing a body whose imagery is still coming down
      // would show it as a flat disc for the first few seconds.
      if (subject.detail) await api.loadDetail(subject.detail);
      // Gone in while that was arriving: the app is theirs now, and nothing
      // below is ours to do to it.
      if (gone) return false;
      if (subject.frame(api) === false) return false;
      // Anything still flying would drive yaw itself and undo the framing a
      // frame later.
      api.controls.stopFlight();
      /*
       * The interface belongs to the app, not to its front door.
       *
       * While the screen was a photograph this did not come up: the picture
       * covered the panels. A live scene behind a title put the whole thing on
       * show — rail, panels, the object card, the readout along the bottom, and
       * every galaxy label in the frame — behind the words asking the visitor
       * to start, which is both ugly and a strange thing to do to somebody who
       * has not started yet. Immersive mode is exactly this state and the app
       * already has it; `setUiVisible` is the programmatic way in, and being
       * programmatic it also keeps the mode's own "press F11" hint away.
       */
      api.setUiVisible?.(false);
      hidden = api;
      root.classList.add('is-live');
      startDrift(api);
      return true;
    } catch {
      return false;
    }
  }

  function enter() {
    if (!open) return;
    open = false;
    gone = true;
    if (drift) {
      cancelAnimationFrame(drift);
      drift = 0;
    }
    // Before the cover starts fading, so the interface is arriving as the words
    // leave rather than after them — and before `started` resolves below, which
    // is what raises the first visit's welcome card into it.
    if (hidden) {
      hidden.setUiVisible?.(true);
      hidden = null;
    }
    root.classList.add('is-going');
    /*
     * Removed a beat after the fade rather than with it. The pointer sequence
     * that got us here is still running — this fires on click, and the pointerup
     * behind it has to land on a cover that is still there. Take it away now and
     * the release goes to the canvas underneath, which reads it as a tap on
     * whatever happens to be behind the button and flies off to it.
     */
    setTimeout(() => root.remove(), 700);
    started.resolve();
  }

  /**
   * The app has finished loading. Only now is there anywhere to go, so only now
   * does the label become an invitation and the cover become clickable.
   *
   * @param {object} [api] the app's own surface, from space.js. Given one, the
   *   screen dissolves from its photograph into that view, live and turning.
   *   Without one it stays a photograph, which is what the checks that drive
   *   this page before the scene exists rely on.
   */
  function ready(api) {
    open = true;
    root.classList.add('is-ready');
    button.classList.add('is-ready');
    button.disabled = false;
    // Not awaited: the way in opens now, and the scene arrives behind it when
    // its imagery does. Somebody who taps immediately should not be made to
    // wait for a backdrop they are leaving anyway.
    goLive(api);
    // The wording the device can actually be told to do, the way the rest of
    // the interface words itself.
    button.textContent = platform.touch ? 'Tap to start' : 'Click to start';
    // So that a keyboard has the way in under its hands: the button is a real
    // one, so Enter and Space already work once it is focused.
    button.focus({ preventScroll: true });
  }

  // The button is the affordance, but the invitation says tap rather than tap
  // precisely there, so the whole cover takes it.
  root.addEventListener('click', enter);

  return { shown: true, ready, whenStarted };
}
