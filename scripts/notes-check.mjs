/**
 * Reads the piano part as notes rather than as a level.
 *
 * The audition renders audio and measures it, which will tell you the score is
 * loud enough and has top end and does not clip, and will happily pass a part
 * that is one note struck over and over. What it cannot see is whether what was
 * composed is music: whether the melody has more than a couple of distinct
 * pitches in it, whether everything stays in key, whether the phrase actually
 * lands on a beat. So this asks the scheduler for phrases and prints them.
 *
 * Usage: node scripts/notes-check.mjs [scene]
 */
import puppeteer from 'puppeteer-core';

const URL = 'http://127.0.0.1:5179/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const SCENES = {
  home: { home: 1, leave: 0.05 },
  deep: { deep: 0.95, leave: 0.15 },
  land: { land: 0.9, home: 0.15, approach: 0.15 },
  alien: { alien: 0.9, land: 0.4, deep: 0.25, awe: 0.5, wonder: 0.5 },
  wonder: { deep: 0.5, approach: 0.6, awe: 1, wonder: 1 },
  void: { void: 1, deep: 0.22, awe: 0.4, wonder: 0.2 },
};

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// The score is in A minor with no accidentals, so anything black is a mistake.
const IN_KEY = new Set([0, 2, 4, 5, 7, 9, 11]);
const spell = (m) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--headless=new', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setRequestInterception(true);
page.on('request', (r) => {
  if (r.url() === `${URL}notes` && r.resourceType() === 'document') {
    r.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>n</title>' });
    return;
  }
  r.continue();
});
await page.goto(`${URL}notes`, { waitUntil: 'domcontentloaded', timeout: 60000 });

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const wanted = only.length ? only : Object.keys(SCENES);
const failures = [];

for (const name of wanted) {
  const mix = SCENES[name];
  if (!mix) {
    console.error(`unknown scene: ${name}`);
    continue;
  }
  const phrases = await page.evaluate(async ({ base, mix }) => {
    const mod = await import(`${base}src/engine/ambient.js`);
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    const ambient = mod.createAmbient({ context: ctx, autoResume: false, schedule: false });
    ambient._internals.setGlideScale(0.015);
    await ambient.start();
    ambient._internals.snap(mix);
    const out = [];
    for (let i = 0; i < 8; i++) {
      if (i > 0 && i % 2 === 0) ambient._internals.nextChord();
      out.push(ambient._internals.planPhrase());
    }
    return out;
  }, { base: URL, mix });

  console.log(`\n${name}`);
  const pitches = new Set();
  let stuck = 0;
  for (const [i, p] of phrases.entries()) {
    const sorted = [...p.notes].sort((a, b) => a.at - b.at);
    for (const n of sorted) {
      pitches.add(n.note);
      if (!IN_KEY.has(((n.note % 12) + 12) % 12)) {
        failures.push(`${name}: ${spell(n.note)} is not in the key`);
      }
    }
    // Three of the same pitch in a row above the bass. Two is a held note and
    // idiomatic; three every phrase is what a melody looks like when the pool
    // it is drawn from has fewer pitches in it than the motif has steps, which
    // is a bug that sounds like a stuck key and passes every level check.
    const melody = sorted.filter((n) => n.note >= 55);
    for (let k = 2; k < melody.length; k++) {
      if (melody[k].note === melody[k - 1].note && melody[k].note === melody[k - 2].note) {
        stuck++;
        break;
      }
    }
    const line = sorted
      .map((n) => `${(n.at / 0.86).toFixed(1)}:${spell(n.note)}`)
      .join('  ');
    console.log(`  ${String(i + 1).padStart(2)}. ${line}`);
  }
  // A part that keeps landing on the same two or three pitches reads as a
  // pattern rather than a tune, and is the most likely way for generated
  // melody to go wrong while every level check still passes.
  console.log(`      ${pitches.size} distinct pitches over 8 phrases, `
    + `${stuck} with a note struck three times running`);
  if (pitches.size < 8) failures.push(`${name}: only ${pitches.size} distinct pitches`);
  if (stuck > 2) failures.push(`${name}: ${stuck} of 8 phrases hammer one pitch`);
}

await browser.close();

if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('\nnotes look musical');
