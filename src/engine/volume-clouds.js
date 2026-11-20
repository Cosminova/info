import { BackSide, Mesh, ShaderMaterial, SphereGeometry } from 'three';

// A bounded spherical cloud volume. Rays integrate the near weather layer;
// hollow space and the planet itself are skipped analytically. This gives the
// deck thickness, parallax and self-shadowing from above, below and inside.
export function createVolumeClouds(surface, radius, baseKm, thicknessKm) {
  const uniforms = {};
  for (const key of ['uCameraLocal','uRadius','uCloudCover','uCloudFreq','uCloudSeed','uCloudTint','uSunDir','uSunColour','uSunIntensity','uPixelsPerRadian']) uniforms[key] = surface.uniforms[key];
  uniforms.uCloudBase = {value:radius+baseKm};
  uniforms.uCloudTop = {value:radius+baseKm+thicknessKm};
  const material = new ShaderMaterial({uniforms,side:BackSide,transparent:true,depthWrite:false,
    vertexShader:/*glsl*/`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vLocal; varying vec3 vViewRay;
      void main(){vLocal=position;vec4 p=modelViewMatrix*vec4(position,1.0);vViewRay=p.xyz;gl_Position=projectionMatrix*p;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader:/*glsl*/`
      precision highp float;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec3 vLocal; varying vec3 vViewRay;
      uniform vec3 uCameraLocal,uSunDir,uCloudTint,uSunColour;
      uniform float uRadius,uCloudBase,uCloudTop,uCloudCover,uCloudFreq,uCloudSeed,uSunIntensity,uPixelsPerRadian;
      float hash(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
      float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
        return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
          mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+1.0),f.x),f.y),f.z);}
      vec2 span(vec3 o,vec3 d,float r){float b=dot(o,d),h=b*b-dot(o,o)+r*r;if(h<0.0)return vec2(-1.0);h=sqrt(h);return vec2(-b-h,-b+h);}
      float cloudWeather(vec3 d,float footprint){
        vec3 q=d*uCloudFreq+uCloudSeed;
        vec3 warp=vec3(noise3(q*.65),noise3(q*.65+17.1),noise3(q*.65-9.3))-.5;
        q+=warp*1.4;
        // Weather systems at the planet's own cloud scale decide where cloud
        // is; the octaves below only tear its edges. Without the broad term
        // every world came out in the same small scattered puffs.
        float systems=noise3(q*.9)*.62+noise3(q*2.1+5.3)*.38;
        q*=3.5;
        float sum=0.0,amp=.55,freq=3.5,total=0.0;
        mat3 rot=mat3(0.,.8,.6,-.8,.36,-.48,-.6,-.48,.64);
        for(int i=0;i<6;i++){
          float resolved=1.0-smoothstep(.25,.75,footprint*uCloudFreq*freq);
          float band=.5;if(resolved>.001)band=noise3(q);
          sum+=amp*mix(.5,band,resolved);total+=amp;
          q=rot*q*2.07+11.7;freq*=2.07;amp*=.58;
        }
        // Broad fronts with fine torn edges, not a binary opaque mask. The
        // threshold spans the whole range, from a few clouds to a closed deck.
        float v=mix(systems,sum/total,.42);
        float t=mix(.74,.26,uCloudCover);
        return smoothstep(t-.06,t+.08,v);
      }
      float density(vec3 p,float weather){
        float h=(length(p)-uCloudBase)/(uCloudTop-uCloudBase);
        if(h<=0.0||h>=1.0)return 0.0;
        float footprint=length(p-uCameraLocal)/max(uPixelsPerRadian,1.0);
        float billow=.55;
        if(footprint<2.0){
          billow=noise3(p*.23+uCloudSeed)*.7+noise3(p*.61+19.0)*.3;
          billow=mix(billow,.55,smoothstep(.2,2.0,footprint));
        }
        float shape=smoothstep(0.0,.18,h)*(1.0-smoothstep(.55,1.0,h));
        return weather*shape*smoothstep(.22,.65,billow)*(.35+.4*weather*weather);
      }
      void main(){
        vec3 eye=uCameraLocal,ray=normalize(vLocal-eye);
        vec2 outer=span(eye,ray,uCloudTop);if(outer.y<=0.0)discard;
        float start=max(0.0,outer.x),end=outer.y;
        vec2 inner=span(eye,ray,uCloudBase);
        if(length(eye)<uCloudBase)start=max(start,inner.y);
        else if(inner.x>start)end=min(end,inner.x);
        vec2 ground=span(eye,ray,uRadius);
        if(ground.x>0.0)end=min(end,ground.x);
        if(end<=start)discard;
        // Cap grazing distance; no long march through the hollow globe.
        end=min(end,start+180.0);
        float footprint=(start+end)*.5/max(uPixelsPerRadian,1.0);
        // The weather column is shared by the short ray segment. Four samples
        // suffice once its vertical structure is below a pixel; opacity remains
        // corrected by the actual step length rather than the sample count.
        float steps=footprint>4.0?4.0:8.0;
        float weather=cloudWeather(normalize(eye+ray*((start+end)*.5)),footprint/uRadius);
        if(weather<.002)discard;
        float stepKm=(end-start)/steps,trans=1.0,first=end;
        vec3 sum=vec3(0.0);
        for(int i=0;i<8;i++){
          if(float(i)>=steps)break;
          float t=start+(float(i)+.5)*stepKm;vec3 p=eye+ray*t;
          float den=density(p,weather);if(den<.002)continue;
          first=min(first,t);
          float shadow=exp(-density(p+uSunDir*1.2,weather)*2.4);
          float sun=smoothstep(-.06,.06,dot(normalize(p),uSunDir));
          float forward=pow(max(dot(ray,uSunDir),0.0),12.0);
          vec3 lit=uCloudTint*uSunColour*uSunIntensity*(.035+sun*(.18+shadow*(.55+forward*.18)));
          float a=1.0-exp(-den*stepKm*.85);sum+=trans*a*lit;trans*=1.0-a;
          if(trans<.015)break;
        }
        if(trans>.998)discard;
        #if defined(USE_LOGARITHMIC_DEPTH_BUFFER)
          gl_FragDepth=log2(1.0+first*max(-normalize(vViewRay).z,.0001))*logDepthBufFC*.5;
        #endif
        gl_FragColor=vec4(sum/max(1.0-trans,.001),1.0-trans);
      }
    `});
  const mesh=new Mesh(new SphereGeometry(radius+baseKm+thicknessKm,64,32),material);
  mesh.frustumCulled=false;mesh.renderOrder=4;mesh.name='volumetric-clouds';
  return mesh;
}
