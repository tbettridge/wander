// Riding a horse.
//
// The player does not become the horse. The horse keeps running its own
// locomotion — gait, turn radius, terrain grade, reactive hooves — and the
// rider only supplies intent: how much forward, how much rein. Everything that
// makes the animal move convincingly is downstream of those two numbers, so
// steering it by writing its heading directly would throw all of it away.
//
// The camera sits where a rider's head is: above and slightly behind the
// withers, high enough that the crest and a little of the poll show at the
// bottom of frame. Mouselook stays free the whole time — you look around from
// the saddle rather than being locked to the horse's facing. That is the same
// arrangement the train service uses for a seated passenger, and it uses the
// same two controls flags: input locked, look allowed.
//
// THREE-free so the geometry is testable without a renderer.

import { RIDDEN_GALLOP_SPEED, RIDDEN_TROT_SPEED } from './pace.mjs';

// How close you must be to a horse to get on it.
export const MOUNT_REACH = 3.4;
// Where the rider sits, in the horse's own frame: back from the withers toward
// the middle of the barrel, and up by a fraction of the animal's height.
export const SEAT_BACK = 0.16;
export const SEAT_RISE = 0.72;
// Eye height above the seat. Enough to see over the neck, low enough that the
// crest stays in shot.
export const EYE_ABOVE_SEAT = 0.62;

// How far the seat throws the rider about, in metres, at a walk and at a full
// gallop. Small numbers on purpose: this is the suggestion of a horse under you,
// not a camera earthquake, and the eye notices a rhythm long before it notices
// an amplitude.
export const JOSTLE_WALK = 0.010;
export const JOSTLE_GALLOP = 0.050;
// The ramp between them. A working trot is already almost half of gallop speed,
// so a gentle curve made ordinary riding bounce as much as hard riding; this
// keeps the trot discreet and spends the movement at the top of the range,
// where the rider is meant to feel it.
const JOSTLE_RAMP = 2.4;
// Below this the horse is shifting its weight rather than travelling, and a
// standing horse must not bounce the view.
const JOSTLE_ONSET = 1.1;
const TAU = Math.PI * 2;
// An irrational multiple, so the two bounce terms never come back into step.
const PHI = 1.6180339887;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function mix(a, b, t) { return a + (b - a) * t; }

/**
 * The nearest mountable animal, or null.
 *
 * Only tame animals, and only ones standing still enough to get on: a horse
 * already trotting away is not offering you a leg up.
 */
export function nearestMount(agents, position, reach = MOUNT_REACH) {
  let best = null;
  let bestDistance = reach;
  for (const agent of agents) {
    if (!agent?.recipe?.tame) continue;
    if (agent.speed > 1.2) continue;
    const distance = Math.hypot(
      agent.mesh.position.x - position.x,
      agent.mesh.position.z - position.z,
    );
    if (distance < bestDistance) { bestDistance = distance; best = agent; }
  }
  return best;
}

/**
 * Where the rider's eye sits for a horse at this pose.
 *
 * `shoulderY` is the animal's withers height in metres; the seat is placed
 * against that rather than against a fixed offset, so a foal and a shire both
 * carry the rider in the right place.
 */
export function seatPose(mount, shoulderY) {
  const heading = mount.heading;
  const back = shoulderY * SEAT_BACK;
  return {
    x: mount.mesh.position.x - Math.sin(heading) * back,
    y: mount.mesh.position.y + shoulderY * SEAT_RISE + EYE_ABOVE_SEAT,
    z: mount.mesh.position.z - Math.cos(heading) * back,
  };
}

/**
 * Rider intent from whatever input is present.
 *
 * There is no reverse, by design and not by omission: a horse under saddle does
 * not walk backwards on request, and the gait solver has no backward walk to
 * play if it did. Pressing back simply asks for nothing.
 */
export function riderIntent({ forwardKey = false, backKey = false, leftKey = false,
  rightKey = false, sprintKey = false, stickX = 0, stickY = 0 } = {}) {
  // Stick forward is negative Y on every controller here, matching the walking
  // controls. Back on the stick is ignored for the same reason as the back key.
  const stickForward = Math.max(0, -stickY);
  const forward = clamp(Math.max(forwardKey ? 1 : 0, stickForward), 0, 1);
  const steerKeys = (leftKey ? 1 : 0) - (rightKey ? 1 : 0);
  const steer = clamp(steerKeys + (Math.abs(stickX) > 0.12 ? -stickX : 0), -1, 1);
  // Asking for a gallop while asking for no drive is asking for nothing: the
  // sprint key raises the ceiling, it does not itself set the horse going.
  const sprint = !!sprintKey && forward > 0.04;
  void backKey;
  return {
    forward,
    steer,
    sprint,
    topSpeed: sprint ? RIDDEN_GALLOP_SPEED : RIDDEN_TROT_SPEED,
  };
}

/**
 * How much the saddle throws the rider about this instant.
 *
 * Returned in the horse's own frame — `lift` up, `lateral` to its right,
 * `surge` along its facing — so the caller rotates it by the heading rather
 * than this having to know which way is north.
 *
 * `strideCycles` is the horse's gait clock in whole strides, so the bounce is
 * locked to the actual footfalls instead of running on a clock of its own; a
 * shake that drifts against the legs is what makes camera shake read as a
 * rumble effect rather than as an animal.
 */
