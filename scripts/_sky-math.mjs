/**
 * The sky shader's integral, recomputed on the CPU from the live uniforms.
 *
 * The rendered sunset came out pale blue near the ground where the arithmetic
 * says it should be orange, so this reads the uniforms the GPU is actually
 * using and runs the same maths here, per view angle, with the intermediate
 * terms printed. Whatever disagrees between this and the frame is the bug.
 *
 * Usage: node scripts/_sky-math.mjs [body] [--phase 88]
 */
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const BODY = args.find((a) => !a.startsWith('--')) ?? 'earth';
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const PHASE = flag('phase', 88);
const ALT = flag('alt', 1.0006);
const BRIGHT = flag('brightness', 0);

const URL = process.env.COSMINOVA_URL ?? 'http://127.0.0.1:5182/';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  defaultViewport: { width: 480, height: 854 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 300)));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 90000 });

const settle = (n) =>
  page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        let count = 0;
        const tick = () => (++count > frames ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );

await page.evaluate(
  ({ body, phase, alt }) => {
    const sv = window.cosminova;
    sv.setRate(0);
    sv.lookFromSun(body, alt, phase, 0);
    const c = sv.controls;
    c.autoCenter = false;
    c.lookYaw = 0;
    c.lookPitch = 1.45;
    c.fov = 70;
  },
  { body: BODY, phase: PHASE, alt: ALT },
);
await page.evaluate((key) => window.cosminova.loadDetail(key), BODY);
await settle(60);

const u = await page.evaluate((body) => {
  const p = window.cosminova.planets.get(body);
  const s = p.skyUniforms;
  return {
    radius: s.uRadius.value,
    shell: s.uShellRadius.value,
    camera: s.uCameraLocal.value.toArray(),
    sun: s.uSunDir.value.toArray(),
    rayleigh: s.uRayleigh.value.toArray(),
    mie: s.uMie.value,
    mieG: s.uMieG.value,
    scaleHeight: s.uScaleHeight.value,
    mieHeight: s.uMieHeight.value,
    brightness: p.skyInscatterMaterial.uniforms.uBrightness.value,
    sunIntensity: p.skyInscatterMaterial.uniforms.uSunIntensity.value,
    sunColour: p.skyInscatterMaterial.uniforms.uSunColour.value.toArray(),
  };
}, BODY);

await browser.close();

if (BRIGHT) u.brightness = BRIGHT;

