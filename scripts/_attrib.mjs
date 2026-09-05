/**
 * Subsystem cost attribution: measure the same view with one subsystem removed
 * at a time, at a realistic Retina pixel count.
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const URL = args.find((a) => !a.startsWith('--')) ?? 'http://127.0.0.1:5182/index.html';
const W = Number(args.find((a) => a.startsWith('--w='))?.split('=')[1] ?? 1512);
const H = Number(args.find((a) => a.startsWith('--h='))?.split('=')[1] ?? 900);
const DPR = Number(args.find((a) => a.startsWith('--dpr='))?.split('=')[1] ?? 2);
const FRAMES = Number(args.find((a) => a.startsWith('--frames='))?.split('=')[1] ?? 100);

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: DPR },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await page.evaluate(() => window.cosminova.setRate(0));

console.log(await page.evaluate(() => {
  const gl = window.cosminova.renderer.getContext();
  const i = gl.getExtension('WEBGL_debug_renderer_info');
  return `${i ? gl.getParameter(i.UNMASKED_RENDERER_WEBGL) : '?'}  drawing ${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`;
}));

async function measure() {
  return page.evaluate(async (frames) => {
    // warm
    await new Promise((r) => { let n = 0; const t = () => (++n < 20 ? requestAnimationFrame(t) : r()); requestAnimationFrame(t); });
    const times = [];
    await new Promise((resolve) => {
      let last = performance.now();
      let n = 0;
      const tick = () => {
        const now = performance.now();
        times.push(now - last);
        last = now;
        if (++n >= frames) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  }, FRAMES);
}

const VIEWS = [
  { name: 'moon low', go: () => window.cosminova.target('moon', 1.02) },
  { name: 'mercury low', go: () => window.cosminova.target('mercury', 1.02) },
  { name: 'earth orbit', go: () => window.cosminova.target('earth', 2.4) },
];

const KNOBS = {
  baseline: () => {},
  'no bloom': () => window.cosminova.setPass('bloom', false),
  'no dither': () => window.cosminova.setPass('dither', false),
  'no sky pass': () => window.cosminova.setPass('sky', false),
  'no deep field': () => {
    window.__hid = [];
    window.cosminova.scene.traverse((o) => {
      if (/stars|galax|milky|deep/i.test(o.name ?? '') && o.visible) { o.visible = false; window.__hid.push(o); }
    });
  },
  'no craft': () => { window.cosminova.state.showCraft = false; window.cosminova.state.showTrajectories = false; },
  'no labels': () => { document.getElementById('label-layer').style.display = 'none'; },
  'dpr 1': () => { window.cosminova.renderer.setPixelRatio(1); window.dispatchEvent(new Event('resize')); },
};

const RESET = () => {
  window.cosminova.setPass('bloom', true);
  window.cosminova.setPass('dither', true);
  window.cosminova.setPass('sky', true);
  for (const o of window.__hid ?? []) o.visible = true;
  window.__hid = [];
  window.cosminova.state.showCraft = true;
  window.cosminova.state.showTrajectories = true;
  document.getElementById('label-layer').style.display = '';
  window.cosminova.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  window.dispatchEvent(new Event('resize'));
};

for (const view of VIEWS) {
  await page.evaluate(view.go);
  await new Promise((r) => setTimeout(r, 2500));
  console.log(`\n=== ${view.name} ===`);
  let base = 0;
  for (const [label, fn] of Object.entries(KNOBS)) {
    await page.evaluate(RESET);
    await page.evaluate(fn);
    await new Promise((r) => setTimeout(r, 900));
    const ms = await measure();
    if (label === 'baseline') base = ms;
    const delta = label === 'baseline' ? '' : `  (${(ms - base >= 0 ? '+' : '')}${(ms - base).toFixed(1)} ms, ${(((base - ms) / base) * 100).toFixed(0)}% saved)`;
    console.log(`  ${label.padEnd(14)} ${ms.toFixed(1)} ms  ${(1000 / ms).toFixed(0)} fps${delta}`);
  }
  const s = await page.evaluate(() => window.cosminova.stats());
  console.log(`  [patches ${s.patches}, draws ${s.drawCalls}, tris ${(s.triangles / 1000).toFixed(0)}k]`);
}

await browser.close();
