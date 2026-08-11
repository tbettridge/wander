import assert from 'node:assert/strict';
import { advanceGaze, createGazeState, GAZE, NOTICE, noticeOnApproach } from '../src/npcgaze.mjs';
import { mulberry32 } from '../src/noise.js';

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
  look(state, 6, { player: target, lockOn: 'player' });
  assert.ok(Math.abs(state.yaw - target.yaw) < 0.08,
    `a held gaze should converge on its target, ended at ${state.yaw.toFixed(3)}`);
  assert.ok(Math.abs(state.pitch - target.pitch) < 0.06, 'and settle in pitch too');
}

// --- in conversation it looks at whoever it is talking to ---------------------
{
  const state = createGazeState(3);
  const trace = look(state, 40, {
    player: { yaw: 0.3, pitch: 0 }, neighbour: { yaw: -0.8, pitch: 0 }, lockOn: 'player',
  });
  assert.ok(trace.every((f) => f.focus === 'player'),
    'a resident in conversation must not look away at the scenery');
}
{
  // The same lock holds two residents on each other while THEY are talking.
  const state = createGazeState(4);
  const trace = look(state, 40, {
    player: { yaw: 0.2, pitch: 0 }, neighbour: { yaw: -0.5, pitch: 0 }, lockOn: 'neighbour',
  });
  assert.ok(trace.every((f) => f.focus === 'neighbour'),
    'two residents in conversation must hold each other, not turn to the player');
}

// --- and it does look around when it is not ----------------------------------
{
  const state = createGazeState(21);
  const focuses = new Set(look(state, 240, {
    player: { yaw: 0.4, pitch: 0 }, neighbour: { yaw: -0.6, pitch: 0.1 },
    held: { yaw: 0.2, pitch: 0.5 }, vista: { yaw: -1.2, pitch: -0.05 },
  }).map((f) => f.focus));
  assert.ok(focuses.size >= 3,
    `a resident should spread its attention around, only ever used ${[...focuses]}`);
}

// --- the player must not dominate --------------------------------------------
// Everyone on the platform staring at the player is the thing this weighting
// exists to prevent: it reads as a room full of people waiting to be spoken to.
{
  let onPlayer = 0;
  let samples = 0;
  for (let seed = 0; seed < 24; seed++) {
    const state = createGazeState(seed * 7919 + 3);
    for (const { focus } of look(state, 120, {
      player: { yaw: 0.3, pitch: 0 }, neighbour: { yaw: -0.7, pitch: 0 },
      held: { yaw: 0.2, pitch: 0.5 }, vista: { yaw: -1.1, pitch: -0.05 },
    })) {
      samples++;
      if (focus === 'player') onPlayer++;
    }
  }
  const share = onPlayer / samples;
  assert.ok(share < 0.35, `residents should not spend ${(share * 100).toFixed(0)}% of their time watching the player`);
  assert.ok(share > 0.05, 'but should still notice them sometimes');
}

// --- proximity still matters --------------------------------------------------
{
  const near = createGazeState(55);
  const far = createGazeState(55);
  const count = (state, playerInterest) => look(state, 200, {
    player: { yaw: 0.3, pitch: 0 }, vista: { yaw: -1.0, pitch: 0 }, playerInterest,
  }).filter((f) => f.focus === 'player').length;
  assert.ok(count(near, 1) > count(far, 0.15),
    'a resident should notice a player standing beside them more than one across the platform');
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

// --- a crowd does not turn as one -----------------------------------------------
// The bug: everyone within range got a fixed sub-second fuse and then stared,
// so walking into a market turned every head in it on the same frame.
{
  const rng = mulberry32(4242);
  const N = 4000;
  let immediate = 0, later = 0, never = 0, worstDelay = 0;
  for (let i = 0; i < N; i++) {
    const notice = noticeOnApproach(rng, 6);
    if (!notice) { never++; continue; }
    if (notice.delay <= 0.4) immediate++; else later++;
    worstDelay = Math.max(worstDelay, notice.delay);
    assert.ok(notice.hold >= NOTICE.holdMin && notice.hold <= NOTICE.holdMax,
      'a look should last a couple of seconds, not lock on');
  }
  assert.ok(Math.abs(immediate / N - NOTICE.immediateChance) < 0.03,
    `about a quarter should look straight away, got ${(immediate / N).toFixed(3)}`);
  assert.ok(Math.abs(later / N - NOTICE.eventualChance) < 0.03,
    `about half should look later, got ${(later / N).toFixed(3)}`);
  assert.ok(Math.abs(never / N - 0.25) < 0.03,
    `about a quarter should never look up, got ${(never / N).toFixed(3)}`);
  assert.ok(worstDelay <= NOTICE.window,
    `a scheduled look must fall inside the window, got ${worstDelay.toFixed(2)}s`);

  // Spread, not synchrony: the delays of a crowd must not cluster on one value.
  const delays = [];
  for (let i = 0; i < 200; i++) {
    const notice = noticeOnApproach(rng, 8);
    if (notice) delays.push(notice.delay);
  }
  const spread = Math.max(...delays) - Math.min(...delays);
  assert.ok(spread > NOTICE.window * 0.5,
    `a crowd's looks must be spread over seconds, got ${spread.toFixed(2)}s`);
}

// --- but one or two people still look up, which is only polite ---------------------
{
  const rng = mulberry32(77);
  for (let i = 0; i < 300; i++) {
    const notice = noticeOnApproach(rng, NOTICE.crowd);
    assert.ok(notice, 'a lone trader should acknowledge someone walking up');
    assert.ok(notice.delay < 0.6, 'and should not take seconds about it');
  }
}

console.log('npcgaze PASS · stays inside the neck\'s range · settles on its target · '
  + 'holds the eye in conversation · shifts attention otherwise · never freezes · '
  + 'a crowd notices you one at a time · seeded');

// --- looking at nothing in particular, on purpose ----------------------------
// 'glance' is the lock a resident takes while composing an answer. It has no
// candidate of its own, so it has to be honoured before the candidate lookup or
// it silently falls through to the weighted pick — and a thinking resident goes
// straight back to staring at the player.
{
  const state = createGazeState(31);
  const player = { yaw: 0, pitch: 0 };
  let held = 0;
  for (let step = 0; step < 400; step++) {
    advanceGaze(state, 1 / 60, { player, lockOn: 'glance', playerInterest: 1 });
    if (state.focus === 'glance') held++;
  }
  assert.equal(held, 400, 'a glance lock never reverts to the player mid-thought');
  assert.ok(Math.abs(state.yaw) > 0.02,
    'and it actually looks somewhere, rather than resolving to dead ahead');

  // Releasing the lock lets the player win again.
  let returned = false;
  for (let step = 0; step < 900 && !returned; step++) {
    advanceGaze(state, 1 / 60, { player, lockOn: 'player' });
    if (state.focus === 'player') returned = true;
  }
  assert.ok(returned, 'the eyes come back when the answer arrives');
}
