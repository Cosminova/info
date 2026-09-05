/**
 * Same camera, with the sky's two passes switched on one at a time, so an
 * artefact can be attributed to the pass that draws it.
 *
 * Usage: node scripts/_sky-isolate.mjs [body] [--phase 88]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BODY = args[0] && !args[0].startsWith('--') ? args[0] : 'earth';
const PHASE = Number(option('phase', 88));
const PITCH = Number(option('pitch', 1.45));

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5182/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots/sunset');
fs.mkdirSync(OUT, { recursive: true });
const W = 480;
const H = 854;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new', '--hide-scrollbars', '--mute-audio', '--no-sandbox',
    '--enable-unsafe-swiftshader', '--use-gl=angle', `--window-size=${W},${H}`,
  ],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
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

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });

await page.evaluate(() => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.setDate('2026-06-21T12:00:00Z');
  sv.setUiVisible(false);
  sv.setQuality('ultra');
  for (const key of ['craft', 'trajectories', 'craftVectors', 'distantMarkers']) sv.setView(key, false);
});

const MODES = [
  { name: 'both', extinction: true, inscatter: true, terrain: true, bloom: true },
  { name: 'both-nobloom', extinction: true, inscatter: true, terrain: true, bloom: false },
  { name: 'inscatter-nobloom', extinction: false, inscatter: true, terrain: true, bloom: false },
  { name: 'nosky-nobloom', extinction: false, inscatter: false, terrain: true, bloom: false },
];

const made = [];
for (const mode of MODES) {
  await page.evaluate(
    ({ body, phase, pitch, m }) => {
      const sv = window.cosminova;
      sv.lookFromSun(body, 1.0006, phase, 0);
      const c = sv.controls;
      c.autoCenter = false;
      c.lookYaw = 0;
      c.lookPitch = pitch;
      c.fov = 70;
      sv.setView('bloom', m.bloom);
      const planet = sv.planets.get(body);
      window.__planet = planet;
      window.__modeApply = () => {
        if (!planet?.sky) return;
        planet.sky.children[0].visible = m.extinction;
        planet.sky.children[1].visible = m.inscatter;
        planet.mesh.visible = m.terrain;
      };
    },
    { body: BODY, phase: PHASE, pitch: PITCH, m: mode },
  );
  await page.evaluate((key) => window.cosminova.loadDetail(key), BODY);
  await settle(90);
  // Applied last: the frame loop owns sky visibility, so this has to land after
  // the final update before the shot.
  await page.evaluate(() => window.__modeApply());
  await settle(1);

  const file = path.join(OUT, `iso-${mode.name}.png`);
  await page.screenshot({ path: file });
  made.push({ name: mode.name, file });
  console.log(`${mode.name.padEnd(16)} written`);
}

const tw = 300;
const th = Math.round((tw * H) / W);
const tiles = await Promise.all(
  made.map(async (m, i) => ({
    input: await sharp(m.file).resize(tw, th, { fit: 'fill' }).png().toBuffer(),
    left: i * tw,
    top: 0,
  })),
);
const sheet = path.join(OUT, 'sheet-isolate.png');
await sharp({
  create: { width: made.length * tw, height: th, channels: 3, background: { r: 10, g: 10, b: 14 } },
}).composite(tiles).png().toFile(sheet);
console.log(`\nsheet: ${sheet}`);
console.log(made.map((m, i) => `${i + 1}. ${m.name}`).join('   '));

await browser.close();
