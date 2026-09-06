import { Group, Matrix4, Quaternion, Vector3, Vector4 } from 'three';

import { equatorialToVector } from './astro.js';
import { BODY_BY_KEY } from './engine/bodies-data.js';
import { Planet } from './engine/planet.js';
import { physicalFor } from './engine/physical-data.js';
import { createRings } from './engine/rings.js';
import {
  SUN_RADIUS_KM,
  UMBRA_REFRACTED_LIGHT,
  displayedReflectance,
  illuminatedFraction,
  reflectedFraction,
} from './engine/shadow-glsl.js';
import { capTextureWidth } from './engine/platform.js';

const DEG = Math.PI / 180;
const AU_KM = 149597870.7;
const EARTH_RADIUS_KM = 6371;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Reflectance the lit face of a body is exposed to, in linear light.
 *
 * Set from the reference footage, where a moon beside Saturn's rings sits in dim
 * blue-grey mid tones with the rings as the only bright thing in frame, and
 * nothing is anywhere near clipping. Chosen at the low end deliberately: a
 * slightly dark planet still shows its markings, whereas a bright one shows
 * nothing at all.
 */
const TARGET_MID_TONE = 0.26;

/**
 * Real bodies in the naked-eye sky.
 *
 * Looking up from the ground, a planet is a point of light; through a telescope
 * it is a world. This layer is what makes that one continuous gesture instead of
 * two separate programs. Below a few pixels across, the sprite discs the sky
 * layer draws are the right answer — they carry the correct brightness and phase
 * and cost nothing. Past that they are a smooth shaded circle and magnifying
 * them further shows nothing new, so the same terrain renderer the solar system
 * explorer uses takes over, with its imagery, elevation, procedural relief,
 * rings and shadows.
 *
 * The bodies are not placed at their true distances. A perspective camera cannot
 * hold Saturn at 1.4 billion kilometres and the horizon at two in the same depth
 * buffer, and the sky layers around it live on a shell 900 units out. Instead
 * each body is placed on a shell well inside that and scaled so that it subtends
 * exactly the angle it really does — which is all an observer can measure anyway.
 * Everything the shading depends on, and the level of detail the terrain builds,
 * uses the true distance in kilometres, so what you see is the real body at the
 * real size, drawn somewhere convenient.
 */
export class ResolvedBodies {
  /**
   * @param {object} options
   * @param {import('three').Scene} options.scene the sky scene
   * @param {import('./engine/universe.js').Universe} options.universe for spin and tilt
   * @param {import('./engine/textures.js').BodyTextures} options.textures
   * @param {number} options.shellRadius scene units at which bodies are placed
   */
  constructor({ scene, universe, textures, shellRadius = 380 }) {
    this.scene = scene;
    this.universe = universe;
    this.textures = textures;
    this.shellRadius = shellRadius;

    this.group = new Group();
    // Drawn after the star field and the panorama, both of which sit further
    // out; a planet in front of the Milky Way should hide it.
    this.group.renderOrder = 4;
    scene.add(this.group);

    this.planets = new Map();
    this.requested = new Set();
    this.rings = new Map();
    // Per body exposure gain, measured from its imagery. See _gain.
    this.gains = new Map();
    this._probe = null;

    this._direction = new Vector3();
    this._cameraLocal = new Vector3();
    this._sunLocal = new Vector3();
    this._toSun = new Vector3();
    this._toHost = new Vector3();
    this._shineDir = new Vector3();
    this._occluder = new Vector4();
    this._equatorialOrientation = new Quaternion();
    this._skyRotation = new Quaternion();
    this._inverse = new Quaternion();
    this._viewLocal = new Vector3();
    this._lockX = new Vector3();
    this._lockY = new Vector3();
    this._lockZ = new Vector3();
    this._lockBasis = new Matrix4();

    // Ecliptic to equatorial. The ephemeris hands over right ascension and
    // declination, so directions arrive already in the equatorial frame, but the
    // spin axes and orbital planes the universe model carries are ecliptic.
    this._eclipticToEquatorial = new Quaternion().setFromAxisAngle(
      new Vector3(1, 0, 0),
      23.439291 * DEG,
    );
  }

