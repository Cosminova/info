import fs from 'node:fs';import assert from 'node:assert/strict';import puppeteer from 'puppeteer-core';
const out=process.env.OUT??'work/exo-landforms';fs.mkdirSync(out,{recursive:true});const wait=ms=>new Promise(r=>setTimeout(r,ms));
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--headless=new','--no-sandbox'],defaultViewport:{width:1280,height:800}});
try{const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'){errors.push(m.text());console.error(m.text())}});await page.goto('http://localhost:5179/?home=0');await page.waitForFunction('window.cosminova?.ready',{timeout:180000});
 const catalog=await page.evaluate(async()=>{const {describePlanet}=await import('/src/engine/classify.js'),{specFromPlanet}=await import('/src/engine/exo-system.js');const data=await(await fetch('/data/exoplanets.json')).json();let count=0;for(const host of data.systems)for(const entry of host.planets){const d=describePlanet(entry,{starTeff:host.teff,aAu:entry.aAu}),s=specFromPlanet(entry,d,'test');if(d.gaseous&&(s.iceLatitude!==0||s.exoMountains[0]!==0))throw Error(entry.name+' invalid giant');if(!d.gaseous&&!s.testWorld&&s.exoMountains[0]<=0)throw Error(entry.name+' missing mountain geometry');count++;}return count;});assert.equal(catalog,6327);
 const results=[];
 for(const key of ['exo:gj-887-c','exo:proxima-cen-d','exo:barnard-d']){
  await page.evaluate(key=>{const s=window.cosminova;s.controls.stopWalk();s.setQuality('high');s.setUiVisible(false);s.setRate(0);s.lookFromSun(key,3.5,55,15);},key);await wait(6000);
  const result=await page.evaluate(key=>{const s=window.cosminova,p=s.exoSystem.get(key).planet,u=p.material.uniforms,proto=u.uSunDir.value;
   const dirs=Array.from({length:512},(_,i)=>{const y=1-2*(i+.5)/512,a=i*2.3999632297,r=Math.sqrt(1-y*y);return proto.clone().set(r*Math.cos(a),y,r*Math.sin(a));});
   const full=p.groundHeightsKm(s.renderer,dirs);const amp=u.uExoMountains.value.x;let plain;
   try{u.uExoMountains.value.x=0;plain=p.groundHeightsKm(s.renderer,dirs);}finally{u.uExoMountains.value.x=amp;}
   let featureEffect=0;const feature=p.spec.landscapeKind==='rifted'?'uRiftDepth':p.spec.landscapeKind==='volcanic'?'uVolcanoHeight':null;
   if(feature){const value=u[feature].value;try{u[feature].value=0;const off=p.groundHeightsKm(s.renderer,dirs);featureEffect=Math.max(...full.map((v,i)=>Math.abs(v-off[i])))*1000;}finally{u[feature].value=value;}}
   let best=0,score=-Infinity;for(let i=0;i<dirs.length;i++){const v=full[i]-plain[i];if(dirs[i].dot(proto)>.45&&v>score){best=i;score=v;}}
   window.landformPoint=dirs[best].clone();
   return {key,kind:p.spec.landscapeKind,maxMountainDisplacementM:Math.max(...full.map((v,i)=>v-plain[i]))*1000,feature,featureEffectM:featureEffect,minHeightKm:Math.min(...full),maxHeightKm:Math.max(...full)};
  },key);
  assert.ok(result.maxMountainDisplacementM>100,JSON.stringify(result));if(result.feature)assert.ok(result.featureEffectM>10,JSON.stringify(result));results.push(result);
  await page.screenshot({path:out+'/'+key.replaceAll(':','-')+'-orbit.png'});
  await page.evaluate(key=>{const s=window.cosminova,p=s.exoSystem.get(key).planet,c=s.controls;c.startWalk();c._descent=null;c.walkLocal.copy(window.landformPoint);c.walkHeadingLocal.crossVectors(c.walkLocal.clone().set(0,1,0),c.walkLocal).normalize();c.walkEyeKm=8;c.walkPitch=-.45;c.walkGroundKm=p.groundHeightsKm(s.renderer,[c.walkLocal])[0]+.008;c.walkGroundEpoch++;},key);await wait(3500);const clearance=await page.evaluate(key=>{const s=window.cosminova,p=s.exoSystem.get(key).planet,c=s.controls;return c._walkCameraHeight-p.groundHeightsKm(s.renderer,[c.walkLocal])[0];},key);assert.ok(clearance>0,`Camera below terrain on ${key}: ${clearance}`);result.cameraClearanceKm=clearance;await page.screenshot({path:out+'/'+key.replaceAll(':','-')+'-mountains.png'});
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(out+'/results.json',JSON.stringify({catalog,results,errors},null,2));console.log(JSON.stringify(results));
}finally{await browser.close();}
