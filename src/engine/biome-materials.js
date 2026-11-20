import { DataTexture, TextureLoader, RepeatWrapping, LinearMipmapLinearFilter, SRGBColorSpace, NoColorSpace } from 'three';
const flat=new DataTexture(new Uint8Array([128,128,128,128]),1,1);flat.needsUpdate=true;
const uniforms={uBiomeGrass:{value:flat},uBiomeSand:{value:flat},uBiomeNormal:{value:flat},uBiomeReady:{value:0}};
let started=false;
export function biomeMaterialUniforms(enabled){
  if(enabled&&!started){started=true;let count=0;const loader=new TextureLoader();
    for(const [key,file,color]of [['uBiomeGrass','grass',true],['uBiomeSand','sand',true],['uBiomeNormal','normal',false]]){
      loader.load(`textures/ground/biome-${file}.webp`,texture=>{
        texture.wrapS=texture.wrapT=RepeatWrapping;texture.minFilter=LinearMipmapLinearFilter;texture.anisotropy=8;
        texture.colorSpace=color?SRGBColorSpace:NoColorSpace;uniforms[key].value=texture;if(++count===3)uniforms.uBiomeReady.value=1;
      });
    }
  }
  return uniforms;
}
export const BIOME_MATERIAL_GLSL=/*glsl*/`
  uniform sampler2D uBiomeGrass;
  uniform sampler2D uBiomeSand;
  uniform sampler2D uBiomeNormal;
  uniform float uBiomeReady;
  void biomeMaterial(vec3 dir,vec3 rel,float heightKm,float steep,vec3 terrainNormal,inout vec3 albedo,inout vec3 normal,inout float shade){
    float grass=max(testRegion(dir,1),testRegion(dir,6));
    float sand=max(testRegion(dir,0),testRegion(dir,2));
    float weight=max(grass,sand)*uBiomeReady*(1.0-smoothstep(.08,.32,steep))*(1.0-smoothstep(80.0,250.0,length(vRel)*1000.0));
    if(weight<.001)return;
    bool living=grass>sand;
    vec3 local=uMapBasis*rel;
    vec2 uv=(uMapFrac.xy+local.xy-(uMapBasis*dir).xy*heightKm*1000.0)/(living?2.0:4.0);
    vec2 dx=dFdx(uv),dy=dFdy(uv);
    // Shifted dual samples (also used by the rock material) break the regular
    // grass/sand tiling. Use the same blend for colour and normal data, with
    // original derivatives to keep mip filtering stable while walking.
    float pick=textureLod(uBiomeNormal,uv*.125+0.37,3.0).x*16.0;
    float cell=floor(pick), blend=smoothstep(.2,.8,fract(pick));
    vec2 a=uv+sin(vec2(3.0,7.0)*cell), b=uv+sin(vec2(3.0,7.0)*(cell+1.0));
    vec3 tex=living?mix(textureGrad(uBiomeGrass,a,dx,dy).rgb,textureGrad(uBiomeGrass,b,dx,dy).rgb,blend)
      :mix(textureGrad(uBiomeSand,a,dx,dy).rgb,textureGrad(uBiomeSand,b,dx,dy).rgb,blend);
    vec4 packed=mix(textureGrad(uBiomeNormal,a,dx,dy),textureGrad(uBiomeNormal,b,dx,dy),blend)*2.0-1.0;
    vec2 n=living?packed.xy:packed.zw;
    vec3 slope=transpose(uMapBasis)*vec3(-n/max(sqrt(max(1.0-dot(n,n),.1)),.4),0.0);
    slope-=terrainNormal*dot(slope,terrainNormal);
    normal=normalize(mix(normal,normalize(terrainNormal-slope*.025),weight));
    // Retain fine colour variation without deep-looking baked crevices.
    tex=mix(albedo,tex,.45);
    albedo=mix(albedo,tex,weight);
    shade=mix(shade,1.0,weight);
  }
`;
