/**
 * Can you still go everywhere?
 *
 * Reported as no longer being able to travel around the universe. Navigation has
 * a lot of separate paths behind one verb — a solar-system body, a moon, a
 * spacecraft, a catalogue star, an exoplanet, a system invented inside a galaxy,
 * a galaxy itself, a black hole — and they resolve through different code. A
 * break in one of them looks like "travel is broken" from the outside.
 *
 * So each kind is tried in turn and the camera is asked where it ended up. A
 * target counts as reached when the selection took, the camera is a sane
 * distance from something rather than at the origin or at infinity, and the
 * frame afterwards has anything in it at all. Reporting per kind is the point:
 * it says which path broke rather than that something did.
 *
 * Arriving is only half of it, so the view is also nudged and re-shot: a throw
 * partway through the frame leaves the last good image on screen and the sim
 * running behind it, which looks fine in a single screenshot and is exactly the
 * failure that prompted this. A still image after the camera moved means the
 * frame is dying somewhere, so the console is read back per target to say where.
 *
 * Usage: node scripts/travel-check.mjs
 */
import sharp from 'sharp';
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const TARGETS = [
  ['planet', 'mars'],
  ['moon', 'europa'],
  ['craft', 'craft:voyager1'],
  ['near star', 'star:Vega'],
  ['exoplanet', 'exo:trappist-1-e'],
  ['exo host', 'star:TRAPPIST-1'],
  ['far exoplanet', 'exo:kepler-452-b'],
  ['galaxy', 'gal:NGC 224'],
  ['invented star', 'star:Andromeda alpha'],
  ['invented planet', 'exo:andromeda-alpha-b'],
  ['black hole', 'bh:sgr-a'],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle'],
  defaultViewport: { width: 800, height: 500 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.cosminova?.ready === true, { timeout: 120000 });
await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setUiVisible(false);
});

const bhKey = await page.evaluate(() => {
  const list = window.cosminova.destinations ?? [];
  return list.find((d) => d.kind === 'black-hole')?.key ?? null;
});

let failures = 0;
console.log(`travelling to one of each kind of destination:\n`);
console.log('  kind              key                        result');

for (const [kind, rawKey] of TARGETS) {
  const key = kind === 'black hole' ? (bhKey ?? rawKey) : rawKey;
  const before = await page.evaluate(() => window.cosminova.state.target);
  let outcome;
  try {
    outcome = await page.evaluate((k) => {
      const sv = window.cosminova;
      const known = (sv.destinations ?? []).some((d) => d.key === k);
      try {
        sv.target(k, 6);
      } catch (err) {
        return { listed: known, threw: String(err && err.message) };
      }
      return { listed: known, threw: null };
    }, key);
  } catch (err) {
    outcome = { listed: false, threw: String(err.message) };
  }
  await new Promise((r) => setTimeout(r, 2600));

  const landed = await page.evaluate(() => {
    const sv = window.cosminova;
    const s = sv.stats();
    const p = sv.controls?.worldPosition;
    return {
      target: sv.state.target,
      altitudeKm: s.altitudeKm,
      distanceRadii: s.distanceRadii,
      finite: p ? Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) : false,
    };
  });

  const grey = async () => {
    const png = await page.screenshot({ type: 'png' });
    const { data } = await sharp(png).removeAlpha().greyscale().raw()
      .toBuffer({ resolveWithObject: true });
    return data;
  };

  const before2 = await grey();
  let lit = 0;
  for (let i = 0; i < before2.length; i++) if (before2[i] > 8) lit++;
  const litPct = (100 * lit) / before2.length;

  // Move the camera and look again: a frame that throws part-way keeps showing
  // the last image it managed to finish.
  await page.evaluate(() => { window.cosminova.controls.yaw += 0.12; });
  await new Promise((r) => setTimeout(r, 500));
  const after2 = await grey();
  let moved = 0;
  for (let i = 0; i < after2.length; i++) if (Math.abs(after2[i] - before2[i]) > 3) moved++;
  const movedPct = (100 * moved) / after2.length;

  const problems = [];
  if (movedPct < 0.05) problems.push(`view frozen (${movedPct.toFixed(3)}% changed after turning)`);
  const fresh = errors.splice(0, errors.length);
  if (fresh.length) problems.push(`error: ${[...new Set(fresh)][0].slice(0, 90)}`);
  if (!outcome.listed) problems.push('not in the destination list');
  if (outcome.threw) problems.push(`threw: ${outcome.threw}`);
  if (landed.target !== key) problems.push(`target stayed ${landed.target === before ? 'put' : `at ${landed.target}`}`);
  if (!landed.finite) problems.push('camera position not finite');
  if (!(landed.altitudeKm > 0) || !Number.isFinite(landed.altitudeKm)) {
    problems.push(`altitude ${landed.altitudeKm}`);
  }
  if (litPct < 0.02) problems.push(`frame empty (${litPct.toFixed(3)}% lit)`);

  if (problems.length) failures++;
  console.log(`  ${(problems.length ? 'FAIL' : 'ok  ')} ${kind.padEnd(15)} ${key.padEnd(26)} `
    + (problems.length
      ? problems.join('; ')
      : `alt ${Number(landed.altitudeKm).toExponential(2)} km, ${litPct.toFixed(2)}% lit, live`));
}

console.log(`\n${failures ? `${failures} of ${TARGETS.length} destinations unreachable` : 'every kind of destination is reachable'}`);
await browser.close();
process.exit(failures || errors.length ? 1 : 0);
