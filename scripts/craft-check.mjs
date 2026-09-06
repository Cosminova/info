/**
 * Spacecraft system check.
 *
 * The spacecraft are the one part of this scene whose positions are claims about
 * the real world, so they are worth testing numerically rather than by eye. A
 * screenshot shows that something was drawn; it does not show that the thing
 * drawn was where the spacecraft was.
 *
 * Five things are measured:
 *
 *   motion      The reported velocity against the finite difference of the
 *               reported position. These come from different code paths — the
 *               Hermite spline returns both, and the Kepler solver derives them
 *               separately — so agreeing to a fraction of a percent means the
 *               interpolation is consistent with itself. It also catches segment
 *               boundaries, where a discontinuity shows up as a finite difference
 *               tens of times the true speed.
 *
 *   geometry    Distances against what the mission was. An orbiter has to be
 *               within a plausible altitude of the body it orbits, a lander has
 *               to be on the surface, and a probe leaving the Solar System has
 *               to be further out every year.
 *
 *   history     Historical dates, since the whole point of the timeline is that
 *               a date decides where things are. Apollo 11 in July 1969 has to be
 *               at the Moon and nowhere near it in 2026.
 *
 *   detail      That the level of detail actually changes: a marker at distance,
 *               a mesh close up, and the marker gone by the time the mesh is
 *               readable, rather than both drawn at once.
 *
 *   picking     That a craft framed in the centre of the view is what a click in
 *               the centre of the view selects.
 *
 * Usage: node scripts/craft-check.mjs
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const AU = 149597870.7;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/**
 * What each craft should be true of, and when.
 *
 * `at` is a date the craft was flying. `centre` is the body it should be
 * referred to then. `altKm` bounds the distance from that body's centre, which
 * for an orbiter is a real constraint: Juno's perijove is a few thousand
 * kilometres and its apojove is eight million, and anything outside that is not
 * an orbit around Jupiter.
 */
const EXPECT = [
  { key: 'voyager1', at: '1979-03-05', centre: 'sun', auRange: [4.5, 6] },
  { key: 'voyager1', at: '2026-01-01', centre: 'sun', auRange: [160, 175] },
  { key: 'voyager2', at: '1989-08-25', centre: 'sun', auRange: [29, 31] },
  { key: 'pioneer10', at: '1973-12-04', centre: 'sun', auRange: [4.8, 5.4] },
  { key: 'new-horizons', at: '2015-07-14', centre: 'sun', auRange: [32, 33.5] },
  // Parker's closest perihelion is 6.9 million kilometres, which is 0.046 AU
  // and about nine and a half solar radii.
  { key: 'parker', at: '2024-12-24', centre: 'sun', auRange: [0.044, 0.05] },
  { key: 'cassini', at: '2006-06-01', centre: 'saturn', altKm: [6e4, 5e6] },
  { key: 'cassini', at: '2000-12-30', centre: 'jupiter', altKm: [9e6, 2e8] },
  { key: 'juno', at: '2020-06-01', centre: 'jupiter', altKm: [6e4, 9e6] },
  { key: 'galileo', at: '1997-01-01', centre: 'jupiter', altKm: [1e5, 2e7] },
  { key: 'messenger', at: '2013-01-01', centre: 'mercury', altKm: [2.6e3, 2e5] },
  { key: 'mro', at: '2020-01-01', centre: 'mars', altKm: [3.6e3, 4.2e3] },
  { key: 'maven', at: '2020-01-01', centre: 'mars', altKm: [3.5e3, 1.4e4] },
  { key: 'iss', at: '2026-06-01', centre: 'earth', altKm: [6.7e3, 6.85e3] },
  { key: 'hubble', at: '2026-06-01', centre: 'earth', altKm: [6.8e3, 7.0e3] },
  { key: 'jwst', at: '2026-06-01', centre: 'sun', auRange: [0.98, 1.03] },
  { key: 'lro', at: '2026-06-01', centre: 'moon', altKm: [1.78e3, 1.95e3] },
  { key: 'curiosity', at: '2026-06-01', centre: 'mars', surface: true },
  { key: 'perseverance', at: '2026-06-01', centre: 'mars', surface: true },
  { key: 'apollo11', at: '2026-06-01', centre: 'moon', surface: true },
  // Bennu is not one of this scene's bodies, so the constraint is heliocentric:
  // OSIRIS-REx was station-keeping at Bennu, which was near aphelion.
  { key: 'osiris-rex', at: '2019-06-01', centre: 'sun', auRange: [1.1, 1.4] },
];

