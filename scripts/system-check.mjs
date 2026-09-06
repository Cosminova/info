/**
 * Systems, wherever they are: a star's planets, a galaxy's stars, a hole's.
 *
 * Three things are being held here, and they were all one fault. BODIES and
 * MOONS are the Sun's, satellitesOf only ever consulted those two, and the
 * system panel took its answer literally — so standing at TRAPPIST-1 with seven
 * planets around it, or at a star in Andromeda with four, the panel said "no
 * known satellites". The black holes said the same and were telling the truth,
 * because nothing had ever been put around them.
 *
 * So: a star with planets has to show them, a galaxy and a black hole have to
 * show the stars filed under them, and every row of every one of those has to
 * be somewhere the app can actually travel to. The last is the one worth
 * asserting hardest — a system panel listing names that resolve to nothing
 * looks completely correct and is a dead end at every click.
 *
 * Usage: node scripts/system-check.mjs [url]
 */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  \u2014 ${detail}` : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });

/**
 * Goes somewhere and reports what the system panel would be given there.
 *
 * Travelled to rather than merely looked up, because for a star the members
 * come from the loaded system when there is one and from the catalogue record
 * when there is not, and those two paths have to agree.
 */
const systemAt = (key) => page.evaluate((target) => {
  const api = window.cosminova;
  api.target(target);
  const known = new Set(api.destinations.map((dest) => dest.key));
  return {
    arrived: api.stats().target === target,
    members: api.systemMembers(target).map((m) => ({
      key: m.key,
      name: m.name,
      note: m.note ?? null,
      listed: known.has(m.key),
    })),
  };
}, key);

/**
 * The same trip, read off the panel the visitor is actually shown.
 *
 * Worth doing separately from the surface above: the panel decides for itself
 * which body's system to show — a moon shows its planet's, and a planet of
 * another star shows its host's — so what is in the list at a given destination
 * is not the same question as what orbits it.
 */
async function panelAt(key) {
  await page.evaluate((target) => {
    window.cosminova.ui.togglePanel('system', true);
    window.cosminova.target(target);
  }, key);
  /*
   * Waited for by the panel's own signature rather than by a stopwatch.
   *
   * The tree is rebuilt in the frame loop, and this check runs on a software
   * renderer at about eight frames a second — with a quality settle after every
   * jump, which makes it slower still just after the moment being measured. A
   * third of a second was two frames on a good jump and none on a bad one, and
   * what came back then was the last system that did get built: the check read
   * Sagittarius A*'s stars at Cygnus X-1 and called it a bug in the app. The
   * signature carries the target it was built for, so there is no need to guess.
   */
  await page.waitForFunction(
    (target) => document.querySelector('.system-tree')?.__sig?.split('|')[1] === target,
    { timeout: 20000 },
    key,
  );
  return page.evaluate(() => {
    const tree = document.querySelector('.system-tree');
    return {
      root: tree?.querySelector('.tree-root')?.textContent?.trim() ?? '',
      empty: tree?.querySelector('.obj-empty')?.textContent?.trim() ?? '',
      rows: [...(tree?.querySelectorAll('.tree-kid') ?? [])].map((row) => ({
        name: row.querySelector('.tree-name')?.textContent ?? '',
        size: row.querySelector('.tree-size')?.textContent ?? '',
      })),
    };
  });
}

// ------------------------------------------------------------------ real stars
console.log('\na star with planets of its own');
{
  const trappist = await systemAt('star:TRAPPIST-1');
  check(
    'TRAPPIST-1 lists its planets',
    trappist.members.length >= 7,
    trappist.members.map((m) => m.name).join(', ') || 'nothing',
  );
  check(
    'and every row of it is a destination in its own right',
    trappist.members.every((m) => m.listed),
    trappist.members.filter((m) => !m.listed).map((m) => m.key).join(', ') || 'all listed',
  );
  const panel = await panelAt('star:TRAPPIST-1');
  check(
    'the panel at the star shows them, where it used to say there were none',
    panel.rows.length >= 7 && !panel.empty,
    panel.empty || `${panel.root}: ${panel.rows.map((r) => r.name).join(', ')}`,
  );
  // A planet of another star, which should show its host and its siblings
  // rather than itself: the same rule that puts a moon under its planet.
  const atPlanet = await panelAt('exo:trappist-1-e');
  check(
    'and from one of those planets, the panel is still the star\u2019s',
    atPlanet.root === 'TRAPPIST-1' && atPlanet.rows.length >= 7,
    `${atPlanet.root} with ${atPlanet.rows.length} rows`,
  );
}

// ------------------------------------------------------------ doubles
console.log('\na double, whose two stars were listed as strangers');
{
  const panel = await panelAt('star:Gl 725 A');
  const companion = panel.rows.find((row) => row.name === 'Gl 725 B');
  check(
    'Gl 725 A shows Gl 725 B as its companion',
    Boolean(companion) && companion.size === 'companion star',
    panel.rows.map((r) => `${r.name} (${r.size})`).join(', ') || panel.empty,
  );
  const both = await page.evaluate(() => window.cosminova.destinations
    .filter((dest) => dest.kind === 'star' && dest.name.startsWith('Gl 725'))
    .map((dest) => `${dest.name}: ${dest.group}`));
  check(
    'and both are filed under the pair rather than under the catalogue',
    both.length >= 2 && both.every((row) => row.endsWith('Gl 725')),
    both.join(', '),
  );
}

// --------------------------------------------------------------- black holes
console.log('\nthe black holes, which had nothing around them');
for (const [name, key] of [
  ['Sagittarius A*', 'bh:sgr-a'],
  ['Cygnus X-1', 'bh:cygnus-x1'],
  ['M87*', 'bh:m87-star'],
]) {
  const system = await systemAt(key);
  check(
    `${name} has stars in orbit`,
    system.members.length >= 3,
    system.members.map((m) => `${m.name} (${m.note})`).join(', ') || 'nothing',
  );
  const first = system.members[0];
  if (!first) continue;
  check(
    `${name}: and they are filed under it, not in with the catalogue stars`,
    system.members.every((m) => m.listed),
    system.members.filter((m) => !m.listed).map((m) => m.key).join(', ') || 'all listed',
  );
  const star = await systemAt(first.key);
  check(
    `${name}: ${first.name} is somewhere you can go, with planets`,
    star.arrived && star.members.length >= 2,
    `${star.members.length} planets`,
  );
  const planet = star.members[0];
  if (!planet) continue;
  const arrived = await page.evaluate((target) => {
    window.cosminova.target(target);
    const stats = window.cosminova.stats();
    const camera = window.cosminova.camera.position;
    return {
      target: stats.target,
      finite: [camera.x, camera.y, camera.z].every(Number.isFinite),
    };
  }, planet.key);
  check(
    `${name}: and its planet ${planet.name} can be travelled to`,
    arrived.target === planet.key && arrived.finite,
    `target ${arrived.target}`,
  );
  const panel = await panelAt(key);
  check(
    `${name}: the panel at the hole lists them, with how far out they orbit`,
    panel.rows.length === system.members.length && panel.rows.every((r) => /AU|pc/.test(r.size)),
    panel.empty || panel.rows.map((r) => `${r.name} ${r.size}`).join(', '),
  );
}

// -------------------------------------------------------------------- galaxies
console.log('\na galaxy, whose stars were already there but unlisted');
{
  const andromeda = await systemAt('gal:NGC 224');
  check(
    'Andromeda lists the stars in it',
    andromeda.members.length >= 6,
    andromeda.members.map((m) => m.name).join(', ') || 'nothing',
  );
  const named = new Set(andromeda.members.map((m) => m.name));
  check(
    'including the two that used to be generated and thrown away',
    named.has('Andromeda eta') && named.has('Andromeda theta'),
    [...named].slice(-3).join(', '),
  );
}

// ------------------------------------------------------------- the search list
console.log('\nthe search list, where a star was its own subtitle');
{
  const rows = await page.evaluate(async () => {
    window.cosminova.ui.focusSearch();
    const input = document.querySelector('.search-input');
    input.value = 'Fornax A';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return [...document.querySelectorAll('.search-row')].slice(0, 12).map((row) => ({
      name: row.querySelector('.r-name span')?.textContent ?? '',
      meta: row.querySelector('.r-meta')?.textContent ?? '',
    }));
  });
  const selfNamed = rows.filter((row) => row.meta.startsWith(row.name));
  check(
    'no row repeats its own name underneath itself',
    selfNamed.length === 0,
    selfNamed.map((r) => `${r.name} / ${r.meta}`).join('; ') || `${rows.length} rows read`,
  );
  const star = rows.find((row) => /^Fornax A [a-z]+$/.test(row.name));
  check(
    'a host star says which galaxy it is in and that it has planets',
    Boolean(star) && star.meta.includes('Fornax A') && /\d+ planets/.test(star.meta),
    star ? `${star.name} \u2014 ${star.meta}` : 'no host star row',
  );
}

check('nothing went wrong', errors.length === 0, [...new Set(errors)].slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL  ${f.name}  ${f.detail}`);
  process.exit(1);
}
