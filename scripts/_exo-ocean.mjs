import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--headless=new','--no-sandbox','--use-gl=angle'], defaultViewport: { width: 1200, height: 800 } });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5180/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
for (const host of ['TRAPPIST-1', 'Proxima Cen', 'Kepler-452', 'TOI-700', 'Kepler-186', 'GJ 667 C', 'K2-18']) {
  const key = [...window0(), ...[]].length; // placeholder
}
function window0(){return [];}
const found = await p.evaluate(async (names) => {
  const out = [];
  for (const name of names) {
    const dest = window.cosminova.destinations.find((d) => d.kind === 'star' && d.system?.host === name);
    if (!dest) { out.push({ name, missing: true }); continue; }
    window.cosminova.state.target = dest.key;
    out.push({ name, key: dest.key, planets: dest.system.planets.map((x) => x.name) });
  }
  return out;
}, ['TRAPPIST-1', 'Proxima Cen', 'Kepler-452', 'TOI-700', 'Kepler-186', 'K2-18']);
console.log(JSON.stringify(found, null, 1));
await b.close();
