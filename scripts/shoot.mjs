/**
 * Headless capture harness.
 *
 * Loads the app in local Chrome, applies a named scenario against the debug
 * handle, waits for the large texture tier and for terrain LOD to settle, then
 * writes a screenshot. Also reports console errors and a few numbers from the
 * live scene so regressions show up without eyeballing every shot.
 *
 * Usage: node scripts/shoot.mjs [scenario ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve('shots');
fs.mkdirSync(OUT, { recursive: true });

// distanceRadii is measured from the body centre, so 1.02 is a low orbit and
// 1.0002 is a few hundred metres up.
const SCENARIOS = {
  moon: {
    description: 'Moon from three radii, measured LOLA relief',
    body: 'moon',
    apply: (api) => api.lookFromSun('moon', 2.7, 34, 14),
  },
  moonOrbit: {
    description: 'Low lunar orbit, terminator across the far side highlands',
    body: 'moon',
    apply: (api) => api.lookFromSun('moon', 1.06, 62, 8),
  },
  moonSurface: {
    description: 'A few kilometres above the lunar surface',
    body: 'moon',
    apply: (api) => { api.lookFromSun('moon', 1.0025, 74, 4); api.controls.lookPitch = 0.62; },
  },
  // Regional geology, viewed at a grazing sun. Four kilometres of relief on a
  // three-thousand-kilometre body is invisible at full phase from a distance —
  // the whole disc is lit flat and the terrain reads as albedo. Long shadows near
  // the terminator are the only way to see the shape of it.
  marsGeology: {
    description: 'Mars from low orbit at a grazing sun: dichotomy, plains, rift and shields',
    body: 'mars',
    apply: (api) => api.lookFromSun('mars', 1.16, 74, 12),
  },
  mercuryPlains: {
    description: 'Mercury: smooth volcanic plains against saturated cratered highland',
    body: 'mercury',
    apply: (api) => api.lookFromSun('mercury', 1.14, 71, 10),
  },
  venusPlains: {
    description: 'Venus under its cloud deck: near-global volcanic plain',
    body: 'venus',
    apply: (api) => api.lookFromSun('venus', 1.15, 68, 10),
  },
  // Diagnostics for the four regional processes, each removed on its own from the
  // same frame. Which of them a feature came from is otherwise guesswork.
  diagMarsNoCrust: {
    description: 'Mars with the crustal dichotomy off',
    body: 'mars',
    apply: (api) => {
      api.lookFromSun('mars', 1.16, 74, 12);
      api.setUniform('mars', 'uCrustRelief', 0);
    },
  },
  diagMarsNoFlood: {
    description: 'Mars with the volcanic flooding off, so the plains stay cratered',
    body: 'mars',
    apply: (api) => {
      api.lookFromSun('mars', 1.16, 74, 12);
      api.setUniform('mars', 'uFloodCoverage', 0);
    },
  },
  diagMarsRiftOnly: {
    description: 'Mars with only the rift, to see where it runs',
    body: 'mars',
    apply: (api) => {
      api.lookFromSun('mars', 1.16, 74, 12);
      api.setUniform('mars', 'uCraterOctaves', 0);
      api.setUniform('mars', 'uFloodCoverage', 0);
      api.setUniform('mars', 'uVolcanoCoverage', 0);
    },
  },
  // Flooding taken past its limit: the whole body inside the province and the datum
  // set above every piece of terrain on it, so every crater in view should vanish.
  // The upper bound on what the operator can do, which is the quickest way to tell
  // a flood that is not reaching the ground from a camera that is not over a
  // province — the two look identical on an ordinary view.
  diagMarsFloodEverywhere: {
    description: 'Mars with the lava province covering the whole body',
    body: 'mars',
    apply: (api) => {
      api.lookFromSun('mars', 1.16, 74, 12);
      api.setUniform('mars', 'uFloodCoverage', 1);
      api.setUniform('mars', 'uFloodLevel', 3);
    },
  },
  diagMarsFloodMap: {
    description: 'Mars with the lava fill drawn directly as a map',
    body: 'mars',
    apply: (api) => {
      api.lookFromSun('mars', 1.16, 74, 12);
      api.setUniform('mars', 'uDebugGeology', 1);
    },
  },
  diagMercuryFloodMap: {
    description: 'Mercury with the lava fill drawn directly as a map',
    body: 'mercury',
    apply: (api) => {
      api.lookFromSun('mercury', 1.14, 71, 10);
      api.setUniform('mercury', 'uDebugGeology', 1);
    },
  },
  diagMarsVolcanoesOnly: {
    description: 'Mars with only the shield volcanoes, whole disc at a grazing sun',
    body: 'mars',
    // The whole disc rather than low orbit: a volcanic province covers a tenth of
    // the planet and holds only a handful of edifices, so a close view of an
    // arbitrary spot almost certainly contains none of them.
    apply: (api) => {
      api.lookFromSun('mars', 2.3, 82, 12);
      api.setUniform('mars', 'uCraterOctaves', 0);
      api.setUniform('mars', 'uFloodCoverage', 0);
      api.setUniform('mars', 'uRiftCoverage', 0);
    },
  },
  // Diagnostics: the same low orbit with one relief source at a time, to tell a
  // procedural artefact apart from a measured-elevation one.
  // The two shape terms a small body gets and a large one does not, each on its
  // own. Basins are the coarse pass and carry the only geometry on the body
  // steep enough to out-run the vertex grid, so this is where faceting shows up
  // first; irregular relief is what breaks the silhouette.
  diagPhobosNoBasin: {
    description: 'Phobos with the basin pass off',
    body: 'phobos',
    apply: (api) => {
      api.setDate('2026-03-21T14:40:00Z');
      api.lookFromSun('phobos', 2.4, 55, 18);
      api.setUniform('phobos', 'uBasinDepth', 0);
    },
  },
  diagPhobosBasinOnly: {
    description: 'Phobos with the crater octaves off, basins alone',
    body: 'phobos',
    apply: (api) => {
      api.setDate('2026-03-21T14:40:00Z');
      api.lookFromSun('phobos', 2.4, 55, 18);
      api.setUniform('phobos', 'uCraterOctaves', 0);
    },
  },
  diagPhobosNoIrregular: {
    description: 'Phobos with the irregular relief off',
    body: 'phobos',
    apply: (api) => {
      api.setDate('2026-03-21T14:40:00Z');
      api.lookFromSun('phobos', 2.4, 55, 18);
      api.setUniform('phobos', 'uIrregular', 0);
    },
  },
  diagProc: {
    description: 'Low lunar orbit, procedural relief only',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uDemStrength', 0);
    },
  },
  diagDem: {
    description: 'Low lunar orbit, measured relief only',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uCraterOctaves', 0);
      api.setUniform('moon', 'uRoughness', 0);
    },
  },
  // Relief amplitude sweep: if an artefact scales with these it is the height
  // itself, and if it survives unchanged it is how the height is being sampled.
  diagDem000: {
    description: 'Low lunar orbit, measured relief off',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uDemStrength', 0);
    },
  },
  diagProcOnly: {
    description: 'Low lunar orbit, procedural relief only',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uDemStrength', 0);
    },
  },
  diagDemOnly: {
    description: 'Low lunar orbit, measured relief only',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uCraterOctaves', 0);
      api.setUniform('moon', 'uRoughness', 0);
    },
  },
  diagDemSmooth: {
    description: 'Low lunar orbit, measured relief only, forced four mips coarser',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uCraterOctaves', 0);
      api.setUniform('moon', 'uRoughness', 0);
      api.setUniform('moon', 'uDemLodBias', 4);
    },
  },
  diagDemNoSkirt: {
    description: 'Low lunar orbit, measured relief only, skirts collapsed',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uCraterOctaves', 0);
      api.setUniform('moon', 'uRoughness', 0);
      api.setUniform('moon', 'uSkirtScale', 0);
    },
  },
  diagDemFlatHeight: {
    description: 'Low lunar orbit, elevation flattened but its normals kept',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uCraterOctaves', 0);
      api.setUniform('moon', 'uRoughness', 0);
      api.setUniform('moon', 'uDemLodBias', 20);
    },
  },
  diagDemNoNormals: {
    description: 'Low lunar orbit, elevation displaced but its normals dropped',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uCraterOctaves', 0);
      api.setUniform('moon', 'uRoughness', 0);
      api.setUniform('moon', 'uHasNormal', 0);
    },
  },
  diagLodLow: {
    description: 'Low lunar orbit, elevation pinned to the finest mip',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uDemLodBias', -32);
    },
  },
  diagLodHigh: {
    description: 'Low lunar orbit, elevation forced four mips coarser',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uDemLodBias', 4);
    },
  },
  diagNoSkirt: {
    description: 'Low lunar orbit with the LOD skirts collapsed',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uSkirtScale', 0);
    },
  },
  diagDem005: {
    description: 'Low lunar orbit, measured relief at a twentieth',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uDemStrength', 0.05);
    },
  },
  diagDem100: {
    description: 'Low lunar orbit, measured relief at full strength',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uDemStrength', 1);
    },
  },
  diagFlat: {
    description: 'Low lunar orbit, no relief at all',
    body: 'moon',
    apply: (api) => {
      api.lookFromSun('moon', 1.06, 62, 8);
      api.setUniform('moon', 'uDemStrength', 0);
      api.setUniform('moon', 'uCraterOctaves', 0);
      api.setUniform('moon', 'uRoughness', 0);
      api.setUniform('moon', 'uHasNormal', 0);
    },
  },
  mercury: {
    description: 'Mercury close up, fully procedural saturation cratering',
    body: 'mercury',
    apply: (api) => api.lookFromSun('mercury', 1.05, 58, 10),
  },
  earth: {
    description: 'Earth with atmosphere and city lights near the terminator',
    body: 'earth',
    apply: (api) => api.lookFromSun('earth', 2.6, 46, 16),
  },
  earthLimb: {
    description: 'Low Earth orbit, atmospheric limb',
    body: 'earth',
    apply: (api) => { api.lookFromSun('earth', 1.05, 68, 6); api.controls.lookPitch = 0.5; },
  },
  mars: {
    description: 'Mars from three radii',
    body: 'mars',
    apply: (api) => api.lookFromSun('mars', 2.8, 30, 18),
  },
  jupiter: {
    description: 'Jupiter, banded and oblate',
    body: 'jupiter',
    apply: (api) => api.lookFromSun('jupiter', 3.2, 28, 14),
  },
  io: {
    description: 'Io, volcanic sulphur surface',
    body: 'io',
    apply: (api) => api.lookFromSun('io', 1.6, 36, 12),
  },
  europa: {
    description: 'Europa, ice lineae',
    body: 'europa',
    apply: (api) => api.lookFromSun('europa', 1.5, 36, 12),
  },
  callisto: {
    description: 'Callisto, the most heavily cratered surface known',
    body: 'callisto',
    apply: (api) => api.lookFromSun('callisto', 1.15, 52, 10),
  },
  saturn: {
    description: 'Saturn and the ring system',
    body: 'saturn',
    apply: (api) => api.lookFromSun('saturn', 4.2, 34, 26),
  },
  ringsClose: {
    // The reference for this is the view from just above the ring plane, where
    // the banding has to hold up at a scale the profile texture cannot carry.
    description: 'Low over the ring plane, where ringlet structure has to resolve',
    body: 'saturn',
    // Distances here are in planetary radii and the A ring's outer edge is at
    // 2.27 of Saturn's, so this sits over the ring system with it filling most
    // of the frame, which is where the profile texture used to run out.
    apply: (api) => api.lookFromSun('saturn', 2.4, 50, 58),
  },
  titan: {
    description: 'Titan under its haze',
    body: 'titan',
    apply: (api) => api.lookFromSun('titan', 2.0, 40, 14),
  },
  enceladus: {
    description: 'Enceladus, young ice with the south polar terrain',
    body: 'enceladus',
    apply: (api) => api.lookFromSun('enceladus', 1.8, 38, 16),
  },
  tethys: {
    description: 'Tethys and the Odysseus basin',
    body: 'tethys',
    apply: (api) => api.lookFromSun('tethys', 1.9, 36, 12),
  },
  dione: {
    description: 'Dione, cratered ice with bright cliffs',
    body: 'dione',
    apply: (api) => api.lookFromSun('dione', 1.9, 40, 14),
  },
  rhea: {
    description: 'Rhea, saturation cratered',
    body: 'rhea',
    apply: (api) => api.lookFromSun('rhea', 1.8, 44, 12),
  },
  iapetus: {
    description: 'Iapetus, the two-tone moon',
    body: 'iapetus',
    apply: (api) => api.lookFromSun('iapetus', 2.0, 34, 10),
  },
  triton: {
    description: 'Triton, cantaloupe terrain and nitrogen haze',
    body: 'triton',
    apply: (api) => api.lookFromSun('triton', 2.0, 36, 14),
  },
  pluto: {
    description: 'Pluto, Sputnik Planitia and the cratered uplands',
    body: 'pluto',
    apply: (api) => api.lookFromSun('pluto', 2.2, 30, 12),
  },
  charon: {
    description: 'Charon, canyons and Mordor Macula',
    body: 'charon',
    apply: (api) => api.lookFromSun('charon', 2.0, 38, 14),
  },
  vesta: {
    description: 'Vesta, with the Rheasilvia basin across the south',
    body: 'vesta',
    apply: (api) => api.lookFromSun('vesta', 1.9, 42, 16),
  },
  ceres: {
    description: 'Ceres, from the Dawn framing camera mosaic',
    body: 'ceres',
    apply: (api) => api.lookFromSun('ceres', 1.9, 40, 14),
  },
  phobos: {
    description: 'Phobos: measured triaxial shape, saturated with craters',
    body: 'phobos',
    apply: (api) => {
      // Phobos is inside Mars's shadow at the default epoch, which is correct
      // but makes for a dark shot; step forward one third of an orbit.
      api.setDate('2026-03-21T14:40:00Z');
      api.lookFromSun('phobos', 2.4, 55, 18);
    },
  },
  crescent: {
    description: 'Callisto at 168 degrees phase: the night side must be black',
    body: 'callisto',
    apply: (api) => api.lookFromSun('callisto', 2.6, 168, 6),
  },
  phobosEclipse: {
    description: 'Phobos in the Martian umbra, lit only by planetshine',
    body: 'phobos',
    apply: (api) => {
      api.setDate('2026-03-21T12:00:00Z');
      api.lookFromSun('phobos', 2.4, 20, 12);
    },
  },
  hyperion: {
    description: 'Hyperion, the most irregular body of its size in the system',
    body: 'hyperion',
    apply: (api) => api.lookFromSun('hyperion', 2.4, 50, 16),
  },
  mimas: {
    description: 'Mimas: round, but with Herschel across a third of the disc',
    body: 'mimas',
    apply: (api) => api.lookFromSun('mimas', 2.2, 45, 15),
  },
  sun: {
    description: 'The Sun: granulation, limb darkening, corona',
    body: 'sun',
    apply: (api) => api.target('sun', 6, { yaw: 0.5, pitch: 0.1 }),
  },
  system: {
    description: 'Retreat from Saturn until the whole system is in frame',
    body: 'saturn',
    apply: (api) => api.target('saturn', 90000, { yaw: 0.6, pitch: 0.5 }),
  },
  andromeda: {
    description: 'Andromeda as a faint extended disc, not a glowing oval',
    apply: (api) => api.target('gal:NGC 224', 1.85, { yaw: 0.35, pitch: 0.18 }),
  },
  fromEarth: {
    description: 'Moon as seen from Earth, true angular size',
    apply: (api) => {
      api.target('moon', 3.2);
      api.viewFromEarth(true);
    },
  },

  // Spacecraft. Each is framed at a date inside its own mission, because the
  // date decides where a craft is and half of these no longer exist.
  iss: {
    description: 'The station over the Earth: truss, arrays, radiators, modules',
    body: 'earth',
    apply: (api) => {
      api.setDate('2026-03-21T12:00:00Z');
      api.lookAtCraft('iss', 2.6);
    },
  },
  hubble: {
    description: 'Hubble: aperture door, arrays and the low-gain antennas',
    body: 'earth',
    apply: (api) => {
      api.setDate('2026-03-21T12:00:00Z');
      api.lookAtCraft('hubble', 4);
    },
  },
  voyager: {
    description: 'Voyager 1 in interstellar space: dish, booms, RTGs',
    apply: (api) => {
      api.setDate('2026-03-21T12:00:00Z');
      api.lookAtCraft('voyager1', 4);
    },
  },
  cassiniSaturn: {
    description: 'Cassini in the Saturn system during the mission',
    body: 'saturn',
    apply: (api) => {
      api.setDate('2008-06-01T12:00:00Z');
      api.lookAtCraft('cassini', 4);
    },
  },
  junoJupiter: {
    description: 'Juno over Jupiter, its three solar wings spread',
    body: 'jupiter',
    apply: (api) => {
      api.setDate('2020-06-01T12:00:00Z');
      api.lookAtCraft('juno', 3.4);
    },
  },
  orion: {
    description: 'Orion on Artemis I, capsule and service module',
    apply: (api) => {
      api.setDate('2022-12-01T12:00:00Z');
      api.lookAtCraft('artemis1', 4);
    },
  },
  perseverance: {
    description: 'Perseverance on the floor of Jezero, on the planet\u2019s own terrain',
    body: 'mars',
    apply: (api) => {
      api.setDate('2026-03-21T12:00:00Z');
      api.lookAtCraft('perseverance', 6);
    },
  },
  apollo11Site: {
    description: 'The Apollo 11 descent stage at Tranquillity Base',
    body: 'moon',
    apply: (api) => {
      api.setDate('2026-03-21T12:00:00Z');
      api.lookAtCraft('apollo11', 6);
    },
  },
  apollo11Ground: {
    description: 'Tranquillity Base with the lunar surface behind it',
    body: 'moon',
    apply: (api) => {
      api.setDate('2026-03-21T12:00:00Z');
      api.lookAtCraft('apollo11', 30);
      api.controls.pitch = 0.12;
    },
  },
  voyagerTrail: {
    description: 'Voyager 1\u2019s whole trajectory out of the Solar System',
    apply: (api) => {
      api.setDate('2026-03-21T12:00:00Z');
      // Select the probe, then pull back to the scale of its path: the trail
      // stays with the craft you picked rather than with the camera target.
      api.lookAtCraft('voyager1', 4);
      api.target('sun', 7.4e4, { yaw: 2.1, pitch: 0.62 });
    },
  },
  junoOrbit: {
    description: 'Juno\u2019s orbit around Jupiter, drawn from one revolution',
    body: 'jupiter',
    apply: (api) => {
      api.setDate('2020-06-01T12:00:00Z');
      api.lookAtCraft('juno', 4);
      api.target('craft:juno', 1.2e9, { yaw: 0.9, pitch: 0.5 });
    },
  },
  fromCassini: {
    description: 'Saturn from Cassini\u2019s own camera position',
    body: 'saturn',
    apply: (api) => {
      api.setDate('2006-06-01T12:00:00Z');
      api.lookAtCraft('cassini', 4);
      api.rideCraft('cassini');
    },
  },
};

const requested = process.argv.slice(2);
// Diagnostics isolate one term of the surface shader at a time and are only run
// when named; they are not views anyone would want to look at.
const names = requested.length
  ? requested
  : Object.keys(SCENARIOS).filter((name) => !name.startsWith('diag'));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--window-size=1600,1000',
  ],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
});

const page = await browser.newPage();
const problems = [];
const verbose = process.env.COSMINOVA_VERBOSE === '1';
page.on('console', (message) => {
  if (verbose) console.log(`  [${message.type()}] ${message.text()}`);
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${error.stack ?? error.message}`));
page.on('requestfailed', (request) =>
  problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`),
);
page.on('response', (response) => {
  if (response.status() >= 400) problems.push(`http ${response.status()}: ${response.url()}`);
});

const settle = (frames) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let count = 0;
        const tick = () => (++count > n ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames,
  );

const reportAndExit = async (reason) => {
  console.error(`\n${reason}`);
  const status = await page
    .evaluate(() => ({ hasHandle: Boolean(window.cosminova), ready: window.cosminova?.ready ?? null }))
    .catch(() => null);
  console.error(`page status: ${JSON.stringify(status)}`);
  for (const problem of [...new Set(problems)]) console.error(`  ${problem}`);
  await browser.close();
  process.exit(1);
};

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

try {
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });
} catch {
  await reportAndExit('app never reached a rendered frame');
}
await settle(10);

// Time is frozen for captures so a scenario is reproducible to the frame.
await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setDate('2026-03-21T12:00:00Z');
});

const results = [];
for (const name of names) {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    console.error(`unknown scenario: ${name}`);
    continue;
  }

  await page.evaluate(`(${scenario.apply.toString()})(window.cosminova)`);
  if (scenario.body) {
    await page.evaluate((body) => window.cosminova.loadDetail(body), scenario.body);
  }
  // Terrain LOD ramps over several frames as the octave count climbs, and the
  // large textures have to decode; 60 frames is comfortably past both.
  await settle(60);

  const stats = await page.evaluate(() => window.cosminova.stats());
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });

  // Measured from the saved file, not the live canvas: without
  // preserveDrawingBuffer the canvas reads back empty once the frame is
  // composited, which reported every scene as pure black.
  const pixels = await (async () => {
    const { data, info } = await sharp(file)
      .resize(240, 150, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    let sum = 0;
    let max = 0;
    let nonBlack = 0;
    let blown = 0;
    const count = info.width * info.height;
    for (let i = 0; i < count; i++) {
      const o = i * channels;
      const luma = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
      sum += luma;
      if (luma > max) max = luma;
      if (luma > 4) nonBlack++;
      if (luma > 250) blown++;
    }
    const w = info.width;
    const h = info.height;
    return {
      mean: sum / count,
      max: Math.round(max),
      nonBlack: nonBlack / count,
      blown: blown / count,
    };
  })();

  results.push({ name, file, stats, pixels });
  console.log(
    `${name.padEnd(13)} alt=${formatKm(stats.altitudeKm).padEnd(12)}` +
      ` patches=${String(stats.patches).padEnd(5)}` +
      ` dem=${String(stats.demWidth).padEnd(5)}${stats.hasDem ? 'D' : '-'}${stats.hasNormal ? 'N' : '-'}` +
      ` relief=${stats.reliefKm ? `${stats.reliefKm[0].toFixed(1)}..${stats.reliefKm[1].toFixed(1)}km` : '-'}`.padEnd(
        26,
      ) +
      ` mean=${pixels.mean.toFixed(1).padEnd(6)} max=${pixels.max.toString().padEnd(4)}` +
      ` lit=${(pixels.nonBlack * 100).toFixed(0).padEnd(3)}%` +
      ` blown=${(pixels.blown * 100).toFixed(0).padEnd(3)}% fps=${stats.fps.toFixed(0)}`,
  );
}

function formatKm(km) {
  if (km < 1) return `${(km * 1000).toFixed(0)}m`;
  if (km < 1e4) return `${km.toFixed(1)}km`;
  if (km < 1e7) return `${(km / 1000).toFixed(0)}Mm`;
  return `${(km / 149597870.7).toFixed(2)}AU`;
}

await browser.close();

if (problems.length) {
  console.error('\nPROBLEMS');
  for (const problem of [...new Set(problems)]) console.error(`  ${problem}`);
  process.exitCode = 1;
} else {
  console.log('\nno console errors');
}