/** Craft that must not exist at a date, because they had not launched or had ended. */
const ABSENT = [
  { key: 'iss', at: '1985-01-01' },
  { key: 'juno', at: '2005-01-01' },
  { key: 'curiosity', at: '2005-01-01' },
  { key: 'perseverance', at: '2019-01-01' },
  { key: 'jwst', at: '2015-01-01' },
];

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
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const settle = (frames = 20) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let count = 0;
        const tick = () => (++count > n ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames,
  );

await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
await page.evaluate(() => {
  window.cosminova.setRate(0);
  window.cosminova.setUiVisible?.(false);
});
await settle(20);

// ------------------------------------------------------------------- the data

const loaded = await page.evaluate(() => {
  const f = window.cosminova.craftField;
  return {
    roster: f.specs.length,
    withPaths: f.byKey.size,
    table: Boolean(f.table),
    samples: f.table ? f.table.times.length : 0,
    models: new Set(f.specs.map((s) => s.model)).size,
  };
});

check('trajectory table loaded', loaded.table, `${loaded.samples.toLocaleString()} samples`);
check('roster populated', loaded.roster >= 100, `${loaded.roster} craft, ${loaded.withPaths} with Horizons paths`);
check('models are shared, not per craft', loaded.models < loaded.roster, `${loaded.models} models for ${loaded.roster} craft`);

// --------------------------------------------------------------- the geometry

const probe = await page.evaluate((cases) => {
  const u = window.cosminova.universe;
  const f = window.cosminova.craftField;
  const out = [];
  for (const c of cases) {
    const date = new Date(`${c.at}T12:00:00Z`);
    u.update(date);
    f.update(date, u);
    const s = f.get(c.key);
    if (!s) { out.push({ ...c, missing: true }); continue; }
    const centre = u.get(c.centre);
    const row = {
      ...c,
      present: s.present,
      phase: s.phase,
      centreKey: s.centreKey,
      onSurface: s.onSurface,
      speedKms: s.speedKms,
      sunKm: s.position.length(),
      groundKm: s.groundKm,
    };
    if (centre) {
      row.centreKm = s.position.distanceTo(centre.position);
      row.centreRadiusKm = centre.spec.radiusKm;
    }
    out.push(row);
  }
  return out;
}, EXPECT);

for (const row of probe) {
  const label = `${row.key} @ ${row.at}`;
  if (row.missing) { check(label, false, 'not in the roster'); continue; }
  if (!row.present) { check(label, false, `not present: ${row.phase}`); continue; }

  if (row.auRange) {
    const au = row.sunKm / AU;
    check(
      `${label} distance from Sun`,
      au >= row.auRange[0] && au <= row.auRange[1],
      `${au.toFixed(3)} AU, expected ${row.auRange[0]}\u2013${row.auRange[1]}`,
    );
  }
  if (row.altKm) {
    check(
      `${label} distance from ${row.centre}`,
      row.centreKm >= row.altKm[0] && row.centreKm <= row.altKm[1],
      `${Math.round(row.centreKm).toLocaleString()} km, expected ${row.altKm[0].toExponential(1)}\u2013${row.altKm[1].toExponential(1)}`,
    );
  }
  if (row.surface) {
    // Not "close to the reference radius": the terrain is drawn kilometres
    // either side of that sphere, and the craft is meant to be on the terrain.
    // So the invariant is that it stands exactly at the height the ground under
    // it was reported to be, whatever that height turns out to be. Whether the
    // height is the real one is a separate check, further down, because it needs
    // the body loaded and a frame to read it back.
    const off = row.centreKm - row.centreRadiusKm;
    check(
      `${label} sits on the surface`,
      row.onSurface && Math.abs(off - (row.groundKm ?? 0)) < 0.01,
      `${off.toFixed(3)} km above the datum, ground reported at ${(row.groundKm ?? 0).toFixed(3)} km`,
    );
  }
}

