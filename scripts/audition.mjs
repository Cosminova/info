/**
 * Headless listening harness for the score.
 *
 * Renders each scene of ambient.js through an OfflineAudioContext in real
 * Chrome, then reports level, crest factor and the spread of energy across
 * seven bands. That is not the same as listening to it, but it catches the
 * things that are actually wrong rather than merely unmusical: a stem that
 * makes no sound, a mix that clips, a modulator driving a gain negative, DC on
 * the output, a scene with nothing above 3 kHz because a filter is in the way,
 * or a sub that exists only below what a laptop speaker can reproduce.
 *
 * Writes a WAV per scene to skyview/audio-check/ so the result can be listened
 * to properly, and exits non-zero if any check fails.
 *
 * Usage: node scripts/audition.mjs [scene ...]
 *        node scripts/audition.mjs --seconds 60
 *        node scripts/audition.mjs --beds     (accompaniment without the piano)
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('audio-check');

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const boolean = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
// Booleans first: a boolean flag must not consume the token after it, or the
// first scene name on the command line silently disappears.
// The piano part plays unless you ask for it not to. It used to be opt-in via
// --tour, from when it was a garnish on the beds; it is the score now, so a
// render without it is not a configuration the player can ever hear, and
// judging levels on one means judging music nobody listens to. `--beds` still
// renders the accompaniment alone, which is the useful thing to look at when
// asking how loud the background actually is under the melody.
const BEDS_ONLY = boolean('beds');
const TOUR = !BEDS_ONLY;
const SECONDS = Number(value('seconds', 30));

// Each scene is the weight set sceneWeights would produce somewhere, named for
// where that is. Kept explicit rather than derived so a scene can be auditioned
// without also depending on the camera mapping being right.
const SCENES = {
  home: { home: 1, leave: 0.05 },
  leave: { home: 0.35, leave: 0.9, deep: 0.2 },
  deep: { deep: 0.95, leave: 0.15 },
  approach: { deep: 0.4, approach: 0.85, awe: 0.35, wonder: 0.35 },
  land: { land: 0.9, home: 0.15, approach: 0.15 },
  alien: { alien: 0.9, land: 0.4, deep: 0.25, awe: 0.5, wonder: 0.5 },
  void: { void: 1, deep: 0.22, awe: 0.4, wonder: 0.2 },
  wonder: { deep: 0.5, approach: 0.6, awe: 1, wonder: 1 },
  // Every stem at once. sceneWeights never asks for this, so it is not judged on
  // loudness — it is here to prove the output cannot be driven past the ceiling
  // however the weights are abused, and that eight stems at full weight still
  // agree about the chord.
  everything: {
    home: 1, leave: 1, deep: 1, approach: 1,
    land: 1, alien: 1, void: 1, wonder: 1, awe: 1,
  },
  silence: {
    home: 0, leave: 0, deep: 0, approach: 0,
    land: 0, alien: 0, void: 0, wonder: 0, awe: 0,
  },
};

const BANDS = [
  ['sub', 20, 60],
  ['low', 60, 150],
  ['lowmid', 150, 400],
  ['mid', 400, 1000],
  ['himid', 1000, 3000],
  ['high', 3000, 8000],
  ['air', 8000, 16000],
];

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const problems = [];
page.on('console', (m) => {
  const text = m.text();
  // The stub document has no favicon; that 404 is not a finding.
  if (m.type() === 'error' && !text.includes('404')) problems.push(`console: ${text}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.stack ?? e.message}`));

// A stub document on the dev server's origin, so the module and its imports
// resolve normally without loading the whole renderer just to test audio.
await page.setRequestInterception(true);
page.on('request', (request) => {
  if (request.url() === `${URL}audition` && request.resourceType() === 'document') {
    request.respond({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><title>audition</title>',
    });
    return;
  }
  request.continue();
});
await page.goto(`${URL}audition`, { waitUntil: 'domcontentloaded', timeout: 60000 });

const ok = await page.evaluate(async (base) => {
  const mod = await import(`${base}src/engine/ambient.js`);
  window.__ambient = mod;
  return typeof mod.createAmbient === 'function' && typeof mod.sceneWeights === 'function';
}, URL);
if (!ok) {
  console.error('ambient.js did not load or is missing its exports');
  for (const p of problems) console.error(`  ${p}`);
  await browser.close();
  process.exit(1);
}

/**
 * Render one scene offline and return both the analysis and the samples.
 *
 * The measurement window starts well after the render does: the long reverb is
 * eleven seconds and has to fill before the level means anything, and the pads
 * breathe on cycles tens of seconds long, so a short window lands on an
 * arbitrary point of the swell.
 */
