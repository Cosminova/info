/**
 * Interface check harness.
 *
 * Loads a view in local Chrome at each resolution the interface claims to
 * support, exercises the panels, search, context menu and immersive mode, and
 * reports console errors plus a few facts that are easy to get wrong and hard to
 * see in a screenshot: whether anything overlaps the centre of the view, whether
 * a panel has run off the edge, and what the interface costs per frame.
 *
 * Both views are checked by the same harness, because both are built from the
 * same layout and the rules being tested are the layout's rules. What differs is
 * only which panels exist and how a search is opened, which is what the profiles
 * below describe.
 *
 * Usage: node scripts/ui-check.mjs [explorer|sky] [viewport ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const APPS = {
  explorer: {
    page: '',
    panels: ['navigation', 'camera', 'display', 'inspector', 'system', 'bookmarks'],
    query: 'tit',
    // The explorer's search and context menu are driven through its own API.
    openExtras: async (page) => {
      await page.evaluate(() => {
        window.cosminova.ui.focusSearch();
        const input = document.querySelector('.search-input');
        input.value = 'tit';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await page.evaluate(() => {
        window.cosminova.ui.openObjectMenu(
          Math.round(window.innerWidth * 0.62),
          Math.round(window.innerHeight * 0.55),
          'titan',
        );
      });
    },
  },
  sky: {
    page: 'sky.html',
    panels: ['options', 'readout', 'selection'],
    query: 'vega',
    // The planetarium's search is wired in main.js by element, so it is driven
    // the way a person drives it.
    openExtras: async (page) => {
      await page.evaluate(() => {
        const input = document.getElementById('search-input');
        input.focus();
        input.value = 'vega';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    },
  },
};

const args = process.argv.slice(2);
const appName = args[0] in APPS ? args.shift() : 'explorer';
const app = APPS[appName];
const URL = BASE + app.page;
const OUT = path.resolve('shots/ui', appName);
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '4k': { width: 3840, height: 2160 },
  ultrawide: { width: 3440, height: 1440 },
  small: { width: 1280, height: 720 },
};

const names = args.length ? args : Object.keys(VIEWPORTS);

/** The centre of the screen must stay clear; this is the box we protect. */
const CENTRE_FRACTION = 0.44;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
  ],
});

let failures = 0;

