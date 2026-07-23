// Shadow scheduling policy kept renderer-independent so cadence and guard-band
// behavior can be regression-tested without WebGL.

const POLICIES = Object.freeze({
  potato: Object.freeze({ surfaceHz: 0, grassSize: 0, grassRange: 0, grassMove: Infinity, grassMaxAge: Infinity, grassFade: 0 }),
  low:    Object.freeze({ surfaceHz: 0, grassSize: 0, grassRange: 0, grassMove: Infinity, grassMaxAge: Infinity, grassFade: 0 }),
  medium: Object.freeze({ surfaceHz: 20, grassSize: 512,  grassRange: 72, grassMove: 24, grassMaxAge: 4.0, grassFade: 0.32 }),
  high:   Object.freeze({ surfaceHz: 30, grassSize: 1024, grassRange: 82, grassMove: 24, grassMaxAge: 4.0, grassFade: 0.32 }),
  ultra:  Object.freeze({ surfaceHz: 30, grassSize: 1024, grassRange: 82, grassMove: 24, grassMaxAge: 4.0, grassFade: 0.32 }),
});

export const GRASS_SHADOW_TAPS = 5;

export function shadowPolicyForTier(name) {
  return POLICIES[name] || POLICIES.high;
}

export function surfaceShadowDue(elapsed, hz, force = false) {
  if (force) return hz > 0;
  return hz > 0 && elapsed >= 1 / hz;
}

export function consumeSurfaceShadowInterval(elapsed, hz, force = false) {
  if (hz <= 0 || force) return 0;
  // Preserve fractional frame-time instead of resetting the accumulator. At
  // 60–90 fps, resetting turns a 30 Hz target into a quantized 20–24 Hz pass.
  return Math.max(0, elapsed - 1 / hz);
}

export function grassSnapshotDue({
  hasSnapshot,
  age,
  playerX,
  playerZ,
  anchorX,
  anchorZ,
  policy,
  force = false,
}) {
  if (!policy || policy.grassSize <= 0) return false;
  if (force || !hasSnapshot) return true;
  return age >= policy.grassMaxAge
    || Math.abs(playerX - anchorX) >= policy.grassMove
    || Math.abs(playerZ - anchorZ) >= policy.grassMove;
}
