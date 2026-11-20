import puppeteer from 'puppeteer-core';import fs from 'node:fs';import assert from 'node:assert/strict';
const out=process.env.OUT??'work/system-check';fs.mkdirSync(out,{recursive:true});const wait=ms=>new Promise(r=>setTimeout(r,ms));
const b=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--headless=new','--no-sandbox'],defaultViewport:{width:1280,height:800}});
const report={errors:[],worlds:[]};
try{const p=await b.newPage();p.on('pageerror',e=>report.errors.push(e.message));p.on('console',m=>{if(m.type()==='error')report.errors.push(m.text())});await p.goto('http://localhost:5179/?home=0');await p.waitForFunction('window.cosminova?.ready',{timeout:180000});await p.evaluate(()=>{window.cosminova.setQuality('high');window.cosminova.setRate(0);window.cosminova.setUiVisible(false)});
 for(const key of ['earth','moon','saturn','exo:proxima-cen-b','exo:proxima-cen-d','exo:barnard-d','exo:gj-887-c']){
  await p.evaluate(key=>{const s=window.cosminova;s.lookFromSun(key,3.5,45,15);if(key==='earth'||key==='moon')s.controls.pitch=1.35;},key);await wait(2500);
  await p.screenshot({path:`${out}/${key.replaceAll(':','-')}.png`});
  report.worlds.push(await p.evaluate(key=>{const s=window.cosminova,item=s.exoSystem?.get(key),u=item?.planet?.material.uniforms;return {key,clouds:u?.uCloudCover.value,cloudScale:u?.uCloudFreq.value,mountains:u?.uExoMountains.value.toArray(),family:item?.spec.landscapeKind,gl:s.renderer.getContext().getError()};},key));
 }
 // Same rendering/collision code at 1e23 km, where absolute subtraction loses
 // millions of kilometres. Keep the already-established local camera frame.
 await p.evaluate(()=>{const s=window.cosminova;s.exoSystem.position.set(1e23,-2e23,3e23);s.controls.distanceRadii=1.00000001;});await wait(2200);
 report.farOrbit=await p.evaluate(()=>{const s=window.cosminova,p=s.exoSystem.get(s.state.target).planet,c=s.controls;const d=p.material.uniforms.uCameraLocal.value.clone().normalize(),h=p.groundHeightsKm(s.renderer,[d])[0];return {clearanceKm:p.material.uniforms.uCameraLocal.value.length()-p.radius-h,patches:p.sphere.patchCount,offset:c.originOffset.length(),radius:p.radius};});
 assert.ok(report.farOrbit.clearanceKm>=-.002,JSON.stringify(report.farOrbit));await p.screenshot({path:out+'/far-close.png'});
 // Close-range flight must remain outside terrain at intergalactic coordinates.
 await p.evaluate(()=>{const s=window.cosminova,c=s.controls;c.startRoam();c.setInput('KeyW',true);c.flySpeed=10;});await wait(1200);await p.evaluate(()=>window.cosminova.controls.setInput('KeyW',false));
 report.flight=await p.evaluate(()=>{const s=window.cosminova,p=s.exoSystem.get(s.state.target).planet,c=s.controls;return {distance:c.originOffset.length(),radius:p.radius,mode:c.mode};});assert.ok(report.flight.distance>=report.flight.radius*.99,JSON.stringify(report.flight));
 await p.evaluate(()=>{const s=window.cosminova;s.controls.stopRoam();s.lookFromSun('exo:proxima-cen-b',3.5,40,15);s.setUiVisible(true);s.ui.togglePanel('system')});await wait(1500);
 await p.evaluate(()=>window.cosminova.target(window.cosminova.exoSystem.key));await wait(2000);
 report.stars=await p.evaluate(()=>{const s=window.cosminova,x=s.exoSystem;return {hostFlare:x.star.flare.visible,companionFlare:x.companion?.star.flare.visible,members:s.systemMembers(x.key),previews:document.querySelectorAll('.system-preview-item').length};});assert.ok(report.stars.hostFlare);assert.ok(report.stars.previews>0);await p.screenshot({path:out+'/system-panel.png'});
 assert.deepEqual(report.errors,[]);fs.writeFileSync(out+'/results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{fs.writeFileSync(out+'/results.json',JSON.stringify(report,null,2));await b.close();}
