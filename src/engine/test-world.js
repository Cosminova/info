// Deliberately fictional art/renderer test preset. Catalogue measurements stay
// intact; these sites are not observations of the real Gliese 12 b.
export const TEST_SITES = [
  { id: 'coast', name: 'Turquoise coast', lat: 12, lon: 0 },
  { id: 'meadow', name: 'Living highlands', lat: 32, lon: 65 },
  { id: 'desert', name: 'Ochre desert', lat: -18, lon: 120 },
  { id: 'alpine', name: 'Alpine ranges', lat: 58, lon: -35 },
  { id: 'ice', name: 'Polar ice / aurora', lat: 78, lon: 45 },
  { id: 'volcano', name: 'Volcanic caldera', lat: -12, lon: -85 },
  { id: 'wetland', name: 'Tidal wetlands', lat: -35, lon: -15 },
];
export function siteDirection(site) {
  const lat = site.lat * Math.PI / 180, lon = site.lon * Math.PI / 180;
  return [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
}
const centers = TEST_SITES.map(s => `vec3(${siteDirection(s).map(v => v.toFixed(9)).join(',')})`).join(',\n');
export const TEST_WORLD_GLSL = /* glsl */ `
  uniform float uTestWorld;
  float gLandFiltered = 0.0;
  float gTestFilteredHeight = 0.0;
  const vec3 testSites[7] = vec3[7](${centers});
  float testRegion(vec3 d, int i) { return smoothstep(0.997, 0.9995, dot(d, testSites[i])); }
  // Gradient (Perlin) noise avoids the flat cell centres of value noise.
  // Different gradient directions and rotated octave coordinates break lattice
  // alignment. Value and derivative are evaluated from the same polynomial.
  vec4 landNoiseWithCurvature(vec3 p, out mat3 curvature) {
    ivec3 cell=ivec3(floor(p));vec3 f=fract(p);
    vec3 w=f*f*f*(f*(f*6.0-15.0)+10.0);
    vec3 dw=30.0*f*f*(f*(f-2.0)+1.0);
    vec4 result=vec4(0.0);curvature=mat3(0.0);
    vec3 ddw=60.0*f*(2.0*f*f-3.0*f+1.0);
    for(int z=0;z<2;z++)for(int y=0;y<2;y++)for(int x=0;x<2;x++){
      ivec3 corner=ivec3(x,y,z);uint bits=pcg3d(uvec3(cell+corner)).x;
      vec3 g=vec3((bits&1u)==0u?-1.0:1.0,(bits&2u)==0u?-1.0:1.0,(bits&4u)==0u?-1.0:1.0);
      g[int((bits>>3u)%3u)]=0.0;g*=0.70710678;
      vec3 c=vec3(corner),blend=mix(1.0-w,w,c),db=dw*(c*2.0-1.0);
      float v=dot(g,f-c),weight=blend.x*blend.y*blend.z;
      result.x+=v*weight;
      vec3 gradWeight=vec3(db.x*blend.y*blend.z,blend.x*db.y*blend.z,blend.x*blend.y*db.z);
      result.yzw+=g*weight+v*gradWeight;
      vec3 dd=ddw*(c*2.0-1.0);
      mat3 h=mat3(dd.x*blend.y*blend.z,db.x*db.y*blend.z,db.x*blend.y*db.z,
        db.x*db.y*blend.z,blend.x*dd.y*blend.z,blend.x*db.y*db.z,
        db.x*blend.y*db.z,blend.x*db.y*db.z,blend.x*blend.y*dd.z);
      curvature+=outerProduct(g,gradWeight)+outerProduct(gradWeight,g)+v*h;
    }
    curvature*=1.7;return result*1.7;
  }
  vec4 landNoise(vec3 p){mat3 unused;return landNoiseWithCurvature(p,unused);}
  // Hybrid multifractal: low-frequency uplift controls how much detail survives.
  // A smooth coordinate warp bends ranges without a straight artificial trench.
  // This is a deterministic geological approximation, not a water simulation.
  vec4 testLandform(vec3 p, float footprint) {
    // Bend fine detail along the coarse field's gradient, in the spirit of
    // procedural erosion. Carry the warp Jacobian (including curvature) so
    // lighting stays the derivative of the displaced geometry.
    mat3 curvature;
    vec4 base=landNoiseWithCurvature(p+3.7,curvature);
    vec3 q=p-.65*base.x*base.yzw;
    mat3 jacobian=mat3(1.0)-.65*(outerProduct(base.yzw,base.yzw)+base.x*curvature);
    mat3 rot=mat3(.00,.80,.60,-.80,.36,-.48,-.60,-.48,.64);
    mat3 transform=mat3(1.0);
    vec3 baseGradient=base.yzw;
    float r=clamp((base.x+.35)/.9,0.0,1.0);
    float rough=.22+.78*r*r*(3.0-2.0*r);
    vec3 roughGradient=baseGradient*(.78*6.0*r*(1.0-r)/.9);
    vec4 sum=vec4(.34+.64*base.x,baseGradient*.64);
    float baseFilter=1.0-smoothstep(.18,.65,footprint);
    float filteredHeight=.34+.64*base.x*baseFilter;
    float freq=1.0,amp=.32;
    for(int i=1;i<4;i++){
      freq*=2.13;transform=rot*transform;
      vec4 n=landNoise(transform*q*freq+float(i)*17.13);
      vec3 gradient=transpose(jacobian)*transpose(transform)*n.yzw*freq;
      // Tributary ridges occur only in the finer bands, supported by the
      // broad massif. The smooth crest avoids a discontinuous normal.
      if(i>=2){float rounded=sqrt(n.x*n.x+.008);gradient*=-n.x/rounded;n.x=.38-rounded;}
      float filtered=1.0-smoothstep(.18,.65,footprint*freq);
      sum.x+=amp*n.x*rough;
      filteredHeight+=amp*n.x*rough*filtered*baseFilter;
      sum.yzw+=amp*(gradient*rough+n.x*roughGradient)*filtered;
      amp*=.46;
    }
    // Height remains independent of camera/LOD; only unresolved shading fades.
    sum.yzw*=1.0-smoothstep(.18,.65,footprint);
    gLandFiltered=.5*(filteredHeight+sqrt(filteredHeight*filteredHeight+.0025));
    float rounded=sqrt(sum.x*sum.x+.0025);
    return vec4(.5*(sum.x+rounded),sum.yzw*.5*(1.0+sum.x/rounded));
  }
  vec4 testTerrain(vec3 d, float pixelAngle) {
    // Interior sites need only their own field. Avoid evaluating continent,
    // crags and distant ridges for every vertex and fragment in a meadow.
    vec4 hill = fbmd(d * 190.0 + 6.1, 3, 2.07, 0.34);
    vec4 t = vec4(0.0);
    float shadeHeight=0.0;
    bool interior = false;
    for(int j=0;j<7;j++) if(dot(d,testSites[j])>=0.9995) interior=true;
    if(!interior) {
    vec4 continent = fbmd(d * 2.8 + 17.3, 7, 2.03, 0.47);
    vec4 ridge = testLandform(d * 180.0 + 3.7, pixelAngle * 180.0);
    float filteredRidge=gLandFiltered;
    float mountain = smoothstep(0.02, 0.32, continent.x);
    float mq = clamp((continent.x - 0.02) / 0.30, 0.0, 1.0);
    float mountainDerivative = 6.0 * mq * (1.0 - mq) / 0.30;
    t = vec4(1.4 + continent.x * 9.0 + ridge.x * ridge.x * mountain * 8.0 + hill.x * 0.22,
      continent.yzw * (25.2 + ridge.x * ridge.x * 22.4 * mountainDerivative) + ridge.yzw * (2880.0 * ridge.x * mountain) + hill.yzw * 41.8);
    float filteredContinent=fbmd(d*2.8+17.3,int(clamp(log2(.35/max(pixelAngle*2.8,1e-8)),2.0,7.0)),2.03,.47).x;
    shadeHeight=1.4+filteredContinent*9.0+filteredRidge*filteredRidge*mountain*8.0
      +hill.x*.22*(1.0-smoothstep(.0001,.001,pixelAngle));
    // Bounded crag amplitude; fine grain belongs in the material, not spiky mesh noise.
    // Metre-scale materials are filtered separately. Keep the geological
    // height field fixed so approaching a site cannot move its rock foundations.
    vec4 crag = fbmd(d * 1600.0 + 41.0, 3, 2.03, 0.32);
    t += vec4(crag.x * 0.008, crag.yzw * 12.8 * (1.0-smoothstep(.00004,.0003,pixelAngle)));
    }
    for (int i = 0; i < 7; i++) {
      float dotSite = dot(d, testSites[i]);
      float w = testRegion(d, i);
      if (w < 0.001) continue;
      float h = 1.6 + hill.x * 0.15;
      float filteredH=-1.0;
      vec3 slope = hill.yzw * 28.5;
      if (i == 0) { vec3 east = normalize(cross(vec3(0,1,0), testSites[i])); h = 1.13 + clamp(dot(d, east) * 450.0,-0.7,0.7) + hill.x * 0.005; slope = east * (abs(dot(d,east)*450.0)<0.7?450.0:0.0) + hill.yzw * 0.95; }
      if (i == 1 || i == 2 || i == 3) {
        // Broad uplifted ranges, foothills and quiet floors. Each region has
        // a different seed offset and relief; no repeated straight valley mask.
        float frequency = i == 2 ? 120.0 : 180.0;
        vec4 massif = testLandform(d*frequency + float(i)*31.7, pixelAngle*frequency);
        float relief = i == 3 ? 8.5 : i == 1 ? 5.0 : 3.5;
        float base = i == 3 ? 2.2 : i == 1 ? 1.5 : 1.7;
        h = base + massif.x*massif.x*relief + hill.x*.08;
        filteredH=base+gLandFiltered*gLandFiltered*relief+hill.x*.08;
        slope = massif.yzw*(2.0*massif.x*relief*frequency) + hill.yzw*15.2;
      }
      if (i == 4) { vec4 ridge = ridgedd(d * 38.0 + 3.7, 6); h = 2.8 + ridge.x * 0.45; slope = ridge.yzw * 17.1; }
      if (i == 5) {
        float r = max(length(d - testSites[i]) * uRadius, 0.001);
        float cone = 3.6 * exp(-r / 13.0), bowl = 2.1 * exp(-r*r / 7.0);
        h = 1.6 + cone - bowl + hill.x * 0.025;
        vec3 dr = (d - testSites[i]) / r * uRadius * uRadius;
        slope = dr * (-cone / 13.0 + bowl * r * 2.0 / 7.0) + hill.yzw * 4.75;
      }
      if (i == 6) { h = 1.12 + hill.x * 0.11; slope = hill.yzw * 20.9; }
      if(filteredH<0.0)filteredH=h;
      shadeHeight=mix(shadeHeight,filteredH,w);
      float q = clamp((dotSite - 0.997) / 0.0025, 0.0, 1.0);
      vec3 dw = testSites[i] * 6.0 * q * (1.0 - q) / 0.0025;
      t = vec4(mix(t.x, h, w), mix(t.yzw, slope, w) + (h - t.x) * dw);
    }
    gTestFilteredHeight=shadeHeight;
    return t;
  }
  vec3 testBiomeColour(vec3 d, float height, float steep, float pixelAngle) {
    int colourOctaves=pixelAngle<.000015?3:int(clamp(log2(.4/max(pixelAngle*7.0,1e-8)),2.0,7.0));
    float moisture;
    if(pixelAngle<.000015)moisture=fbmd(d*7.0+19.0,3,2.1,.5).x;
    else moisture=fbmd(d*7.0+19.0,colourOctaves,2.1,.5).x;
    float weathering=moisture*.5;
    if(pixelAngle>=.000015)weathering=fbmd(d*34.0+vec3(moisture*3.0,-moisture*.8,moisture*1.5)+11.2,int(clamp(log2(.4/max(pixelAngle*34.0,1e-8)),1.0,6.0)),2.07,.62).x;
    float cold = smoothstep(0.55, 0.9, abs(d.y));
    vec3 green = mix(vec3(0.065,0.105,0.078), vec3(0.18,0.205,0.14), smoothstep(-0.2,0.25,moisture));
    vec3 sand = vec3(0.38,0.31,0.235), stone = vec3(0.24,0.26,0.28);
    vec3 c = mix(sand, green, smoothstep(-0.3,0.3,moisture));
    c = mix(c, vec3(0.27,0.25,0.15), cold);
    c = mix(c, vec3(0.67,0.72,0.73), smoothstep(0.82,0.96,abs(d.y)));
    c = mix(c, vec3(0.61,0.48,0.29), 1.0-smoothstep(0.002,0.012,abs(height-1.1)));
    c = mix(c, green, testRegion(d,1));
    c = mix(c, sand, testRegion(d,2));
    float beds = smoothstep(-.3,.3,moisture);
    vec3 alpineRock = mix(vec3(0.27,0.29,0.31),vec3(0.49,0.50,0.47),
      beds * 0.22 + smoothstep(0.04,0.25,moisture) * 0.18);
    c = mix(c, alpineRock, testRegion(d,3));
    c = mix(c, vec3(0.71,0.77,0.79), testRegion(d,4));
    c = mix(c, vec3(0.075,0.067,0.058), testRegion(d,5));
    c = mix(c, vec3(0.12,0.20,0.065), testRegion(d,6));
    c = mix(c, stone, smoothstep(0.08,0.36,steep) * 0.85);
    float snow = smoothstep(4.4,5.8,height) * (1.0-smoothstep(0.12,0.45,steep));
    // Orbital snow coverage represents regional climate, not unresolved
    // individual snow pockets. Preserve altitude/slope snow when approaching.
    float regionalSnow=smoothstep(.64,.88,abs(d.y)+moisture*.12);
    snow=mix(snow,regionalSnow,smoothstep(.00015,.0008,pixelAngle));
    c*=.88+weathering*.45;
    return mix(c, vec3(0.72,0.76,0.77), snow);
  }
`;
