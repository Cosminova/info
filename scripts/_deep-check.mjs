/**
 * Diagnostic for the two reported deep-sky faults: galaxies never appearing,
 * and the field of white dashes that shows up inside an invented galaxy system.
 * Reports what is actually in the scene at each stop rather than guessing from
 * the screenshot.
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
p.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 300));
});
await p.goto('http://127.0.0.1:5182/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await p.evaluate(() => { window.cosminova.setRate(0); window.cosminova.setUiVisible(false); });

console.log('view flags:', JSON.stringify(await p.evaluate(() => {
  const s = window.cosminova.state;
  return {
    showGalaxies: s.showGalaxies, showStars: s.showStars,
    showMilkyWay: s.showMilkyWay, showDistantMarkers: s.showDistantMarkers,
    showCraft: s.showCraft, showTrajectories: s.showTrajectories,
    showCraftVectors: s.showCraftVectors,
  };
})));

// What deep-sky targets exist at all?
const dests = await p.evaluate(() => (window.cosminova.destinations ?? [])
  .filter((d) => d.kind === 'galaxy' || /^gal:/.test(d.key))
  .slice(0, 12).map((d) => ({ key: d.key, name: d.name })));
console.log('galaxy destinations:', JSON.stringify(dests));

const generated = await p.evaluate(() => (window.cosminova.destinations ?? [])
  .filter((d) => /fornax/i.test(`${d.key} ${d.name ?? ''}`))
  .slice(0, 8).map((d) => ({ key: d.key, name: d.name, kind: d.kind })));
console.log('fornax destinations:', JSON.stringify(generated, null, 1));

async function probe(tag, target, dist) {
  await p.evaluate((t, d) => window.cosminova.target(t, d), target, dist);
  await new Promise((r) => setTimeout(r, 6000));
  const info = await p.evaluate(() => {
    const sv = window.cosminova;
    const df = sv.deepField ?? sv.deep ?? null;
    // Count what is actually being drawn, by type, with visibility.
    const drawn = {};
    sv.scene.traverse((o) => {
      if (!o.visible) return;
      const kind = o.type;
      drawn[kind] = (drawn[kind] ?? 0) + 1;
    });
    return {
      drawn,
      galaxyMeshVisible: df?.galaxies?.mesh?.visible ?? null,
      galaxyCount: df?.galaxies?.count ?? null,
      starsVisible: df?.stars?.visible ?? null,
      milkyWayVisible: df?.milkyWay?.points?.visible ?? null,
      craftCount: sv.craftField?.items?.length ?? null,
      exoKey: sv.exoSystem?.key ?? null,
      exoPlanets: sv.exoSystem?.planets?.length ?? null,
      exoMoons: sv.exoSystem?.moons?.length ?? null,
      distanceAu: sv.controls?.worldPosition
        ? sv.controls.worldPosition.length() / 149597870.7 : null,
    };
  });
  const out = `/tmp/deep-${tag}.png`;
  await p.screenshot({ path: out });
  console.log(`\n== ${tag} (${target})`);
  console.log(JSON.stringify(info, null, 1));
  console.log(out);
}

await probe('m31', 'gal:M31', 3);
await probe('fornax-galaxy', 'gal:NGC1316', 3);
await probe('fornax-delta', 'star:Fornax A delta', 12);

await b.close();
