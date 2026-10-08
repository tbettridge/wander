// Who pays the player any attention, and how much.
//
// Every resident used to notice the player on approach: within ten metres
// most of them stopped, squared up and stared, whoever they were and whatever
// they were doing. That is what a crowd of extras waiting for their line looks
// like, not a village. Real passers-by mostly ignore a stranger; the few who
// look do it with their eyes and a turn of the head, briefly, and only when
// you come close. The people who stop, turn and wave are the ones who know
// you.
//
// So attention is earned, and it is decided here, once, for every kind of NPC:
// village residents, station residents and travellers on the trails all ask
// the same question of the same relationship record.
//
// THREE-free, so it can be asserted without a renderer.

import { relationshipBetween } from './npcsocialmemory.mjs';

export const ATTENTION = Object.freeze({
  // A stranger only ever glances, head only, and only this close.
  strangerGlanceRange: 2.5,
  // Their share of the gaze's attention while you are in range, against the
  // full share someone who knows you gives.
  strangerInterest: 0.35,
  // And a glance is a glance: never held longer than this.
  strangerHoldMax: 0.9,
  // Somebody who knows you notices from here, stops, turns and waves.
  knownRange: 8,
  // Children are curious about everyone and watch you go by, from further off,
  // but nobody stops for you.
  childRange: 7,
  childInterest: 0.8,
  // How often to re-read the relationship record; it changes on conversation
  // timescales, not per frame.
  refreshSeconds: 4,
});

/**
 * Does this NPC know the player well enough to greet them?
 *
 * A record alone is not enough — one exchange at a platform leaves an edge
 * behind. It takes real familiarity, trust or obligation, and nobody greets
 * someone they are wary of.
 */
export function knowsPlayer(state, actorId) {
  const playerId = state?.playerId;
  if (!playerId || !actorId) return false;
  const edge = relationshipBetween(state, actorId, playerId);
  if (!edge) return false;
  if (edge.affinity < -0.2 || edge.trust < -0.3) return false;
  return edge.familiarity >= 0.18 || edge.trust > 0.45 || edge.obligation > 0.45;
}

/**
 * A cached view of knowsPlayer for an NPC that is asked every frame.
 * `memo` is any object the caller keeps per NPC.
 */
export function knowsPlayerCached(memo, state, actorId, dt = 0) {
  memo.rapportAge = (memo.rapportAge ?? Infinity) + Math.max(0, dt);
  if (memo.rapportAge >= ATTENTION.refreshSeconds || memo.knowsPlayer === undefined) {
    memo.rapportAge = 0;
    memo.knowsPlayer = knowsPlayer(state, actorId);
  }
  return memo.knowsPlayer;
}

/**
 * How this NPC attends to the player at `distance`, this frame.
 *
 *   look       may the gaze consider the player at all
 *   interest   0..1 weight the gaze gives the player when it does
 *   holdMax    longest the gaze may rest on the player before moving on
 *   greet      may this approach stop, turn and greet (body, not just eyes)
 */
export function playerAttention({ knows = false, child = false, distance = Infinity } = {}) {
  if (knows) {
    const interest = Math.max(0, Math.min(1, 1 - (distance - 3) / 11));
    return { look: distance < 14, interest, holdMax: Infinity, greet: distance < ATTENTION.knownRange };
  }
  if (child) {
    return {
      look: distance < ATTENTION.childRange,
      interest: ATTENTION.childInterest, holdMax: Infinity, greet: false,
    };
  }
  return {
    look: distance < ATTENTION.strangerGlanceRange,
    interest: ATTENTION.strangerInterest,
    holdMax: ATTENTION.strangerHoldMax,
    greet: false,
  };
}
