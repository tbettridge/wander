// A traveller walking the real trail network, start to finish.
//
// Simulated against a real nav graph rather than a fixture, because the
// interesting failures are not in the state machine — they are in what happens
// when it meets real routes: legs that do not join, edges walked backwards,
// grades that vary along the way.
//
// Everything here runs without a renderer, which is the point. A traveller is a
// position and an intent, so a journey must be completable with no rig at all.

import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { trailsAround, clearTrailCache } from '../src/trails.js';
import { buildNavGraph } from '../src/npcnavgraph.mjs';
import {
  advanceJourney, createJourneyState, isTravelling, JOURNEY, JOURNEY_PHASE,
  journeyProgress,
} from '../src/npcjourney.mjs';

const world = new World(20260612);
clearTrailCache();
const edges = [];
trailsAround(world, 0, 0, world.seed, 20000, edges);
const graph = buildNavGraph(edges);
const keys = [...graph.nodes.keys()];
assert.ok(keys.length > 100, 'need a real network to travel on');

// Pick a landmark with somewhere to go.
const home = keys.find((k) => graph.nodes.get(k).links.length >= 2) ?? keys[0];

// --- a traveller completes a journey, with no rig and no renderer -------------
{
  const state = createJourneyState(1234, home, { loiterHours: 0 });
  // One in-world hour to trigger departure, then walk in 0.5s steps.
  advanceJourney(state, { dt: 0, hours: 1, graph });
  assert.equal(state.phase, JOURNEY_PHASE.travel, 'a traveller departs when its stay expires');
  assert.ok(state.route.legs.length >= 1, 'and has a route to follow');

  const startX = state.x, startZ = state.z;
  let steps = 0;
  while (state.arrivals === 0 && steps < 400000) {
    advanceJourney(state, { dt: 0.5, hours: 0, graph });
    steps++;
  }
  assert.equal(state.arrivals, 1, `the journey must finish, gave up after ${steps} steps`);
  assert.equal(state.phase, JOURNEY_PHASE.loiter, 'and the traveller loiters on arrival');
  assert.ok(Math.hypot(state.x - startX, state.z - startZ) > 100,
    'a completed journey actually goes somewhere');
}

// --- position never jumps ------------------------------------------------------
// The failure this catches is the clearing transfer being skipped: legs end up
// to 100m apart, so an omitted transfer shows up as a single enormous step.
{
  const state = createJourneyState(99, home, { loiterHours: 0 });
  advanceJourney(state, { dt: 0, hours: 1, graph });
  let worst = 0;
  let lastX = state.x, lastZ = state.z;
  const dt = 0.5;
  for (let i = 0; i < 200000 && state.arrivals === 0; i++) {
    advanceJourney(state, { dt, hours: 0, graph });
    worst = Math.max(worst, Math.hypot(state.x - lastX, state.z - lastZ));
    lastX = state.x; lastZ = state.z;
  }
  // Fastest possible going is Tobler's peak, ~6.9 km/h, so half a second can
  // never legitimately cover even 1.5m.
  assert.ok(worst < 1.5,
    `a traveller moved ${worst.toFixed(1)}m in one ${dt}s step — that is a teleport, `
    + 'most likely a skipped clearing transfer');
}

// --- the clearing between legs is actually walked -----------------------------
{
  const state = createJourneyState(7, home, { loiterHours: 0 });
  advanceJourney(state, { dt: 0, hours: 1, graph });
  let sawTransfer = false;
  let multiLeg = state.route.legs.length > 1;
  for (let i = 0; i < 200000 && state.arrivals === 0; i++) {
    advanceJourney(state, { dt: 0.5, hours: 0, graph });
    if (state.phase === JOURNEY_PHASE.transfer) sawTransfer = true;
  }
  if (multiLeg) {
    assert.ok(sawTransfer,
      'a multi-leg journey must spend time crossing open ground between edges');
  }
}

