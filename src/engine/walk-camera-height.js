// Camera suspension in kilometres. Collision support remains authoritative;
// smoothing may spend part of the eye-height margin, never cross the floor.
export function smoothWalkHeight(previous, floor, eye, dt) {
  const target = floor + eye;
  if (!Number.isFinite(previous) || dt <= 0 || eye > 0.01) return target;
  const blended = previous + (target - previous) * -Math.expm1(-dt / 0.22);
  return Math.max(floor + Math.min(eye, 0.001), Math.min(target + 0.0006, blended));
}
