/**
 * Interaction smoke test for the explorer interface.
 *
 * Drives the things a screenshot cannot show — immersive mode, panel collapse,
 * dialogs, Escape unwinding, rebinding a key, bookmarks, the time controller,
 * right-click picking, preference persistence across a reload — and asserts the
 * resulting state. Any console error at any point is a failure.
 *
 * Usage: node scripts/ui-interact.mjs
 */
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
// A native dialog would hang the run; nothing in the interface should open one.
page.on('dialog', async (d) => {
  errors.push(`native dialog opened: ${d.type()} ${d.message()}`);
  await d.dismiss();
});

await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });
await frames(2);

const results = [];
const wait = (ms = 350) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for rendered frames rather than wall-clock time.
 *
 * Under software rendering this scene runs at a fraction of a frame per second,
 * so a sleep long enough to be reliable would make the run take an hour, and a
 * short one tests nothing — the interface only updates when the render loop
 * reaches it.
 */
async function frames(count = 2, timeoutMs = 45000) {
  await page.evaluate(async (n, timeout) => {
    let seen = 0;
    const start = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        if (++seen >= n || performance.now() - start > timeout) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, count, timeoutMs);
}

/**
 * Wait until the inspector is actually describing `name`.
 *
 * A body can take a few frames to resolve while its system loads, so counting
 * frames is not enough; the assertion has to be about the panel's content.
 */
async function inspectorShowing(name, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const shown = await page.evaluate(() => {
      const head = document.querySelector('[data-panel="inspector"] .obj-name');
      const facts = document.querySelector('[data-panel="inspector"] .kv');
      return head && !head.closest('.obj-head').hidden && facts && !facts.hidden
        ? head.textContent
        : null;
    });
    if (shown === name) return true;
    await frames(1);
  }
  return false;
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
  return message;
};

// ---------------------------------------------------------------- immersive

await check('F11 hides the whole interface', async () => {
  await page.keyboard.press('F11');
  await frames(2);
  const state = await page.evaluate(() => {
    const layer = document.querySelector('.ui-layer');
    const cs = getComputedStyle(layer);
    return {
      immersive: document.body.classList.contains('immersive'),
      opacity: cs.opacity,
      events: getComputedStyle(document.querySelector('.ui-layer .panel')).pointerEvents,
      opacity: cs.opacity,
    };
  });
  assert(state.immersive, 'body has the immersive class');
  // Asserted on a panel rather than the layer: the layer is pointer-transparent
  // at all times so the view can be dragged through it, and it is the panels
  // that would otherwise stay clickable while invisible. pointer-events is not
  // transitioned, so this reports the target state even on a stalled render loop.
  assert(state.events === 'none', `panels stop taking events (${state.events})`);

  // The capture path asks for it instantly, which must be fully transparent with
  // no dependence on a transition completing.
  await page.evaluate(() => window.cosminova.setUiVisible(true));
  await frames(1);
  await page.evaluate(() => window.cosminova.setUiVisible(false));
  const instant = await page.evaluate(() => getComputedStyle(document.querySelector('.ui-layer')).opacity);
  assert(Number(instant) === 0, `instant hide is fully transparent (opacity ${instant})`);
  await page.evaluate(() => window.cosminova.setUiVisible(true));
  return `events ${state.events}, instant opacity ${instant}`;
});

await check('F11 restores it', async () => {
  // Enter first, so this exercises the exit regardless of where the previous
  // check left the state.
  await page.evaluate(() => window.cosminova.ui.setImmersive(true, true));
  await frames(1);
  await page.keyboard.press('F11');
  await frames(2);
  const state = await page.evaluate(() => ({
    immersive: document.body.classList.contains('immersive'),
    events: getComputedStyle(document.querySelector('.ui-layer .panel')).pointerEvents,
  }));
  assert(!state.immersive, 'interface is back');
  assert(state.events === 'auto', `panels take events again (${state.events})`);
  return 'restored';
});

