import { advanceBipedGait, createBipedState } from './npcgait.mjs';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const damp = (value, target, sharpness, dt) => target + (value - target) * Math.exp(-sharpness * Math.max(0, dt));
const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

export const NPC_LOCOMOTION_LOD = Object.freeze({ near: 48, medium: 105, far: 180 });

export function locomotionLod(distance = 0, { xr = false } = {}) {
  const scale = xr ? 0.72 : 1;
  if (distance <= NPC_LOCOMOTION_LOD.near * scale) return { tier: 'near', interval: 0, terrain: true };
  // A locomotion pose is root-relative. Holding it while the root continues to
  // translate visibly drags both feet across the floor, so visible walkers
  // always advance contact state every frame. LOD reduces surface detail and
  // avatar detail, never temporal continuity.
  if (distance <= NPC_LOCOMOTION_LOD.medium * scale) return { tier: 'medium', interval: 0, terrain: true };
  if (distance <= NPC_LOCOMOTION_LOD.far * scale) return { tier: 'far', interval: 0, terrain: false };
  return { tier: 'culled', interval: Infinity, terrain: false };
}

export function createNpcLocomotionState(phase = 0) {
  return {
    gait: createBipedState(phase), initialized: false,
    phaseSeed: ((phase % 1) + 1) % 1, resting: false,
    x: 0, y: 0, z: 0, heading: 0, travelHeading: 0,
    speed: 0, acceleration: 0, turnRate: 0,
    elapsed: 0, pose: null, teleported: false, supportId: null,
  };
}

export function resetNpcLocomotion(state, { x = 0, y = 0, z = 0, heading = 0 } = {}) {
  state.initialized = true; state.x = x; state.y = y; state.z = z;
  state.heading = heading; state.travelHeading = heading;
  state.speed = 0; state.acceleration = 0; state.turnRate = 0; state.elapsed = 0;
  state.gait = createBipedState(state.gait?.phase || 0); state.teleported = true;
  state.resting = false;
  state.supportId = null;
}

/**
 * One adapter for station residents, trail travellers, and settlement NPCs.
 * Movement remains owned by their behaviour systems; this controller turns
 * actual displacement into a stable, terrain-aware human pose.
 */
