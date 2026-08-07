// How fast the player covers ground, on foot and in the saddle.
//
// These live together, and away from Three.js, because the saddle speeds are
// defined against the on-foot ones rather than in absolute metres: the point of
// a horse is that it is faster than walking, so the two must move together. Had
// they been declared in their own modules, tuning the walk would have quietly
// made riding pointless.

export const WALK_SPEED = 4.8;
export const SPRINT_SPEED = 10.5;

// A horse is worth getting on. Every pace is a quarter faster than covering the
// same ground on your own legs, and the sprint key means the same thing in the
// saddle as it does out of it — hold it and you go from a working trot to a
// gallop.
export const RIDING_SPEEDUP = 1.25;
export const RIDDEN_TROT_SPEED = WALK_SPEED * RIDING_SPEEDUP;
export const RIDDEN_GALLOP_SPEED = SPRINT_SPEED * RIDING_SPEEDUP;
