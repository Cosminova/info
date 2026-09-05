import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--headless=new','--no-sandbox','--use-gl=angle'], defaultViewport: { width: 1200, height: 800 } });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5180/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
const hits = await p.evaluate(() => {
  const out = [];
  for (const d of window.cosminova.destinations) {
    if (d.kind !== 'star' || !d.system) continue;
    for (const pl of d.system.planets ?? []) {
      out.push({ host: d.system.host, name: pl.name, r: pl.radiusEarth, a: pl.aAu, teq: pl.teqK });
    }
  }
  return out.filter(x => x.r > 0.7 && x.r < 2.6).slice(0, 40);
});
console.log(JSON.stringify(hits.slice(0, 25), null, 0));
await b.close();
