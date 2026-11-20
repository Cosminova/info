import { hashName, rng } from './classify.js';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
// Stable artistic geography, separate from measured catalogue quantities.
// No per-frame randomness and no need to allocate terrain for unvisited worlds.
export function exoAppearance(name, described) {
  const r=rng(hashName(`${name}:appearance-v1`));
  const ocean=described.oceanLevel??0;
  return {
    continentScale: .75+r()*2.9,
    relief: .55+r()*1.15,
    rangeScale: .65+r()*1.4,
    oceanFraction: described.gaseous||ocean===0 ? 0 : clamp(ocean+(r()-.5)*.18,.06,.97),
    cloudScale: 4+r()*5,
    bandScale: .7+r()*1.4,
  };
}
export function naturalPalette(palette) {
  return palette?.map(rgb=>{
    const mean=rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
    const c=rgb.map(x=>mean+(x-mean)*.92);
    // Avoid violet mineral colours while retaining ochre, basalt and blue-grey.
    if(c[0]>c[1]*1.2&&c[2]>c[1]*1.2)c[1]=(c[0]+c[2])*.48;
    return c;
  });
}

// Independent mineral chemistry and weathering give each name a continuous
// palette, rather than assigning every member of a family the same colours.
function mineralPalette(name, base, mixing=1) {
  const r=rng(hashName(`${name}:minerals-v1`));
  const minerals=[[.57,.48,.34],[.34,.39,.42],[.53,.29,.16],[.22,.24,.23],[.73,.70,.61],[.36,.43,.39]];
  const a=minerals[Math.floor(r()*minerals.length)], b=minerals[Math.floor(r()*minerals.length)];
  const blend=r(), strength=(.12+r()*.4)*mixing, brightness=.7+r()*.5;
  return naturalPalette(base.map((c,i)=>c.map((v,j)=>{
    const tone=(a[j]*(1-blend)+b[j]*blend)*[1,.45,1.25,1.6][i];
    return clamp((v*(1-strength)+tone*strength)*brightness,.015,.95);
  })));
}

// Distinct geological/weather families, with continuous variation inside each.
// These augment the existing seeded province generator rather than replacing it.
export function exoCharacter(name, d) {
  const r=rng(hashName(`${name}:character-v1`));
  const pick=a=>a[Math.floor(r()*a.length)];
  const size=clamp(d.radiusKm/6371,.00005,1.8);
  if(d.gaseous){
    const weather=pick(['banded','stormy','hazy','turbulent']);
    const palettes=d.temperatureK>700 ? [
      [[.52,.29,.12],[.13,.075,.045],[.8,.56,.25],[.75,.69,.55]],
      [[.45,.38,.30],[.11,.13,.15],[.71,.58,.4],[.8,.77,.7]],
    ] : [
      [[.68,.55,.37],[.20,.105,.055],[.85,.77,.61],[.72,.71,.66]],
      [[.19,.36,.49],[.035,.095,.18],[.52,.69,.75],[.67,.76,.8]],
      [[.34,.52,.49],[.08,.19,.21],[.72,.77,.65],[.75,.8,.78]],
      [[.59,.46,.27],[.22,.18,.13],[.87,.78,.55],[.73,.71,.65]],
    ];
    return {kind:weather,palette:mineralPalette(name,pick(palettes),.35),mountains:[0,1,0],
      weather:[['banded','stormy','hazy','turbulent'].indexOf(weather)+1,weather==='hazy'?1.2:2.8+r()*1.8,.18+r()*.16, r()*6.283],
      banding:weather==='banded'?3+r()*3:weather==='hazy'?.35+r()*.4:.8+r()*1.4};
  }
  const kind=pickWeighted(r, rockyChoices(d));
  const family=ROCKY[kind];
  const wet=d.oceanLevel>0&&(family.ocean>0||rng(hashName(`${name}:wet-v2`))()<.2);
  return {kind,palette:mineralPalette(name,family.palette,family.mixing??1),
    mountains:[family.range[0]*size*(.35+r()*1.65),family.range[1]*(.4+r()*1.8),family.style],weather:[0,0,0,0],
    oceanFraction:wet?(family.ocean>0?family.ocean+r()*.2:.15+r()*.35):0,
    sea:family.sea,
    terrace:family.terrace?family.terrace*(.6+r()*.6):undefined,
    iceLatitude:family.ice,
    ...cloudRegime(name,d),
    craterFactor:(family.craters??.15)*(.6+r()*.9),
    geology:family.geology?.(r,size)??{},
  };
}

function pickWeighted(r, weights) {
  const entries=Object.entries(weights).filter(([,w])=>w>0);
  let roll=r()*entries.reduce((s,[,w])=>s+w,0);
  for(const [k,w] of entries){roll-=w;if(roll<=0)return k;}
  return entries[entries.length-1][0];
}

/**
 * Rocky families and how likely each is at a given temperature and wetness.
 * Earth-like ground is one family among many, and the rarest of them.
 */
function rockyChoices(d) {
  const t=d.temperatureK??288, wet=(d.oceanLevel??0)>0;
  if(t>700)return {volcanic:3,sulfur:2,carbon:1.5,iron:1.5,cratered:1,desert:1};
  if(t>380)return {desert:2.5,sulfur:1.5,iron:2,volcanic:1.5,salt:1,mesa:1.5,carbon:1,cratered:1};
  if(t<230)return {glacial:1.4,salt:1,cratered:1.5,iron:1,rifted:1,mesa:.6,carbon:.6};
  return wet
    ? {alpine:.7,archipelago:1,oceanic:1.1,verdant:.8,rifted:1,desert:.8,mesa:.8,iron:.8,volcanic:.6,salt:.4}
    : {rifted:1.4,desert:2,mesa:1.5,iron:1.6,volcanic:1,cratered:1.2,salt:.8,carbon:.6,alpine:.3};
}

