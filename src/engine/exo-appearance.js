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
