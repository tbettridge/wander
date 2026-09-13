// Shared dimensions for the dedicated crossing model and its physical support.
export const CROSSING_LOG_LENGTH = 2.7;
export const CROSSING_LOG_RADIUS = 0.24;
export const CROSSING_LOG_SIDES = 7;
export const CROSSING_LOG_SCALE = 0.82;

// Upper surface of the tapered seven-sided trunk used by CylinderGeometry,
// rotated onto local X. Decorations never enlarge the walkable footprint.
export function crossingLogHeightAt(crossing, x, z) {
  const dx = x - crossing.x, dz = z - crossing.z;
  const along = dx * crossing.tangentX + dz * crossing.tangentZ;
  const across = -dx * crossing.tangentZ + dz * crossing.tangentX;
  const length = crossing.logLength ?? crossing.span + 1.8;
  if (Math.abs(along) > length / 2) return null;
  const radius = CROSSING_LOG_RADIUS * CROSSING_LOG_SCALE * (0.85 + 0.15 * (along / length + 0.5));
  let top = -Infinity;
  for (let i = 0; i < CROSSING_LOG_SIDES; i++) {
    const a = i * Math.PI * 2 / CROSSING_LOG_SIDES, b = (i + 1) * Math.PI * 2 / CROSSING_LOG_SIDES;
    const za = Math.cos(a) * radius, zb = Math.cos(b) * radius;
    if (across < Math.min(za, zb) || across > Math.max(za, zb) || Math.abs(zb - za) < 1e-12) continue;
    const t = (across - za) / (zb - za);
    top = Math.max(top, radius * (Math.sin(a) + (Math.sin(b) - Math.sin(a)) * t));
  }
  return Number.isFinite(top) ? crossing.surfaceY + top : null;
}
