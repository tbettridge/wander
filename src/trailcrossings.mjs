// Where a trail meets water, and what stands there.
//
// This is the single source of truth for a crossing. The chunk builder asks it
// what to build; the player's feet and an NPC's gait ask it what to stand on.
// They have to be the same answer — a deck the eye can see and the foot walks
// through is worse than no deck at all — so the decision lives in one place
// rather than being derived twice.
//
// THREE-free, so a crossing can be asserted without a renderer.

const BANK_SEARCH_REACH = 70;   // how far past the water to hunt for solid ground
const BANK_SEARCH_STEP = 2;
const WATER_WALK_REACH = 400;   // rivers here run to ~350m
const WATER_WALK_STEP = 0.75;

export const DECK_BOARD_SPACING = 0.52;
export const DECK_HALF_WIDTH = 0.95;   // deck boards plus the rail posts
// A deck is only underfoot if you are already at about its level. Approaching
// along a bank you step up onto it; wading beneath a bridge you do not get
// yanked onto the deck from the riverbed.
export const DECK_STEP_UP = 0.65;
// The deck meets solid ground at each abutment rather than stopping dead on a
// mathematical boundary. Without this the last step onto the bank falls through
// the seam, because the position that generated the deck and the position being
// tested differ in the last decimal place.
export const DECK_END_TOLERANCE = 0.3;

/** Solid, walkable ground — not water, not a cliff, not below the waterline. */
export function drySite(world, x, z, maxSlope = 0.48) {
  const site = world.biomeAt(x, z);
  return site.h > 0.55 && site.slope <= maxSlope && !world.riverAt(x, z).wet ? site : null;
}

/**
 * Resolve one ford on one trail edge into the crossing that belongs there.
 *
 * Returns null when nothing can be built — no dry ground within reach on both
 * sides — which is a real answer and rare (about one crossing in 250).
 */
export function solveCrossing(world, crossing, tangentX, tangentZ) {
  let cx = crossing.centerX ?? crossing.x;
  let cz = crossing.centerZ ?? crossing.z;
  let tx = crossing.tangentX || tangentX;
  let tz = crossing.tangentZ || tangentZ;
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl; tz /= tl;

  // The ford record already knows where the water started and stopped along the
  // route, so start from that rather than from a default of 2m, then refine it
  // against the water itself. This walk used to stop at 18m, which truncated
  // every wider river: the span gate then rejected it, or the bank probes were
  // placed from a centre still mid-channel and reported no banks. Those two
  // between them left 89% of crossings built as nothing.
  const recorded = Math.hypot((crossing.endX ?? cx) - (crossing.x ?? cx),
    (crossing.endZ ?? cz) - (crossing.z ?? cz));
  let span = Math.max(1.2, crossing.span || recorded || 2);
  if (world.riverAt(cx, cz).wet) {
    let back = 0, forward = 0;
    for (let d = WATER_WALK_STEP; d <= WATER_WALK_REACH; d += WATER_WALK_STEP) {
      if (!world.riverAt(cx - tx * d, cz - tz * d).wet) break;
      back = d;
    }
    for (let d = WATER_WALK_STEP; d <= WATER_WALK_REACH; d += WATER_WALK_STEP) {
      if (!world.riverAt(cx + tx * d, cz + tz * d).wet) break;
      forward = d;
    }
    if (back + forward > 1) {
      // Re-centre on the refined wet run so symmetric bank and prop placement
      // truly spans it.
      const shift = (forward - back) * 0.5;
      cx += tx * shift; cz += tz * shift;
      span = back + forward;
    }
  }

  // Search outward for solid ground rather than testing a single point: the
  // margin of a wide river is usually marshy for a few metres, and an abutment
  // can sit a little further back.
  const findBank = (dirX, dirZ) => {
    for (let d = span * 0.5 + 1.4; d <= span * 0.5 + BANK_SEARCH_REACH; d += BANK_SEARCH_STEP) {
      const site = drySite(world, cx + dirX * d, cz + dirZ * d);
      if (site) return { site, dist: d };
    }
    return null;
  };
  const bankAHit = findBank(-tx, -tz);
  const bankBHit = findBank(tx, tz);
  if (!bankAHit || !bankBHit) return null;

  const bankA = bankAHit.site, bankB = bankBHit.site;
  const biome = bankA.id || bankB.id || world.biomeAt(cx, cz).id;
  const forestChannel = biome === 'forest' || biome === 'taiga' || biome === 'jungle';
  const centreRiver = world.riverAt(cx, cz);
  const waterY = centreRiver.wet ? centreRiver.y : world.height(cx, cz);
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
    // Everything else gets a real bridge, at whatever length the water demands.
    kind = 'bridge';
  }

  const deckLength = bankAHit.dist + bankBHit.dist;
  const startAlong = -bankAHit.dist;
  const surfaceY = kind === 'bridge'
    ? Math.max(waterY + 1.05, bankA.h + 0.12, bankB.h + 0.12)
    : kind === 'plank-bridge' ? Math.max(waterY + 0.32, bankA.h + 0.08, bankB.h + 0.08)
      : kind === 'log' ? waterY + 0.20
        : waterY + 0.08;

  return {
    kind, x: cx, z: cz, tangentX: tx, tangentZ: tz,
    span, depth: crossing.maxDepth, waterY, surfaceY,
    biome, forestChannel, bankA, bankB, bankRise, bankStep,
    deckLength, startAlong,
    // The walkable extent along the crossing axis. Stepping stones and logs are
    // deliberately excluded from this: they are footholds, not a floor, and
    // pretending a line of boulders is a continuous surface would let a walker
    // glide across water between them.
    walkable: kind === 'bridge' || kind === 'plank-bridge',
  };
}

/**
 * The deck height at a point, or null when the point is not on one.
 *
 * `atY` is the walker's current height: a deck underfoot only counts if they
 * are already near its level, so you can wade beneath a bridge without being
 * lifted onto it.
 */
export function deckHeightAt(crossings, x, z, atY = Infinity) {
  let best = null;
  for (let i = 0; i < crossings.length; i++) {
    const c = crossings[i];
    if (!c || !c.walkable) continue;
    const dx = x - c.x, dz = z - c.z;
    const along = dx * c.tangentX + dz * c.tangentZ;
    if (along < c.startAlong - DECK_END_TOLERANCE
      || along > c.startAlong + c.deckLength + DECK_END_TOLERANCE) continue;
    const across = dx * -c.tangentZ + dz * c.tangentX;
    if (Math.abs(across) > DECK_HALF_WIDTH) continue;
    if (atY < c.surfaceY - DECK_STEP_UP) continue;
    if (best === null || c.surfaceY > best) best = c.surfaceY;
  }
  return best;
}
