/**
 * Render a shot to a finished, uploadable video.
 *
 * Screen recording a flight gives you whatever the machine managed that day:
 * dropped frames, terrain popping in late, the quality governor dipping detail
 * when the fan spins up. None of that is fixable afterwards. So nothing here is
 * recorded — the camera is placed frame by frame, and each frame is held until
 * the terrain has finished streaming before it is captured. A frame takes as
 * long as it takes, real time means nothing, and the result is identical on any
 * machine and re-renderable at any resolution.
 *
 * The score comes from the app's own synthesiser through an OfflineAudioContext,
 * the same way scripts/audition.mjs renders it. That matters for a channel: it
 * is generated, so there is no third-party recording to be claimed, muted or
 * demonetised on upload.
 *
 * Captions are drawn into the page rather than burned in by ffmpeg, so they use
 * the app's own typeface and need no filter support in the encoder. A matching
 * .srt is written alongside for the upload's caption track.
 *
 * Usage: node scripts/render-video.mjs [shot]
 *        node scripts/render-video.mjs moon --preview
 *        node scripts/render-video.mjs moon --landscape
 *        node scripts/render-video.mjs moon --fps 60 --width 2160 --height 3840
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import puppeteer from 'puppeteer-core';

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5179/';
const CHROME = process.env.CHROME_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

const PREVIEW = flag('preview');
const LANDSCAPE = flag('landscape');
const KEEP = flag('keep-frames');
const FPS = Number(option('fps', PREVIEW ? 12 : 30));
const WIDTH = Number(option('width', LANDSCAPE ? 1920 : 1080)) / (PREVIEW ? 2 : 1);
const HEIGHT = Number(option('height', LANDSCAPE ? 1080 : 1920)) / (PREVIEW ? 2 : 1);
// No mark on the picture by default. A caption says something; a logo sitting
// over the frame for the whole runtime only asks for something.
const BRAND = option('brand', '');
const SITE = option('url', '');
const SHOT_NAME = args[0] ?? 'moon';

const OUT_DIR = path.resolve('video');
const FRAME_DIR = path.join(OUT_DIR, `${SHOT_NAME}-frames`);

// ---------------------------------------------------------------------------
// Easing and interpolation
// ---------------------------------------------------------------------------

/**
 * Easing that does not stop in the middle of the shot.
 *
 * Easing each beat in and out independently brings the camera to a dead halt at
 * every boundary, which in a shot whose whole claim is that it never cuts reads
 * as five stalls. So only the two ends of the whole move are eased, and the
 * joins in between are left alone: `depart` leaves from rest and arrives at
 * unit rate, `arrive` leaves at unit rate and comes to rest, and everything
 * between them runs on a linear clock.
 *
 * A linear clock is the right one because distances and fields of view travel
 * geometrically — constant ratio per second, which is what reads as a smooth
 * continuous zoom rather than something accelerating away.
 */
const depart = (t) => 2 * t * t - t * t * t;
const arrive = (t) => t + t * t - t * t * t;
const linear = (t) => t;
const lerp = (a, b, t) => a + (b - a) * t;
/** Distances and fields of view are ratios, so they travel geometrically. */
const glide = (a, b, t) => a * Math.pow(b / a, t);
/** Turn the short way round, so a sweep never takes the long way to get there. */
const wrapTo = (from, to) => {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return from + d;
};

// ---------------------------------------------------------------------------
// The shot
// ---------------------------------------------------------------------------

const MOON_RADIUS_KM = 1737.4;

/**
 * Earth's surface to the floor of a lunar crater, in one continuous move.
 *
 * The join in the middle is the interesting part. Magnifying from the ground and
 * flying there are different things, and cutting between them wastes the only
 * claim this engine has that a video editor cannot fake — that it is all one
 * scene at true scale. So instead the field of view opens back up over a second
 * and a half while the distance closes by exactly the same ratio: the Moon
 * holds its size on screen while the perspective changes underneath it, and a
 * flat magnified disc becomes a sphere you are approaching without a cut.
 */
