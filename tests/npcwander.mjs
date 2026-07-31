import assert from 'node:assert/strict';
import {
  advanceWander, createWanderState, WANDER, wanderBox, wanderTemperament,
} from '../src/npcwander.mjs';

const BOUNDS = { alongMin: -20.5, alongMax: 20.5, acrossMin: 1.8, acrossMax: 3.25 };
const HOME = { along: -10.5, across: 2.45 };
const dt = 1 / 60;

function walk(state, seconds, options = {}) {
  const frames = Math.round(seconds / dt);
  const trace = [];
  for (let i = 0; i < frames; i++) {
    const before = { along: state.along, across: state.across, speed: state.speed, mode: state.mode };
    advanceWander(state, dt, options);
    trace.push({ before, after: { along: state.along, across: state.across, speed: state.speed, mode: state.mode } });
  }
  return trace;
}

// --- the roaming box must respect the platform -------------------------------
const wide = wanderBox({ along: 20, across: 3.2 }, wanderTemperament('pace'), BOUNDS);
assert.ok(wide.alongMax <= BOUNDS.alongMax && wide.acrossMax <= BOUNDS.acrossMax,
  'a roaming box may never reach past the platform it is cut against');
assert.ok(wide.alongMin >= 20 - wanderTemperament('pace').roamAlong,
  'the box is anchored on the posted spot, not on the platform centre');

// --- a resident never leaves its box -----------------------------------------
for (const activity of ['pace', 'wait', 'attend', 'gesture']) {
  const state = createWanderState(0x51ee7 ^ activity.length, HOME, activity, BOUNDS);
  for (const { after } of walk(state, 400)) {
    assert.ok(after.along >= state.box.alongMin - 1e-9 && after.along <= state.box.alongMax + 1e-9,
      `${activity} wandered off the platform along the rails`);
    assert.ok(after.across >= state.box.acrossMin - 1e-9 && after.across <= state.box.acrossMax + 1e-9,
      `${activity} wandered off the side of the platform`);
  }
}

// --- the rule that makes a step plantable ------------------------------------
// Turning happens at a standstill. If the body ever travelled while turning,
// the direction of travel would disagree with the plane the legs swing in and
// the stance foot would be dragged sideways through the turn.
{
  const state = createWanderState(99, HOME, 'pace', BOUNDS);
  let turningFrames = 0;
  for (const { before, after } of walk(state, 600)) {
    if (before.mode !== 'turn') continue;
    turningFrames++;
    const moved = Math.hypot(after.along - before.along, after.across - before.across);
    assert.ok(moved < 1e-9, 'a resident must not travel while it is turning on the spot');
  }
  assert.ok(turningFrames > 0, 'the sample must actually contain some turning');
}

// --- speed is real: bounded, and never a teleport ----------------------------
{
  const state = createWanderState(7, HOME, 'pace', BOUNDS);
  let peak = 0;
  for (const { before, after } of walk(state, 600)) {
    const moved = Math.hypot(after.along - before.along, after.across - before.across);
    assert.ok(moved <= WANDER.strollSpeed * dt + 1e-9, 'a resident may never jump further than its speed allows');
    assert.ok(Math.abs(after.speed - before.speed) <= Math.max(WANDER.accel, WANDER.brake) * dt + 1e-9,
      'speed must ramp through acceleration rather than switching on');
    peak = Math.max(peak, after.speed);
  }
  assert.ok(peak > WANDER.strollSpeed * 0.5, 'a pacing resident should reach a real walking speed');
  assert.ok(peak <= WANDER.strollSpeed + 1e-9, 'and never exceed the stroll it was given');
}

// --- a walk arrives and then rests -------------------------------------------
{
  const state = createWanderState(31337, HOME, 'pace', BOUNDS);
  const modes = new Set();
  let travelled = 0;
  for (const { before, after } of walk(state, 600)) {
    modes.add(after.mode);
    travelled += Math.hypot(after.along - before.along, after.across - before.across);
  }
  assert.ok(modes.has('dwell') && modes.has('turn') && modes.has('walk'),
    'a pacing resident should dwell, turn and walk over ten minutes');
  assert.ok(travelled > 20, `a pacing resident should cover ground, covered ${travelled.toFixed(1)}m`);
}

// --- someone waiting mostly stands -------------------------------------------
{
  const pacer = createWanderState(5, HOME, 'pace', BOUNDS);
  const waiter = createWanderState(5, HOME, 'wait', BOUNDS);
  const distance = (state) => walk(state, 600)
    .reduce((sum, { before, after }) => sum + Math.hypot(after.along - before.along, after.across - before.across), 0);
  assert.ok(distance(pacer) > distance(waiter) * 2,
    'temperament must actually separate a pacing porter from a waiting traveller');
}

// --- held residents stop, and stay stopped -----------------------------------
{
  const state = createWanderState(11, HOME, 'pace', BOUNDS);
  walk(state, 30);
  for (const { before, after } of walk(state, 20, { held: true })) {
    assert.ok(after.speed <= before.speed + 1e-9, 'a held resident may only ever slow down');
  }
  assert.equal(state.speed, 0, 'a resident held for a conversation comes to a complete stop');
}

// --- the same seed must produce the same resident ----------------------------
{
  const a = createWanderState(4242, HOME, 'pace', BOUNDS);
  const b = createWanderState(4242, HOME, 'pace', BOUNDS);
  walk(a, 120); walk(b, 120);
  assert.ok(Math.abs(a.along - b.along) < 1e-12 && Math.abs(a.across - b.across) < 1e-12,
    'a seeded resident must wander identically every visit');
}

console.log('npcwander PASS · roams only inside its platform box · turns at a standstill · '
  + 'real acceleration and braking · temperament separates pacing from waiting · seeded and repeatable');
