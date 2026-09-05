/**
 * Ground view capture and exposure check.
 *
 * Points the sky view at a body, magnifies it until the terrain renderer has
 * taken over, and writes a screenshot along with the brightness of the disc.
 *
 * The numbers are the point of it. "Too bright" is easy to see and awkward to
 * argue about, and a disc that has clipped to white looks fine in a thumbnail
 * while having lost every marking on it. So each shot reports the mean level of
 * the lit disc and the fraction of it within a whisker of full scale: anything
 * with a clipped fraction above a percent or two has detail that is simply gone.
 *
 * Usage: node scripts/ground-shots.mjs [body ...]
 */
import fs from 'node:fs';
import path from 'node:path';

import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5173/sky.html';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots');
fs.mkdirSync(OUT, { recursive: true });

// A date and time when all of these are up at once, so one run covers them all.
const WHEN = '2026-08-27T21:30:00';

/**
 * A night when a body is high and well lit.
 *
 * Worth the search: pointed at a thin crescent, a deep zoom into the middle of
 * the disc lands on the unlit side and photographs nothing, which looks exactly
 * like a broken renderer.
 */
async function findGoodNight(page, key, { minAltitude = 15, targetPhase = 0.75 } = {}) {
  return page.evaluate(
    ({ bodyKey, minAlt, wantPhase }) => {
      const start = Date.UTC(2026, 7, 27);
      let best = null;
      // Phase matters most, and by a long way, but a full Moon is the wrong
      // target: at zero phase angle the Sun is directly behind the viewer, every
      // shadow is hidden behind whatever cast it, and the surface photographs
      // flat. That is exactly why a full Moon looks flat overhead. Three quarters
      // lit puts the Sun forty degrees off vertical over the middle of the disc,
      // which is lit ground with relief you can see.
      //
      // Hourly for two months, scored rather than filtered, because whether a
      // given phase is ever up in a dark sky depends on the viewer's latitude and
      // the time of year.
      for (let step = 0; step < 24 * 60; step++) {
        const when = new Date(start + step * 3600 * 1000);
        window.cosminova.setDate(when.toISOString());
        const info = window.cosminova.bodyInfo(bodyKey);
        const sun = window.cosminova.bodyInfo('sun');
        if (!info || !sun) return null;
        const score =
          4 * (1 - Math.abs(info.phase - wantPhase)) +
          Math.min(Math.max(info.altitude, 0), 60) / 60 +
          (sun.altitude < -6 ? 1 : 0);
        if (!best || score > best.score) {
          best = { score, iso: when.toISOString(), altitude: info.altitude, phase: info.phase };
        }
        if (
          info.altitude > minAlt &&
          Math.abs(info.phase - wantPhase) < 0.04 &&
          sun.altitude < -6
        ) {
          break;
        }
      }
      return best;
    },
    { bodyKey: key, minAlt: minAltitude, wantPhase: targetPhase },
  );
}

const TARGETS = {
  jupiter: { fov: 0.02, description: 'Jupiter, belts across half the frame' },
  saturn: { fov: 0.03, description: 'Saturn and rings' },
  moon: { fov: 0.62, description: 'The whole Moon', needsLitSurface: true },
  // The deep zooms drop the atmosphere. Not to flatter the renderer: a telescopic
  // field at any real altitude is looking through enough air to veil a dark
  // surface completely, and the question these shots answer is whether the
  // terrain is there and detailed, which the sky glow would hide either way.
  moonDeep: {
    body: 'moon',
    fov: 0.004,
    mode: 'space',
    description: 'Lunar surface at a quarter of an arcminute',
    needsLitSurface: true,
  },
  moonDeeper: {
    body: 'moon',
    fov: 0.002,
    mode: 'space',
    description: 'Lunar surface, near the floor of the zoom',
    needsLitSurface: true,
  },
  saturnDeep: {
    body: 'saturn',
    fov: 0.004,
    mode: 'space',
    description: 'Saturn ring detail',
  },
  mars: { fov: 0.01, description: 'Mars' },
  venus: { fov: 0.02, description: 'Venus, a thick crescent' },
};

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(TARGETS);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-angle=metal'],
  defaultViewport: { width: 1024, height: 768, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });

let failed = false;

for (const name of names) {
  const target = TARGETS[name];
  if (!target) {
    console.log(`${name}: no such target`);
    continue;
  }
  const key = target.body ?? name;

  // The deep zooms need a lit surface under the crosshair, which means waiting
  // for a gibbous Moon rather than using the same evening as everything else.
  let when = WHEN;
  if (target.needsLitSurface) {
    const night = await findGoodNight(page, key);
    if (!night) {
      console.log(`${name}: found no night with ${key} high and well lit`);
      failed = true;
      continue;
    }
    when = night.iso;
    console.log(
      `${name}: ${night.iso.replace('T', ' ').slice(0, 16)}, ` +
        `${night.altitude.toFixed(0)}° up, ${(night.phase * 100).toFixed(0)}% lit`,
    );
  }

  // Time is stopped, or the sky's rotation would carry the body out of a
  // telescopic frame during the settling wait.
  await page.evaluate(
    ({ at, bodyKey, fov, mode }) => {
      window.cosminova.setRate(0);
      window.cosminova.setDate(at);
      window.cosminova.setMode(mode);
      window.cosminova.lookAtBody(bodyKey, fov);
    },
    { at: when, bodyKey: key, fov: target.fov, mode: target.mode ?? 'ground' },
  );

  // Imagery arrives in tiers and the terrain settles over several frames.
  await new Promise((r) => setTimeout(r, 6000));

  const file = path.join(OUT, `ground-${name}.png`);
  const buffer = await page.screenshot({ encoding: 'binary' });
  fs.writeFileSync(file, buffer);

  // The middle of the frame, which holds the body and none of the interface. A
  // threshold against the sky is no use here: near the horizon the sky itself is
  // well off black, so brightness is judged from the top of the distribution
  // instead, and against a reading of the sky taken from the same frame.
  const meta = await sharp(buffer).metadata();
  const crop = {
    left: Math.round(meta.width * 0.2),
    top: Math.round(meta.height * 0.2),
    width: Math.round(meta.width * 0.6),
    height: Math.round(meta.height * 0.6),
  };
  const { data } = await sharp(buffer)
    .extract(crop)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const sorted = Uint8Array.from(data).sort();
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  const sky = at(0.2) / 255;
  const highlight = at(0.999) / 255;
  let clipped = 0;
  let lit = 0;
  let litTotal = 0;
  const litThreshold = at(0.2) + 12;
  for (let i = 0; i < data.length; i++) {
    if (data[i] >= 250) clipped++;
    if (data[i] > litThreshold) {
      lit++;
      litTotal += data[i];
    }
  }
  const clippedFraction = clipped / data.length;
  const coverage = lit / data.length;
  const mean = lit ? litTotal / lit / 255 : 0;

  const missing = coverage < 0.005;
  const verdict = missing
    ? 'NOTHING THERE'
    : clippedFraction > 0.01
      ? 'BLOWN OUT'
      : mean > 0.85
        ? 'very bright'
        : 'ok';
  if (missing || clippedFraction > 0.01) failed = true;
  console.log(
    `${name.padEnd(10)} lit ${(coverage * 100).toFixed(1).padStart(5)}% of centre  ` +
      `mean ${mean.toFixed(3)}  peak ${highlight.toFixed(3)}  sky ${sky.toFixed(3)}  ` +
      `clipped ${(clippedFraction * 100).toFixed(2)}%  ${verdict}`,
  );
}

await browser.close();

if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const error of [...new Set(errors)].slice(0, 8)) console.log(`  ${error}`);
  failed = true;
}

process.exit(failed ? 1 : 0);