// Where the ground is, for the craft standing on it. The height comes back from
// the terrain shader a frame after it is asked for, so this needs the body
// loaded and the frame loop running, and it is worth the trouble: placing a
// lander on the reference sphere instead of the terrain buried the Apollo
// landers under a kilometre of rock, and the surface check above cannot see that
// because it only compares the craft against the height it was given.
for (const site of [
  { key: 'apollo11', body: 'moon', at: '2026-06-01' },
  { key: 'perseverance', body: 'mars', at: '2026-06-01' },
  { key: 'curiosity', body: 'mars', at: '2026-06-01' },
]) {
  await page.evaluate(async (c) => {
    const api = window.cosminova;
    api.setRate(0);
    api.setDate(`${c.at}T12:00:00Z`);
    await api.loadDetail(c.body);
    api.lookAtCraft(c.key, 60);
  }, site);
  await settle(30);
  const stood = await page.evaluate((c) => {
    const api = window.cosminova;
    const s = api.craftField.get(c.key);
    const body = api.universe.get(c.body);
    const dir = s.position.clone().sub(body.position);
    const off = dir.length() - body.spec.radiusKm;
    // The terrain's own answer, asked for again here rather than trusted from the
    // placement, so a stale cache would show up as a disagreement.
    dir.normalize().applyQuaternion(body.orientation.clone().invert());
    const [terrain] = api.planets.get(c.body).groundHeightsKm(api.renderer, [dir]);
    return { off, ground: s.groundKm, terrain, radiusKm: body.spec.radiusKm };
  }, site);
  check(
    `${site.key} stands on the drawn terrain`,
    stood.ground !== null
      && Math.abs(stood.off - stood.terrain) < 0.05
      && Math.abs(stood.terrain) < stood.radiusKm * 0.01,
    `${stood.off.toFixed(3)} km above the datum, terrain reads ${stood.terrain.toFixed(3)} km`,
  );
}

// Attitude has to be a rotation, not just any matrix: a left-handed basis gets
// through setFromRotationMatrix as a non-unit quaternion, which silently shears
// the model into a sliver instead of turning it.
const attitude = await page.evaluate(() => {
  const u = window.cosminova.universe;
  const f = window.cosminova.craftField;
  const worst = { key: null, error: 0 };
  let checked = 0;
  for (const at of ['1972-04-20', '1997-09-01', '2015-07-14', '2026-03-21']) {
    const date = new Date(`${at}T12:00:00Z`);
    u.update(date);
    f.update(date, u);
    for (const s of f.all()) {
      if (!s.present) continue;
      checked += 1;
      const error = Math.abs(s.orientation.length() - 1);
      if (error > worst.error) { worst.key = s.key; worst.error = error; }
    }
  }
  return { checked, ...worst };
});
check(
  'attitude quaternions are rotations',
  attitude.error < 1e-6,
  `${attitude.checked} states checked, worst ${attitude.key ?? 'none'} off by ${attitude.error.toExponential(1)}`,
);

for (const item of ABSENT) {
  const state = await page.evaluate((c) => {
    const u = window.cosminova.universe;
    const f = window.cosminova.craftField;
    const date = new Date(`${c.at}T12:00:00Z`);
    u.update(date);
    f.update(date, u);
    const s = f.get(c.key);
    return { present: s?.present, phase: s?.phase };
  }, item);
  check(`${item.key} absent in ${item.at.slice(0, 4)}`, state.present === false, state.phase);
}

// ----------------------------------------------------------------- the motion

/**
 * Reported velocity against the finite difference of position, relative to the
 * centre body so the centre's own motion is not counted.
 */
