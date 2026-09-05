import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--headless=new','--no-sandbox','--use-gl=angle'], defaultViewport: { width: 1000, height: 700 } });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:5182/index.html', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.cosminova && window.cosminova.ready', { timeout: 180000 });
await p.evaluate(() => window.cosminova.setRate(0));
await p.evaluate(() => window.cosminova.target('star:TRAPPIST-1', 12));
await new Promise((r) => setTimeout(r, 3000));
await p.evaluate(() => window.cosminova.lookAtExo('exo:trappist-1-e', 2.6));
await new Promise((r) => setTimeout(r, 3000));
console.log(JSON.stringify(await p.evaluate(() => {
  const sv = window.cosminova;
  const item = sv.exoSystem.planets.find((i) => i.spec.key === 'exo:trappist-1-e');
  const u = item.planet.material.uniforms;
  const cam = sv.controls.worldPosition;
  const toCam = item.world.clone().sub(cam).normalize();
  const toStar = sv.exoSystem.position.clone().sub(item.world).normalize();
  return {
    visible: item.planet.group.visible,
    sunIntensity: u.uSunIntensity.value,
    sunDir: u.uSunDir.value.toArray().map((x) => +x.toFixed(3)),
    camLocal: u.uCameraLocal.value.length().toFixed(0),
    radius: item.spec.radiusKm,
    seaLevel: u.uSeaLevelKm.value,
    cloud: u.uCloudCover.value,
    phaseDot: +toStar.dot(toCam).toFixed(3),
    atmoDensity: u.uAtmosphereDensity.value,
    albedoBoost: u.uAlbedoBoost.value,
    exposure: sv.state.exposure,
  };
}), null, 1));
await b.close();