// ------------------------------------------------------------------ the maths

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.sqrt(dot(a, a));
const norm = (a) => {
  const l = len(a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function sphereSpan(o, d, r) {
  const b = dot(o, d);
  const c = dot(o, o) - r * r;
  const disc = b * b - c;
  if (disc < 0) return [1, -1];
  const s = Math.sqrt(disc);
  return [-b - s, -b + s];
}

function columnAlong(o, d, length, N = 6) {
  let r = 0;
  let m = 0;
  let prev = 0;
  for (let i = 0; i < N; i++) {
    const f = (i + 1) / N;
    const edge = length * f * f;
    const dt = edge - prev;
    const h = Math.max(len(add(o, mul(d, prev + dt * 0.5))) - u.radius, 0);
    r += Math.exp(-h / u.scaleHeight) * dt;
    m += Math.exp(-h / u.mieHeight) * dt;
    prev = edge;
  }
  return [r, m];
}

function inscatter(origin, ray, STEPS = 24) {
  const shell = sphereSpan(origin, ray, u.shell);
  if (shell[1] <= 0) return null;
  const near = Math.max(shell[0], 0);
  let far = shell[1];
  const ground = sphereSpan(origin, ray, u.radius);
  const hitGround = ground[0] > 0 && ground[1] > ground[0];
  if (hitGround) far = Math.min(far, ground[0]);
  const pathLen = far - near;
  if (pathLen <= 1e-6) return null;

  const mu = dot(ray, u.sun);
  const phaseR = 0.0596831 * (1 + mu * mu);
  const g = u.mieG;
  const hg = 1 + g * g - 2 * g * mu;
  const phaseM = (1 - g * g) / (12.5663706 * Math.pow(Math.max(hg, 1e-4), 1.5));

  let viewR = 0;
  let viewM = 0;
  const sumR = [0, 0, 0];
  const sumM = [0, 0, 0];
  let shadowed = 0;
  let firstLightT = null;

  let prev = 0;
  for (let i = 0; i < STEPS; i++) {
    const f = (i + 1) / STEPS;
    const edge = pathLen * f * f;
    const dt = edge - prev;
    const p = add(origin, mul(ray, near + prev + dt * 0.5));
    prev = edge;
    const h = Math.max(len(p) - u.radius, 0);
    const dR = Math.exp(-h / u.scaleHeight);
    const dM = Math.exp(-h / u.mieHeight);
    viewR += dR * dt;
    viewM += dM * dt;

    const blocked = sphereSpan(p, u.sun, u.radius);
    if (blocked[0] > 0 && blocked[1] > blocked[0]) {
      shadowed++;
      continue;
    }
    const toSun = sphereSpan(p, u.sun, u.shell);
    const light = columnAlong(p, u.sun, Math.max(toSun[1], 0));
    const T = [0, 1, 2].map((c) =>
      Math.exp(-(u.rayleigh[c] * (viewR + light[0]) + u.mie * (viewM + light[1]))),
    );
    if (!firstLightT) {
      firstLightT = [0, 1, 2].map((c) =>
        Math.exp(-(u.rayleigh[c] * light[0] + u.mie * light[1])),
      );
    }
    for (let c = 0; c < 3; c++) {
      sumR[c] += dR * T[c] * dt;
      sumM[c] += dM * T[c] * dt;
    }
  }

  const scale = u.brightness * Math.min(u.sunIntensity, 2.4);
  const colour = [0, 1, 2].map(
    (c) =>
      (sumR[c] * u.rayleigh[c] * phaseR + sumM[c] * u.mie * phaseM) * u.sunColour[c] * scale,
  );
  return { pathLen, hitGround, mu, phaseR, phaseM, shadowed, firstLightT, colour };
}

// ------------------------------------------------------------------- geometry

const up = norm(u.camera);
const altitude = len(u.camera) - u.radius;
const sunElev = (Math.asin(dot(up, u.sun)) * 180) / Math.PI;
// A horizontal direction pointing towards the sun, so the sweep runs up the
// sky through the sun's own azimuth where the sunset colour lives.
const east = norm(cross(cross(up, u.sun), up));
const horizonDip = (Math.acos(u.radius / len(u.camera)) * 180) / Math.PI;

console.log(`body            ${BODY}  phase ${PHASE}`);
console.log(`radius          ${u.radius.toFixed(1)} km   shell ${u.shell.toFixed(1)} km`);
console.log(`altitude        ${altitude.toFixed(2)} km`);
console.log(`sun elevation   ${sunElev.toFixed(2)} deg  (at the camera's sub-point)`);
console.log(`horizon dip     ${horizonDip.toFixed(2)} deg below horizontal`);
console.log(`rayleigh        ${u.rayleigh.map((v) => v.toExponential(2)).join('  ')} /km`);
console.log(`  zenith tau    ${u.rayleigh.map((v) => (v * u.scaleHeight).toFixed(3)).join('  ')}`);
console.log(`mie             ${u.mie.toExponential(2)} /km   g ${u.mieG}`);
console.log(`  zenith tau    ${(u.mie * u.mieHeight).toFixed(4)}`);
console.log(`scale heights   rayleigh ${u.scaleHeight.toFixed(2)} km   mie ${u.mieHeight.toFixed(2)} km`);
console.log(`brightness      ${u.brightness}   sunIntensity ${u.sunIntensity.toFixed(3)}`);
console.log('');
console.log('elev    len(km)  ground  shadowed  lightT(rgb)              linear rgb            sRGB');

const srgb = (v) => {
  const c = Math.max(0, Math.min(1, v));
  const e = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(e * 255);
};

for (const elev of [40, 20, 10, 4, 1, 0, -1, -2, -5, -10, -20, -34]) {
  const a = (elev * Math.PI) / 180;
  const ray = norm(add(mul(east, Math.cos(a)), mul(up, Math.sin(a))));
  const r = inscatter(u.camera, ray);
  if (!r) {
    console.log(`${String(elev).padStart(4)}    (no segment)`);
    continue;
  }
  const lt = r.firstLightT
    ? r.firstLightT.map((v) => v.toFixed(3)).join(' ')
    : '  -     -     -  ';
  console.log(
    `${String(elev).padStart(4)}  ${r.pathLen.toFixed(1).padStart(8)}  ${String(r.hitGround).padStart(6)}  ${String(r.shadowed).padStart(8)}  ${lt.padEnd(20)}  ${r.colour
      .map((v) => v.toFixed(4).padStart(7))
      .join(' ')}   ${r.colour.map(srgb).join(',')}`,
  );
}
