// Where a village's horses stand.
//
// A horse belongs to a settlement, so the ground it may occupy is the ground
// the settlement leaves open: the town square, or the common just past the last
// house. Nowhere in between. The gaps between houses are yards, gardens and
// alleys — a horse standing in one is a horse standing in somebody's front
// room, which is exactly what a plain "somewhere near a settlement" spawn used
// to produce, because a random point inside the halo lands on a building as
// readily as beside one.
//
// The other half of the problem was that the halo was enormous next to the
// village inside it: picking uniformly out to 190m put nearly every horse in an
// empty field over the hill, so the animals belonging to a village were the one
// place you never saw them. Resolving every horse onto one of the two legal
// bands fixes the siting and the visibility together.
//
// THREE-free, so the siting can be asserted without a renderer.

import { buildingSpan, pointInsideBuilding } from './settlementplan.mjs';
import { propCollisionRadius } from './settlementprops.mjs';

const TAU = Math.PI * 2;

// Room for a horse to stand without clipping a wall or a market stall.
export const HORSE_CLEARANCE = 2.4;
// Where the common starts, measured out from the furthest building's far
// corner. Far enough to read as "outside the town" rather than as a horse
// pressed up against a gable.
export const OUTSIDE_MARGIN = 22;
// And how deep that grazing band runs, so the horses around a village are not
// all standing on one circle. Kept shallow: at 55 the far edge put horses some
// 78m beyond the last house, which is a different field rather than the edge of
// this town, and from the square they were specks.
export const PASTURE_BAND = 34;
// How much of the time the horses are in the square rather than out on the
// common. A minority, because a market square full of loose horses reads as a
// horse fair rather than as a village — but not so small a minority that it
// rounds to none: only two or three groups are ever loaded near a village at
// once, so a third-share regularly meant an empty square.
export const SQUARE_SHARE = 0.40;

/** How far the settlement is actually built out, from its centre. */
export function builtRadius(plan, site) {
  let reach = 0;
  for (const building of plan.buildings) {
    const distance = Math.hypot(building.x - site.x, building.z - site.z)
      + buildingSpan(building);
    if (distance > reach) reach = distance;
  }
  return reach;
}

/** Can a horse stand here without being inside a building or a fixture? */
export function groundIsClear(plan, x, z, clearance = HORSE_CLEARANCE) {
  for (const building of plan.buildings) {
    if (pointInsideBuilding(building, x, z, clearance)) return false;
  }
  for (const prop of plan.props || []) {
    const radius = propCollisionRadius(prop);
    if (radius > 0 && Math.hypot(prop.x - x, prop.z - z) < radius + clearance) return false;
  }
  return true;
}

/**
 * A standing place around the edge of the square.
 *
 * Out toward the rim rather than the middle: the centre is the well and the
 * market, which is where people walk and where a horse would be in the way.
 */
function squareStanding(plan, square, roll) {
  const ring = Math.max(2, square.radius * 0.66);
  const base = roll * TAU;
  for (let i = 0; i < 16; i++) {
    const angle = base + (i / 16) * TAU;
    const x = square.x + Math.cos(angle) * ring;
    const z = square.z + Math.sin(angle) * ring;
    if (groundIsClear(plan, x, z)) return { x, z, where: 'square' };
  }
  return null;
}

/**
 * A standing place out on the common, keeping the bearing it was heading for so
 * horses stay spread around the village rather than stacking on one side.
 */
function commonStanding(plan, site, reach, bearing, roll) {
  const depth = roll * PASTURE_BAND;
  for (let step = 0; step < 10; step++) {
    // Walk outward on failure: an outlying barn or a mill is the usual reason
    // the first ring is refused.
    const radius = reach + OUTSIDE_MARGIN + depth + step * 9;
    const x = site.x + Math.cos(bearing) * radius;
    const z = site.z + Math.sin(bearing) * radius;
    if (groundIsClear(plan, x, z)) return { x, z, where: 'common' };
  }
  return null;
}

/**
 * Resolve a candidate spawn point onto ground a horse may actually stand on.
 *
 * `roll` is a single deterministic 0..1 draw, so the same cell resolves to the
 * same place every time it streams back in.
 *
 * Returns null when neither band can be satisfied, which the caller must treat
 * as "no horse here" rather than falling back to the original point — the
 * original point is the one we already know may be inside a house.
 */
export function resolveHorseGround(plan, site, x, z, roll = 0.5) {
  const reach = builtRadius(plan, site);
  const bearing = Math.atan2(z - site.z, x - site.x);
  const distance = Math.hypot(x - site.x, z - site.z);
  const bandStart = reach + OUTSIDE_MARGIN;

  // Already standing on the common, in the band, and clear of everything: the
  // point it picked for itself is a good one, so keep the scatter.
  if (distance >= bandStart && distance <= bandStart + PASTURE_BAND
    && groundIsClear(plan, x, z)) {
    return { x, z, where: 'common' };
  }

  if (plan.square && roll < SQUARE_SHARE) {
    const inSquare = squareStanding(plan, plan.square, roll / SQUARE_SHARE);
    if (inSquare) return inSquare;
  }
  return commonStanding(plan, site, reach, bearing,
    plan.square ? (roll - SQUARE_SHARE) / (1 - SQUARE_SHARE) : roll);
}
