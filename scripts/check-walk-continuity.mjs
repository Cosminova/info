import assert from 'node:assert/strict';
import {Vector3} from 'three';
import {WalkSupport} from '../src/engine/walk-support.js';
// A known tilted plane crossing many mesh cells. A correct collision floor is
// continuous even across the triangle diagonal; a neighbourhood maximum isn't.
const radius=6000, sea=-100;
const support=new WalkSupport({radius,material:{uniforms:{uSeaLevelKm:{value:sea}}}},{});
const o=new Vector3(-.00004,-.00004,1),r=new Vector3(.00008,0,0),u=new Vector3(0,.00008,0);
for (const morph of [0, .5, 1]) {
const tile={o,r,u,n:7,loX:0,loY:0,dirs:[],heights:[]};
for(let y=0;y<8;y++)for(let x=0;x<8;x++){
 const wx=x+(Math.floor(x*.5+.5)*2-x)*morph;
 const wy=y+(Math.floor(y*.5+.5)*2-y)*morph;
 const d=o.clone().addScaledVector(r,wx/7).addScaledVector(u,wy/7).normalize();
 tile.dirs.push(d);tile.heights.push((radius+2)/(d.z-.2*d.x)-radius);
}
let maxError=0,maxJump=0,last=null;
for(let i=0;i<1000;i++){
 const d=o.clone().addScaledVector(r,(1.05+4.8*i/999)/7).addScaledVector(u,3.2/7).normalize();
 const expected=(radius+2)/(d.z-.2*d.x)-radius;
 const h=support.height(tile,d);assert.ok(Number.isFinite(h));
 const excess=(h-expected)*1000;maxError=Math.max(maxError,Math.abs(excess));
 if(last!==null)maxJump=Math.max(maxJump,Math.abs(excess-last));last=excess;
}
console.log(JSON.stringify({morph,maxFloorOffsetM:maxError,maxOffsetJumpM:maxJump}));
assert.ok(maxError<.61,'floor must remain within the 60 cm safety margin');
assert.ok(maxJump<.001,'floor must not step at vertex-cell boundaries');

}
