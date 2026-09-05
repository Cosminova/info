import { Matrix4, Quaternion, Vector3 } from 'three';
import { DEG, dateToJulianDay, J2000, greenwichMeanSiderealTime } from '../astro.js';
import { PLANETS, heliocentric } from '../solar.js';
import { BODIES, SUN } from './bodies-data.js';
import { MOONS } from './moons-data.js';
import { isLocked } from './figures.js';

/**
 * Where everything is, in kilometres, in a right-handed world frame with
 * +Y along ecliptic north and +X towards the vernal equinox.
 *
 * The ephemeris code returns ecliptic rectangular coordinates with +z north, so
 * the mapping into a Y-up world is (x, z, -y); the sign on the last component is
 * what keeps the frame right-handed rather than mirroring every orbit.
 */

const AU_KM = 149597870.7;
const eclipticToWorld = (x, y, z, out) => out.set(x, z, -y);

/** Rotation carrying ecliptic north onto a body's own spin axis. */
function axisTiltQuaternion(tiltDeg, nodeDeg = 0) {
  const q = new Quaternion();
  const node = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), nodeDeg * DEG);
  const tilt = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), tiltDeg * DEG);
  return q.copy(node).multiply(tilt);
}

export class Universe {
  constructor() {
    this.states = new Map();
    const register = (spec) => {
      this.states.set(spec.key, {
        spec,
        position: new Vector3(),
        // Orientation of the body's rotating frame relative to the world.
        orientation: new Quaternion(),
        tilt: axisTiltQuaternion(spec.tiltDeg ?? 0),
        spinAngle: 0,
      });
    };
    register(SUN);
    for (const spec of BODIES) register(spec);
    for (const spec of MOONS) register(spec);

    this._lockX = new Vector3();
    this._lockY = new Vector3();
    this._lockZ = new Vector3();
    this._lockBasis = new Matrix4();
    this._tmp = new Vector3();
    this._spin = new Quaternion();
    this._axis = new Vector3(0, 1, 0);
  }

  get(key) {
    return this.states.get(key);
  }

  /** Advances every body to `date`. Parents are resolved before children. */
  update(date) {
    const jd = dateToJulianDay(date);
    const T = (jd - J2000) / 36525;
    const daysSinceEpoch = jd - J2000;

    const sun = this.states.get('sun');
    sun.position.set(0, 0, 0);

    // Planets first: their positions are absolute, and moons hang off them.
    for (const state of this.states.values()) {
      const spec = state.spec;
      if (spec.key === 'sun' || spec.parent !== 'sun') continue;

      const elements = PLANETS[spec.key];
      if (elements) {
        const helio = heliocentric(elements, T);
        eclipticToWorld(helio.x * AU_KM, helio.y * AU_KM, helio.z * AU_KM, state.position);
      } else if (spec.orbitOverride) {
        // Bodies outside the JPL table (Ceres) get a simple ellipse.
        const o = spec.orbitOverride;
        const meanAnomaly = ((daysSinceEpoch / o.periodDays) * 2 * Math.PI) % (2 * Math.PI);
        const a = o.aAu * AU_KM;
        const e = o.eccentricity;
        let E = meanAnomaly;
        for (let i = 0; i < 8; i++) {
          E -= (E - e * Math.sin(E) - meanAnomaly) / (1 - e * Math.cos(E));
        }
        const x = a * (Math.cos(E) - e);
        const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
        const incl = o.inclDeg * DEG;
        eclipticToWorld(x, y * Math.cos(incl), y * Math.sin(incl), state.position);
      }
    }

    // Then moons, in their parent's equatorial plane.
    for (const state of this.states.values()) {
      const spec = state.spec;
      if (!spec.orbitKm || spec.parent === 'sun') continue;
      const parent = this.states.get(spec.parent);
      if (!parent) continue;

      const angle = (daysSinceEpoch / spec.orbitDays) * 2 * Math.PI;
      const incl = (spec.orbitInclDeg ?? 0) * DEG;
      const r = spec.orbitKm;
      this._tmp.set(
        r * Math.cos(angle),
        r * Math.sin(angle) * Math.sin(incl),
        r * Math.sin(angle) * Math.cos(incl),
      );
      // Orbit follows the parent's equator, so inherit the parent's tilt.
      this._tmp.applyQuaternion(parent.tilt);
      state.position.copy(parent.position).add(this._tmp);
    }

    // Spin. Earth is tied to sidereal time so that noon really is noon; the
    // others use their rotation period from an arbitrary epoch phase, since
    // their prime meridians carry no meaning for the viewer.
    //
    // Tidally locked moons are the exception, and there is nothing arbitrary
    // about them: they keep one face towards their parent for ever. An arbitrary
    // phase puts the wrong face towards us, which for our own Moon means showing
    // the heavily cratered far side that nobody on Earth has ever seen.
    for (const state of this.states.values()) {
      const spec = state.spec;

      if (isLocked(spec)) {
        const parent = this.states.get(spec.parent);
        if (parent) {
          this._orientLocked(state, parent);
          continue;
        }
      }

      const period = spec.rotationHours ?? 0;
      let angle;
      if (spec.key === 'earth') {
        angle = greenwichMeanSiderealTime(jd) * DEG;
      } else if (period !== 0) {
        angle = ((daysSinceEpoch * 24) / period) * 2 * Math.PI;
      } else {
        angle = 0;
      }
      state.spinAngle = angle;
      this._spin.setFromAxisAngle(this._axis, angle);
      state.orientation.copy(state.tilt).multiply(this._spin);
    }

    return this;
  }

  /**
   * Points a moon's prime meridian at its parent.
   *
   * Built as a basis rather than as a spin angle, because the axis it would have
   * to be a rotation about depends on the parent's tilt and the moon's orbital
   * inclination, and solving for the angle is both fiddlier and easier to get
   * subtly wrong than simply naming the three axes. The prime meridian faces the
   * body's own -x direction, which is where dirToUv in the terrain shader places
   * the centre of an equirectangular map.
   */
  _orientLocked(state, parent) {
    // The body's +x points away from the parent, so its -x — where dirToUv puts
    // the centre of the map — faces it.
    const x = this._lockX.subVectors(state.position, parent.position).normalize();
    // Spin axis, which for a locked moon is normal to its orbit and so follows
    // the parent's equator.
    const up = this._lockY.set(0, 1, 0).applyQuaternion(parent.tilt);

    // Orthogonalise, because the parent does not generally sit exactly in the
    // moon's equatorial plane and a basis has to be square. Taken in this order
    // — z from x and the spin axis, then y from z and x — the result is right
    // handed by construction, since x × (z × x) = z. Deriving z the other way
    // round instead gives a basis with determinant -1, which is a reflection
    // rather than a rotation: setFromRotationMatrix then returns a quaternion
    // that is not a unit quaternion, and everything downstream that assumes one
    // — the conjugate used as an inverse, Matrix4.compose, a surface position
    // rotated into the world — is quietly wrong. It renders as a moon mirrored
    // east to west, which is subtle enough to survive being looked at.
    const z = this._lockZ.crossVectors(x, up).normalize();
    if (z.lengthSq() < 1e-12) z.set(0, 0, 1);
    up.crossVectors(z, x).normalize();

    this._lockBasis.makeBasis(x, up, z);
    state.orientation.setFromRotationMatrix(this._lockBasis);
    state.spinAngle = 0;
  }
}

export { AU_KM };
