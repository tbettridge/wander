// A traveller between landmarks: loiter → travel → transfer → arrive → loiter.
//
// The rule that shapes everything here: a traveller is a POSITION AND AN INTENT,
// not a live actor. It advances from `dt` and a route, and its position is
// derived from arc length along a trail. Nothing in this file needs a rig, a
// gait, a mesh or a renderer, so an NPC keeps walking while it is out of
// simulation range and is still somewhere sensible when the player arrives.
//
// Three phases do the moving:
//
//   travel    — along one trail edge, at a speed set by that edge's grade
//   transfer  — across the open ground between two edges. Trail edges stop at a
//               landmark's clearing halo rather than its centre, so consecutive
//               legs end and begin up to 100m apart. Walking that gap is a real
//               part of the journey, not an accounting detail; skipping it is a
//               teleport across a clearing.
//   loiter    — standing at a landmark, for up to 24 in-world hours
//
// Time is in-world HOURS for loitering and seconds for walking, because those
// are the units the two things are actually specified in. Mixing them behind one
// number is how a 24-hour stay becomes a 24-second one.

import { mulberry32 } from './noise.js';
import { advanceLeg, findRoute, hikingSpeed, reachableWithin } from './npcnavgraph.mjs';
import { trailFrameAtArc } from './trails.js';

export const JOURNEY_PHASE = Object.freeze({
  loiter: 'loiter',
  travel: 'travel',
  transfer: 'transfer',
});

/**
 * Why someone is out walking.
 *
 * Deliberately a SEED, not a story: a short errand the character can build on,
 * decided once per journey and stable for its whole length. An NPC that invents
 * a fresh reason each time it is asked contradicts itself within one
 * conversation, and one that has no reason at all answers "I am travelling",
 * which is not an answer.
 */
export const JOURNEY_PURPOSES = Object.freeze([
  'carrying a message',
  'taking goods to trade',
  'visiting family',
  'returning home',
  'looking for work',
  'walking a route they were paid to check',
  'meeting someone',
  'delivering something promised a long time ago',
  'moving on after staying too long',
  'following news heard at the last stop',
  'escorting a debt or a favour',
  'going to see something they have only been told about',
]);

export const JOURNEY = Object.freeze({
  // Tobler gives km/h; walking wants m/s. A traveller is not in a hurry.
  paceScale: 1 / 3.6,
  // Open ground between edges is slower than the trail either side of it.
  transferSpeed: 0.95,
  // A stay is anywhere from a short pause to a full day, per the agreed rule.
  loiterMinHours: 0.35,
  loiterMaxHours: 24,
  // How far a traveller will go in one journey, as hiking-time cost — roughly
  // metres divided by km/h, so ~3000 is a few hours of easy going. Without a
  // ceiling Dijkstra happily returns a three-day walk across the map.
  maxRouteCost: 3000,
});

/**
 * A traveller that starts where it already is, standing still.
 *
 * `homeKey` is the landmark it belongs to right now. Everything else is decided
 * when the loiter expires, so a fresh traveller costs nothing until it moves.
 */
export function createJourneyState(seed, homeKey, { x = 0, z = 0, loiterHours = null } = {}) {
  const rng = mulberry32((seed >>> 0) ^ 0x6a09e667);
  return {
    rng,
    phase: JOURNEY_PHASE.loiter,
    homeKey,
    destKey: null,
    route: null,
    legIndex: 0,
    travelled: 0,
    transferFrom: null,
    transferTo: null,
    // Staggered on purpose: without it every NPC seeded in the same frame
    // departs in the same frame, and the world empties and refills in waves.
    loiterLeft: loiterHours ?? pickLoiter(rng),
    x,
    z,
    heading: 0,
    speed: 0,
    // Counts completed journeys, which is the cheapest way to see from the
    // outside whether travel is actually happening.
    arrivals: 0,
    // The errand, and how much of it is behind them. Both are things a
    // traveller can be asked about, so both have to survive being out of range.
    purpose: null,
    coveredM: 0,
    walkedSeconds: 0,
    // Where this journey began, kept because homeKey is overwritten on arrival
    // and "where have you come from" is the obvious question.
    fromKey: null,
  };
}

function pickLoiter(rng) {
  // Biased towards shorter stays: an hour is common, a full day is rare.
  const roll = rng();
  return JOURNEY.loiterMinHours
    + (JOURNEY.loiterMaxHours - JOURNEY.loiterMinHours) * roll * roll * roll;
}

/**
 * Advance a traveller.
 *
 * @param {object} state    from createJourneyState
 * @param {object} tick
 * @param {number} tick.dt      seconds of real walking
 * @param {number} tick.hours   in-world hours elapsed, for loitering
 * @param {object} tick.graph   nav graph; without one a traveller simply waits
 * @returns {string} the phase after the tick
 */
export function advanceJourney(state, { dt = 0, hours = 0, graph = null } = {}) {
  if (state.phase === JOURNEY_PHASE.loiter) {
    state.speed = 0;
    state.loiterLeft -= hours;
    if (state.loiterLeft > 0) return state.phase;
    if (!graph || !depart(state, graph)) {
      // Nowhere to go, or no graph yet. Wait a little and ask again rather than
      // retrying every frame for the rest of the session.
      state.loiterLeft = 0.25;
      return state.phase;
    }
    return state.phase;
  }

  if (state.phase === JOURNEY_PHASE.transfer) return advanceTransfer(state, dt);
  return advanceTravel(state, dt);
}

