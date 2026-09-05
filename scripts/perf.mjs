/**
 * Frame-time benchmark for the solar system view.
 *
 * Written to be trustworthy rather than quick. Single short runs of this scene
 * vary by 30% between repeats — enough to make a real 20% improvement look like
 * a regression — so every scenario is measured in several separated repetitions
 * and reported with its spread. Treat two numbers as different only when the
 * ranges do not overlap.
 *
 * Frame interval is taken from requestAnimationFrame, so a scene comfortably
 * inside the frame budget reads as the display's refresh rate and nothing
 * faster; 16.7 ms means "fast enough", not "exactly 60".
 *
 * Usage: node scripts/perf.mjs [url] [--reps=3] [--frames=150]
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const URL =
  args.find((a) => !a.startsWith('--')) ?? process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5178/index.html';
const REPS = flag('reps', 3);
const FRAMES = flag('frames', 150);
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// The close-range cases are the ones that have ever been below the frame
// budget; the distant ones are here to catch a regression that only shows up
// when the whole system is in view.
const SCENARIOS = [
  { name: 'moon orbit', key: 'moon', distanceRadii: 3.2 },
  { name: 'moon low', key: 'moon', distanceRadii: 1.02 },
  { name: 'moon surface', key: 'moon', distanceRadii: 1.0008 },
  { name: 'mercury low', key: 'mercury', distanceRadii: 1.02 },
  { name: 'callisto low', key: 'callisto', distanceRadii: 1.02 },
  { name: 'ceres low', key: 'ceres', distanceRadii: 1.02 },
  { name: 'earth orbit', key: 'earth', distanceRadii: 2.4 },
  { name: 'jupiter orbit', key: 'jupiter', distanceRadii: 3.0 },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await page.evaluate(() => window.cosminova.setRate(0));

const gpu = await page.evaluate(() => {
  const gl = window.cosminova.renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`${gpu}\n${REPS} reps of ${FRAMES} frames at 1280x800\n`);

const frame = (n) =>
  page.evaluate(
    (count) =>
      new Promise((resolve) => {
        const times = [];
        let last = performance.now();
        const tick = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          if (times.length >= count) resolve(times);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    n,
  );

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const results = [];
for (const scenario of SCENARIOS) {
  const medians = [];
  for (let rep = 0; rep < REPS; rep++) {
    await page.evaluate(
      ({ key, distanceRadii }) => window.cosminova.lookFromSun(key, distanceRadii, 40, 18),
      scenario,
    );
    // Terrain subdivision and texture upgrades both settle over a few frames;
    // measuring through that would report the cost of arriving, not of being
    // there.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1200)));
    const times = await frame(FRAMES);
    medians.push(median(times.slice(20)));
  }

  const stats = await page.evaluate(() => window.cosminova.stats());
  const best = Math.min(...medians);
  const worst = Math.max(...medians);
  results.push({ name: scenario.name, medians, stats });
  console.log(
    `${scenario.name.padEnd(14)} ${median(medians).toFixed(1).padStart(5)} ms ` +
      `(${best.toFixed(1)}-${worst.toFixed(1)})  ` +
      `${(1000 / median(medians)).toFixed(0).padStart(3)} fps  ` +
      `patches ${String(stats.patches).padStart(4)}`,
  );
}

await browser.close();

const slow = results.filter((r) => median(r.medians) > 18).length;
console.log(`\n${results.length - slow}/${results.length} scenarios inside the frame budget`);
