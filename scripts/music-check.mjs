/**
 * That the music can be turned off, and stays off.
 *
 * There was already a Music checkbox, in the Display panel, which is what F9
 * opens — and on a Mac F9 is a volume key unless the user has been told
 * otherwise, so the control existed and could not be reached. It now has a key
 * of its own and a menu item in the macOS shell, both going through the same
 * action.
 *
 * Checked against the audio graph rather than the preference: a preference
 * that flips while the music plays on is the failure worth catching, and it is
 * the one a test of the preference alone would miss.
 *
 * Usage: node scripts/music-check.mjs
 */
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new',
    '--no-sandbox',
    '--use-gl=angle',
    // Without this there is no audio device in headless and the context never
    // leaves 'suspended', so nothing about muting would mean anything.
    '--autoplay-policy=no-user-gesture-required',
  ],
  defaultViewport: { width: 1000, height: 640 },
});

async function open() {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('cosminova.prefs', JSON.stringify({ seenIntro: true }));
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
  // The music arms on the first input rather than on load, so nothing is
  // playing to mute until something has been pressed.
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown')));
  await new Promise((r) => setTimeout(r, 900));
  return page;
}

const state = (page) =>
  page.evaluate(() => ({
    muted: window.cosminova.ambient.muted,
    pref: window.cosminova.ui.prefs.get('view.music', true),
    registered: Boolean(window.cosminova.ui.shortcuts.actions.get('toggle.music')),
    key: window.cosminova.ui.shortcuts.binding('toggle.music'),
  }));

const page = await open();
const initial = await state(page);

check(initial.registered, 'music is a registered action, so it is in the help panel', `key ${initial.key}`);
check(initial.key === 'F12', 'and it is on a function key like the rest of the panel keys', initial.key);
check(!initial.muted && initial.pref === true, 'music is on to begin with');

/* Through the registry, which is the path both the key press and the macOS
   menu item take. */
await page.evaluate(() => window.cosminova.ui.shortcuts.run('toggle.music'));
await new Promise((r) => setTimeout(r, 400));
const off = await state(page);
check(off.muted === true, 'running the action mutes the audio graph', `muted ${off.muted}`);
check(off.pref === false, 'and records it as a preference', `pref ${off.pref}`);

/* The checkbox in the Display panel is the other face of the same setting and
   must not be left showing the opposite of what is true. */
const boxAgrees = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('label')];
  const music = labels.find((l) => l.textContent.trim() === 'Music');
  return music ? music.querySelector('input[type=checkbox]')?.checked : null;
});
check(boxAgrees === false, 'and unticks the checkbox that shows it', `checkbox ${boxAgrees}`);

await page.evaluate(() => window.cosminova.ui.shortcuts.run('toggle.music'));
await new Promise((r) => setTimeout(r, 400));
const backOn = await state(page);
check(backOn.muted === false && backOn.pref === true, 'and turns it back on again');

/* Off, then reloaded: silence has to survive, or turning the music off is
   something you do once per visit. */
await page.evaluate(() => window.cosminova.ui.shortcuts.run('toggle.music'));
await new Promise((r) => setTimeout(r, 400));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown')));
await new Promise((r) => setTimeout(r, 900));
const afterReload = await state(page);
check(
  afterReload.muted === true && afterReload.pref === false,
  'and it is still off after a reload',
  `muted ${afterReload.muted}, pref ${afterReload.pref}`,
);

console.log(failures ? `\n${failures} failed` : '\nall passed');
await browser.close();
process.exit(failures ? 1 : 0);
