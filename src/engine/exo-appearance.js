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
    const c=rgb.map(x=>mean+(x-mean)*.72);
    // Avoid violet mineral colours while retaining ochre, basalt and blue-grey.
    if(c[0]>c[1]*1.2&&c[2]>c[1]*1.2)c[1]=(c[0]+c[2])*.48;
    return c;
  });
}

// Distinct geological/weather families, with continuous variation inside each.
// These augment the existing seeded province generator rather than replacing it.
export function exoCharacter(name, d) {
  const r=rng(hashName(`${name}:character-v1`));
  const pick=a=>a[Math.floor(r()*a.length)];
  const size=clamp(d.radiusKm/6371,.35,1.8);
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
    return {kind:weather,palette:pick(palettes),mountains:[0,1,0],
      weather:[['banded','stormy','hazy','turbulent'].indexOf(weather)+1,weather==='hazy'?1.2:2.8+r()*1.8,.18+r()*.16, r()*6.283],
      banding:weather==='banded'?3+r()*3:weather==='hazy'?.35+r()*.4:.8+r()*1.4};
  }
  let choices=d.oceanLevel>0?['alpine','archipelago','rifted']:['alpine','rifted','volcanic','cratered'];
  if(d.temperatureK<230)choices=[...choices,'glacial'];
  if(d.temperatureK>700)choices=['volcanic','rifted','cratered'];
  const kind=pick(choices), mountains={alpine:[7,150],archipelago:[3,95],rifted:[3.5,85],volcanic:[1.4,55],cratered:[.65,45],glacial:[4,120]}[kind];
  const palettes={
    alpine:[[.40,.34,.25],[.12,.19,.14],[.51,.49,.43],[.79,.82,.82]],
    archipelago:[[.48,.39,.25],[.10,.23,.18],[.60,.56,.42],[.8,.83,.81]],
    rifted:[[.47,.26,.14],[.18,.14,.12],[.65,.47,.29],[.76,.73,.66]],
    volcanic:[[.19,.19,.18],[.045,.05,.055],[.36,.27,.18],[.56,.56,.53]],
    cratered:[[.39,.35,.29],[.20,.20,.20],[.57,.52,.43],[.7,.71,.7]],
    glacial:[[.56,.67,.70],[.20,.30,.35],[.72,.77,.76],[.87,.90,.90]],
  };
  return {kind,palette:palettes[kind].map(c=>c.map(v=>v*(.88+r()*.2))),
    mountains:[mountains[0]*size*(.8+r()*.4),mountains[1]*(.8+r()*.4),0],weather:[0,0,0,0],
    oceanFraction:d.oceanLevel>0?(kind==='archipelago'?.76+r()*.16:.25+r()*.35):0,
    // Separate seed keeps weather choices from reshuffling the geography.
    cloudCover:d.volatiles==='airless'||rng(hashName(`${name}:clouds-v1`))()<.4?0:kind==='volcanic'?.10:kind==='archipelago'?.28:.08+rng(hashName(`${name}:cloud-density-v1`))()*.24,
    craterFactor:kind==='cratered'?1.7:.2,
    geology:kind==='rifted'?{rift:{coverage:.35,frequency:2.5+r()*2,depth:8*size,width:.04+r()*.035}}:
      kind==='volcanic'?{volcano:{coverage:.38,frequency:4+r()*3,height:16*size,density:.55},flood:{coverage:.28,fill:.7,wrinkle:.035,softness:.25}}:
      kind==='archipelago'?{volcano:{coverage:.22,frequency:7,height:7*size,density:.6}}:{},
  };
}
