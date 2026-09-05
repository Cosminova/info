/**
 * Hunts the field of white dashes reported inside an invented galaxy system.
 *
 * "Dashes" is the useful word in the report. A uniform scatter of short bright
 * marks is what line geometry looks like when its vertices have gone bad, and
 * this scene is exactly where that would happen: the constellation figures, the
 * spacecraft trajectories and the asterism lines are all built around the Sun,
 * and Fornax A is twenty megaparsecs from it. Line vertices are float32, so at
 * that range the coordinates carry no useful precision left and the segments
 * land wherever rounding puts them.
 *
 * So rather than guess, this switches each layer off in turn and measures the
 * frame. Whichever layer's removal takes the bright marks away is the one
 * drawing them.
 *
 * Usage: node scripts/fornax-check.mjs
 */
import sharp from 'sharp';
import puppeteer from 'puppeteer-core';

const URL = 'http://127.0.0.1:5179/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1024;
const H = 640;

const LAYERS = ['constellations', 'asterisms', 'bounds', 'constellationBounds',
  'trajectories', 'craftVectors', 'craft', 'stars', 'milkyWay', 'galaxies',
  'distantMarkers', 'exo', 'orbits'];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: W, height: H },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.cosminova?.ready === true, { timeout: 120000 });
await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setUiVisible(false);
});

/**
 * Counts small isolated bright marks: pixels well above the sky that do not sit
 * in a large bright region. A star field scores here too, so what matters is
 * how the number moves as layers are switched off, not its absolute value.
 */
async function marks() {
  const png = await page.screenshot({ type: 'png' });
  const { data, info } = await sharp(png).removeAlpha().greyscale().raw()
    .toBuffer({ resolveWithObject: true });
  let bright = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
    if (data[i] > 60) bright++;
  }
  return {
    bright,
    brightPct: (100 * bright) / data.length,
    mean: sum / data.length,
    width: info.width,
  };
}

async function goTo(target, radii) {
  await page.evaluate((t, r) => window.cosminova.target(t, r), target, radii);
  await new Promise((r) => setTimeout(r, 2200));
}

console.log('inside the invented system at Fornax A:\n');
await goTo('star:Fornax A delta', 12);

const scene = await page.evaluate(() => {
  const sv = window.cosminova;
  const byType = {};
  const lines = [];
  sv.scene.traverse((o) => {
    if (!o.visible) return;
    byType[o.type] = (byType[o.type] ?? 0) + 1;
    if (/Line/.test(o.type)) {
      lines.push({ type: o.type, name: o.name || '(unnamed)', renderOrder: o.renderOrder });
    }
  });
  return {
    byType,
    lines: lines.slice(0, 12),
    exoPlanets: sv.exoSystem?.planets?.length ?? 0,
    exoMoons: sv.exoSystem?.moons?.length ?? 0,
    distanceFromSunMpc: sv.controls.worldPosition.length() / (3.0857e19),
  };
});
console.log(`  visible object types: ${JSON.stringify(scene.byType)}`);
console.log(`  line objects: ${JSON.stringify(scene.lines)}`);
console.log(`  exo system: ${scene.exoPlanets} planets, ${scene.exoMoons} moons`);
console.log(`  distance from the Sun: ${scene.distanceFromSunMpc.toFixed(2)} Mpc\n`);

const base = await marks();
console.log(`  baseline: ${base.brightPct.toFixed(3)}% of pixels above 60, `
  + `mean ${base.mean.toFixed(2)}`);
await page.screenshot({ path: 'shots/_fornax-all.png' });

console.log('\n  switching each layer off in turn:\n');
const drops = [];
for (const layer of LAYERS) {
  const applied = await page.evaluate((k) => {
    try {
      window.cosminova.setView(k, false);
      return true;
    } catch {
      return false;
    }
  }, layer);
  if (!applied) continue;
  await new Promise((r) => setTimeout(r, 500));
  const m = await marks();
  const drop = base.brightPct - m.brightPct;
  drops.push({ layer, drop, after: m.brightPct });
  console.log(`    without ${layer.padEnd(20)} ${m.brightPct.toFixed(3)}%  `
    + `(${drop >= 0 ? '-' : '+'}${Math.abs(drop).toFixed(3)})`);
  // Put it back, so each layer is measured on its own.
  await page.evaluate((k) => {
    try { window.cosminova.setView(k, true); } catch { /* ignore */ }
  }, layer);
  await new Promise((r) => setTimeout(r, 300));
}

drops.sort((a, b) => b.drop - a.drop);
console.log(`\n  biggest contributors: ${drops.slice(0, 3)
  .map((d) => `${d.layer} (${d.drop.toFixed(3)})`).join(', ')}`);

// The other half of the report was a crowd of names, and labels are only drawn
// with the interface up — so it has to go back on to see them at all. Several
// distances, because the pile-up depends on how much of the system is in frame:
// far enough out and forty-two bodies occupy a few pixels.
await page.evaluate(() => window.cosminova.setUiVisible(true));
for (const radii of [12, 90, 700, 6000]) {
  await goTo('star:Fornax A delta', radii);
  const seen = await page.evaluate(() => {
    const drawn = [...document.querySelectorAll('.obj-label')].filter((n) => !n.hidden);
    const boxes = drawn.map((n) => {
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, text: n.textContent.slice(0, 24) };
    });
    let overlapping = 0;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]; const b = boxes[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
          overlapping++;
          break;
        }
      }
    }
    return { drawn: drawn.length, overlapping, sample: boxes.slice(0, 4).map((b) => b.text) };
  });
  console.log(`\n  at ${String(radii).padStart(5)} radii: ${seen.drawn} labels drawn, `
    + `${seen.overlapping} overlapping`);
  console.log(`    ${JSON.stringify(seen.sample)}`);
  await page.screenshot({ path: `shots/_fornax-${radii}.png` });
}

const labels = await page.evaluate(() => {
  const sv = window.cosminova;
  const items = sv.debug?.collectLabelItems?.() ?? null;
  const drawn = [...document.querySelectorAll('.obj-label')].filter((n) => !n.hidden);
  const boxes = drawn.map((n) => {
    const r = n.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  // How many drawn labels overlap another drawn label.
  let overlapping = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]; const b = boxes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        overlapping++;
        break;
      }
    }
  }
  return { wanted: items ? items.length : null, drawn: drawn.length, overlapping };
});
console.log(`\n  labels: ${labels.wanted ?? '?'} candidates, ${labels.drawn} drawn, `
  + `${labels.overlapping} overlapping another`);

if (errors.length) {
  console.log('\n  errors:');
  for (const e of [...new Set(errors)].slice(0, 6)) console.log(`    ${e}`);
}

await browser.close();
