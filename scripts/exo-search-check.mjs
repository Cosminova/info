/**
 * Can you find an exoplanet, and does it load when you do?
 *
 * Reported as "how do I find these exoplanets, please make them accessible
 * somehow". Two separate things had to be true and neither was: the planet has
 * to be in the destination list under the name people know it by, and going
 * there has to actually build the system rather than throw.
 *
 * The second half matters more than it looks. Only two hundred and fifty of the
 * catalogue's systems were reachable before, so the system builder has only ever
 * been exercised on nearby, well-measured ones. Opening it up to all four and a
 * half thousand means feeding it rows with missing radii, missing temperatures
 * and odd multiples, so this visits a spread of them and fails on any console
 * error rather than trusting that a screenshot looks fine.
 *
 * Usage: node scripts/exo-search-check.mjs
 */
import puppeteer from 'puppeteer-core';

const URL = 'http://127.0.0.1:5179/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Names a person would plausibly type, spanning the catalogue's range: the
// nearest system, the famous seven-planet one, and Kepler rows far outside the
// old twenty-five parsec cut.
const WANTED = [
  'Proxima Cen b',
  'TRAPPIST-1e',
  'TRAPPIST-1',
  'Kepler-186f',
  'Kepler-452b',
  'K2-18b',
  'LHS 1140 b',
  'WASP-12b',
  'HD 209458 b',
  'TOI-700 d',
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 1024, height: 640 },
});
const page = await browser.newPage();
let errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(`console: ${m.text().slice(0, 160)}`);
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.cosminova?.ready === true, { timeout: 120000 });
await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setUiVisible(false);
});

const counts = await page.evaluate(() => {
  const all = window.cosminova.destinations ?? [];
  const by = {};
  for (const d of all) by[d.kind] = (by[d.kind] ?? 0) + 1;
  return { total: all.length, by };
});
console.log(`destinations: ${counts.total}`);
console.log(`  ${JSON.stringify(counts.by)}\n`);

// Search the way the interface searches, through the real input, so this tests
// the scoring too and not just the presence of a row in an array.
console.log('typing each name into the search box:\n');
const failures = [];
for (const query of WANTED) {
  const hits = await page.evaluate(async (q) => {
    const sv = window.cosminova;
    sv.setUiVisible(true);
    const input = document.querySelector('.search-input');
    if (!input) return { error: 'no search input' };
    input.focus();
    input.value = q;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 260));
    const rows = [...document.querySelectorAll('.search-row')];
    const out = rows.slice(0, 3).map((r) => ({
      name: r.querySelector('.r-name span')?.textContent ?? '',
      badge: r.querySelector('.badge')?.textContent ?? '',
      meta: r.querySelector('.r-meta')?.textContent ?? '',
      key: r.dataset.key,
    }));
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    sv.setUiVisible(false);
    return { rows: out, count: rows.length };
  }, query);

  if (hits.error) {
    failures.push(`${query}: ${hits.error}`);
    continue;
  }
  const top = hits.rows[0];
  // Compared with separators removed, because that is the whole point: the
  // catalogue writes "TRAPPIST-1 e" and the query says TRAPPIST-1e, and landing
  // on the catalogue's spelling of the planet asked for is a hit, not a miss.
  const squash = (s) => s.toLowerCase().replace(/[\s-]/g, '');
  const found = top && squash(top.name) === squash(query);
  console.log(`  ${query.padEnd(15)} ${found ? 'top hit' : 'NOT THE TOP HIT'}  `
    + `-> ${hits.rows.map((r) => `${r.name} [${r.badge}]`).join(' | ') || 'nothing'}`);
  if (!hits.count) failures.push(`${query}: search returns nothing`);
  else if (!found) failures.push(`${query}: top hit is "${top.name}", not the planet asked for`);
}

// Now actually go to a spread of them. This is where a system with missing
// fields would throw, and where the old distance cut hid the problem.
console.log('\ngoing to a spread of them:\n');
// Keys are looked up by name rather than assembled from one, because the slug
// rule turns "TRAPPIST-1 e" into trappist-1-e and guessing at that only tests
// the guess: a wrong key resolves to nothing and reports as a silent failure to
// load, which is indistinguishable from the bug this is looking for.
const spread = await page.evaluate((names) => {
  const all = window.cosminova.destinations ?? [];
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  return all.filter((d) => d.kind === 'exo-planet' && wanted.has(d.name.toLowerCase()))
    .map((d) => d.key);
}, ['TRAPPIST-1 e', 'Kepler-186 f', 'Kepler-452 b', 'WASP-12 b', 'K2-18 b', 'Proxima Cen b']);
console.log(`  (resolved keys: ${spread.join(', ')})\n`);
for (const key of spread) {
  errors = [];
  const info = await page.evaluate(async (k) => {
    const sv = window.cosminova;
    try {
      sv.target(k, 3);
    } catch (err) {
      return { threw: err.message };
    }
    await new Promise((r) => setTimeout(r, 1400));
    return {
      target: sv.state.target,
      exoHost: sv.exoSystem?.system?.host ?? null,
      planets: sv.exoSystem?.planets?.length ?? 0,
      moons: sv.exoSystem?.moons?.length ?? 0,
      distanceRadii: sv.controls.distanceRadii,
    };
  }, key);
  const bad = info.threw || errors.length;
  console.log(`  ${key.padEnd(20)} ${bad ? 'FAILED' : 'ok'}  `
    + `host ${info.exoHost}  planets ${info.planets}  moons ${info.moons}`);
  if (info.threw) failures.push(`${key}: threw ${info.threw}`);
  for (const e of errors.slice(0, 2)) failures.push(`${key}: ${e}`);
  if (!info.threw && info.exoHost === null) failures.push(`${key}: arrived with no system loaded`);
}

await page.screenshot({ path: 'shots/_exo-trappist.png' });
await browser.close();

if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
console.log('\nevery exoplanet searched for was found, and every system loaded');
