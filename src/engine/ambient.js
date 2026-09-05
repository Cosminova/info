/**
 * Original cinematic score for Cosminova. Every sound here is synthesised at
 * runtime — there are no samples and no audio files — and nothing is a loop.
 * Eight stems play continuously and crossfade with where the camera is, so the
 * piece has no downbeat, no loop point and no end; it only changes weather.
 *
 * Stems: home, leave, deep, approach, land, alien, void, wonder.
 *
 * The one thing that makes this work musically is the harmony clock below. Every
 * stem voices the *same* chord at the same time, each in its own register and
 * each gliding at its own speed. Without that, stems that are audible together —
 * which is most of them, most of the time, because the weights overlap on
 * purpose — drift into different chords and the crossfade turns to mud. With it,
 * any combination of stems is consonant, so the mix can move freely.
 */

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * The progression: four chords, all diatonic to C major / A minor, moving by
 * step and sharing most of their tones. That shared-tone writing is what lets a
 * pad still gliding towards the last chord sit against one that has already
 * arrived at the next; the notes they disagree about are notes both chords hold.
 *
 * A minor is the key for the same reason so much of this repertoire is in it:
 * the natural minor with an added ninth is warm rather than sad, and the drop to
 * the relative major on the way round reads as hopefulness without resolving,
 * which is the "there is so much out there" feeling rather than an ending.
 *
 * `full` spans five octaves so that every stem can pick from it in its own
 * register. `open` is the same harmony voiced in fourths and fifths with the
 * third left out — still in key, but rootless and unplaceable, which is what the
 * alien stem wants. `bass` is the pedal.
 */
const PROGRESSION = [
  {
    name: 'Fmaj9',
    bass: 29,
    full: [41, 48, 53, 57, 60, 64, 67, 69, 72, 76, 81],
    open: [53, 60, 64, 71, 76, 83],
  },
  {
    name: 'Cadd9',
    bass: 24,
    full: [36, 43, 48, 52, 55, 60, 62, 64, 67, 74, 79],
    open: [48, 55, 62, 69, 74, 81],
  },
  {
    name: 'Am9',
    bass: 21,
    full: [33, 40, 45, 48, 52, 55, 57, 59, 64, 71, 76],
    open: [45, 52, 59, 64, 71, 76],
  },
  {
    name: 'Em11',
    bass: 28,
    full: [40, 47, 52, 55, 59, 62, 64, 67, 71, 74, 79],
    open: [52, 59, 62, 67, 74, 79],
  },
];

// Notes the piano and the bells are allowed to touch, as scale degrees rather
// than chord tones: a melody note off the chord is the point, a melody note off
// the key is a mistake.
const PENTATONIC = [0, 2, 4, 7, 9];

const STEM_NAMES = ['home', 'leave', 'deep', 'approach', 'land', 'alien', 'void', 'wonder'];

// Output level with the music enabled. Set so the loudest place the game can
// reach sits near -20 dBFS with the peaks a good 10 dB below clipping; the
// ceiling in the master chain guarantees the rest.
const LEVEL = 0.68;

/**
 * Chord tones spread evenly across a register.
 *
 * Spread, not lowest-first: taking the first N tones in range bunches every
 * voicing at the bottom of its span, which puts four notes inside one octave and
 * is heard as congestion rather than as a chord. Sampling the available tones
 * across the whole range gives an open voicing with air between the notes, which
 * is most of why a pad sounds wide rather than thick.
 */
function pick(notes, lo, hi, count) {
  const inRange = notes.filter((n) => n >= lo && n <= hi);
  if (!inRange.length) {
    // Chord has nothing in this register: fold tones into it an octave at a time.
    return notes.slice(0, count).map((n) => {
      let v = n;
      while (v < lo) v += 12;
      while (v > hi) v -= 12;
      return v;
    });
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    out.push(inRange[Math.round(t * (inRange.length - 1))]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

// Per context, because an AudioBuffer belongs to the context that made it.
const noiseCache = new WeakMap();

function noiseBuffer(ctx) {
  const cached = noiseCache.get(ctx);
  if (cached) return cached;
  const length = ctx.sampleRate * 4;
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }
  noiseCache.set(ctx, buffer);
  return buffer;
}

/**
 * A reverb tail, built rather than recorded.
 *
 * Two things make the difference between this and a plain burst of decaying
 * noise. The tail is progressively damped — the coefficient of the one-pole
 * filter falls as the tail decays, so the top end dies first, which is what a
 * large space actually does to sound and what stops the reverb from hissing. And
 * the two channels are generated independently, which decorrelates them and is
 * where the width comes from.
 */
function reverbImpulse(ctx, { seconds, decay = 2.6, damp = 0.5, preDelay = 0 }) {
  const rate = ctx.sampleRate;
  const pre = Math.floor(preDelay * rate);
  const tail = Math.floor(seconds * rate);
  const buffer = ctx.createBuffer(2, pre + tail, rate);
  let peak = 0;
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < tail; i++) {
      const t = i / tail;
      const env = (1 - t) ** decay;
      const k = damp * (1 - t * 0.88) + 0.02;
      lp += k * (Math.random() * 2 - 1 - lp);
      const v = lp * env;
      data[pre + i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
  }
  if (peak > 0) {
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) data[i] /= peak;
    }
  }
  return buffer;
}

function lfo(ctx, dest, { rate, depth, type = 'sine', phase = 0 }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = rate;
  gain.gain.value = depth;
  osc.connect(gain);
  gain.connect(dest);
  // Oscillators started at different times are at different phases, which is
  // all that keeps a dozen slow modulators from lining up into one pulse.
  osc.start(ctx.currentTime + phase);
  return { osc, gain };
}

/**
 * Chorus, as a pair of short modulated delays. Cheap, and it is most of what
 * separates a synthesiser pad that sounds like a chord from one that sounds like
 * a texture: the pitch of each copy wanders by a few cents against the others,
 * so the sum never settles.
 */
function chorus(ctx, input, output, { depth = 0.0055, rate = 0.09, mix = 0.5 } = {}) {
  const wet = ctx.createGain();
  wet.gain.value = mix;
  const dry = ctx.createGain();
  dry.gain.value = 1 - mix * 0.35;
  input.connect(dry);
  dry.connect(output);
  for (let i = 0; i < 2; i++) {
    const delay = ctx.createDelay(0.25);
    delay.delayTime.value = 0.018 + i * 0.013;
    const pan = ctx.createStereoPanner();
    pan.pan.value = i ? 0.65 : -0.65;
    input.connect(delay);
    delay.connect(pan);
    pan.connect(wet);
    lfo(ctx, delay.delayTime, { rate: rate * (i ? 1.37 : 1), depth, phase: i * 3.1 });
  }
  wet.connect(output);
}

/**
 * A pad: one oscillator group per note, three oscillators per note detuned
 * against each other, through a resonant lowpass that drifts.
 *
 * Each note also gets its own slow amplitude breathing at a rate that shares no
 * common factor with its neighbours'. That is what makes the chord evolve while
 * standing still — voices surface and recede inside a sustained harmony instead
 * of the whole block sitting at one level.
 */
