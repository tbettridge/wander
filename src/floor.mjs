// Where a walker's feet end up, given everything claiming to be underneath them.
//
// An environment — a cave interior, a railway tunnel, a station — owns the
// vertical domain. That is deliberate and right: a missing cave floor must
// freeze the player at their last safe height rather than yank them up to the
// outdoor terrain above the roof.
//
// The ownership used to be TOTAL, and it silently vetoed bridge decks. Standing
// on a trail bridge within an active environment's reach, the deck was found,
// reported by every diagnostic as present, and then thrown away one line later:
//
//     floor = this.environment ? (environmentFloor ?? y) : max(outdoorFloor, …)
//
// The player walked through a deck the console insisted was underfoot. Nothing
// about the crossing was wrong — the answer was correct and simply unused.
//
// So: outdoors, a deck beats the environment's own floor, because a station
// resolver knows nothing about a trail bridge crossing the river beside it.
// Indoors it does not, because a deck must never pull anyone through a ceiling.
//
// Pure, and separate from controls.js, so the rule can be asserted without a
// renderer. Every failure in this area has been an untested integration between
// two parts that were each individually right.

/**
 * @param {object} state
 * @param {boolean} state.hasEnvironment  a cave/tunnel/station resolver is active
 * @param {boolean} state.indoors         that resolver reports an interior
 * @param {number|null|undefined} state.environmentFloor  its floor, if it has one
 * @param {number|null|undefined} state.deck  walkable structure height, or null
 * @param {number} state.ground           bare terrain height
 * @param {number} state.lastY            the walker's current height
 * @param {number} state.waterLevel       the global waterline
 * @returns {number} the height the feet should resolve to
 */
export function resolveFloor({
  hasEnvironment, indoors, environmentFloor, deck, ground, lastY, waterLevel,
}) {
  const hasDeck = deck !== null && deck !== undefined && Number.isFinite(deck);
  if (hasEnvironment) {
    // A null environment floor freezes the walker where they are rather than
    // dropping them to whatever the outdoor terrain happens to be.
    const base = Number.isFinite(environmentFloor) ? environmentFloor : lastY;
    if (!indoors && hasDeck && deck > base) return deck;
    return base;
  }
  const open = hasDeck && deck > ground ? deck : ground;
  // Wading is allowed; sinking forever is not.
  return Math.max(open, waterLevel - 1.2);
}
