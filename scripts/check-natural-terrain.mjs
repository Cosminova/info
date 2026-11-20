import fs from 'node:fs';import assert from 'node:assert/strict';import puppeteer from 'puppeteer-core';
const out=process.env.OUT??'work/natural-validation';fs.mkdirSync(out,{recursive:true});
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--headless=new','--no-sandbox'],defaultViewport:{width:1280,height:800}});
const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 await page.goto('http://localhost:5179/?home=0');await page.waitForFunction('window.cosminova?.ready',{timeout:180000});
 await page.evaluate(()=>{const s=window.cosminova;s.setQuality('high');s.setUiVisible(false);s.setRate(0);s.visitTestBiome('alpine');});await wait(3500);
 const report=await page.evaluate(async()=>{
  const s=window.cosminova,p=s.exoSystem.get('exo:gliese-12-b').planet;
  const THREE=await import(performance.getEntriesByType('resource').map(r=>r.name).find(n=>/\/deps\/three\.js/.test(n)));
  const {TERRAIN_GLSL}=await import('/src/engine/terrain-glsl.js'),{TEST_WORLD_GLSL}=await import('/src/engine/test-world.js');
  const material=new THREE.ShaderMaterial({uniforms:{uRadius:{value:p.radius}},vertexShader:'void main(){gl_Position=vec4(position.xy,0.,1.);}',fragmentShader:`precision highp float;uniform float uRadius;${TERRAIN_GLSL}${TEST_WORLD_GLSL}
   void main(){float i=gl_FragCoord.x;vec3 p=vec3(sin(i*.37),cos(i*.61),sin(i*.73))*3.0;float e=.0001;
    vec4 a=testLandform(p,0.0);vec3 numeric=vec3(testLandform(p+vec3(e,0,0),0.0).x-testLandform(p-vec3(e,0,0),0.0).x,testLandform(p+vec3(0,e,0),0.0).x-testLandform(p-vec3(0,e,0),0.0).x,testLandform(p+vec3(0,0,e),0.0).x-testLandform(p-vec3(0,0,e),0.0).x)/(2.0*e);
    gl_FragColor=vec4(length(a.yzw-numeric),abs(a.x-testLandform(p,.02).x),length(testLandform(p,1.0).yzw),0.0);
   }`,depthTest:false,depthWrite:false});
  const target=new THREE.WebGLRenderTarget(64,1,{type:THREE.FloatType,depthBuffer:false});const scene=new THREE.Scene(),quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);scene.add(quad);
  const previous=s.renderer.getRenderTarget();s.renderer.setRenderTarget(target);s.renderer.render(scene,new THREE.Camera());const data=new Float32Array(256);s.renderer.readRenderTargetPixels(target,0,0,64,1,data);s.renderer.setRenderTarget(previous);target.dispose();quad.geometry.dispose();material.dispose();
  return {rocksVisible:p.surfaceScatter.rocks.visible,gradientMaxError:Math.max(...Array.from({length:64},(_,i)=>data[i*4])),lodHeightMaxChange:Math.max(...Array.from({length:64},(_,i)=>data[i*4+1])),unresolvedSlopeMax:Math.max(...Array.from({length:64},(_,i)=>data[i*4+2])),glError:s.renderer.getContext().getError()};
 });
 console.log(JSON.stringify(report));
 assert.equal(report.rocksVisible,false);assert.equal(report.glError,0);assert.ok(report.gradientMaxError<.04);assert.ok(report.lodHeightMaxChange<.000002,'Canonical height must remain unchanged within GPU float roundoff');assert.equal(report.unresolvedSlopeMax,0);
 await page.screenshot({path:out+'/alpine-ground.png'});
 await page.evaluate(()=>{const c=window.cosminova.controls;c.walkEyeKm=5;c.walkPitch=-.25;});await wait(1500);await page.screenshot({path:out+'/alpine-landscape.png'});
 await page.evaluate(()=>{const s=window.cosminova;s.controls.stopWalk();s.controls.mode='orbit';s.lookFromSun('exo:gliese-12-b',3.5,55,15);});await wait(2500);await page.screenshot({path:out+'/gliese-orbit.png'});
 await page.evaluate(()=>{window.cosminova.exoSystem.get('exo:gliese-12-b').planet.cloudVolume.visible=false;});await wait(500);await page.screenshot({path:out+'/gliese-orbit-clear.png'});
 report.errors=errors;fs.writeFileSync(out+'/validation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));assert.deepEqual(errors,[]);
}finally{await browser.close();}