const drift = await page.evaluate((cases) => {
  const u = window.cosminova.universe;
  const f = window.cosminova.craftField;
  const out = [];
  for (const c of cases) {
    if (c.surface) continue;
    const t = new Date(`${c.at}T12:00:00Z`).getTime();
    const h = 20000; // milliseconds, small against every orbit period here
    const relative = (ms) => {
      const date = new Date(ms);
      u.update(date);
      f.update(date, u);
      const s = f.get(c.key);
      if (!s?.present) return null;
      const centre = u.get(s.centreKey);
      return {
        x: s.position.x - (centre?.position.x ?? 0),
        y: s.position.y - (centre?.position.y ?? 0),
        z: s.position.z - (centre?.position.z ?? 0),
        vx: s.velocity.x, vy: s.velocity.y, vz: s.velocity.z,
        speed: s.speedKms,
      };
    };
    const before = relative(t - h);
    const now = relative(t);
    const after = relative(t + h);
    if (!before || !now || !after) continue;
    const dt = (2 * h) / 1000;
    const fd = [
      (after.x - before.x) / dt,
      (after.y - before.y) / dt,
      (after.z - before.z) / dt,
    ];
    const fdSpeed = Math.hypot(...fd);
    const err = Math.hypot(fd[0] - now.vx, fd[1] - now.vy, fd[2] - now.vz);
    out.push({
      key: c.key, at: c.at,
      speed: now.speed,
      fdSpeed,
      relative: now.speed > 0 ? err / now.speed : err,
    });
  }
  return out;
}, EXPECT);

for (const row of drift) {
  // One per cent, which is loose enough for the Kepler segments — where the
  // finite difference walks a real orbit and the velocity is the osculating one
  // — and far tighter than any discontinuity would be.
  check(
    `${row.key} @ ${row.at} velocity matches its own motion`,
    row.relative < 0.01,
    `${row.speed.toFixed(3)} km/s reported, ${row.fdSpeed.toFixed(3)} measured (${(row.relative * 100).toFixed(3)}%)`,
  );
}

// ------------------------------------------------------------- the trajectory

const paths = await page.evaluate((cases) => {
  const u = window.cosminova.universe;
  const f = window.cosminova.craftField;
  return cases.map(({ key, at }) => {
    const date = new Date(`${at}T00:00:00Z`);
    u.update(date);
    f.update(date, u);
    const path = f.trajectory(key, date, u);
    if (!path) return { key, points: 0 };
    // Span of the drawn line, to tell a real path from a degenerate one.
    let min = Infinity;
    let max = 0;
    const n = path.points.length / 3;
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(path.points[i * 3], path.points[i * 3 + 1], path.points[i * 3 + 2]);
      min = Math.min(min, r);
      max = Math.max(max, r);
    }
    return { key, points: n, split: path.split, minKm: min, maxKm: max };
  });
  // Each craft is asked about a date inside its own mission, since a path that
  // is entirely in the past is correct for Cassini in 2020 and would say nothing
  // about whether the past/future split works.
}, [
  { key: 'voyager1', at: '1985-01-01' },
  { key: 'cassini', at: '2008-01-01' },
  { key: 'juno', at: '2020-06-01' },
  { key: 'iss', at: '2026-06-01' },
  { key: 'new-horizons', at: '2013-01-01' },
  { key: 'parker', at: '2022-06-01' },
  { key: 'hubble', at: '2026-06-01' },
]);

for (const p of paths) {
  check(`${p.key} draws a trajectory`, p.points > 32, `${p.points} points`);
  if (p.points > 32) {
    check(
      `${p.key} trajectory has a present`,
      p.split > 0 && p.split < p.points,
      `${p.split} of ${p.points} points already flown`,
    );
  }
}

// ----------------------------------------------------------------- the detail

const lod = await page.evaluate(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const wait = async (n) => { for (let i = 0; i < n; i++) await frame(); };
  const sample = async (radii) => {
    window.cosminova.lookAtCraft('iss', radii);
    await wait(6);
    const d = window.cosminova.craftDetail('iss');
    const mesh = window.cosminova.scene.getObjectByName('craft-iss');
    return { radii, ...d, meshInScene: Boolean(mesh?.visible) };
  };
  window.cosminova.setDate('2026-06-01T00:00:00Z');
  return {
    near: await sample(6),
    mid: await sample(900),
    far: await sample(400000),
  };
});

check('mesh drawn from close up', lod.near.meshFade > 0.99 && lod.near.meshInScene,
  `${lod.near.apparent.toFixed(0)} px across`);
check('marker gone once the mesh is readable', lod.near.markerAlpha < 0.01,
  `marker alpha ${lod.near.markerAlpha.toFixed(3)}`);
