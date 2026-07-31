// Autonomy for station residents, within rules.
//
// The residents used to move on an authored curve: `along = home + sin(t) * d`.
// That is a path, not a behaviour, and it has two problems. It never varies, so
// a station looks the same every visit; and its velocity reverses instantly at
// each end of the sweep, which asks the body to turn 180 degrees while still
// travelling at full speed. A gait cannot plant a foot through that — the stance
// foot is dragged round the turn.
//
// So: a small behaviour instead. A resident holds a position, decides where it
// would like to stand next, turns to face it WHILE STOPPED, walks there with a
// real acceleration and a real braking distance, arrives, and waits. Its choices
// are bounded by a roaming box around the spot it was posted to, and it never
// leaves the platform.
//
// Turning on the spot is the load-bearing rule. It is what lets every step be
// planted: the body only ever travels along the direction it already faces, so
// the direction of travel and the sagittal plane the legs swing in never
// disagree. Everything else here is flavour by comparison.
//
// Coordinates are the station's own frame, the same one the slots are authored
// in: `along` runs with the rails and `across` sits on the platform. `facing` is
// the angle of travel within that plane, so (cos facing, sin facing) is the
// direction of the walk. THREE-free, so the behaviour can be asserted without a
// renderer.

import { mulberry32 } from './noise.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const WANDER = Object.freeze({
  // A stroll along a platform, not a march. Comfortable human walking is nearer
  // 1.4 m/s, but that reads as hurrying in a space this small.
  strollSpeed: 0.62,
  accel: 0.85,
  // Braking has to be firmer than acceleration or the arrival overshoots and
  // the resident circles its own target.
  brake: 1.30,
  arriveRadius: 0.25,
  turnRate: 2.60,
  // How closely the body must already face its target before it will walk. Loose
  // enough that the last few degrees are steered out during the walk, tight
  // enough that no step is ever taken sideways.
  headingTolerance: 0.30,
  // Below this the resident counts as standing, and may turn to face a speaker.
  idleSpeed: 0.05,
});

/**
 * How restless each posting is.
 *
 * A porter paces the length of the platform; someone waiting for a train mostly
 * stands, shifts their weight, and occasionally moves a pace or two. `settle` is
 * the chance that a dwell is a long one rather than a short pause.
 */
export const WANDER_TEMPERAMENT = Object.freeze({
  pace: Object.freeze({ roamAlong: 7.5, roamAcross: 0.55, dwellMin: 0.7, dwellMax: 2.4, settle: 0.20 }),
  attend: Object.freeze({ roamAlong: 2.4, roamAcross: 0.50, dwellMin: 2.5, dwellMax: 7.0, settle: 0.55 }),
  wait: Object.freeze({ roamAlong: 1.5, roamAcross: 0.40, dwellMin: 3.5, dwellMax: 9.0, settle: 0.70 }),
  gesture: Object.freeze({ roamAlong: 1.0, roamAcross: 0.35, dwellMin: 4.0, dwellMax: 10.0, settle: 0.80 }),
});

export function wanderTemperament(activity) {
  return WANDER_TEMPERAMENT[activity] || WANDER_TEMPERAMENT.wait;
}

/**
 * The box a resident may roam in: its temperament around its posted spot, cut
 * down to whatever the platform actually allows.
 */
export function wanderBox(home, temperament, bounds) {
  return {
    alongMin: Math.max(bounds.alongMin, home.along - temperament.roamAlong),
    alongMax: Math.min(bounds.alongMax, home.along + temperament.roamAlong),
    acrossMin: Math.max(bounds.acrossMin, home.across - temperament.roamAcross),
    acrossMax: Math.min(bounds.acrossMax, home.across + temperament.roamAcross),
  };
}

export function createWanderState(seed, home, activity, bounds) {
  const temperament = wanderTemperament(activity);
  const box = wanderBox(home, temperament, bounds);
  const rng = mulberry32(seed >>> 0);
  return {
    rng,
    temperament,
    // Two different things. `box` is where a resident CHOOSES to stand, left to
    // itself; `bounds` is where it may physically be. They differ because a
    // resident will step outside its usual patch to go and speak to somebody
    // (see requestVisit) — but it may never step off the platform, and once the
    // errand is over its own next choice brings it home again.
    box,
    bounds,
    along: clamp(home.along, box.alongMin, box.alongMax),
    across: clamp(home.across, box.acrossMin, box.acrossMax),
    // Posted facing is across the platform, toward the track: that is where a
    // train, and therefore the resident's attention, will arrive from.
    facing: home.across >= 0 ? Math.PI : 0,
    speed: 0,
    mode: 'dwell',
    timer: temperament.dwellMin + rng() * (temperament.dwellMax - temperament.dwellMin),
    targetAlong: null,
    targetAcross: null,
  };
}

