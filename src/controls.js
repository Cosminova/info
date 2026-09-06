import { Vector3 } from 'three';
import { DEG, RAD } from './astro.js';
import { platform } from './engine/platform.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Shortest signed difference between two angles, in degrees. */
function angleDelta(from, to) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * Planetarium-style look controls.
 *
 * Orientation is stored as yaw/pitch so the horizon never tilts, and drag
 * sensitivity is derived from the current field of view, meaning one pixel of
 * mouse travel always moves the sky by one pixel no matter how deep the zoom.
 */
export class SkyControls {
  constructor(camera, domElement, options = {}) {
    this.camera = camera;
    this.dom = domElement;

    this.yaw = options.yaw ?? 0;
    this.pitch = options.pitch ?? 25;
    this.fov = options.fov ?? 75;
    this.fovTarget = this.fov;

    this.minFov = options.minFov ?? 0.035;
    this.maxFov = options.maxFov ?? 110;
    this.minPitch = options.minPitch ?? -89.5;
    this.maxPitch = options.maxPitch ?? 89.5;

    this.damping = options.damping ?? 5.2;
    this.zoomSmoothing = options.zoomSmoothing ?? 9;
    this.dragSensitivity = options.dragSensitivity ?? 1;

    this.velocityYaw = 0;
    this.velocityPitch = 0;
    this.dragging = false;
    this.tween = null;
    this.enabled = true;
    this.onInteract = options.onInteract ?? (() => {});

    // A function returning the world direction to keep centred, or null. See
    // `follow`.
    this._following = null;

    this._pointers = new Map();
    this._pinchDistance = 0;
    this._lastMove = 0;
    this._forward = new Vector3();

    this._bind();
    this.applyToCamera();
  }

  _bind() {
    const dom = this.dom;
    dom.style.touchAction = 'none';
    /*
     * Marks the document for the touch-only rules in ui/theme.css, which grow
     * everything you press to 44 points. The planetarium's interface is built
     * in markup and wired by main.js, and this is the only file it loads that
     * belongs to the touch port — so the flag is raised here, next to the other
     * line in this method that exists because a finger is not a mouse. The
     * explorer raises it in ui/explorer-ui.js, where it has a composition root
     * to do it from.
     */
    if (platform.touch) document.documentElement.classList.add('is-touch');

    this._onPointerDown = (event) => {
      if (!this.enabled) return;
      dom.setPointerCapture?.(event.pointerId);
      this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this._pointers.size === 1) {
        this.dragging = true;
        this.velocityYaw = 0;
        this.velocityPitch = 0;
        this.tween = null;
        this._dragMoved = 0;
        // Taking hold of the view gives up tracking, but only once the pointer
        // has actually moved: a click to select something must not immediately
        // cancel the tracking that selecting it turns on.
      } else if (this._pointers.size === 2) {
        this._pinchDistance = this._currentPinchDistance();
      }
      this.onInteract();
    };

    this._onPointerMove = (event) => {
      const prev = this._pointers.get(event.pointerId);
      if (!prev) return;
      const dx = event.clientX - prev.x;
      const dy = event.clientY - prev.y;
      prev.x = event.clientX;
      prev.y = event.clientY;

      if (this._pointers.size >= 2) {
        const distance = this._currentPinchDistance();
        if (this._pinchDistance > 0 && distance > 0) {
          this.zoomBy(Math.log(this._pinchDistance / distance) * 1.6);
        }
        this._pinchDistance = distance;
        return;
      }

      if (!this.dragging) return;
      const degPerPixel = (this.fov / this.dom.clientHeight) * this.dragSensitivity;
      const dYaw = dx * degPerPixel;
      const dPitch = dy * degPerPixel;

      this.yaw -= dYaw;
      this.pitch = clamp(this.pitch + dPitch, this.minPitch, this.maxPitch);
      this._dragMoved += Math.abs(dx) + Math.abs(dy);
      if (this._dragMoved > 6) this.follow(null);

      const now = performance.now();
      const dt = Math.max(1, now - this._lastMove) / 1000;
      this._lastMove = now;
      // Blend so a single jittery sample cannot fling the view.
      this.velocityYaw = this.velocityYaw * 0.55 + (-dYaw / dt) * 0.45;
      this.velocityPitch = this.velocityPitch * 0.55 + (dPitch / dt) * 0.45;
    };

