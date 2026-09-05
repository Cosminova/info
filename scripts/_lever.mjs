/** Does the quality level actually buy frame time? Measured, not assumed. */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://127.0.0.1:5180/index.html';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
  defaultViewport: { width: 1512, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await page.evaluate(() => window.cosminova.setRate(0));
console.log(await page.evaluate(() => {
  const gl = window.cosminova.renderer.getContext();
  const i = gl.getExtension('WEBGL_debug_renderer_info');
  return `${i ? gl.getParameter(i.UNMASKED_RENDERER_WEBGL) : '?'}`;
}));

async function measure(frames = 90) {
  return page.evaluate(async (n) => {
    await new Promise((r) => { let i = 0; const t = () => (++i < 20 ? requestAnimationFrame(t) : r()); requestAnimationFrame(t); });
    const times = [];
    await new Promise((resolve) => {
      let last = performance.now();
      let i = 0;
      const tick = () => { const now = performance.now(); times.push(now - last); last = now; if (++i >= n) return resolve(); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  }, frames);
}

for (const [body, dist] of [['mercury', 1.02], ['moon', 1.02], ['earth', 2.4]]) {
  console.log(`\n=== ${body} @ ${dist} radii ===`);
  let base = 0;
  for (const preset of ['ultra', 'high', 'medium', 'low']) {
    await page.evaluate((p) => window.cosminova.setQuality(p), preset);
    await page.evaluate((b, d) => window.cosminova.target(b, d), body, dist);
    await new Promise((r) => setTimeout(r, 3000));
    const ms = await measure();
    const s = await page.evaluate(() => window.cosminova.stats());
    if (preset === 'ultra') base = ms;
    console.log(
      `  ${preset.padEnd(8)} ${ms.toFixed(1).padStart(6)} ms  ${String(Math.round(1000 / ms)).padStart(3)} fps` +
      `  scale ${s.renderScale.toFixed(2)}  patches ${String(s.patches).padStart(4)}` +
      (preset === 'ultra' ? '' : `   ${(base / ms).toFixed(2)}x faster`),
    );
  }
}

// Auto mode: does it converge, and where?
console.log('\n=== auto convergence (mercury surface) ===');
await page.evaluate(() => window.cosminova.setQuality('auto'));
await page.evaluate(() => window.cosminova.target('mercury', 1.02));
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = await page.evaluate(() => window.cosminova.stats());
  console.log(`  t+${(i + 1) * 2}s  level ${s.quality.toFixed(2)}  scale ${s.renderScale.toFixed(2)}  fps ${s.fps.toFixed(0)}`);
}
const ms = await measure();
console.log(`  settled: ${ms.toFixed(1)} ms (${Math.round(1000 / ms)} fps)`);

await browser.close();
