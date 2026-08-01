// Where a trail meets water, and what stands there.
//
// This is the single source of truth for a crossing. The chunk builder asks it
// what to build; the player's feet and an NPC's gait ask it what to stand on.
// They have to be the same answer — a deck the eye can see and the foot walks
// through is worse than no deck at all — so the decision lives in one place
// rather than being derived twice.
//
// A crossing is measured ALONG THE TRAIL, in arc length, never along a straight
// line between its banks. A bridge carries the path. Laid as a straight chord it
// departs from the path it was built for — measured at 8m of drift on a long
// span — so the walker steps off the side of their own bridge, and the
// structure visibly cuts across the route instead of following it.
//
// THREE-free, so a crossing can be asserted without a renderer.

import { trailFrameAtArc } from './trails.js';

const BANK_SEARCH_REACH = 90;   // how far past the water to hunt for solid ground
const BANK_SEARCH_STEP = 1.5;
const WATER_WALK_REACH = 420;   // rivers here run to ~350m
const WATER_WALK_STEP = 1.0;

export const DECK_BOARD_SPACING = 0.52;
// Fallback only. A deck's real width comes from the trail it carries — see
// deckHalfWidth. A fixed 1.35 here was the bug that made bridges unusable: a
// primary trail is 3.7m across and the deck was 2.1m, so a walker following the
// worn path stepped past the edge of the bridge and into the river.
export const DECK_HALF_WIDTH = 1.35;
// How far past the last plank the footing reaches.
//
// The deck boards span exactly deckHalfWidth either side of the centreline, so
// this is the only slack between what the eye sees and what the foot finds. It
// is small on purpose: a quarter metre keeps the very edge of the last plank
// from being a knife-edge that a walker's point-sized position can fall past,
// and nothing more.
//
// It was briefly 8m while the fall-through was being hunted. Width was never
// the cause — a bridge deck sounded and behaved like the river beneath it
// because the wading test read the map under the player rather than the deck
// carrying them — so the footing matches the geometry again.
export const DECK_EDGE_MARGIN = 0.25;

/**
 * How wide a crossing's deck is, taken from the path it carries.
 *
 * A bridge exists to carry a trail, so it is as wide as the trail. Anything
 * narrower is a walker following the worn ground straight off the side.
 */
export function deckHalfWidth(edge) {
  return Math.max(1.1, edge?.width || DECK_HALF_WIDTH);
}
// A deck is only underfoot if you are already at about its level. Approaching
// along a bank you step up onto it; wading beneath a bridge you do not get
// yanked onto the deck from the riverbed.
export const DECK_STEP_UP = 0.65;
// The deck meets solid ground at each abutment rather than stopping dead on a
// mathematical boundary, so the last step onto the bank cannot fall through a
// seam between two positions differing in their last decimal place.
export const DECK_END_TOLERANCE = 0.4;
// How high a bridge deck wants to stand over the water, and the least it will
// accept where the banks simply are not that tall.
export const DECK_WATER_CLEARANCE = 1.05;
export const DECK_MIN_CLEARANCE = 0.45;

const _frame = {};

/** Solid, walkable ground — not water, not a cliff, not below the waterline. */
export function drySite(world, x, z, maxSlope = 0.48) {
  const site = world.biomeAt(x, z);
  return site.h > 0.55 && site.slope <= maxSlope && !world.riverAt(x, z).wet ? site : null;
}

/** Nearest point on an edge's centreline, as a distance and an arc position. */
export function nearestArcOnEdge(edge, x, z) {
  const s = edge.segments;
  let best = Infinity, bestI = 0, bestT = 0;
  for (let i = 0; i < s.count; i++) {
    let t = ((x - s.ax[i]) * s.dx[i] + (z - s.az[i]) * s.dz[i]) * s.invLen2[i];
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = s.ax[i] + s.dx[i] * t, qz = s.az[i] + s.dz[i] * t;
    const d2 = (x - qx) ** 2 + (z - qz) ** 2;
    if (d2 < best) { best = d2; bestI = i; bestT = t; }
  }
  return {
    distance: Math.sqrt(best),
    arc: s.arc[bestI] + bestT * (s.len[bestI] || 0),
  };
}