const SHOTS = {
  moon: {
    // A waning crescent, about a third lit, on a dark sky. Measured from the
    // ground rather than from orbit, which is the only place the phase means
    // anything — and picked away from new moon, where the Moon rides close
    // enough to the Sun that the sky is brighter than the disc.
    date: '2026-09-07T06:00:00.000Z',
    beats: [
      {
        name: 'reveal',
        seconds: 3.5,
        ease: depart,
        caption: 'This is the Moon, from Earth.',
        // Opening on the wide naked-eye sky was three seconds of black with a
        // speck in it — true to what you see standing outside, and fatal in a
        // format where the first frame decides whether anyone sees the second.
        // So it opens already magnified, on a disc with its maria visible.
        async setup(page) {
          await page.evaluate(() => {
            window.cosminova.target('moon', 3.2);
            window.cosminova.viewFromEarth(true);
          });
        },
        frame: (t) => ({ fov: glide(2.0, 1.45, t), lookPitch: 0 }),
      },
      {
        name: 'magnify',
        seconds: 4.5,
        ease: linear,
        caption: 'No cuts. No CGI. Real data.',
        // Down to where the disc nearly fills the frame. Past this, magnifying
        // stops paying: the field is already narrower than the Moon.
        frame: (t) => ({ fov: glide(1.45, 0.74, t), lookPitch: 0 }),
      },
      {
        name: 'handover',
        seconds: 3,
        ease: linear,
        caption: '384,400 km — crossed for real.',
        async setup(page, ctx) {
          // Leave the ground holding the same look direction, so the phase and
          // the terminator carry across the join untouched.
          ctx.base = await page.evaluate((radius) => {
            const sv = window.cosminova;
            sv.viewFromEarth(false);
            const c = sv.controls;
            c.stopFlight();
            return { yaw: c.yaw, pitch: c.pitch, distanceRadii: c.distanceRadii, radius };
          }, MOON_RADIUS_KM);
        },
        frame: (t, ctx) => ({
          // Both move by the same ratio, which is what holds the apparent size.
          fov: glide(0.74, 40, t),
          distanceRadii: glide(ctx.base.distanceRadii, 4.1, t),
          yaw: ctx.base.yaw,
          pitch: ctx.base.pitch,
        }),
      },
      {
        name: 'orbit',
        seconds: 7,
        ease: linear,
        caption: 'Real elevation, measured from orbit.',
        /**
         * Swing round onto the lit side while closing in.
         *
         * A crescent seen from Earth is a crescent all the way there, so
         * arriving and staying put would put the camera over four fifths
         * darkness and land the descent in the dark. Rather than guess a
         * direction, the app is asked where a fifty-degree phase angle is for
         * this date and the sweep ends there: a strong terminator and long
         * shadows, whatever the phase happened to be at the start.
         */
        async setup(page, ctx) {
          // Two directions, not one: where a fifty-degree phase is, to arrive
          // on, and a slightly more raking one to descend towards, because low
          // sun is what puts shadows in a crater and shadows are the only
          // reason the relief reads at all.
          //
          // Both are asked for rather than reached by drifting a hand-picked
          // yaw, which turns the camera whichever way the arithmetic happens to
          // point — on this date, into the terminator, so the shot got murkier
          // every second and ended on a frame you cannot see. The opposite
          // mistake is just as easy: aiming at thirty-two degrees put the sun
          // overhead and washed the last five seconds out flat.
          const sample = (phase) => page.evaluate((p) => {
            const sv = window.cosminova;
            sv.lookFromSun('moon', 4.1, p, 14);
            return { yaw: sv.controls.yaw, pitch: sv.controls.pitch };
          }, phase);
          ctx.lit = await sample(50);
          ctx.litClose = await sample(56);
          ctx.lit.yaw = wrapTo(ctx.base.yaw, ctx.lit.yaw);
          ctx.litClose.yaw = wrapTo(ctx.lit.yaw, ctx.litClose.yaw);
        },
        frame: (t, ctx) => ({
          fov: 40,
          distanceRadii: glide(4.1, 2.05, t),
          yaw: lerp(ctx.base.yaw, ctx.lit.yaw, t),
          pitch: lerp(ctx.base.pitch, ctx.lit.pitch, t),
        }),
      },
      {
        name: 'descend',
        seconds: 8,
        ease: arrive,
        caption: 'All the way down to the ground.',
        frame: (t, ctx) => ({
          fov: lerp(40, 55, t),
          // 2.05 radii out to about three kilometres up.
          distanceRadii: glide(2.05, 1.0018, t),
          yaw: lerp(ctx.lit.yaw, ctx.litClose.yaw, t),
          pitch: lerp(ctx.lit.pitch, ctx.litClose.pitch, t),
        }),
      },
    ],
  },
};

