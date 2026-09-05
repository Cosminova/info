/**
 * Why the sky is or is not on screen: reports the state of the two sky shells
 * for a body while standing on it.
 *
 * Usage: node scripts/_sky-probe.mjs
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
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE:', m.text().slice(0, 300));
});
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

const report = await page.evaluate(async () => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.setDate('2026-06-21T12:00:00Z');
  sv.target('sun', 12);
  sv.viewFromEarth(true);
  await new Promise((r) => setTimeout(r, 1500));

  const earth = sv.planets.get('earth');
  const out = {
    hasPlanet: Boolean(earth),
    hasSky: Boolean(earth?.sky),
    skyVisible: earth?.sky?.visible ?? null,
    hazeVisible: earth?.atmosphere?.visible ?? null,
    inSceneGraph: Boolean(earth?.group?.parent),
    groupVisible: earth?.group?.visible ?? null,
    radius: earth?.radius,
    shellRadius: earth?.skyUniforms?.uShellRadius.value,
    cameraLocalLen: earth?.skyUniforms?.uCameraLocal.value.length(),
    sunDir: earth?.skyUniforms?.uSunDir.value.toArray(),
    rayleigh: earth?.skyUniforms?.uRayleigh.value.toArray(),
    mie: earth?.skyUniforms?.uMie.value,
    scaleHeight: earth?.skyUniforms?.uScaleHeight.value,
    brightness: earth?.skyInscatterMaterial?.uniforms.uBrightness.value,
    sunIntensity: earth?.skyInscatterMaterial?.uniforms.uSunIntensity.value,
    cameraAltitudeKm: sv.stats().altitudeKm,
    childOrders: earth?.sky?.children.map((c) => ({ order: c.renderOrder, visible: c.visible })),
  };
  return out;
});

console.log(JSON.stringify(report, null, 2));
await settle(30);
await browser.close();
