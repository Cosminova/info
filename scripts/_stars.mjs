/**
 * Reads back the derived radius and colour of named stars from the live app,
 * against accepted radii, so the derivation can be checked where it is actually
 * used rather than only in the module that computes it.
 *
 * Usage: node scripts/_stars.mjs
 */
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5182/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const ACCEPTED = {
  Betelgeuse: 764, Antares: 680, Deneb: 203, Gacrux: 84, Rigel: 78.9, Canopus: 71,
  Alphard: 50.5, Aldebaran: 45.1, Polaris: 37.5, Arcturus: 25.4, Alnilam: 24,
  Alnitak: 20, Dubhe: 17, Hadar: 9, Pollux: 8.8, Shaula: 8.8, Mimosa: 8.4,
  Spica: 7.4, Achernar: 7.3, Bellatrix: 5.8, Regulus: 3.1, Vega: 2.6, Castor: 2.4,
  Procyon: 2, Fomalhaut: 1.84, Altair: 1.8, Sirius: 1.71, 'Rigil Kentaurus': 1.22,
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  defaultViewport: { width: 900, height: 600 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });

const rows = await page.evaluate((accepted) => {
  const out = [];
  for (const name of Object.keys(accepted)) {
    const dest = window.cosminova.destinations.find((d) => d.key === `star:${name}`);
    if (!dest) {
      out.push({ name, missing: true });
      continue;
    }
    window.cosminova.target(`star:${name}`, 3);
    const stats = window.cosminova.stats();
    out.push({
      name,
      radiusKm: stats.targetRadiusKm ?? null,
      spect: dest.spect,
      profile: dest._profile ?? null,
    });
  }
  return out;
}, ACCEPTED);

const SOLAR = 695700;
console.log(`${'star'.padEnd(16)} ${'spect'.padEnd(13)} ${'Teff'.padStart(6)} ${'R calc'.padStart(8)} ${'R real'.padStart(7)} ${'ratio'.padStart(6)}  colour`);
const ratios = [];
for (const row of rows) {
  if (row.missing) {
    console.log(`${row.name.padEnd(16)} MISSING`);
    continue;
  }
  const real = ACCEPTED[row.name];
  const calc = (row.profile?.radiusKm ?? row.radiusKm ?? 0) / SOLAR;
  const ratio = calc / real;
  ratios.push(ratio);
  const c = row.profile?.colour ?? [];
  console.log(
    `${row.name.padEnd(16)} ${String(row.spect ?? '-').slice(0, 13).padEnd(13)}` +
      ` ${String(Math.round(row.profile?.teff ?? 0)).padStart(6)}` +
      ` ${calc.toFixed(1).padStart(8)} ${real.toFixed(1).padStart(7)} ${ratio.toFixed(2).padStart(6)}` +
      `  ${c.map((v) => v.toFixed(2)).join(' ')}`,
  );
}
ratios.sort((a, b) => a - b);
const median = ratios[Math.floor(ratios.length / 2)];
console.log(
  `\nmedian ${median.toFixed(2)}   within 1.6x: ${ratios.filter((r) => r > 1 / 1.6 && r < 1.6).length}/${ratios.length}`,
);

await browser.close();
