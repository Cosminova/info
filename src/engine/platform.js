/**
 * What kind of machine this is, and what it is allowed to spend.
 *
 * quality.js already answers "is this frame too slow" better than any hardware
 * guess could, and nothing here tries to duplicate it. The two files divide the
 * problem by whether a cost can be changed mid-flight. Resolution, terrain
 * octaves and patch budget can, so they belong to the closed loop. A shader's
 * loop bound is compiled into the program, a texture's size is fixed once it is
 * uploaded, and a particle count is fixed when the buffer is allocated — those
 * have to be decided before the first frame, which is what this file is for.
 *
 * The reason a phone needs its own answer is memory rather than speed. A desktop
 * near tier is 8192x4096; decoded and uploaded that is 134 MB, and iOS ends a
 * web content process well before a few of those are resident. There is no
 * frame-time signal to react to because the process is simply gone. So the
 * ceilings below are set low enough that the app cannot ask for more than the
 * device will give, and the adaptive loop then works normally inside them.
 *
 * Device class comes from the native shell when there is one, because a shell
 * knows what it is running on and a user agent string is a rumour. The sniffing
 * path exists for mobile Safari, where there is no shell to ask.
 */

/**
 * Desktop keeps every number the app shipped with, so importing this module
 * changes nothing on macOS or Windows. The mobile rows are the edits.
 */
const PROFILES = {
  desktop: {
    deviceClass: 'desktop',
    // Retina at full rate is what the desktop build was profiled against.
    dprCap: 2,
    antialias: true,
    targetFps: 60,
    maxRenderScale: 1,
    // Elevation and normal ceilings. The desktop asset set carries a 4096
    // height pyramid and 8192 normals.
    demMaxWidth: 4096,
    normMaxWidth: 8192,
    panoramaMaxWidth: 4096,
    // Apparent size at which a body earns its large surface map.
    nearUpgradePixels: 160,
    // Shader loop bounds, compiled into the program.
    blackHoleSteps: 160,
    skyInscatterSteps: 24,
    skyColumnSamples: 6,
    ringSegments: 512,
    // Buffer sizes, fixed at allocation.
    milkyWayParticles: 72000,
    hostGalaxyStars: 62000,
    faintStars: 600000,
    maxPointSize: 90,
  },

  /**
   * iPad, and anything else with a touch screen and room to draw. An M-series
   * iPad would hold more than this, but the same binary runs on an A-series one
   * with a fraction of the memory bandwidth, and the adaptive loop can recover
   * a conservative frame far more gracefully than it can recover a terminated
   * content process.
   */
  tablet: {
    deviceClass: 'tablet',
    dprCap: 2,
    antialias: false,
    targetFps: 60,
    maxRenderScale: 0.85,
    demMaxWidth: 1024,
    normMaxWidth: 2048,
    panoramaMaxWidth: 2048,
    nearUpgradePixels: 240,
    blackHoleSteps: 72,
    skyInscatterSteps: 12,
    skyColumnSamples: 4,
    ringSegments: 256,
    milkyWayParticles: 36000,
    hostGalaxyStars: 32000,
    faintStars: 120000,
    maxPointSize: 46,
  },

  /**
   * iPhone. Thirty is the target rather than sixty because this scene is
   * fragment-bound: doubling the frame rate here costs half the resolution, and
   * a sharp thirty reads better than a soft sixty on a screen held at arm's
   * length. It also keeps the phone from throttling three minutes in, which
   * looks far worse than either.
   */
  phone: {
    deviceClass: 'phone',
    dprCap: 2,
    antialias: false,
    targetFps: 30,
    maxRenderScale: 0.67,
    demMaxWidth: 512,
    normMaxWidth: 1024,
    panoramaMaxWidth: 2048,
    nearUpgradePixels: 320,
    blackHoleSteps: 48,
    skyInscatterSteps: 8,
    skyColumnSamples: 4,
    ringSegments: 192,
    milkyWayParticles: 18000,
    hostGalaxyStars: 16000,
    faintStars: 40000,
    maxPointSize: 32,
  },
};

/** The native shell's own account of itself, injected before any page script. */
function shellInfo() {
  if (typeof window === 'undefined') return null;
  return window.cosminovaShell ?? null;
}

/**
 * Only reached in a browser, where there is no shell to ask.
 *
 * iPadOS reports itself as a Mac in the user agent and has done for years, so
 * the tablet test is a touch screen on a machine claiming to be a desktop —
 * which no actual desktop Mac satisfies. The phone/tablet split is on the short
 * edge in CSS pixels rather than the long one, so it does not change when the
 * device is rotated.
 */
function sniff() {
  if (typeof window === 'undefined') return 'desktop';
  const ua = navigator.userAgent ?? '';
  const points = navigator.maxTouchPoints ?? 0;
  const touch = points > 1 || 'ontouchstart' in window;
  const iPhone = /iPhone|iPod/.test(ua);
  const iPad = /iPad/.test(ua) || (touch && /Macintosh/.test(ua));
  const android = /Android/.test(ua);
  if (!touch && !iPhone) return 'desktop';
  if (iPhone) return 'phone';
  if (iPad) return 'tablet';
  if (android) return Math.min(window.innerWidth, window.innerHeight) < 500 ? 'phone' : 'tablet';
  return 'desktop';
}

function resolve() {
  const shell = shellInfo();
  const named = shell?.deviceClass;
  const deviceClass = PROFILES[named] ? named : sniff();
  const profile = { ...PROFILES[deviceClass] };
  return {
    ...profile,
    /** 'ios' | 'macos' | 'web', for the few places that need the host itself. */
    shell: shell?.shell ?? (window.cosminovaDesktop?.shell ?? 'web'),
    mobile: deviceClass !== 'desktop',
    touch: deviceClass !== 'desktop',
  };
}

/**
 * Resolved once. A device does not become a different device, and a profile that
 * could change under the app would mean shader programs and buffer sizes
 * disagreeing with each other halfway through a session.
 */
export const platform = resolve();

/** Clamps a requested texture width to what this device is willing to hold. */
export function capTextureWidth(wanted, kind) {
  if (kind === 'dem') return Math.min(wanted, platform.demMaxWidth);
  if (kind === 'norm') return Math.min(wanted, platform.normMaxWidth);
  return wanted;
}

/** The pixel ratio to hand the renderer, before the adaptive render scale. */
export function basePixelRatio() {
  const dpr = (typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1;
  return Math.min(dpr, platform.dprCap);
}