function createPad(ctx, dest, {
  notes = 4,
  cutoff = 1200,
  q = 1.1,
  detune = 7,
  types = ['sine', 'triangle', 'sine'],
  breathe = 0.16,
  spread = 0.75,
  bias = 0,
} = {}) {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  filter.Q.value = q;
  const wide = ctx.createGain();
  filter.connect(wide);
  chorus(ctx, wide, dest, { depth: 0.0035, rate: 0.07, mix: 0.35 });
  // A lowpass swung across a third of its own cutoff is a filter sweep, and a
  // filter sweep under everything for the whole piece is the single thing that
  // makes a score read as a sound effect. Enough movement to keep the pad from
  // sitting dead still, not enough to hear as a gesture of its own.
  lfo(ctx, filter.frequency, { rate: 0.019, depth: cutoff * 0.06 });

  const voices = [];
  for (let i = 0; i < notes; i++) {
    const level = ctx.createGain();
    level.gain.value = 0;
    const breath = ctx.createGain();
    breath.gain.value = 1;
    const pan = ctx.createStereoPanner();
    pan.pan.value = (notes === 1 ? 0 : i / (notes - 1) - 0.5) * 2 * spread;
    level.connect(breath);
    breath.connect(pan);
    pan.connect(filter);
    lfo(ctx, breath.gain, {
      rate: 0.021 + i * 0.0134,
      depth: breathe,
      phase: i * 1.7,
    });

    const oscs = [];
    for (let k = 0; k < types.length; k++) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = types[k];
      osc.frequency.value = midi(48);
      // `bias` shifts the whole group off concert pitch. Used by the alien stem,
      // where a few cents against every other stem beats slowly and is most of
      // why it feels wrong in a way that is hard to point at.
      osc.detune.value = (k - (types.length - 1) / 2) * detune + bias;
      g.gain.value = 1 / types.length;
      osc.connect(g);
      g.connect(level);
      osc.start();
      oscs.push(osc);
    }
    voices.push({ level, oscs });
  }

  return {
    filter,
    set(list, gain, glide) {
      const now = ctx.currentTime;
      for (let i = 0; i < voices.length; i++) {
        const note = list[i % list.length];
        for (const osc of voices[i].oscs) {
          osc.frequency.setTargetAtTime(midi(note), now, glide * 0.45);
        }
        // Outer voices sit back so the chord has a centre rather than reading as
        // a stack of equals.
        const weight = i === 0 ? 1 : i < 3 ? 0.86 : 0.62;
        voices[i].level.gain.setTargetAtTime(gain * weight, now, glide);
      }
    },
  };
}

/**
 * Wordless choir. Sawtooth pairs through two bandpass formants, which is the
 * cheapest thing that reads as a voice rather than a synthesiser: the ear
 * identifies a vowel from the position of two resonances, so putting them in
 * roughly the right place is enough. The vowel drifts between "oo" and "ah" on a
 * slow modulator, and each note has its own small vibrato, which keeps it from
 * sounding like one singer multiplied.
 */
function createChoir(ctx, dest, { notes = 4, level = 1 } = {}) {
  const bus = ctx.createGain();
  bus.gain.value = 0;

  const f1 = ctx.createBiquadFilter();
  f1.type = 'bandpass';
  f1.frequency.value = 520;
  f1.Q.value = 3.2;
  const f2 = ctx.createBiquadFilter();
  f2.type = 'bandpass';
  f2.frequency.value = 1180;
  f2.Q.value = 4.5;
  const g1 = ctx.createGain();
  g1.gain.value = 1;
  const g2 = ctx.createGain();
  g2.gain.value = 0.42;
  // Above the second formant a voice falls away steeply; without this the saws
  // keep their buzz and it stops sounding human.
  const roll = ctx.createBiquadFilter();
  roll.type = 'lowpass';
  roll.frequency.value = 2600;
  roll.Q.value = 0.7;

  bus.connect(f1);
  bus.connect(f2);
  f1.connect(g1);
  f2.connect(g2);
  const sum = ctx.createGain();
  sum.gain.value = level;
  g1.connect(sum);
  g2.connect(sum);
  sum.connect(roll);
  chorus(ctx, roll, dest, { depth: 0.008, rate: 0.05, mix: 0.55 });

  lfo(ctx, f1.frequency, { rate: 0.023, depth: 150 });
  lfo(ctx, f2.frequency, { rate: 0.017, depth: 420, phase: 2.2 });

  const voices = [];
  for (let i = 0; i < notes; i++) {
    const level_ = ctx.createGain();
    level_.gain.value = 1 / notes;
    const pan = ctx.createStereoPanner();
    pan.pan.value = (i / Math.max(notes - 1, 1) - 0.5) * 1.5;
    level_.connect(pan);
    pan.connect(bus);
    const oscs = [];
    for (let k = 0; k < 2; k++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = midi(60);
      osc.detune.value = k ? 9 : -9;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      osc.connect(g);
      g.connect(level_);
      osc.start();
      oscs.push(osc);
      lfo(ctx, osc.detune, { rate: 4.1 + i * 0.37 + k * 0.11, depth: 5.5, phase: i * 0.8 });
    }
    voices.push({ oscs });
  }

  return {
    set(list, gain, glide) {
      const now = ctx.currentTime;
      for (let i = 0; i < voices.length; i++) {
        const note = list[i % list.length];
        for (const osc of voices[i].oscs) osc.frequency.setTargetAtTime(midi(note), now, glide * 0.5);
      }
      bus.gain.setTargetAtTime(gain, now, glide);
    },
  };
}

/**
 * String ensemble. Sawtooths with a body resonance and a slow swell, which is
 * all a section is at this distance: the individual bows are inaudible, what
 * carries is the collective detune and the fact that the sound takes a second
 * or two to arrive.
 */
function createStrings(ctx, dest, { notes = 4 } = {}) {
  const body = ctx.createBiquadFilter();
  body.type = 'bandpass';
  body.frequency.value = 620;
  body.Q.value = 0.55;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 2400;
  tone.Q.value = 0.8;
  const bus = ctx.createGain();
  bus.gain.value = 0;
  bus.connect(body);
  body.connect(tone);
  chorus(ctx, tone, dest, { depth: 0.007, rate: 0.06, mix: 0.5 });
  // Bow pressure changing the brightness of the section, not a filter sweep.
  lfo(ctx, tone.frequency, { rate: 0.014, depth: 220 });

  const voices = [];
  for (let i = 0; i < notes; i++) {
    const level = ctx.createGain();
    level.gain.value = 1 / notes;
    const pan = ctx.createStereoPanner();
    pan.pan.value = (i / Math.max(notes - 1, 1) - 0.5) * 1.7;
    level.connect(pan);
    pan.connect(bus);
    const oscs = [];
    for (let k = 0; k < 3; k++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = midi(60);
      osc.detune.value = (k - 1) * 11;
      const g = ctx.createGain();
      g.gain.value = 1 / 3;
      osc.connect(g);
      g.connect(level);
      osc.start();
      oscs.push(osc);
      lfo(ctx, osc.detune, { rate: 3.3 + i * 0.29 + k * 0.13, depth: 4, phase: i * 1.1 });
    }
    voices.push({ oscs });
  }

  return {
    set(list, gain, glide) {
      const now = ctx.currentTime;
      for (let i = 0; i < voices.length; i++) {
        const note = list[i % list.length];
        for (const osc of voices[i].oscs) osc.frequency.setTargetAtTime(midi(note), now, glide * 0.6);
      }
      // Strings swell rather than switch, so their gain always takes longer to
      // arrive than the pads'.
      bus.gain.setTargetAtTime(gain, now, glide * 1.8);
    },
  };
}

/**
 * Sub-bass. A sine at 30 Hz is nearly inaudible on the speakers most people
 * have, so this puts a fifth above the root and runs the pair through a gentle
 * waveshaper: the distortion products land an octave and a twelfth up, where
 * small speakers can reproduce them, and the ear infers the fundamental it
 * cannot actually hear. On a system that can reproduce it, the fundamental is
 * still there underneath.
 */
function createSub(ctx, dest) {
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 1.9) / Math.tanh(1.9);
  }
  shaper.curve = curve;
  // Drive into the saturator is fixed and the level is taken after it. How hard
  // a waveshaper is driven is what decides how many harmonics it makes, so
  // putting the level control in front of it would make the sub change timbre as
  // its weight in the mix changed — thin when quiet, growling when loud.
  const drive = ctx.createGain();
  drive.gain.value = 0.75;
  const post = ctx.createBiquadFilter();
  post.type = 'lowpass';
  post.frequency.value = 300;
  post.Q.value = 0.6;
  const level = ctx.createGain();
  level.gain.value = 0;
  drive.connect(shaper);
  shaper.connect(post);
  post.connect(level);
  level.connect(dest);

  const oscs = [];
  for (let k = 0; k < 2; k++) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = midi(29);
    g.gain.value = k ? 0.3 : 1;
    osc.connect(g);
    g.connect(drive);
    osc.start();
    oscs.push(osc);
    lfo(ctx, osc.frequency, { rate: 0.031 + k * 0.017, depth: 0.09, phase: k * 2.4 });
  }

  return {
    set(root, gain, glide) {
      const now = ctx.currentTime;
      oscs[0].frequency.setTargetAtTime(midi(root), now, glide * 0.7);
      oscs[1].frequency.setTargetAtTime(midi(root + 7), now, glide * 0.7);
      level.gain.setTargetAtTime(gain, now, glide);
    },
  };
}

