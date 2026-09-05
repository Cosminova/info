// Frames the resident black holes a few ways: the classic edge-on approach, and
// far enough out that the disc reads as a small bright object the way it does
// when it is standing in for a sun.
import puppeteer from 'puppeteer-core';

const b = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 1280, height: 720 },
});
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
p.on('console', (m) => {
  if (m.type() === 'error' && /shader|program|uniform/i.test(m.text())) {
    console.log('SHADER:', m.text().slice(0, 600));
  }
});
await p.goto('http://127.0.0.1:5182/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await p.evaluate(() => { window.cosminova.setRate(0); window.cosminova.setUiVisible(false); });

const holes = await p.evaluate(() => (window.cosminova.destinations ?? [])
  .filter((d) => /hole|sgr|cygnus|m87/i.test(`${d.key} ${d.name ?? ''}`))
  .map((d) => ({ key: d.key, name: d.name, kind: d.kind })));
console.log(JSON.stringify(holes, null, 1));

for (const hole of holes.slice(0, 3)) {
  for (const dist of [95, 320]) {
    const info = await p.evaluate((k, d) => window.cosminova.lookAtBlackHole(k, d), hole.key, dist);
    await new Promise((r) => setTimeout(r, 3500));
    const out = `/tmp/bh-${hole.key.replace(/[^a-z0-9]+/gi, '-')}-${dist}.png`;
    await p.screenshot({ path: out });
    console.log(out, JSON.stringify(info));
  }
}
await b.close();