/**
 * Sunsets, on six worlds and around three stars.
 *
 * Every frame is the sky the scattering equations give for that world's air and
 * that star's colour, seen from a camera standing at a stated height with the
 * sun at a stated angle above the horizon. Nothing is graded to look alien: the
 * red skies are red because the star is 2500 K, and Mars's blue sunset is blue
 * because that is what happens when the air is thin enough that the forward
 * lobe beats the sideways one.
 */
SHOTS.alien = {
  date: '2026-06-21T17:00:00.000Z',
  beats: [
    {
      name: 'earth-day',
      seconds: 5,
      ease: depart,
      caption: 'Sunset is just air in the way.',
      async setup(page) {
        // Stood on the spot first, so the terrain and textures stream in for
        // where the camera will actually be rather than for wherever the app
        // happened to be pointing.
        await page.evaluate(() => {
          window.cosminova.standAt('earth', { sunElevationDeg: 12, altitudeKm: 2.5, viewElevationDeg: 9 });
        });
        await page.evaluate(() => window.cosminova.loadDetail('earth'));
      },
      frame: (t) => ({
        stand: {
          body: 'earth',
          sunElevationDeg: lerp(12, 3, t),
          altitudeKm: 2.5,
          viewElevationDeg: 9,
          fov: 62,
        },
      }),
    },
    {
      name: 'earth-set',
      seconds: 5,
      ease: linear,
      caption: 'Blue light scatters away first. Red is what gets through.',
      frame: (t) => ({
        stand: {
          body: 'earth',
          sunElevationDeg: lerp(3, -1.5, t),
          altitudeKm: 2.5,
          viewElevationDeg: 9,
          fov: 62,
        },
      }),
    },
    {
      name: 'earth-dusk',
      seconds: 3.5,
      ease: linear,
      caption: 'Then the planet\u2019s own shadow climbs the sky.',
      // Stopping at three degrees below rather than six: past that the band is
      // all there is to see and the frame is otherwise black.
      frame: (t) => ({
        stand: {
          body: 'earth',
          sunElevationDeg: lerp(-1.5, -3.2, t),
          altitudeKm: 2.5,
          viewElevationDeg: 5,
          fov: 55,
        },
      }),
    },
    {
      name: 'mars',
      seconds: 6,
      ease: linear,
      caption: 'Mars. Same star — and the sunset comes out blue.',
      async setup(page) {
        await page.evaluate(() => {
          window.cosminova.standAt('mars', { sunElevationDeg: 5, altitudeKm: 4, viewElevationDeg: 8 });
        });
        await page.evaluate(() => window.cosminova.loadDetail('mars'));
      },
      frame: (t) => ({
        stand: {
          body: 'mars',
          sunElevationDeg: lerp(5, -1, t),
          altitudeKm: 4,
          viewElevationDeg: 8,
          fov: 62,
        },
      }),
    },
    {
      name: 'trappist',
      seconds: 7,
      ease: linear,
      caption: 'TRAPPIST-1 e. Its sun is a red dwarf, four times wider than ours.',
      async setup(page, ctx) {
        // The system is fetched and built on demand, so it has to be asked for
        // and waited on before there is a surface to stand on.
        await page.evaluate(() => window.cosminova.target('exo:trappist-1-e'));
        await page.waitForFunction(
          () => Boolean(window.cosminova.standAt('exo:trappist-1-e', { sunElevationDeg: 6, altitudeKm: 10 })),
          { timeout: 90000 },
        );
        await page.evaluate(() => window.cosminova.loadDetail('trappist-1-e'));
      },
      frame: (t) => ({
        stand: {
          body: 'exo:trappist-1-e',
          sunElevationDeg: lerp(6, -0.5, t),
          altitudeKm: 10,
          viewElevationDeg: 10,
          fov: 62,
        },
      }),
    },
    {
      name: 'proxima',
      seconds: 5.5,
      ease: linear,
      caption: 'Proxima b, four light years out. The closest sunset to home.',
      async setup(page, ctx) {
        await page.evaluate(() => window.cosminova.target('exo:proxima-cen-b'));
        await page.waitForFunction(
          () => Boolean(window.cosminova.standAt('exo:proxima-cen-b', { sunElevationDeg: 4, altitudeKm: 10 })),
          { timeout: 90000 },
        );
        await page.evaluate(() => window.cosminova.loadDetail('proxima-cen-b'));
      },
      frame: (t) => ({
        stand: {
          body: 'exo:proxima-cen-b',
          sunElevationDeg: lerp(4, -0.5, t),
          altitudeKm: 10,
          viewElevationDeg: 10,
          fov: 62,
        },
      }),
    },
    // Two frames of the same composition, because that is what makes the
    // comparison legible. Held at one absolute distance instead, the honest
    // frame is a supergiant filling the screen next to a sun two pixels across:
    // true, and unreadable. So the apparent size is what is held fixed, and the
    // distance it took to get there is the number that carries the scale.
    {
      name: 'sun-scale',
      seconds: 4,
      ease: linear,
      caption: 'This is our sun, from eight times its own radius.',
      async setup(page) {
        await page.evaluate(() => {
          const sv = window.cosminova;
          sv.target('sun', 8);
          sv.controls.stopFlight();
          sv.controls.distanceRadii = 8;
        });
      },
      frame: () => ({ distanceRadii: 8, fov: 34 }),
    },
    {
      name: 'betelgeuse',
      seconds: 6,
      ease: linear,
      caption: 'Betelgeuse, the same size on screen \u2014 from 700 times as far.',
      async setup(page) {
        await page.evaluate(() => {
          const sv = window.cosminova;
          sv.target('star:Betelgeuse', 8);
          sv.controls.stopFlight();
          sv.controls.distanceRadii = 8;
        });
      },
      frame: (t) => ({ distanceRadii: glide(8, 6.4, t), fov: 34 }),
    },
    {
      name: 'betelgeuse-orbit',
      seconds: 4,
      ease: linear,
      // Its radius comes out at 712 solar radii here, which is 3.3 AU: past
      // Mars at 1.52, and most of the way to the asteroid belt.
      caption: 'Put it where the sun is, and Mars would orbit inside it.',
      frame: (t) => ({ distanceRadii: glide(6.4, 5.2, t), fov: 34 }),
    },
    {
      name: 'hole-far',
      seconds: 5,
      ease: linear,
      caption: 'Sagittarius A*. Four million suns, in a point.',
      async setup(page) {
        await page.evaluate(() => {
          const sv = window.cosminova;
          sv.setView('blackHoles', true);
          sv.lookAtBlackHole('sgr-a', 260);
        });
      },
      frame: (t) => ({
        distanceRadii: glide(260, 110, t),
        fov: 38,
      }),
    },
    {
      name: 'hole-near',
      seconds: 7,
      ease: arrive,
      caption: 'The ring is light from behind it, bent around the front.',
      frame: (t) => ({
        distanceRadii: glide(110, 24, t),
        fov: lerp(38, 52, t),
      }),
    },
  ],
};