check('mesh dropped at distance', lod.far.meshFade < 0.01 && !lod.far.meshInScene,
  `${lod.far.apparent.toFixed(4)} px across`);
// Present, but no more than that. This used to demand more than 0.5, which is
// the setting that made a distant craft brighter than almost every star in the
// frame; the bound is now the dim floor markers sit on, checked at both ends
// so the marker can neither vanish nor grow back into a beacon.
check('marker carries it at distance', lod.far.markerAlpha > 0.05 && lod.far.markerAlpha < 0.15,
  `marker alpha ${lod.far.markerAlpha.toFixed(3)}`);
check('the two cross over rather than switching',
  lod.mid.meshFade > 0.01 && lod.mid.meshFade < 0.99 && lod.mid.markerAlpha > 0.01,
  `at ${lod.mid.apparent.toFixed(2)} px: mesh ${lod.mid.meshFade.toFixed(2)}, marker ${lod.mid.markerAlpha.toFixed(2)}`);

// ---------------------------------------------------------------- the picking

const picking = await page.evaluate(async (keys) => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const wait = async (n) => { for (let i = 0; i < n; i++) await frame(); };
  const out = [];
  for (const key of keys) {
    window.cosminova.setDate('2026-06-01T00:00:00Z');
    const framed = window.cosminova.lookAtCraft(key, 7);
    if (!framed?.present) { out.push({ key, present: false }); continue; }
    await wait(8);
    const hit = window.cosminova.ui
      ? window.cosminova.state.target
      : null;
    const picked = window.cosminova.pick
      ? window.cosminova.pick(window.innerWidth / 2, window.innerHeight / 2)
      : null;
    out.push({ key, present: true, target: hit, picked });
  }
  return out;
}, ['iss', 'hubble', 'jwst', 'perseverance', 'voyager1']);

for (const row of picking) {
  if (!row.present) { check(`${row.key} pickable`, false, 'not present at the test date'); continue; }
  check(
    `${row.key} is what a click in the centre selects`,
    row.picked === `craft:${row.key}`,
    `picked ${row.picked ?? 'nothing'}`,
  );
}

// ----------------------------------------------------------------- the onboard

const onboard = await page.evaluate(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const wait = async (n) => { for (let i = 0; i < n; i++) await frame(); };
  window.cosminova.setDate('2010-06-01T00:00:00Z');
  window.cosminova.lookAtCraft('cassini', 6);
  await wait(6);
  const rode = window.cosminova.rideCraft('cassini');
  await wait(10);
  const item = window.cosminova.craftField.get('cassini');
  const cam = window.cosminova.controls.worldPosition;
  const gap = Math.hypot(
    cam.x - item.position.x,
    cam.y - item.position.y,
    cam.z - item.position.z,
  );
  const near = window.cosminova.camera.near;
  window.cosminova.rideCraft(null);
  await wait(4);
  return { rode, gap, near, riding: window.cosminova.controls.riding };
});

check('onboard camera attaches to the craft', onboard.rode, `camera ${(onboard.gap * 1000).toFixed(1)} m from it`);
check('onboard camera sits within the craft\u2019s own scale', onboard.gap < 0.05, `${(onboard.gap * 1000).toFixed(1)} m`);
check('near plane follows the craft, not the target', onboard.near < 0.001, `near = ${(onboard.near * 1000).toFixed(2)} m`);
check('leaving the craft restores the camera', onboard.riding === false);

// ------------------------------------------------------- the procedural systems

