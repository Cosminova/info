/**
 * Throwaway. What the landing page costs, split by when it is paid for.
 *
 * The hero became an eight-image slideshow, and eight of those at 1600x900 is
 * around 600 KB. The whole point of the data-src arrangement in index.html is
 * that seven of them are not on the critical path — this checks that claim
 * rather than assuming it, by measuring what has been transferred at first
 * paint and then what the rotation and a full scroll add on top.
 *
 * Usage: node scripts/_site-weight.mjs
 */
import puppeteer from 'puppeteer-core';

const URL = process.env.SITE_URL ?? 'http://127.0.0.1:4700/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();

const seen = [];
page.on('response', async (res) => {
  const url = res.url();
  if (!url.startsWith(URL)) return;
  let size = 0;
  try {
    size = (await res.buffer()).length;
  } catch {
    /* redirects and aborted requests have no body */
  }
  seen.push({ path: url.slice(URL.length) || '/', size, at: Date.now() });
});

const started = Date.now();
await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
const atLoad = seen.length;
const loadBytes = seen.reduce((n, r) => n + r.size, 0);

/** Sums and prints a slice of the request log. */
function report(label, slice) {
  const bytes = slice.reduce((n, r) => n + r.size, 0);
  console.log(`\n${label}: ${slice.length} requests, ${(bytes / 1024).toFixed(0)} KB`);
  for (const r of [...slice].sort((a, b) => b.size - a.size).slice(0, 8)) {
    console.log(`  ${(r.size / 1024).toFixed(0).padStart(5)} KB  ${r.path}`);
  }
  return bytes;
}

report('at load', seen.slice(0, atLoad));

// Long enough for the rotation to pull in the next slide or two.
await new Promise((r) => setTimeout(r, 9000));
const afterIdle = seen.length;
report('added by the rotation', seen.slice(atLoad, afterIdle));

// Everything the page will ever ask for, including lazy images far down.
await page.evaluate(async () => {
  const step = innerHeight * 0.7;
  for (let y = 0; y < document.body.scrollHeight; y += step) {
    scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 220));
  }
});
await new Promise((r) => setTimeout(r, 2500));
report('added by scrolling to the end', seen.slice(afterIdle));

const total = seen.reduce((n, r) => n + r.size, 0);
console.log(
  `\nfirst paint ${(loadBytes / 1024).toFixed(0)} KB` +
    `   whole page read to the end ${(total / 1024 / 1024).toFixed(2)} MB` +
    `   (${((Date.now() - started) / 1000).toFixed(0)}s)`,
);

await browser.close();
