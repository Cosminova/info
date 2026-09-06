/**
 * The start screen: a photograph, the name, and a way in.
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

/**
 * Rendered by `node scripts/site-stills.mjs home`, which is also where the
 * reasoning about the three lives. Named rather than globbed so a half-written
 * public/home cannot put a missing file on the front door.
 */
const BACKDROPS = ['m87', 'saturn', 'earth-ground'];

/** Remembers only the last one shown, so a visit is not the same picture twice. */
const LAST_KEY = 'cosminova.home.last';

/**
 * Which backdrop, avoiding the one before it.
 *
 * Written straight to localStorage rather than through ui/prefs.js, which is
 * the app's store for everything else: prefs belongs to the interface and is
 * built well after this, and one string is not worth loading the interface
 * early for. Wrapped because storage throws rather than returning null in a
 * private window, and a start screen must not be what breaks the app.
 */
function pickBackdrop() {
  let last = null;
  try {
    last = window.localStorage.getItem(LAST_KEY);
  } catch {
    last = null;
  }
  const fresh = BACKDROPS.filter((name) => name !== last);
  const chosen = fresh[Math.floor(Math.random() * fresh.length)] ?? BACKDROPS[0];
  try {
    window.localStorage.setItem(LAST_KEY, chosen);
  } catch {
    /* Nothing to remember it with; a repeat is not worth caring about. */
  }
  return chosen;
}

/**
 * Whether to show it at all.
 *
 * Three answers, in order of who is asking:
 *
 *   `?home=1` / `?home=0` — an explicit request, honoured either way. The check
 *   script uses the first to see the screen the automation rule below would
 *   otherwise have hidden from it.
 *
 *   Automation — every capture and check script in scripts/ drives this page in
 *   headless Chrome, waits for `window.cosminova.ready`, and then photographs
 *   or clicks the scene. A cover over that would have quietly turned the store
 *   screenshots, the site stills and the interaction checks into pictures of a
 *   start screen. `navigator.webdriver` is the one thing that separates them
 *   from a visitor, and it is set for all of them.
 *
 *   The host — the iOS and macOS apps launched from an icon and have their own
 *   launch screen; asking them to be started again is a door in the middle of a
 *   room. This is the web version's screen only.
 */
function shouldShow() {
  const asked = new URLSearchParams(window.location.search).get('home');
  if (asked === '1') return true;
  if (asked === '0') return false;
  if (navigator.webdriver) return false;
  return platform.shell === 'web';
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

  // Loaded through an Image so the fade begins on a picture that is ready to be
  // shown rather than on one still arriving, which on a slow connection is the
  // difference between a photograph appearing and a photograph unrolling.
  const file = `${BASE.replace(/\/$/, '')}/home/${pickBackdrop()}.jpg`;
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

  function enter() {
    if (!open) return;
    open = false;
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
   */
  function ready() {
    open = true;
    root.classList.add('is-ready');
    button.classList.add('is-ready');
    button.disabled = false;
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
