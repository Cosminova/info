import fs from 'node:fs';import assert from 'node:assert/strict';
import {describePlanet} from '../src/engine/classify.js';
import {exoAppearance,naturalPalette} from '../src/engine/exo-appearance.js';
const catalog=JSON.parse(fs.readFileSync('public/data/exoplanets.json'));let count=0,rocky=0,gas=0,wet=0;const profiles=new Set();
for(const system of catalog.systems)for(const entry of system.planets){
 const described=describePlanet(entry,{starTeff:system.teff,aAu:entry.aAu});const a=exoAppearance(entry.name,described);
 assert.deepEqual(a,exoAppearance(entry.name,described));for(const v of Object.values(a))assert.ok(Number.isFinite(v));
 assert.ok(a.continentScale>=.75&&a.continentScale<=3.65);assert.ok(a.oceanFraction>=0&&a.oceanFraction<=.97);
 if(described.gaseous){gas++;assert.equal(a.oceanFraction,0);}else rocky++;
 if(!described.oceanLevel)assert.equal(a.oceanFraction,0);
 if(a.oceanFraction>0)wet++;profiles.add(JSON.stringify(a));count++;
}
assert.equal(profiles.size,count,'Named planets must not reuse a geography profile');
assert.ok(naturalPalette([[.5,.1,.5]])[0][1]>.3);
console.log(JSON.stringify({count,rocky,gas,wet,uniqueProfiles:profiles.size}));
