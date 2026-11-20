import assert from 'node:assert/strict';
import {Vector3 as V} from 'three';
import {lensTransmission} from '../src/engine/star.js';
const eye=new V(),star=new V(0,0,1000);
assert.equal(lensTransmission(eye,star,10,new V(0,0,100),5),0,'Foreground planet must extinguish the whole lens flare');
assert.equal(lensTransmission(eye,star,10,new V(30,0,100),5),1);
assert.equal(lensTransmission(eye,star,10,new V(0,0,2000),5),1);
assert.equal(lensTransmission(eye,star,10,new V(0,0,-100),5),1);
const partial=lensTransmission(eye,star,10,new V(5,0,100),5);assert.ok(partial>0&&partial<1);
const annular=lensTransmission(eye,star,10,new V(0,0,100),.5);assert.ok(annular>.74&&annular<.76);
let last=0;for(let x=0;x<8;x+=.02){const transmission=lensTransmission(eye,star,10,new V(x,0,100),5);assert.ok(Number.isFinite(transmission)&&transmission>=last-1e-8);last=transmission;}
console.log('PASS: full/partial/annular eclipses, unobscured/behind-source cases, continuous limb transition');
