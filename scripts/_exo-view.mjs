import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
const host = process.argv[2] ?? 'TRAPPIST-1';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--headless=new','--no-sandbox','--use-gl=angle'], defaultViewport: { width: 1280, height: 800 } });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5182/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await p.evaluate(() => { window.cosminova.setRate(0); window.cosminova.setUiVisible(false); });
await p.evaluate((h) => window.cosminova.target(`star:${h}`, 12), host);
await new Promise((r) => setTimeout(r, 3000));
const info = await p.evaluate(() => {
  const sv = window.cosminova;
  const exo = sv.exoSystem;
  if (!exo) return null;
  return exo.planets.map((i) => ({
    key: i.spec.key, name: i.spec.name, r: Math.round(i.spec.radiusKm),
    sea: +(i.spec.seaLevelKm ?? 0).toFixed(2), cloud: +(i.spec.cloudCover ?? 0).toFixed(2),
    cls: i.spec.classLabel, air: !!i.spec.atmosphere,
  }));
});
console.log(JSON.stringify(info, null, 1));
const wet = (info ?? []).filter((x) => x.sea > 0);
for (const target of wet.slice(0, 2)) {
  for (const [tag, dist] of [['orbit', 2.6], ['low', 1.06]]) {
    await p.evaluate((k, d) => window.cosminova.lookAtExo(k, d), target.key, dist);
    await new Promise((r) => setTimeout(r, 4500));
    const out = `/tmp/exo-${target.key.replace(/[^a-z0-9]+/gi, '-')}-${tag}.png`;
    await p.screenshot({ path: out });
    console.log(out);
  }
}
await b.close();