/**
 * Resolve one ford on one trail edge into the crossing that belongs there.
 *
 * Returns null when nothing can be built — no dry ground within reach along the
 * trail on either side.
 */
export function solveCrossing(world, edge, crossing) {
  // The ford already records where the water started and stopped along the
  // route. Work outward from there in arc length, so everything that follows is
  // expressed in the path's own coordinates.
  const wetStart = crossing.arcStart ?? crossing.arcPosition ?? 0;
  const wetEnd = crossing.arcEnd ?? wetStart;
  let arcIn = wetStart;
  let arcOut = wetEnd;
  for (let d = 0; d <= WATER_WALK_REACH; d += WATER_WALK_STEP) {
    const arc = wetStart - d;
    if (arc < 0) break;
    trailFrameAtArc(edge, arc, _frame);
    if (!world.riverAt(_frame.x, _frame.z).wet) break;
    arcIn = arc;
  }
  for (let d = 0; d <= WATER_WALK_REACH; d += WATER_WALK_STEP) {
    const arc = wetEnd + d;
    if (arc > edge.arcLength) break;
    trailFrameAtArc(edge, arc, _frame);
    if (!world.riverAt(_frame.x, _frame.z).wet) break;
    arcOut = arc;
  }

  // Abutments: walk out along the trail until the ground has risen to the level
  // the deck wants to sit at. Stopping at the first dry ground instead — as this
  // did — leaves the deck hanging in the air over a low bank by as much as 8m,
  // which is not only wrong to look at: it is more than a step, so the deck can
  // never be climbed onto and a walker passes straight through it.
  const findAbutment = (fromArc, direction, targetY) => {
    let best = null;
    for (let d = 1.5; d <= BANK_SEARCH_REACH; d += BANK_SEARCH_STEP) {
      const arc = fromArc + direction * d;
      if (arc < 0 || arc > edge.arcLength) break;
      trailFrameAtArc(edge, arc, _frame);
      const site = drySite(world, _frame.x, _frame.z);
      if (!site) continue;
      // Remember the highest dry ground seen, in case nothing reaches the mark.
      if (!best || site.h > best.site.h) best = { site, arc, x: _frame.x, z: _frame.z };
      if (site.h >= targetY) return { site, arc, x: _frame.x, z: _frame.z };
    }
    return best;
  };

  const centreProbe = trailFrameAtArc(edge, (arcIn + arcOut) * 0.5, {});
  const centreWater = world.riverAt(centreProbe.x, centreProbe.z);
  const water = centreWater.wet ? centreWater.y : world.height(centreProbe.x, centreProbe.z);

  // First pass: where does the ground first stand high enough to carry a deck
  // that clears the water?
  const wantY = water + DECK_WATER_CLEARANCE;
  const firstA = findAbutment(arcIn, -1, wantY);
  const firstB = findAbutment(arcOut, 1, wantY);
  if (!firstA || !firstB) return null;

  // The deck sits at the LOWER of the two, so the low end is flush and the high
  // end is a step down — a step down is walkable, a step up is not.
  const deckY = Math.max(
    Math.min(firstA.site.h, firstB.site.h),
    water + DECK_MIN_CLEARANCE,
  );
  // Second pass: with the height settled, land each end where the ground
  // actually reaches it. On the higher bank that pulls the abutment back in
  // toward the water, which is exactly where a real one would sit.
  const bankAHit = findAbutment(arcIn, -1, deckY - 0.04) || firstA;
  const bankBHit = findAbutment(arcOut, 1, deckY - 0.04) || firstB;

  const bankA = bankAHit.site, bankB = bankBHit.site;
  const centre = centreProbe;
  const waterY = water;
  const span = Math.max(1.2, arcOut - arcIn);
  const biome = bankA.id || bankB.id || world.biomeAt(centre.x, centre.z).id;
  const forestChannel = biome === 'forest' || biome === 'taiga' || biome === 'jungle';
  const bankRise = Math.max(bankA.h, bankB.h) - waterY;
  const bankStep = Math.abs(bankA.h - bankB.h);

  let kind;
  // The small crossings keep their original, narrow conditions: they are what a
  // stream deserves, and they only work on gentle, close banks.
  if (span <= 14.5 && bankRise <= 1.25 && bankStep <= 1.0 && crossing.kind !== 'bridge-required') {
    if (forestChannel && span <= 12.0 && crossing.maxDepth > 0.35 && bankRise <= 0.62) kind = 'log';
    else if (crossing.maxDepth <= 0.85 && span <= 10.0) kind = 'stepping-stones';
    else if (crossing.maxDepth <= 1.65) kind = 'plank-bridge';
    else kind = 'bridge';
  } else {
    kind = 'bridge';
  }

  // One level deck, at the height its abutments settled on. Small crossings sit
  // lower: a plank over a stream is not a viaduct.
  const surfaceY = kind === 'bridge' ? deckY
    : kind === 'plank-bridge' ? Math.max(waterY + 0.32, Math.min(bankA.h, bankB.h) + 0.04)
      : kind === 'log' ? waterY + 0.20
        : waterY + 0.08;

  return {
    kind,
    edgeId: edge.id,
    // The deck is as wide as the trail it carries.
    halfWidth: deckHalfWidth(edge),
    // Everything positional below is arc length along the trail.
    arcStart: bankAHit.arc,
    arcEnd: bankBHit.arc,
    deckLength: bankBHit.arc - bankAHit.arc,
    wetStart: arcIn,
    wetEnd: arcOut,
    // The centre point and its frame, for anything wanting a plain position.
    x: centre.x, z: centre.z, tangentX: centre.tangentX, tangentZ: centre.tangentZ,
    span, depth: crossing.maxDepth, waterY, surfaceY,
    biome, forestChannel, bankA, bankB, bankRise, bankStep,
    // Stepping stones and logs are footholds, not a floor: treating a line of
    // boulders as a continuous surface would let a walker glide over water.
    walkable: kind === 'bridge' || kind === 'plank-bridge',
  };
}