const shot = SHOTS[SHOT_NAME];
if (!shot) {
  console.error(`no shot called "${SHOT_NAME}". known: ${Object.keys(SHOTS).join(', ')}`);
  process.exit(1);
}

const totalSeconds = shot.beats.reduce((s, b) => s + b.seconds, 0);

// ---------------------------------------------------------------------------
// Page setup
// ---------------------------------------------------------------------------

fs.rmSync(FRAME_DIR, { recursive: true, force: true });
fs.mkdirSync(FRAME_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--headless=new', '--no-sandbox', '--use-gl=angle', '--hide-scrollbars'],
  defaultViewport: { width: Math.round(WIDTH), height: Math.round(HEIGHT), deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log(`rendering "${SHOT_NAME}" — ${totalSeconds}s at ${FPS} fps, `
  + `${Math.round(WIDTH)}x${Math.round(HEIGHT)}${PREVIEW ? ' (preview)' : ''}`);

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.cosminova?.ready === true, { timeout: 180000 });

await page.evaluate(({ date, brand, site }) => {
  const sv = window.cosminova;
  sv.setRate(0);
  sv.setDate(date);
  sv.setUiVisible(false);
  // Overlays are for navigating, not for looking at. A trajectory ribbon drawn
  // on the celestial sphere cuts a bright curve straight across a landscape.
  for (const key of ['craft', 'trajectories', 'craftVectors', 'distantMarkers']) sv.setView(key, false);
  for (const key of [
    'labelPlanets', 'labelStars', 'labelGalaxies', 'labelBlackHoles', 'labelCraft', 'labelExo',
  ]) sv.setView(key, false);
  // Pin the detail. Left on auto, the governor trims terrain and resolution
  // whenever a frame runs long, which in a render is most of them — and the
  // trimming would be visible as the picture softening and recovering.
  sv.setQuality?.('ultra') ?? sv.quality?.setPreset?.('ultra');

  const style = document.createElement('style');
  style.textContent = `
    .immersive-hint, .loading { display: none !important; }
    #__cap {
      position: fixed; left: 0; right: 0; bottom: 12%;
      display: flex; justify-content: center; padding: 0 7%;
      pointer-events: none; z-index: 99999;
    }
    #__capText {
      font: 700 clamp(26px, 5.4vw, 66px)/1.28 var(--font, 'Inter', system-ui, sans-serif);
      color: #fff; text-align: center; letter-spacing: -0.01em;
      text-shadow: 0 3px 24px rgba(0,0,0,0.92), 0 0 6px rgba(0,0,0,0.95);
      opacity: 0; transition: none;
    }
    #__brand {
      position: fixed; left: 0; right: 0; top: 6.5%; text-align: center;
      font: 700 clamp(20px, 3.8vw, 46px)/1.2 var(--font, 'Inter', system-ui, sans-serif);
      color: #fff; letter-spacing: 0.18em; text-transform: uppercase;
      text-shadow: 0 3px 20px rgba(0,0,0,0.95); opacity: 0; z-index: 99999;
      pointer-events: none;
    }
    #__brand small {
      display: block; margin-top: 0.5em; font-size: 0.62em; letter-spacing: 0.06em;
      text-transform: none; font-weight: 500; opacity: 0.85;
    }
  `;
  document.head.append(style);

  const cap = document.createElement('div');
  cap.id = '__cap';
  cap.innerHTML = '<div id="__capText"></div>';
  document.body.append(cap);

  const bd = document.createElement('div');
  bd.id = '__brand';
  if (brand) bd.innerHTML = `${brand}${site ? `<small>${site}</small>` : ''}`;
  document.body.append(bd);

  window.__caption = (text, opacity) => {
    const node = document.getElementById('__capText');
    if (node.textContent !== text) node.textContent = text;
    node.style.opacity = String(opacity);
  };
  window.__brand = (opacity) => {
    if (!brand) return;
    document.getElementById('__brand').style.opacity = String(opacity);
  };

  /** Place the camera exactly. Anything the app might be doing on its own is
   *  cancelled first, or it fights the keyframes. */
  window.__place = (s) => {
    const sv = window.cosminova;
    const c = sv.controls;
    c.stopFlight();
    c.cruise = 0;
    c.zoomVelocity = 0;
    c.yawVelocity = 0;
    c.pitchVelocity = 0;
    if (s.date) sv.setDate(s.date);
    // A beat standing on a surface hands over the whole placement, because the
    // spot to stand on to see the sun at a given height moves as the sun does,
    // and this is what recomputes it. The sun setting over the beat is the
    // elevation being wound down frame by frame.
    if (s.stand) {
      const { body, ...options } = s.stand;
      sv.standAt(body, options);
      return;
    }
    if (s.fov !== undefined) c.fov = s.fov;
    if (s.distanceRadii !== undefined) c.distanceRadii = s.distanceRadii;
    if (s.yaw !== undefined) c.yaw = s.yaw;
    if (s.pitch !== undefined) c.pitch = s.pitch;
    c.lookYaw = s.lookYaw ?? 0;
    c.lookPitch = s.lookPitch ?? 0;
  };
}, { date: shot.date, brand: BRAND, site: SITE });

/**
 * Hold the frame until the scene has stopped arriving.
 *
 * Terrain streams in over several frames and textures upgrade behind it, so
 * capturing immediately would record the low-detail version of every frame and
 * the video would crawl with detail popping. Waiting for the patch count to
 * stop changing is what makes the render look better than the live app rather
 * than the same as it.
 */
async function settle(minMs, maxMs) {
  const started = Date.now();
  let last = -1;
  let stable = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 55));
    const patches = await page.evaluate(() => window.cosminova.stats().patches);
    if (patches === last) stable++;
    else { stable = 0; last = patches; }
    const waited = Date.now() - started;
    if (stable >= 2 && waited >= minMs) return;
    if (waited >= maxMs) return;
  }
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