for (const name of names) {
  const viewport = VIEWPORTS[name];
  if (!viewport) {
    console.error(`unknown viewport: ${name}`);
    failures++;
    continue;
  }

  const page = await browser.newPage();
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
/*
 * Start past the first-run welcome card. It is centred over the scene by
 * design, and these checks drive the scene underneath it — a drag begun in the
 * middle of the viewport would land on the card rather than the sky. A real
 * first visit sees it; a regression check is not a first visit.
 */
await page.evaluateOnNewDocument(() => {
  try {
    const KEY = 'skyview.ui.v1';
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    saved.seenIntro = true;
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {
    /* private mode: the card will appear and the centre drags will miss. */
  }
});


  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });
  // Let terrain LOD and the first texture tier settle so the frame cost below is
  // measured against a steady scene rather than a loading one.
  await new Promise((resolve) => setTimeout(resolve, 3500));

  // Open everything at once: the worst case for both layout and cost.
  await page.evaluate((panels) => {
    for (const id of panels) window.cosminova.ui.togglePanel(id, true);
  }, app.panels);
  await new Promise((resolve) => setTimeout(resolve, 700));

  const report = await page.evaluate((centreFraction) => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const centre = {
      left: w * (0.5 - centreFraction / 2),
      right: w * (0.5 + centreFraction / 2),
      top: h * (0.5 - centreFraction / 2),
      bottom: h * (0.5 + centreFraction / 2),
    };

    const scrollableAncestor = (node) => {
      for (let p = node.parentElement; p; p = p.parentElement) {
        const style = getComputedStyle(p);
        const scrolls = /auto|scroll/.test(`${style.overflowY}${style.overflowX}`);
        if (scrolls && (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)) return p;
      }
      return null;
    };

    const intruders = [];
    const offscreen = [];
    // Only elements that actually paint something are candidates; the region
    // wrappers span the window by design and take no pointer events.
    const candidates = document.querySelectorAll(
      '.panel, .hud, .timebar, .zoombar, .search-results, .dialog, .menu, .obj-label',
    );
    for (const node of candidates) {
      if (node.hidden || !node.offsetParent) continue;
      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const describe = `${node.className.split(' ')[0]}${node.dataset.panel ? `[${node.dataset.panel}]` : ''}`;
      // Labels are exempt from the centre rule: they name the object they sit
      // beside, and the object you are looking at is in the middle of the screen
      // by definition. They are still held to the off-screen rule below.
      const isLabel = node.classList.contains('obj-label');
      if (!isLabel && r.right > centre.left && r.left < centre.right && r.bottom > centre.top && r.top < centre.bottom) {
        intruders.push(`${describe} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      // Something that extends past the window is only a problem if it cannot be
      // reached. A panel below the fold of a scrollable dock is fine — that is
      // what the dock is for — so the test is for content that is both outside
      // the window and has nothing that scrolls to bring it back.
      const outside = r.left < -1 || r.top < -1 || r.right > w + 1 || r.bottom > h + 1;
      if (outside && !scrollableAncestor(node)) {
        offscreen.push(`${describe} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.right)},${Math.round(r.bottom)}`);
      }
    }

    const painted = [...candidates].filter((n) => !n.hidden && n.offsetParent).length;
    return { w, h, intruders, offscreen, painted };
  }, CENTRE_FRACTION);

  // Frame cost: the same scene with the interface on and then hidden. Immersive
  // mode stops the interface updating entirely, so the difference is what the
  // chrome costs.
  const measure = () => page.evaluate(async () => {
    let frames = 0;
    const start = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        frames++;
        if (performance.now() - start > 3000) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return (frames / (performance.now() - start)) * 1000;
  });

  // Alternated and repeated rather than measured once each way. On a software
  // renderer the scene itself varies by more than the interface costs, so a
  // single before/after pair reports noise — including negative costs.
  const withUi = [];
  const without = [];
  await measure();
  for (let i = 0; i < 3; i++) {
    withUi.push(await measure());
    await page.evaluate(() => window.cosminova.setUiVisible(false));
    await new Promise((resolve) => setTimeout(resolve, 400));
    without.push(await measure());
    await page.evaluate(() => window.cosminova.setUiVisible(true));
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const median = (values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const fpsWithUi = median(withUi);
  const fpsWithout = median(without);

  await page.screenshot({ path: path.join(OUT, `${name}.png`) });

  // A second shot with the search list and a context menu open, since those are
  // the two things that can overhang and are not visible in the resting layout.
  await app.openExtras(page);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.screenshot({ path: path.join(OUT, `${name}-open.png`) });

  const overhang = await page.evaluate(() => {
    const out = [];
    for (const node of document.querySelectorAll('.search-results, .menu')) {
      if (node.hidden) continue;
      const r = node.getBoundingClientRect();
      if (r.left < -1 || r.top < -1 || r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1) {
        out.push(`${node.className.split(' ')[0]} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.right)},${Math.round(r.bottom)}`);
      }
    }
    return out;
  });

  const cost = fpsWithout > 0 ? (1 - fpsWithUi / fpsWithout) * 100 : 0;
  // Below roughly ten frames a second the scene is dominating so heavily that a
  // percentage of it says nothing about the interface.
  const costNote = fpsWithout < 10 ? ' (scene-bound; not meaningful)' : '';
  const bad = errors.length || report.intruders.length || report.offscreen.length || overhang.length;
  if (bad) failures++;

  console.log(`\n${appName} ${name}  ${report.w}x${report.h}  ${report.painted} elements`);
  console.log(`  fps ${fpsWithUi.toFixed(1)} with ui, ${fpsWithout.toFixed(1)} without \u2014 ${cost.toFixed(1)}% frame cost${costNote}`);
  if (report.intruders.length) console.log(`  CENTRE BLOCKED: ${report.intruders.join('; ')}`);
  if (report.offscreen.length) console.log(`  OFF-SCREEN: ${report.offscreen.join('; ')}`);
  if (overhang.length) console.log(`  OVERHANGING: ${overhang.join('; ')}`);
  for (const error of errors.slice(0, 8)) console.log(`  ERROR ${error}`);
  if (!bad) console.log('  ok');

  await page.close();
}

await browser.close();
console.log(failures ? `\n${failures} viewport(s) with problems` : '\nall viewports clean');
process.exit(failures ? 1 : 0);
