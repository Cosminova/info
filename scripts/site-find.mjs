/**
 * Finds a good place to watch a sunset from.
 *
 * The framing fixes where on the terminator the camera stands, but the world
 * turns underneath it, so the time of day decides what ground is there. A peak
 * is the wrong place to shoot from: standing a couple of kilometres over an
 * eighteen kilometre summit puts the camera above most of the air and the sky
 * goes dark and thin. This sweeps the clock and reports the low, flat sites.
 *
 * Usage: node scripts/site-find.mjs [body ...] [--steps 24]
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const bodies = args.filter((a) => !a.startsWith('--'));
const BODIES = bodies.length ? bodies : ['earth', 'mars'];
const i = args.indexOf('--steps');
const STEPS = i >= 0 ? Number(args[i + 1]) : 24;

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5182/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  defaultViewport: { width: 480, height: 854 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });

const settle = (n) =>
  page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        let count = 0;
        const tick = () => (++count > frames ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );

await page.evaluate(() => window.cosminova.setRate(0));

for (const body of BODIES) {
  // Load the near textures first: the height probe reads the terrain shader,
  // and the answer it gives before the detailed elevation arrives is not the
  // one the camera will be standing on.
  await page.evaluate((key) => {
    window.cosminova.setDate('2026-06-21T00:00:00Z');
    window.cosminova.standAt(key, { sunElevationDeg: 0, altitudeKm: 3 });
  }, body);
  await page.evaluate((key) => window.cosminova.loadDetail(key), body);
  await settle(90);

  const found = [];
  for (let s = 0; s < STEPS; s++) {
    const hours = (s * 24) / STEPS;
    for (const rollDeg of [0, 180]) {
      const r = await page.evaluate(
        ({ key, hours: h, rollDeg: roll }) => {
          const sv = window.cosminova;
          const d = new Date(Date.UTC(2026, 5, 21, 0, 0, 0));
          d.setUTCMinutes(d.getUTCMinutes() + Math.round(h * 60));
          sv.setDate(d.toISOString());
          const placed = sv.standAt(key, { sunElevationDeg: 0, altitudeKm: 3, rollDeg: roll });
          return placed && { ...placed, iso: d.toISOString() };
        },
        { key: body, hours, rollDeg },
      );
      await settle(3);
      if (r) found.push({ hours, rollDeg, groundKm: r.groundKm, sea: r.seaLevelKm, iso: r.iso });
    }
  }

  found.sort((a, b) => a.groundKm - b.groundKm);
  console.log(`\n${body}: lowest ground under the terminator, of ${found.length} sites`);
  for (const f of found.slice(0, 6)) {
    console.log(
      `  ${f.iso}  roll ${String(f.rollDeg).padStart(3)}  ground ${f.groundKm
        .toFixed(2)
        .padStart(7)} km  (sea level ${(f.sea ?? 0).toFixed(2)} km)`,
    );
  }
  const high = found[found.length - 1];
  console.log(`  (worst was ${high.groundKm.toFixed(2)} km, so the choice is worth making)`);
}

await browser.close();