const CAPTION_FADE = 0.45;
const captions = [];
let frameIndex = 0;
let elapsed = 0;
const ctx = {};
const startedAt = Date.now();

for (const beat of shot.beats) {
  if (beat.setup) await beat.setup(page, ctx);
  const frames = Math.round(beat.seconds * FPS);
  if (beat.caption) {
    captions.push({ from: elapsed + 0.15, to: elapsed + beat.seconds - 0.1, text: beat.caption });
  }

  for (let i = 0; i < frames; i++) {
    const t = frames === 1 ? 1 : i / (frames - 1);
    // The clock is linear; the easing is the beat's own business, and most
    // beats do not want any.
    const state = beat.frame((beat.ease ?? linear)(t), ctx);
    const seconds = beat.seconds * t;
    // Fade the caption in at the head of its beat and out at the tail.
    const fade = Math.min(
      seconds / CAPTION_FADE,
      (beat.seconds - seconds) / CAPTION_FADE,
      1,
    );
    // The name comes up over the last beat, so the frame people stop on has it.
    const isLast = beat === shot.beats[shot.beats.length - 1];
    const brandOpacity = isLast ? Math.min(Math.max((t - 0.45) / 0.25, 0), 1) : 0;

    await page.evaluate(
      ({ s, text, opacity, brand }) => {
        window.__place(s);
        window.__caption(text, opacity);
        window.__brand(brand);
      },
      { s: state, text: beat.caption ?? '', opacity: Math.max(fade, 0), brand: brandOpacity },
    );

    // Beats carrying streamed terrain are the ones worth waiting long for; a
    // camera out in space has nothing left to arrive.
    const onSurface = beat.name === 'descend' || Boolean(state.stand);
    await settle(onSurface ? 220 : 90, onSurface ? 2200 : 900);

    const file = path.join(FRAME_DIR, `f${String(frameIndex).padStart(5, '0')}.png`);
    await page.screenshot({ path: file, type: 'png' });
    frameIndex++;

    if (frameIndex % 25 === 0 || frameIndex === 1) {
      const total = Math.round(totalSeconds * FPS);
      const per = (Date.now() - startedAt) / frameIndex / 1000;
      const left = Math.round(((total - frameIndex) * per) / 6) / 10;
      process.stdout.write(
        `\r  frame ${frameIndex}/${total}  ${beat.name.padEnd(9)} `
        + `${per.toFixed(2)}s/frame  ~${left} min left      `,
      );
    }
  }
  elapsed += beat.seconds;
}
process.stdout.write('\n');

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

