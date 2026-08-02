// Meeting someone on the road.
//
// A traveller that walks past the player without a flicker is the thing that
// most gives away that it is on rails. Everything needed to fix it already
// existed — gaze, emotes, the social layer — and none of it reached anyone in
// transit, because all of it was written for a resident standing on a platform.
//
// So: a small behaviour for the moment two walkers meet. It decides three
// things, and deliberately no more.
//
//   notice   how much attention the player has, 0..1
//   pause    whether this one actually stops, or just looks and keeps walking
//   face     whether to turn toward them
//
// The load-bearing rule is that MOST TRAVELLERS DO NOT STOP. Someone crossing
// country with a message to deliver glances at a stranger and carries on; if
// every one of them halted, the road would read as a receiving line and the
// journeys would stop meaning anything. Stopping is the exception that makes
// the glance worth something.
//
// The decision is made ONCE per encounter, when the player first comes close,
// and it holds until they leave. A traveller that re-rolls every frame dithers —
// stopping, starting, stopping again — which looks like a bug rather than a
// personality.
//
// THREE-free, so the behaviour can be asserted without a renderer.

import { mulberry32 } from './noise.js';

export const ENCOUNTER = Object.freeze({
  // Where someone registers as approaching, and where they are close enough to
  // be worth stopping for.
  noticeRange: 26,
  closeRange: 9,
  // Leaving is deliberately further out than noticing, so a player walking
  // alongside at the edge of range does not flicker the encounter on and off.
  forgetRange: 34,
  // How long a stop lasts before they get on with their journey.
  pauseMin: 1.8,
  pauseMax: 5.0,
  // Having stopped once, they will not stop again for this long — otherwise a
  // player who walks alongside holds a traveller in place indefinitely.
  cooldown: 45,
  // How likely a stop is at all. Low on purpose: see above.
  stopChance: 0.28,
  // Slowing to a near-halt reads better than stopping dead, so a paused walker
  // keeps a fraction of their pace for the first moment.
  pauseEase: 2.6,
});

export const ENCOUNTER_PHASE = Object.freeze({
  none: 'none',
  noticing: 'noticing',
  paused: 'paused',
  passing: 'passing',
});

/**
 * @param {number} seed        stable per NPC, so the same person behaves the same way
 * @param {number} sociability 0..1 — how likely this one is to stop at all
 */
export function createEncounterState(seed = 1, sociability = 0.5) {
  return {
    rng: mulberry32((seed >>> 0) ^ 0x517cc1b7),
    sociability,
    phase: ENCOUNTER_PHASE.none,
    // 0..1 attention on the player, eased rather than switched so a glance
    // arrives and fades instead of snapping.
    notice: 0,
    pauseLeft: 0,
    cooldownLeft: 0,
    // Whether this particular meeting has already been decided.
    decided: false,
    encounters: 0,
  };
}

/**
 * Advance one traveller's reaction to the player.
 *
 * @param {object} state
 * @param {number} dt
 * @param {object} world
 * @param {number} world.distance    metres to the player
 * @param {boolean} world.travelling whether this NPC is currently walking
 * @param {boolean} world.talking    whether a conversation is open
 * @returns {object} { notice, pausing, facing, speedScale, phase }
 */
export function advanceEncounter(state, dt = 0.016, {
  distance = Infinity, travelling = false, talking = false,
} = {}) {
  state.cooldownLeft = Math.max(0, state.cooldownLeft - dt);

  // A conversation overrides everything: stop, look at them, stay stopped. The
  // journey is already held elsewhere while talking; this makes the body agree.
  if (talking) {
    state.phase = ENCOUNTER_PHASE.paused;
    state.notice = 1;
    return { notice: 1, pausing: true, facing: true, speedScale: 0, phase: state.phase };
  }

  const inRange = distance <= ENCOUNTER.noticeRange;
  const gone = distance > ENCOUNTER.forgetRange;

  if (gone) {
    // Out of range: forget this meeting so the next one is decided afresh.
    if (state.decided) state.encounters++;
    state.decided = false;
    state.phase = ENCOUNTER_PHASE.none;
    state.pauseLeft = 0;
    state.notice = ease(state.notice, 0, dt, 2.5);
    return { notice: state.notice, pausing: false, facing: false, speedScale: 1, phase: state.phase };
  }

  if (!inRange) {
    // Between noticeRange and forgetRange: keep whatever was decided, but do not
    // start anything new.
    state.notice = ease(state.notice, 0, dt, 1.6);
    const stillPaused = state.phase === ENCOUNTER_PHASE.paused && state.pauseLeft > 0;
    if (stillPaused) return tickPause(state, dt);
    return { notice: state.notice, pausing: false, facing: false, speedScale: 1, phase: state.phase };
  }

  // Decide once, on first approach.
  if (!state.decided) {
    state.decided = true;
    const willing = state.cooldownLeft <= 0 && travelling;
    const chance = ENCOUNTER.stopChance * (0.4 + state.sociability * 1.2);
    state.phase = willing && state.rng() < chance
      ? ENCOUNTER_PHASE.paused
      : ENCOUNTER_PHASE.passing;
    if (state.phase === ENCOUNTER_PHASE.paused) {
      state.pauseLeft = ENCOUNTER.pauseMin
        + state.rng() * (ENCOUNTER.pauseMax - ENCOUNTER.pauseMin);
      state.cooldownLeft = ENCOUNTER.cooldown;
    }
  }

  // Attention rises as they get closer, whether or not they stop. This is the
  // part that matters most: a glance costs nothing and is what makes someone
  // walking past feel like a person rather than a prop.
  const closeness = 1 - Math.min(1, Math.max(0,
    (distance - ENCOUNTER.closeRange) / (ENCOUNTER.noticeRange - ENCOUNTER.closeRange)));
  const target = state.phase === ENCOUNTER_PHASE.paused ? 1 : 0.35 + closeness * 0.5;
  state.notice = ease(state.notice, target, dt, 2.2);

  if (state.phase === ENCOUNTER_PHASE.paused && state.pauseLeft > 0) {
    return tickPause(state, dt);
  }
  if (state.phase === ENCOUNTER_PHASE.paused) {
    // The stop is over; walk on, but keep looking a moment longer.
    state.phase = ENCOUNTER_PHASE.passing;
  }
  return {
    notice: state.notice,
    pausing: false,
    // Turning the whole body to a stranger you are walking past is a stare, and
    // it fights the gait. Passers-by turn the head only, which the gaze layer
    // already knows how to do.
    facing: false,
    speedScale: 1,
    phase: state.phase,
  };
}

function tickPause(state, dt) {
  state.pauseLeft = Math.max(0, state.pauseLeft - dt);
  // Ease out of walking rather than stopping dead mid-stride.
  const speedScale = Math.max(0, Math.min(1, state.pauseLeft > 0 ? 0 : 1));
  return {
    notice: state.notice,
    pausing: state.pauseLeft > 0,
    facing: true,
    speedScale,
    phase: ENCOUNTER_PHASE.paused,
  };
}

function ease(current, target, dt, rate) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/**
 * How sociable a role is, 0..1.
 *
 * A porter or a guide meets people for a living; someone carrying a message is
 * not looking for conversation. This is the only place a role changes travel
 * behaviour, and it is a nudge rather than a rule.
 */
export function sociabilityFor(identity) {
  const role = (identity?.role || '').toLowerCase();
  if (/guide|porter|host|keeper|trader|pedlar/.test(role)) return 0.85;
  if (/courier|messenger|scout|ranger/.test(role)) return 0.3;
  return 0.55;
}
