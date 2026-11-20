import { Camera, HalfFloatType, LinearFilter, Matrix3, Mesh, PlaneGeometry, RepeatWrapping, Scene, ShaderMaterial, Vector3, WebGLRenderTarget } from 'three';

// Integrate the same atmospheric shader into a direction-space LUT. It is
// independent of camera rotation, with quadratic elevation mapping concentrating
// samples around the horizon. Terrain and its antialiasing remain full resolution.
export class SkyRadianceCache {
  constructor(materials, fragmentShader) {
    this.basis = new Matrix3();
    this.lastEye = new Vector3(Infinity,0,0);
    this.lastSun = new Vector3();
    this.lastGround = Infinity;
    this.lastAt = -Infinity;
    this.scene = new Scene(); this.camera = new Camera();
    const vertexShader = 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}';
    const shader = fragmentShader
      .replace(/    if \(uUseSkyLut > 0\.5\) \{[\s\S]*?    const int STEPS =/, '    const int STEPS =')
      .replaceAll('#include <logdepthbuf_pars_fragment>', '')
      .replaceAll('#include <logdepthbuf_fragment>', '')
      .replace('varying vec3 vLocal;', 'varying vec2 vUv; vec3 vLocal;')
      .replace('    vec3 origin, ray;', `
        float longitude = vUv.x * 6.2831853;
        float e = vUv.y * 2.0 - 1.0;
        float latitude = sign(e) * e * e * 1.5707963;
        vec3 lutRay = uSkyBasis * vec3(cos(latitude)*cos(longitude), cos(latitude)*sin(longitude), sin(latitude));
        vec2 span = sphereSpan(uCameraLocal, lutRay, uShellRadius);
        vLocal = uCameraLocal + lutRay * max(span.y, 0.001);
        vec3 origin, ray;`);
    this.entries = materials.map(material => {
      const target = new WebGLRenderTarget(256, 128, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, stencilBuffer: false });
      target.texture.wrapS = RepeatWrapping;
      material.uniforms.uSkyRadianceLut = { value: target.texture };
      material.uniforms.uSkyBasis = { value: this.basis };
      material.uniforms.uUseSkyLut = { value: 0 };
      const bake = new ShaderMaterial({ vertexShader, fragmentShader: shader, depthTest: false, depthWrite: false,
        uniforms: { ...material.uniforms, uUseSkyLut: { value: 0 }, uSkyWeather: { value: 0 }, uSkyRadianceLut: { value: null } } });
      return { material, target, bake };
    });
    this.mesh = new Mesh(new PlaneGeometry(2,2), this.entries[0].bake);
    this.mesh.frustumCulled = false; this.scene.add(this.mesh);
    this.updates = 0;
  }
  update(renderer) {
    const u = this.entries[0].material.uniforms;
    const eye = u.uCameraLocal.value, sun = u.uSunDir.value;
    const active = eye.length() - u.uRadius.value < 35 && eye.length() > u.uRadius.value;
    for (const e of this.entries) e.material.uniforms.uUseSkyLut.value = active ? 1 : 0;
    if (!active) return;
    const now = performance.now(), ground = u.uGroundKm.value;
    const fog = this.entries.map(e => e.material.uniforms.uFogMix.value).join(',');
    if (eye.distanceTo(this.lastEye) < 0.025 && sun.distanceTo(this.lastSun) < 0.001 && Math.abs(ground-this.lastGround)<0.01 && now-this.lastAt<800 && fog===this.lastFog) return;
    const up = eye.clone().normalize();
    const east = new Vector3().crossVectors(Math.abs(up.y)<0.95?new Vector3(0,1,0):new Vector3(1,0,0),up).normalize();
    const north = new Vector3().crossVectors(up,east);
    this.basis.set(east.x,north.x,up.x,east.y,north.y,up.y,east.z,north.z,up.z);
    const previous = renderer.getRenderTarget();
    for (const e of this.entries) {
      this.mesh.material=e.bake; renderer.setRenderTarget(e.target); renderer.clear(); renderer.render(this.scene,this.camera);
    }
    renderer.setRenderTarget(previous);
    this.lastEye.copy(eye); this.lastSun.copy(sun); this.lastGround=ground; this.lastAt=now; this.lastFog=fog; this.updates++;
  }
  dispose() { for(const e of this.entries){e.target.dispose();e.bake.dispose();} this.mesh.geometry.dispose(); }
}

export const SKY_WEATHER_GLSL = /* glsl */ `
  uniform float uSkyWeather;
  uniform float uWeatherTime;
  uniform sampler2D uSkyRadianceLut;
  uniform float uUseSkyLut;
  uniform mat3 uSkyBasis;
  float skyHash(vec2 p) { p=fract(p*vec2(0.1031,0.1030));p+=dot(p,p.yx+33.33);return fract((p.x+p.y)*p.x); }
  float skyNoise(vec2 p) {
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(skyHash(i),skyHash(i+vec2(1,0)),f.x),mix(skyHash(i+vec2(0,1)),skyHash(i+1.0),f.x),f.y);
  }
  float skyFbm(vec2 p) { float f=0.0,a=0.57; for(int i=0;i<4;i++){f+=a*skyNoise(p);p=mat2(1.7,1.2,-1.2,1.7)*p+7.3;a*=0.48;}return f; }
  vec3 skyWeather(vec3 colour, vec3 origin, vec3 ray) {
    if(uSkyWeather<0.5 || uOnGround>0.5) return colour;
    float sunUp=dot(normalize(origin),uSunDir);
    float day=smoothstep(-0.12,0.12,sunUp);
    // Clouds are integrated by the shared spherical volume, including from below.
    float night=1.0-smoothstep(-0.16,-0.03,sunUp);
    if(night>0.001) {
      vec2 shell=sphereSpan(origin,ray,uRadius+95.0);
      if(shell.y>0.0 && dot(ray,normalize(origin))>0.0) {
        vec3 p=normalize(origin+ray*shell.y);
        float lon=atan(p.z,p.x), drift=uWeatherTime*0.035;
        float oval=abs(p.y)-0.96 + sin(lon*7.0+drift)*0.012 + sin(lon*17.0-drift*0.7)*0.006;
        float band=exp(-pow(oval/0.012,2.0));
        float rays=0.25+0.75*skyNoise(vec2(lon*110.0,drift*0.3));
        vec3 aurora=mix(vec3(0.035,0.85,0.26),vec3(0.38,0.075,0.48),smoothstep(0.0,0.03,oval));
        colour+=aurora*band*rays*night*0.22;
      }
    }
    return colour;
  }
`;
