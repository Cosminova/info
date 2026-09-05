/**
 * Interaction smoke test for the planetarium interface.
 *
 * The layout is checked by ui-check.mjs; this drives the things a screenshot
 * cannot show. The point of interest here is different from the explorer's: this
 * view's controls were already wired in main.js and the shell was added around
 * them, so most of these assertions are about the two not disagreeing — the rail
 * and the options button driving one panel, one handler per key, and the sky's
 * own keys still working after the shortcut table was layered on top.
 *
 * Usage: node scripts/sky-interact.mjs
 */
import puppeteer from 'puppeteer-core';

const URL = (process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/') + 'sky.html';
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
page.on('dialog', async (d) => {
  errors.push(`native dialog opened: ${d.type()} ${d.message()}`);
  await d.dismiss();
});

await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });

const results = [];
const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/** Wait on rendered frames, not wall-clock time: software rendering is slow. */
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

async function check(name, fn) {
  try {
    results.push({ name, ok: true, detail: await fn() });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
  return message;
};

const hidden = (id) => page.evaluate((x) => document.getElementById(x).hidden, id);

// Start from a known state, since preferences persist across runs.
await page.evaluate(() => window.cosminova.ui.prefs.reset());
await page.reload({ waitUntil: 'load' });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });

// ----------------------------------------------------------------- immersive

await check('F11 hides the whole interface', async () => {
  await page.keyboard.press('F11');
  await frames(2);
  const state = await page.evaluate(() => ({
    immersive: document.body.classList.contains('immersive'),
    opacity: getComputedStyle(document.querySelector('.ui-layer')).opacity,
    events: getComputedStyle(document.querySelector('.ui-layer .panel')).pointerEvents,
    labels: getComputedStyle(document.getElementById('labels')).opacity,
  }));
  assert(state.immersive, 'body has the immersive class');
  assert(state.events === 'none', `panels stop taking events (${state.events})`);
  // The sky labels are drawn outside the interface layer, so they need their own
  // rule; a cinematic shot of the sky should not have names written across it.
  assert(Number(state.labels) === 0, `sky labels hidden (opacity ${state.labels})`);
  return `events ${state.events}, labels ${state.labels}`;
});

await check('the capture path hides it instantly', async () => {
  await page.evaluate(() => window.cosminova.setUiVisible(true));
  await frames(1);
  await page.evaluate(() => window.cosminova.setUiVisible(false));
  const opacity = await page.evaluate(
    () => getComputedStyle(document.querySelector('.ui-layer')).opacity,
  );
  assert(Number(opacity) === 0, `fully transparent without waiting for a transition (${opacity})`);
  await page.evaluate(() => window.cosminova.setUiVisible(true));
  return `opacity ${opacity}`;
});

await check('F11 restores it', async () => {
  await page.evaluate(() => window.cosminova.ui.setImmersive(true, true));
  await frames(1);
  await page.keyboard.press('F11');
  await frames(2);
  const immersive = await page.evaluate(() => document.body.classList.contains('immersive'));
  assert(!immersive, 'interface is back');
  return 'restored';
});

// --------------------------------------------------------------------- panels

await check('the rail and the options button drive one panel', async () => {
  const before = await hidden('panel');
  await page.click('#btn-panel');
  await wait();
  const afterButton = await hidden('panel');
  assert(afterButton !== before, `options button toggled it (${before} to ${afterButton})`);

  // The rail must agree, not toggle a second, private notion of open.
  const railActive = await page.evaluate(
    () => document.querySelectorAll('.rail-item')[3].classList.contains('is-active'),
  );
  assert(railActive === !afterButton, 'the rail shows the same state the button left');

  await page.evaluate(() => window.cosminova.ui.togglePanel('options'));
  await wait();
  const afterRail = await hidden('panel');
  assert(afterRail !== afterButton, 'the rail toggles the same element');
  return `button ${afterButton}, rail ${afterRail}`;
});

await check('F9 and F4 toggle their panels', async () => {
  const optionsBefore = await hidden('panel');
  await page.keyboard.press('F9');
  await wait();
  assert((await hidden('panel')) !== optionsBefore, 'F9 toggled options');

  const readoutBefore = await hidden('readout-panel');
  await page.keyboard.press('F4');
  await wait();
  assert((await hidden('readout-panel')) !== readoutBefore, 'F4 toggled coordinates');
  return 'both';
});

