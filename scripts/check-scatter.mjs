import assert from 'node:assert/strict';
import { Group, Vector3, Color } from 'three';
import { ScatterGeography, VISIBLE_KM } from '../src/engine/scatter-geography.js';
import { SurfaceScatter } from '../src/engine/surface-scatter.js';
const radius=5925,geo=new ScatterGeography(radius,42);
// Placement and ownership survive cube edges/poles and differing generation order.
for(const dir of [new Vector3(1,0,0),new Vector3(1,1,0).normalize(),new Vector3(1,1,1).normalize(),new Vector3(0,1,0)]) {
 const cells=geo.nearby(dir),ids=new Set();assert.ok(cells.length<=128);
 for(const c of cells)for(const r of geo.generate(c)) {
  assert.equal(geo.cellAt(r.dir).key,c.key);assert.ok(!ids.has(r.id));ids.add(r.id);
  assert.deepEqual(r,geo.generate(c).find(x=>x.id===r.id));
 }
 const east=new Vector3(0,0,1),north=new Vector3().crossVectors(dir,east).normalize();
 for(let a=0;a<64;a++) {
  const d=dir.clone().addScaledVector(east,Math.cos(a)*VISIBLE_KM/radius).addScaledVector(north,Math.sin(a)*VISIBLE_KM/radius).normalize();
  assert.ok(cells.some(c=>c.key===geo.cellAt(d).key),'Visible area must have prefetched cells at face edges');
 }
}
const uniform=value=>({value});let calls=0,hold=null;
const planet={radius,spin:new Group(),stencilRef:1,material:{uniforms:{uSurfaceSeed:uniform(42),uSunDir:uniform(new Vector3(1,0,0)),uSunColour:uniform(new Color('white')),uSunIntensity:uniform(1),uWaveTime:uniform(0),uHazeK:uniform(0),uSeaLevelKm:uniform(1.1)}},groundHeightsKmAsync(_renderer,dirs,options){
 assert.equal(options.pixelAngle,1e-9);assert.ok(options.owner);assert.ok(dirs.length<=64);calls++;
 const heights=Float32Array.from(dirs,d=>2+d.y*.01);return hold?new Promise(resolve=>hold.resolve=()=>resolve(heights)):Promise.resolve(heights);
}};
const scatter=new SurfaceScatter(planet),origin=new Vector3(1,0,0);
async function settle(dir){for(let i=0;i<150;i++){scatter.update({},dir.clone().multiplyScalar(radius+2.0017),2);await new Promise(r=>setImmediate(r));if(!scatter.pending&&scatter.stats().queued===0)break;}assert.equal(scatter.stats().queued,0);assert.ok(scatter.cache.size<=256);}
await settle(origin);const first=scatter.snapshot();assert.ok(first.length>0);
const initialCalls=calls,uploads=scatter.stats().uploads;
await settle(origin);assert.equal(calls,initialCalls);assert.equal(scatter.stats().uploads,uploads,'Stationary scenes must not regenerate or upload');
await settle(new Vector3(1,0,.3/radius).normalize());const awayCalls=calls;
await settle(origin);assert.equal(calls,awayCalls,'Returning to cached cells must not sample heights again');assert.deepEqual(scatter.snapshot(),first);
for(let i=1;i<=25;i++)await settle(new Vector3(1,0,i*1.0/radius).normalize());
assert.ok(scatter.stats().evictions>0);await settle(origin);assert.deepEqual(scatter.snapshot(),first,'Eviction/regeneration must reproduce exact world positions');
const before=scatter.stats().generated;hold={};scatter.update({},new Vector3(0,1,0).multiplyScalar(radius+2.0017),2);assert.ok(scatter.pending);scatter.dispose();hold.resolve();await new Promise(r=>setImmediate(r));assert.equal(scatter.stats().generated,before);assert.equal(scatter.cache.size,0,'Disposed queries cannot repopulate the world');
console.log(JSON.stringify({passed:true,initialObjects:first.length,queries:calls,evictions:scatter.stats().evictions,checks:['seed reproducibility','cube edges and poles','prefetch coverage','cache revisit without queries/uploads','bounded LRU eviction','exact regeneration after eviction','late async disposal']},null,2));