/**
 * A slow pulse: the beat of something enormous rather than a drum. A low sine
 * gated by a shaped modulator, with a breath of filtered noise on the same
 * envelope so the swell has some texture at the top.
 */
function createPulse(ctx, dest, { note = 26, rate = 0.055 } = {}) {
  const bus = ctx.createGain();
  bus.gain.value = 1;

  // The swell, as its own stage in series with the level control rather than
  // sharing a parameter with it. A modulator and a setTargetAtTime writing to
  // the same AudioParam sum, so putting both on one gain node makes the level
  // control fight the modulation and can drive the gain negative.
  //
  // Squaring the sine through a waveshaper is what turns a symmetric wobble into
  // a swell with a long trough — the difference between a tremolo and a breath.
  const shape = ctx.createGain();
  shape.gain.value = 0;
  const squash = ctx.createWaveShaper();
  const curve = new Float32Array(513);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = x * x * x * x;
  }
  squash.curve = curve;
  const swell = ctx.createOscillator();
  swell.type = 'sine';
  swell.frequency.value = rate;
  swell.connect(squash);
  squash.connect(shape.gain);
  swell.start();

  const level = ctx.createGain();
  level.gain.value = 0;
  bus.connect(shape);
  shape.connect(level);
  level.connect(dest);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = midi(note);
  const og = ctx.createGain();
  og.gain.value = 0.8;
  osc.connect(og);
  og.connect(bus);
  osc.start();

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx);
  noise.loop = true;
  const nf = ctx.createBiquadFilter();
  nf.type = 'bandpass';
  nf.frequency.value = 180;
  nf.Q.value = 1.4;
  const ng = ctx.createGain();
  ng.gain.value = 0.12;
  noise.connect(nf);
  nf.connect(ng);
  ng.connect(bus);
  noise.start();
  lfo(ctx, nf.frequency, { rate: 0.043, depth: 60 });

  return {
    set(root, gain, glide) {
      const now = ctx.currentTime;
      osc.frequency.setTargetAtTime(midi(root), now, glide);
      level.gain.setTargetAtTime(gain, now, glide);
    },
  };
}

/**
 * Filtered noise: the air in a room, the hiss of a thin atmosphere, the sense
 * that the silence has a shape. Bandpassed, never loud enough to identify as
 * noise.
 *
 * The sweep is small on purpose. A noise band walked across an octave is a
 * whoosh, and whooshes under a sustained chord are what make a score sound like
 * a wind tunnel rather than an ensemble. This is room tone; it should be
 * noticed only when it stops.
 */
function createAir(ctx, dest, { freq = 420, q = 0.5, sweep = 0.06 } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  // Two stages: one carries the slow swell, the other the level. Sharing a
  // single gain node between a modulator and the level control would let the
  // modulation dominate a quiet setting and push the gain below zero.
  const drift = ctx.createGain();
  drift.gain.value = 1;
  const level = ctx.createGain();
  level.gain.value = 0;
  src.connect(f);
  f.connect(drift);
  drift.connect(level);
  level.connect(dest);
  src.start();
  lfo(ctx, f.frequency, { rate: 0.027, depth: freq * sweep });
  lfo(ctx, drift.gain, { rate: 0.013, depth: 0.45 });
  return {
    set(gain, glide) {
      level.gain.setTargetAtTime(gain, ctx.currentTime, glide);
    },
  };
}

/**
 * Felt piano. A piano is not a sine: it is a stack of partials that are slightly
 * sharp of the harmonic series because real strings are stiff, and each partial
 * decays faster than the one below it, which is why the tone darkens as it
 * fades. Both of those are what the ear uses to identify the instrument, so both
 * are here; the hammer gets a click of filtered noise, and a lowpass stands in
 * for the felt.
 */
function makePiano(ctx, dest, note, peak, when = 0) {
  // Scheduled against the audio clock rather than fired on arrival. setTimeout
  // drifts by a handful of milliseconds, which is inaudible on a pad and is
  // exactly the wrong amount on a piano: a pulse you can feel is a pulse whose
  // notes land where the ear predicted, and the whole difference between a
  // played phrase and a sequence of separate notes lives in that few
  // milliseconds. So the scheduler works a phrase ahead and passes times in.
  const now = Math.max(when, ctx.currentTime);
  const base = midi(note);
  const out = ctx.createGain();
  out.gain.value = peak;
  const felt = ctx.createBiquadFilter();
  felt.type = 'lowpass';
  felt.frequency.value = 1500 + peak * 8000;
  felt.Q.value = 0.5;
  const pan = ctx.createStereoPanner();
  pan.pan.value = (Math.random() - 0.5) * 0.5;
  out.connect(felt);
  felt.connect(pan);
  pan.connect(dest);

  const partials = [
    { ratio: 1, gain: 1, decay: 7.5 },
    { ratio: 2.004, gain: 0.4, decay: 5.4 },
    { ratio: 3.014, gain: 0.16, decay: 3.6 },
    { ratio: 4.032, gain: 0.07, decay: 2.4 },
    { ratio: 5.06, gain: 0.03, decay: 1.6 },
  ];
  for (const p of partials) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = base * p.ratio;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(p.gain, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.00001, now + p.decay);
    osc.connect(g);
    g.connect(out);
    osc.start(now);
    // Stopping the oscillator after its own envelope has finished, rather than
    // at a shared time, is what keeps the tail from being cut off audibly.
    osc.stop(now + p.decay + 0.1);
  }

  const hammer = ctx.createBufferSource();
  hammer.buffer = noiseBuffer(ctx);
  const hf = ctx.createBiquadFilter();
  hf.type = 'bandpass';
  hf.frequency.value = base * 3.5;
  hf.Q.value = 0.9;
  const hg = ctx.createGain();
  hg.gain.setValueAtTime(0.5, now);
  hg.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
  hammer.connect(hf);
  hf.connect(hg);
  hg.connect(out);
  hammer.start(now, Math.random() * 3);
  hammer.stop(now + 0.12);
}

/**
 * Melodic cells, as beat offsets within an eight-beat phrase paired with a step
 * up the available chord tones.
 *
 * Written out rather than improvised note by note because the thing that makes
 * this repertoire feel composed is recurrence: a phrase you have heard before,
 * arriving again a little different, is a tune, and five notes picked at random
 * every time is a wind chime. Steps index into whatever tones the current chord
 * offers in the current register, so one cell transposes itself through the
 * whole progression and stays consonant without any of them being written
 * twice.
 *
 * Fractional beats are on purpose. Everything landing on integers marches, and
 * a piano piece at this tempo should breathe.
 */
const MOTIFS = [
  [{ b: 0, s: 0 }, { b: 1.5, s: 2 }, { b: 3, s: 1 }, { b: 5, s: 3 }, { b: 6.5, s: 2 }],
  [{ b: 0, s: 2 }, { b: 1, s: 1 }, { b: 2, s: 0 }, { b: 4, s: 2 }, { b: 6, s: 4 }],
  [{ b: 0, s: 4 }, { b: 2, s: 3 }, { b: 3.5, s: 2 }, { b: 4.5, s: 3 }, { b: 6, s: 1 }],
  [{ b: 0.5, s: 1 }, { b: 2, s: 2 }, { b: 3, s: 2 }, { b: 5, s: 0 }, { b: 7, s: 1 }],
  [{ b: 0, s: 3 }, { b: 1.5, s: 4 }, { b: 3, s: 3 }, { b: 4, s: 1 }, { b: 6.5, s: 0 }],
  // Sparse cells, for the places that want more air than tune.
  [{ b: 0, s: 0 }, { b: 3, s: 2 }, { b: 6, s: 1 }],
  [{ b: 1, s: 2 }, { b: 4.5, s: 0 }],
];

