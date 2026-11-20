import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import puppeteer from 'puppeteer-core';
const out=path.resolve(process.env.OUT??'work/camera-look');fs.mkdirSync(out,{recursive:true});
const b=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--headless=new','--no-sandbox','--use-gl=angle'],defaultViewport:{width:1280,height:800}});const p=await b.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error'||m.type()==='warn'&&/WebGL|THREE/.test(m.text()))errors.push(m.text())});const wait=ms=>new Promise(r=>setTimeout(r,ms));const report={};
try{await p.goto('http://localhost:5179/?home=0');await p.waitForFunction('window.cosminova?.ready',{timeout:180000});await p.evaluate(()=>{const s=window.cosminova;s.setUiVisible(false);s.setQuality('high');s.setRate(0);});
for(const [key,phase]of [['moon',74],['mars',55],['jupiter',55],['earth',55],['sun',0]]){
 await p.evaluate(async({key,phase})=>{const s=window.cosminova;await s.loadDetail(key);s.lookFromSun(key,key==='sun'?215:2.7,phase,0);}, {key,phase});await wait(3000);await p.screenshot({path:path.join(out,key+'.png')});const n=await p.evaluate(()=>window.cosminova.stats().renderedFrames),t=Date.now();await wait(1500);report[key]=await p.evaluate(({n,t})=>({fps:(window.cosminova.stats().renderedFrames-n)*1000/(Date.now()-t),stats:window.cosminova.stats()}),{n,t});
}
report.errors=errors;fs.writeFileSync(path.join(out,'validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(Object.fromEntries(Object.entries(report).map(([k,v])=>[k,v.fps??v])),null,2));assert.deepEqual(errors,[]);
}finally{await b.close()}
