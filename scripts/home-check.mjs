/**
 * The start screen: the hosts that get it, the one that must not, and the
 * handover from photograph to live scene.
 *
 * A cover over the whole viewport is a dangerous thing to add to this app,
 * because almost everything in scripts/ works by loading the explorer in
 * headless Chrome, waiting for `window.cosminova.ready` and then photographing
 * or clicking the scene. Anything left in front of that turns the store
 * screenshots, the site stills and every interaction check into a picture of a
 * start screen — and it would do it quietly, since all of those scripts would
 * still pass their own assertions about a page that had loaded fine.
 *
 * So the last case here is the important one: the others are the feature, and
 * that one is the reason the feature is allowed to exist.
 *
 * The screen also goes live — it dissolves from its still into the scene it was
 * rendered from and turns slowly around it. That brings two things worth
 * holding: the turn has to actually happen and has to stop when the visitor
 * goes in, and the app's own interface has to stay out of the way while the
 * screen is up and come back with it. Getting the second wrong is not subtle
 * (it puts the rail, the panels and every label in the frame behind the title)
 * but it is invisible to every other check, since they all run without the
 * screen.
 *
 * Usage: node scripts/home-check.mjs [url]      (serve dist/)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = process.argv[2] ?? process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'shots', 'home');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
});

/**
 * `hosted` is what makes a visitor: every script here is automated, and the
 * start screen hides from automation on purpose, so to see what a person sees
 * the one signal separating them has to be put back.
 */
async function load({ viewport, ua, shell = null, hosted = false, touchPoints = 0, home = null }) {
  const page = await browser.newPage();
  const errors = [];
  const fetched = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('request', (r) => {
    if (/\/home\/[^/]+\.jpg/.test(r.url())) fetched.push(r.url().split('/').pop());
  });
  if (ua) await page.setUserAgent(ua);
  await page.setViewport(viewport);
  if (hosted) {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
  }
  if (touchPoints) {
    // setViewport cannot fake maxTouchPoints, and on iPadOS it is the whole
    // basis of the guess: the user agent has claimed to be a Mac for years.
    await page.evaluateOnNewDocument((n) => {
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => n });
    }, touchPoints);
  }
  if (shell) {
    await page.evaluateOnNewDocument((s) => {
      window.cosminovaShell = s;
    }, shell);
  }
  const target = home ? `${URL}${URL.includes('?') ? '&' : '?'}home=${home}` : URL;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
  return { page, errors, fetched };
}

const state = (page) =>
  page.evaluate(() => {
    const root = document.getElementById('home');
    const backdrop = document.getElementById('home-backdrop');
    const button = document.getElementById('home-start');
    const box = root?.getBoundingClientRect();
    return {
      present: Boolean(root),
      covers: box ? box.width >= window.innerWidth && box.height >= window.innerHeight : false,
      ready: Boolean(root?.classList.contains('is-ready')),
      // Handed over to the scene: the still is on its way out and the view
      // behind it is being turned.
      live: Boolean(root?.classList.contains('is-live')),
      stillOpacity: backdrop ? Number(getComputedStyle(backdrop).opacity) : null,
      // Immersive mode, which is how the screen keeps the app's interface out of
      // its own picture.
      bare: document.body.classList.contains('immersive'),
      yaw: window.cosminova?.controls?.yaw ?? null,
      backdropLoaded: Boolean(backdrop?.classList.contains('is-loaded')),
      backdropImage: backdrop ? getComputedStyle(backdrop).backgroundImage.slice(0, 60) : '',
      label: button?.textContent.trim() ?? '',
      disabled: button?.disabled ?? null,
      // Built hidden at startup and revealed later, so presence in the DOM says
      // nothing about whether anyone is being shown it.
      intro: (() => {
        const card = document.querySelector('.intro');
        return Boolean(card) && !card.hidden;
      })(),
    };
  });

