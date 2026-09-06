/**
 * Checks that the phone and tablet builds are actually lighter, and that the
 * device profile reached the places that cannot be changed later.
 *
 * The failure this is really guarding against is silent. Shader loop bounds and
 * particle counts are interpolated from the profile before the first frame, so
 * a profile that resolved wrong does not look wrong — it either compiles a
 * desktop-sized shader onto a phone, or it interpolates `undefined` into GLSL
 * and every program fails at once. Both are invisible in a build log. So this
 * asserts on what the running app reports about itself, per emulated device.
 *
 * The other half is the memory ceiling. iOS ends a web content process rather
 * than dropping frames, which means there is no signal to react to and no
 * screenshot of the failure. The only defence is never asking for a texture
 * that large, so the asset set is checked against the manifest it ships with.
 *
 * Usage: node scripts/mobile-check.mjs [url]      (serve dist-ios, not dist)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = process.argv[2] ?? process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5181/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'shots', 'mobile');

/**
 * The user agent matters as much as the viewport. platform.js prefers the native
 * shell's own account of the device and only sniffs when there is no shell, and
 * a browser check exercises the sniffing path — which is the one that has to get
 * iPadOS right, since it has claimed to be a Mac for years.
 */
const DEVICES = [
  {
    name: 'iPhone 15 Pro',
    expect: 'phone',
    viewport: { width: 393, height: 852, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  {
    name: 'iPad Pro 11',
    expect: 'tablet',
    viewport: { width: 834, height: 1194, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    // Exactly what iPadOS sends: a desktop Safari string. The touch points are
    // the only thing separating it from a real Mac.
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    touchPoints: 5,
  },
];

/**
 * The desktop row runs against a different URL, because it has to. dist-ios
 * ships only the mobile asset set, so a desktop profile pointed at it asks for
 * a panorama tier that was never built. That is worth knowing but it is not this
 * script's business: set COSMINOVA_DESKTOP_URL to a served dist/ to check that
 * the profile still resolves to desktop and still spends like one.
 */
const DESKTOP = {
  name: 'desktop',
  expect: 'desktop',
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  url: process.env.COSMINOVA_DESKTOP_URL,
};
if (DESKTOP.url) DEVICES.push(DESKTOP);

/** What each class is allowed to spend, mirroring src/engine/platform.js. */
const LIMITS = {
  phone: { maxRenderScale: 0.67, targetFps: 30, demWidth: 512 },
  tablet: { maxRenderScale: 0.85, targetFps: 60, demWidth: 1024 },
  desktop: { maxRenderScale: 1, targetFps: 60, demWidth: 4096 },
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ------------------------------------------------------- the shipped asset set
console.log('\nasset set');
const manifestPath = path.join(ROOT, 'public-mobile', 'textures', 'bodies.json');
if (!fs.existsSync(manifestPath)) {
  check('the mobile asset set has been built', false, 'run npm run build:mobile-assets');
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const widths = [];
  const missing = [];
  for (const [body, kinds] of Object.entries(manifest)) {
    for (const [kind, tiers] of Object.entries(kinds)) {
      for (const [tier, entry] of Object.entries(tiers)) {
        if (entry.width) widths.push({ body, kind, tier, width: entry.width });
        const file = path.join(ROOT, 'public-mobile', 'textures', entry.file);
        if (!fs.existsSync(file)) missing.push(entry.file);
      }
    }
  }
  const widest = widths.sort((a, b) => b.width - a.width)[0];
  // 2048x1024 is 8 MB uploaded. 4096 would be 33 and 8192 would be 134, which
  // is the size that ends the process.
  check(
    'no surface map is wider than 2048',
    widest.width <= 2048,
    `widest is ${widest.body} ${widest.kind} ${widest.tier} at ${widest.width}`,
  );
  check('every manifest entry has its file', missing.length === 0, missing.slice(0, 3).join(', '));

  const size = (dir) => {
    let total = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      }
    };
    walk(dir);
    return total;
  };
  const mobile = size(path.join(ROOT, 'public-mobile'));
  const desktop = size(path.join(ROOT, 'public'));
  const mb = (n) => `${(n / (1 << 20)).toFixed(1)} MB`;
  // Well inside the 200 MB Apple will download over a cellular connection
  // without asking, which is the number that decides whether someone installs
  // this on a train.
  check(
    'the whole asset set fits comfortably under the cellular download limit',
    mobile < 100 * (1 << 20),
    `${mb(mobile)} against ${mb(desktop)} on the desktop`,
  );
}

// ------------------------------------------------------------ the running app
fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
});