// --- grade sets the pace ------------------------------------------------------
{
  const state = createJourneyState(5, home, { loiterHours: 0 });
  advanceJourney(state, { dt: 0, hours: 1, graph });
  const speeds = new Set();
  for (let i = 0; i < 20000 && state.arrivals === 0; i++) {
    advanceJourney(state, { dt: 0.5, hours: 0, graph });
    if (state.phase === JOURNEY_PHASE.travel) speeds.add(state.speed.toFixed(4));
  }
  for (const s of speeds) {
    const v = Number(s);
    assert.ok(v > 0.2 && v < 2.0,
      `a walking pace of ${v.toFixed(2)} m/s is not a walk`);
  }
}

// --- loitering is in hours, not seconds ---------------------------------------
// Mixing the units is how a 24-hour stay silently becomes a 24-second one.
{
  const state = createJourneyState(3, home, { loiterHours: 6 });
  // Six hours of walking time must not move the clock on.
  for (let i = 0; i < 1000; i++) advanceJourney(state, { dt: 1, hours: 0, graph });
  assert.equal(state.phase, JOURNEY_PHASE.loiter,
    'seconds of walking must not shorten a stay measured in hours');
  advanceJourney(state, { dt: 0, hours: 5.9, graph });
  assert.equal(state.phase, JOURNEY_PHASE.loiter, 'still waiting just before the hour');
  advanceJourney(state, { dt: 0, hours: 0.2, graph });
  assert.equal(state.phase, JOURNEY_PHASE.travel, 'and leaves once the stay is up');
}

// --- stays are staggered, and stay within the agreed 24 hours -----------------
{
  const stays = [];
  for (let seed = 0; seed < 400; seed++) {
    stays.push(createJourneyState(seed, home).loiterLeft);
  }
  const max = Math.max(...stays);
  const min = Math.min(...stays);
  assert.ok(max <= JOURNEY.loiterMaxHours,
    `a stay of ${max.toFixed(1)}h exceeds the agreed 24-hour ceiling`);
  assert.ok(min >= JOURNEY.loiterMinHours, 'and none is instantaneous');
  const distinct = new Set(stays.map((s) => s.toFixed(2))).size;
  assert.ok(distinct > 300,
    'stays must be staggered, or a region departs and refills in waves');
}

// --- no graph means wait, not crash or teleport -------------------------------
{
  const state = createJourneyState(11, home, { loiterHours: 0 });
  const before = { x: state.x, z: state.z };
  for (let i = 0; i < 50; i++) advanceJourney(state, { dt: 0.5, hours: 1, graph: null });
  assert.equal(state.phase, JOURNEY_PHASE.loiter,
    'with no nav graph a traveller waits where it is');
  assert.equal(state.x, before.x, 'and does not drift');
  assert.equal(isTravelling(state), false, 'and is not pretending to walk');
}

// --- an unknown home is not fatal ---------------------------------------------
{
  const state = createJourneyState(13, 'no-such-landmark', { loiterHours: 0 });
  for (let i = 0; i < 20; i++) advanceJourney(state, { dt: 0.5, hours: 1, graph });
  assert.equal(state.phase, JOURNEY_PHASE.loiter,
    'a traveller whose landmark is not in the graph waits rather than throwing');
}

// --- progress is monotonic and bounded ----------------------------------------
{
  const state = createJourneyState(21, home, { loiterHours: 0 });
  advanceJourney(state, { dt: 0, hours: 1, graph });
  let last = 0;
  for (let i = 0; i < 200000 && state.arrivals === 0; i++) {
    advanceJourney(state, { dt: 0.5, hours: 0, graph });
    if (state.arrivals) break;
    const p = journeyProgress(state);
    assert.ok(p >= last - 1e-6, `progress went backwards: ${last} → ${p}`);
    assert.ok(p >= 0 && p <= 1, `progress out of range: ${p}`);
    last = p;
  }
}

console.log('npcjourney PASS · a journey completes with no rig or renderer · '
  + 'position never jumps, so clearing transfers are walked not skipped · '
  + 'grade sets the pace · loitering is in hours and staggered under 24 · '
  + 'a missing graph waits instead of drifting');
