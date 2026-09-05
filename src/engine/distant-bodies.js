import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Points,
  ShaderMaterial,
} from 'three';

/**
 * Solar-system bodies too small to tessellate still have to be visible as
 * points of light — otherwise Saturn vanishes for the entire Earth-to-Saturn
 * cruise. These are camera-relative positions, one point per body.
 */

const MAX = 96;

const VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float size;
  attribute vec3 color;
  uniform float uPixelRatio;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = size * uPixelRatio;
    gl_PointSize = clamp(gl_PointSize, 1.5, 22.0);
    #include <logdepthbuf_vertex>
  }
`;

const FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec3 vColor;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float core = exp(-r * r * 3.4);
    gl_FragColor = vec4(vColor * core, core);
  }
`;

export function createDistantBodies() {
  const positions = new Float32Array(MAX * 3);
  const colors = new Float32Array(MAX * 3);
  const sizes = new Float32Array(MAX);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('size', new BufferAttribute(sizes, 1));

  const material = new ShaderMaterial({
    uniforms: { uPixelRatio: { value: 1 } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });

  const points = new Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 4;
  points.name = 'distant-bodies';

  let count = 0;

  return {
    object: points,
    begin() {
      count = 0;
    },
    add(rel, rgb, apparentPixels, albedo = 0.4) {
      if (count >= MAX) return;
      const i = count++;
      positions[i * 3] = rel.x;
      positions[i * 3 + 1] = rel.y;
      positions[i * 3 + 2] = rel.z;
      const boost = 0.55 + albedo;
      colors[i * 3] = rgb[0] * boost;
      colors[i * 3 + 1] = rgb[1] * boost;
      colors[i * 3 + 2] = rgb[2] * boost;
      sizes[i] = Math.min(16, Math.max(1.6, apparentPixels * 2.8 + 1.1));
    },
    end(pixelRatio) {
      material.uniforms.uPixelRatio.value = pixelRatio;
      geometry.setDrawRange(0, count);
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.color.needsUpdate = true;
      geometry.attributes.size.needsUpdate = true;
      points.visible = count > 0;
    },
  };
}