// ------------------------------------------------- a visitor, on a desktop
console.log('\na visitor in a browser');
{
  const { page, errors, fetched } = await load({
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    hosted: true,
  });

  // Before the app is ready: the screen is up and says what it is waiting for.
  await page.waitForSelector('#home', { timeout: 30000 });
  const waiting = await state(page);
  check('the start screen is up before the app has loaded', waiting.present && waiting.covers);
  check(
    'it does not offer to start while there is nowhere to go',
    waiting.disabled === true && !waiting.ready,
    `button reads "${waiting.label}"`,
  );

  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
  await page.waitForFunction("document.getElementById('home')?.classList.contains('is-ready')", {
    timeout: 30000,
  });
  const armed = await state(page);
  check('a backdrop decoded and faded in', armed.backdropLoaded, armed.backdropImage);
  check(
    'exactly one of the three backdrops was fetched',
    fetched.length === 1,
    fetched.join(', ') || 'none',
  );
  check('it invites a click on a machine with a pointer', armed.label === 'Click to start', armed.label);
  check('the welcome card is not raised behind it', !armed.intro);
  await page.screenshot({ path: path.join(OUT, 'desktop.png') });

  // The gesture.
  await page.click('#home');
  await new Promise((r) => setTimeout(r, 1400));
  const after = await state(page);
  check('clicking takes the screen away', !after.present);
  check('and the first visit gets its welcome card then, not before', after.intro);
  check('the interface is left where the app expects it', !after.bare);
  check('nothing went wrong', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.screenshot({ path: path.join(OUT, 'desktop-after.png') });
  await page.close();
}

// --------------------------------------------------------- a visitor, on a phone
console.log('\na visitor on a phone');
{
  const { page, errors } = await load({
    viewport: { width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    hosted: true,
  });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
  await page.waitForFunction("document.getElementById('home')?.classList.contains('is-ready')", {
    timeout: 30000,
  });
  const armed = await state(page);
  check('the screen fits a phone and covers it', armed.present && armed.covers);
  check('it asks for a tap rather than a click', armed.label === 'Tap to start', armed.label);
  await page.screenshot({ path: path.join(OUT, 'phone.png') });

  await page.tap('#home');
  await new Promise((r) => setTimeout(r, 1400));
  check('tapping takes it away', !(await state(page)).present);
  check('nothing went wrong', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// --------------------------------------------------------- a visitor, on an iPad
/*
 * Safari on an iPad, which is a different host from the iPad app and has to
 * answer differently: this one did not launch from an icon, it was opened at a
 * URL, so it gets the same front door as any other browser. The user agent says
 * Macintosh — iPadOS has sent that for years — so the touch points are what
 * stop this being taken for a desktop.
 */
console.log('\na visitor on an iPad, in Safari');
{
  const { page, errors } = await load({
    viewport: { width: 834, height: 1194, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    touchPoints: 5,
    hosted: true,
  });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
  await page.waitForFunction("document.getElementById('home')?.classList.contains('is-ready')", {
    timeout: 30000,
  });
  const armed = await state(page);
  check('the web version on an iPad gets the screen too', armed.present && armed.covers);
  check('and is asked for a tap, not a click', armed.label === 'Tap to start', armed.label);
  check('a backdrop decoded at tablet size', armed.backdropLoaded, armed.backdropImage);
  await page.screenshot({ path: path.join(OUT, 'ipad.png') });

  await page.tap('#home');
  await new Promise((r) => setTimeout(r, 1400));
  check('tapping takes it away', !(await state(page)).present);
  check('nothing went wrong', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// ------------------------------------------------------------------ the iOS app
/*
 * The native apps used to be the exception: an app launched from an icon has
 * been started once already, and a second door is a door in the middle of a
 * room. True, and still the wrong trade — the screen is how this app introduces
 * itself, and an iPhone version that opened differently from the web version
 * left two front doors to keep in step. So the iOS shell now gets what Safari
 * gets, and this case exists to keep them the same.
 */
console.log('\ninside the iOS app');
{
  const { page, errors, fetched } = await load({
    viewport: { width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    shell: { shell: 'ios', deviceClass: 'phone' },
    hosted: true,
  });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
  await page.waitForFunction("document.getElementById('home')?.classList.contains('is-ready')", {
    timeout: 30000,
  });
  const inside = await state(page);
  check('the app that launched from an icon gets the screen too', inside.present && inside.covers);
  check('and asks for a tap', inside.label === 'Tap to start', inside.label);
  // The still has to be in the bundle: an app that opens on a gradient because
  // its front door was left in public/ is the failure this catches.
  check('its still came out of the app bundle', inside.backdropLoaded, fetched.join(', ') || 'none');
  await page.screenshot({ path: path.join(OUT, 'ios.png') });

  await page.tap('#home');
  await new Promise((r) => setTimeout(r, 1400));
  check('tapping takes it away', !(await state(page)).present);
  check('nothing went wrong', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// ------------------------------------------------------ the still goes live
/*
 * Driven by name rather than left to the visit's own choice: which subject comes
 * up is a coin toss, and the three do not take the same time to arrive — a black
 * hole needs no imagery, a planet needs a surface mosaic. Each is asked for
 * directly so all three are actually covered.
 */
console.log('\nthe photograph gives way to the scene');
for (const subject of ['m87', 'saturn', 'earth-ground']) {
  const { page, errors } = await load({
    viewport: { width: 1200, height: 760, deviceScaleFactor: 1 },
    hosted: true,
    home: subject,
  });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });

  let handed = true;
  try {
    await page.waitForFunction("document.getElementById('home')?.classList.contains('is-live')", {
      timeout: 60000,
    });
  } catch {
    handed = false;
  }
  const first = await state(page);
  check(`${subject}: the screen hands over to the live scene`, handed && first.live);
  check(`${subject}: and takes the interface out of its own picture`, first.bare);

  // Long enough that the drift is unmistakable rather than a rounding error:
  // a fortieth of a radian a second, so three seconds is most of a degree.
  await new Promise((r) => setTimeout(r, 3000));
  const later = await state(page);
  const turned = later.yaw - first.yaw;
  check(`${subject}: the view is turning`, turned > 0.02, `${turned.toFixed(3)} rad in 3 s`);
  check(
    `${subject}: and the still has faded off it`,
    later.stillOpacity !== null && later.stillOpacity < 0.05,
    `opacity ${later.stillOpacity}`,
  );
  await page.screenshot({ path: path.join(OUT, `live-${subject}.png`) });

  await page.click('#home');
  await new Promise((r) => setTimeout(r, 1200));
  const held = await state(page);
  check(`${subject}: going in gives the interface back`, !held.present && !held.bare);
  // The turn is the screen's, not the app's: left running, the camera would go
  // on walking round the body under the visitor's hands.
  await new Promise((r) => setTimeout(r, 1500));
  const settled = await page.evaluate(() => window.cosminova.controls.yaw);
  check(
    `${subject}: and stops the turn on the way`,
    Math.abs(settled - held.yaw) < 0.005,
    `${(settled - held.yaw).toFixed(4)} rad after`,
  );
  check('nothing went wrong', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// ------------------------------------------------------------- a capture script
console.log('\na capture script, which is every other file in scripts/');
{
  // Deliberately not `hosted`: this is exactly how site-stills, store-shots,
  // ui-check and the rest arrive, and none of them know this screen exists.
  const { page, errors, fetched } = await load({
    viewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
  });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
  const seen = await state(page);
  check('automation is handed the scene, not a start screen', !seen.present);
  check('and is not made to download a backdrop for it', fetched.length === 0, fetched.join(', '));
  check('nothing went wrong', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`shots in ${path.relative(ROOT, OUT)}`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL  ${f.name}  ${f.detail}`);
  process.exit(1);
}