/**
 * The journey's own music, rendered offline from the app's synthesiser.
 *
 * The scene weights are stepped at the beat boundaries so the score travels
 * with the camera — close and domestic on the ground, opening out through the
 * crossing, settling onto the surface at the end.
 */
async function renderScore(seconds) {
  return page.evaluate(async ({ seconds, base }) => {
    const mod = await import(`${base}src/engine/ambient.js`);
    const rate = 48000;
    const ctx = new OfflineAudioContext(2, Math.ceil(rate * seconds), rate);
    const ambient = mod.createAmbient({ context: ctx, autoResume: false, schedule: false });
    const inner = ambient._internals;
    // No wall clock in an offline render, so the long crossfades have to be
    // collapsed or they never arrive inside the length of the piece.
    inner.setGlideScale(0.015);
    await ambient.start();

    const arc = [
      [0.00, { home: 1, leave: 0.06 }],
      [0.14, { home: 0.5, leave: 0.85, deep: 0.15 }],
      [0.37, { leave: 0.5, deep: 0.7, approach: 0.5, awe: 0.4, wonder: 0.3 }],
      [0.46, { deep: 0.35, approach: 0.9, awe: 0.55, wonder: 0.5 }],
      [0.72, { land: 0.9, approach: 0.25, home: 0.12, wonder: 0.25 }],
    ];
    inner.snap(arc[0][1]);
    for (const [at, mix] of arc.slice(1)) {
      ctx.suspend(at * seconds).then(() => {
        try { inner.snap(mix); } catch { /* keep going: silence is worse */ }
        ctx.resume();
      });
    }

    const PHRASE = 8 * 0.86;
    const count = Math.max(Math.floor((seconds - 0.6) / PHRASE), 1);
    for (let i = 0; i < count; i++) {
      ctx.suspend(0.3 + i * PHRASE).then(() => {
        try {
          if (i > 0 && i % 2 === 0) inner.nextChord();
          inner.renderPhrase(ctx.currentTime);
          if (i % 3 === 0) inner.strike('bell', 72, 0.018);
          if (i % 2 === 0) inner.strike('shimmer', 84, 0.02);
        } catch { /* a dropped phrase is a gap, not a failure */ }
        ctx.resume();
      });
    }

    const buffer = await ctx.startRendering();
    const L = buffer.getChannelData(0);
    const R = buffer.getChannelData(1);
    const out = new Array(buffer.length * 2);
    let peak = 0;
    for (let i = 0; i < buffer.length; i++) {
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    }
    // Normalise to a hair under full scale: the score is mixed to sit under an
    // app, and on a phone speaker that is inaudible.
    const gain = peak > 1e-5 ? 0.89 / peak : 1;
    // Ease the last second down so the piece ends rather than stopping.
    const tail = Math.min(Math.floor(rate * 1.2), buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      const fade = i > buffer.length - tail ? (buffer.length - i) / tail : 1;
      const head = Math.min(i / (rate * 0.35), 1);
      out[i * 2] = L[i] * gain * fade * head;
      out[i * 2 + 1] = R[i] * gain * fade * head;
    }
    return { samples: out, rate, peak };
  }, { seconds, base: URL });
}