export function advanceNpcLocomotion(state, {
  dims, dt = 1 / 60, position = [0, 0, 0], heading = 0,
  requestedSpeed = null, surfaceQuery = null, fixedY = null,
  distance = 0, xr = false, held = false, talking = false, gesturePhase = 0,
  arrivalDistance = Infinity, actionKind = null,
} = {}) {
  const safeDt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
  const lod = locomotionLod(distance, { xr });
  const query = surfaceQuery || ((x, z) => ({ y: fixedY ?? position[1], normal: [0, 1, 0], supportId: 'fallback', surfaceKind: 'flat', walkable: true }));
  const centreSurface = query(position[0], position[2], position[1]);
  if (!state.initialized) resetNpcLocomotion(state, {
    x: position[0], y: position[1], z: position[2], heading,
  });
  const dx = position[0] - state.x, dz = position[2] - state.z;
  const displacement = Math.hypot(dx, dz);
  const measuredSpeed = safeDt > 1e-4 ? Math.min(4.2, displacement / safeDt) : 0;
  const dy = position[1] - state.y;
  const teleportThreshold = Math.max(0.72, (dims?.legLength || 0.9) * 0.9);
  if (displacement > teleportThreshold || safeDt <= 0) {
    resetNpcLocomotion(state, { x: position[0], y: position[1], z: position[2], heading });
  } else {
    const supportChanged = state.supportId !== null && centreSurface?.supportId
      && state.supportId !== centreSurface.supportId;
    const verticalTeleport = Math.abs(dy) > Math.max(0.16, (dims?.legLength || 0.9) * 0.20)
      || (supportChanged && Math.abs(dy) > 0.035);
    if (verticalTeleport) {
      // Contacts are world-space. A support handoff cannot leave them on the
      // previous floor while the root moves to the new one; reinitialize the
      // two contacts at the current gait phase without discarding horizontal
      // velocity.
      state.gait = createBipedState(state.gait?.phase || 0);
      state.pose = null;
      state.teleported = true;
    }
  }
  const rawSpeed = requestedSpeed === null
    ? measuredSpeed
    : Math.max(0, requestedSpeed);
  const targetSpeed = held ? 0 : rawSpeed * clamp(arrivalDistance / 0.7, 0.22, 1);
  const previousSpeed = state.speed;
  state.speed = damp(state.speed, targetSpeed, targetSpeed > state.speed ? 8.5 : 12.5, safeDt);
  if (state.speed < 0.025 && targetSpeed === 0) state.speed = 0;
  state.acceleration = damp(state.acceleration, safeDt > 1e-4 ? (state.speed - previousSpeed) / safeDt : 0, 9, safeDt);
  const deltaHeading = angleDelta(state.heading, heading);
  state.turnRate = damp(state.turnRate, safeDt > 1e-4 ? deltaHeading / safeDt : 0, 10, safeDt);
  state.heading += angleDelta(state.heading, heading) * (1 - Math.exp(-14 * safeDt));
  if (displacement > 0.001) {
    const actualHeading = Math.atan2(dx, dz);
    state.travelHeading += angleDelta(state.travelHeading, actualHeading)
      * (1 - Math.exp(-20 * safeDt));
  } else {
    state.travelHeading += angleDelta(state.travelHeading, state.heading)
      * (1 - Math.exp(-8 * safeDt));
  }
  state.x = position[0]; state.y = position[1]; state.z = position[2]; state.elapsed += safeDt;

  // A caller may still render a nominally culled actor (settlement streaming
  // uses a wider group range than avatar detail). A moving root must therefore
  // keep advancing even in the cheapest tier. Only a motionless far actor may
  // safely reuse its last pose.
  if (lod.tier === 'culled' && state.pose && displacement <= 0.001
    && targetSpeed === 0 && state.speed === 0) return state.pose;
  if (lod.interval && state.pose && displacement <= 0.001 && state.elapsed < lod.interval) return state.pose;
  const poseDt = state.elapsed || safeDt; state.elapsed = 0;
  const gaitHeading = displacement > 0.001 || state.speed > 0.04 ? state.travelHeading : state.heading;
  const forward = [Math.sin(gaitHeading), 0, Math.cos(gaitHeading)];
  const terrainHeight = (x, z) => query(x, z, position[1])?.y ?? fixedY ?? position[1];
  // World displacement is authoritative. A behaviour can stop on a waypoint
  // in one frame while the filtered speed still contains the previous walk;
  // continuing to predict footholds from that stale value makes the legs step
  // forward under a stationary body. Conversely, if a caller accidentally
  // marks a translating actor held, the gait must follow the moving root
  // rather than leave both contacts dragging behind it.
  const translated = measuredSpeed > 0.025;
  const gaitSpeed = translated
    ? (held ? measuredSpeed : clamp(state.speed, measuredSpeed * 0.88, measuredSpeed * 1.12))
    : 0;
  const effectiveSpeed = Math.max(gaitSpeed,
    Math.abs(state.turnRate) > 0.55 ? Math.min(0.22, Math.abs(state.turnRate) * 0.08) : 0);
  if (!translated && effectiveSpeed === 0
    && state.gait.feet.every((foot) => foot.initialized && !foot.swinging)) {
    // Hold a stable double-support clock while dwelling. Choose whichever foot
    // is physically farther behind as the first foot on resume; preserving the
    // historical alternation across a long stop can otherwise leave that foot
    // planted for half a stride while the body walks almost a metre away.
    const fx = Math.sin(state.travelHeading), fz = Math.cos(state.travelHeading);
    const foreAft = state.gait.feet.map((foot) =>
      (foot.position[0] - position[0]) * fx + (foot.position[2] - position[2]) * fz);
    const nextFoot = foreAft[0] === foreAft[1]
      ? (state.phaseSeed < 0.5 ? 0 : 1)
      : (foreAft[0] < foreAft[1] ? 0 : 1);
    const seededOffset = state.phaseSeed * 0.02;
    state.gait.phase = (nextFoot === 0 ? 0.985 : 0.485) - seededOffset;
    state.gait.lastLiftedFoot = 1 - nextFoot;
    for (let side = 0; side < 2; side++) {
      state.gait.feet[side].lastPhase = (state.gait.phase + side * 0.5) % 1;
    }
    state.resting = true;
  } else if (translated) state.resting = false;
  state.pose = advanceBipedGait(state.gait, {
    dims, dt: poseDt, speed: effectiveSpeed, position, forward,
    terrainHeight, surfaceQuery: lod.terrain ? query : null,
    talking, gesturePhase, acceleration: state.acceleration, turnRate: state.turnRate,
    actionKind,
  });
  state.pose.locomotion = {
    speed: gaitSpeed, filteredSpeed: state.speed, measuredSpeed,
    acceleration: state.acceleration, turnRate: state.turnRate,
    lod: lod.tier, surface: centreSurface, teleported: state.teleported,
  };
  state.supportId = centreSurface?.supportId ?? state.supportId;
  state.teleported = false;
  return state.pose;
}
