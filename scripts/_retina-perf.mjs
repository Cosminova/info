/**
 * Frame time at the resolution the complaint came from.
 *
 * The standing benchmark runs 1280x800 at one device pixel per CSS pixel, which
 * is a quarter of the fragments a Retina laptop actually asks for, and the
 * surface shader is fragment-bound — so that benchmark cannot see the problem
 * being reported. This one runs 3024x1800 at 2x and reports each scenario with
 * the adaptive governor doing its job and with it pinned to ultra, which is the
 * before-and-after the user is asking about.
 */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://127.0.0.1:5182/index.html';
const FRAMES = 140;
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const SCENARIOS = [
  { name: 'moon surface', key: 'moon', d: 1.0008 },
  { name: 'moon low', key: 'moon', d: 1.02 },
  { name: 'mercury low', key: 'mercury', d: 1.02 },
  { name: 'earth orbit', key: 'earth', d: 2.4 },
  { name: 'jupiter orbit', key: 'jupiter', d: 3.0 },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  defaultViewport: { width: 1512, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await page.evaluate(() => { window.cosminova.setRate(0); window.cosminova.setUiVisible(false); });

const canvas = await page.evaluate(() => ({
  w: window.cosminova.renderer.domElement.width,
  h: window.cosminova.renderer.domElement.height,
  dpr: window.devicePixelRatio,
}));
console.log(`canvas ${canvas.w}x${canvas.h} at dpr ${canvas.dpr}\n`);

async function measure() {
  return page.evaluate(async (frames) => {
    const gaps = [];
    let last = performance.now();
    await new Promise((done) => {
      const tick = () => {
        const now = performance.now();
        gaps.push(now - last);
        last = now;
        if (gaps.length >= frames) return done();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // Drop the first quarter: terrain is still streaming in right after a jump.
    const warm = gaps.slice(Math.floor(gaps.length / 4)).sort((a, b) => a - b);
    const at = (q) => warm[Math.min(warm.length - 1, Math.floor(q * warm.length))];
    return { median: at(0.5), p90: at(0.9) };
  }, FRAMES);
}

const rows = [];
for (const preset of ['ultra', 'auto']) {
  for (const s of SCENARIOS) {
    await page.evaluate((p) => window.cosminova.quality.setPreset(p), preset);
    await page.evaluate((k, d) => window.cosminova.lookFromSun(k, d), s.key, s.d);
    // Long settle: the governor needs real frames before it has an opinion, and
    // terrain streaming has to finish or it is the streaming being measured.
    await new Promise((r) => setTimeout(r, 6000));
    const { median, p90 } = await measure();
    const q = await page.evaluate(() => ({
      scale: window.cosminova.quality.renderScale,
      terrain: window.cosminova.quality.terrainDetail,
    }));
    rows.push({
      scenario: s.name,
      preset,
      fps: +(1000 / median).toFixed(1),
      median: +median.toFixed(1),
      p90: +p90.toFixed(1),
      renderScale: +q.scale.toFixed(2),
      terrainDetail: +q.terrain.toFixed(2),
    });
    console.log(
      `${s.name.padEnd(14)} ${preset.padEnd(6)} ${(1000 / median).toFixed(1).padStart(6)} fps`
      + `  median ${median.toFixed(1).padStart(6)} ms  p90 ${p90.toFixed(1).padStart(6)} ms`
      + `  scale ${q.scale.toFixed(2)}  detail ${q.terrain.toFixed(2)}`,
    );
  }
  console.log('');
}

await browser.close();

console.log('--- summary: auto vs ultra at Retina resolution');
for (const s of SCENARIOS) {
  const ultra = rows.find((r) => r.scenario === s.name && r.preset === 'ultra');
  const auto = rows.find((r) => r.scenario === s.name && r.preset === 'auto');
  const gain = ultra.median / auto.median;
  console.log(
    `${s.name.padEnd(14)} ${ultra.fps.toFixed(1).padStart(6)} -> ${auto.fps.toFixed(1).padStart(6)} fps`
    + `   ${gain.toFixed(2)}x faster`,
  );
}
