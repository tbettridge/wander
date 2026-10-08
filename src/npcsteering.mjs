const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const damp = (value, target, sharpness, dt) => target + (value - target) * Math.exp(-sharpness * Math.max(0, dt));
const dampAngle = (value, target, sharpness, dt) => {
  const delta = Math.atan2(Math.sin(target - value), Math.cos(target - value));
  return value + delta * (1 - Math.exp(-sharpness * Math.max(0, dt)));
};

export function createNpcSteeringState(heading = 0) {
  return {
    vx: 0, vz: 0, heading, speed: 0, blockedTime: 0,
    slideSign: 0, stallTime: 0, bestDistance: Infinity, targetX: NaN, targetZ: NaN,
    sinceContact: Infinity,
  };
}

// Progress, not contact, is what tells a resident it is stuck.
//
// Contact alone oscillates — a blocked resident is pushed out, drifts back and
// touches again — and `blockedTime` drains at twice the rate it fills, so on a
// real wedge it hovers near zero and never crosses any threshold. What actually
// separates walking from grinding is whether the gap to the waypoint is still
// closing, so the stall clock resets on progress and on nothing else.

/** Stalled this long and the resident starts working along the obstruction. */
const SLIDE_AFTER = 0.45;
/** Stalled this long and the waypoint itself is written off as unreachable. */
const UNSTICK_AFTER = 2.5;
/** Ground that has to be gained before the stall clock resets. */
const PROGRESS_EPSILON = 0.05;
/**
 * A stall only counts as a wedge if something was actually in the way.
 *
 * Rounding a corner also stops the gap to the current waypoint closing, because
 * the look-ahead is already steering at the next one — releasing the waypoint
 * for that would cut a corner off every turn in the village. Measured as time
 * since the last contact rather than as an accumulated total: a wedged resident
 * touches in bursts of a few frames in ten, which averages away in any timer
 * that drains while it is not touching.
 */
const CONTACT_RECENCY = 1;

/** A walker's half-width, for predicting a pass. */
const BODY_RADIUS = 0.3;
/** Centres never end a step closer than this. */
export const MIN_SEPARATION = 0.55;
/** The most a body is moved out of an overlap in one pass. */
const MAX_SEPARATION_STEP = 0.07;
/** How far ahead, in seconds and metres, people watch for a collision. */
const PREDICT_HORIZON = 2.4;
const PREDICT_RANGE = 5;

