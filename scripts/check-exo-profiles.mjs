import fs from 'node:fs';import assert from 'node:assert/strict';
import {describePlanet} from '../src/engine/classify.js';
import {exoAppearance,exoCharacter,naturalPalette} from '../src/engine/exo-appearance.js';
const characters={};let clearAtmospheres=0,cloudyAtmospheres=0;
const catalog=JSON.parse(fs.readFileSync('public/data/exoplanets.json'));let count=0,rocky=0,gas=0,wet=0;const profiles=new Set();
for(const system of catalog.systems)for(const entry of system.planets){
 const described=describePlanet(entry,{starTeff:system.teff,aAu:entry.aAu});const a=exoAppearance(entry.name,described);
 const character=exoCharacter(entry.name,described);
 assert.deepEqual(character,exoCharacter(entry.name,described));
 if(!described.gaseous&&described.volatiles!=='airless'){if(character.cloudCover===0)clearAtmospheres++;else cloudyAtmospheres++;}
 const family=(described.gaseous?'gas:':'rock:')+character.kind;characters[family]=(characters[family]??0)+1;
 if(described.gaseous){assert.equal(character.mountains[0],0);assert.ok(character.weather[0]>0);}
 else {assert.ok(character.mountains[0]>.1);assert.ok(character.mountains[1]>0);}
 assert.deepEqual(a,exoAppearance(entry.name,described));for(const v of Object.values(a))assert.ok(Number.isFinite(v));
 assert.ok(a.continentScale>=.75&&a.continentScale<=3.65);assert.ok(a.oceanFraction>=0&&a.oceanFraction<=.97);
 if(described.gaseous){gas++;assert.equal(a.oceanFraction,0);}else rocky++;
 if(!described.oceanLevel)assert.equal(a.oceanFraction,0);
 if(a.oceanFraction>0)wet++;profiles.add(JSON.stringify(a));count++;
}
assert.equal(profiles.size,count,'Named planets must not reuse a geography profile');
assert.ok(naturalPalette([[.5,.1,.5]])[0][1]>.3);
assert.ok(clearAtmospheres>100&&cloudyAtmospheres>100,'Atmospheric rocky worlds need both clear and cloudy skies');
console.log(JSON.stringify({clearAtmospheres,cloudyAtmospheres,count,rocky,gas,wet,uniqueProfiles:profiles.size,characters}));
