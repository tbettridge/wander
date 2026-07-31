import assert from 'node:assert/strict';
import { advanceGaze, createGazeState, GAZE } from '../src/npcgaze.mjs';

const dt = 1 / 60;

function look(state, seconds, options = {}) {
  const frames = Math.round(seconds / dt);
  const trace = [];
  for (let i = 0; i < frames; i++) {
    advanceGaze(state, dt, options);
    trace.push({ yaw: state.yaw, pitch: state.pitch, focus: state.focus });
  }
  return trace;
}

// --- a neck has a range, and the gaze stays inside it -------------------------
{
  const state = createGazeState(7);
  // Somebody directly behind: the head must turn as far as it can and stop,
  // not spin round.
  for (const { yaw, pitch } of look(state, 60, { player: { yaw: Math.PI, pitch: 1.4 } })) {
    assert.ok(Math.abs(yaw) <= GAZE.yawLimit + 1e-9, `gaze yaw ${yaw} left the neck's range`);
    assert.ok(Math.abs(pitch) <= GAZE.pitchLimit + 1e-9, `gaze pitch ${pitch} left the neck's range`);
  }
}

// --- it actually settles on what it is looking at -----------------------------
{
  const state = createGazeState(11);
  const target = { yaw: 0.5, pitch: -0.2 };
  look(state, 6, { player: target, talking: true });
  assert.ok(Math.abs(state.yaw - target.yaw) < 0.08,
    `a held gaze should converge on its target, ended at ${state.yaw.toFixed(3)}`);
  assert.ok(Math.abs(state.pitch - target.pitch) < 0.06, 'and settle in pitch too');
}

// --- in conversation it looks at whoever it is talking to ---------------------
{
  const state = createGazeState(3);
  const trace = look(state, 40, {
    player: { yaw: 0.3, pitch: 0 }, neighbour: { yaw: -0.8, pitch: 0 }, talking: true,
  });
  assert.ok(trace.every((f) => f.focus === 'player'),
    'a resident in conversation must not look away at the scenery');
}

// --- and it does look around when it is not ----------------------------------
{
  const state = createGazeState(21);
  const focuses = new Set(look(state, 120, {
    player: { yaw: 0.4, pitch: 0 }, neighbour: { yaw: -0.6, pitch: 0.1 },
  }).map((f) => f.focus));
  assert.ok(focuses.size >= 2,
    `a resident with company should shift its attention, only ever used ${[...focuses]}`);
}

// --- never frozen -------------------------------------------------------------
{
  // No player, no neighbour, standing still: the head must still have life in it.
  const state = createGazeState(5);
  const trace = look(state, 30);
  const spread = Math.max(...trace.map((f) => f.yaw)) - Math.min(...trace.map((f) => f.yaw));
  assert.ok(spread > GAZE.driftYaw,
    `an idle head must not lock in place, moved only ${spread.toFixed(4)} rad`);
}

// --- a walking resident looks ahead more than it looks around -----------------
{
  const walking = createGazeState(77);
  const standing = createGazeState(77);
  const swing = (trace) => Math.max(...trace.map((f) => Math.abs(f.yaw)));
  const walkSwing = swing(look(walking, 120, { moving: true }));
  const standSwing = swing(look(standing, 120, { moving: false }));
  assert.ok(walkSwing < standSwing,
    'someone walking should keep their eyes nearer their path than someone idling');
}

// --- seeded and repeatable ----------------------------------------------------
{
  const a = createGazeState(909);
  const b = createGazeState(909);
  look(a, 45); look(b, 45);
  assert.ok(Math.abs(a.yaw - b.yaw) < 1e-12 && Math.abs(a.pitch - b.pitch) < 1e-12,
    'a seeded resident must look around the same way every visit');
}

console.log('npcgaze PASS · stays inside the neck\'s range · settles on its target · '
  + 'holds the eye in conversation · shifts attention otherwise · never freezes · seeded');
