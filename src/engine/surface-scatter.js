import { AlwaysStencilFunc, ReplaceStencilOp, BufferGeometry, Float32BufferAttribute, DoubleSide, Group, IcosahedronGeometry, InstancedMesh, Matrix4, Quaternion, ShaderMaterial, Vector3 } from 'three';
import { siteDirection, TEST_SITES } from './test-world.js';
const random = n => { const x=Math.sin(n*127.1+311.7)*43758.5453;return x-Math.floor(x); };
function material(planet, grass) {
  return new ShaderMaterial({ side: grass ? DoubleSide : 0, stencilWrite:true, stencilRef:planet.stencilRef, stencilFunc:AlwaysStencilFunc, stencilZPass:ReplaceStencilOp, uniforms: {
    sun: planet.material.uniforms.uSunDir, light: planet.material.uniforms.uSunColour,
    intensity: planet.material.uniforms.uSunIntensity, time: planet.material.uniforms.uWaveTime,
    grass: { value: grass ? 1 : 0 }, day: { value: 1 }, haze: planet.material.uniforms.uHazeK, basis: { value: new Matrix4() },
  }, vertexShader: `
    #include <common>
    #include <logdepthbuf_pars_vertex>
    uniform float time; uniform float grass; uniform mat4 basis;
    varying vec3 n; varying vec3 p; varying float height; varying float distanceKm;
    void main(){vec3 v=position;if(grass>0.5)v.x+=sin(time*1.7+instanceMatrix[3].x*1300.0)*v.y*v.y*.14;
      vec4 local=instanceMatrix*vec4(v,1.0);p=local.xyz*1000.0;height=position.y;
      n=normalize(mat3(basis)*mat3(instanceMatrix)*normal);
      vec4 eye=modelViewMatrix*local;distanceKm=length(eye.xyz);gl_Position=projectionMatrix*eye;
      #include <logdepthbuf_vertex>
    }`, fragmentShader: `
    #include <common>
    #include <logdepthbuf_pars_fragment>
    uniform vec3 sun;uniform vec3 light;uniform float intensity;uniform float grass;uniform float day;uniform float haze;
    varying vec3 n;varying vec3 p;varying float height;varying float distanceKm;
    void main(){
      #include <logdepthbuf_fragment>
      vec3 normal=normalize(n);if(!gl_FrontFacing)normal=-normal;
      float grain=.86+.14*sin(p.x*47.0+sin(p.y*73.0)+p.z*39.0);
      vec3 colour=mix(vec3(.24,.22,.18)*grain,mix(vec3(.055,.095,.023),vec3(.22,.29,.08),clamp(height,0.0,1.0)),grass);
      float lit=max(dot(normal,sun),0.0)*.8+.22;
      gl_FragColor=vec4(colour*light*intensity*lit*day,haze>0.0?1.0-exp(-haze*distanceKm):1.0);
    }` });
}
export class SurfaceScatter {
  constructor(planet) {
    this.planet=planet;this.group=new Group();planet.spin.add(this.group);
    const rock=new IcosahedronGeometry(1,1), pos=rock.attributes.position;
    for(let i=0;i<pos.count;i++){const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);const f=.8+.2*Math.sin(x*7+y*13+z*5);pos.setXYZ(i,x*f,y*f,z*f);}rock.computeVertexNormals();
    this.rocks=new InstancedMesh(rock,material(planet,false),64);this.rocks.count=0;
    const blade=new BufferGeometry();blade.setAttribute('position',new Float32BufferAttribute([-.015,0,0,.015,0,0,.005,.6,0,.005,.6,0,.015,0,0,.015,1,0],3));blade.computeVertexNormals();
    this.grass=new InstancedMesh(blade,material(planet,true),1536);this.grass.count=0;
    for(const m of [this.rocks,this.grass]){m.frustumCulled=false;this.group.add(m);}
    this.anchor=null;this.pending=false;this.generation=0;
  }
  update(renderer, eye, groundKm) {
    const altitude=eye.length()-this.planet.radius-groundKm;
    this.group.visible=altitude<0.12;
    if(!this.group.visible)return;
    const dir=eye.clone().normalize();
    const day=Math.max(.008,Math.min(1,(dir.dot(this.planet.material.uniforms.uSunDir.value)+.05)/.2));
    this.rocks.material.uniforms.day.value=day;this.grass.material.uniforms.day.value=day;
    if(this.pending || (this.anchor && dir.distanceTo(this.anchor)*this.planet.radius<0.022))return;
    const up=dir, east=new Vector3().crossVectors(Math.abs(up.y)<.95?new Vector3(0,1,0):new Vector3(1,0,0),up).normalize(),north=new Vector3().crossVectors(east,up);
    const origin=up.clone().multiplyScalar(this.planet.radius);
    const basis=new Matrix4().makeBasis(east,up,north);
    const dirs=[];
    for(let y=0;y<8;y++)for(let x=0;x<8;x++){
      const i=y*8+x,dx=(x-3.5)*.012+(random(i)-.5)*.008,dz=(y-3.5)*.012+(random(i+78)-.5)*.008;
      dirs.push(up.clone().addScaledVector(east,dx/this.planet.radius).addScaledVector(north,dz/this.planet.radius).normalize());
    }
    const read=this.planet.groundHeightsKmAsync(renderer,dirs);if(!read)return;
    this.pending=true;const generation=this.generation;
    read.then(heights=>{
      if(generation!==this.generation)return;
      this.anchor=up.clone();this.group.position.copy(origin);this.group.quaternion.setFromRotationMatrix(basis);
      this.rocks.material.uniforms.basis.value.copy(basis);this.grass.material.uniforms.basis.value.copy(basis);
      const green=[1,6].some(i=>up.dot(new Vector3().fromArray(siteDirection(TEST_SITES[i])))>.999);
      const sea=this.planet.material.uniforms.uSeaLevelKm.value;
      let rocks=0,grass=0;
      const mat=new Matrix4(),q=new Quaternion(),scale=new Vector3();
      for(let i=0;i<dirs.length;i++){
        if(!Number.isFinite(heights[i])||heights[i]<sea+.004)continue;
        const v=dirs[i].clone().multiplyScalar(this.planet.radius+heights[i]).sub(origin);
        const at=new Vector3(v.dot(east),v.dot(up),v.dot(north));
        const size=(.15+random(i+12)**3*.95)/1000;
        q.setFromAxisAngle(new Vector3(0,1,0),random(i+25)*6.28);
        scale.set(size*1.5,size*.75,size);mat.compose(at.clone().add(new Vector3(0,size*.35,0)),q,scale);this.rocks.setMatrixAt(rocks++,mat);
        if(green)for(let j=0;j<24;j++){
          const k=i*24+j;
          const point=at.clone().add(new Vector3((random(k+320)-.5)*.0012,0,(random(k+520)-.5)*.0012));
          q.setFromAxisAngle(new Vector3(0,1,0),random(k+50)*6.28);
          const h=(.3+random(k+60)*.65)/1000;scale.set(h,h,h);mat.compose(point,q,scale);this.grass.setMatrixAt(grass++,mat);
        }
      }
      this.rocks.count=rocks;this.grass.count=grass;this.rocks.instanceMatrix.needsUpdate=true;this.grass.instanceMatrix.needsUpdate=true;
    },()=>{}).finally(()=>{this.pending=false;});
  }
  dispose(){this.generation++;this.group.removeFromParent();for(const m of [this.rocks,this.grass]){m.geometry.dispose();m.material.dispose();}}
}