for (const device of DEVICES) {
  console.log(`\n${device.name}`);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setUserAgent(device.ua);
  await page.setViewport(device.viewport);
  if (device.touchPoints) {
    // Chrome does not let setViewport fake maxTouchPoints, and it is the whole
    // basis of telling an iPad from a Mac.
    await page.evaluateOnNewDocument((n) => {
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => n });
    }, device.touchPoints);
  }

  await page.goto(device.url ?? URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 120000 });
  // Long enough for the adaptive loop to have taken a decision and for terrain
  // to have streamed a level or two.
  await new Promise((r) => setTimeout(r, 4000));

  const stats = await page.evaluate(() => window.cosminova.stats());
  const limits = LIMITS[device.expect];

  check(
    `resolves as ${device.expect}`,
    stats.deviceClass === device.expect,
    `reported ${stats.deviceClass}`,
  );
  check(
    'holds its resolution ceiling',
    stats.maxRenderScale <= limits.maxRenderScale + 1e-6 && stats.renderScale <= limits.maxRenderScale + 1e-6,
    `render scale ${stats.renderScale} against a ceiling of ${stats.maxRenderScale}`,
  );
  check('targets the right frame rate', stats.targetFps === limits.targetFps, `${stats.targetFps} fps`);
  check(
    'asks for no more elevation than the profile allows',
    stats.demWidth <= limits.demWidth,
    `${stats.target} at ${stats.demWidth}`,
  );

  /*
   * A shader that failed to compile is the specific disaster this file exists
   * for, and three reports it as a console error rather than by throwing, so
   * without this it would pass every other assertion here while drawing
   * nothing. `undefined` appearing in a loop bound lands in the same place.
   */
  const shaderErrors = errors.filter((e) => /shader|WebGLProgram|GLSL|undefined/i.test(e));
  check('every shader compiled', shaderErrors.length === 0, shaderErrors.slice(0, 2).join(' | '));
  // Not triangles or draw calls: those come from renderer.info, which the post
  // chain resets, so what they report is the final full-screen pass rather than
  // the scene. Terrain patches are the thing that only exists if a surface was
  // actually built and refined.
  check(
    'a surface was built and refined',
    stats.patches > 0,
    `${stats.patches} patches on ${stats.target}, ${stats.drawCalls} calls in the last pass`,
  );
  /*
   * Nothing may advertise a key the device has no way of producing.
   *
   * The shortcut registry is what fills the rail's tooltips, the help table and
   * the rebinding list, so a stale F-key default is not one wrong string but the
   * same wrong string in three places, each of them presented as the way in. The
   * desktop row is here for the opposite reason: the substitution is keyed off
   * the resolved platform, and a profile that came out wrong on a Mac would take
   * the function row away from the machine that has one.
   */
  const keys = await page.evaluate(() => {
    const shortcuts = window.cosminova?.ui?.shortcuts;
    return {
      bindings: shortcuts
        ? [...shortcuts.actions.keys()].map((id) => ({ id, binding: shortcuts.binding(id) }))
        : [],
      // What the interface itself says, rather than what the registry holds.
      advertised: [...document.querySelectorAll('[data-tip-key], button.rebind')]
        .map((node) => (node.dataset.tipKey ?? node.textContent ?? '').trim())
        .filter(Boolean),
    };
  });
  const isFunctionKey = (s) => /^F(1[0-2]|[1-9])$/.test(s);
  const fKeys = keys.bindings.filter((b) => isFunctionKey(b.binding));

  if (device.expect === 'desktop') {
    check(
      'keeps the function keys on a machine that has them',
      fKeys.length > 0,
      `${fKeys.length} of ${keys.bindings.length} actions on the function row`,
    );
  } else {
    check(
      'binds nothing to a function row this device does not have',
      keys.bindings.length > 0 && fKeys.length === 0,
      fKeys.length ? fKeys.map((b) => `${b.id}=${b.binding}`).join(', ') : `${keys.bindings.length} actions checked`,
    );
    check(
      'advertises no function key anywhere in the interface',
      !keys.advertised.some(isFunctionKey),
      keys.advertised.filter(isFunctionKey).join(', '),
    );
    // The three that keep a binding, for a keyboard attached to an iPad.
    const wanted = { 'open.search': 'Meta+K', 'open.help': 'Meta+/', 'open.settings': 'Meta+,' };
    const wrong = Object.entries(wanted).filter(
      ([id, binding]) => keys.bindings.find((b) => b.id === id)?.binding !== binding,
    );
    check(
      'search, help and settings keep the chords a keyboard can produce',
      wrong.length === 0,
      wrong.map(([id, binding]) => `${id} wanted ${binding}`).join(', '),
    );
  }

  check('nothing else went wrong', errors.length === 0, errors.slice(0, 2).join(' | '));

  const shot = path.join(OUT, `${device.expect}-boot.png`);
  await page.screenshot({ path: shot });
  console.log(`  shot  ${path.relative(ROOT, shot)}   fps ${stats.fps?.toFixed?.(0) ?? '?'}`);
  await page.close();
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL  ${f.name}  ${f.detail}`);
  process.exit(1);
}
