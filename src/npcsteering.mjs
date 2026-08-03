const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const damp = (value, target, sharpness, dt) => target + (value - target) * Math.exp(-sharpness * Math.max(0, dt));
const dampAngle = (value, target, sharpness, dt) => {
  const delta = Math.atan2(Math.sin(target - value), Math.cos(target - value));
  return value + delta * (1 - Math.exp(-sharpness * Math.max(0, dt)));
};

export function createNpcSteeringState(heading = 0) {
  return { vx: 0, vz: 0, heading, speed: 0, blockedTime: 0 };
}

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
  // Yield sideways instead of pushing residents into a shared centre point.
  let avoidX = 0, avoidZ = 0;
  for (const other of neighbours) {
    const ox = position.x - other.x, oz = position.z - other.z;
    const separation = Math.hypot(ox, oz);
    if (separation > 1e-4 && separation < personalSpace) {
      const weight = (1 - separation / personalSpace) ** 2;
      avoidX += ox / separation * weight; avoidZ += oz / separation * weight;
    }
  }
  tx += avoidX * 1.8; tz += avoidZ * 1.8;
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
  const collision = resolveMovement?.(position, previous);
  state.blockedTime = collision?.blocked ? state.blockedTime + safeDt : Math.max(0, state.blockedTime - safeDt * 2);
  if (collision?.blocked) {
    state.vx *= 0.35; state.vz *= 0.35; state.speed *= 0.6;
  }
  // Arrival belongs to the position collision resolution actually accepted,
  // not the position at the start of the frame. A blocked intermediate corner
  // must remain active even when the collision projection leaves the actor
  // inside the look-ahead radius; otherwise the next segment can steer them
  // through the same wall.
  const resolvedDistance = Math.hypot(target.x - position.x, target.z - position.z);
  const arrived = nextTarget
    ? !collision?.blocked && resolvedDistance <= 0.78
    : resolvedDistance <= stopRadius;
  return {
    distance: resolvedDistance,
    arrived,
    heading: state.heading,
    speed: state.speed,
    blocked: !!collision?.blocked,
  };
}
