import { ACESFilmicToneMapping, Vector2 } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createDitherPass } from './dither.js';

/**
 * The scene is rendered in linear HDR: a first-magnitude star is thousands of
 * times brighter than the faintest visible one, and that ratio is preserved all
 * the way through bloom. Tone mapping happens last, in OutputPass, which is
 * what produces the natural-looking glare falloff around bright stars instead
 * of flat clipped white discs.
 */
export function createPostProcessing(renderer, scene, camera, { bloom = {} } = {}) {
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;

  const size = renderer.getDrawingBufferSize(new Vector2());
  const composer = new EffectComposer(renderer);
  composer.setSize(size.width, size.height);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // A fairly high threshold keeps the glow on genuinely bright stars instead of
  // smearing the whole faint field into a haze.
  const bloomPass = new UnrealBloomPass(
    new Vector2(size.width, size.height),
    bloom.strength ?? 0.45,
    bloom.radius ?? 0.5,
    bloom.threshold ?? 0.75,
  );
  composer.addPass(bloomPass);

  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  // Twilight and the outer Milky Way are exactly the smooth dark gradients that
  // band in an 8-bit framebuffer, so the chain ends in dither.
  const dither = createDitherPass();
  composer.addPass(dither.pass);

  return {
    composer,
    bloomPass,
    setSize(width, height) {
      composer.setSize(width, height);
      bloomPass.setSize(width, height);
    },
    setBloom({ strength, radius, threshold }) {
      if (strength !== undefined) bloomPass.strength = strength;
      if (radius !== undefined) bloomPass.radius = radius;
      if (threshold !== undefined) bloomPass.threshold = threshold;
    },
    setEnabled(enabled) {
      bloomPass.enabled = enabled;
    },
    render(deltaTime) {
      dither.advance();
      composer.render(deltaTime);
    },
  };
}