async function render(mix, seconds, tour) {
  return page.evaluate(async ({ mix, seconds, tour, bands }) => {
    const rate = 48000;
    const ctx = new OfflineAudioContext(2, Math.ceil(rate * seconds), rate);
    const ambient = window.__ambient.createAmbient({
      context: ctx,
      autoResume: false,
      schedule: false,
    });
    // Time does not pass while an offline context renders, so the glides have to
    // be collapsed; otherwise a twenty-second pad swell never arrives.
    ambient._internals.setGlideScale(0.015);
    await ambient.start();
    ambient._internals.snap(mix);

    const inner = ambient._internals;
    const failures = [];
    if (tour) {
      // Play the actual piano part, phrase by phrase, changing chord every two
      // phrases the way the live scheduler does.
      //
      // This used to hand-place a few isolated notes, which measured a piano
      // that does not exist: the real part is a left hand and a five-note motif
      // per phrase, several times as many notes and several times the level.
      // Phrases go down on a fixed grid with no rests, so what comes back is
      // the busiest the score ever gets — the right case for a headroom check.
      const PHRASE = 8 * 0.86;
      const count = Math.max(Math.floor((seconds - 1) / PHRASE), 1);
      for (let i = 0; i < count; i++) {
        // Whatever happens in here, resume. A throw inside a suspend callback
        // leaves the context suspended with nobody left to restart it, and
        // `startRendering` then never settles — the render does not fail, it
        // hangs, and the harness dies on a protocol timeout minutes later with
        // nothing to say about why.
        ctx.suspend(0.25 + i * PHRASE).then(() => {
          try {
            if (i > 0 && i % 2 === 0) inner.nextChord();
            inner.renderPhrase(ctx.currentTime);
            // Bells and shimmer are occasional colour over the piano; the harp
            // is rare now, so one run every few phrases rather than every one.
            if (i % 3 === 0) inner.strike('bell', 72, 0.018);
            if (i % 2 === 0) inner.strike('shimmer', 84, 0.02);
            if (i % 4 === 1) {
              for (let k = 0; k < 4; k++) {
                inner.strike('harp', 64 + [0, 4, 7, 11][k], 0.028 - k * 0.004);
              }
            }
          } catch (err) {
            failures.push(`phrase ${i}: ${err && err.message}`);
          }
          ctx.resume();
        });
      }
    }

    const buffer = await ctx.startRendering();
    const L = buffer.getChannelData(0);
    const R = buffer.getChannelData(1);
    const from = Math.floor(buffer.length * 0.45);

    let peak = 0;
    let sum = 0;
    let dc = 0;
    let bad = 0;
    let width = 0;
    for (let i = from; i < buffer.length; i++) {
      const l = L[i];
      const r = R[i];
      if (!Number.isFinite(l) || !Number.isFinite(r)) bad++;
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      sum += l * l + r * r;
      dc += l + r;
      width += Math.abs(l - r);
    }
    const n = (buffer.length - from) * 2;
    const rms = Math.sqrt(sum / n);
    // Width relative to level, so a loud mono scene does not score wider than a
    // quiet stereo one.
    let mono = 0;
    for (let i = from; i < buffer.length; i++) mono += Math.abs(L[i]) + Math.abs(R[i]);
    const widthRatio = mono > 0 ? width / mono : 0;

    // Band levels from a windowed FFT, averaged over several windows.
    //
    // The first version of this probed each band at six frequencies with a
    // Goertzel, which was wrong in a way worth recording: a single bin is about
    // 3 Hz wide, so a broadband band like 3–8 kHz showed a thousandth of the
    // energy it actually contained and every high band read as empty. Summing
    // power over all the bins in a band gives figures that are comparable
    // between bands and that add up to the overall level.
    const N = 32768;
    const win = new Float32Array(N);
    let winPower = 0;
    for (let i = 0; i < N; i++) {
      win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
      winPower += win[i] * win[i];
    }
    const bits = Math.log2(N);
    const rev = new Uint32Array(N);
    for (let i = 0; i < N; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    const power = new Float64Array(N / 2 + 1);
    const windows = 4;
    let used = 0;
    for (let s = 0; s < windows; s++) {
      const at = from + Math.floor(((buffer.length - from - N) * s) / (windows - 1 || 1));
      if (at < 0 || at + N > buffer.length) continue;
      used++;
      const re = new Float64Array(N);
      const im = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        re[rev[i]] = (L[at + i] + R[at + i]) * 0.5 * win[i];
      }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1;
        const step = (2 * Math.PI) / size;
        for (let i = 0; i < N; i += size) {
          for (let j = 0; j < half; j++) {
            const ang = -step * j;
            const wr = Math.cos(ang);
            const wi = Math.sin(ang);
            const a = i + j;
            const b = a + half;
            const tr = re[b] * wr - im[b] * wi;
            const ti = re[b] * wi + im[b] * wr;
            re[b] = re[a] - tr;
            im[b] = im[a] - ti;
            re[a] += tr;
            im[a] += ti;
          }
        }
      }
      for (let k = 0; k <= N / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    }
    // Parseval, one-sided, corrected for the window: this makes the sum over all
    // bands equal the mean square of the signal.
    const norm = used ? 2 / (N * winPower * used) : 0;
    const energy = {};
    for (const [name, lo, hi] of bands) {
      let sum = 0;
      const kLo = Math.max(1, Math.round((lo * N) / rate));
      const kHi = Math.min(N / 2, Math.round((hi * N) / rate));
      for (let k = kLo; k <= kHi; k++) sum += power[k];
      energy[name] = Math.sqrt(sum * norm);
    }

    const samples = new Float32Array(buffer.length * 2);
    for (let i = 0; i < buffer.length; i++) {
      samples[i * 2] = L[i];
      samples[i * 2 + 1] = R[i];
    }
    return {
      peak,
      rms,
      dc: dc / n,
      bad,
      width: widthRatio,
      energy,
      samples: Array.from(samples),
      length: buffer.length,
      rate,
      failures,
    };
  }, { mix, seconds, tour, bands: BANDS });
}