/** Smooth path following with arrival braking and lightweight personal space. */
export function advanceNpcSteering(state, {
  position, target, nextTarget = null, dt = 1 / 60, maxSpeed = 1.25,
  arrivalRadius = 0.7, stopRadius = 0.1, neighbours = [], personalSpace = 0.82,
  resolveMovement = null,
} = {}) {
  const safeDt = clamp(dt, 0, 0.1);
  const dx = target.x - position.x, dz = target.z - position.z;
  const distance = Math.hypot(dx, dz);
  let tx = distance > 1e-5 ? dx / distance : 0;
  let tz = distance > 1e-5 ? dz / distance : 0;
  // Look through a corner as it approaches instead of reaching the waypoint,
  // stopping, and snapping to the next segment.
  if (nextTarget && distance < 1.35) {
    const ndx = nextTarget.x - target.x, ndz = nextTarget.z - target.z;
    const nl = Math.hypot(ndx, ndz) || 1;
    const blend = clamp(1 - distance / 1.35, 0, 0.55);
    tx = tx * (1 - blend) + ndx / nl * blend;
    tz = tz * (1 - blend) + ndz / nl * blend;
    const length = Math.hypot(tx, tz) || 1; tx /= length; tz /= length;
  }
  // Yield sideways instead of pushing residents into a shared centre point,
  // and see people coming.
  //
  // Personal space alone only reacts once two people are already touching,
  // so a pair walking straight at each other met nose to nose and slid
  // through. Each neighbour that carries a velocity is also projected to its
  // closest approach; if that falls inside a body's width in the next couple
  // of seconds, this walker eases toward the side that clears it, biased to
  // its own right so two people meeting head-on pass instead of dancing.
  //
  // A neighbour is a position ({x, z}, or {pos}) with optional vx/vz, an
  // optional `radius`, and `heavy` for something that does not yield (the
  // player).
  let avoidX = 0, avoidZ = 0;
  const fx = tx, fz = tz;
  for (const other of neighbours) {
    const ox0 = other.pos ? other.pos.x : other.x, oz0 = other.pos ? other.pos.z : other.z;
    const ox = position.x - ox0, oz = position.z - oz0;
    const separation = Math.hypot(ox, oz);
    if (separation < 1e-4 || separation > PREDICT_RANGE) continue;
    const space = other.radius ? other.radius + personalSpace * 0.5 : personalSpace;
    if (separation < space) {
      const weight = (1 - separation / space) ** 2;
      avoidX += ox / separation * weight * 1.8; avoidZ += oz / separation * weight * 1.8;
    }
    // Only a neighbour that says how it is moving can be predicted; a bare
    // position is somebody whose motion is unknown, not somebody standing still.
    if (!Number.isFinite(other.vx)) continue;
    const rvx = other.vx - state.vx, rvz = other.vz - state.vz;
    const rv2 = rvx * rvx + rvz * rvz;
    if (rv2 < 1e-4) continue;
    // `other` relative to this walker is (-ox, -oz); when is it nearest?
    const t = (ox * rvx + oz * rvz) / rv2;
    if (t <= 0 || t > PREDICT_HORIZON) continue;
    const cx = -ox + rvx * t, cz = -oz + rvz * t;
    const d = Math.hypot(cx, cz);
    const reach = (other.radius || BODY_RADIUS) + BODY_RADIUS + 0.28;
    if (d >= reach) continue;
    const urgency = (1 - t / PREDICT_HORIZON) * (1 - d / reach);
    // Away from where they will be; straight to the right when it is dead on.
    let ax = d > 0.08 ? -cx / d : fz, az = d > 0.08 ? -cz / d : -fx;
    ax = ax * 0.7 + fz * 0.3; az = az * 0.7 - fx * 0.3;
    avoidX += ax * urgency * 2.4; avoidZ += az * urgency * 2.4;
  }
  tx += avoidX; tz += avoidZ;
  // Work along what the route did not know was there.
  //
  // Lanes are planned against building footprints alone, so a legal route can
  // point straight through a wellhead, a market stall or a plinth rim. Holding
  // the original heading just grinds; steering across the obstruction lets the
  // resident follow its face until the corner clears. The side is picked once
  // and held — alternating it parks them against the middle of the wall.
  if (state.stallTime > SLIDE_AFTER && state.sinceContact < CONTACT_RECENCY) {
    if (!state.slideSign) state.slideSign = state.heading >= 0 ? 1 : -1;
    const blend = clamp((state.stallTime - SLIDE_AFTER) / 0.9, 0, 1);
    const px = -tz * state.slideSign, pz = tx * state.slideSign;
    tx += px * blend * 1.6; tz += pz * blend * 1.6;
  } else if (state.slideSign) state.slideSign = 0;
  const directionLength = Math.hypot(tx, tz) || 1; tx /= directionLength; tz /= directionLength;
  const desiredSpeed = distance <= stopRadius ? 0
    : maxSpeed * clamp((distance - stopRadius) / Math.max(0.05, arrivalRadius), 0.12, 1);
  const sharpness = desiredSpeed > state.speed ? 4.8 : 8.5;
  state.speed = damp(state.speed, desiredSpeed, sharpness, safeDt);
  if (desiredSpeed === 0 && state.speed < 0.025) state.speed = 0;
  state.vx = damp(state.vx, tx * state.speed, sharpness, safeDt);
  state.vz = damp(state.vz, tz * state.speed, sharpness, safeDt);
  if (state.speed > 0.04) state.heading = dampAngle(state.heading, Math.atan2(state.vx, state.vz), 12, safeDt);
  const previous = { x: position.x, y: position.y, z: position.z };
  position.x += state.vx * safeDt; position.z += state.vz * safeDt;
  // Bodies do not overlap. Whatever the steering above decided, a walker that
  // ends a step inside someone's width is moved back out of it — all the way
  // if the other is standing still or will not yield, half if they are
  // walking too and will take the other half on their own turn. Before the
  // wall resolve, so this can never push anyone through a wall.
  // Two passes: in a crush, stepping out of one person steps into another.
  for (let pass = 0; pass < 2; pass++) {
    for (const other of neighbours) {
      const ox0 = other.pos ? other.pos.x : other.x, oz0 = other.pos ? other.pos.z : other.z;
      const ox = position.x - ox0, oz = position.z - oz0;
      const separation = Math.hypot(ox, oz);
      const minimum = other.minSeparation ?? MIN_SEPARATION;
      if (separation < 1e-4 || separation >= minimum) continue;
      // A deep overlap is corrected outright whoever is moving.
      const standing = Number.isFinite(other.speed) && other.speed <= 0.05;
      const share = other.heavy || standing || separation < minimum * 0.75 ? 1 : 0.6;
      // A shallow brush is eased out over a few frames rather than popped; a
      // body inside a body is corrected at once.
      const deep = separation < minimum * 0.75;
      const push = deep ? (minimum - separation) * share
        : Math.min(MAX_SEPARATION_STEP, (minimum - separation) * share);
      position.x += ox / separation * push; position.z += oz / separation * push;
    }
  }
  const collision = resolveMovement?.(position, previous);
  state.blockedTime = collision?.blocked ? state.blockedTime + safeDt : Math.max(0, state.blockedTime - safeDt * 2);
  state.sinceContact = collision?.blocked ? 0 : state.sinceContact + safeDt;
  if (collision?.blocked) {
    state.vx *= 0.35; state.vz *= 0.35; state.speed *= 0.6;
  }
  // Arrival belongs to the position collision resolution actually accepted,
  // not the position at the start of the frame. A blocked intermediate corner
  // must remain active even when the collision projection leaves the actor
  // inside the look-ahead radius; otherwise the next segment can steer them
  // through the same wall.
  const resolvedDistance = Math.hypot(target.x - position.x, target.z - position.z);
  if (Math.abs(target.x - state.targetX) > 1e-6 || Math.abs(target.z - state.targetZ) > 1e-6) {
    state.targetX = target.x; state.targetZ = target.z;
    state.bestDistance = resolvedDistance; state.stallTime = 0;
  } else if (resolvedDistance < state.bestDistance - PROGRESS_EPSILON) {
    state.bestDistance = resolvedDistance; state.stallTime = 0;
  } else state.stallTime += safeDt;
  // Write off a waypoint that cannot be reached at all.
  //
  // `arrived` is gated on not being blocked, so without this a resident wedged
  // against unplanned geometry can never advance its route index, never reaches
  // its destination building, and so never re-plans: it pushes into the same
  // wall for the rest of the session, and everyone else routed down that lane
  // piles up behind it. Releasing the waypoint cannot walk anyone through that
  // wall — the collision resolver still owns the position — so the worst case
  // is a cut corner and a second release further along.
  const abandoned = state.stallTime >= UNSTICK_AFTER
    && state.sinceContact < CONTACT_RECENCY
    && resolvedDistance > stopRadius;
  if (abandoned) { state.stallTime = 0; state.slideSign = 0; }
  const arrived = abandoned || (nextTarget
    ? !collision?.blocked && resolvedDistance <= 0.78
    : resolvedDistance <= stopRadius);
  return {
    distance: resolvedDistance,
    arrived,
    abandoned,
    heading: state.heading,
    speed: state.speed,
    blocked: !!collision?.blocked,
  };
}
