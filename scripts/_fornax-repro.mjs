/**
 * Reproduces the field of white dashes reported inside an invented galaxy
 * system, with the interface left on, which is the condition it was seen under.
 * Also dumps whatever DOM the labels layer is producing, since a uniform grid of
 * identical marks is far more likely to be markup than geometry.
 */
import puppeteer from 'puppeteer-core';

const b = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 1024, height: 600 },
});
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5179/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await p.evaluate(() => window.cosminova.setRate(0));

await p.evaluate(() => window.cosminova.target('star:Fornax A delta', 12));
await new Promise((r) => setTimeout(r, 7000));
await p.screenshot({ path: '/tmp/fornax-ui.png' });

const dom = await p.evaluate(() => {
  const report = {};
  // Every element that is small, light and repeated is a candidate.
  const all = Array.from(document.querySelectorAll('body *'));
  const tally = {};
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const key = `${el.tagName}.${el.className || '-'}`;
    tally[key] = tally[key] ?? { n: 0, sample: null };
    tally[key].n++;
    if (!tally[key].sample) {
      tally[key].sample = {
        w: Math.round(r.width), h: Math.round(r.height),
        text: (el.textContent ?? '').slice(0, 40),
      };
    }
  }
  report.repeated = Object.entries(tally)
    .filter(([, v]) => v.n > 12)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 12);

  const sv = window.cosminova;
  report.labelItems = sv.ui?.labelCount ?? null;
  report.exo = {
    planets: sv.exoSystem?.planets?.length ?? null,
    moons: sv.exoSystem?.moons?.length ?? null,
    moonNames: (sv.exoSystem?.moons ?? []).slice(0, 6).map((m) => m.spec.name),
    moonRadiiKm: (sv.exoSystem?.moons ?? []).slice(0, 6).map((m) => Math.round(m.spec.radiusKm)),
  };
  return report;
});
console.log(JSON.stringify(dom, null, 1));
await b.close();
console.log('/tmp/fornax-ui.png');
