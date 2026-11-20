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
    vec3 tex=living?textureGrad(uBiomeGrass,uv,dx,dy).rgb:textureGrad(uBiomeSand,uv,dx,dy).rgb;
    vec4 packed=textureGrad(uBiomeNormal,uv,dx,dy)*2.0-1.0;
    vec2 n=living?packed.xy:packed.zw;
    vec3 slope=transpose(uMapBasis)*vec3(-n/max(sqrt(max(1.0-dot(n,n),.1)),.4),0.0);
    slope-=terrainNormal*dot(slope,terrainNormal);
    normal=normalize(mix(normal,normalize(terrainNormal-slope*.35),weight));
    albedo=mix(albedo,tex,weight);
    shade=mix(shade,1.0,weight);
  }
`;
