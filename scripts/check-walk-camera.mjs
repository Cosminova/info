import assert from 'node:assert/strict';
import {smoothWalkHeight} from '../src/engine/walk-camera-height.js';
const eye=.0017,dt=1/60;
let h=eye,raw=[],filtered=[];
for(let i=0;i<600;i++){
 const floor=.00025*Math.sin(i*dt*2*Math.PI*3);
 h=smoothWalkHeight(h,floor,eye,dt);
 assert.ok(h-floor>=.001-1e-12);
 if(i>60){raw.push(floor+eye);filtered.push(h);}
}
const range=a=>(Math.max(...a)-Math.min(...a))*1000;
assert.ok(range(filtered)<range(raw)*.3,'Reduce small rapid vertical oscillation');
for(const floor of [1,1.1,.9,2,0]){h=smoothWalkHeight(h,floor,eye,dt);assert.ok(h>=floor+.001);}
assert.equal(smoothWalkHeight(NaN,2,eye,dt),2+eye);
assert.equal(smoothWalkHeight(0,2,.1,dt),2.1);
// Exponential response should be independent of frame rate on a constant floor.
function settle(hz){let y=eye;for(let i=0;i<hz;i++)y=smoothWalkHeight(y,.0004,eye,1/hz);return y;}
assert.ok(Math.abs(settle(30)-settle(120))<1e-12);
console.log(JSON.stringify({rawPeakToPeakM:range(raw),smoothedPeakToPeakM:range(filtered),minimumSupportClearanceM:1}));
