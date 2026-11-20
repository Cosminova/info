import sharp from 'sharp';import fs from 'node:fs';import assert from 'node:assert/strict';import puppeteer from 'puppeteer-core';
const out=process.env.OUT??'work/visual-fixes';fs.mkdirSync(out,{recursive:true});
const b=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--headless=new','--no-sandbox'],defaultViewport:{width:1280,height:800}});
const p=await b.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text())});const wait=ms=>new Promise(r=>setTimeout(r,ms));const report={};
try{
 await p.goto('http://localhost:5179/?home=0');await p.waitForFunction('window.cosminova?.ready',{timeout:180000});
 await p.evaluate(()=>{const s=window.cosminova;s.setUiVisible(false);s.setQuality('high');s.setRate(0);s.lookFromSun('sun',7,0,0);});await wait(2500);
 report.sun=await p.evaluate(()=>{const u=window.cosminova.sun.flareMaterial.uniforms;return {spikes:u.uSpikes.value,intensity:u.uIntensity.value,resolved:u.uResolved.value};});assert.equal(report.sun.spikes,0);assert.ok(report.sun.intensity<=.28);await p.screenshot({path:out+'/sun-close.png'});
 await p.evaluate(()=>window.cosminova.lookFromSun('exo:gliese-12-b',3.5,55,15));await wait(4000);
 report.clouds=await p.evaluate(()=>{const s=window.cosminova,pl=s.exoSystem.get('exo:gliese-12-b').planet;return {volume:!!pl.cloudVolume,base:pl.cloudVolume?.material.uniforms.uCloudBase.value-pl.radius,top:pl.cloudVolume?.material.uniforms.uCloudTop.value-pl.radius,cover:pl.material.uniforms.uCloudCover.value};});assert.ok(report.clouds.volume);await p.screenshot({path:out+'/gliese-orbit-clouds.png'});
 await p.evaluate(()=>window.cosminova.exoSystem.get('exo:gliese-12-b').planet.cloudVolume.visible=false);await wait(500);await p.screenshot({path:out+'/gliese-orbit-no-clouds.png'});
 await p.evaluate(()=>window.cosminova.exoSystem.get('exo:gliese-12-b').planet.cloudVolume.visible=true);
 const on=await sharp(out+'/gliese-orbit-clouds.png').removeAlpha().raw().toBuffer(),off=await sharp(out+'/gliese-orbit-no-clouds.png').removeAlpha().raw().toBuffer();
 let starPixels=0;for(let y=0;y<100;y++)for(let x=0;x<200;x++){const i=(y*1280+x)*3;if(Math.max(on[i],on[i+1],on[i+2])>60)starPixels++;}
 report.backgroundStarPixels=starPixels;assert.ok(starPixels>30,'Planet framing must retain background stars');
 report.cloudChangedChannels=on.reduce((n,v,i)=>n+(Math.abs(v-off[i])>8?1:0),0);assert.ok(report.cloudChangedChannels>10000,'Volume must visibly render over the planet, not just exist in the scene');
 const n=await p.evaluate(()=>window.cosminova.stats().renderedFrames),t=Date.now();await wait(2000);report.orbitFps=(await p.evaluate(()=>window.cosminova.stats().renderedFrames)-n)*1000/(Date.now()-t);
 // Sample ordinary locations, outside every named biome. No biome teleport.
 report.globalTerrain=await p.evaluate(async()=>{const s=window.cosminova,pl=s.exoSystem.get('exo:gliese-12-b').planet;const {TEST_SITES,siteDirection}=await import('/src/engine/test-world.js');
 const results=[];for(const [lat,lon]of [[15,35],[-20,160],[45,-120]]){
 const d=s.controls.walkLocal.clone().fromArray(siteDirection({lat,lon}));const east=d.clone().set(-d.z,0,d.x).normalize();
 const dirs=Array.from({length:65},(_,i)=>d.clone().addScaledVector(east,(i-32)*.3125/pl.radius).normalize());const heights=pl.groundHeightsKm(s.renderer,dirs);
 results.push({lat,lon,outsideBiomes:TEST_SITES.every(site=>d.dot(d.clone().fromArray(siteDirection(site)))<.997),reliefM:1000*(Math.max(...heights)-Math.min(...heights))});}return results;});
 assert.ok(report.globalTerrain.every(x=>x.outsideBiomes));assert.ok(report.globalTerrain.some(x=>x.reliefM>500));
 await p.evaluate(()=>{const s=window.cosminova;s.controls.startWalk();s.controls._descent=null;s.controls.walkPitch=.35;});await wait(4000);await p.screenshot({path:out+'/normal-landing.png'});
 await p.evaluate(()=>window.cosminova.visitTestBiome('alpine'));await wait(3000);await p.screenshot({path:out+'/alpine-clouds.png'});
 await p.evaluate(()=>{const c=window.cosminova.controls;c.walkEyeKm=14.5;c.walkPitch=0;});await wait(1500);await p.screenshot({path:out+'/inside-clouds.png'});
 assert.deepEqual(errors,[]);report.errors=errors;fs.writeFileSync(out+'/validation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await b.close();}
