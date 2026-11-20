import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const out=path.resolve(process.env.OUT??'work/walk-safety');fs.mkdirSync(out,{recursive:true});
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--headless=new','--no-sandbox','--use-gl=angle'],defaultViewport:{width:1280,height:800}});
const page=await browser.newPage();const errors=[],warnings=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());if(m.type()==='warn'&&/WebGL|THREE/.test(m.text()))warnings.push(m.text());});
const wait=ms=>new Promise(r=>setTimeout(r,ms));const report={samples:[],performance:{}};
try{
 await page.goto(process.env.COSMINOVA_URL??'http://localhost:5179/?home=0');await page.waitForFunction('window.cosminova?.ready',{timeout:180000});
 await page.evaluate(()=>{window.cosminova.setQuality('high');window.cosminova.setUiVisible(false);window.cosminova.setRate(0);window.cosminova.visitTestBiome('alpine');});await wait(4500);
 await page.evaluate(async()=>{
   const {WalkSupport}=await import('/src/engine/walk-support.js'); const {Vector3,Ray}=await import(performance.getEntriesByType('resource').map(r=>r.name).find(n=>/\/deps\/three\.js/.test(n)));
   window.auditGround=()=>{
     const s=window.cosminova,p=s.exoSystem.get('exo:gliese-12-b').planet,c=s.controls;
     const tile=new WalkSupport(p,s.renderer).describe(c.walkLocal);if(!tile)return {missing:true};
     const heights=p.groundHeightsKm(s.renderer,tile.dirs),radius=p.radius;
     const verts=tile.dirs.map((d,i)=>d.clone().multiplyScalar(radius+heights[i]));
     const ray=new Ray(new Vector3(),c.walkLocal.clone());let highest=-Infinity;const hit=new Vector3();
     for(let y=0;y<7;y++)for(let x=0;x<7;x++){
       const a=y*8+x,b=a+1,d=a+8,e=d+1;
       for(const [i,j,k]of [[a,b,e],[a,e,d]])if(ray.intersectTriangle(verts[i],verts[j],verts[k],false,hit))highest=Math.max(highest,hit.length()-radius);
     }
     return {clearanceM:((c._walkCameraHeight ?? (c.walkGroundKm+c.walkEyeKm))-highest)*1000,ground:c.walkGroundKm,meshGround:highest,level:tile.level,waiting:s.stats().collisionBlockedSteps};
   };
 });
 for(const biome of ['alpine','volcano','coast','desert']){
   await page.evaluate(id=>window.cosminova.visitTestBiome(id),biome);await wait(2000);
   for(const keys of [['KeyW','ShiftLeft'],['KeyD'],['KeyS','ShiftLeft'],['KeyA']]){
     await page.evaluate(keys=>keys.forEach(k=>window.cosminova.controls.setInput(k,true)),keys);
     for(let i=0;i<4;i++){await wait(160);const sample=await page.evaluate(()=>window.auditGround());report.samples.push({biome,keys,...sample});assert.ok(!sample.missing&&Number.isFinite(sample.clearanceM)&&sample.clearanceM>=0.05,`Camera under rendered terrain: ${JSON.stringify(sample)}`);}
     await page.evaluate(keys=>keys.forEach(k=>window.cosminova.controls.setInput(k,false)),keys);
   }
   await page.screenshot({path:path.join(out,`${biome}.png`)});
 }
 // Directly reproduce the former PBO race: start an async read then synchronously
 // ask for exactly the same terrain point before the fence has resolved.
 report.readback=await page.evaluate(async()=>{
   const s=window.cosminova,p=s.exoSystem.get('exo:gliese-12-b').planet;
   if(p._asyncProbe)await p._asyncProbe;
   const d=s.controls.walkLocal.clone();const pending=p.groundHeightsKmAsync(s.renderer,[d]);
   const sync=p.groundHeightsKm(s.renderer,[d])[0];const asyncHeight=(await pending)[0];
   return {sync,asyncHeight,error:s.renderer.getContext().getError()};
 });assert.equal(report.readback.error,0);assert.ok(Math.abs(report.readback.sync-report.readback.asyncHeight)<.00001);
 for(const q of ['ultra','high','medium']){
   await page.evaluate(q=>window.cosminova.setQuality(q),q);await wait(1200);
   const before=await page.evaluate(()=>window.cosminova.stats());await wait(2500);const after=await page.evaluate(()=>window.cosminova.stats());
   report.performance[q]={fps:(after.renderedFrames-before.renderedFrames)/2.5,renderScale:after.renderScale};
   const sample=await page.evaluate(()=>window.auditGround());assert.ok(sample.clearanceM>=0.05);report.samples.push({quality:q,...sample});
 }
 // Real page focus loss, with the full-detail scene still visible in its tab.
 const other=await browser.newPage();await other.goto('about:blank');await other.bringToFront();await wait(500);
 const start=await page.evaluate(()=>window.cosminova.stats());await wait(2200);const end=await page.evaluate(()=>window.cosminova.stats());
 report.background={frames:end.renderedFrames-start.renderedFrames,renderScale:end.renderScale,focused:end.renderFocused};assert.ok(report.background.frames<=3,'Background rendering must release the GPU');await other.close();await page.bringToFront();
 for(const id of ['meadow','wetland','ice']){await page.evaluate(id=>window.cosminova.visitTestBiome(id),id);await wait(3000);await page.screenshot({path:path.join(out,`${id}.png`)});}
 await page.evaluate(()=>{window.cosminova.setTestLighting('night');window.cosminova.controls.walkPitch=.45;});await wait(2500);await page.screenshot({path:path.join(out,'aurora.png')});
 report.errors=errors;report.warnings=warnings;
 fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,samples:report.samples.length,minClearanceM:Math.min(...report.samples.map(x=>x.clearanceM))},null,2));assert.deepEqual(errors,[]);assert.deepEqual(warnings,[]);
}finally{await browser.close();}
