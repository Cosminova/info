import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/**
 * Final-stage dither.
 *
 * Smooth, very dark gradients are where an 8-bit framebuffer runs out of
 * numbers: twilight sky, the falloff of an atmosphere shell, the outer Milky
 * Way. Rounding each pixel to the nearest of 256 levels turns those gradients
 * into visible contour bands, and no amount of precision earlier in the
 * pipeline helps, because the banding is created by the final quantisation.
 *
 * Adding just under one level of noise before that rounding converts the
 * banding into film-grain-scale dither, which the eye integrates back into a
 * smooth ramp. The noise is triangular rather than uniform — the difference of
 * two uniform samples — because that spreads the quantisation error evenly
 * instead of leaving a bias near level boundaries, the same reason audio
 * dithering uses a TPDF.
 *
 * This has to run after tone mapping and the sRGB transfer function, since it
 * is the display-space levels that are being smoothed, so it belongs at the
 * very end of the chain.
 */
const DitherShader = {
  uniforms: {
    tDiffuse: { value: null },
    // Just under one 8-bit level. Enough to break the contour, small enough
    // that it reads as texture rather than noise.
    uAmount: { value: 0.9 / 255 },
    uSeed: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    uniform float uSeed;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec4 colour = texture2D(tDiffuse, vUv);
      vec2 p = gl_FragCoord.xy + uSeed;
      float noise = hash(p) - hash(p + 37.31);
      gl_FragColor = vec4(colour.rgb + noise * uAmount, colour.a);
    }
  `,
};

export function createDitherPass() {
  const pass = new ShaderPass(DitherShader);
  return {
    pass,
    /** Re-seeds the pattern so it does not freeze into a static grain. */
    advance() {
      // Wraps well short of the precision limit of a float32 uniform.
      pass.uniforms.uSeed.value = (pass.uniforms.uSeed.value + 71.0) % 4096.0;
    },
    setAmount(levels) {
      pass.uniforms.uAmount.value = levels / 255;
    },
  };
}
