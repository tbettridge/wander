const TAU = Math.PI * 2;

export const COMPASS_POINTS = Object.freeze([
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]);

export function normalizeCompassHeading(heading = 0) {
  if (!Number.isFinite(heading)) return 0;
  return ((heading % TAU) + TAU) % TAU;
}

/**
 * World convention: +Z north, +X WEST. The renderer is right-handed with +Y
 * up, so someone facing +Z has +X on their left: calling +X east would make
 * the land the mirror image of its own map, with the sun (which rises at -X
 * and stands at -Z at noon, sky.js) rising in the west. The raw geometric
 * angle atan2(x, z) still drives rotations; only the compass reading flips.
 */
export function compassHeadingFromDirection(x = 0, z = 1) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.hypot(x, z) < 1e-6) return 0;
  return normalizeCompassHeading(Math.atan2(-x, z));
}

export function compassReading(heading = 0) {
  const normalized = normalizeCompassHeading(heading);
  const degrees = Math.round(normalized * 180 / Math.PI) % 360;
  const pointIndex = Math.round(normalized / TAU * COMPASS_POINTS.length) % COMPASS_POINTS.length;
  return Object.freeze({
    heading: normalized,
    degrees,
    point: COMPASS_POINTS[pointIndex],
  });
}

export function compassReadingFromDirection(x = 0, z = 1) {
  return compassReading(compassHeadingFromDirection(x, z));
}