// ------------------------------------------------------------------- panels

await check('F3 toggles the object panel', async () => {
  const before = await page.evaluate(() => document.querySelector('[data-panel="inspector"]').hidden);
  await page.keyboard.press('F3');
  await wait();
  const after = await page.evaluate(() => document.querySelector('[data-panel="inspector"]').hidden);
  assert(before !== after, `hidden ${before} -> ${after}`);
  await page.keyboard.press('F3');
  await wait();
  return 'toggles';
});

/**
 * Height read with animations disabled.
 *
 * The collapse animates a grid row, and a CSS transition only advances when the
 * page produces a frame. Under software rendering this scene runs at a few frames
 * a second, so a transition mid-flight can sit at its starting value for seconds
 * — measuring during one says nothing about where it lands. `no-ui-anim` is the
 * same switch the capture path uses to hide the interface instantly.
 */
async function settledHeight(selector) {
  return page.evaluate((sel) => {
    document.body.classList.add('no-ui-anim');
    void document.body.offsetWidth;
    const height = document.querySelector(sel).getBoundingClientRect().height;
    document.body.classList.remove('no-ui-anim');
    return height;
  }, selector);
}

await check('clicking a panel header collapses it', async () => {
  await page.evaluate(() => window.cosminova.ui.togglePanel('navigation', true));
  await wait();
  const target = '[data-panel="navigation"] .panel-collapse';
  const open = await settledHeight(target);

  await page.click('[data-panel="navigation"] .panel-head');
  await wait(400);
  const collapsed = await page.evaluate(() =>
    document.querySelector('[data-panel="navigation"]').classList.contains('is-collapsed'));
  assert(collapsed, 'collapsed');
  // Asserted in pixels as well as by class: a zero-height grid row is still
  // floored by the body's own padding, which left a sliver of empty panel below
  // the header until the collapsed state zeroed it.
  const shut = await settledHeight(target);
  assert(open > 20, `open has height (${Math.round(open)})`);
  assert(shut < 1, `collapses to nothing, header only (${Math.round(shut)})`);

  await page.click('[data-panel="navigation"] .panel-head');
  await wait(400);
  const expanded = await page.evaluate(() =>
    !document.querySelector('[data-panel="navigation"]').classList.contains('is-collapsed'));
  assert(expanded, 'expands again');
  return `${Math.round(open)}px to ${Math.round(shut)}px`;
});

// ------------------------------------------------------------------ dialogs

await check('F1 opens help with rebindable keys listed', async () => {
  await page.keyboard.press('F1');
  await wait();
  const count = await page.evaluate(() => {
    const dialog = [...document.querySelectorAll('.dialog')].find((d) => !d.hidden);
    return dialog ? dialog.querySelectorAll('.help-keys .rebind').length : 0;
  });
  assert(count > 10, `${count} bindings listed`);
  return `${count} bindings`;
});

await check('Esc closes the dialog', async () => {
  await page.keyboard.press('Escape');
  await wait();
  const open = await page.evaluate(() => [...document.querySelectorAll('.dialog')].some((d) => !d.hidden));
  assert(!open, 'closed');
  return 'closed';
});

await check('the catalog dialog builds', async () => {
  await page.evaluate(() => window.cosminova.ui.toggleDialog('catalog', true));
  await wait(600);
  const groups = await page.evaluate(() => document.querySelectorAll('.catalog .section').length);
  assert(groups > 3, `${groups} groups`);
  await page.keyboard.press('Escape');
  await wait();
  return `${groups} groups`;
});

// ---------------------------------------------------------------- rebinding

