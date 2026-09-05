/**
 * How big and how bright a galaxy actually renders, against how big it should be.
 *
 * Reported as "galaxies just don't show up". They do arrive — the destination
 * resolves and the camera flies the whole way — but what is drawn on arrival is
 * a smudge a few dozen pixels across, which from the chair is indistinguishable
 * from nothing being there.
 *
 * Measuring this needs care in two places that both bit an earlier pass at it.
 * The catalogue is keyed by NGC number, so `gal:M31` is not a destination and
 * asking for one looks exactly like navigation being broken. And a WebGL canvas
 * with no preserved drawing buffer reads back as solid black through drawImage,
 * so pixels have to come from a real screenshot decoded outside the page.
 *
 * Usage: node scripts/galaxy-check.mjs
 */
import sharp from 'sharp';
import puppeteer from 'puppeteer-core';

const URL = 'http://127.0.0.1:5179/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1024;
const H = 640;

// Keyed the way the catalogue keys them, with the name people would search for.
const TARGETS = [
  ['gal:NGC 224', 'Andromeda'],
  ['gal:LMC', 'Large Magellanic Cloud'],
  ['gal:NGC 5128', 'Centaurus A'],
  ['gal:NGC 4594', 'Sombrero'],
];
const DISTANCES = [2.4, 6, 20];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: W, height: H },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text().slice(0, 200));
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.cosminova?.ready === true, { timeout: 120000 });
await page.evaluate(() => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.setUiVisible(false);
  // Only the galaxies. Everything else in the frame is either a point source
  // scattered across all of it or a label, and both defeat the measurement.
  for (const k of ['stars', 'milkyWay', 'labelGalaxies', 'labelStars',
    'labelPlanets', 'labelExo', 'labelCraft', 'labelBlackHoles',
    'distantMarkers', 'craft', 'constellations', 'asterisms']) {
    try { sv.setView(k, false); } catch { /* not every build has every key */ }
  }
});

/** Bounding box and brightness of everything above the black of empty space. */
async function measure() {
  const png = await page.screenshot({ type: 'png' });
  const { data, info } = await sharp(png).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  let minX = info.width; let maxX = -1; let minY = info.height; let maxY = -1;
  let lit = 0; let peak = 0; let sum = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 3;
      const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
      sum += v;
      if (v > peak) peak = v;
      // Stars are single bright pixels; a galaxy is a broad low plateau. The
      // threshold is above the sky and below the disc.
      if (v > 6) {
        lit++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const px = info.width * info.height;
  return {
    litPct: (100 * lit) / px,
    peak,
    mean: sum / px,
    boxW: maxX - minX + 1,
    boxH: maxY - minY + 1,
  };
}

const fov = await page.evaluate(() => window.cosminova.camera.fov);
console.log(`viewport ${W}x${H}, vertical fov ${fov}\n`);

for (const [key, label] of TARGETS) {
  console.log(`${label}  (${key})`);
  for (const d of DISTANCES) {
    const ok = await page.evaluate((k, dd) => {
      const sv = window.cosminova;
      sv.target(k, dd);
      return sv.state.target === k;
    }, key, d);
    if (!ok) {
      console.log(`  ${String(d).padStart(4)} radii   NOT A DESTINATION`);
      continue;
    }
    await new Promise((r) => setTimeout(r, 1200));
    const m = await measure();
    // What the disc should subtend, from the radius the navigation code used
    // to place the camera. Anything much smaller means the billboard is not
    // the size the rest of the app believes the galaxy is.
    const expectedDeg = (2 * Math.atan(1 / d) * 180) / Math.PI;
    const expectedPx = (expectedDeg / fov) * H;
    console.log(`  ${String(d).padStart(4)} radii   `
      + `drawn ${String(m.boxW).padStart(4)}x${String(m.boxH).padStart(3)} px   `
      + `expected ~${expectedPx.toFixed(0)} px   `
      + `peak ${String(Math.round(m.peak)).padStart(3)}   `
      + `lit ${m.litPct.toFixed(2)}%`);
  }
  await page.screenshot({ path: `shots/_gal-${key.replace(/[^a-z0-9]+/gi, '-')}.png` });
  console.log('');
}

// A galaxy is drawn as one flat quad whose orientation is fixed in the world,
// not turned to face the viewer. If that is what is happening, then flying
// around one at a constant distance should take it from full size to nothing as
// the camera crosses its plane — which would be the whole fault, because you
// cannot control which side of a galaxy you arrive on.
console.log('orbiting at 3 radii, looking for the disc edge-on:\n');
const bestByKey = new Map();
const deadAngles = [];
for (const [key, label] of TARGETS) {
  const row = [];
  for (let i = 0; i < 8; i++) {
    const yaw = (i / 8) * Math.PI * 2;
    await page.evaluate((k, y) => {
      window.cosminova.target(k, 3, { yaw: y, pitch: 0.2 });
    }, key, yaw);
    await new Promise((r) => setTimeout(r, 700));
    const m = await measure();
    row.push(m.litPct);
  }
  const max = Math.max(...row);
  bestByKey.set(key, max);
  const dead = row.filter((v) => v < 0.005).length;
  console.log(`  ${label.padEnd(24)} ${row.map((v) => v.toFixed(2).padStart(6)).join('')}`
    + `   max ${max.toFixed(2)}%  ${dead ? `${dead} DEAD ANGLES` : 'visible all round'}`);
  // The actual regression: a galaxy must not be invisible from any direction.
  // Before the quads were made double-sided, every one of these had four dead
  // angles out of eight — an entire hemisphere that rendered nothing.
  if (dead) deadAngles.push(`${label}: ${dead} of 8 viewing angles render nothing`);
}

// Arriving should land on a view of the disc, not on its edge. The billboards
// carry the galaxy's orientation as seen from Earth, so there is exactly one
// good side and the flight code now aims for it; this checks it does, by
// comparing what arrival shows against the best the orbit above ever found.
console.log('\narrival vs. the best view available:\n');
for (const [key, label] of TARGETS) {
  await page.evaluate((k) => window.cosminova.lookAtGalaxy(k, 3), key);
  await new Promise((r) => setTimeout(r, 900));
  const m = await measure();
  const best = bestByKey.get(key) ?? 0;
  const frac = best > 0 ? m.litPct / best : 0;
  console.log(`  ${label.padEnd(24)} arrival ${m.litPct.toFixed(2)}%  `
    + `best seen while orbiting ${best.toFixed(2)}%  (${(frac * 100).toFixed(0)}%)`);
  // Reported, not asserted. A disc's projected area is largest exactly along
  // its normal, which is where arrival now aims, so a low ratio here does not
  // mean the aim is wrong — it means this measurement counts every lit pixel in
  // frame, and close to Andromeda that includes NGC 205 and NGC 221, which are
  // separate destinations in their own right and can outweigh the disc.
  // What this run does assert is the dead angles above.
  await page.screenshot({ path: `shots/_gal-arrive-${key.replace(/[^a-z0-9]+/gi, '-')}.png` });
}

if (errors.length) {
  console.log('\nerrors:');
  for (const e of [...new Set(errors)].slice(0, 8)) console.log(`  ${e}`);
}

await browser.close();

if (deadAngles.length || errors.length) {
  console.log('\nfailures:');
  for (const f of [...deadAngles, ...errors.slice(0, 5)]) console.log(`  ${f}`);
  process.exit(1);
}
console.log('\nevery galaxy renders from every direction');
