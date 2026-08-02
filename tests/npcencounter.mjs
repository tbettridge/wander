// Meeting a traveller on the road.
//
// The behaviour being pinned is mostly about restraint. It would be easy to
// make every traveller stop and turn and beam at the player, and it would be
// wrong: a road where everyone halts is a receiving line, and the journeys stop
// meaning anything. Most of these assertions are about NOT reacting.

import assert from 'node:assert/strict';
import {
  advanceEncounter, createEncounterState, ENCOUNTER, ENCOUNTER_PHASE,
  sociabilityFor,
} from '../src/npcencounter.mjs';

const dt = 1 / 30;

/** Walk the player in from far away and hold them at `distance`. */
function meet(state, distance, seconds = 3, opts = {}) {
  let last = null;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    last = advanceEncounter(state, dt, { distance, travelling: true, ...opts });
  }
  return last;
}

// --- most travellers do not stop ----------------------------------------------
// The single most important property here. If this drifts upward the road stops
// feeling like a road.
{
  let stopped = 0;
  const total = 400;
  for (let seed = 0; seed < total; seed++) {
    const state = createEncounterState(seed, 0.55);
    const result = meet(state, 6, 2);
    if (result.pausing) stopped++;
  }
  const rate = stopped / total;
  assert.ok(rate > 0.05 && rate < 0.45,
    `between 5% and 45% of travellers should stop; ${(rate * 100).toFixed(0)}% did`);
}

// --- but everyone notices ------------------------------------------------------
{
  let noticed = 0;
  for (let seed = 0; seed < 100; seed++) {
    const state = createEncounterState(seed, 0.55);
    if (meet(state, 7, 2).notice > 0.3) noticed++;
  }
  assert.equal(noticed, 100,
    'every traveller gives a passer-by at least a glance, whether or not they stop');
}

// --- a passer-by does not turn its body ---------------------------------------
// Turning to face a stranger you are walking past is a stare, and it fights the
// gait: the legs swing in the sagittal plane, so a body turned away from its
// direction of travel drags the planted foot.
{
  const state = createEncounterState(3, 0.55);
  const result = meet(state, 8, 2);
  if (!result.pausing) {
    assert.equal(result.facing, false,
      'someone walking past turns their head, not their body');
    assert.equal(result.speedScale, 1, 'and does not slow down');
  }
}

// --- a stop is temporary, and they move on ------------------------------------
{
  // Find a seed that does stop, then hold the player there and check it ends.
  let state = null;
  for (let seed = 0; seed < 200 && !state; seed++) {
    const candidate = createEncounterState(seed, 1);
    if (meet(candidate, 5, 1).pausing) state = candidate;
  }
  assert.ok(state, 'some traveller must be willing to stop');
  const held = meet(state, 5, ENCOUNTER.pauseMax + 2);
  assert.equal(held.pausing, false,
    'a stop ends by itself — a traveller has somewhere to be');
  assert.equal(held.speedScale, 1, 'and they walk on at full pace');
}

// --- a player who follows cannot hold someone in place ------------------------
// Without a cooldown, walking alongside a traveller pins them: they stop, resume,
// come back into range, and stop again forever.
{
  let state = null;
  for (let seed = 0; seed < 200 && !state; seed++) {
    const candidate = createEncounterState(seed, 1);
    if (meet(candidate, 5, 1).pausing) state = candidate;
  }
  meet(state, 5, ENCOUNTER.pauseMax + 2);        // first stop completes
  // Leave and come straight back, as a player walking alongside would.
  meet(state, ENCOUNTER.forgetRange + 10, 1);
  const second = meet(state, 5, 2);
  assert.equal(second.pausing, false,
    'having just stopped, they do not stop again — the cooldown is what stops a '
    + 'following player pinning a traveller in place');
}

// --- conversation overrides everything ----------------------------------------
{
  const state = createEncounterState(11, 0);      // least sociable possible
  const result = advanceEncounter(state, dt, { distance: 3, travelling: true, talking: true });
  assert.equal(result.pausing, true, 'someone being spoken to stops');
  assert.equal(result.facing, true, 'and turns to face the person speaking');
  assert.equal(result.speedScale, 0, 'and does not wander off mid-sentence');
  assert.equal(result.notice, 1, 'with full attention');
}

// --- attention fades when the player leaves -----------------------------------
{
  const state = createEncounterState(5, 0.55);
  meet(state, 6, 2);
  const after = meet(state, ENCOUNTER.forgetRange + 5, 4);
  assert.ok(after.notice < 0.1, `attention must fade, still at ${after.notice.toFixed(2)}`);
  assert.equal(after.phase, ENCOUNTER_PHASE.none, 'and the meeting is over');
}

// --- hysteresis: no flicker at the boundary -----------------------------------
// A player walking alongside at exactly the notice range must not toggle the
// encounter on and off every frame.
{
  const state = createEncounterState(7, 0.55);
  meet(state, ENCOUNTER.noticeRange - 0.5, 1);
  const decidedAt = state.decided;
  meet(state, ENCOUNTER.noticeRange + 1, 1);      // just outside notice, inside forget
  assert.equal(state.decided, decidedAt,
    'stepping just outside the notice range must not re-decide the meeting');
  assert.ok(ENCOUNTER.forgetRange > ENCOUNTER.noticeRange,
    'forgetting has to be further out than noticing, or the encounter flickers');
}

// --- a standing NPC does not "stop" -------------------------------------------
{
  const state = createEncounterState(13, 1);
  const result = meet(state, 5, 2, { travelling: false });
  assert.equal(result.pausing, false,
    'someone already standing still has nothing to stop doing');
}

// --- role nudges sociability, and stays a nudge -------------------------------
{
  assert.ok(sociabilityFor({ role: 'guide' }) > sociabilityFor({ role: 'courier' }),
    'a guide is more willing to stop than a courier');
  for (const role of ['guide', 'courier', 'anything else']) {
    const value = sociabilityFor({ role });
    assert.ok(value > 0 && value <= 1, `${role} sociability out of range: ${value}`);
  }
}

console.log('npcencounter PASS · most travellers walk on · everyone glances · '
  + 'passers-by turn their head not their body · a stop ends by itself · '
  + 'a following player cannot pin someone in place · conversation stops them');