await check('a shortcut can be rebound and then works', async () => {
  await page.keyboard.press('F1');
  await wait();
  // Rebind "object labels" from F5 to J, then check J toggles it.
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.help-keys')][0];
    const labels = [...rows.children];
    const index = labels.findIndex((n) => n.textContent === 'Object labels');
    labels[index - 1].click();
  });
  await wait();
  await page.keyboard.press('j');
  await wait();
  const binding = await page.evaluate(() => window.cosminova.ui.shortcuts.binding('toggle.labels'));
  assert(binding === 'J', `bound to ${binding}`);
  await page.keyboard.press('Escape');
  await wait();
  const before = await page.evaluate(() => window.cosminova.ui.prefs.get('labels'));
  await page.keyboard.press('j');
  await wait();
  const after = await page.evaluate(() => window.cosminova.ui.prefs.get('labels'));
  assert(before !== after, `labels ${before} -> ${after}`);
  // Put it back so the persistence check below starts from the default.
  await page.evaluate(() => {
    window.cosminova.ui.shortcuts.reset('toggle.labels');
    window.cosminova.ui.prefs.set('labels', true);
  });
  return `rebound to J and fired`;
});

// ---------------------------------------------------------------------- time

await check('space pauses and resumes', async () => {
  const before = await page.evaluate(() => window.cosminova.state.playing);
  await page.keyboard.press('Space');
  await wait();
  const paused = await page.evaluate(() => window.cosminova.state.playing);
  assert(before !== paused, `playing ${before} -> ${paused}`);
  await page.keyboard.press('Space');
  await wait();
  return 'toggles';
});

await check('the time controller reaches reverse', async () => {
  await page.evaluate(() => window.cosminova.setRate(1));
  // Two steps down from realtime: realtime -> reverse realtime.
  await page.click('.timebar .time-step');
  await wait(200);
  const rate = await page.evaluate(() => window.cosminova.state.timeRate);
  assert(rate < 0, `rate is ${rate}`);
  const dateBefore = await page.evaluate(() => window.cosminova.state.date.getTime());
  await frames(3);
  const dateAfter = await page.evaluate(() => window.cosminova.state.date.getTime());
  assert(dateAfter < dateBefore, 'the clock actually runs backwards');
  await page.evaluate(() => window.cosminova.setRate(1));
  return `rate ${rate}, clock moved ${dateAfter - dateBefore} ms`;
});

await check('the custom multiplier is an in-page control', async () => {
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.timebar .btn')];
    buttons.find((b) => b.dataset.tip === 'Custom multiplier').click();
  });
  await wait();
  const visible = await page.evaluate(() => !document.querySelector('.rate-popover').hidden);
  assert(visible, 'popover opened');
  await page.evaluate(() => {
    const input = document.querySelector('.rate-popover input');
    input.value = '-2500';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await wait();
  const rate = await page.evaluate(() => window.cosminova.state.timeRate);
  assert(rate === -2500, `rate is ${rate}`);
  await page.evaluate(() => window.cosminova.setRate(1));
  return 'accepted -2500';
});

// ------------------------------------------------------------------- picking

await check('right-clicking an object opens its menu', async () => {
  await page.evaluate(() => window.cosminova.target('saturn', 4));
  await frames(3);
  const box = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await wait(400);
  const menu = await page.evaluate(() => {
    const node = document.querySelector('.menu:not(.rate-popover)');
    return node ? { title: node.querySelector('.menu-head .t')?.textContent, items: node.querySelectorAll('button').length } : null;
  });
  assert(menu, 'a menu opened');
  assert(menu.items >= 8, `${menu.items} items`);
  await page.keyboard.press('Escape');
  await wait();
  return `${menu.title}, ${menu.items} items`;
});

