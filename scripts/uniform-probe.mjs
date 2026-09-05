/**
 * Prints selected surface uniforms for a body, straight off the running page.
 *
 * Exists because inferring uniform values from screenshots is slow and wrong: a
 * feature can be absent because its uniform is zero, because another term is
 * swamping it, or because the value never reached the shader at all, and those
 * look identical on screen.
 *
 * Usage: node scripts/uniform-probe.mjs [body...]
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const NAMES = [
  'uRadius',
  'uSurfaceSeed',
  'uCrustRelief',
  'uFloodCoverage',
  'uFloodLevel',
  'uFloodSoftness',
  'uMacroRelief',
  'uCraterDepth',
  'uCraterFreq',
  'uRoughness',
  'uBasinDepth',
  'uRiftCoverage',
  'uVolcanoCoverage',
];

const bodies = process.argv.slice(2);
const BODIES = bodies.length ? bodies : ['mars', 'mercury', 'venus'];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });

for (const key of BODIES) {
  const values = await page.evaluate(
    (k, names) => {
      const ok = Boolean(window.cosminova.lookFromSun(k, 1.2, 70, 10));
      const found = {};
      for (const name of names) {
        // setUniform reports whether the uniform exists at all, which is the
        // question worth answering when a term appears to do nothing.
        found[name] = window.cosminova.probeUniform
          ? window.cosminova.probeUniform(k, name)
          : null;
      }
      return { ok, found };
    },
    key,
    NAMES,
  );
  console.log(`\n${key}  (camera placed: ${values.ok})`);
  for (const [name, value] of Object.entries(values.found)) {
    console.log(`  ${name.padEnd(18)} ${value === null ? 'NO SUCH UNIFORM' : value}`);
  }
}

await browser.close();