  /**
   * The body's orientation in the equatorial frame, left in
   * `_equatorialOrientation`.
   *
   * A tidally locked moon has to be turned by where its parent really is, not by
   * where a model says it is — get this wrong for our own Moon and you are shown
   * the far side, which is both unmistakable and impossible. Everything else is
   * spun by the universe model, whose epoch phase is arbitrary; that is honest for
   * the giant planets, whose belts are what you see rather than any particular
   * meridian, and a known limitation for Mars.
   */
  _orient(body, state, geocentric) {
    if (body.key === 'moon') {
      // Towards Earth, which is straight back down the line of sight.
      const toParent = this._lockX.copy(geocentric.get('moon')).normalize().negate();
      // The Moon's axis is within a degree and a half of the ecliptic pole, close
      // enough that using the pole itself is below the resolution of anything
      // this view can show.
      const up = this._lockY.set(0, 1, 0).applyQuaternion(this._eclipticToEquatorial);
      const forward = this._lockZ.crossVectors(toParent, up).normalize();
      if (forward.lengthSq() < 1e-12) forward.set(0, 0, 1);
      up.crossVectors(forward, toParent).normalize();
      this._lockBasis.makeBasis(this._lockX.clone().negate(), up, forward);
      this._equatorialOrientation.setFromRotationMatrix(this._lockBasis);
      return;
    }

    if (state) {
      this._equatorialOrientation.copy(this._eclipticToEquatorial).multiply(state.orientation);
    } else {
      this._equatorialOrientation.identity();
    }
  }

  /**
   * Mean reflectance of an image, in linear light, or null if it cannot be read.
   *
   * Sampled at 32×16, which is far too coarse to see anything but is exactly
   * right for an average, and costs one draw call once per body. Texture data is
   * sRGB encoded, so it is decoded before averaging: skipping that step
   * overstates dark surfaces badly, which is the opposite of what is wanted here.
   */
  _measure(texture) {
    const image = texture?.image;
    if (!image?.width) return null;

    if (!this._probe) {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 16;
      this._probe = canvas.getContext('2d', { willReadFrequently: true });
    }
    const context = this._probe;

    try {
      context.clearRect(0, 0, 32, 16);
      context.drawImage(image, 0, 0, 32, 16);
      const { data } = context.getImageData(0, 0, 32, 16);
      let total = 0;
      for (let i = 0; i < data.length; i += 4) {
        // Rec. 709 luminance weights, on sRGB-decoded channels.
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        total += 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
      }
      return total / (data.length / 4);
    } catch {
      // Cross-origin or not yet decoded; the caller falls back to the palette.
      return null;
    }
  }

