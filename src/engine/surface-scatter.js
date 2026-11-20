import { AlwaysStencilFunc, ReplaceStencilOp, BufferGeometry, Float32BufferAttribute, InstancedBufferAttribute, DynamicDrawUsage, DoubleSide, Group, IcosahedronGeometry, InstancedMesh, Matrix4, Quaternion, ShaderMaterial, Vector3 } from 'three';
import { siteDirection, TEST_SITES } from './test-world.js';
import { ScatterGeography, ROCKS_PER_CELL, CELL_KM, VISIBLE_KM, randomFor } from './scatter-geography.js';
const POOL_CELLS=128, CACHE_CELLS=256, BLADES=12;
const GREEN_SITES=[1,6].map(i=>new Vector3().fromArray(siteDirection(TEST_SITES[i])));
const Y=new Vector3(0,1,0);
function material(planet, grass) {
  return new ShaderMaterial({ side: grass ? DoubleSide : 0, stencilWrite:true, stencilRef:planet.stencilRef, stencilFunc:AlwaysStencilFunc, stencilZPass:ReplaceStencilOp, uniforms: {
    sun: planet.material.uniforms.uSunDir, light: planet.material.uniforms.uSunColour,
    intensity: planet.material.uniforms.uSunIntensity, time: planet.material.uniforms.uWaveTime,
    clock: {value:0}, eye: {value:new Vector3()}, grass: { value: grass ? 1 : 0 }, day: { value: 1 }, haze: planet.material.uniforms.uHazeK, basis: { value: new Matrix4() },
  }, vertexShader: `
    #include <common>
    #include <logdepthbuf_pars_vertex>
    attribute vec2 instanceLife;
    uniform float time; uniform float clock; uniform float grass; uniform mat4 basis; uniform vec3 eye;
    varying float visibility;
    varying vec3 n; varying vec3 p; varying float height; varying float distanceKm;
    void main(){
      visibility=instanceLife.x<0.0?0.0:smoothstep(0.0,1.2,clock-instanceLife.x);
      float range=length(instanceMatrix[3].xyz-eye);
      visibility*=1.0-smoothstep(grass>0.5?0.035:0.060,grass>0.5?0.060:0.095,range);
      if(visibility<=0.0){gl_Position=vec4(2.0,2.0,2.0,1.0);return;}
      vec3 v=position;if(grass>0.5)v.x+=sin(time*1.7+instanceLife.y)*v.y*v.y*.14;
      vec4 local=instanceMatrix*vec4(v,1.0);p=position;height=position.y;
      vec3 scale2=vec3(dot(instanceMatrix[0].xyz,instanceMatrix[0].xyz),dot(instanceMatrix[1].xyz,instanceMatrix[1].xyz),dot(instanceMatrix[2].xyz,instanceMatrix[2].xyz));
      n=normalize(mat3(basis)*mat3(instanceMatrix)*(normal/max(scale2,vec3(1e-12))));
      vec4 eye=modelViewMatrix*local;distanceKm=length(eye.xyz);gl_Position=projectionMatrix*eye;
      #include <logdepthbuf_vertex>
    }`, fragmentShader: `
    #include <common>
    #include <logdepthbuf_pars_fragment>
    varying float visibility;
    uniform vec3 sun;uniform vec3 light;uniform float intensity;uniform float grass;uniform float day;uniform float haze;
    varying vec3 n;varying vec3 p;varying float height;varying float distanceKm;
    void main(){
      #include <logdepthbuf_fragment>
      // Coverage fade preserves opaque depth/stencil and the haze alpha channel.
      float coverage=fract(52.9829189*fract(dot(floor(gl_FragCoord.xy),vec2(.06711056,.00583715))));
      if(coverage>=visibility)discard;
      vec3 normal=normalize(n);if(!gl_FrontFacing)normal=-normal;
      float grain=1.0+.035*sin(p.x*31.0)*sin(p.y*47.0)*sin(p.z*39.0);
      vec3 colour=mix(vec3(.24,.22,.18)*grain,mix(vec3(.055,.095,.023),vec3(.22,.29,.08),clamp(height,0.0,1.0)),grass);
      float lit=max(dot(normal,sun),0.0)*.8+.22;
      gl_FragColor=vec4(colour*light*intensity*lit*day,haze>0.0?1.0-exp(-haze*distanceKm):1.0);
    }` });
}
export class SurfaceScatter {
  constructor(planet) {
    this.planet=planet;this.group=new Group();planet.spin.add(this.group);
    this.geography=new ScatterGeography(planet.radius,Math.round(planet.material.uniforms.uSurfaceSeed.value));
    const rock=new IcosahedronGeometry(1,1),pos=rock.attributes.position;
    for(let i=0;i<pos.count;i++){const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);const f=.8+.2*Math.sin(x*7+y*13+z*5);pos.setXYZ(i,x*f,y*f,z*f);}rock.computeVertexNormals();
    const blade=new BufferGeometry();blade.setAttribute('position',new Float32BufferAttribute([-.015,0,0,.015,0,0,.005,.6,0,.005,.6,0,.015,0,0,.015,1,0],3));blade.computeVertexNormals();
    this.rocks=this._mesh(rock,false,POOL_CELLS*ROCKS_PER_CELL);
    this.grass=this._mesh(blade,true,POOL_CELLS*ROCKS_PER_CELL*BLADES);
    this.cache=new Map();this.resident=new Map();this.desired=new Map();this.free=Array.from({length:POOL_CELLS},(_,i)=>POOL_CELLS-1-i);
    this.probe={};this.pending=false;this.generation=0;this.scanAt=null;this.anchored=false;
    this.counters={generated:0,cacheHits:0,evictions:0,uploads:0,queries:0,failures:0,lateLoads:0,maxUploadMs:0};
  }
  _mesh(geometry,grass,count) {
    const life=new Float32Array(count*2);for(let i=0;i<count;i++)life[i*2]=-1;
    geometry.setAttribute('instanceLife',new InstancedBufferAttribute(life,2).setUsage(DynamicDrawUsage));
    const mesh=new InstancedMesh(geometry,material(this.planet,grass),count);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);mesh.count=0;mesh.frustumCulled=false;this.group.add(mesh);return mesh;
  }
  stats(){return {...this.counters,cachedCells:this.cache.size,residentCells:this.resident.size,pending:this.pending,queued:[...this.desired.keys()].filter(k=>!this.cache.has(k)).length};}
  snapshot(){return [...this.resident.keys()].flatMap(k=>this.cache.get(k).rocks.filter(r=>r.position).map(r=>({id:r.id,position:r.position.toArray(),size:r.size,yaw:r.yaw}))).sort((a,b)=>a.id.localeCompare(b.id));}
  _hide(slot) {
    for(const [mesh,n] of [[this.rocks,ROCKS_PER_CELL],[this.grass,ROCKS_PER_CELL*BLADES]]) {
      const life=mesh.geometry.getAttribute('instanceLife');for(let i=slot*n;i<(slot+1)*n;i++)life.array[i*2]=-1;
      life.addUpdateRange(slot*n*2,n*2);life.needsUpdate=true;
    }
  }
  _scan(dir,now) {
    const cells=this.geography.nearby(dir);this.desired=new Map(cells.map(c=>[c.key,c]));this.scanAt=dir.clone();
    for(const [key,slot] of this.resident)if(!this.desired.has(key)||this.desired.get(key).distance>VISIBLE_KM+CELL_KM*Math.SQRT1_2+.012){this._hide(slot);this.free.push(slot);this.resident.delete(key);}
    const high=Math.max(-1,...this.resident.values())+1;this.rocks.count=high*ROCKS_PER_CELL;this.grass.count=high*ROCKS_PER_CELL*BLADES;
    for(const cell of cells) {
      const cached=this.cache.get(cell.key);
      if(cached){cached.used=now;if(!this.resident.has(cell.key)){if(this._activate(cached,now))this.counters.cacheHits++;}}
    }
  }
  _prune() {
    while(this.cache.size>CACHE_CELLS) {
      let oldest=null;
      for(const c of this.cache.values())if(!this.desired.has(c.key)&&(!oldest||c.used<oldest.used))oldest=c;
      if(!oldest)break;this.cache.delete(oldest.key);this.counters.evictions++;
    }
  }
  _activate(cell,now) {
    if(!this.desired.has(cell.key)||this.resident.has(cell.key)||!this.free.length)return;
    if(this.desired.get(cell.key).distance>VISIBLE_KM+CELL_KM*Math.SQRT1_2+.012)return;
    const slot=this.free.pop();this.resident.set(cell.key,slot);cell.born=cell.loadedAt;
    this._write(cell,slot);return true;
  }
  _write(cell,slot) {
    const started=performance.now();
    const mat=new Matrix4(),q=new Quaternion(),yaw=new Quaternion(),scale=new Vector3();
    this._hide(slot);
    cell.rocks.forEach((r,i)=>{
      if(!r.position)return;
      q.setFromUnitVectors(Y,r.normal);yaw.setFromAxisAngle(Y,r.yaw);q.multiply(yaw);
      const at=r.position.clone().sub(this.group.position).addScaledVector(r.normal,r.size*.15);
      scale.set(r.size*1.5,r.size*.75,r.size);mat.compose(at,q,scale);
      const index=slot*ROCKS_PER_CELL+i;this.rocks.setMatrixAt(index,mat);
      this.rocks.geometry.getAttribute('instanceLife').setXY(index,cell.born,randomFor(r.seed,4)*6.28);
      if(r.green)for(let j=0;j<BLADES;j++) {
        const k=index*BLADES+j,dx=(randomFor(r.seed,10+j*4)-.5)*.0012,dz=(randomFor(r.seed,11+j*4)-.5)*.0012;
        const point=r.position.clone().sub(this.group.position).addScaledVector(r.east,dx).addScaledVector(r.north,dz);
        point.addScaledVector(r.dir,-(dx*r.normal.dot(r.east)+dz*r.normal.dot(r.north))/Math.max(.3,r.normal.dot(r.dir)));
        q.setFromUnitVectors(Y,r.normal);yaw.setFromAxisAngle(Y,randomFor(r.seed,12+j*4)*6.28);q.multiply(yaw);
        const h=(.18+randomFor(r.seed,13+j*4)*.4)/1000;scale.set(h,h,h);mat.compose(point,q,scale);this.grass.setMatrixAt(k,mat);
        this.grass.geometry.getAttribute('instanceLife').setXY(k,cell.born,randomFor(r.seed,j+100)*6.28);
      }
    });
    for(const [mesh,n]of [[this.rocks,ROCKS_PER_CELL],[this.grass,ROCKS_PER_CELL*BLADES]]) {
      mesh.count=Math.max(mesh.count,(slot+1)*n);mesh.instanceMatrix.addUpdateRange(slot*n*16,n*16);mesh.instanceMatrix.needsUpdate=true;
      const life=mesh.geometry.getAttribute('instanceLife');life.addUpdateRange(slot*n*2,n*2);life.needsUpdate=true;
    }
    this.counters.uploads++;this.counters.maxUploadMs=Math.max(this.counters.maxUploadMs,performance.now()-started);
  }
  _rebase(dir) {
    const origin=dir.clone().multiplyScalar(this.planet.radius),delta=this.group.position.clone().sub(origin);
    // Change only the rendering origin, never geographical object positions.
    for(const mesh of [this.rocks,this.grass]) {
      const a=mesh.instanceMatrix.array;for(let i=0;i<mesh.count;i++){a[i*16+12]+=delta.x;a[i*16+13]+=delta.y;a[i*16+14]+=delta.z;}
      mesh.instanceMatrix.clearUpdateRanges();mesh.instanceMatrix.needsUpdate=true;
    }
    this.group.position.copy(origin);this.anchored=true;
  }
  update(renderer,eye,groundKm) {
    const altitude=eye.length()-this.planet.radius-groundKm;this.group.visible=altitude<.12;
    if(!this.group.visible)return;
    const dir=eye.clone().normalize(),now=performance.now()/1000;this.eyeDir=dir;
    if(!this.anchored||eye.distanceTo(this.group.position)>Math.abs(groundKm)+2)this._rebase(dir);
    const day=Math.max(.008,Math.min(1,(dir.dot(this.planet.material.uniforms.uSunDir.value)+.05)/.2));
    for(const mesh of [this.rocks,this.grass]){mesh.material.uniforms.day.value=day;mesh.material.uniforms.clock.value=now;mesh.material.uniforms.eye.value.copy(eye).sub(this.group.position);}
    if(!this.scanAt||dir.distanceTo(this.scanAt)*this.planet.radius>.012)this._scan(dir,now);
    if(this.pending)return;
    const cell=[...this.desired.values()].find(c=>!this.cache.has(c.key));if(!cell)return;
    const rocks=this.geography.generate(cell),dirs=[];
    for(const r of rocks) {
      r.east=new Vector3().crossVectors(Math.abs(r.dir.y)<.95?Y:new Vector3(1,0,0),r.dir).normalize();r.north=new Vector3().crossVectors(r.dir,r.east);
      dirs.push(r.dir,r.dir.clone().addScaledVector(r.east,.002/this.planet.radius).normalize(),r.dir.clone().addScaledVector(r.north,.002/this.planet.radius).normalize());
    }
    const read=this.planet.groundHeightsKmAsync(renderer,dirs,{owner:this.probe,pixelAngle:1e-9});if(!read)return;
    this.pending=true;this.counters.queries++;const generation=this.generation;
    read.then(heights=>{
      if(generation!==this.generation)return;
      if(heights.length!==dirs.length||!heights.every(Number.isFinite))throw new Error('Invalid scatter terrain samples');
      const radius=this.planet.radius,sea=this.planet.material.uniforms.uSeaLevelKm.value;
      rocks.forEach((r,i)=>{
        const h=heights[i*3];if(h<sea+.004)return;
        const at=r.dir.clone().multiplyScalar(radius+h),e=dirs[i*3+1].clone().multiplyScalar(radius+heights[i*3+1]).sub(at),n=dirs[i*3+2].clone().multiplyScalar(radius+heights[i*3+2]).sub(at);
        r.normal=e.cross(n).normalize();if(r.normal.dot(r.dir)<0)r.normal.negate();
        if(r.normal.dot(r.dir)<.55)return;
        r.position=at;r.green=GREEN_SITES.some(site=>r.dir.dot(site)>.999);
      });
      const cached={...cell,rocks,used:performance.now()/1000,loadedAt:performance.now()/1000};this.cache.set(cell.key,cached);this.counters.generated++;this._prune();
      if(this.eyeDir&&rocks.some(r=>r.position&&r.dir.distanceTo(this.eyeDir)*radius<VISIBLE_KM))this.counters.lateLoads++;
      this._activate(cached,performance.now()/1000);
    }).catch(()=>{this.counters.failures++;}).finally(()=>{this.pending=false;});
  }
  dispose() {
    this.generation++;this.group.removeFromParent();
    for(const m of [this.rocks,this.grass]){m.geometry.dispose();m.material.dispose();}
    const release=()=>{this.probe._probeTargetAsync?.target.dispose();this.probe._probeMaterial?.dispose();};
    if(this.probe._asyncProbe)this.probe._asyncProbe.then(release,release);else release();
    this.cache.clear();this.resident.clear();
  }
}
