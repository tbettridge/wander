// Where a resident is looking.
//
// The head used to run a fixed sine sway: the same arc, forever, regardless of
// what was in front of it. That is what reads as stiff — not the amount of
// movement but its indifference. A head that never settles on anything is as
// lifeless as one that never moves.
//
// So the head holds a focus for a while, then chooses another. It looks at the
// player when the player is near, at whoever it is standing next to, or off at
// nothing in particular; it holds each for a second or two before moving on. On
// top of whatever it holds there is a slow drift, because a real head is never
// perfectly still even when its owner is staring at something.
//
// Angles are relative to the body, in the head bone's own frame: `yaw` is left
// and right, `pitch` is up (negative) and down (positive), matching a rotation
// about the head's local X. Both are clamped to a neck's actual range — past
// about 55 degrees a person turns their shoulders instead, and a head that
// swivels further than that looks like it came off.
//
// THREE-free, so the behaviour can be asserted without a renderer.

import { mulberry32 } from './noise.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const GAZE = Object.freeze({
  yawLimit: 0.95,    // ~54 degrees each way
  pitchLimit: 0.45,
  turnRate: 6.5,
  holdMin: 1.3,
  holdMax: 4.0,
  glanceYaw: 0.62,
  glancePitch: 0.16,
  // Walking, a person looks mostly where they are going.
  movingGlanceScale: 0.4,
  driftYaw: 0.045,
  driftPitch: 0.022,
  // The relative pull of each thing worth looking at. The player is one of
  // several and deliberately not the strongest: when every resident on a
  // platform watches you, none of them is inhabiting the place, they are all
  // just waiting to be spoken to. Someone absorbed in the book they are
  // carrying, or staring off over the fields, is what makes the one who DOES
  // look up feel like they chose to.
  weights: Object.freeze({
    player: 0.26,
    neighbour: 0.22,
    held: 0.20,
    vista: 0.32,
    glance: 0.22,
  }),
});

export function createGazeState(seed = 1, phase = 0) {
  const rng = mulberry32(seed >>> 0);
  return {
    rng,
    t: phase,
    hold: rng() * GAZE.holdMax,
    focus: 'ahead',
    glanceYaw: 0,
    glancePitch: 0,
    yaw: 0,
    pitch: 0,
  };
}

function pickFocus(state, candidates, playerInterest) {
  const w = GAZE.weights;
  const options = [
    ['player', candidates.player ? w.player * playerInterest : 0],
    ['neighbour', candidates.neighbour ? w.neighbour : 0],
    ['held', candidates.held ? w.held : 0],
    ['vista', candidates.vista ? w.vista : 0],
    ['glance', w.glance],
  ];
  const total = options.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = state.rng() * total;
  for (const [name, weight] of options) {
    roll -= weight;
    if (roll <= 0) return name;
  }
  return 'glance';
}

/**
 * Advance the gaze by dt and return the state, whose `yaw`/`pitch` the renderer
 * puts straight onto the head bone.
 *
 * `player` and `neighbour` are {yaw, pitch} in the head's frame, or null when
 * there is nobody to look at. Someone in conversation looks at whoever they are
 * talking to and nowhere else.
 */
export function advanceGaze(state, dt = 0.016, {
  player = null, neighbour = null, held = null, vista = null,
  lockOn = null, playerInterest = 1, moving = false,
} = {}) {
  const candidates = { player, neighbour, held, vista };
  state.t += dt;
  state.hold -= dt;

  // Someone in conversation — with the player or with the resident beside them
  // — looks at whoever they are talking to and nowhere else.
  if (lockOn && candidates[lockOn]) {
    state.focus = lockOn;
    state.hold = GAZE.holdMin;
  } else if (state.hold <= 0 || (state.focus !== 'glance' && !candidates[state.focus])) {
    state.focus = pickFocus(state, candidates, playerInterest);
    state.hold = GAZE.holdMin + state.rng() * (GAZE.holdMax - GAZE.holdMin);
    if (state.focus === 'glance') {
      const spread = moving ? GAZE.movingGlanceScale : 1;
      state.glanceYaw = (state.rng() * 2 - 1) * GAZE.glanceYaw * spread;
      state.glancePitch = (state.rng() * 2 - 1) * GAZE.glancePitch;
    }
  }

  let target = { yaw: 0, pitch: 0 };
  if (state.focus === 'glance') target = { yaw: state.glanceYaw, pitch: state.glancePitch };
  else if (candidates[state.focus]) target = candidates[state.focus];

  // A target further round than the neck reaches is not ignored — the head
  // turns as far as it can and holds there, which is what a person does.
  const wantYaw = clamp(
    wrapAngle(target.yaw) + Math.sin(state.t * 0.9) * GAZE.driftYaw,
    -GAZE.yawLimit, GAZE.yawLimit,
  );
  const wantPitch = clamp(
    target.pitch + Math.sin(state.t * 0.63 + 1.7) * GAZE.driftPitch,
    -GAZE.pitchLimit, GAZE.pitchLimit,
  );
  const k = 1 - Math.exp(-GAZE.turnRate * Math.min(dt, 0.1));
  state.yaw += (wantYaw - state.yaw) * k;
  state.pitch += (wantPitch - state.pitch) * k;
  return state;
}

export { wrapAngle as gazeWrapAngle };
