/**
 * Checks that the interface says what it does.
 *
 * Every control here worked before this check existed; the complaint was that
 * you could not tell what any of it was for. So these assertions are about
 * legibility rather than behaviour — that the rail is words and not only
 * pictograms, that no button in the object panel is a mystery on hover, that
 * the guide opens on how to get somewhere rather than on a table of keys, and
 * that the card which explains all of it appears once and then stops.
 *
 * Usage: node scripts/onboard-check.mjs [url]
 */
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  // Wide enough that the rail is allowed its labels; the narrow-screen fallback
  // to icons is deliberate and is covered by the layout check instead.
  defaultViewport: { width: 1760, height: 990, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await new Promise((r) => setTimeout(r, 1600));

// ------------------------------------------------------------- the first visit
const intro = await page.evaluate(() => {
  const node = document.querySelector('.intro');
  if (!node || node.hidden) return null;
  return {
    steps: [...node.querySelectorAll('.intro-step-name')].map((n) => n.textContent.trim()),
    buttons: [...node.querySelectorAll('button')].map((n) => n.textContent.trim()),
  };
});
check('a first visit is greeted with something that explains itself', Boolean(intro));
check(
  'it says how to get somewhere, how to look, and how to fly',
  intro?.steps.length === 3,
  intro ? intro.steps.join(' / ') : 'no card',
);
check(
  'it offers to take you somewhere rather than only describing it',
  Boolean(intro?.buttons.some((b) => /take me/i.test(b))),
  intro ? intro.buttons.join(' / ') : '',
);

// It must not cover the scene: the card tells you to drag, so a card that eats
// the drag is worse than no card. The centre of the viewport should be canvas.
const centreIsScene = await page.evaluate(() => {
  const el = document.elementFromPoint(Math.round(innerWidth * 0.5), Math.round(innerHeight * 0.78));
  return el?.tagName === 'CANVAS';
});
check('the card leaves the scene reachable around it', centreIsScene);

// --------------------------------------------------------------- and only once
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.intro button')].find((x) => /know my way/i.test(x.textContent));
  b?.click();
});
await new Promise((r) => setTimeout(r, 400));
await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await new Promise((r) => setTimeout(r, 1600));
const stillGone = await page.evaluate(() => {
  const node = document.querySelector('.intro');
  return !node || node.hidden;
});
check('dismissing it is remembered across a reload', stillGone);

// --------------------------------------------------------------------- the rail
const rail = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.rail-item')];
  return items.map((node) => {
    const label = node.querySelector('.rail-label');
    const style = label ? getComputedStyle(label) : null;
    return {
      text: label?.textContent.trim() ?? '',
      readable: style ? Number(style.opacity) > 0.5 : false,
      tip: node.dataset.tip ?? '',
      width: node.getBoundingClientRect().width,
      overflows: label ? label.scrollWidth > label.clientWidth + 1 : false,
    };
  });
});
check('the rail has items', rail.length > 0, `${rail.length} items`);
check(
  'every rail item shows its name in words, not only an icon',
  rail.every((r) => r.text && r.readable),
  rail.filter((r) => !r.text || !r.readable).map((r) => r.text || '(blank)').join(', ') || 'all labelled',
);
check(
  'no rail label is cut off by the width the rail was given',
  rail.every((r) => !r.overflows),
  rail.filter((r) => r.overflows).map((r) => r.text).join(', ') || 'all fit',
);
check(
  'every rail item also explains itself on hover',
  rail.every((r) => r.tip),
  rail.filter((r) => !r.tip).map((r) => r.text).join(', ') || 'all covered',
);

// --------------------------------------------------- the object panel's actions
await page.evaluate(() => window.cosminova.target('mars', 4));
await new Promise((r) => setTimeout(r, 2200));
const actions = await page.evaluate(() => {
  // Scoped to the object panel. `.obj-actions` is a shared row style and the
  // navigation panel uses it too, so an unscoped query answers about the wrong
  // three buttons entirely.
  const row = document.querySelector('[data-panel="inspector"] .obj-actions');
  if (!row) return null;
  return [...row.querySelectorAll('button')].map((b) => ({
    label: b.textContent.trim(),
    tip: b.dataset.tip ?? b.title ?? '',
  }));
});
check('the object panel offers actions', Boolean(actions?.length), `${actions?.length ?? 0} buttons`);
check(
  'every action says what it does on hover',
  Boolean(actions?.every((a) => a.tip.length > 12)),
  actions ? actions.filter((a) => a.tip.length <= 12).map((a) => a.label).join(', ') || 'all explained' : '',
);
// The row used to carry three pairs that ran identical code, which is most of
// why the difference between them could not be guessed: there was none.
const labels = (actions ?? []).map((a) => a.label);
check(
  'no two actions are the same thing under different names',
  new Set(labels).size === labels.length && !labels.includes('Follow'),
  labels.join(' / '),
);

// ---------------------------------------------------------------- camera modes
const modes = await page.evaluate(() =>
  [...document.querySelectorAll('.segmented button')]
    .map((b) => ({ label: b.textContent.trim(), tip: b.title || b.dataset.tip || '' }))
    .filter((m) => ['Orbit', 'Fly', 'Track', 'Roam'].includes(m.label)),
);
check('all four camera modes are offered', modes.length === 4, modes.map((m) => m.label).join(' / '));
check(
  'each camera mode explains what it does to the camera',
  modes.every((m) => m.tip.length > 20),
  modes.filter((m) => m.tip.length <= 20).map((m) => m.label).join(', ') || 'all explained',
);

// ----------------------------------------------------------------- the guide
await page.evaluate(() => window.cosminova.ui.toggleDialog('help', true));
await new Promise((r) => setTimeout(r, 500));
const help = await page.evaluate(() => {
  const dialog = [...document.querySelectorAll('.dialog')].find((d) => !d.hidden && /get around|controls/i.test(d.textContent));
  if (!dialog) return null;
  return {
    titles: [...dialog.querySelectorAll('.section-title')].map((n) => n.textContent.trim()),
    firstTitle: dialog.querySelector('.section-title')?.textContent.trim() ?? '',
    mentionsRoam: /roam/i.test(dialog.textContent),
    mentionsDestinations: /destinations/i.test(dialog.textContent),
    prose: [...dialog.querySelectorAll('.prose')].length,
  };
});
check('the guide opens', Boolean(help));
check(
  'it leads with how to get somewhere, not with a table of keys',
  /getting somewhere/i.test(help?.firstTitle ?? ''),
  help?.firstTitle ?? '',
);
check(
  'it explains the destination list and the untethered mode',
  Boolean(help?.mentionsDestinations && help?.mentionsRoam),
  `destinations=${help?.mentionsDestinations} roam=${help?.mentionsRoam}`,
);
check('it teaches in prose rather than only listing', (help?.prose ?? 0) >= 4, `${help?.prose} paragraphs`);

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log('');
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);

await browser.close();
process.exit(failed ? 1 : 0);