/**
 * Send a resident somewhere specific — to stand beside someone, in practice.
 *
 * The destination is clamped to the platform rather than to the resident's own
 * patch, because crossing to speak to somebody is exactly the case where a
 * person leaves the spot they were posted to. Nothing brings them back
 * explicitly; the next target they choose for themselves is inside their own
 * box, so they drift home on their own.
 */
export function requestVisit(state, along, across) {
  const limit = state.bounds || state.box;
  state.targetAlong = clamp(along, limit.alongMin, limit.alongMax);
  state.targetAcross = clamp(across, limit.acrossMin, limit.acrossMax);
  state.mode = 'turn';
  return state;
}

function chooseTarget(state) {
  const { box, rng } = state;
  state.targetAlong = box.alongMin + rng() * (box.alongMax - box.alongMin);
  state.targetAcross = box.acrossMin + rng() * (box.acrossMax - box.acrossMin);
  // A target too close to stand up for is not worth the walk; hold instead.
  const reach = Math.hypot(state.targetAlong - state.along, state.targetAcross - state.across);
  return reach > WANDER.arriveRadius * 2;
}

function dwellTime(state) {
  const t = state.temperament;
  const long = state.rng() < t.settle;
  const min = long ? (t.dwellMin + t.dwellMax) * 0.5 : t.dwellMin;
  const max = long ? t.dwellMax : (t.dwellMin + t.dwellMax) * 0.5;
  return min + state.rng() * (max - min);
}

function turnToward(facing, target, rate, dt) {
  const delta = Math.atan2(Math.sin(target - facing), Math.cos(target - facing));
  const step = rate * dt;
  if (Math.abs(delta) <= step) return { facing: target, error: 0 };
  return { facing: facing + Math.sign(delta) * step, error: Math.abs(delta) - step };
}

/**
 * Advance one resident's behaviour by dt.
 *
 * Mutates and returns `state`. `along`/`across`/`facing`/`speed` are what the
 * renderer reads; `speed` is the real thing, not a curve, so the gait can be
 * driven straight from the distance actually covered.
 */
export function advanceWander(state, dt = 0.016, { held = false } = {}) {
  // A resident in conversation stands still and lets the caller aim it.
  if (held) {
    state.speed = Math.max(0, state.speed - WANDER.brake * dt);
    if (state.mode === 'walk') state.mode = 'dwell';
    if (state.speed < 1e-4) state.speed = 0;
    state.timer = Math.max(state.timer, 0.5);
    return state;
  }

  if (state.mode === 'dwell') {
    state.speed = Math.max(0, state.speed - WANDER.brake * dt);
    state.timer -= dt;
    if (state.timer <= 0) {
      state.mode = chooseTarget(state) ? 'turn' : 'dwell';
      if (state.mode === 'dwell') state.timer = dwellTime(state);
    }
    return state;
  }

  const toAlong = state.targetAlong - state.along;
  const toAcross = state.targetAcross - state.across;
  const distance = Math.hypot(toAlong, toAcross);
  const bearing = Math.atan2(toAcross, toAlong);

  if (state.mode === 'turn') {
    // Standing still through the turn is the whole point: see the header.
    state.speed = Math.max(0, state.speed - WANDER.brake * dt);
    const turned = turnToward(state.facing, bearing, WANDER.turnRate, dt);
    state.facing = turned.facing;
    if (turned.error <= WANDER.headingTolerance) state.mode = 'walk';
    return state;
  }

  // walk: steer out the remaining error while moving, and brake in time to stop
  // ON the target rather than around it.
  const turned = turnToward(state.facing, bearing, WANDER.turnRate * 0.55, dt);
  state.facing = turned.facing;
  const approach = Math.sqrt(Math.max(0, 2 * WANDER.brake * Math.max(0, distance - WANDER.arriveRadius * 0.5)));
  const ceiling = Math.min(WANDER.strollSpeed, approach);
  state.speed = state.speed < ceiling
    ? Math.min(ceiling, state.speed + WANDER.accel * dt)
    : Math.max(ceiling, state.speed - WANDER.brake * dt);

  const step = state.speed * dt;
  const limit = state.bounds || state.box;
  state.along = clamp(state.along + Math.cos(state.facing) * step, limit.alongMin, limit.alongMax);
  state.across = clamp(state.across + Math.sin(state.facing) * step, limit.acrossMin, limit.acrossMax);

  if (distance <= WANDER.arriveRadius) {
    state.mode = 'dwell';
    state.timer = dwellTime(state);
    state.targetAlong = null;
    state.targetAcross = null;
  }
  return state;
}

export { TAU as WANDER_TAU };