/** Seconds per beat. About seventy to the minute: walking pace, not marching. */
const BEAT = 0.86;
const PHRASE_BEATS = 8;

/**
 * The pitches a melody is allowed to walk, ascending through a register.
 *
 * Chord tones alone are not enough to make a tune out of. Inside the two
 * octaves a melody actually occupies a four-note chord offers three or four
 * pitches, a fourth and a fifth apart, so a five-note motif drawn from them
 * repeats pitches it did not mean to repeat and leaps between the ones it does
 * not — which is how the first version of this produced phrases like B4 B4 B4.
 *
 * Filling in the rest of the key gives a dozen or so pitches a step or two
 * apart, and stepwise motion through a scale with the chord tones landing on
 * the strong beats is, more or less, what this kind of piano writing is.
 *
 * Rootless voicings skip the fill. The alien stem wants the wide unplaceable
 * intervals that chord tones on their own produce, so there the old behaviour
 * is the intended one.
 */
function melodyPool(tones, lo, hi, fill) {
  const classes = new Set(tones.map((n) => ((n % 12) + 12) % 12));
  if (fill) for (const d of PENTATONIC) classes.add(d % 12);
  const out = [];
  for (let n = lo; n <= hi; n++) if (classes.has(((n % 12) + 12) % 12)) out.push(n);
  return out.length ? out : pick(tones, lo, hi, 5);
}

/**
 * A struck metal partial stack, tuned so its overtones are inharmonic in a way
 * that reads as a bell rather than a pitched note. Used sparingly on alien
 * worlds, where the point is a sound you cannot place.
 */
function makeBell(ctx, dest, note, peak) {
  const now = ctx.currentTime;
  const base = midi(note);
  const out = ctx.createGain();
  out.gain.value = peak;
  const pan = ctx.createStereoPanner();
  pan.pan.value = (Math.random() - 0.5) * 1.4;
  out.connect(pan);
  pan.connect(dest);
  const ratios = [1, 2.76, 5.4, 8.93];
  const decays = [9, 6, 4, 2.6];
  for (let i = 0; i < ratios.length; i++) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = base * ratios[i];
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.6 / (i + 1), now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.00001, now + decays[i]);
    osc.connect(g);
    g.connect(out);
    osc.start(now);
    osc.stop(now + decays[i] + 0.1);
  }
}

/**
 * Plucked string, somewhere between a harp and a celesta.
 *
 * This is the voice that makes the score read as played rather than as
 * generated. Pads and noise beds have no attack, and without an attack the ear
 * has nothing to time the music by — a chord that fades in over nine seconds is
 * weather, not a phrase. A pluck is almost all attack: a few milliseconds of
 * broadband edge, then harmonics that decay at their own rates. That edge is
 * also the only thing in the whole piece with energy above 5 kHz.
 *
 * A harp's partials are close to a true harmonic series — much closer than a
 * piano's, whose thick stiff strings run sharp — so these ratios are whole
 * numbers, and the brightness comes from how slowly the upper ones fade rather
 * than from where they sit.
 */
function makePluck(ctx, dest, note, peak) {
  const now = ctx.currentTime;
  const base = midi(note);
  const out = ctx.createGain();
  out.gain.value = peak;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  // Higher notes come off the string brighter, which is most of why a harp
  // glissando sounds like it is rising rather than merely getting higher.
  tone.frequency.value = Math.min(base * 9 + 1800, 14000);
  tone.Q.value = 0.4;
  const pan = ctx.createStereoPanner();
  pan.pan.value = (Math.random() - 0.5) * 1.2;
  out.connect(tone);
  tone.connect(pan);
  pan.connect(dest);

  // Long fundamental, quick top: the note darkens as it rings, the way a real
  // string sheds its high partials first.
  const partials = [
    { ratio: 1, gain: 1, decay: 3.6 },
    { ratio: 2, gain: 0.5, decay: 2.5 },
    { ratio: 3, gain: 0.26, decay: 1.7 },
    { ratio: 4, gain: 0.13, decay: 1.1 },
    { ratio: 5, gain: 0.07, decay: 0.75 },
    { ratio: 6, gain: 0.035, decay: 0.5 },
  ];
  for (const p of partials) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = base * p.ratio;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(p.gain, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.00001, now + p.decay);
    osc.connect(g);
    g.connect(out);
    osc.start(now);
    osc.stop(now + p.decay + 0.1);
  }

  // The fingernail leaving the string. Brief and bright, and the reason a pluck
  // can be heard through a chord that is louder than it is.
  const nail = ctx.createBufferSource();
  nail.buffer = noiseBuffer(ctx);
  const nf = ctx.createBiquadFilter();
  nf.type = 'bandpass';
  nf.frequency.value = Math.min(base * 6, 9000);
  nf.Q.value = 1.2;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.32, now);
  ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
  nail.connect(nf);
  nf.connect(ng);
  ng.connect(out);
  nail.start(now, Math.random() * 3);
  nail.stop(now + 0.07);
}

/**
 * A single high tone that fades up out of nothing and back into it. No attack,
 * so it cannot be located in time — it is simply there and then it is not, which
 * is what makes it read as distance rather than as a note.
 */
function makeShimmer(ctx, dest, note, peak) {
  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, now);
  out.gain.exponentialRampToValueAtTime(peak, now + 3.4);
  out.gain.exponentialRampToValueAtTime(0.00001, now + 11);
  const pan = ctx.createStereoPanner();
  pan.pan.value = (Math.random() - 0.5) * 1.7;
  out.connect(pan);
  pan.connect(dest);
  for (let k = 0; k < 2; k++) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = midi(note + k * 12);
    osc.detune.value = k ? 6 : -6;
    g.gain.value = k ? 0.3 : 1;
    osc.connect(g);
    g.connect(out);
    osc.start(now);
    osc.stop(now + 11.5);
  }
}

// ---------------------------------------------------------------------------
// Scene mapping
// ---------------------------------------------------------------------------

/**
 * Mix weights from camera state. Values are 0–1 and do not need to sum to 1.
 *
 * `awe` is separate from the stem weights: it is how much of the discovery build
 * is unlocked, and it drives the choir and strings on top of whatever else is
 * playing rather than replacing it.
 */