// Nothing here is real, and the point of the checks is that the machinery does
// not know that: an invented probe around another star has to be placed, drawn,
// searched and labelled by the same code as Cassini. The one thing that must
// differ is what it claims about itself.
const exo = await page.evaluate(async () => {
  const api = window.cosminova;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const wait = async (n) => { for (let i = 0; i < n; i++) await frame(); };

  const before = api.craftField.list.length;
  const system = api.destinations.find((d) => d.kind === 'star' && d.system?.planets?.length >= 2);
  api.target(system.key, 40);
  await wait(30);

  const fleet = api.craftField.list.filter((s) => s.spec.procedural);
  const rows = fleet.map((s) => ({
    key: s.key,
    present: s.present,
    onSurface: s.onSurface,
    centre: s.centreKey,
    speedKms: s.speedKms,
    quat: s.orientation.length(),
    radiusKm: Math.hypot(s.local.x, s.local.y, s.local.z),
    listed: !!api.destinations.find((d) => d.key === `craft:${s.key}`),
    tier: api.craftRecord(`craft:${s.key}`)?.data,
  }));

  // Close enough that only a local frame can place it: absolute positions out
  // here are spaced tens of metres apart.
  const flyable = fleet.find((s) => s.present && !s.onSurface);
  api.lookAtCraft(flyable.key, 8);
  await wait(20);
  const near = {
    key: flyable.key,
    detail: api.craftDetail(flyable.key),
    picked: api.pick(window.innerWidth / 2, window.innerHeight / 2),
    distanceKm: api.controls.distanceKm,
  };

  // And leaving takes the fleet with it, or every system visited would pile up.
  const other = api.destinations.find(
    (d) => d.kind === 'star' && d.system?.planets?.length >= 2 && d.key !== system.key,
  );
  api.target(other.key, 40);
  await wait(30);
  const swapped = api.craftField.list.filter((s) => s.spec.procedural);

  return {
    host: system.system.host,
    before,
    rows,
    near,
    after: {
      total: api.craftField.list.length,
      procedural: swapped.length,
      hosts: [...new Set(swapped.map((s) => s.spec.host))],
      stale: api.destinations.filter(
        (d) => d.kind === 'craft' && d.craft?.procedural && !api.craftField.get(d.craft.key),
      ).length,
    },
  };
});

check(`${exo.host} generates a fleet`, exo.rows.length > 0, `${exo.rows.length} craft`);
check(
  'every generated craft is placed',
  exo.rows.every((r) => r.present),
  `${exo.rows.filter((r) => r.present).length} of ${exo.rows.length}`,
);
check(
  'each one orbits or stands on a body of its own system',
  exo.rows.every((r) => r.centre?.startsWith('exo:')),
  [...new Set(exo.rows.map((r) => r.centre))].join(', '),
);
check(
  'orbits are closed, not escaping',
  exo.rows.every((r) => r.onSurface || (r.speedKms > 0.05 && r.speedKms < 400)),
  `${Math.min(...exo.rows.map((r) => r.speedKms)).toFixed(2)}–${Math.max(...exo.rows.map((r) => r.speedKms)).toFixed(2)} km/s`,
);
check(
  'attitudes are rotations',
  exo.rows.every((r) => Math.abs(r.quat - 1) < 1e-6),
  `worst |q| off by ${Math.max(...exo.rows.map((r) => Math.abs(r.quat - 1))).toExponential(1)}`,
);
check(
  'all of them are searchable',
  exo.rows.every((r) => r.listed),
  `${exo.rows.filter((r) => r.listed).length} of ${exo.rows.length} in the destination list`,
);
check(
  'and none of them claims to be real',
  exo.rows.every((r) => r.tier === 'procedural'),
  [...new Set(exo.rows.map((r) => r.tier))].join(', '),
);
check(
  'one can be approached to within metres',
  exo.near.detail && exo.near.detail.meshFade > 0.9,
  exo.near.detail
    ? `${(exo.near.distanceKm * 1000).toFixed(1)} m away, ${exo.near.detail.apparent.toFixed(0)} px across`
    : 'not drawn at all',
);
check(
  'and clicked on from there',
  exo.near.picked === `craft:${exo.near.key}`,
  `picked ${exo.near.picked ?? 'nothing'}`,
);
check(
  'leaving the system unloads its fleet',
  exo.after.hosts.length === 1 && exo.after.hosts[0] !== exo.host,
  `now carrying ${exo.after.hosts.join(', ') || 'none'}`,
);
check(
  'and leaves no orphaned destinations',
  exo.after.stale === 0 && exo.after.total === exo.before + exo.after.procedural,
  `${exo.after.stale} stale, roster ${exo.before} \u2192 ${exo.after.total} carrying ${exo.after.procedural}`,
);

// ----------------------------------------------------------------------- done

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failures ? `\n${failures} failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