// style is the surface shader's material pattern; range is mountain height per
// Earth radius and their frequency.
const ROCKY={
  alpine:{style:1,range:[7,150],palette:[[.40,.34,.25],[.12,.19,.14],[.51,.49,.43],[.79,.82,.82]]},
  archipelago:{style:2,range:[3,95],ocean:.65,palette:[[.48,.39,.25],[.10,.23,.18],[.60,.56,.42],[.8,.83,.81]],
    geology:(r,size)=>({volcano:{coverage:.22,frequency:7,height:7*size,density:.6}})},
  oceanic:{style:2,range:[2,70],ocean:.86,palette:[[.62,.56,.42],[.30,.34,.26],[.74,.70,.58],[.86,.88,.88]],
    sea:{deep:[.004,.03,.07],shallow:[.03,.19,.22]}},
  verdant:{style:1,range:[5,120],ocean:.45,mixing:.4,palette:[[.30,.18,.30],[.10,.20,.16],[.46,.36,.22],[.80,.80,.78]],
    sea:{deep:[.02,.045,.05],shallow:[.08,.17,.12]}},
  rifted:{style:3,range:[3.5,85],terrace:.25,palette:[[.47,.26,.14],[.18,.14,.12],[.65,.47,.29],[.76,.73,.66]],
    geology:(r,size)=>({rift:{coverage:.35,frequency:1.2+r()*5,depth:(3+r()*10)*size,width:.04+r()*.035}})},
  desert:{style:6,range:[2.2,60],craters:.25,palette:[[.78,.55,.30],[.55,.34,.17],[.88,.72,.48],[.86,.80,.70]],
    geology:(r,size)=>({rift:{coverage:.12,frequency:2+r()*3,depth:(2+r()*5)*size,width:.03+r()*.03}})},
  mesa:{style:3,range:[2.6,70],terrace:.42,palette:[[.62,.34,.20],[.34,.18,.12],[.80,.58,.40],[.74,.68,.60]],
    geology:(r,size)=>({rift:{coverage:.25,frequency:3+r()*4,depth:(3+r()*6)*size,width:.05+r()*.04}})},
  iron:{style:3,range:[4,90],craters:.4,palette:[[.52,.22,.12],[.26,.11,.07],[.70,.40,.24],[.80,.74,.70]],
    geology:(r,size)=>({rift:{coverage:.18,frequency:2+r()*3,depth:(4+r()*8)*size,width:.05},volcano:{coverage:.12,frequency:4,height:(8+r()*16)*size,density:.3}})},
  volcanic:{style:4,range:[1.4,55],palette:[[.19,.19,.18],[.045,.05,.055],[.36,.27,.18],[.56,.56,.53]],
    geology:(r,size)=>({volcano:{coverage:.38,frequency:4+r()*3,height:(5+r()*14)*size,density:.2+r()*.5},flood:{coverage:.28,fill:.7,wrinkle:.035,softness:.25}})},
  sulfur:{style:4,range:[1.2,50],mixing:.35,palette:[[.78,.68,.22],[.42,.30,.10],[.88,.80,.48],[.92,.90,.78]],
    geology:(r,size)=>({volcano:{coverage:.45,frequency:6+r()*3,height:(3+r()*6)*size,density:.45},flood:{coverage:.6,fill:.85,wrinkle:.04,softness:.3}})},
  carbon:{style:4,range:[3,80],mixing:.5,palette:[[.12,.10,.09],[.05,.045,.04],[.24,.20,.16],[.40,.38,.36]]},
  salt:{style:6,range:[1.5,40],mixing:.45,palette:[[.86,.82,.78],[.66,.56,.56],[.94,.90,.86],[.97,.96,.95]],
    geology:(r,size)=>({flood:{coverage:.5,fill:.9,wrinkle:.02,softness:.4}})},
  cratered:{style:5,range:[.65,45],craters:1.3,palette:[[.39,.35,.29],[.20,.20,.20],[.57,.52,.43],[.7,.71,.7]]},
  glacial:{style:6,range:[4,120],ice:.45,palette:[[.56,.67,.70],[.20,.30,.35],[.72,.77,.76],[.87,.90,.90]],
    geology:(r,size)=>({rift:{coverage:.2,frequency:3+r()*4,depth:(2+r()*4)*size,width:.03}})},
};

/**
 * How much cloud a world has and how large its weather is: none at all, a few
 * fair-weather clouds, broken cloud, great storm systems, or a closed deck.
 */
function cloudRegime(name, d) {
  if(d.volatiles==='airless')return {cloudCover:0,cloudScale:3};
  const r=rng(hashName(`${name}:clouds-v3`));
  const roll=r();
  if(roll<.3)return {cloudCover:0,cloudScale:3};
  if(roll<.52)return {cloudCover:.14+r()*.12,cloudScale:5+r()*4};
  if(roll<.74)return {cloudCover:.42+r()*.16,cloudScale:2.6+r()*3};
  if(roll<.91)return {cloudCover:.62+r()*.16,cloudScale:1.1+r()*1.3};
  return {cloudCover:.93+r()*.05,cloudScale:1.4+r()*2};
}