  /**
   * Exposure gain for a body, chosen so its lit face lands in the mid tones.
   *
   * Each body is presented at its own exposure — see the note in `update` — but
   * "its own exposure" was previously a single number for everything, and that is
   * what made Jupiter arrive as a white disc with its belts washed out. The gain
   * needed depends on how bright the imagery already is, and that varies by more
   * than a factor of ten: lunar maps are dark grey, Jupiter's are near-white
   * cream, and the surface classes for bodies with no imagery at all range from
   * charcoal to fresh snow. A number that suits the Moon overexposes Jupiter by
   * four stops.
   *
   * So it is measured rather than guessed: the mean reflectance of the map times
   * the body's albedo scaling gives the brightness the shader is starting from,
   * and the gain is whatever turns that into the target mid tone. This calibrates
   * itself for every body, including the ones with no imagery and the ones nobody
   * has hand-tuned, which matters when there are hundreds of moons.
   */
  _gain(key, planet) {
    const uniforms = planet.material.uniforms;
    const hasImagery = uniforms.uHasColourMap?.value > 0.5;

    // Measured once from imagery, but a body is drawn before its imagery has
    // finished downloading, so a palette-derived figure is provisional and gets
    // replaced when the map lands.
    const cached = this.gains.get(key);
    if (cached && (cached.measured || !hasImagery)) return cached.gain;

    let level = hasImagery ? this._measure(uniforms.uColourMap.value) : null;
    const measured = level !== null;

    if (level === null && uniforms.uPaletteA) {
      // No imagery, or not decoded yet: average the procedural palette instead.
      // Those colours are already linear, so nothing to decode.
      const stops = [uniforms.uPaletteA, uniforms.uPaletteB, uniforms.uPaletteC]
        .map((u) => u?.value)
        .filter(Boolean);
      if (stops.length) {
        level =
          stops.reduce((sum, c) => sum + 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, 0) /
          stops.length;
      }
    }
    if (!(level > 0)) return cached?.gain ?? null;

    const boost = uniforms.uAlbedoBoost?.value ?? 1;
    // Clamped because the measurement covers the whole map, including any black
    // margin, so it errs low for some bodies, and a runaway gain on a dark one is
    // worse than leaving it dark.
    const gain = clamp(TARGET_MID_TONE / (level * boost), 0.15, 2.6);
    this.gains.set(key, { gain, measured });
    return gain;
  }

  /** Creates the terrain body and starts its imagery downloading, once. */
  _acquire(key) {
    if (this.planets.has(key)) return this.planets.get(key);
    const spec = BODY_BY_KEY.get(key);
    if (!spec) return null;

    // Deeper than the solar system view's default, because from the ground the
    // zoom does not stop at a flyby distance: the field of view keeps narrowing,
    // and the mesh has to keep up or the last few decades of zoom magnify a
    // smooth ball. Affordable only alongside the view cone culling in `update`.
    const planet = new Planet({ ...spec, maxLevel: spec.maxLevel ?? 18 });
    this.planets.set(key, planet);
    this.group.add(planet.group);

    if (!this.requested.has(key)) {
      this.requested.add(key);
      this.textures.loadFar(key).then((maps) => {
        if (maps.colour) planet.setColourMap(maps.colour);
        if (maps.night) planet.setNightMap(maps.night);
        if (maps.ocean) planet.setOceanMap(maps.ocean);
        if (maps.dem) planet.setDemMap(maps.dem, maps.demInfo);
        if (maps.norm) planet.setNormalMap(maps.norm);
        if (maps.rings && spec.rings) {
          const rings = createRings({
            innerKm: spec.rings.innerKm,
            outerKm: spec.rings.outerKm,
            planetRadiusKm: planet.radius,
            texture: maps.rings,
          });
          planet.spin.add(rings.mesh);
          this.rings.set(key, rings);
        }
      });
    }

    return planet;
  }

