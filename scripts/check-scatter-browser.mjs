import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
const out=process.env.OUT??'work/scatter-browser';fs.mkdirSync(out,{recursive:true});
const b=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--headless=new','--no-sandbox','--use-gl=angle'],defaultViewport:{width:1280,height:800}});
const p=await b.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'||m.type()==='warn'&&/WebGL|THREE/.test(m.text()))errors.push(m.text())});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(){await p.waitForFunction(()=>{const s=window.cosminova.exoSystem.get('exo:gliese-12-b').planet.surfaceScatter;return !s.pending&&s.stats().queued===0},{timeout:60000});await wait(1600);}
try{
 await p.goto('http://localhost:5179/?home=0');await p.waitForFunction('window.cosminova?.ready',{timeout:180000});
 await p.evaluate(()=>{const s=window.cosminova;s.setQuality('high');s.setUiVisible(false);s.setRate(0);s.visitTestBiome('meadow');window.scatterStart=s.controls.walkLocal.clone();
  // Resident prefetch cells have a 12 m rescan tolerance. Compare every
  // actually visible rock, not invisible boundary cells retained by hysteresis.
  window.visibleRockSnapshot=()=>{const p=s.exoSystem.get('exo:gliese-12-b').planet;
   return p.surfaceScatter.snapshot().filter(r=>{const d=s.controls.walkLocal.clone().fromArray(r.position).normalize();return d.distanceTo(window.scatterStart)*p.radius<.095;});};});await ready();
 const first=await p.evaluate(()=>window.visibleRockSnapshot());assert.ok(first.length);
 await p.screenshot({path:out+'/persistent-rocks.png'});
 await p.evaluate(()=>{const c=window.cosminova.controls,d=window.scatterStart,e=d.clone().set(-d.z,0,d.x).normalize();c.walkLocal.copy(d).addScaledVector(e,.25/c.targetRadius).normalize();});await ready();
 const away=await p.evaluate(()=>window.cosminova.exoSystem.get('exo:gliese-12-b').planet.surfaceScatter.stats());
 await p.evaluate(()=>window.cosminova.controls.walkLocal.copy(window.scatterStart));await ready();
 const returned=await p.evaluate(()=>{const s=window.cosminova.exoSystem.get('exo:gliese-12-b').planet.surfaceScatter;return {objects:window.visibleRockSnapshot(),stats:s.stats()}});
 assert.deepEqual(returned.objects,first);assert.equal(returned.stats.queries,away.queries,'Cached return must not request new terrain heights');
 // Re-create the scatter component: no in-memory cache or camera-dependent
 // sampling may be needed to reproduce a location.
 await p.evaluate(async()=>{const {SurfaceScatter}=await import('/src/engine/surface-scatter.js');const pl=window.cosminova.exoSystem.get('exo:gliese-12-b').planet;pl.surfaceScatter.dispose();pl.surfaceScatter=new SurfaceScatter(pl);window.cosminova.setQuality('medium');});await ready();
 const regenerated=await p.evaluate(()=>window.visibleRockSnapshot());assert.deepEqual(regenerated,first);
 // Real walking crosses several old 22 m rebuild boundaries. Existing IDs
 // must retain identical world transforms and loading must stay ahead.
 const before=await p.evaluate(()=>{const s=window.cosminova;const st=s.exoSystem.get('exo:gliese-12-b').planet.surfaceScatter.stats();s.controls.setInput('KeyW',true);return {stats:st,dir:s.controls.walkLocal.toArray()};});
 await wait(15000);
 const walked=await p.evaluate(()=>{const s=window.cosminova;s.controls.setInput('KeyW',false);const sc=s.exoSystem.get('exo:gliese-12-b').planet.surfaceScatter;return {objects:sc.snapshot(),stats:sc.stats(),dir:s.controls.walkLocal.toArray()};});
 assert.ok(walked.dir.some((x,i)=>Math.abs(x-before.dir[i])>1e-7));
 const old=new Map(first.map(r=>[r.id,r]));let common=0;for(const r of walked.objects)if(old.has(r.id)){assert.deepEqual(r,old.get(r.id));common++;}assert.ok(common>0);
 assert.equal(walked.stats.lateLoads,before.stats.lateLoads,'Ordinary walking must load cells before they enter visible range');assert.equal(walked.stats.failures,0);
 await p.evaluate(()=>window.cosminova.visitTestBiome('alpine'));await ready();
 const foundations=await p.evaluate(()=>{
  const s=window.cosminova,pl=s.exoSystem.get('exo:gliese-12-b').planet,sc=pl.surfaceScatter;
  const rocks=[...sc.cache.values()].flatMap(c=>c.rocks.filter(r=>r.position)).sort((a,b)=>a.dir.distanceTo(s.controls.walkLocal)-b.dir.distanceTo(s.controls.walkLocal)).slice(0,32);
  const heights=pl.groundHeightsKm(s.renderer,rocks.map(r=>r.dir));
  return {count:rocks.length,maxErrorM:Math.max(...rocks.map((r,i)=>Math.abs(r.position.length()-pl.radius-heights[i])*1000))};
 });assert.ok(foundations.count>0);assert.ok(foundations.maxErrorM<.002,'Cached rock foundations must agree with the live terrain field');
 await p.screenshot({path:out+'/alpine-ground.png'});
 await p.evaluate(()=>{window.cosminova.controls.walkEyeKm=.2;window.cosminova.controls.walkPitch=-.15;});await wait(2500);await p.screenshot({path:out+'/alpine-landscape.png'});
 assert.deepEqual(errors,[]);
 const result={passed:true,initialObjects:first.length,unchangedObjectsAfterWalking:common,cacheReturnQueries:returned.stats.queries-away.queries,regeneratedAtDifferentQuality:true,foundations,walk:walked.stats,errors};fs.writeFileSync(out+'/validation.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await b.close();}
