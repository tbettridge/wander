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
// How far a bridge deck rides above the water at its crown. Enough to read as a
// bridge, and comfortably more than DECK_STEP_UP so somebody wading the river
// is never close enough to be lifted onto the deck above them — while staying
// low enough that the climb onto it from the bank is a gentle rise.
export const DECK_WATER_CLEARANCE = 1.0;

/**
 * The deck height at a distance along the crossing.
 *
 * Ends sit exactly on their banks so a walker steps on and off without a lip;
 * the middle rises to clear the water. Geometry and collision both read this,
 * so the boards are where the feet are.
 */
export function deckHeightAlong(crossing, along) {
  const t = crossing.deckLength > 0
    ? Math.max(0, Math.min(1, (along - crossing.startAlong) / crossing.deckLength)) : 0;
  const base = crossing.bankAY + (crossing.bankBY - crossing.bankAY) * t;
  return base + (crossing.crownRise || 0) * Math.sin(Math.PI * t);
}

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

  // A deck is a profile, not a shelf. Held at one flat height it meets the
  // ground at neither end: whichever bank is lower gets the whole difference as
  // a step — measured up to 5.9m — and since that exceeds what anyone can climb,
  // every bridge became impossible to actually walk onto. So it lands exactly on
  // each bank and humps in the middle to clear the water, which is what a
  // footbridge looks like anyway.
  const deckLength = bankAHit.dist + bankBHit.dist;
  const startAlong = -bankAHit.dist;
  const bankAY = bankA.h;
  const bankBY = bankB.h;
  const clearance = kind === 'bridge' ? DECK_WATER_CLEARANCE
    : kind === 'plank-bridge' ? 0.32
      : kind === 'log' ? 0.20 : 0.08;
  // Size the crown against the water along the WHOLE deck, not just at its
  // middle. A river falls as it runs, so a hump fitted to the centre alone
  // leaves the deck dipping under the surface further along — measured at a
  // metre below, which is a bridge you cross by wading.
  let crownRise = 0;
  const CROWN_SAMPLES = 64;
  for (let i = 1; i < CROWN_SAMPLES; i++) {
    const t = i / CROWN_SAMPLES;
    const shape = Math.sin(Math.PI * t);
    // Near the abutments the deck is on dry bank and the shape has no leverage;
    // asking it to lift there would send the crown to infinity.
    if (shape < 0.15) continue;
    const sx = cx + tx * (startAlong + deckLength * t);
    const sz = cz + tz * (startAlong + deckLength * t);
    const river = world.riverAt(sx, sz);
    if (!river.wet) continue;
    const baseline = bankAY + (bankBY - bankAY) * t;
    const needed = (river.y + clearance) - baseline;
    if (needed > 0) crownRise = Math.max(crownRise, needed / shape);
  }
  // Always clear the water sampled at the centre too, even if the walk above
  // found no wet sample there.
  crownRise = Math.max(crownRise, (waterY + clearance) - (bankAY + bankBY) * 0.5);
  // The high point of the finished deck, for anything that needs one number.
  const surfaceY = Math.max(bankAY, bankBY, (bankAY + bankBY) * 0.5 + crownRise);

  return {
    kind, x: cx, z: cz, tangentX: tx, tangentZ: tz,
    span, depth: crossing.maxDepth, waterY, surfaceY,
    biome, forestChannel, bankA, bankB, bankRise, bankStep,
    deckLength, startAlong, bankAY, bankBY, crownRise,
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
    const deck = deckHeightAlong(c, along);
    if (atY < deck - DECK_STEP_UP) continue;
    if (best === null || deck > best) best = deck;
  }
  return best;
}