export function saddleJostle(strideCycles, speed, scale = 1) {
  const still = { lift: 0, lateral: 0, surge: 0 };
  const moving = clamp(speed / JOSTLE_ONSET, 0, 1);
  if (!(moving > 0) || !(scale > 0) || !Number.isFinite(strideCycles)) return still;
  const pace = clamp(speed / RIDDEN_GALLOP_SPEED, 0, 1);
  const amplitude = moving * scale * mix(JOSTLE_WALK, JOSTLE_GALLOP, pace ** JOSTLE_RAMP);
  const beat = strideCycles * TAU;
  // Two beats per stride: at a trot the diagonal pairs land alternately, so the
  // back rises and falls twice a cycle. The second term runs at an irrational
  // multiple of the first, so the sum never repeats and no two strides land
  // quite alike — irregularity without a random number, which keeps a replayed
  // ride identical to the first one.
  const bounce = Math.sin(beat * 2) * 0.64 + Math.sin(beat * 2 * PHI + 1.1) * 0.36;
  // The barrel rolls once per stride as the weight crosses from one diagonal to
  // the other, so the sway runs at half the bounce and a quarter-turn behind it.
  const sway = Math.sin(beat + 0.7);
  const surge = Math.sin(beat * 2 - 0.5) * 0.34;
  // A slow swell over several strides, so some land harder than others.
  const swell = 1 + 0.24 * Math.sin(beat * 0.31 + 0.9);
  return {
    lift: bounce * amplitude * swell,
    lateral: sway * amplitude * 0.52 * swell,
    surge: surge * amplitude * swell,
  };
}

export class HorseRiding {
  constructor(controls, { onMount = null, onDismount = null } = {}) {
    this.controls = controls;
    this.mount = null;
    this.shoulderY = 1;
    this.onMount = onMount;
    this.onDismount = onDismount;
    this.previousLook = false;
    // Scales the saddle's throw. Turned down for a headset and off entirely for
    // a player who has asked for reduced motion, because a shaking horizon is
    // the one thing you cannot look away from.
    this.jostleScale = 1;
    this.jostleClock = 0;
  }

  get riding() { return !!this.mount; }

  /**
   * Get on, if there is anything to get on.
   *
   * Movement input is locked and mouselook explicitly allowed — the same pair
   * the train uses for a seated passenger. Without the look flag the player
   * would be frozen facing one way for the whole ride.
   */
  tryMount(agents, position) {
    if (this.mount) return false;
    const candidate = nearestMount(agents, position);
    if (!candidate) return false;
    this.mount = candidate;
    this.shoulderY = candidate.dimensions?.shoulderY
      ?? candidate.rig?.dimensions?.shoulderY ?? 1.5;
    candidate.setRider({ forward: 0, steer: 0 });
    this.controls.setInputLocked(true);
    this.previousLook = this.controls.allowLook;
    this.controls.allowLook = true;
    this.onMount?.(candidate);
    return true;
  }

  /** Step down, landing beside the horse rather than inside it. */
  dismount() {
    if (!this.mount) return false;
    const horse = this.mount;
    horse.setRider(null);
    const side = horse.heading + Math.PI / 2;
    const clearance = Math.max(1.2, this.shoulderY * 0.9);
    this.controls.setInputLocked(false);
    this.controls.allowLook = this.previousLook;
    this.controls.place(
      horse.mesh.position.x + Math.sin(side) * clearance,
      horse.mesh.position.z + Math.cos(side) * clearance,
    );
    this.mount = null;
    this.onDismount?.(horse);
    return true;
  }

  toggle(agents, position) {
    return this.mount ? this.dismount() : this.tryMount(agents, position);
  }

  /**
   * Hand this frame's intent to the horse. Call BEFORE the animal updates, so
   * it steps on the current frame's input rather than the previous one's.
   */
  drive(input) {
    if (!this.mount) return null;
    // An animal that streams out from under the player would leave them riding
    // a corpse, so losing the mount dismounts cleanly.
    if (!this.mount.mesh.parent) { this.dismount(); return null; }
    const intent = riderIntent(input);
    this.mount.setRider(intent);
    return intent;
  }

  /**
   * Put the camera in the saddle. Call AFTER the animal updates: placing only
   * beforehand leaves the view a frame behind the horse and the ride swims.
   *
   * The rig is placed rather than moved, because while mounted the player's own
   * locomotion is switched off entirely — the horse's position IS the player's,
   * and nothing else may write it.
   */
  carry(dt = 0) {
    if (!this.mount) return null;
    const seat = seatPose(this.mount, this.shoulderY);
    const speed = this.mount.speed || 0;
    // Prefer the animal's own gait clock so the bounce lands with the hooves;
    // the local clock is only a stand-in for a mount that does not keep one.
    this.jostleClock += dt * (0.9 + speed * 0.22);
    const cycles = Number.isFinite(this.mount.gaitClock)
      ? this.mount.gaitClock : this.jostleClock;
    const throwOff = saddleJostle(cycles, speed, this.jostleScale);
    // Into world axes. Forward is (sin, cos) by this project's convention, so
    // the horse's right is (cos, -sin).
    const heading = this.mount.heading;
    this.controls.placeAt(
      seat.x + Math.sin(heading) * throwOff.surge + Math.cos(heading) * throwOff.lateral,
      seat.y + throwOff.lift,
      seat.z + Math.cos(heading) * throwOff.surge - Math.sin(heading) * throwOff.lateral,
    );
    return seat;
  }
}
