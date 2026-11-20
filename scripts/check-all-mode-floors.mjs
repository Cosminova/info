import fs from 'node:fs';import assert from 'node:assert/strict';import puppeteer from 'puppeteer-core';
const wait=ms=>new Promise(r=>setTimeout(r,ms)),results=[],errors=[];
const b=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--headless=new','--no-sandbox'],defaultViewport:{width:1280,height:800}});
try{const p=await b.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto('http://localhost:5179/?home=0');await p.waitForFunction('window.cosminova?.ready',{timeout:180000});
for(const mode of ['orbit','fly','ship','cinematic']){
 await p.evaluate(()=>{const s=window.cosminova;s.setShip(false);s.controls.stopRoam();s.setUiVisible(false);s.setRate(0);s.lookFromSun('exo:gj-887-c',2,40,15)});await wait(1500);
 await p.evaluate(mode=>{const s=window.cosminova,c=s.controls;
  if(mode==='cinematic'){c.flyTo(s.state.target,{distanceRadii:.99,duration:600});return;}
  if(mode==='ship'){s.setShip(true);c.roamOffset.setLength(c.targetRadius*.99);c.originOffset.copy(c.roamOffset);}
  else {c.mode=mode;c.distanceRadii=.99;}
 },mode);await wait(1800);
 const result=await p.evaluate(mode=>{const s=window.cosminova,x=s.exoSystem.get('exo:gj-887-c').planet,d=x.material.uniforms.uCameraLocal.value.clone(),h=x.groundHeightsKm(s.renderer,[d.clone().normalize()])[0];return {mode,clearanceM:(d.length()-x.radius-h)*1000,gl:s.renderer.getContext().getError()};},mode);results.push(result);assert.ok(result.clearanceM>=0,JSON.stringify(result));assert.equal(result.gl,0);
}
await p.evaluate(()=>{const s=window.cosminova;s.setShip(false);s.controls.stopRoam();s.lookFromSun('amalthea',2,40,15)});await wait(1500);
await p.evaluate(()=>window.cosminova.controls.distanceRadii=.99);await wait(1800);
const irregular=await p.evaluate(()=>{const s=window.cosminova,p=s.planets.get('amalthea'),u=p.material.uniforms,eye=u.uCameraLocal.value.clone(),axis=u.uAxisScale.value,dir=eye.clone().divide(axis).normalize(),h=p.groundHeightsKm(s.renderer,[dir])[0],floor=dir.clone().multiplyScalar(p.radius+h).multiply(axis).length();return {mode:'irregular-moon',clearanceM:(eye.length()-floor)*1000,axis:axis.toArray(),gl:s.renderer.getContext().getError()};});results.push(irregular);assert.ok(irregular.clearanceM>=0,JSON.stringify(irregular));assert.deepEqual(errors,[]);
}finally{await b.close();fs.writeFileSync('work/system-mode-floors.json',JSON.stringify({results,errors},null,2));console.log(JSON.stringify(results));}