/**
 * The deck height at a point, or null when the point is not on one.
 *
 * Tested against the TRAIL, because that is where the deck was laid. `atY` is
 * the walker's height: a deck underfoot only counts if they are already near its
 * level, so you can wade beneath a bridge without being lifted onto it.
 *
 * `edges` maps edge id to the trail edge each crossing belongs to.
 */
export function deckHeightAt(crossings, edges, x, z, atY = Infinity) {
  let best = null;
  for (let i = 0; i < crossings.length; i++) {
    const c = crossings[i];
    if (!c || !c.walkable) continue;
    const edge = edges && (edges.get ? edges.get(c.edgeId) : edges[c.edgeId]);
    if (!edge) continue;
    const near = nearestArcOnEdge(edge, x, z);
    if (near.distance > deckHalfWidth(edge) + DECK_EDGE_MARGIN) continue;
    if (near.arc < c.arcStart - DECK_END_TOLERANCE
      || near.arc > c.arcEnd + DECK_END_TOLERANCE) continue;
    // Standing on a bridge is not conditional. There WAS a height test here —
    // ignore the deck unless the walker is already near its level — so that
    // someone in the river could pass beneath a footbridge. It is the one gate
    // that can silently refuse a deck to a walker standing on its planks, and
    // being able to walk over a bridge matters more than being able to wade
    // under one. Within the deck's footprint, the deck is the floor.
    void atY;
    if (best === null || c.surfaceY > best) best = c.surfaceY;
  }
  return best;
}
