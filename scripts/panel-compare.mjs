/**
 * Puts the spacecraft panel next to the planet panel and reports how they differ.
 *
 * Reported as "make the UI for the satellite the same as the planet, because
 * currently it is a bit weird". Both already run through the same inspector and
 * the same row builder, so the difference is not the panel — it is what the row
 * builder puts in it. This crops the panel for each and dumps the label/value
 * pairs as the DOM actually holds them, which is where a blank label or a row
 * that wrapped to four lines shows up.
 *
 * Usage: node scripts/panel-compare.mjs
 */
import puppeteer from 'puppeteer-core';

const URL = 'http://127.0.0.1:5179/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const SUBJECTS = [
  ['mars', 'planet'],
  ['moon', 'moon'],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 1280, height: 860 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.cosminova?.ready === true, { timeout: 120000 });
await page.evaluate(() => window.cosminova.setRate(0));

// Find some spacecraft that actually exist on the current date, so the panel is
// showing a live one rather than "not yet launched".
const craft = await page.evaluate(() => {
  const sv = window.cosminova;
  const out = [];
  for (const d of sv.destinations ?? []) {
    if (d.kind !== 'craft') continue;
    const st = sv.craftField?.get?.(d.key.replace(/^craft:/, ''));
    if (st?.present) out.push(d.key);
    if (out.length >= 3) break;
  }
  return out;
});

async function dump(key, label) {
  await page.evaluate((k) => {
    window.cosminova.target(k, 4);
  }, key);
  await new Promise((r) => setTimeout(r, 1600));
  const info = await page.evaluate(() => {
    const dl = document.querySelector('.kv');
    if (!dl) return { error: 'no inspector' };
    const kids = [...dl.children];
    const rows = [];
    for (let i = 0; i < kids.length; i += 2) {
      const dt = kids[i];
      const dd = kids[i + 1];
      if (!dt || !dd) continue;
      rows.push({
        label: dt.textContent,
        value: dd.textContent,
        prose: dd.classList.contains('is-text'),
        // How tall the row rendered, which is how a wrapped paragraph shows up.
        height: Math.round(dd.getBoundingClientRect().height),
      });
    }
    const panel = document.querySelector('.kv')?.closest('section, aside, div[class*="panel"]');
    const box = (panel ?? document.querySelector('.kv')).getBoundingClientRect();
    return {
      title: document.querySelector('.obj-name')?.textContent,
      className: document.querySelector('.obj-class')?.textContent,
      rows,
      panelHeight: Math.round(box.height),
      panelWidth: Math.round(box.width),
      actions: [...document.querySelectorAll('.obj-actions .btn')]
        .filter((b) => !b.classList.contains('is-hidden') && b.offsetParent !== null)
        .map((b) => `${b.textContent}${b.disabled ? '(off)' : ''}`),
    };
  });

  console.log(`\n=== ${label}: ${info.title}  [${info.className}]`);
  console.log(`    panel ${info.panelWidth}x${info.panelHeight}, ${info.rows.length} rows`);
  console.log(`    actions: ${info.actions.join(', ')}`);
  for (const r of info.rows) {
    const flag = !r.label.trim() ? '  <-- BLANK LABEL' : r.height > 48 ? `  <-- ${r.height}px tall` : '';
    console.log(`      ${(r.label || '""').padEnd(20)} ${r.prose ? 'prose' : ' num '}  `
      + `${JSON.stringify(r.value.slice(0, 62))}${flag}`);
  }
  return info;
}

const seen = [];
for (const [key, label] of SUBJECTS) seen.push(await dump(key, label));
for (const key of craft) seen.push(await dump(key, 'craft'));

await browser.close();

console.log('\nsummary:');
for (const s of seen) {
  const blanks = s.rows.filter((r) => !r.label.trim()).length;
  const tall = s.rows.filter((r) => r.height > 48).length;
  console.log(`  ${String(s.title).padEnd(22)} rows ${String(s.rows.length).padStart(2)}  `
    + `height ${String(s.panelHeight).padStart(4)}px  blank labels ${blanks}  tall rows ${tall}`);
}
