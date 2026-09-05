import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const DOWNLOADS = path.join(process.env.HOME, 'Downloads');
const OUT = '/tmp/refframes';
fs.mkdirSync(OUT, { recursive: true });

const files = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: [
    '--headless=new',
    '--no-sandbox',
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
  ],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('ERR', e.message));

for (const name of files) {
  const file = path.join(DOWNLOADS, name);
  if (!fs.existsSync(file)) { console.log(`missing ${name}`); continue; }
  await page.goto(`file://${file}`, { waitUntil: 'load', timeout: 60000 });

  const meta = await page.evaluate(async () => {
    const v = document.querySelector('video');
    if (!v) return null;
    if (!v.readyState) await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
    return { duration: v.duration, w: v.videoWidth, h: v.videoHeight };
  });
  if (!meta) { console.log(`${name}: no video element`); continue; }

  const slug = name.replace(/[^a-z0-9]+/gi, '-').replace(/-mp4$/, '');
  const count = 8;
  console.log(`${name}: ${meta.duration.toFixed(1)}s ${meta.w}x${meta.h}`);

  for (let i = 0; i < count; i++) {
    const t = (meta.duration * (i + 0.5)) / count;
    const dataUrl = await page.evaluate(async (time) => {
      const v = document.querySelector('video');
      v.pause();
      v.currentTime = time;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      await new Promise((r) => requestAnimationFrame(r));
      const c = document.createElement('canvas');
      const scale = Math.min(1, 1100 / v.videoWidth);
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.82);
    }, t);
    const out = path.join(OUT, `${slug}-${String(i).padStart(2, '0')}.jpg`);
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
}

await browser.close();
console.log(`frames in ${OUT}`);
