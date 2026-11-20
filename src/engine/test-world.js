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
  const vec3 testSites[7] = vec3[7](${centers});
  float testRegion(vec3 d, int i) { return smoothstep(0.997, 0.9995, dot(d, testSites[i])); }
  // The existing derivative-noise basis, with rounded crests and less energy
  // in fine octaves. This avoids the cost of the general erosion shader while
  // retaining a matching height gradient for materials and terrain lighting.
  vec4 testMountainRidges(vec3 p) {
    vec4 sum=vec4(0.0);float amp=0.5,freq=1.0;
    for(int i=0;i<3;i++) {
      vec4 n=noised(p*freq);
      float rounded=sqrt(n.x*n.x+0.025),crest=1.0-rounded;
      sum.x+=amp*crest*crest;
      sum.yzw-=amp*freq*2.0*crest*n.x/rounded*n.yzw;
      freq*=2.03;amp*=0.44;
    }
    sum.x-=0.42;return sum;
  }
  vec4 testTerrain(vec3 d, float pixelAngle) {
    // Interior sites need only their own field. Avoid evaluating continent,
    // crags and distant ridges for every vertex and fragment in a meadow.
    vec4 hill = fbmd(d * 190.0 + 6.1, 3, 2.07, 0.34);
    vec4 t = vec4(0.0);
    bool interior = false;
    for(int j=0;j<7;j++) if(dot(d,testSites[j])>=0.9995) interior=true;
    if(!interior) {
    vec4 continent = fbmd(d * 2.8 + 17.3, 5, 2.03, 0.47);
    vec4 ridge = testMountainRidges(d * 1100.0 + 3.7);
    float mountain = smoothstep(0.02, 0.32, continent.x);
    float mq = clamp((continent.x - 0.02) / 0.30, 0.0, 1.0);
    float mountainDerivative = 6.0 * mq * (1.0 - mq) / 0.30;
    t = vec4(1.4 + continent.x * 9.0 + (ridge.x + 0.48) * mountain * 3.8 + hill.x * 0.22,
      continent.yzw * (25.2 + (ridge.x + 0.48) * 10.64 * mountainDerivative) + ridge.yzw * 4180.0 * mountain + hill.yzw * 41.8);
    // Bounded crag amplitude; fine grain belongs in the material, not spiky mesh noise.
    // Metre-scale materials are filtered separately. Keep the geological
    // height field fixed so approaching a site cannot move its rock foundations.
    vec4 crag = fbmd(d * 1600.0 + 41.0, 3, 2.03, 0.32);
    t += vec4(crag.x * 0.025, crag.yzw * 40.0);
    }
    for (int i = 0; i < 7; i++) {
      float dotSite = dot(d, testSites[i]);
      float w = testRegion(d, i);
      if (w < 0.001) continue;
      float h = 1.6 + hill.x * 0.15;
      vec3 slope = hill.yzw * 28.5;
      if (i == 0) { vec3 east = normalize(cross(vec3(0,1,0), testSites[i])); h = 1.13 + clamp(dot(d, east) * 450.0,-0.7,0.7) + hill.x * 0.005; slope = east * (abs(dot(d,east)*450.0)<0.7?450.0:0.0) + hill.yzw * 0.95; }
      if (i == 1 || i == 2 || i == 3) {
        // Kilometre-scale ranges, with a broad drainage valley through the
        // landing region. Warping bends the range; fine octaves shape shoulders
        // rather than imposing metre-scale washboard noise on the walker.
        vec3 east = normalize(cross(vec3(0,1,0), testSites[i]));
        float across = dot(d - testSites[i], east) * uRadius;
        float bend = across + hill.x * 1.8;
        float valley = 1.0 - exp(-bend*bend/6.0);
        vec3 valleyGradient = (east*uRadius + hill.yzw*342.0)
          * (2.0*bend/6.0) * (1.0-valley);
        vec3 warpAxis = vec3(0.8,-0.35,0.55);
        vec4 ridge = testMountainRidges(d*1100.0 + warpAxis*hill.x + 3.7);
        vec3 gradient = ridge.yzw*1100.0 + hill.yzw*(190.0*dot(ridge.yzw,warpAxis));
        float relief = i == 3 ? 5.5 : i == 1 ? 3.2 : 1.8;
        float base = i == 3 ? 2.4 : i == 1 ? 1.6 : 1.9;
        float massif = max(0.0, ridge.x + 0.48);
        h = base + hill.x*.12 + valley*massif*relief;
        slope = hill.yzw*22.8 + relief*(valleyGradient*massif + valley*gradient);
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
      float q = clamp((dotSite - 0.997) / 0.0025, 0.0, 1.0);
      vec3 dw = testSites[i] * 6.0 * q * (1.0 - q) / 0.0025;
      t = vec4(mix(t.x, h, w), mix(t.yzw, slope, w) + (h - t.x) * dw);
    }
    return t;
  }
  vec3 testBiomeColour(vec3 d, float height, float steep) {
    float moisture = fbmd(d * 7.0 + 19.0, 3, 2.1, 0.5).x;
    float cold = smoothstep(0.55, 0.9, abs(d.y));
    vec3 green = mix(vec3(0.085,0.14,0.038), vec3(0.19,0.26,0.07), smoothstep(-0.2,0.25,moisture));
    vec3 sand = vec3(0.48,0.31,0.15), stone = vec3(0.24,0.26,0.28);
    vec3 c = mix(sand, green, smoothstep(-0.12,0.12,moisture));
    c = mix(c, vec3(0.27,0.25,0.15), cold);
    c = mix(c, vec3(0.67,0.72,0.73), smoothstep(0.82,0.96,abs(d.y)));
    c = mix(c, vec3(0.61,0.48,0.29), 1.0-smoothstep(0.015,0.085,abs(height-1.1)));
    c = mix(c, green, testRegion(d,1));
    c = mix(c, sand, testRegion(d,2));
    float beds = 0.5 + 0.5 * sin(height * 42.0 + moisture * 4.0);
    vec3 alpineRock = mix(vec3(0.27,0.29,0.31),vec3(0.49,0.50,0.47),
      beds * 0.22 + smoothstep(0.04,0.25,moisture) * 0.18);
    c = mix(c, alpineRock, testRegion(d,3));
    c = mix(c, vec3(0.71,0.77,0.79), testRegion(d,4));
    c = mix(c, vec3(0.075,0.067,0.058), testRegion(d,5));
    c = mix(c, vec3(0.12,0.20,0.065), testRegion(d,6));
    c = mix(c, stone, smoothstep(0.08,0.36,steep) * 0.85);
    float snow = smoothstep(4.25,5.0,height) * (1.0-smoothstep(0.12,0.45,steep));
    return mix(c, vec3(0.80,0.83,0.83), snow);
  }
`;
