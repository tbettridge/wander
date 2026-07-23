// Pure screen-overlay policy kept separate from the long-lived cave module.
// The browser can therefore cache cave lighting without making a newly-added
// UI export incompatible with an older module graph during local iteration.

function clamp01(value) { return Math.max(0, Math.min(1, value)); }
function smoothstep(a, b, value) {
  const t = clamp01((value - a) / Math.max(1e-9, b - a));
  return t * t * (3 - 2 * t);
}

// The fullscreen underwater wash belongs to the surface ocean/river volume,
// not to every world-space point below sea level. Sea caves routinely descend
// below y=0 while remaining dry, so cave air suppresses that surface overlay.
// Both boundaries are eased to avoid introducing another screen-wide switch.
export function surfaceWaterOverlayOpacity(
  waterDepth,
  caveFactor = 0,
  caveTarget = 0,
  insideCave = false,
) {
  if (!(waterDepth > 0)) return 0;
  const submerged = smoothstep(0, 0.35, waterDepth);
  if (insideCave) return 0;
  const caveAir = smoothstep(0.002, 0.025, Math.max(caveFactor, caveTarget));
  return submerged * (1 - caveAir);
}
