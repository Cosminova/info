/**
 * The card shown once, on a first visit.
 *
 * Everything this app can do was reachable before it existed and none of it
 * announced itself: the scene opens on a black frame with a few thousand stars
 * in it, eleven unlabelled icons down one side, and no statement anywhere that
 * the things in the sky are places you can go. Someone who already knew the
 * shape of the thing found it all; someone who did not had to guess which icon
 * to press first.
 *
 * So this says the three things worth knowing, in the order they are needed,
 * and offers to do the first one for you. It appears once and remembers that it
 * has, because a welcome mat you have to step over every time is worse than
 * none — and it can be brought back from the help dialog, which is where
 * someone who dismissed it too quickly would look.
 */

import { el } from './dom.js';
import { platform } from '../engine/platform.js';

/**
 * The same three things, in the same order, in the words of the device holding
 * them.
 *
 * Two versions rather than one hedged version. A card that says "click or tap"
 * and "scroll or pinch" throughout is longer, reads as a manual, and tells
 * everyone half a sentence they cannot act on — which is the opposite of the
 * point, since the card exists because the first move was not obvious. The
 * third step is the one that changes most: there are no keys to name, so it
 * names the thing that appears when you switch to Roam instead. sky.html
 * already says "pinch to zoom", so the vocabulary is the project's own.
 */
const STEPS_POINTER = [
  ['Go somewhere', 'Click a name under Destinations, or search for one. Everything you can see is somewhere you can travel to.'],
  ['Look around', 'Drag to swing around what you have arrived at. Scroll to close in, all the way down to standing on the surface.'],
  ['Fly it yourself', 'Switch the camera to Roam and W A S D moves you through open space, with nothing to orbit and nowhere you cannot go.'],
];

const STEPS_TOUCH = [
  ['Go somewhere', 'Tap a name under Destinations, or search for one. Everything you can see is somewhere you can travel to.'],
  ['Look around', 'Drag to swing around what you have arrived at. Pinch to close in, all the way down to standing on the surface.'],
  ['Fly it yourself', 'Switch the camera to Roam and the flight pad moves you through open space, with nothing to orbit and nowhere you cannot go.'],
];

/**
 * @param {object} config
 * @param {{get: Function, set: Function}} config.prefs
 * @param {() => void} config.onStart   Fly somewhere worth seeing.
 * @param {() => void} config.onGuide   Open the full guide.
 */
export function createIntro({ prefs, onStart, onGuide }) {
  const STEPS = platform.touch ? STEPS_TOUCH : STEPS_POINTER;

  const root = el('div', { class: 'intro takes-pointer', hidden: true }, [
    el('div', { class: 'intro-card' }, [
      el('div', { class: 'intro-head' }, [
        el('div', { class: 'intro-title', text: 'Welcome to Cosminova' }),
        el('div', {
          class: 'intro-sub',
          text: 'The solar system, the nearby stars and a few thousand galaxies, at true scale and all in one piece.',
        }),
      ]),
      el('ol', { class: 'intro-steps' }, STEPS.map(([name, body], i) => el('li', { class: 'intro-step' }, [
        el('span', { class: 'intro-step-n', text: String(i + 1) }),
        el('div', {}, [
          el('div', { class: 'intro-step-name', text: name }),
          el('div', { class: 'intro-step-body', text: body }),
        ]),
      ]))),
      el('div', { class: 'intro-actions' }, [
        el('button', {
          type: 'button',
          class: 'btn is-primary',
          text: 'Take me to Earth',
          dataset: { tip: 'Fly there now, so the scene has somewhere in it to start from' },
          onClick: () => {
            dismiss();
            onStart?.();
          },
        }),
        el('button', {
          type: 'button',
          class: 'btn',
          text: 'Full guide',
          dataset: { tip: platform.touch ? 'Every gesture, and what it does' : 'Every control, and the keys they are on' },
          onClick: () => {
            dismiss();
            onGuide?.();
          },
        }),
        el('button', {
          type: 'button',
          class: 'btn is-quiet',
          text: 'I know my way',
          onClick: () => dismiss(),
        }),
      ]),
    ]),
  ]);

  function dismiss() {
    root.hidden = true;
    prefs.set('seenIntro', true);
  }

  return {
    root,

    /** Shown only to someone who has not seen it, so returning is uninterrupted. */
    maybeShow() {
      if (prefs.get('seenIntro', false)) return;
      root.hidden = false;
    },

    /** From the help dialog, for anyone who dismissed it and wanted it back. */
    show() {
      root.hidden = false;
    },
  };
}
