/** Every option in the table: does the checkbox exist, and does it change the scene? */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://127.0.0.1:5182/index.html';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await page.evaluate(() => window.cosminova.setRate(0));

// Open the Display and Performance panels the way a person would.
const opened = await page.evaluate(() => {
  const hits = [...document.querySelectorAll('.rail-item')].map((b) => b.querySelector('.rail-label')?.textContent);
  for (const label of ['Display', 'Performance']) {
    const button = [...document.querySelectorAll('.rail-item')]
      .find((b) => b.querySelector('.rail-label')?.textContent === label);
    button?.click();
  }
  return hits;
});
console.log(`rail: ${opened.join(', ')}`);

const found = await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('.panel[data-panel="display"] .check')];
  return boxes.map((b) => b.querySelector('span')?.textContent);
});
console.log(`\n${found.length} checkboxes in Display:\n  ${found.join('\n  ')}`);

const perf = await page.evaluate(() => {
  const p = document.querySelector('.panel[data-panel="quality"]');
  if (!p) return null;
  return {
    presets: [...p.querySelectorAll('.segmented button')].map((b) => b.textContent),
    readout: p.querySelector('.quality-readout')?.textContent,
    sliders: [...p.querySelectorAll('.field-label')].map((s) => s.textContent),
  };
});
console.log(`\nPerformance panel: ${JSON.stringify(perf, null, 2)}`);

// Toggle every checkbox off, then on, and confirm the scene stays alive.
const probe = () => page.evaluate(() => {
  const sv = window.cosminova;
  let stars = null; let galaxies = null; let mw = null; let distant = null; let holes = null;
  sv.scene.traverse((o) => {
    if (o.name === 'distant-bodies') distant = o.visible;
  });
  stars = sv.scene.children.some((o) => o.type === 'Points' && o.visible);
  return { stars, distant, labels: document.querySelectorAll('#label-layer .label').length };
});

console.log(`\nbefore: ${JSON.stringify(await probe())}`);
const names = await page.evaluate(async () => {
  const boxes = [...document.querySelectorAll('.panel[data-panel="display"] .check input')];
  const off = [];
  for (const b of boxes) {
    if (b.checked) { b.click(); off.push(b.parentElement.querySelector('span').textContent); }
  }
  return off;
});
await new Promise((r) => setTimeout(r, 1500));
console.log(`turned off ${names.length}: ${JSON.stringify(await probe())}`);

await page.evaluate(() => {
  for (const b of document.querySelectorAll('.panel[data-panel="display"] .check input')) if (!b.checked) b.click();
});
await new Promise((r) => setTimeout(r, 1500));
console.log(`turned on:  ${JSON.stringify(await probe())}`);

// Star labels: the specific ask. Default off, on when asked.
await page.evaluate(() => window.cosminova.target('sirius', 12));
await new Promise((r) => setTimeout(r, 2500));
const labelState = await page.evaluate(() => {
  const box = [...document.querySelectorAll('.panel[data-panel="display"] .check')]
    .find((b) => b.querySelector('span').textContent === 'Stars');
  return { present: Boolean(box), checked: box?.querySelector('input').checked };
});
console.log(`\n"Stars" name toggle: ${JSON.stringify(labelState)}`);

const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('skyview.ui.v1') || '{}'));
console.log(`persisted view keys: ${Object.keys(stored.view ?? {}).length}, quality: ${JSON.stringify(stored.quality)}`);

console.log(`\nerrors: ${errors.length ? errors.slice(0, 6).join(' | ') : 'none'}`);
await browser.close();
