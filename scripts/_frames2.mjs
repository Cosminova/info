import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const [name, fromS, toS, countS, tag] = process.argv.slice(2);
const OUT = '/tmp/refframes';
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
await page.goto(`file://${path.join(process.env.HOME, 'Downloads', name)}`, { waitUntil: 'load', timeout: 60000 });
await page.evaluate(async () => {
  const v = document.querySelector('video');
  if (!v.readyState) await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
});

const from = Number(fromS);
const to = Number(toS);
const count = Number(countS);
for (let i = 0; i < count; i++) {
  const t = from + ((to - from) * i) / Math.max(count - 1, 1);
  const dataUrl = await page.evaluate(async (time) => {
    const v = document.querySelector('video');
    v.pause();
    v.currentTime = time;
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    await new Promise((r) => requestAnimationFrame(r));
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return c.toDataURL('image/jpeg', 0.9);
  }, t);
  const out = path.join(OUT, `${tag}-${String(Math.round(t)).padStart(4, '0')}.jpg`);
  fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`${out}  t=${t.toFixed(1)}s`);
}

await browser.close();
