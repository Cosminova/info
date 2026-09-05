import { Quaternion, Vector2, Vector3 } from 'three';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Fold an angle back into (-pi, pi].
 *
 * Orbit pitch runs all the way round rather than stopping just short of the
 * pole, so it has to be kept bounded somewhere or a long drag in one direction
 * accumulates without limit and eventually loses precision.
 */
const wrapAngle = (a) => {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
};

/**
 * Orbit-and-approach camera with a free-flight mode.
 *
 * Distance is stored as a multiple of the reference body's radius so one
 * scroll gesture carries you from a crater floor out past the Local Group
 * without the gain feeling wrong at either end. Zoom is multiplicative, and a
 * leftover velocity lets the view keep coasting after you lift your fingers —
 * the same continuous exponential zoom those fly-through films use.
 *
 * The camera's world position is held in ordinary JS numbers (float64). The
 * Three.js camera itself sits at the origin; the scene is translated to it
 * each frame, which is what keeps vertex positions inside float32.
 */
export class OrbitApproachControls {
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;

    this.targetKey = 'earth';
    this.targetPosition = new Vector3();
    this.targetRadius = 6371;

    this.yaw = 0.6;
    this.pitch = 0.25;
    this.distanceRadii = 4;

    this.lookYaw = 0;
    this.lookPitch = 0;

    this.yawVelocity = 0;
    this.pitchVelocity = 0;
    this.zoomVelocity = 0;
    this.damping = 0.9;
    this.zoomDamping = 0.92;
    this.zoomSpeed = 0.0016;
    this.orbitSensitivity = 0.0045;
    this.lookSensitivity = 0.0032;
    this.minDistanceRadii = 1.000001;
    this.maxDistanceRadii = 1e22;
    this.riding = false;
    this._riderUp = new Vector3(0, 1, 0);

    this.mode = 'orbit';
    this.flySpeed = 0.55;
    this.cruise = 0;
    this.earthView = false;
    this.groundUp = new Vector3(0, 1, 0);
    this.standHeightKm = 0.012;

    /**
     * Field of view in degrees, owned here rather than on the camera so the
     * interface has one place to read and write it and so it survives the
     * ground-view switch, which needs a wider field and has to put the previous
     * one back afterwards.
     */
    this.fov = camera.fov;
    /**
     * Low enough to be a telescope rather than a crop: about three thousand
     * times the naked-eye view, past what any instrument on the ground gets.
     *
     * It is a floor and not a limit — zooming through it stops magnifying and
     * starts travelling. Where to put it is therefore a question of how long to
     * spend magnifying before that happens, and magnifying has an end: a star
     * is a point at every magnification, so past a certain field there is one
     * dot on an empty sky and the only way to make progress is to go there.
     */
    this.minFov = 0.02;
    this.maxFov = 100;
    /**
     * The wheel is tuned for distance, which spans fifty e-folds; the field
     * spans eight. Feeding it the same impulse crosses the whole field range in
     * a single notch, so it is geared down to about two-thirds of a stop each.
     */
    this.fovZoomScale = 0.3;
    this._fovBeforeGround = camera.fov;
    this._fovBeforeRide = camera.fov;
    /** The field the look offsets are fractions of; see how they are applied. */
    this._lookFovReference = camera.fov;

    /**
     * In free flight the camera normally keeps whatever heading you left it
     * pointing. With tracking on it swings back to the target every frame, so
     * you can fly past something while keeping your eyes on it.
     */
    this.trackTarget = false;
    /** Return the look offsets to centre when nothing is driving them. */
    this.autoCenter = true;
    /**
     * Attitude the orbit offset is expressed in, or null for the world frame.
     * Set while orbiting a spacecraft so the framing rides with the craft.
     * @type {Quaternion|null}
     */
    this.bodyFrame = null;

    this.worldPosition = new Vector3();
    /**
     * The camera as an exact offset from the thing it was built relative to:
     * the key of that thing, and the vector from it to the camera.
     *
     * `worldPosition` is that sum, and a sum at interstellar magnitudes cannot
     * hold a small offset — a double spaced thirty metres apart eleven parsecs
     * out swallows a station-keeping distance whole. Anything that needs the
     * camera's position near a known body should subtract this instead of
     * subtracting two absolute positions.
     * @type {string|null}
     */
    this.originKey = null;
    this.originOffset = new Vector3();

