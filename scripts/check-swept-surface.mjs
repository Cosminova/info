import assert from 'node:assert/strict';
import {sphereEntry} from '../src/engine/swept-surface.js';
const v=(x,y=0,z=0)=>({x,y,z});
assert.equal(sphereEntry(v(2),v(-2),1),.25);
assert.equal(sphereEntry(v(2,2),v(-2,2),1),null);
assert.equal(sphereEntry(v(0),v(2),1),null);
assert.equal(sphereEntry(v(2),v(2),1),null);
for(const radius of [.002,4,6371,70000])for(const scale of [2,20,500]){
 const a=v(radius*scale),b=v(-radius*scale),t=sphereEntry(a,b,radius);
 assert.ok(t>=0&&t<.5);
 assert.ok(Math.abs(a.x+(b.x-a.x)*t-radius)<radius*1e-8);
}
console.log('Swept collision: hits, misses, stationary, penetration and 12 scale/speed cases passed.');
