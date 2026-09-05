/**
 * Destination list invariants.
 *
 * The list and the key map are two views of one thing: search, the catalogue
 * dialog and the per-frame label pass read the list, while selecting anything
 * resolves through the map. The map holds one entry per key, so a second entry
 * pushed under a key already in it is a row that can be found and offered and
 * never resolves to itself — clicking it lands on the other one.
 *
 * That is not hypothetical. Systems invented inside galaxies take their host
 * names from the galaxy's name and everything else from its catalogue id, and an
 * interacting pair is one name across several rows, so the Antennae alone
 * produced four systems all called "Antennae Galaxies alpha", separately
 * generated and separately placed. 277 keys were duplicated. Two of those
 * systems in view at once labelled the same star twice in two places, which is
 * what a pile of labels on top of each other turns out to be.
 *
 * Usage: node scripts/dest-check.mjs
 */
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 900, height: 600 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.cosminova?.ready === true, { timeout: 120000 });

const report = await page.evaluate(() => {
  const list = window.cosminova.destinations ?? [];
  const counts = new Map();
  for (const d of list) counts.set(d.key, (counts.get(d.key) ?? 0) + 1);
  const dupes = [...counts.entries()].filter(([, n]) => n > 1);
  return {
    total: list.length,
    distinct: counts.size,
    duplicated: dupes.length,
    extra: dupes.reduce((sum, [, n]) => sum + n - 1, 0),
    worst: dupes.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} x${n}`),
    unnamed: list.filter((d) => !d.name).length,
    keyless: list.filter((d) => !d.key).length,
  };
});

let failures = 0;
const check = (ok, label, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}  ${detail}`);
};

console.log(`destination list: ${report.total} entries, ${report.distinct} distinct keys\n`);
check(report.duplicated === 0, 'every destination has a key of its own',
  report.duplicated === 0
    ? 'no key appears twice'
    : `${report.duplicated} keys duplicated, ${report.extra} unreachable rows: ${report.worst.join(', ')}`);
check(report.keyless === 0, 'every destination has a key', `${report.keyless} without one`);
check(report.unnamed === 0, 'every destination has a name', `${report.unnamed} without one`);
check(errors.length === 0, 'no console errors while building the list',
  errors.length ? [...new Set(errors)].slice(0, 3).join(' | ') : 'none');

console.log(`\n${failures ? `${failures} failed` : 'the destination list is consistent'}`);
await browser.close();
process.exit(failures ? 1 : 0);
