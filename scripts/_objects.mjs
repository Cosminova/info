/**
 * Lists what is actually in the scene and drawing, so an unexplained overlay
 * can be traced to the object making it.
 *
 * Usage: node scripts/_objects.mjs
 */
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5182/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  defaultViewport: { width: 800, height: 600 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });

const list = await page.evaluate(() => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.lookFromSun('earth', 1.0006, 88, 0);
  const rows = [];
  const walk = (object, depth, parentVisible) => {
    const visible = parentVisible && object.visible;
    const isDrawn = object.isMesh || object.isLine || object.isLineSegments || object.isPoints || object.isSprite;
    if (isDrawn) {
      rows.push({
        type: object.type,
        name: object.name || '(unnamed)',
        visible,
        order: object.renderOrder,
        depth,
        count: object.geometry?.attributes?.position?.count ?? null,
      });
    }
    for (const child of object.children) walk(child, depth + 1, visible);
  };
  walk(sv.scene, 0, true);
  return rows.filter((r) => r.visible);
});

console.log(`${list.length} visible drawable objects\n`);
const byType = new Map();
for (const row of list) {
  const key = `${row.type} ${row.name}`;
  byType.set(key, (byType.get(key) ?? 0) + 1);
}
for (const [key, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(4)} x ${key}`);
}
console.log('\nlines and points only:');
for (const row of list.filter((r) => /Line|Points/.test(r.type))) {
  console.log(`  ${row.type.padEnd(14)} ${row.name.padEnd(28)} order=${row.order} verts=${row.count}`);
}

await browser.close();