    this._onPointerUp = (event) => {
      this._pointers.delete(event.pointerId);
      if (this._pointers.size === 0) this.dragging = false;
      if (this._pointers.size < 2) this._pinchDistance = 0;
    };

    this._onWheel = (event) => {
      if (!this.enabled) return;
      event.preventDefault();
      // Normalise line/page deltas to something close to pixel scroll.
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      this.zoomBy((event.deltaY * unit) / 420);
      this.onInteract();
    };

    this._onDoubleClick = (event) => {
      if (!this.enabled) return;
      const direction = this.screenToDirection(event.clientX, event.clientY);
      this.flyTo({ direction, fov: Math.max(this.minFov, this.fov / 4), duration: 900 });
    };

    dom.addEventListener('pointerdown', this._onPointerDown);
    dom.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
    dom.addEventListener('wheel', this._onWheel, { passive: false });
    dom.addEventListener('dblclick', this._onDoubleClick);
  }

  dispose() {
    const dom = this.dom;
    dom.removeEventListener('pointerdown', this._onPointerDown);
    dom.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    dom.removeEventListener('wheel', this._onWheel);
    dom.removeEventListener('dblclick', this._onDoubleClick);
  }

  _currentPinchDistance() {
    const points = [...this._pointers.values()];
    if (points.length < 2) return 0;
    return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
  }

  /**
   * Keeps something centred as the sky turns.
   *
   * Zoom without this is close to unusable, and no amount of reduced drag
   * sensitivity fixes it: the sky moves fifteen arcseconds a second, so at a one
   * arcminute field a planet crosses the frame and is gone in four seconds, and
   * at the deep end it leaves before you have looked at it. Tracking is what
   * turns "find it again, and again" into pointing a telescope with a drive on it.
   *
   * @param {(() => import('three').Vector3 | null) | null} getter world direction
   *   to centre, re-read every frame because both the target and the sky move
   */
  follow(getter) {
    this._following = getter ?? null;
  }

  get isFollowing() {
    return Boolean(this._following);
  }

  /** Exponential zoom keeps each notch feeling identical across 3.5 decades. */
  zoomBy(amount) {
    this.fovTarget = clamp(this.fovTarget * Math.exp(amount), this.minFov, this.maxFov);
    this.tween = null;
  }

  setFov(fov, immediate = false) {
    this.fovTarget = clamp(fov, this.minFov, this.maxFov);
    if (immediate) this.fov = this.fovTarget;
  }

  /** World-space direction the camera is pointing. */
  get direction() {
    const p = this.pitch * DEG;
    const y = this.yaw * DEG;
    const cp = Math.cos(p);
    return this._forward.set(-cp * Math.sin(y), Math.sin(p), cp * Math.cos(y));
  }

  static directionToYawPitch(direction) {
    const v = direction.clone().normalize();
    const pitch = Math.asin(clamp(v.y, -1, 1)) * RAD;
    const yaw = Math.atan2(-v.x, v.z) * RAD;
    return { yaw, pitch };
  }

  /** Converts a viewport pixel into a world direction using the live camera. */
  screenToDirection(clientX, clientY) {
    const rect = this.dom.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const v = new Vector3(ndcX, ndcY, 0.5).unproject(this.camera);
    return v.normalize();
  }

  flyTo({ direction, yaw, pitch, fov, duration = 1100 }) {
    let targetYaw = yaw;
    let targetPitch = pitch;
    if (direction) {
      const yp = SkyControls.directionToYawPitch(direction);
      targetYaw = yp.yaw;
      targetPitch = yp.pitch;
    }
    this.tween = {
      startYaw: this.yaw,
      startPitch: this.pitch,
      startFov: this.fov,
      deltaYaw: targetYaw === undefined ? 0 : angleDelta(this.yaw, targetYaw),
      targetPitch: targetPitch === undefined ? this.pitch : clamp(targetPitch, this.minPitch, this.maxPitch),
      targetFov: fov === undefined ? this.fov : clamp(fov, this.minFov, this.maxFov),
      elapsed: 0,
      duration,
    };
    this.velocityYaw = 0;
    this.velocityPitch = 0;
  }

  /** Jumps straight to an orientation, cancelling any easing in flight. */
  setOrientation({ direction, yaw, pitch, fov }) {
    if (direction) {
      const yp = SkyControls.directionToYawPitch(direction);
      this.yaw = yp.yaw;
      this.pitch = clamp(yp.pitch, this.minPitch, this.maxPitch);
    } else {
      if (yaw !== undefined) this.yaw = yaw;
      if (pitch !== undefined) this.pitch = clamp(pitch, this.minPitch, this.maxPitch);
    }
    if (fov !== undefined) {
      this.fov = clamp(fov, this.minFov, this.maxFov);
      this.fovTarget = this.fov;
    }
    this.tween = null;
    this.velocityYaw = 0;
    this.velocityPitch = 0;
    this.applyToCamera();
  }

  update(dt) {
    if (this.tween) {
      const t = this.tween;
      t.elapsed += dt * 1000;
      const k = easeInOutCubic(Math.min(1, t.elapsed / t.duration));
      this.yaw = t.startYaw + t.deltaYaw * k;
      this.pitch = t.startPitch + (t.targetPitch - t.startPitch) * k;
      // Interpolate zoom geometrically; linear FOV blending looks like it stalls.
      this.fov = t.startFov * Math.pow(t.targetFov / t.startFov, k);
      this.fovTarget = this.fov;
      if (t.elapsed >= t.duration) this.tween = null;
    } else {
      if (!this.dragging) {
        const decay = Math.exp(-this.damping * dt);
        this.yaw += this.velocityYaw * dt;
        this.pitch = clamp(this.pitch + this.velocityPitch * dt, this.minPitch, this.maxPitch);
        this.velocityYaw *= decay;
        this.velocityPitch *= decay;
        if (Math.abs(this.velocityYaw) < 0.01) this.velocityYaw = 0;
        if (Math.abs(this.velocityPitch) < 0.01) this.velocityPitch = 0;
      }
      const blend = 1 - Math.exp(-this.zoomSmoothing * dt);
      this.fov *= Math.pow(this.fovTarget / this.fov, blend);
    }

    // Tracking runs after the tween, so flying to a target and then holding it
    // are one continuous movement, and it is skipped while dragging so the view
    // does not fight the hand on it.
    if (this._following && !this.dragging) {
      const direction = this._following();
      if (direction) {
        const yp = SkyControls.directionToYawPitch(direction);
        if (this.tween) {
          // Retarget the flight rather than overriding it, or the ease would be
          // fighting a jump every frame.
          this.tween.deltaYaw = angleDelta(this.tween.startYaw, yp.yaw);
          this.tween.targetPitch = clamp(yp.pitch, this.minPitch, this.maxPitch);
        } else {
          this.yaw = yp.yaw;
          this.pitch = clamp(yp.pitch, this.minPitch, this.maxPitch);
          this.velocityYaw = 0;
          this.velocityPitch = 0;
        }
      }
    }

    this.yaw = ((this.yaw % 360) + 360) % 360;
    this.applyToCamera();
  }

  applyToCamera() {
    const camera = this.camera;
    camera.fov = this.fov;
    camera.position.set(0, 0, 0);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.direction);
    camera.updateProjectionMatrix();
  }

  /** Angular size of one device-independent pixel, in radians. */
  radiansPerPixel(viewportHeight) {
    return (this.fov * DEG) / Math.max(1, viewportHeight);
  }
}