export function sceneWeights({
  viewFromEarth = false,
  kind = 'body',
  key = 'earth',
  distanceRadii = 4,
  fromSunKm = 1.5e8,
  earthDistanceKm = 1e6,
} = {}) {
  const AU = 149597870.7;
  const fromSunAU = fromSunKm / AU;
  const earthAlt = earthDistanceKm - 6371;
  const w = {
    home: 0, leave: 0, deep: 0, approach: 0,
    land: 0, alien: 0, void: 0, wonder: 0, awe: 0,
  };

  if (kind === 'black-hole') {
    w.void = 1;
    w.deep = 0.22;
    // Close to the hole the awe is dread rather than delight, so the build is
    // held well back: it colours the drones instead of taking them over.
    w.awe = smoothstep(60, 8, distanceRadii) * 0.45;
    w.wonder = w.awe * 0.5;
    return w;
  }

  if (kind === 'galaxy') {
    w.deep = 0.62;
    w.approach = smoothstep(16, 5, distanceRadii) * 0.4;
    w.awe = smoothstep(7, 2, distanceRadii);
    w.wonder = w.awe;
    return w;
  }

  const onEarth = viewFromEarth || (key === 'earth' && (distanceRadii < 1.12 || earthAlt < 120));
  if (onEarth) {
    w.home = 1;
    w.leave = smoothstep(40, 400, earthAlt) * 0.18;
    return w;
  }

  // Other stars and their planets are unfamiliar; ours is not. The Sun shares
  // the 'star' kind with the whole catalogue, so without excluding it by key,
  // flying home to the Sun plays the alien stem.
  const exo = kind === 'exo-planet' || (kind === 'star' && key !== 'sun');
  const world = kind === 'body' || kind === 'moon';
  // The Sun is neither a world nor alien, but arriving at it is still an
  // arrival, so it needs the approach build like anything else you fly to.
  const target = world || exo || key === 'sun';

  // How much of the arrival is underway, computed before anything else so that
  // every departure and travelling layer can be told to make room for it.
  const arriving = target ? smoothstep(90, 12, distanceRadii) : 0;
  const arrived = target ? smoothstep(9, 2.4, distanceRadii) : 0;

  // Leaving: home recedes and the low end grows, tied to the same altitude so it
  // reads as one continuous departure rather than a cue changing.
  //
  // On a log scale, because that is how the camera moves — distance changes by
  // factors, not by increments. Measured linearly, home was still at four
  // fifths of full weight out past geostationary orbit, which is well past the
  // point where anything about the view still says civilisation.
  if (earthAlt < 4e5 && fromSunAU < 1.3) {
    const gone = smoothstep(2.3, 4.8, Math.log10(Math.max(earthAlt, 1)));
    w.home = (1 - gone) * 0.95;
    w.deep = smoothstep(4.6, 5.6, Math.log10(Math.max(earthAlt, 1))) * 0.35;
    if (key === 'moon') {
      w.approach = arriving * 0.7;
      w.land = arrived * 0.85;
      w.awe = smoothstep(9, 2.5, distanceRadii) * 0.35;
    }
    // Departure yields to arrival: without this, coming down at the Moon plays
    // the leaving-Earth stem at full weight underneath the landing.
    w.leave = gone * (1 - w.land * 0.8) * (1 - w.approach * 0.3);
    w.wonder = w.awe;
    return w;
  }

  const far = smoothstep(1.5, 9, fromSunAU);

  // Everything below layers rather than switches: deep space never fully leaves
  // once you are out there, it just makes room.
  w.deep = 0.35 + far * 0.55;
  w.leave = (1 - far) * 0.4;

  if (arriving > 0) {
    // Anticipation peaks on the way in and steps back once you are there, so the
    // arrival hands over to the intimacy of being somewhere rather than the two
    // playing over each other.
    w.approach = arriving * 0.85 * (1 - arrived * 0.6);
    w.deep *= 1 - arriving * 0.45;
    w.awe = smoothstep(30, 4, distanceRadii) * 0.5;
  }
  if (arrived > 0) {
    w.land = arrived * 0.9;
    w.deep *= 1 - arrived * 0.7;
    w.leave *= 1 - arrived;
  }
  if (exo) {
    w.alien = smoothstep(40, 4, distanceRadii) * 0.9;
    // An alien world is its own atmosphere; the generic arrival and landing
    // layers thin out so the unfamiliar harmony is what is actually heard.
    w.approach *= 0.6;
    w.land *= 0.55;
    w.awe = Math.max(w.awe, smoothstep(20, 3, distanceRadii) * 0.6);
  }
  if (arrived > 0.5 && key === 'earth') {
    w.home = 0.7;
    w.land = 0;
  }
  w.wonder = w.awe;
  return w;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * `context`, `autoResume` and `schedule` exist for the offline render test, which
 * supplies its own OfflineAudioContext and places transients itself. In the app
 * all three defaults are what you want.
 */
export function createAmbient({ context = null, autoResume = true, schedule = true } = {}) {
  let ctx = context;
  let master = null;
  let muted = false;
  let started = false;
  let timers = [];
  let stems = {};
  let parts = {};
  let chordIndex = 0;
  // Phrases played on the current chord, so the progression can be driven by
  // the piano rather than by a clock the piano cannot see.
  let phrasesHeld = 0;
  // Height of the melody in its register, 0 to 1, carried between phrases.
  let anchorPos = 0.45;
  // Multiplies every glide and crossfade time. Only the offline render test
  // touches it: that test has no wall clock, so it needs the graph to arrive at
  // its target levels immediately rather than over the half-minute the music
  // actually wants.
  let glideScale = 1;
  let mix = {
    home: 1, leave: 0, deep: 0, approach: 0,
    land: 0, alien: 0, void: 0, wonder: 0, awe: 0,
  };
  let lastApply = -1e9;

  function later(ms, fn) {
    timers.push(setTimeout(fn, ms));
  }

  /**
   * Move every stem to the next chord at once. Each one glides at its own rate —
   * the sub takes half a minute, the pads ten to twenty seconds, the strings
   * longer still — so the change is never an event, but they are all heading to
   * the same place, which is what keeps them in tune with each other.
   */
  function advanceHarmony() {
    chordIndex = (chordIndex + 1) % PROGRESSION.length;
    voiceHarmony();
  }

  /**
   * Place every stem on the current chord. Levels here are fixed: the stem gains
   * set by `apply` are the only mixer, so multiplying by the mix again in here
   * would square it and leave a stem at half weight sounding a quarter as loud.
   *
   * The exception is the wonder pad, which is scaled by `awe` on top of a stem
   * gain that is already `awe` — deliberately squared, so the shimmering top of
   * the build only arrives at the very end of it rather than fading up alongside
   * everything else. The climax should feel earned rather than switched on.
   */
  function voiceHarmony() {
    if (!ctx) return;
    const { full, open, bass } = PROGRESSION[chordIndex];
    const g = (seconds) => seconds * glideScale;

    // Everything in here is now accompaniment, and quiet enough that the piano
    // is unambiguously the thing playing.
    //
    // The beds used to be the score: eight sustained stems, each a filtered
    // oscillator stack over a band of noise, and the piano was a few notes
    // sprinkled on top in two of the eight places. Sustained synthesis with no
    // attack and a modulator on everything is heard as a sound effect, not as
    // music, however carefully it is voiced — which is exactly the complaint.
    // So the levels below are roughly a third of what they were, the noise beds
    // are silent, and the pulses are gone. What is left is a cushion under the
    // piano: enough to place the harmony while the sustain pedal is down,
    // little enough that you would not notice it alone.
    parts.homePad.set(pick(full, 48, 76, 4), 0.014, g(9));
    parts.homeSub.set(bass + 12, 0.02, g(14));
    parts.homeStrings.set(pick(full, 55, 79, 4), 0.009, g(10));

    parts.leavePad.set(pick(full, 36, 64, 4), 0.014, g(14));
    parts.leaveSub.set(bass, 0.021, g(20));
    parts.leaveStrings.set(pick(full, 48, 72, 4), 0.009, g(12));

    parts.deepPad.set(pick(full, 40, 79, 5), 0.012, g(18));
    parts.deepSub.set(bass, 0.026, g(24));
    parts.deepStrings.set(pick(full, 52, 76, 4), 0.01, g(14));
    parts.deepPulse.set(bass + 12, 0, g(12));

    parts.approachStrings.set(pick(full, 55, 79, 4), 0.022, g(10));
    parts.approachChoir.set(pick(full, 52, 74, 4), 0.016, g(12));
    parts.approachPad.set(pick(full, 45, 72, 4), 0.016, g(11));

    parts.landPad.set(pick(full, 52, 79, 4), 0.014, g(8));
    parts.landSub.set(bass + 12, 0.02, g(12));
    parts.landStrings.set(pick(full, 57, 81, 4), 0.009, g(9));

    parts.alienPad.set(pick(open, 45, 79, 5), 0.026, g(12));
    parts.alienSub.set(bass, 0.03, g(16));

    // The void keeps a little more of its bottom than anywhere else. It is the
    // one place with almost no piano in it, so with the bed at the same level as
    // everywhere else there would be nothing there at all. It stays at the bass
    // octave rather than below — an octave down puts the A minor root at 14 Hz,
    // which no speaker reproduces and which only eats headroom.
    parts.voidSub.set(bass, 0.04, g(22));
    parts.voidPulse.set(bass, 0, g(16));

    parts.wonderStrings.set(pick(full, 60, 84, 4), 0.026, g(9));
    parts.wonderChoir.set(pick(full, 57, 81, 4), 0.018, g(11));
    parts.wonderPad.set(pick(full, 67, 91, 4), 0.014 * clamp(mix.awe, 0, 1), g(13));
  }

  /**
   * The piano part, which is now the piece rather than a decoration on it.
   *
   * One eight-beat phrase is written and scheduled at a time, a phrase ahead of
   * the audio clock. Left hand states the chord low and holds it; right hand
   * plays a motif above. Where the camera is chooses the register, how many of
   * the motif's notes actually get played, and how often a phrase is followed
   * by a bar of nothing — so somewhere vast is the same music with more silence
   * in it rather than different music.
   */
  function planPhrase() {
    const chord = PROGRESSION[chordIndex];
    // Familiar places play more notes and sit in the middle of the keyboard;
    // empty ones play fewer and drift to the edges of it.
    const close = clamp(mix.home + mix.land * 0.95 + mix.approach * 0.6, 0, 1.3);
    const far = clamp(mix.deep + mix.leave * 0.8 + mix.void, 0, 1.3);
    const lift = clamp(mix.awe + mix.wonder * 0.6, 0, 1.4);
    const strange = clamp(mix.alien, 0, 1);

    // Alien systems take the rootless voicing. Still a piano, still in key, but
    // stacked in fourths and fifths so it cannot be placed.
    const rootless = strange > 0.45;
    const tones = rootless ? chord.open : chord.full;
    // Melody register: chest height at home, up an octave under awe, down one
    // out in the dark.
    const lo = Math.round(60 + lift * 7 - far * 6);
    const pool = melodyPool(tones, lo, lo + 22, !rootless);
    // Where in that register this phrase sits. It walks rather than jumps, so
    // one phrase begins near where the last one ended and the part wanders the
    // way a melody does instead of being re-rolled from scratch every eight
    // beats.
    anchorPos = clamp(anchorPos + (Math.random() - 0.5) * 0.5, 0, 1);
    const anchor = Math.round(anchorPos * Math.max(pool.length - 5, 0));
    const density = clamp(0.55 + close * 0.4 + lift * 0.2 - far * 0.25, 0.25, 1);
    const gain = 0.5 + 0.5 * clamp(close + lift * 0.7 + far * 0.5 + strange, 0, 1.2);

    const notes = [];
    const bells = [];

    // Left hand. Root on the downbeat, then a tone from the middle of the chord
    // halfway through, which is as much as this style ever asks of it.
    notes.push({ note: chord.bass + 12, peak: 0.13 * gain, at: 0 });
    if (Math.random() < 0.75) {
      const inner = pick(tones, chord.bass + 19, chord.bass + 31, 2);
      notes.push({
        note: inner[Math.random() < 0.5 ? 0 : 1],
        peak: 0.085 * gain,
        at: BEAT * 4,
      });
    }

    // Right hand.
    const motif = far > 0.75 && Math.random() < 0.6
      ? MOTIFS[5 + ((Math.random() * 2) | 0)]
      : MOTIFS[(Math.random() * 5) | 0];
    for (let i = 0; i < motif.length; i++) {
      if (Math.random() > density) continue;
      const cell = motif[i];
      // The first note of a phrase carries a little more weight, and the rest
      // taper, which is most of what separates a phrase from a list of notes.
      const accent = i === 0 ? 1 : 0.78 - i * 0.04;
      // A few milliseconds of scatter. Nobody plays dead on the grid, and a
      // piano that does sounds like a music box.
      const swing = (Math.random() - 0.5) * 0.022;
      notes.push({
        note: pool[Math.min(anchor + cell.s, pool.length - 1)],
        peak: 0.155 * gain * accent,
        at: Math.max(cell.b * BEAT + swing, 0),
      });
    }

    // Bells still belong to alien worlds, over the piano rather than instead.
    if (strange > 0.4 && Math.random() < 0.35) {
      bells.push({
        note: chord.open[(Math.random() * chord.open.length) | 0] + 12,
        peak: 0.018 * strange,
        at: Math.random() * BEAT * 4,
      });
    }

    // Rests between phrases, longer where there is more room. A piece that
    // never stops talking cannot be listened past, and most of this score is
    // meant to be listened past.
    const rest = far > 0.6 && Math.random() < 0.5 ? PHRASE_BEATS : 0;
    return { notes, bells, beats: PHRASE_BEATS + rest };
  }

  function schedulePhrase() {
    if (!ctx || muted) {
      later(1500, schedulePhrase);
      return;
    }
    const phrase = planPhrase();
    const start = ctx.currentTime + 0.12;
    for (const n of phrase.notes) {
      makePiano(ctx, parts.pianoDest, n.note, n.peak, start + n.at);
    }
    for (const b of phrase.bells) {
      later(b.at * 1000, () => {
        if (ctx && !muted) makeBell(ctx, parts.bellDest, b.note, b.peak);
      });
    }

    const span = phrase.beats * BEAT * 1000;

    // The chord moves on a phrase boundary, every two phrases. It used to move
    // on a timer of its own running against the piano's, which put chord
    // changes in the middle of phrases — the one place harmony must not move,
    // because a melody note chosen for the old chord is still ringing when the
    // new one arrives under it.
    phrasesHeld++;
    if (phrasesHeld >= 2) {
      phrasesHeld = 0;
      later(span - 120, advanceHarmony);
    }

    later(span, schedulePhrase);
  }

  /**
   * Harp figures. The one part of the score that plays in time with itself.
   *
   * Notes come in short rising or falling runs rather than singly, because two
   * notes a second apart are two events and five notes a fifth of a second
   * apart are a phrase, and a phrase is what the ear accepts as music. The run
   * is drawn from the chord, so it stays consonant with whatever the pads and
   * strings are holding, and the spacing is uneven so it reads as played rather
   * than sequenced.
   */
  function scheduleHarp() {
    if (!ctx || muted) {
      later(5000, scheduleHarp);
      return;
    }
    const chord = PROGRESSION[chordIndex];
    // Follows the familiar stems and the sense of scale, which means it thins
    // out rather than stopping as you go somewhere strange: a black hole still
    // carries some awe and some deep, so a few notes reach it. The one place it
    // genuinely falls silent is a mix that is nothing but void, where there is
    // no stem left for it to play into.
    const present = mix.home + mix.land * 0.9 + mix.approach * 0.8
      + mix.deep * 0.6 + mix.leave * 0.6 + mix.awe;
    if (present > 0.2) {
      const strength = clamp(present, 0, 1.6);
      const tones = pick(chord.full, 57, 88, 7);
      const run = 3 + ((Math.random() * 3) | 0);
      const from = (Math.random() * Math.max(tones.length - run, 1)) | 0;
      const rising = Math.random() < 0.6;
      let when = 0;
      for (let i = 0; i < run; i++) {
        const note = tones[from + (rising ? i : run - 1 - i)] ?? tones[from];
        // Later notes in a run are played more lightly, the way a hand relaxes
        // across a gesture.
        const peak = (0.03 - i * 0.004) * strength;
        later(when, () => {
          if (ctx && !muted) makePluck(ctx, parts.harpDest, note, Math.max(peak, 0.008));
        });
        when += 150 + Math.random() * 170;
      }
    }
    // Much rarer and much quieter than it was. The harp was added to give the
    // beds an attack to hold on to, and now that a piano is playing that job is
    // taken; at the old rate two plucked instruments trade runs over each other
    // and the piano stops sounding like the lead.
    later(14000 + Math.random() * 16000, scheduleHarp);
  }

  function scheduleShimmer() {
    if (!ctx || muted) {
      later(6000, scheduleShimmer);
      return;
    }
    const chord = PROGRESSION[chordIndex];
    const space = mix.deep + mix.leave * 0.6 + mix.approach * 0.5 + mix.awe * 0.8;
    if (space > 0.18) {
      const high = pick(chord.full, 72, 96, 6);
      makeShimmer(ctx, parts.shimmerDest, high[(Math.random() * high.length) | 0],
        0.012 + Math.min(space, 1.6) * 0.014);
    }
    later(5000 + Math.random() * 11000, scheduleShimmer);
  }

  function build() {
    master = ctx.createGain();
    master.gain.value = muted ? 0 : LEVEL;

    // Warmth without muffling. The old chain put a lowpass at 1650 Hz across
    // everything, which is why shimmer and choir could not be heard: they live
    // above it. A shelf that tilts the top down a few decibels does the warming
    // instead, and the lowpass sits up at 13 kHz where it only removes the
    // brittleness of digital sawtooths.
    // Below about 20 Hz there is nothing to hear, only headroom to lose and DC
    // for the saturators to turn into offset. This is the only high-pass in the
    // chain and it is deliberately below the lowest note in the score.
    const rumble = ctx.createBiquadFilter();
    rumble.type = 'highpass';
    rumble.frequency.value = 20;
    rumble.Q.value = 0.7;

    const tilt = ctx.createBiquadFilter();
    tilt.type = 'highshelf';
    tilt.frequency.value = 3800;
    tilt.gain.value = -5.5;
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = 13000;
    air.Q.value = 0.6;
    // Only here to stop stem sums adding up past the ceiling. The attack is
    // deliberately far slower than a piano note's, so the compressor rides the
    // average and never grabs an individual strike — when the score was all
    // sustain that did not matter, and now that it is all transient it is the
    // difference between a piano and a piano behind a pumping door.
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -20;
    glue.knee.value = 22;
    glue.ratio.value = 2.2;
    glue.attack.value = 0.35;
    glue.release.value = 1.4;

    // A hard ceiling, so no combination of stems can ever clip however the
    // weights are driven. A waveshaper clamps its input to ±1, so the signal is
    // scaled down by four first and the curve shaped over that range: the result
    // is unity gain below about -12 dBFS, under a decibel of compression at -6,
    // and an asymptote at -0.4 dBFS that cannot be exceeded. On material with no
    // transients this is inaudible until it is genuinely needed.
    const trim = ctx.createGain();
    trim.gain.value = 0.25;
    const ceiling = ctx.createWaveShaper();
    const curve = new Float32Array(2049);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(4.21 * x);
    }
    ceiling.curve = curve;
    const makeup = ctx.createGain();
    makeup.gain.value = 0.95;

    master.connect(rumble);
    rumble.connect(tilt);
    tilt.connect(air);
    air.connect(glue);
    glue.connect(trim);
    trim.connect(ceiling);
    ceiling.connect(makeup);
    makeup.connect(ctx.destination);

    // Two spaces, not one. The short one gives every voice a room to stand in so
    // nothing sounds dry and synthetic; the long one is the sense of scale, and
    // only the things that should sound distant are sent much of it.
    const room = ctx.createConvolver();
    room.buffer = reverbImpulse(ctx, { seconds: 2.4, decay: 2.2, damp: 0.55, preDelay: 0.012 });
    const roomSend = ctx.createGain();
    roomSend.gain.value = 0.5;
    const roomOut = ctx.createGain();
    roomOut.gain.value = 0.55;
    roomSend.connect(room);
    room.connect(roomOut);
    roomOut.connect(master);

    const hall = ctx.createConvolver();
    hall.buffer = reverbImpulse(ctx, { seconds: 11, decay: 3.1, damp: 0.34, preDelay: 0.06 });
    const hallSend = ctx.createGain();
    hallSend.gain.value = 0.5;
    const hallOut = ctx.createGain();
    hallOut.gain.value = 0.62;
    hallSend.connect(hall);
    hall.connect(hallOut);
    hallOut.connect(master);

    const dry = ctx.createGain();
    dry.gain.value = 0.62;
    dry.connect(master);

    // How much of each stem goes to the long tail. Home and land are close and
    // personal; deep space and the void are enormous.
    const HALL = {
      home: 0.3, leave: 0.6, deep: 0.95, approach: 0.7,
      land: 0.34, alien: 0.75, void: 0.9, wonder: 0.85,
    };
    for (const name of STEM_NAMES) {
      const g = ctx.createGain();
      g.gain.value = name === 'home' ? 0.95 : 0;
      g.connect(dry);
      g.connect(roomSend);
      const toHall = ctx.createGain();
      toHall.gain.value = HALL[name];
      g.connect(toHall);
      toHall.connect(hallSend);
      stems[name] = g;
    }

    // Home: warm, close, uncomplicated. Nothing here is allowed to sound
    // synthetic or vast — this is the stem that has to feel like a place.
    parts.homePad = createPad(ctx, stems.home, {
      notes: 4, cutoff: 1500, q: 0.9, detune: 5, breathe: 0.3,
      types: ['sine', 'triangle', 'sine'],
    });
    parts.homeSub = createSub(ctx, stems.home);
    parts.homeStrings = createStrings(ctx, stems.home, { notes: 4 });
    parts.homeAir = createAir(ctx, stems.home, { freq: 340, q: 0.45 });
    // Silent. The noise beds were the "background noise still going on": a
    // filtered hiss under a piano piece has nothing to contribute and is the
    // first thing you hear when the piano rests. Kept wired up rather than
    // deleted, because room tone is worth having on a planet surface later and
    // the graph is the only place that knowledge lives.
    parts.homeAir.set(0, 6);

    // Leaving: the same harmony an octave and a half down, through a darker
    // filter, with the sub coming up. Scale arriving as weight, not as volume.
    parts.leavePad = createPad(ctx, stems.leave, {
      notes: 4, cutoff: 620, q: 1.5, detune: 11, breathe: 0.4,
      types: ['sawtooth', 'triangle', 'sine'],
    });
    parts.leaveSub = createSub(ctx, stems.leave);
    parts.leaveStrings = createStrings(ctx, stems.leave, { notes: 4 });
    parts.leaveAir = createAir(ctx, stems.leave, { freq: 260, q: 0.4, sweep: 0.08 });
    parts.leaveAir.set(0, 8);

    // Deep space: the widest voicing in the score, the slowest breathing, and
    // almost nothing happening. The pulse is barely there.
    parts.deepPad = createPad(ctx, stems.deep, {
      notes: 5, cutoff: 900, q: 1.2, detune: 9, breathe: 0.55, spread: 0.95,
      types: ['sine', 'triangle', 'sine'],
    });
    parts.deepSub = createSub(ctx, stems.deep);
    parts.deepStrings = createStrings(ctx, stems.deep, { notes: 4 });
    parts.deepPulse = createPulse(ctx, stems.deep, { rate: 0.048 });
    parts.deepAir = createAir(ctx, stems.deep, { freq: 620, q: 0.35, sweep: 0.09 });
    parts.deepAir.set(0, 10);

    // Approaching: harmony thickens and the choir arrives. Strings swell, they
    // do not stab — there is no percussion and no acceleration anywhere here.
    parts.approachPad = createPad(ctx, stems.approach, {
      notes: 4, cutoff: 1250, q: 1, detune: 8, breathe: 0.3,
    });
    parts.approachStrings = createStrings(ctx, stems.approach, { notes: 4 });
    parts.approachChoir = createChoir(ctx, stems.approach, { notes: 4, level: 0.9 });

    // Landing: close, small, human. Piano and a soft pad, a little wind.
    parts.landPad = createPad(ctx, stems.land, {
      notes: 4, cutoff: 1700, q: 0.8, detune: 4, breathe: 0.25, spread: 0.5,
      types: ['sine', 'triangle', 'sine'],
    });
    parts.landSub = createSub(ctx, stems.land);
    parts.landStrings = createStrings(ctx, stems.land, { notes: 4 });
    parts.landAir = createAir(ctx, stems.land, { freq: 480, q: 0.6, sweep: 0.1 });
    parts.landAir.set(0, 7);

    // Alien: in key, but voiced in fourths and fifths with the third missing, so
    // it is consonant and still unplaceable. The whole stem is detuned by a few
    // cents against everything else, which beats slowly and is most of why it
    // feels wrong in a way that is hard to name. Bells rather than piano.
    parts.alienPad = createPad(ctx, stems.alien, {
      notes: 5, cutoff: 1100, q: 1.8, detune: 14, breathe: 0.5, spread: 0.9,
      types: ['triangle', 'sine', 'sawtooth'], bias: 16,
    });
    parts.alienSub = createSub(ctx, stems.alien);
    parts.alienAir = createAir(ctx, stems.alien, { freq: 900, q: 0.8, sweep: 0.12 });
    parts.alienAir.set(0, 8);

    // The void: sub-bass and slow pulses, and essentially no melody. Loud in the
    // register nothing else occupies, quiet everywhere else.
    parts.voidSub = createSub(ctx, stems.void);
    parts.voidPulse = createPulse(ctx, stems.void, { rate: 0.032 });
    parts.voidAir = createAir(ctx, stems.void, { freq: 130, q: 0.5, sweep: 0.07 });
    parts.voidAir.set(0, 9);

    // Wonder: the build. Strings, choir and a high pad, all driven by `awe`, and
    // the pad squared so it only arrives at the very top — the climax should
    // feel earned rather than switched on.
    parts.wonderStrings = createStrings(ctx, stems.wonder, { notes: 4 });
    parts.wonderChoir = createChoir(ctx, stems.wonder, { notes: 4, level: 1 });
    parts.wonderPad = createPad(ctx, stems.wonder, {
      notes: 4, cutoff: 4200, q: 0.7, detune: 6, breathe: 0.35, spread: 1,
      types: ['sine', 'sine', 'triangle'],
    });

    // Transient sources are sent to the stems that should carry them, so a
    // piano note is only audible when the mix is somewhere a piano belongs.
    // The piano gets its own bus into the master rather than being fanned out
    // across the stems.
    //
    // Routing it through the stems was the obvious way to make it audible
    // everywhere, and it is wrong: a stem send is multiplied by that stem's
    // weight, so a voice connected to all eight comes out multiplied by the sum
    // of the weights. That sum runs from about 1 at home to 2.85 over a moon,
    // which is a nine decibel swing in how loud the melody is for no musical
    // reason, and it is why the piano sat under the beds in the two places you
    // spend the most time and over the top of them everywhere else. One bus
    // with one gain means the balance is a number I set rather than a side
    // effect of where the camera is.
    parts.pianoBus = ctx.createGain();
    parts.pianoBus.gain.value = 1;
    // Through the same two spaces every stem uses, not straight to the master.
    // A piano with no room around it is the one thing that would give away that
    // this is synthesis, and the long tail is where the sense of scale lives.
    parts.pianoBus.connect(dry);
    parts.pianoBus.connect(roomSend);
    parts.pianoHall = ctx.createGain();
    parts.pianoHall.gain.value = 0.35;
    parts.pianoBus.connect(parts.pianoHall);
    parts.pianoHall.connect(hallSend);
    parts.pianoDest = ctx.createGain();
    parts.pianoDest.connect(parts.pianoBus);
    parts.bellDest = ctx.createGain();
    parts.bellDest.connect(stems.alien);
    parts.shimmerDest = ctx.createGain();
    parts.shimmerDest.connect(stems.deep);
    parts.shimmerDest.connect(stems.wonder);
    // The harp shares the piano's bus, for the same reason and so the two
    // plucked voices keep a fixed balance with each other wherever you are.
    parts.harpDest = ctx.createGain();
    parts.harpDest.connect(parts.pianoBus);
  }

  async function start() {
    if (started) {
      if (autoResume && ctx.state === 'suspended') await ctx.resume();
      return;
    }
    started = true;
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    build();
    voiceHarmony();
    if (schedule) {
      later(600, schedulePhrase);
      later(6000, scheduleShimmer);
      later(1800, scheduleHarp);
    }
    lastApply = -1e9;
    apply();
    if (autoResume && ctx.state === 'suspended') await ctx.resume();
  }

  function apply() {
    const now = ctx.currentTime;
    for (const name of STEM_NAMES) {
      const g = stems[name];
      if (!g) continue;
      g.gain.cancelScheduledValues(now);
      // Long enough that no move between places is ever heard as a cut, short
      // enough that arriving somewhere new is felt while you are still arriving.
      g.gain.setTargetAtTime(clamp(mix[name] ?? 0, 0, 1), now, 4.5 * glideScale);
    }

    // The piano's own level. It barely moves — the melody should not duck and
    // swell as you fly around, which is exactly what fanning it across the
    // stems used to do. All that changes is a little lift where the score wants
    // to be playing to you and a little restraint out in the empty places,
    // where the writing already thins itself out.
    if (parts.pianoBus) {
      const near = clamp(mix.home + mix.land + mix.approach * 0.7, 0, 1.4);
      const empty = clamp(mix.deep * 0.7 + mix.void, 0, 1.4);
      // Its own bus means the stem gains are no longer in front of it, so
      // taking every stem to zero would leave the piano playing on alone. That
      // is not a hypothetical: it is how the score is silenced. Presence brings
      // it down with the rest of the mix, but reaches full well before any real
      // scene does, so the level stays flat everywhere you can actually be.
      const total = STEM_NAMES.reduce((sum, n) => sum + clamp(mix[n] ?? 0, 0, 1), 0);
      const presence = clamp(total / 0.3, 0, 1);
      const level = clamp(0.92 + near * 0.16 - empty * 0.22, 0.6, 1.15) * presence;
      parts.pianoBus.gain.cancelScheduledValues(now);
      parts.pianoBus.gain.setTargetAtTime(level, now, 4.5 * glideScale);
    }
    // How much room the piano is playing in. Close to home it is a room; out in
    // deep space and over a black hole it is the long tail, which is the only
    // thing in the score that still says "vast" now that the drones are gone.
    if (parts.pianoHall) {
      const vast = clamp(mix.deep * 0.8 + mix.void + mix.leave * 0.5
        + mix.awe * 0.6 + mix.alien * 0.5, 0, 1.6);
      parts.pianoHall.gain.cancelScheduledValues(now);
      parts.pianoHall.gain.setTargetAtTime(clamp(0.3 + vast * 0.45, 0.3, 1),
        now, 4.5 * glideScale);
    }

    voiceHarmony();
  }

  function updateScene(next) {
    if (!next) return;
    mix = { ...mix, ...next };
    if (!started || !ctx) return;
    if (ctx.currentTime - lastApply < 0.75) return;
    lastApply = ctx.currentTime;
    apply();
  }

  function setMuted(value) {
    muted = value;
    if (master && ctx) {
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setTargetAtTime(muted ? 0 : LEVEL, now, 0.35);
    }
    if (!muted) start();
  }

  function dispose() {
    for (const id of timers) clearTimeout(id);
    timers = [];
    if (ctx && ctx.close) ctx.close();
    ctx = null;
    started = false;
  }

  return {
    start,
    setMuted,
    updateScene,
    dispose,
    get muted() { return muted; },
    // Exposed for the offline render test, which drives the graph without a
    // wall clock and needs to place the harmony and the transients by hand.
    _internals: {
      get ctx() { return ctx; },
      get parts() { return parts; },
      get stems() { return stems; },
      chords: PROGRESSION,
      setChord(i) { chordIndex = i % PROGRESSION.length; voiceHarmony(); },
      setGlideScale(v) { glideScale = v; },
      /** Fire one transient now, so the test can place them at known times. */
      strike(kind, note, peak) {
        if (kind === 'piano') makePiano(ctx, parts.pianoDest, note, peak);
        if (kind === 'bell') makeBell(ctx, parts.bellDest, note, peak);
        if (kind === 'shimmer') makeShimmer(ctx, parts.shimmerDest, note, peak);
        if (kind === 'harp') makePluck(ctx, parts.harpDest, note, peak);
      },
      /**
       * Write one phrase of the piano part into an offline render at `at`
       * seconds, and report how long it runs for.
       *
       * The offline test has no wall clock, so the live scheduler never fires in
       * it. Without this the render measures the beds alone — which is how a
       * score whose piano had gone quiet everywhere but two stems could still
       * pass every level check it had. The test now hears the same notes the
       * player does, because both come out of `planPhrase`.
       */
      renderPhrase(at) {
        const phrase = planPhrase();
        for (const n of phrase.notes) {
          makePiano(ctx, parts.pianoDest, n.note, n.peak, at + n.at);
        }
        return phrase;
      },
      /** Write a phrase without playing it, to inspect what was composed. */
      planPhrase() { return planPhrase(); },
      /** Advance the progression on the phrase grid, for offline renders. */
      nextChord() { advanceHarmony(); },
      /** Jump straight to a mix, for offline rendering where time does not pass. */
      snap(next) {
        mix = { ...mix, ...next };
        lastApply = -1e9;
        apply();
      },
    },
  };
}
