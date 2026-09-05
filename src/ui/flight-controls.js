/**
 * On-screen controls for free flight.
 *
 * Free flight worked long before this existed, but nothing on screen said so:
 * choosing the Free camera mode changed how the camera would behave and then
 * sat there, because the movement is on keys and the keys were only mentioned
 * in a tooltip. Someone who clicked Free and pressed nothing concluded, quite
 * reasonably, that the mode did nothing.
 *
 * So the pad is a teaching device as much as a control. The buttons are laid
 * out the way the keys sit on the keyboard — Q W E over A S D — and each one is
 * labelled with its key rather than an arrow, so using the mouse shows you
 * where to put your left hand. Nothing here moves the camera directly; the
 * buttons press the same inputs the keyboard does, so there is one movement
 * path and the pad cannot drift out of step with the keys it is advertising.
 */
import { el, css, text } from './dom.js';

/**
 * Mirrors the physical key positions. `code` is what gets pressed on the
 * controls; `tip` is what the button claims to do, and has to keep agreeing
 * with _applyKeys in camera-controls.js.
 */
const PAD = [
  { code: 'KeyQ', label: 'Q', tip: 'Descend' },
  { code: 'KeyW', label: 'W', tip: 'Thrust forward' },
  { code: 'KeyE', label: 'E', tip: 'Climb' },
  { code: 'KeyA', label: 'A', tip: 'Slide left' },
  { code: 'KeyS', label: 'S', tip: 'Thrust back' },
  { code: 'KeyD', label: 'D', tip: 'Slide right' },
];

/** The flySpeed range the slider spans, as a multiplier on altitude per second. */
const SPEED_MIN = 0.1;
const SPEED_MAX = 4;

export function createFlightControls({ controls, prefs }) {
  const buttons = [];

  /**
   * A button that holds its input down while it is held down.
   *
   * Pointer capture is what makes this reliable: without it, dragging off the
   * button loses the pointerup and the input stays pressed, which is the stuck
   * -thrust bug in miniature. Space and Enter are handled separately because a
   * button reached by keyboard fires click, not pointerdown, and a movement
   * control that only responds to a mouse is a poor trade for one that was
   * already on the keyboard.
   */
  function holdButton({ code, label, tip }) {
    const node = el('button', {
      type: 'button',
      class: 'flight-key',
      text: label,
      'data-tip': `${tip} (${label})`,
      'aria-label': tip,
    });

    const press = (on) => {
      controls.setInput(code, on);
      css(node, 'is-down', on);
    };

    node.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      node.setPointerCapture?.(event.pointerId);
      press(true);
    });
    for (const type of ['pointerup', 'pointercancel']) {
      node.addEventListener(type, () => press(false));
    }
    // Losing focus mid-hold leaves nothing to release the input.
    node.addEventListener('blur', () => press(false));
    node.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        press(true);
      }
    });
    node.addEventListener('keyup', (event) => {
      if (event.key === ' ' || event.key === 'Enter') press(false);
    });

    buttons.push({ code, node, press });
    return node;
  }

  const pad = el('div', { class: 'flight-pad' }, PAD.map(holdButton));

  // Boost latches rather than being held: it is a multiplier you fly under for
  // a while, not a nudge, and holding two things at once on a touchscreen is
  // awkward.
  const boost = el('button', {
    type: 'button',
    class: 'flight-boost',
    text: 'Boost',
    'data-tip': 'Fly four times faster (hold Shift)',
    'aria-pressed': 'false',
    onClick: () => {
      const on = boost.getAttribute('aria-pressed') !== 'true';
      boost.setAttribute('aria-pressed', String(on));
      css(boost, 'is-active', on);
      controls.setInput('ShiftLeft', on);
    },
  });

  const speedValue = el('span', { class: 'flight-speed-value' });
  const speed = el('input', {
    type: 'range',
    class: 'flight-speed-range',
    min: String(SPEED_MIN),
    max: String(SPEED_MAX),
    step: '0.05',
    'aria-label': 'Flight speed',
    'data-tip': 'How fast thrust moves you, relative to your altitude',
    onInput: () => {
      const value = Number(speed.value);
      controls.flySpeed = value;
      prefs.set('flight.speed', value);
      text(speedValue, `${value.toFixed(2)}\u00d7`);
    },
  });

  // Restored before first paint so the slider and the controls agree from the
  // start rather than after the first drag.
  const saved = Number(prefs.get('flight.speed', controls.flySpeed));
  const initial = Number.isFinite(saved) ? Math.min(Math.max(saved, SPEED_MIN), SPEED_MAX) : controls.flySpeed;
  controls.flySpeed = initial;
  speed.value = String(initial);
  text(speedValue, `${initial.toFixed(2)}\u00d7`);

  const root = el('div', { class: 'flight takes-pointer', hidden: true }, [
    el('div', { class: 'flight-row' }, [
      pad,
      el('div', { class: 'flight-side' }, [
        boost,
        el('div', { class: 'flight-speed' }, [
          el('span', { class: 'flight-speed-label', text: 'Speed' }),
          speed,
          speedValue,
        ]),
      ]),
    ]),
    /*
     * The keycaps teach where to put your hand but not what each key does, and
     * steering is not on a key at all — so the line under them carries both.
     * This is the sentence that was missing: everything here was already
     * possible, and nothing on screen said so.
     */
    el('div', {
      class: 'flight-hint',
      text: 'Thrust W/S \u00b7 slide A/D \u00b7 climb E, dive Q \u00b7 drag to steer',
    }),
  ]);

  let visible = false;

  return {
    root,

    /**
     * Shown only in the modes where thrust does anything. Every input is
     * released on the way out: a button held down as the pad disappears would
     * otherwise leave the camera thrusting with nothing on screen to stop it.
     */
    setVisible(on) {
      if (on === visible) return;
      visible = on;
      root.hidden = !on;
      // The scale bar is fixed to the bottom centre, which is where the pad
      // appears; the class lifts it clear rather than letting the two overlap.
      document.body.classList.toggle('is-flying', on);
      if (on) {
        // Restarts the arrival animation, so switching into the mode draws the
        // eye to the controls that just appeared.
        root.classList.remove('is-entering');
        void root.offsetWidth;
        root.classList.add('is-entering');
      } else {
        for (const button of buttons) button.press(false);
        boost.setAttribute('aria-pressed', 'false');
        css(boost, 'is-active', false);
        controls.setInput('ShiftLeft', false);
      }
    },

    /** Reflects keyboard presses on the pad, so the two never look unrelated. */
    sync() {
      if (!visible) return;
      for (const button of buttons) {
        css(button.node, 'is-down', controls.isInputDown?.(button.code) ?? false);
      }
    },
  };
}
