// What an NPC stands on, and what it costs to find out.
//
// Two grounding systems that disagree put an NPC shin-deep in a river the
// player walks over dry, so an NPC resolves against the SAME walkable surface
// the player's feet do — terrain, bridge decks, railway spans, all of it.
//
// The cost is the reason this is not just a function call. One NPC asking where
// the ground is costs nothing; a region's worth of them asking every frame, each
// sample walking the noise stack and then the crossings on top, is the frame
// budget. So samples go through an explicit ceiling and a deferred sample keeps
// the height it had.
//
// A resident on a station platform is a deliberate exception. The platform is
// flat, authored, and not part of the walkable surface at all: sampling terrain
// there would drop them through their own station. They carry a fixed height and
// cost nothing, which is also why a filling station does not eat the budget that
// travellers need.

import {
  beginFrame, createHeightBudget, releaseHeight, sampleHeight,
} from './heightbudget.mjs';

/**
 * @param {object} options
 * @param {(x: number, z: number) => number} options.groundAt
 *   the shared walkable surface — terrain plus anything standing on it
 * @param {number} options.samplesPerFrame  ceiling across all NPCs
 */
export function createGrounding({ groundAt = null, samplesPerFrame = 12 } = {}) {
  return { groundAt, budget: createHeightBudget({ samplesPerFrame }) };
}

/** Start a frame. Everything sampled after this counts against the ceiling. */
export function beginGroundingFrame(grounding) {
  if (grounding) beginFrame(grounding.budget);
}

/**
 * The height an actor's feet resolve to.
 *
 * `fixedY` is honoured whenever it is present — that is the platform case, and
 * it short-circuits before any budget is touched. Everyone else is sampled from
 * the walkable surface, subject to the ceiling.
 *
 * With no surface wired, the fallback is returned unchanged rather than zero:
 * an NPC with no ground is better left where it was than dropped to the origin.
 */
export function groundHeightFor(grounding, key, x, z, { fixedY = null, fallback = 0 } = {}) {
  if (fixedY !== null && fixedY !== undefined) return fixedY;
  if (!grounding || !grounding.groundAt) return fallback;
  return sampleHeight(grounding.budget, key, () => grounding.groundAt(x, z));
}

/** An NPC that has gone: stop holding a height for it. */
export function releaseGrounding(grounding, key) {
  if (grounding) releaseHeight(grounding.budget, key);
}

/** What the last frame cost, for the quality panel and for tests. */
export function groundingStats(grounding) {
  if (!grounding) return { sampled: 0, deferred: 0, tracked: 0, ceiling: 0 };
  const { budget } = grounding;
  return {
    sampled: budget.spent,
    deferred: budget.deferred,
    tracked: budget.cache.size,
    ceiling: budget.samplesPerFrame,
  };
}