  /**
   * @param {object} options
   * @param {object} options.ephemeris from solarSystemAt
   * @param {import('three').Matrix4} options.skyMatrix equatorial to world
   * @param {number} options.pixelsPerRadian
   * @param {number} options.exposure linear
   * @param {number} options.minPixels apparent diameter at which to take over
   */
  update({
    ephemeris,
    skyMatrix,
    pixelsPerRadian,
    exposure = 1,
    minPixels = 9,
    viewWorld = null,
    viewConeRadians = Math.PI,
  }) {
    this._skyRotation.setFromRotationMatrix(skyMatrix);

    // Geocentric vectors in the equatorial frame, in AU. Everything geometric is
    // worked out from these rather than from the universe model: the model's
    // circular orbits are only there to spin bodies on their axes, and for the
    // Moon in particular its orbital phase bears no relation to where the Moon
    // actually is, which lit a gibbous Moon as a thin crescent.
    const geocentric = new Map();
    for (const body of ephemeris.bodies) {
      geocentric.set(
        body.key,
        equatorialToVector(body.ra, body.dec, new Vector3()).multiplyScalar(body.distanceAu),
      );
    }
    const sunGeocentric = geocentric.get('sun');

    const active = new Set();

    for (const body of ephemeris.bodies) {
      const spec = BODY_BY_KEY.get(body.key);
      if (!spec || body.key === 'sun') continue;

      const apparentPixels = body.angularRadius * 2 * pixelsPerRadian;
      if (apparentPixels < minPixels) continue;

      const planet = this._acquire(body.key);
      if (!planet) continue;
      active.add(body.key);

      // Where it is. Uses the same conversion as every other layer in the view:
      // the ephemeris quotes right ascension and declination in degrees, and the
      // sky frame is y-up with the z axis reversed, neither of which is worth
      // rediscovering here.
      equatorialToVector(body.ra, body.dec, this._direction)
        .applyMatrix4(skyMatrix)
        .normalize();

      // How big it is: scaled so the rendered radius subtends the true angle at
      // the shell it is drawn on.
      const renderedRadius = Math.tan(body.angularRadius) * this.shellRadius;
      const scale = renderedRadius / spec.radiusKm;
      planet.group.position.copy(this._direction).multiplyScalar(this.shellRadius);
      planet.group.scale.setScalar(scale);

      // Which way round it is, in the equatorial frame.
      const state = this.universe.get(body.key);
      this._orient(body, state, geocentric);
      planet.group.quaternion.copy(this._skyRotation).multiply(this._equatorialOrientation);

      // Shading and level of detail work in the body's own rotating frame, at the
      // real distance: a hundred metre crater has to be a hundred metres whatever
      // shell the body is drawn on.
      const distanceKm = body.distanceAu * AU_KM;
      const geo = geocentric.get(body.key);
      this._inverse.copy(this._equatorialOrientation).invert();

      // Towards the observer, which for a body seen from the ground is simply
      // back along the line of sight.
      this._cameraLocal
        .copy(geo)
        .normalize()
        .negate()
        .applyQuaternion(this._inverse)
        .multiplyScalar(distanceKm);

      // Towards the Sun, from the Sun-body-Earth triangle the ephemeris gives.
      // This is what sets the phase, and it is the one thing a viewer can check
      // against the sky by eye.
      this._sunLocal
        .subVectors(sunGeocentric, geo)
        .applyQuaternion(this._inverse)
        .normalize();

      // The Sun's angular radius from this body, which sets the width of the
      // terminator and of every penumbra on it. It is not a constant: half a
      // degree at the Moon, a third of that at Saturn.
      const sunDistanceKm = this._toSun.subVectors(geo, sunGeocentric).length() * AU_KM;
      const sunAngular = SUN_RADIUS_KM / Math.max(sunDistanceKm, 1);

      // The Earth's shadow, and the light the Earth reflects.
      //
      // Both only apply to the Moon: nothing else in this view is close enough to
      // the Earth for either to register. Without them a total lunar eclipse
      // passed with the Moon at full brightness, which is the single most obvious
      // lighting event a ground observer can watch.
      let occluder;
      let shineDir;
      let shine = 0;
      if (body.key === 'moon') {
        // The Earth is the origin of the geocentric frame, so the vector from the
        // Moon to it is simply the reverse of the Moon's position.
        this._toHost
          .copy(geo)
          .multiplyScalar(-AU_KM)
          .applyQuaternion(this._inverse);
        occluder = this._occluder.set(
          this._toHost.x,
          this._toHost.y,
          this._toHost.z,
          EARTH_RADIUS_KM,
        );

        shineDir = this._shineDir.copy(this._toHost).normalize();
        shine = displayedReflectance(reflectedFraction({
          hostRadiusKm: EARTH_RADIUS_KM,
          separationKm: this._toHost.length(),
          hostAlbedo: physicalFor('earth')?.albedo ?? 0.43,
          phase: illuminatedFraction(this._sunLocal, shineDir),
        }));
      }

      planet.update({
        cameraLocal: this._cameraLocal,
        sunLocal: this._sunLocal,
        sunAngular,
        occluder,
        // The Earth has an atmosphere, so its shadow is never empty: this is the
        // copper light of a total lunar eclipse.
        umbraLight: occluder ? UMBRA_REFRACTED_LIGHT : 0,
        shineDir,
        shine,
        pixelsPerRadian,
        // Exposure is the viewer's, not the body's: a telescope is refocused and
        // re-stopped for whatever it is pointed at, so each body is presented at
        // its own natural exposure rather than scaled by the sunlight reaching it.
        // Neptune would otherwise arrive nine hundred times darker than Mars.
        //
        // The gain is per body and measured from its own imagery, because the
        // maps differ in brightness by more than a factor of ten; see _gain.
        sunIntensity: exposure * (this._gain(body.key, planet) ?? 1),
        // Which part of the body to spend the patch budget on. Zoomed right in,
        // only a sliver of the disc is on screen, and refining the whole globe to
        // the depth that sliver demands exhausts the budget and coarsens the very
        // detail being zoomed into.
        //
        // The cone is centred on the body rather than on the camera axis, because
        // the direction to the body's centre is already known in the body's own
        // frame — it is where the camera is — whereas the camera's forward
        // direction is in world space, and the two frames are separated by the
        // body's spin as well as its orientation. Instead the cone is opened wide
        // enough to cover the screen from there: half the screen diagonal, plus
        // however far off centre the body currently sits. Dead centre, which is
        // the case that matters, that is exactly the screen.
        // The margin is a proportion of the field rather than a fixed angle. Seen
        // from a quarter of a million kilometres the entire Moon lies within a
        // quarter of a degree of the axis, so a fixed margin of even one degree
        // culls nothing at all: the budget is then spread over the whole globe,
        // the far side is subdivided at the depth the near side asked for, and the
        // patches that were actually on screen are the ones dropped when it runs
        // out — which shows as an empty frame, not as coarse ground.
        viewLocal: this._viewLocal.copy(this._cameraLocal).normalize().negate(),
        coneCos: Math.cos(
          Math.min(
            viewConeRadians * 1.5 + (viewWorld ? this._direction.angleTo(viewWorld) : 0),
            1.55,
          ),
        ),
      });

      const rings = this.rings.get(body.key);
      if (rings) {
        rings.material.uniforms.uSunDir.value.copy(this._sunLocal);
        rings.material.uniforms.uCameraLocal.value.copy(this._cameraLocal);
        rings.material.uniforms.uSunIntensity.value = exposure;
        rings.material.uniforms.uPixelsPerRadian.value = pixelsPerRadian;
        rings.material.uniforms.uSunAngular.value = sunAngular;
      }

      // Elevation and imagery improve as it grows, exactly as on approach in the
      // solar system view.
      const wanted = Math.min(8192, 2 ** Math.ceil(Math.log2(Math.max(apparentPixels * 4, 64))));
      const colour = this.textures.level(body.key, 'colour', wanted);
      if (colour) planet.setColourMap(colour.texture);
      const dem = this.textures.demLevel(body.key, capTextureWidth(wanted, 'dem'));
      if (dem) planet.setDemMap(dem.texture, dem.info);
      const normals = this.textures.level(body.key, 'norm', capTextureWidth(wanted * 2, 'norm'));
      if (normals) planet.setNormalMap(normals.texture);
    }

    // Anything that has shrunk back below the threshold stops drawing, but is
    // kept: its geometry and imagery are expensive to build and cheap to hold,
    // and the same body is usually revisited.
    for (const [key, planet] of this.planets) {
      planet.group.visible = active.has(key);
    }

    return active;
  }
}
