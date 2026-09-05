/**
 * Turns a video into still frames, so a reference clip can be looked at rather
 * than described.
 *
 * The point of this script is collaboration: the most useful direction this
 * project has had came from screenshots of a reference video, and taking those by
 * hand is tedious.
 *
 * Frames come out of Chrome rather than ffmpeg. That is not a preference — there
 * is no package manager on this machine to install ffmpeg with — but it turns out
 * better anyway, because the same approach works for a YouTube URL without
 * downloading anything. yt-dlp is refused by YouTube here (it needs a newer
 * Python than is available, and the version that runs gets a 403 on every video
 * fragment), whereas Chrome is a real browser with real cookies and simply plays
 * the video.
 *
 * Two paths, depending on the source:
 *   - a URL is opened on the watch page, seeked, and screenshotted. Not the
 *     embedded player, which refuses to load with error 153 unless it is framed
 *     by a page on a real origin. The canvas cannot be used here either, because
 *     a cross-origin video taints it and reading the pixels back throws, so the
 *     frames are clipped screenshots of the video element instead.
 *   - a local file is drawn into a canvas, which is exact and full resolution.
 *
 * Usage:
 *   node scripts/video-frames.mjs <url-or-file> [frameCount] [outputDirectory]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const source = process.argv[2];
const frameCount = Number(process.argv[3] ?? 24);
const outputRoot = resolve(process.argv[4] ?? 'reference');

if (!source) {
  console.error('usage: node scripts/video-frames.mjs <url-or-file> [frameCount] [outDir]');
  process.exit(1);
}

/** The eleven character id in any of YouTube's URL shapes. */
function youtubeId(url) {
  const match = url.match(/(?:shorts\/|watch\?v=|youtu\.be\/|embed\/)([\w-]{11})/);
  return match?.[1] ?? null;
}

const isUrl = /^https?:/.test(source);
const videoId = isUrl ? youtubeId(source) : null;
if (isUrl && !videoId) throw new Error(`not a recognised YouTube URL: ${source}`);
if (!isUrl && !existsSync(resolve(source))) throw new Error(`no such file: ${source}`);

const stem = videoId ?? basename(source).replace(/\.[^.]+$/, '');
const frameDirectory = join(outputRoot, stem);
mkdirSync(frameDirectory, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--headless=new',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ],
  // Tall, because YouTube picks its stream resolution from the size of the
  // player: a short viewport gets a 360 pixel wide video, which is not enough to
  // judge a surface by. Vertical clips need the height in particular.
  defaultViewport: { width: 1100, height: 1500, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));

if (isUrl) {
  await page.goto(`https://www.youtube.com/watch?v=${videoId}`, {
    waitUntil: 'networkidle2',
    timeout: 60000,
  });
} else {
  await page.setContent(`<!doctype html><meta charset="utf-8">
    <body style="margin:0;background:#000">
      <video id="v" src="file://${resolve(source)}" muted preload="auto"
             style="display:block;width:100vw"></video>
    </body>`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for playback to be genuinely underway. An unstarted YouTube player
 * reports a duration of zero and ignores currentTime, so seeking before this
 * point silently does nothing.
 */
async function waitForPlayback() {
  return page.evaluate(
    () =>
      new Promise((resolveMeta, reject) => {
        const video = document.querySelector('video');
        if (!video) return reject(new Error('no video element'));
        video.muted = true;
        const attempt = video.play();
        if (attempt?.catch) attempt.catch(() => {});
        // Ask for a decent stream: the player picks its resolution from the
        // player size and will happily serve 360 pixels wide.
        document.querySelector('#movie_player')?.setPlaybackQualityRange?.('hd1080', 'hd720');
        const check = () => {
          if (video.duration > 0 && video.videoWidth > 0) {
            resolveMeta({
              duration: video.duration,
              width: video.videoWidth,
              height: video.videoHeight,
            });
          } else {
            setTimeout(check, 200);
          }
        };
        check();
        setTimeout(() => reject(new Error('player never reported a duration')), 45000);
      }),
  );
}

async function openSource() {
  if (isUrl) {
    await page.goto(`https://www.youtube.com/watch?v=${videoId}`, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
  }
  await page.waitForSelector('video', { timeout: 60000 });
  return waitForPlayback();
}

let metadata = await openSource();
console.log(
  `${metadata.duration.toFixed(1)}s at ${metadata.width}x${metadata.height}, ${frameCount} frames`,
);

/** Seeks and reports whether there is actually a decoded frame to look at. */
async function seek(time) {
  await page.evaluate(
    (t) =>
      new Promise((resolveSeek) => {
        const video = document.querySelector('video');
        const done = () => resolveSeek();
        video.addEventListener('seeked', done, { once: true });
        video.currentTime = t;
        // Players swallow the event when the seek lands on the current frame.
        setTimeout(done, 3000);
      }),
    time,
  );
  // The seeked event fires before the new frame is necessarily painted.
  await sleep(400);
  return page.evaluate(() => {
    const video = document.querySelector('video');
    return Boolean(video && video.readyState >= 2 && video.videoWidth > 0);
  });
}

for (let i = 0; i < frameCount; i++) {
  // Sampled at the midpoint of each interval, which keeps the first and last
  // frames off the title card and the end screen.
  const t = metadata.duration * ((i + 0.5) / frameCount);

  // Long sessions tend to die partway with a "something went wrong" overlay,
  // which screenshots as a grey card rather than failing loudly. Reloading and
  // seeking again recovers it.
  let ready = await seek(t);
  for (let attempt = 0; !ready && attempt < 2; attempt++) {
    console.log(`  (playback stalled at ${t.toFixed(1)}s, reloading)`);
    if (isUrl) await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    metadata = await openSource();
    ready = await seek(t);
  }
  if (!ready) {
    console.log(`  skipped ${t.toFixed(1)}s`);
    continue;
  }

  const file = join(frameDirectory, `frame-${String(i + 1).padStart(3, '0')}-${t.toFixed(1)}s.png`);
  const element = await page.$('video');
  await element.screenshot({ path: file });
  console.log(`  ${basename(file)}`);
}

await browser.close();
console.log(`\nframes in ${frameDirectory}`);