function writeWav(file, interleaved, rate) {
  const frames = interleaved.length / 2;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + frames * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < interleaved.length; i++) {
    const v = Math.max(-1, Math.min(1, interleaved[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

const audioFile = path.join(OUT_DIR, `${SHOT_NAME}.wav`);
let haveAudio = false;
try {
  console.log('rendering the score ...');
  const score = await renderScore(totalSeconds);
  writeWav(audioFile, score.samples, score.rate);
  haveAudio = true;
  console.log(`  ${totalSeconds}s of music, peak ${(20 * Math.log10(score.peak || 1e-9)).toFixed(1)} dB before normalising`);
} catch (err) {
  console.log(`  no music: ${String(err.message).slice(0, 140)}`);
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

const srtTime = (s) => {
  const ms = Math.round(s * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const sec = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, '0')}`;
};
const srtFile = path.join(OUT_DIR, `${SHOT_NAME}.srt`);
fs.writeFileSync(
  srtFile,
  captions
    .map((c, i) => `${i + 1}\n${srtTime(c.from)} --> ${srtTime(c.to)}\n${c.text}\n`)
    .join('\n'),
);

await browser.close();

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

const outFile = path.join(OUT_DIR, `${SHOT_NAME}${LANDSCAPE ? '-wide' : ''}${PREVIEW ? '-preview' : ''}.mp4`);
const ff = [
  '-y',
  '-framerate', String(FPS),
  '-i', path.join(FRAME_DIR, 'f%05d.png'),
  ...(haveAudio ? ['-i', audioFile] : []),
  '-c:v', 'libx264',
  '-preset', PREVIEW ? 'veryfast' : 'slow',
  '-crf', PREVIEW ? '26' : '17',
  '-pix_fmt', 'yuv420p',
  ...(haveAudio ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
  '-movflags', '+faststart',
  outFile,
];

console.log('encoding ...');
await new Promise((resolve, reject) => {
  const proc = spawn(ffmpegPath, ff, { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  proc.stderr.on('data', (d) => { log += d.toString(); });
  proc.on('close', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`ffmpeg exited ${code}\n${log.slice(-1500)}`));
  });
});

if (!KEEP) fs.rmSync(FRAME_DIR, { recursive: true, force: true });

const size = (fs.statSync(outFile).size / 1e6).toFixed(1);
console.log(`\n  ${outFile}  ${size} MB  ${totalSeconds}s  ${Math.round(WIDTH)}x${Math.round(HEIGHT)}`);
console.log(`  ${srtFile}  ${captions.length} captions`);
if (haveAudio) console.log(`  ${audioFile}  score, generated — nothing to claim it`);
if (errors.length) {
  console.log('\n  console errors during the render:');
  for (const e of [...new Set(errors)].slice(0, 5)) console.log(`    ${e.slice(0, 160)}`);
}
