// Where a walking NPC's feet go, between the places their walk is planned by.
//
// A walk through a village is planned as a polyline: the lane's corners, the
// square, the front door. Those points can be twenty or thirty metres apart,
// and the ground between them is not a straight line. Taking the height by
// interpolating between the two corners put a resident a metre in the air over
// every dip in a street and up to their knees in every rise, and the height a
// node was stored with (a doorstep approach carries its building's floor
// height, two metres out from the door) is not the ground under it either.
//
// So the polyline only decides WHERE someone is. How high they stand is always
// asked of the walkable surface at that spot: the same terrain, bridge decks
// and building plinths the player's feet and the village residents resolve
// against.
//
// A rider is the exception. A point that carries a support matrix is on a
// train (or anything else that moves them), and its height belongs to the
// carriage floor, not to the ground the carriage is passing over.

/** Put a resolved point's height on the walkable surface under it. */
export function groundNpcWalkPoint(point, groundAt) {
  if (!point || typeof groundAt !== 'function') return point;
  if (point.supportMatrix || point.fixedY) return point;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) return point;
  const y = groundAt(point.x, point.z);
  if (Number.isFinite(y)) point.y = y;
  return point;
}

/**
 * The point `progress` of the way along a planned walk, grounded.
 *
 * `path` is `{ segments: [{ from, to, length }], total }`. Lengths may include
 * the planned rise; only the horizontal position is read from the segments.
 */
export function sampleNpcWalkSegments({ segments, total }, progress, from, to, groundAt = null) {
  let target = total * progress;
  for (const segment of segments) {
    if (target > segment.length) { target -= segment.length; continue; }
    const t = segment.length > 0 ? target / segment.length : 0;
    const fromY = Number.isFinite(segment.from.y) ? segment.from.y : from.y;
    const toY = Number.isFinite(segment.to.y) ? segment.to.y : to.y;
    return groundNpcWalkPoint({
      x: segment.from.x + (segment.to.x - segment.from.x) * t,
      y: fromY + (toY - fromY) * t,
      z: segment.from.z + (segment.to.z - segment.from.z) * t,
      heading: Math.atan2(segment.to.x - segment.from.x, segment.to.z - segment.from.z),
      progress, mode: 'walk',
    }, groundAt);
  }
  return groundNpcWalkPoint({ ...to, progress, mode: 'walk' }, groundAt);
}