function writeWav(file, samples, rate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

/**
 * Sweep the camera mapping and find the state whose weights sum highest.
 *
 * The synthetic all-stems case above proves nothing can clip, but the mix that
 * actually needs to be in balance is the loudest one the game can reach. Rather
 * than guess where that is, walk the parameter space and ask.
 */
const worst = await page.evaluate(() => {
  const { sceneWeights } = window.__ambient;
  const kinds = ['body', 'moon', 'exo-planet', 'star', 'galaxy', 'black-hole'];
  const keys = ['earth', 'moon', 'mars', 'titan', 'exo:1'];
  let best = null;
  for (const kind of kinds) {
    for (const key of keys) {
      for (const viewFromEarth of [false, true]) {
        for (let d = 0; d < 40; d++) {
          const distanceRadii = 1.001 * 1.35 ** d;
          for (let s = 0; s < 24; s++) {
            const fromSunKm = 1.4e7 * 1.5 ** s;
            for (let e = 0; e < 20; e++) {
              const earthDistanceKm = 6371 + 1.5 * 4 ** e;
              const w = sceneWeights({
                viewFromEarth, kind, key, distanceRadii, fromSunKm, earthDistanceKm,
              });
              // `awe` drives voicing inside the wonder stem rather than a stem of
              // its own, so it is not part of the loudness sum.
              const total = Object.entries(w)
                .filter(([n]) => n !== 'awe')
                .reduce((a, [, v]) => a + v, 0);
              if (!best || total > best.total) {
                best = { total, mix: w, at: { kind, key, viewFromEarth, distanceRadii, fromSunKm, earthDistanceKm } };
              }
            }
          }
        }
      }
    }
  }
  return best;
});
SCENES.worst = worst.mix;
console.log(
  `worst reachable mix sums to ${worst.total.toFixed(2)} ` +
  `at ${worst.at.kind}/${worst.at.key}, ${worst.at.distanceRadii.toFixed(2)} radii, ` +
  `${(worst.at.fromSunKm / 1.496e8).toFixed(2)} AU`,
);
console.log(
  '  ' + Object.entries(worst.mix)
    .filter(([, v]) => v > 0.001)
    .map(([n, v]) => `${n} ${v.toFixed(2)}`)
    .join('  ') + '\n',
);

const db = (v) => (v > 1e-9 ? (20 * Math.log10(v)).toFixed(1) : '-inf');
const names = args.length ? args : Object.keys(SCENES);
const failures = [];

console.log(`rendering ${SECONDS}s per scene${TOUR ? '' : ', accompaniment only'}\n`);
console.log('scene         peak    rms   crest   width  ' + BANDS.map(([b]) => b.padStart(7)).join(''));

for (const name of names) {
  const mix = SCENES[name];
  if (!mix) {
    console.error(`unknown scene: ${name}`);
    continue;
  }
  const r = await render(mix, SECONDS, TOUR);
  const crest = r.rms > 1e-9 ? 20 * Math.log10(r.peak / r.rms) : 0;
  const bandText = BANDS.map(([b]) => db(r.energy[b]).padStart(7)).join('');
  console.log(
    `${name.padEnd(12)} ${db(r.peak).padStart(6)} ${db(r.rms).padStart(6)} ` +
    `${crest.toFixed(1).padStart(6)} ${r.width.toFixed(4).padStart(7)} ${bandText}`,
  );

  writeWav(path.join(OUT, `${name}.wav`), r.samples, r.rate);

  const fail = (why) => failures.push(`${name}: ${why}`);
  // A phrase that threw is a silent hole in the part, and a level check on a
  // render with holes in it passes for the wrong reason.
  for (const err of r.failures || []) fail(err);
  if (r.bad) fail(`${r.bad} non-finite samples`);
  if (Math.abs(r.dc) > 0.002) fail(`DC offset ${r.dc.toFixed(4)}`);
  if (name === 'silence') {
    if (r.rms > 0.0005) fail(`should be near-silent, rms ${db(r.rms)} dBFS`);
    continue;
  }
  if (r.peak >= 0.999) fail(`clipping, peak ${db(r.peak)} dBFS`);
  if (r.peak > 0.85) fail(`no headroom, peak ${db(r.peak)} dBFS`);
  if (r.rms < 0.012) fail(`too quiet, rms ${db(r.rms)} dBFS`);
  if (r.rms > 0.16 && name !== 'everything') fail(`too loud, rms ${db(r.rms)} dBFS`);
  if (r.width < 0.02) fail(`too close to mono, width ${r.width.toFixed(3)}`);

  // Every scene needs a midrange to have a body, and the ones that are meant to
  // shimmer need real content above 3 kHz — a master lowpass sitting on top of
  // the choir and the shimmer is exactly the mistake this is here to catch.
  const rel = (band) => 20 * Math.log10(Math.max(r.energy[band], 1e-12) / r.rms);
  if (rel('mid') < -34) fail(`no midrange, ${rel('mid').toFixed(0)} dB below level`);
  if (['wonder', 'approach', 'deep', 'alien'].includes(name) && rel('high') < -60) {
    fail(`no top end, ${rel('high').toFixed(0)} dB below level`);
  }
  if (['void', 'leave', 'deep'].includes(name) && rel('sub') + rel('low') < -60) {
    fail('no weight in the bottom octaves');
  }
  // Congestion: when almost everything sits in one low band and the midrange is
  // far beneath it, the chord is heard as mud rather than as harmony.
  const tilt = rel('low') - rel('mid');
  if (tilt > 30) fail(`bass-heavy and congested, low is ${tilt.toFixed(0)} dB over mid`);
}

console.log(`\nwav files in ${path.relative(process.cwd(), OUT)}/`);
for (const p of [...new Set(problems)]) console.error(`  ${p}`);
if (failures.length) {
  console.error('\nfailures:');
  for (const f of failures) console.error(`  ${f}`);
} else {
  console.log('\nall scenes pass');
}

await browser.close();
process.exit(failures.length || problems.length ? 1 : 0);
