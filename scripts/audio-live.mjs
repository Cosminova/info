/**
 * Live check for the score inside the running app.
 *
 * The offline harness proves the music is correct; this proves it is affordable.
 * Audio runs on its own thread but shares the machine with the renderer, and the
 * score is a few hundred oscillators and two convolution reverbs, so the thing
 * worth measuring is what it costs the frame rate. Also confirms the context
 * actually starts from a gesture and that nothing throws once it is running.
 *
 * Usage: node scripts/audio-live.mjs
 */
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5173/';
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new',
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1600,1000',
  ],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.stack ?? e.message}`));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });

const fps = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0;
        const t0 = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
          else resolve((frames * 1000) / (performance.now() - t0));
        };
        requestAnimationFrame(tick);
      }),
  );

// A view with real terrain work to do, so the frame budget is not all slack.
await page.evaluate(() => window.cosminova.lookFromSun('moon', 1.06, 62, 8));
await page.evaluate(() => window.cosminova.loadDetail('moon'));

// Terrain LOD keeps subdividing and the large textures keep decoding for several
// seconds after the view changes, which costs frames. Measuring during that
// makes the baseline far slower than the steady state and the comparison
// worthless — the first attempt at this reported audio as making the app faster.
// So: wait, then measure until two runs agree.
await new Promise((r) => setTimeout(r, 10000));
let silent = await fps();
for (let i = 0; i < 4; i++) {
  const again = await fps();
  const settled = Math.abs(again - silent) / Math.max(silent, 1) < 0.06;
  silent = again;
  if (settled) break;
}

const sceneBefore = await page.evaluate(() => window.cosminova.stats());

// The app arms audio on the first pointer gesture anywhere on the window, so a
// synthetic event on the window is enough. A real click at canvas coordinates
// also works, but it hits the picker and flies the camera somewhere cheaper to
// draw, which is what made the first version of this report that enabling audio
// doubled the frame rate.
await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown')));
await new Promise((r) => setTimeout(r, 3000));

const audioState = await page.evaluate(async () => {
  // Walk every scene through the mapping the way flying around would, and make
  // sure none of it throws while the graph is live.
  const mod = await import('/src/engine/ambient.js');
  const probes = [
    { viewFromEarth: true, key: 'earth', kind: 'body', distanceRadii: 1.02, earthDistanceKm: 6372 },
    { key: 'earth', kind: 'body', distanceRadii: 8, earthDistanceKm: 5e4 },
    { key: 'moon', kind: 'moon', distanceRadii: 2.2, earthDistanceKm: 3.8e5 },
    { key: 'saturn', kind: 'body', distanceRadii: 40, fromSunKm: 1.43e9, earthDistanceKm: 1.4e9 },
    { key: 'titan', kind: 'moon', distanceRadii: 1.5, fromSunKm: 1.43e9, earthDistanceKm: 1.4e9 },
    { key: 'exo:x', kind: 'exo-planet', distanceRadii: 3, fromSunKm: 4e13, earthDistanceKm: 4e13 },
    { key: 'sgr-a', kind: 'black-hole', distanceRadii: 20, fromSunKm: 8e17, earthDistanceKm: 8e17 },
    { key: 'gal:M31', kind: 'galaxy', distanceRadii: 2, fromSunKm: 2e19, earthDistanceKm: 2e19 },
    { key: 'sun', kind: 'star', distanceRadii: 12, fromSunKm: 1e6, earthDistanceKm: 1.5e8 },
  ];
  const weights = probes.map((p) => {
    const w = mod.sceneWeights(p);
    return {
      at: p.key,
      top: Object.entries(w)
        .filter(([, v]) => v > 0.08)
        .sort((a, b) => b[1] - a[1])
        .map(([n, v]) => `${n}:${v.toFixed(2)}`)
        .join(' '),
    };
  });
  return { weights, ctxCount: document.querySelectorAll('canvas').length };
});

// Let the graph reach full level: the stems glide in over about fifteen seconds,
// so measuring immediately measures a quieter and cheaper graph than the one
// that actually plays.
await new Promise((r) => setTimeout(r, 15000));
const playing = await fps();
const sceneAfter = await page.evaluate(() => window.cosminova.stats());

console.log(`fps without audio: ${silent.toFixed(1)}`);
console.log(`fps with audio:    ${playing.toFixed(1)}`);
const cost = silent > 0 ? (1 - playing / silent) * 100 : 0;
console.log(`frame cost:        ${cost.toFixed(1)}%`);
// The comparison only means anything if both measurements drew the same thing.
const same = (a, b) =>
  Boolean(a && b)
  && a.target === b.target
  && Math.abs(a.altitudeKm - b.altitudeKm) < 1
  && Math.abs(a.patches - b.patches) < a.patches * 0.05;
console.log(
  `same view:         ${same(sceneBefore, sceneAfter) ? 'yes' : 'NO'} ` +
  `(${sceneBefore?.target} at ${sceneBefore?.altitudeKm?.toFixed(1)} then ` +
  `${sceneAfter?.altitudeKm?.toFixed(1)} km, ` +
  `patches ${sceneBefore?.patches} then ${sceneAfter?.patches})\n`,
);

console.log('scene mapping as the camera moves:');
for (const w of audioState.weights) console.log(`  ${w.at.padEnd(9)} ${w.top}`);

const failures = [];
if (!same(sceneBefore, sceneAfter)) {
  failures.push('the camera moved between measurements, so the fps comparison is void');
} else if (cost > 20) {
  failures.push(`audio costs ${cost.toFixed(1)}% of the frame rate`);
}
for (const w of audioState.weights) {
  if (!w.top) failures.push(`${w.at}: no stem selected, music would go silent`);
}
for (const p of [...new Set(problems)]) console.error(`  ${p}`);
if (failures.length) {
  console.error('\nfailures:');
  for (const f of failures) console.error(`  ${f}`);
} else {
  console.log('\nlive check passes');
}

await browser.close();
process.exit(failures.length || problems.length ? 1 : 0);