    this._flight = null;
    this._dragging = null;
    this._moved = 0;
    this._pointers = new Map();
    this._pinch = 0;
    this._offset = new Vector3();
    this._quat = new Quaternion();
    this._lastDrag = new Vector2();
    this._forward = new Vector3();
    this._right = new Vector3();
    this._up = new Vector3();
    this._lookAt = new Vector3();
    this._keys = new Set();

    this.onClick = null;
    /** `(clientX, clientY) => void` on a right-click that was not a look-drag. */
    this.onContextMenu = null;
    /** `(clientX, clientY) => void` while the pointer moves and nothing is held. */
    this.onHover = null;

    this._bind();
  }

  _bind() {
    const dom = this.dom;
    dom.addEventListener('pointerdown', (event) => {
      if (event.button === 1) event.preventDefault();
      dom.setPointerCapture(event.pointerId);
      this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this._dragging = event.button === 2 || event.shiftKey || event.button === 1 ? 'look' : 'orbit';
      this._button = event.button;
      this._moved = 0;
      this._flight = null;
      this.cruise = 0;
    });
    dom.addEventListener('pointermove', (event) => {
      const previous = this._pointers.get(event.pointerId);
      if (!previous) {
        // Nothing held: this is a hover, which the reticle uses to name whatever
        // is under the cursor.
        this.onHover?.(event.clientX, event.clientY);
        return;
      }
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      previous.x = event.clientX;
      previous.y = event.clientY;
      this._moved += Math.hypot(dx, dy);

      if (this._pointers.size === 2) {
        this._handlePinch();
        return;
      }
      const scale = this.orbitSensitivity * clamp(Math.log10(Math.max(this.distanceRadii, 1.001)), 0.02, 2.4);
      if (this._dragging === 'look' || this.mode === 'fly' || this.earthView || this.riding) {
        const lookScale = this.lookSensitivity;
        this.lookYaw = clamp(this.lookYaw - dx * lookScale, -2.8, 2.8);
        this.lookPitch = clamp(this.lookPitch + dy * lookScale, -1.5, 1.5);
      } else {
        this.yaw -= dx * scale;
        this.pitch = wrapAngle(this.pitch + dy * scale);
        this._lastDrag.set(-dx * scale, dy * scale);
      }
    });
    const release = (event) => {
      const point = this._pointers.get(event.pointerId);
      this._pointers.delete(event.pointerId);
      if (this._pointers.size === 0) {
        if (this._dragging === 'orbit') {
          this.yawVelocity = this._lastDrag.x * 0.5;
          this.pitchVelocity = this._lastDrag.y * 0.5;
        }
        // A right-click opens the context menu, but only when it did not turn
        // into a look-drag — right-drag is how you look around, and a menu
        // appearing at the end of every one of those would be unusable.
        if (this._moved < 5 && point) {
          if (this._button === 2) this.onContextMenu?.(event.clientX, event.clientY);
          else if (this._button === 0) this.onClick?.(event.clientX, event.clientY);
        }
        this._dragging = null;
        this._button = -1;
        this._lastDrag.set(0, 0);
      }
      this._pinch = 0;
    };
    dom.addEventListener('pointerup', release);
    dom.addEventListener('pointercancel', release);
    dom.addEventListener('contextmenu', (event) => event.preventDefault());

    dom.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this._flight = null;
        this.cruise = 0;
        const impulse = event.deltaY * this.zoomSpeed;
        this.zoomVelocity += impulse;
        this.zoomBy(impulse * 0.35);
      },
      { passive: false },
    );

    window.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
      this._keys.add(event.code);
      if (event.code === 'KeyF') {
        this.earthView = false;
        this.mode = this.mode === 'fly' ? 'orbit' : 'fly';
        if (this.mode === 'orbit') {
          this.lookYaw = 0;
          this.lookPitch = 0;
        }
      }
    });
    window.addEventListener('keyup', (event) => {
      this._keys.delete(event.code);
    });
    // A key still down when the window loses focus never gets its keyup, and
    // the camera would go on thrusting in that direction indefinitely — which
    // looks less like a stuck key than like a camera that has run away on its
    // own. Coming back to a window that is flying itself is the same problem in
    // reverse, so the set is emptied on the way out.
    window.addEventListener('blur', () => this._keys.clear());
  }

  /**
   * Press or release a movement input from something that is not the keyboard.
   *
   * The on-screen flight controls go through here rather than moving the camera
   * themselves, so that thrust, its altitude-proportional speed, the boost
   * multiplier and the switch out of orbit mode all stay in one place and
   * cannot drift apart from what the keys do. `code` is a
   * `KeyboardEvent.code` — the buttons are labelled with the key they stand in
   * for, so the mapping is the same thing the user is being taught.
   */
  setInput(code, active) {
    if (active) this._keys.add(code);
    else this._keys.delete(code);
  }

  /** Release every movement input. Used when the controls go out of view. */
  clearInputs() {
    this._keys.clear();
  }

  /** Whether a movement input is currently held, from either source. */
  isInputDown(code) {
    return this._keys.has(code);
  }

  _handlePinch() {
    const points = [...this._pointers.values()];
    const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    if (this._pinch > 0 && distance > 0) {
      const amount = Math.log(this._pinch / distance) * 1.4;
      this.zoomVelocity += amount * 0.4;
      this.zoomBy(amount);
    }
    this._pinch = distance;
  }

  /**
   * Standing on the ground and riding a craft both pin the camera to something
   * and rebuild the distance from where that thing is, every frame, so changing
   * the distance in those modes writes to a value that is about to be
   * overwritten: the wheel does nothing at all. Narrow the field instead, which
   * is the zoom that means anything when you cannot move — a telescope.
   *
   * Widening past the widest field is then what lifts you off, so the gesture
   * stays one continuous motion: keep pulling back and eventually you leave.
   */
  zoomBy(amount) {
    if (this.earthView || this.riding) {
      const wide = this.riding ? this._fovBeforeRide : this._fovBeforeGround;
      const atFloor = amount < 0 && this.fov <= this.minFov * (1 + 1e-9);
      const atCeiling = amount > 0 && this.fov >= this.maxFov * (1 - 1e-9);
      if (!atFloor && !atCeiling) {
        this.fov = clamp(this.fov * Math.exp(amount * this.fovZoomScale), this.minFov, this.maxFov);
        return;
      }
      // Out of field to give, so let go of the ground and let distance take
      // over. Zooming in at the floor is someone still trying to reach what
      // they are looking at, and the field they get back is a wide one, so the
      // distance moves in by however much the field just gave up: the subject
      // is the same size on screen either side of the handover and the only
      // thing that changed is that they are now travelling rather than
      // magnifying. Without that the view jumps by the whole magnification.
      if (atFloor) this.distanceRadii *= this.fov / Math.max(wide, 1e-6);
      if (this.riding) this.setRiding(false);
      else this.earthView = false;
    }
    this.distanceRadii = clamp(
      this.distanceRadii * Math.exp(amount),
      this.minDistanceRadii,
      this.maxDistanceRadii,
    );
  }

  get altitudeKm() {
    return (this.distanceRadii - 1) * this.targetRadius;
  }

  get distanceKm() {
    return this.distanceRadii * this.targetRadius;
  }

  /**
   * Retarget without moving the camera: yaw, pitch and distance are rebuilt
   * from the current world position so the view does not jump.
   */
  setTarget(key, position, radius, { distanceRadii, keepCamera = true } = {}) {
    this.targetKey = key;
    this.targetPosition.copy(position);
    this.targetRadius = radius;
    if (distanceRadii !== undefined) {
      this.distanceRadii = distanceRadii;
      return;
    }
    if (!keepCamera) return;
    const dx = this.worldPosition.x - position.x;
    const dy = this.worldPosition.y - position.y;
    const dz = this.worldPosition.z - position.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-9) return;
    this.distanceRadii = clamp(dist / Math.max(radius, 1e-6), this.minDistanceRadii, this.maxDistanceRadii);
    this._anglesFrom(dx, dy, dz);
  }

  /**
   * Store yaw and pitch for a world-space offset from the target, in whatever
   * frame the offset is currently expressed in.
   */
  _anglesFrom(x, y, z) {
    const v = this._lookAt.set(x, y, z);
    if (this.bodyFrame) v.applyQuaternion(this._quat.copy(this.bodyFrame).invert());
    const dist = v.length() || 1;
    this.pitch = Math.asin(clamp(v.y / dist, -1, 1));
    this.yaw = Math.atan2(v.x, v.z);
  }

  /** Smooth approach. Distance interpolates geometrically. */
  flyTo(key, { distanceRadii = 3.2, duration = 2800, worldFrom, targetFrom, radiusFrom, arriveFrom } = {}) {
    this._flight = {
      key,
      fromDistance: this.distanceRadii,
      toDistance: distanceRadii,
      fromYaw: this.yaw,
      fromPitch: this.pitch,
      fromLookYaw: this.lookYaw,
      fromLookPitch: this.lookPitch,
      worldFrom: worldFrom?.clone() ?? this.worldPosition.clone(),
      targetFrom: targetFrom?.clone() ?? this.targetPosition.clone(),
      radiusFrom: radiusFrom ?? this.targetRadius,
      arriveFrom: arriveFrom?.clone() ?? null,
      start: performance.now(),
      duration,
    };
  }

  get flying() {
    return this._flight !== null;
  }

  /** Abandon an approach in progress and hold wherever the camera got to. */
  stopFlight() {
    this._flight = null;
    this.cruise = 0;
  }

  setFov(degrees) {
    this.fov = clamp(degrees, this.minFov, this.maxFov);
  }

  /**
   * The ground view needs a wider field than orbit does, and the field the user
   * chose has to come back when they leave it — so remember it on the way in
   * rather than restoring a hardcoded number on the way out.
   */
  setGroundView(enabled, groundFov = 58) {
    if (enabled && !this.earthView) this._fovBeforeGround = this.fov;
    this.earthView = enabled;
    this.fov = enabled ? groundFov : this._fovBeforeGround;
    if (enabled) this._lookFovReference = groundFov;
  }

  /**
   * Ride a spacecraft: the camera is pinned to it and turns with it, so what
   * you see is what the craft is pointed at rather than a view of the craft.
   *
   * The same shape as ground view, and for the same reason — the camera is
   * normally defined as a distance from a target, and both of these are cases
   * where it is instead attached to a moving thing and free to look around.
   */
  setRiding(enabled, riderFov = 62) {
    if (enabled && !this.riding) this._fovBeforeRide = this.fov;
    this.riding = enabled;
    this.fov = enabled ? riderFov : this._fovBeforeRide;
    if (enabled) this._lookFovReference = riderFov;
    if (enabled) {
      this.earthView = false;
      this._flight = null;
      this.cruise = 0;
      this.zoomVelocity = 0;
      this.lookYaw = 0;
      this.lookPitch = 0;
    }
  }

  /**
   * Drop to just above the surface and hand control to looking around, which is
   * what "surface camera" means when the camera is always a distance from a
   * body rather than parented to it.
   */
  descendToSurface({ altitudeFraction = 0.0008 } = {}) {
    this.earthView = false;
    this._flight = null;
    this.cruise = 0;
    this.zoomVelocity = 0;
    this.mode = 'orbit';
    this.distanceRadii = clamp(1 + altitudeFraction, this.minDistanceRadii, this.maxDistanceRadii);
    this.lookPitch = 0.35;
  }

  _applyKeys(dt) {
    const keys = this._keys;
    const thrust =
      (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) +
      (keys.has('KeyS') || keys.has('ArrowDown') ? -1 : 0);
    const strafe =
      (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) +
      (keys.has('KeyA') || keys.has('ArrowLeft') ? -1 : 0);
    const rise = (keys.has('KeyE') ? 1 : 0) + (keys.has('KeyQ') ? -1 : 0);
    if (!thrust && !strafe && !rise) return;

    if (this.earthView) {
      this.earthView = false;
    }
    // Thrusting means you have left the craft, the same way it means you have
    // left the ground. The app notices by watching the flag.
    if (this.riding) this.setRiding(false);

    this.mode = 'fly';
    this._flight = null;
    const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1;
    const speed = Math.max(this.altitudeKm, this.targetRadius * 0.002) * this.flySpeed * boost;
    this.worldPosition.addScaledVector(this._forward, thrust * speed * dt);
    this.worldPosition.addScaledVector(this._right, strafe * speed * dt);
    this.worldPosition.addScaledVector(this._up, rise * speed * dt);

    const dx = this.worldPosition.x - this.targetPosition.x;
    const dy = this.worldPosition.y - this.targetPosition.y;
    const dz = this.worldPosition.z - this.targetPosition.z;
    const dist = Math.hypot(dx, dy, dz);
    this.distanceRadii = clamp(dist / Math.max(this.targetRadius, 1e-6), this.minDistanceRadii, this.maxDistanceRadii);
    this.pitch = Math.asin(clamp(dy / dist, -1, 1));
    this.yaw = Math.atan2(dx, dz);
  }

  /**
   * @param {object} [station] if set, sit above this body and look at the target
   * @param {object} [rider] if set, ride this craft: `{ position, orientation,
   *   sizeKm }`, where the orientation's forward axis is where it is pointed
   */
  update(dt, targetPosition, targetRadius, station = null, rider = null) {
    this.targetPosition.copy(targetPosition);
    this.targetRadius = targetRadius;

    if (this.earthView && station) {
      this._flight = null;
      this.cruise = 0;
    }
    if (this.riding && rider) {
      this._flight = null;
      this.cruise = 0;
    }

    const flight = this._flight;
    if (flight) {
      const t = clamp((performance.now() - flight.start) / flight.duration, 0, 1);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.lookYaw = flight.fromLookYaw * (1 - ease);
      this.lookPitch = flight.fromLookPitch * (1 - ease);
      this.yaw = flight.fromYaw + (this.yaw - flight.fromYaw) * 0;
      const fromD = Math.max(flight.worldFrom.distanceTo(flight.targetFrom), 1e-6);
      const toD = flight.toDistance * targetRadius;
      const distance = fromD * Math.pow(toD / fromD, ease);
      const dir = this._offset.subVectors(flight.worldFrom, flight.targetFrom);
      if (dir.lengthSq() < 1e-12) dir.set(0, 0.15, 1);
      dir.normalize();
      if (flight.arriveFrom && flight.arriveFrom.lengthSq() > 1e-12) {
        this._lookAt.copy(flight.arriveFrom).normalize();
        dir.lerp(this._lookAt, ease).normalize();
      }
      const arrived = this._lookAt.copy(targetPosition).addScaledVector(dir, distance);
      const mixedTarget = this._right.copy(flight.targetFrom).lerp(targetPosition, ease);
      this.worldPosition.copy(flight.worldFrom).lerp(arrived, ease);
      const offset = this._offset.subVectors(this.worldPosition, mixedTarget);
      const dist = offset.length() || 1;
      this.distanceRadii = dist / Math.max(targetRadius, 1e-6);
      this._anglesFrom(offset.x, offset.y, offset.z);
      if (t >= 1) {
        this._flight = null;
        this.mode = 'orbit';
      }
    }

    if (this.cruise) {
      this.zoomBy(this.cruise * dt);
      if (this.distanceKm > 3.086e19) this.cruise = 0;
    }
    if (Math.abs(this.zoomVelocity) > 1e-7) {
      this.zoomBy(this.zoomVelocity * dt * 60);
      this.zoomVelocity *= Math.pow(this.zoomDamping, dt * 60);
      if (Math.abs(this.zoomVelocity) < 1e-6) this.zoomVelocity = 0;
    }

    this.yaw += this.yawVelocity;
    // Wrapped, not clamped. Orbit pitch used to stop 89 degrees up so the frame
    // below would not go singular at the pole; it now carries straight over the
    // top and down the far side, which is handled where the up vector is built.
    this.pitch = wrapAngle(this.pitch + this.pitchVelocity);
    const decay = Math.pow(this.damping, dt * 60);
    this.yawVelocity *= decay;
    this.pitchVelocity *= decay;
    if (Math.abs(this.yawVelocity) < 1e-7) this.yawVelocity = 0;
    if (Math.abs(this.pitchVelocity) < 1e-7) this.pitchVelocity = 0;

    const distanceKm = this.distanceRadii * this.targetRadius;
    const cp = Math.cos(this.pitch);
    this._offset.set(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    );
    // Orbiting something small and fast is only stable in that thing's own
    // frame: a world-frame offset slides around the hull as the craft turns,
    // and a spacecraft framed three-quarters on would end up edge-on within a
    // few minutes of flight. Rotating the offset by the target's attitude keeps
    // the view where it was put, and a drag still means what it looks like.
    if (this.bodyFrame) this._offset.applyQuaternion(this.bodyFrame);

    let forward;
    if (this.riding && rider && !flight) {
      // Sit a little back and above the craft's own origin, along its own axes,
      // so its dish or panels are in the bottom of the frame and you are looking
      // out past them. The offset scales with the craft: the same view of a
      // twelve-metre probe and a hundred-metre station.
      this._forward.set(0, 0, 1).applyQuaternion(rider.orientation);
      this._up.set(0, 1, 0).applyQuaternion(rider.orientation);
      const reach = Math.max(rider.sizeKm, 2e-6);
      this.originKey = rider.key ?? null;
      this.originOffset
        .set(0, 0, 0)
        .addScaledVector(this._forward, -reach * 0.55)
        .addScaledVector(this._up, reach * 0.28);
      this.worldPosition.copy(rider.position).add(this.originOffset);
      forward = this._forward;
      this._riderUp.copy(this._up);

      // Keep the distance readouts and the near plane honest: they are still
      // measured to whatever the target is, which is usually not this craft.
      const camDist = Math.max(this.worldPosition.distanceTo(targetPosition), 1e-9);
      this.distanceRadii = clamp(camDist / Math.max(targetRadius, 1e-6), this.minDistanceRadii, this.maxDistanceRadii);
      this._anglesFrom(
        this.worldPosition.x - targetPosition.x,
        this.worldPosition.y - targetPosition.y,
        this.worldPosition.z - targetPosition.z,
      );
    } else if (this.earthView && station && !flight) {
      const toTarget = this._forward.subVectors(targetPosition, station.position);
      const reach = toTarget.length() || 1;
      toTarget.multiplyScalar(1 / reach);
      if (station.sunPosition) {
        this._lookAt.subVectors(station.sunPosition, station.position).normalize();
        this._right.copy(toTarget).cross(this._lookAt);
        if (this._right.lengthSq() < 1e-10) this._right.set(0, 1, 0).cross(toTarget);
      } else {
        this._right.set(0, 1, 0).cross(toTarget);
      }
      if (this._right.lengthSq() < 1e-10) this._right.set(1, 0, 0);
      this._right.normalize();
      const tilt = 1.42;
      this.groundUp.copy(toTarget).applyAxisAngle(this._right, tilt);
      const sunlit = station.sunPosition ? this.groundUp.dot(this._lookAt) > 0 : true;
      if (station.night ? sunlit : !sunlit) {
        this.groundUp.copy(toTarget).applyAxisAngle(this._right, -tilt);
      }
      this.originKey = station.key ?? null;
      this.originOffset
        .copy(this.groundUp)
        .multiplyScalar(station.radius + (station.altitude ?? this.standHeightKm));
      this.worldPosition.copy(station.position).add(this.originOffset);
      forward = this._forward.subVectors(targetPosition, this.worldPosition);
      const camDist = forward.length() || 1;
      forward.multiplyScalar(1 / camDist);
      this.distanceRadii = clamp(camDist / Math.max(targetRadius, 1e-6), this.minDistanceRadii, this.maxDistanceRadii);
      this._anglesFrom(
        this.worldPosition.x - targetPosition.x,
        this.worldPosition.y - targetPosition.y,
        this.worldPosition.z - targetPosition.z,
      );
    } else {
      if (!flight) {
        this.originKey = this.targetKey;
        this.originOffset.copy(this._offset).multiplyScalar(distanceKm);
        this.worldPosition.copy(this.targetPosition).add(this.originOffset);
      } else {
        // A flight interpolates between two absolute positions, so there is no
        // exact offset to hand out; it is also nowhere near anything yet.
        this.originKey = null;
      }
      forward = this._forward.copy(this._offset).negate();
    }
    // Which way is up depends on which side of the pole the camera is on.
    //
    // Orbiting used to stop just short of straight overhead. The reason is
    // real: at the pole the view direction is parallel to world up, their cross
    // product is zero, and there is no way to say which way the horizon lies —
    // so the camera would snap to an arbitrary roll. Clamping avoided it by
    // making the top of the orbit unreachable.
    //
    // Carrying on over the top instead only needs the up vector to invert as
    // the camera passes the pole. Do that and the right vector coming out of
    // the cross product is continuous across the crossing rather than
    // reversing, so the horizon does not roll and the pass reads as one smooth
    // movement. Exactly at the pole the cross product is still degenerate, so
    // the fallback below is the limit the two sides agree on rather than a
    // fixed axis, which is what keeps that single frame from jumping.
    const orbiting = !this.riding && !this.earthView;
    if (orbiting) {
      // Take the horizon straight from the yaw instead of from a cross product.
      //
      // Crossing world up with the view direction is the usual way to do this
      // and it is exactly what forced the pitch clamp: at the pole the two are
      // parallel, the product is zero, and the frame is undefined. Working the
      // limit out by hand gives a horizon that depends only on the yaw and
      // agrees with the cross product to within rounding at every pitch away
      // from the pole — and unlike the cross product it is perfectly well
      // defined at the pole itself. So the singularity does not need avoiding,
      // guarding, or nudging past; it stops existing, and the camera can carry
      // on over the top and down the far side.
      //
      // Past vertical the up vector comes out below the horizon, which is
      // correct rather than a bug: you are looking at the underside of the
      // orbit, and the view is upside down in world terms because you are.
      this._right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
      if (this.bodyFrame) this._right.applyQuaternion(this.bodyFrame);
      this._right.addScaledVector(forward, -this._right.dot(forward));
      if (this._right.lengthSq() < 1e-8) this._right.set(1, 0, 0);
    } else {
      const worldUp = this.riding && rider ? this._riderUp : this.groundUp;
      this._right.crossVectors(worldUp, forward);
      if (this._right.lengthSq() < 1e-8) this._right.set(1, 0, 0);
    }
    this._right.normalize();
    this._up.crossVectors(forward, this._right).normalize();

    // Free-look turns the whole frame, not just the view direction.
    //
    // This used to rotate the forward vector and then rebuild the horizon by
    // crossing it with world up again, which put the pole singularity back
    // right after the work above had removed it. Carrying all three axes
    // through the same two rotations keeps them orthonormal by construction,
    // needs no rebuild, and cannot go degenerate: each rotation leaves its own
    // axis alone and turns the other two.
    //
    // Pinned to the ground or to a craft, those two offsets are read as
    // fractions of the field rather than as angles. The subject then holds its
    // place on screen while the field narrows, and a drag moves the view by the
    // same number of pixels at any magnification. Held as angles they would do
    // neither: the three degrees this view opens with is a sixteenth of a wide
    // field and eight hundred fields at full magnification, so zooming in would
    // swing the subject off screen and a one-pixel drag would lose it.
    const lookScale = orbiting ? 1 : this.fov / Math.max(this._lookFovReference, 1e-6);
    const lookYaw = this.lookYaw * lookScale;
    const lookPitch = this.lookPitch * lookScale;
    if (lookYaw) {
      this._quat.setFromAxisAngle(this._up, lookYaw);
      forward.applyQuaternion(this._quat);
      this._right.applyQuaternion(this._quat);
    }
    if (lookPitch) {
      this._quat.setFromAxisAngle(this._right, lookPitch);
      forward.applyQuaternion(this._quat);
      this._up.applyQuaternion(this._quat);
    }

    this._applyKeys(dt);

    // Tracking, applied after the keys so a frame of thrust cannot leave the
    // target off-centre. Only meaningful in free flight: an orbit camera is
    // already pointed at what it is orbiting.
    if (this.trackTarget && this.mode === 'fly' && !flight && !this.earthView) {
      forward.subVectors(this.targetPosition, this.worldPosition);
      if (forward.lengthSq() < 1e-12) forward.set(0, 0, 1);
      forward.normalize();
      this._right.crossVectors(this._lookAt.set(0, 1, 0), forward);
      if (this._right.lengthSq() < 1e-8) this._right.set(1, 0, 0);
      else this._right.normalize();
      this._up.crossVectors(forward, this._right).normalize();
      this.lookYaw = 0;
      this.lookPitch = 0;
    } else if (this.autoCenter && this.mode === 'orbit' && !flight && !this.earthView && !this.riding && !this._dragging) {
      // Ease the look offsets back to centre so an orbit view recovers from a
      // shift-drag instead of staying permanently askew.
      const pull = Math.pow(0.86, dt * 60);
      this.lookYaw *= pull;
      this.lookPitch *= pull;
      if (Math.abs(this.lookYaw) < 1e-4) this.lookYaw = 0;
      if (Math.abs(this.lookPitch) < 1e-4) this.lookPitch = 0;
    }

    if (this.camera.fov !== this.fov) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    this.camera.position.set(0, 0, 0);
    this.camera.up.copy(this._up);
    this.camera.lookAt(this._lookAt.copy(forward));
  }
}