/**
 * Heights are read with animations disabled.
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
  await page.evaluate(() => window.cosminova.ui.togglePanel('readout', true));
  await wait();
  const target = '#readout-panel .panel-collapse';
  const open = await settledHeight(target);

  await page.click('#readout-panel .panel-head');
  await wait(300);
  const collapsed = await page.evaluate(
    () => document.getElementById('readout-panel').classList.contains('is-collapsed'),
  );
  assert(collapsed, 'the click marked the panel collapsed');
  const shut = await settledHeight(target);
  assert(open > 20, `open has height (${Math.round(open)})`);
  assert(shut < 1, `collapses to nothing, header only (${Math.round(shut)})`);

  await page.click('#readout-panel .panel-head');
  await wait(300);
  assert((await settledHeight(target)) > 20, 'expands again');
  return `${Math.round(open)}px to ${Math.round(shut)}px`;
});

await check('a collapsed panel stays collapsed across a reload', async () => {
  await page.click('#readout-panel .panel-head');
  await wait(500);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });
  const collapsed = await page.evaluate(
    () => document.getElementById('readout-panel').classList.contains('is-collapsed'),
  );
  assert(collapsed, 'still collapsed after reload');
  await page.click('#readout-panel .panel-head');
  await wait(400);
  return 'remembered';
});

// -------------------------------------------------------------------- dialogs

await check('F1 opens help with the keys listed', async () => {
  await page.keyboard.press('F1');
  await wait();
  assert(!(await hidden('help')), 'help is open');
  const counts = await page.evaluate(() => ({
    rebindable: document.querySelectorAll('#help-keys button.rebind').length,
    fixed: document.querySelectorAll('#help-keys kbd').length,
  }));
  assert(counts.rebindable >= 8, `${counts.rebindable} rebindable keys listed`);
  // The keys main.js owns are listed too, or the panel is not a full reference.
  assert(counts.fixed >= 8, `${counts.fixed} fixed sky keys listed`);
  return `${counts.rebindable} rebindable, ${counts.fixed} fixed`;
});

await check('Esc closes the dialog', async () => {
  await page.keyboard.press('Escape');
  await wait();
  assert(await hidden('help'), 'help closed');
  return 'closed';
});

await check('the interface settings dialog opens and retints', async () => {
  await page.keyboard.press('F10');
  await wait();
  const open = await page.evaluate(
    () => Boolean(document.querySelector('.dialog.is-right')) &&
      !document.querySelector('.dialog.is-right').hidden,
  );
  assert(open, 'settings dialog is open');

  await page.evaluate(() => window.cosminova.ui.prefs.set('accent', 24));
  await wait();
  const hue = await page.evaluate(
    () => getComputedStyle(document.documentElement).getPropertyValue('--ui-accent-h').trim(),
  );
  assert(hue === '24', `accent hue applied to the document (${hue})`);
  await page.keyboard.press('Escape');
  await wait();
  return `hue ${hue}`;
});

// ------------------------------------------------------------------ shortcuts

await check('a shortcut can be rebound and then works', async () => {
  await page.keyboard.press('F1');
  await wait();
  // Rebind the coordinates panel from F4 to Shift+K.
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('#help-keys button.rebind')];
    const row = buttons.find((b) => b.nextElementSibling.textContent.includes('Coordinates'));
    row.click();
  });
  await page.keyboard.down('Shift');
  await page.keyboard.press('K');
  await page.keyboard.up('Shift');
  await wait();
  await page.keyboard.press('Escape');
  await wait();

  const before = await hidden('readout-panel');
  await page.keyboard.down('Shift');
  await page.keyboard.press('K');
  await page.keyboard.up('Shift');
  await wait();
  const after = await hidden('readout-panel');
  assert(after !== before, 'the new binding toggles the panel');

  // And the old key must no longer do it.
  await page.keyboard.press('F4');
  await wait();
  assert((await hidden('readout-panel')) === after, 'F4 no longer toggles it');
  return 'Shift+K works, F4 does not';
});

await check("the sky's own keys still work", async () => {
  // main.js owns these. The shell deliberately does not register them, so a
  // single press must move the view exactly once.
  const fovBefore = await page.evaluate(() => window.cosminova.controls.fov);
  await page.keyboard.press('Minus');
  await frames(3);
  const fovAfter = await page.evaluate(() => window.cosminova.controls.fov);
  assert(fovAfter > fovBefore, `zoom out widened the field (${fovBefore.toFixed(1)} to ${fovAfter.toFixed(1)})`);

  const yawBefore = await page.evaluate(() => window.cosminova.controls.yaw);
  await page.keyboard.press('ArrowLeft');
  await frames(3);
  const yawAfter = await page.evaluate(() => window.cosminova.controls.yaw);
  assert(yawAfter !== yawBefore, 'arrow key panned the view');
  return `fov ${fovBefore.toFixed(1)} to ${fovAfter.toFixed(1)}`;
});

await check('space pauses and resumes, and is not handled twice', async () => {
  const rate = () => page.evaluate(() => window.cosminova.state.timeRate);
  await page.evaluate(() => window.cosminova.setRate(1));
  await wait();
  await page.keyboard.press('Space');
  await wait();
  const paused = await rate();
  assert(paused === 0, `paused (rate ${paused})`);
  await page.keyboard.press('Space');
  await wait();
  const resumed = await rate();
  // Two handlers would pause and immediately resume, leaving this at 0.
  assert(resumed === 1, `resumed to realtime (rate ${resumed})`);
  return `0 then ${resumed}`;
});

await check('the time controller reaches reverse', async () => {
  await page.evaluate(() => window.cosminova.setRate(1));
  await wait();
  await page.click('#rates .time-step[data-rate="-1"]');
  await wait();
  const rate = await page.evaluate(() => window.cosminova.state.timeRate);
  assert(rate < 0, `time runs backwards (rate ${rate})`);
  const label = await page.evaluate(() => document.getElementById('rate-label').textContent);
  assert(/\u2212|-/.test(label) || label === 'realtime', `rate label reads "${label}"`);
  await page.evaluate(() => window.cosminova.setRate(1));
  return `rate ${rate}, label "${label}"`;
});

// -------------------------------------------------------------------- search

await check('search finds a star and selecting it fills the panel', async () => {
  await page.evaluate(() => {
    const input = document.getElementById('search-input');
    input.focus();
    input.value = 'vega';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(500);
  const rows = await page.evaluate(
    () => [...document.querySelectorAll('#search-results .search-row')].map((n) => n.textContent),
  );
  assert(rows.length > 0, `${rows.length} results for "vega"`);

  // A real press, not a synthetic click: the rows commit on mousedown so that
  // picking one does not first blur the input and close the list underneath the
  // cursor.
  await page.click('#search-results .search-row');
  await frames(4);
  const shown = await page.evaluate(() => ({
    open: !document.getElementById('selection').hidden,
    title: document.getElementById('selection-title').textContent,
    facts: document.querySelectorAll('#selection-facts > *').length,
  }));
  assert(shown.open, 'the selection panel opened');
  assert(/vega/i.test(shown.title), `it names the star (${shown.title})`);
  assert(shown.facts > 0, `${shown.facts} fields listed`);
  return `${rows.length} results, ${shown.facts} fields for ${shown.title}`;
});

await check('Esc unwinds one layer at a time', async () => {
  await page.evaluate(() => {
    const input = document.getElementById('search-input');
    input.focus();
    input.value = 'ori';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(400);
  assert(!(await hidden('search-results')), 'results are open');
  await page.keyboard.press('Escape');
  await wait();
  assert(await hidden('search-results'), 'Escape closed the results first');
  return 'results, then dialogs';
});

// ---------------------------------------------------------------- appearance

await check('interface scale and opacity apply and persist', async () => {
  await page.evaluate(() => {
    window.cosminova.ui.prefs.set('scale', 1.25);
    window.cosminova.ui.prefs.set('alpha', 0.5);
  });
  await wait(500);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });
  const applied = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      scale: cs.getPropertyValue('--ui-scale').trim(),
      alpha: cs.getPropertyValue('--ui-alpha').trim(),
    };
  });
  assert(applied.scale === '1.25', `scale survived the reload (${applied.scale})`);
  assert(applied.alpha === '0.5', `opacity survived the reload (${applied.alpha})`);
  return `scale ${applied.scale}, alpha ${applied.alpha}`;
});

await check('resetting the interface clears customisation', async () => {
  await page.evaluate(() => window.cosminova.ui.prefs.reset());
  await wait(400);
  const state = await page.evaluate(() => ({
    accent: window.cosminova.ui.prefs.get('accent'),
    scale: window.cosminova.ui.prefs.get('scale'),
  }));
  assert(state.accent === 199 && state.scale === 1, `back to defaults (${JSON.stringify(state)})`);
  return 'reset';
});

// -------------------------------------------------------------------- report

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