await check('right-dragging looks around without opening a menu', async () => {
  const centre = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(centre.x + 120, centre.y + 40, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await wait(300);
  const open = await page.evaluate(() => Boolean(document.querySelector('.menu:not(.rate-popover)')));
  assert(!open, 'no menu after a drag');
  const looked = await page.evaluate(() => Math.abs(window.cosminova.controls.lookYaw) > 1e-4);
  assert(looked, 'the view actually turned');
  return 'drag looks, does not open the menu';
});

// ----------------------------------------------------------------- inspector

await check('the inspector shows class-specific fields', async () => {
  await page.evaluate(() => window.cosminova.ui.togglePanel('inspector', true));
  await page.evaluate(() => window.cosminova.target('titan', 3));
  assert(await inspectorShowing('Titan'), 'the inspector reaches Titan');
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-panel="inspector"] .kv dt')].map((n) => n.textContent));
  for (const expected of ['Primary', 'Surface gravity', 'Temperature', 'Atmosphere', 'Orbital period']) {
    assert(rows.includes(expected), `has ${expected}`);
  }
  const gravity = await page.evaluate(() =>
    document.querySelector('[data-panel="inspector"] dd[data-row="Surface gravity"]').textContent);
  // Titan's surface gravity is 1.35 m/s². If the derivation is wrong this is the
  // row that shows it.
  assert(gravity.startsWith('1.35'), `gravity reads ${gravity}`);
  return `${rows.length} rows, gravity ${gravity}`;
});

await check('a galaxy gets galaxy fields and no surface gravity', async () => {
  await page.evaluate(() => window.cosminova.target('gal:NGC 224', 2.4));
  assert(await inspectorShowing('Andromeda Galaxy'), 'the inspector reaches the galaxy');
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-panel="inspector"] .kv dt')].map((n) => n.textContent));
  assert(!rows.includes('Surface gravity'), 'no surface gravity');
  assert(rows.includes('Light travel'), 'has light travel time');
  return rows.join(', ');
});

// ----------------------------------------------------------------- bookmarks

await check('bookmarking works and survives a reload', async () => {
  await page.evaluate(() => window.cosminova.target('europa', 3));
  await frames(3);
  await page.keyboard.press('b');
  await wait(400);
  const saved = await page.evaluate(() => window.cosminova.ui.prefs.get('bookmarks').map((b) => b.key));
  assert(saved.includes('europa'), `saved ${saved.join(',')}`);

  await page.evaluate(() => window.cosminova.ui.prefs.set('accent', 280));
  await wait(400);

  await page.reload({ waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });
  await frames(2);
  const after = await page.evaluate(() => ({
    bookmarks: window.cosminova.ui.prefs.get('bookmarks').map((b) => b.key),
    accent: window.cosminova.ui.prefs.get('accent'),
    accentApplied: document.documentElement.style.getPropertyValue('--ui-accent-h'),
  }));
  assert(after.bookmarks.includes('europa'), 'bookmark restored');
  assert(after.accent === 280, `accent restored (${after.accent})`);
  assert(after.accentApplied.trim() === '280', `accent applied to the document (${after.accentApplied})`);
  return `bookmarks ${after.bookmarks.join(',')}, accent ${after.accent}`;
});

await check('resetting the interface clears customisation', async () => {
  await page.evaluate(() => window.cosminova.ui.prefs.reset());
  await wait(400);
  const accent = await page.evaluate(() => window.cosminova.ui.prefs.get('accent'));
  assert(accent === 199, `accent back to ${accent}`);
  return 'reset';
});

// ------------------------------------------------------------------- report

console.log('');
let failed = 0;
for (const result of results) {
  console.log(`  ${result.ok ? 'ok  ' : 'FAIL'}  ${result.name}${result.detail ? ` \u2014 ${result.detail}` : ''}`);
  if (!result.ok) failed++;
}
if (errors.length) {
  console.log(`\n  ${errors.length} console error(s):`);
  for (const error of errors.slice(0, 10)) console.log(`    ${error}`);
}

await browser.close();
const bad = failed || errors.length;
console.log(bad ? `\n${failed} failed, ${errors.length} console errors` : `\nall ${results.length} interactions pass, no console errors`);
process.exit(bad ? 1 : 0);
