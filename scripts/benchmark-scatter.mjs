import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const out=path.resolve(process.env.OUT??'work/scatter-baseline');fs.mkdirSync(out,{recursive:true});
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--headless=new','--no-sandbox','--use-gl=angle'],defaultViewport:{width:1280,height:800}});
const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
if(process.env.BASELINE_DIR||process.env.BASELINE_TERRAIN){
 const transformed=await (await fetch('http://localhost:5179/src/engine/surface-scatter.js')).text();
 const three=transformed.match(/from ["']([^"']*\/deps\/three\.js[^"']*)["']/)?.[1];
 if(!three)throw new Error('Cannot resolve the shared Three module for baseline replay');
 await page.setRequestInterception(true);page.on('request',r=>{
  const pathname=new URL(r.url()).pathname;
  const file=process.env.BASELINE_DIR?path.join(process.env.BASELINE_DIR,path.basename(pathname)):
   pathname==='/src/engine/test-world.js'?process.env.BASELINE_TERRAIN:null;
  if(pathname.startsWith('/src/engine/')&&file&&fs.existsSync(file))r.respond({status:200,contentType:'application/javascript',body:fs.readFileSync(file,'utf8').replaceAll("from 'three'",`from '${three}'`)});else r.continue();
 });
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 await page.goto(process.env.URL??'http://localhost:5179/?home=0');await page.waitForFunction('window.cosminova?.ready',{timeout:180000});
 await page.evaluate(()=>{const s=window.cosminova;s.setQuality('high');s.setUiVisible(false);s.visitTestBiome('meadow');s.setRate(0);});await wait(10000);
 const result=await page.evaluate(async()=>{
  const s=window.cosminova,p=s.exoSystem.get('exo:gliese-12-b').planet,scatter=p.surfaceScatter;
  const up=s.controls.walkLocal.clone(),east=up.clone().set(-up.z,0,up.x).normalize();
  const initialScatter=scatter.stats?.()??null;
  const times=[],updates=[],original=scatter.update.bind(scatter);let queries=0;
  const probe=p.groundHeightsKmAsync.bind(p);p.groundHeightsKmAsync=(...args)=>{const read=probe(...args);if(read)queries++;return read;};
  scatter.update=(...args)=>{const t=performance.now();original(...args);updates.push(performance.now()-t);};
  let frames=s.stats().renderedFrames,lastFrame=performance.now();const start=lastFrame,startFrames=frames;
  await new Promise(resolve=>{function tick(now){const elapsed=now-start;const metres=elapsed<10000?elapsed*.008:Math.max(0,(20000-elapsed)*.008);
   s.controls.walkLocal.copy(up).addScaledVector(east,metres/1000/p.radius).normalize();
   const f=s.stats().renderedFrames;if(f!==frames){times.push(now-lastFrame);lastFrame=now;frames=f;}
   if(elapsed>=20000)resolve();else requestAnimationFrame(tick);
  }requestAnimationFrame(tick);});
  const elapsed=performance.now()-start;scatter.update=original;p.groundHeightsKmAsync=probe;
  function quantile(a,q){a=[...a].sort((a,b)=>a-b);return a[Math.min(a.length-1,Math.floor(a.length*q))]??0;}
  const gl=s.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
  return {gpu:ext&&gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),viewport:[innerWidth,innerHeight],quality:s.stats().preset,scale:s.stats().renderScale,route:'80 metres out and back over 20 seconds; meadow; fixed noon',durationMs:elapsed,renderedFrames:frames-startFrames,fps:(frames-startFrames)*1000/elapsed,frameMs:{p50:quantile(times,.5),p95:quantile(times,.95),max:Math.max(...times)},scatterUpdateMs:{p50:quantile(updates,.5),p95:quantile(updates,.95),max:Math.max(...updates)},heightQueries:queries,initialScatter,scatter:scatter.stats?.()??null};
 });
 await page.screenshot({path:path.join(out,'meadow.png')});result.errors=errors;fs.writeFileSync(path.join(out,'benchmark.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(errors.length)throw new Error('Browser errors');
}finally{await browser.close();}