/** Choose somewhere to go and route to it. False when there is nowhere. */
function depart(state, graph) {
  const here = graph.nodes.get(state.homeKey);
  if (!here) return false;
  // Ask what is actually within reach rather than guessing. Picking a random
  // landmark and testing it fails almost every time: cost is hiking time, so a
  // few hours covers a small fraction of a large graph.
  const candidates = [...reachableWithin(graph, state.homeKey, JOURNEY.maxRouteCost).keys()];
  if (!candidates.length) return false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const destKey = candidates[Math.floor(state.rng() * candidates.length) % candidates.length];
    if (destKey === state.homeKey) continue;
    const route = findRoute(graph, state.homeKey, destKey, { maxCost: JOURNEY.maxRouteCost });
    if (!route || !route.legs.length) continue;
    state.destKey = destKey;
    state.fromKey = state.homeKey;
    state.route = route;
    state.legIndex = 0;
    state.travelled = 0;
    state.coveredM = 0;
    state.walkedSeconds = 0;
    state.purpose = JOURNEY_PURPOSES[
      Math.floor(state.rng() * JOURNEY_PURPOSES.length) % JOURNEY_PURPOSES.length
    ];
    state.phase = JOURNEY_PHASE.travel;
    syncTravelPosition(state);
    return true;
  }
  return false;
}

const _frame = {};

function advanceTravel(state, dt) {
  const leg = state.route?.legs[state.legIndex];
  if (!leg) return arrive(state);
  // Grade sets the pace, so a traveller genuinely slows on the steep sections
  // rather than covering them at the same rate as the flat.
  const pace = hikingSpeed(leg.edge.meanGrade || 0) * JOURNEY.paceScale;
  state.speed = pace;
  state.travelled += pace * dt;
  state.coveredM += pace * dt;
  state.walkedSeconds += dt;
  const step = advanceLeg(leg, state.travelled);
  syncTravelPosition(state, step.arc);
  if (!step.done) return state.phase;

  // Leg finished. Cross the clearing to the next one, or arrive.
  const next = state.route.legs[state.legIndex + 1];
  if (!next) return arrive(state);
  trailFrameAtArc(leg.edge, leg.endArc, _frame);
  const fromX = _frame.x, fromZ = _frame.z;
  trailFrameAtArc(next.edge, next.startArc, _frame);
  state.transferFrom = { x: fromX, z: fromZ };
  state.transferTo = { x: _frame.x, z: _frame.z };
  state.travelled = 0;
  state.phase = JOURNEY_PHASE.transfer;
  return state.phase;
}

function advanceTransfer(state, dt) {
  const from = state.transferFrom;
  const to = state.transferTo;
  const span = Math.hypot(to.x - from.x, to.z - from.z);
  state.speed = JOURNEY.transferSpeed;
  state.travelled += JOURNEY.transferSpeed * dt;
  state.coveredM += JOURNEY.transferSpeed * dt;
  state.walkedSeconds += dt;
  const t = span > 1e-6 ? Math.min(1, state.travelled / span) : 1;
  state.x = from.x + (to.x - from.x) * t;
  state.z = from.z + (to.z - from.z) * t;
  state.heading = Math.atan2(to.x - from.x, to.z - from.z);
  if (t < 1) return state.phase;
  state.legIndex++;
  state.travelled = 0;
  state.transferFrom = null;
  state.transferTo = null;
  state.phase = JOURNEY_PHASE.travel;
  syncTravelPosition(state);
  return state.phase;
}

function arrive(state) {
  // The errand and the walk are cleared on arrival, but fromKey is not: an NPC
  // standing at a landmark can still say where it came from today.
  state.homeKey = state.destKey ?? state.homeKey;
  state.destKey = null;
  state.route = null;
  state.legIndex = 0;
  state.travelled = 0;
  state.speed = 0;
  state.arrivals++;
  state.loiterLeft = pickLoiter(state.rng);
  state.phase = JOURNEY_PHASE.loiter;
  return state.phase;
}

/** Put the traveller where its arc position says it is, facing along the trail. */
function syncTravelPosition(state, arcOverride = null) {
  const leg = state.route?.legs[state.legIndex];
  if (!leg) return;
  const arc = arcOverride ?? (advanceLeg(leg, state.travelled).arc);
  trailFrameAtArc(leg.edge, arc, _frame);
  state.x = _frame.x;
  state.z = _frame.z;
  // Facing follows the direction of travel, which is the tangent reversed when
  // the edge is being walked backwards. A traveller facing against its own
  // motion drags every planted foot.
  const dir = leg.forward ? 1 : -1;
  state.heading = Math.atan2(_frame.tangentX * dir, _frame.tangentZ * dir);
}

/** Is this traveller currently walking? Used to pick a gait over a stand. */
export function isTravelling(state) {
  return state.phase === JOURNEY_PHASE.travel || state.phase === JOURNEY_PHASE.transfer;
}

/** How far along the whole journey, 0..1. For debug readouts. */
export function journeyProgress(state) {
  if (!state.route || !state.route.legs.length) return 0;
  const total = state.route.distance + state.route.openGroundDistance;
  if (total <= 0) return 0;
  let done = 0;
  for (let i = 0; i < state.legIndex; i++) {
    done += state.route.legs[i].edge.arcLength || 0;
    done += state.route.legs[i].gapToNext || 0;
  }
  return Math.max(0, Math.min(1, (done + state.travelled) / total));
}
