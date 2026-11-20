import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
const out=process.env.OUT??'work/terrain-ranges';fs.mkdirSync(out,{recursive:true});
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--headless=new','--no-sandbox'],defaultViewport:{width:1280,height:800}});
const page=await browser.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
try{
 await page.goto('http://localhost:5179/?home=0');await page.waitForFunction('window.cosminova?.ready',{timeout:180000});
 const results=[];
 for(const id of ['meadow','desert','alpine']){
  await page.evaluate(id=>{const s=window.cosminova;s.setQuality('high');s.setUiVisible(false);s.visitTestBiome(id);},id);
  await new Promise(r=>setTimeout(r,3500));
  const result=await page.evaluate(async id=>{
   const {TEST_SITES,siteDirection}=await import('/src/engine/test-world.js');
   const s=window.cosminova,p=s.exoSystem.get('exo:gliese-12-b').planet;
   const centre=s.controls.walkLocal.clone().fromArray(siteDirection(TEST_SITES.find(x=>x.id===id)));
   const east=centre.clone().set(-centre.z,0,centre.x).normalize();
   const dirs=Array.from({length:65},(_,i)=>centre.clone().addScaledVector(east,(i-32)*.3125/p.radius).normalize());
   const heights=p.groundHeightsKm(s.renderer,dirs);
   return {id,minKm:Math.min(...heights),maxKm:Math.max(...heights),reliefM:(Math.max(...heights)-Math.min(...heights))*1000};
  },id);
  assert.ok(result.reliefM>500,`${id} needs real mountain geometry`);results.push(result);
  await page.screenshot({path:`${out}/${id}.png`});
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(`${out}/validation.json`,JSON.stringify({results,errors},null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser.close();}
