// Pure semantic choreography for a passenger moving between platform and seat.
// Renderers turn these phases into world transforms; the durable executor uses
// the same timings to decide when exact-once manifest transitions occur.

import { RAIL_CARRIAGE, RAIL_CARRIAGE_SEATS, RAIL_CARRIAGE_STANDING } from './railcarriage.mjs?v=4';

export const NPC_RAIL_TRANSFER_VERSION = 1;

export const NPC_RAIL_PHASE = Object.freeze({
  platformLoiter: 'platform-loiter',
  platformQueue: 'platform-queue',
  waitingForDoor: 'waiting-for-door',
  crossingIn: 'crossing-in',
  walkingToSeat: 'walking-to-seat',
  sitting: 'sitting',
  seated: 'seated',
  ridingStanding: 'riding-standing',
  standing: 'standing',
  walkingToDoor: 'walking-to-door',
  interiorQueue: 'interior-queue',
  crossingOut: 'crossing-out',
  platformEgress: 'platform-egress',
});

export const NPC_RAIL_TIMING = Object.freeze({
  platformQueue: 0.8,
  crossingIn: 1.0,
  walkingToSeat: 1.8,
  sitting: 0.85,
  standing: 0.85,
  walkingToDoor: 1.8,
  crossingOut: 1.0,
  platformEgress: 1.2,
  prepareToAlightSeconds: 9,
  queueSpacing: 0.9,
});

export function npcRailDoorPassable(doorFactor = 0) {
  return Number(doorFactor) >= 0.94;
}

export function createNpcRailTransfer({
  runId, stationId, reservationId, carriageIndex, seatIndex,
  platformId, side = 1, queueIndex = 0, phase = NPC_RAIL_PHASE.platformQueue,
  elapsedSeconds = 0, progress = 0,
  standingIndex = null, approachFrom = null, approachTo = null, approachDurationSeconds = null,
  platformFloorY = null, egressFrom = null, egressTo = null, egressDurationSeconds = null,
} = {}) {
  const transfer = {
    version: NPC_RAIL_TRANSFER_VERSION,
    runId: requiredId(runId, 'runId'),
    stationId: requiredId(stationId, 'stationId'),
    reservationId: requiredId(reservationId, 'reservationId'),
    carriageIndex: nonNegativeInteger(carriageIndex, 'carriageIndex'),
    seatIndex: standingIndex == null ? nonNegativeInteger(seatIndex, 'seatIndex') : null,
    ...(standingIndex == null ? {} : { standingIndex: nonNegativeInteger(standingIndex, 'standingIndex') }),
    platformId: requiredId(platformId, 'platformId'),
    side: Number(side) < 0 ? -1 : 1,
    queueIndex: nonNegativeInteger(queueIndex, 'queueIndex'),
    phase,
    elapsedSeconds: finiteNonNegative(elapsedSeconds, 'elapsedSeconds'),
    progress: Math.max(0, Math.min(1, finiteNonNegative(progress, 'progress'))),
  };
  for (const [key, point] of Object.entries({ approachFrom, approachTo, egressFrom, egressTo })) {
    if (point == null) continue;
    if (![point.x, point.y, point.z].every(Number.isFinite)) throw new TypeError(`Invalid ${key} point.`);
    transfer[key] = { x: point.x, y: point.y, z: point.z };
  }
  for (const [key, seconds] of Object.entries({ approachDurationSeconds, egressDurationSeconds })) {
    if (seconds != null) transfer[key] = finiteNonNegative(seconds, key);
  }
  if (platformFloorY != null) {
    if (!Number.isFinite(platformFloorY)) throw new TypeError('Invalid platform floor height.');
    transfer.platformFloorY = platformFloorY;
  }
  if (!Object.values(NPC_RAIL_PHASE).includes(phase)) throw new TypeError(`Unknown NPC rail phase ${phase}.`);
  return transfer;
}

export function copyNpcRailTransfer(value, changes = {}) {
  if (!value || value.version !== NPC_RAIL_TRANSFER_VERSION) return null;
  return createNpcRailTransfer({ ...value, ...changes });
}

export function advanceNpcRailTransfer(transfer, dt, duration, nextPhase = null) {
  if (!transfer || transfer.version !== NPC_RAIL_TRANSFER_VERSION) {
    throw new TypeError('A valid NPC rail transfer is required.');
  }
  const seconds = finiteNonNegative(dt, 'dt');
  const target = finiteNonNegative(duration, 'duration');
  const before = finiteNonNegative(transfer.elapsedSeconds ?? 0, 'elapsedSeconds');
  const consumed = Math.min(seconds, Math.max(0, target - before));
  const elapsedSeconds = Math.min(target, before + consumed);
  const complete = target === 0 || elapsedSeconds >= target - 1e-9;
  const result = {
    ...transfer,
    elapsedSeconds: complete && nextPhase ? 0 : elapsedSeconds,
    progress: complete && nextPhase ? 0 : (target === 0 ? 1 : elapsedSeconds / target),
    phase: complete && nextPhase ? nextPhase : transfer.phase,
  };
  return { transfer: result, consumed, complete };
}

const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));

/** Carriage-local root pose used by the continuous presentation owner. */
export function npcRailCarriageLocalPose(transfer) {
  if (!transfer || transfer.version !== NPC_RAIL_TRANSFER_VERSION) return null;
  const standing = transfer.standingIndex != null;
  const seat = standing ? RAIL_CARRIAGE_STANDING[transfer.standingIndex] : RAIL_CARRIAGE_SEATS[transfer.seatIndex];
  if (!seat) return null;
  const side = transfer.side < 0 ? -1 : 1;
  const t = Math.max(0, Math.min(1, Number(transfer.progress) || 0));
  const outsideX = side * (RAIL_CARRIAGE.wallX + 0.72);
  const vestibuleX = side * 0.82;
  const aisleX = Math.sign(seat.x) * RAIL_CARRIAGE.aisleStandX;
  // Seat yaw aims a player's -Z camera; an avatar faces +Z, toward the aisle.
  const seatYaw = standing ? seat.yaw : seat.yaw + Math.PI;
  const queueZ = 0;
  let x = outsideX, z = queueZ, mode = 'idle', seated = false, yaw = -side * Math.PI * 0.5;
  let y = transfer.platformFloorY ?? RAIL_CARRIAGE.floorY;
  let seatAmount = 0;
  switch (transfer.phase) {
    case NPC_RAIL_PHASE.crossingIn:
      x = lerp(outsideX, vestibuleX, t); z = lerp(queueZ, 0, t); mode = 'walk';
      y = lerp(y, RAIL_CARRIAGE.floorY, Math.min(1, t * 1.5));
      yaw = Math.atan2(vestibuleX - outsideX, -queueZ); break;
    case NPC_RAIL_PHASE.walkingToSeat: {
      const point = aislePath(vestibuleX, aisleX, seat.z, t);
      ({ x, z, yaw } = point); y = RAIL_CARRIAGE.floorY; mode = 'walk'; break;
    }
    case NPC_RAIL_PHASE.sitting:
      x = lerp(aisleX, seat.x, t); z = seat.z; mode = 'sit'; yaw = seatYaw; break;
    case NPC_RAIL_PHASE.seated:
      x = seat.x; z = seat.z; mode = 'seated'; seated = true; yaw = seatYaw; break;
    case NPC_RAIL_PHASE.ridingStanding:
      x = seat.x; z = seat.z; mode = 'idle'; yaw = seat.yaw; break;
    case NPC_RAIL_PHASE.standing:
      x = lerp(seat.x, aisleX, t); z = seat.z; mode = 'stand'; yaw = seatYaw; break;
    case NPC_RAIL_PHASE.walkingToDoor: {
      const point = aislePath(vestibuleX, aisleX, seat.z, 1 - t);
      ({ x, z } = point); yaw = point.yaw + Math.PI; mode = 'walk'; break;
    }
    case NPC_RAIL_PHASE.interiorQueue:
      x = vestibuleX; z = 0; break;
    case NPC_RAIL_PHASE.waitingForDoor:
      x = outsideX; z = queueZ; yaw = -side * Math.PI * 0.5; break;
    case NPC_RAIL_PHASE.crossingOut:
      x = lerp(vestibuleX, outsideX, t); z = lerp(0, queueZ, t); mode = 'walk';
      y = lerp(RAIL_CARRIAGE.floorY, y, Math.max(0, (t - 0.3) / 0.7));
      yaw = Math.atan2(outsideX - vestibuleX, queueZ); break;
    case NPC_RAIL_PHASE.platformEgress:
      x = lerp(outsideX, side * (RAIL_CARRIAGE.wallX + 2.0), t);
      z = lerp(queueZ, queueZ + (transfer.queueIndex % 2 ? 0.55 : -0.55), t);
      mode = 'walk';
      yaw = Math.atan2(side * (RAIL_CARRIAGE.wallX + 2.0) - outsideX,
        transfer.queueIndex % 2 ? 0.55 : -0.55); break;
    default:
      break;
  }
  const inside = [NPC_RAIL_PHASE.walkingToSeat, NPC_RAIL_PHASE.sitting,
    NPC_RAIL_PHASE.seated, NPC_RAIL_PHASE.ridingStanding, NPC_RAIL_PHASE.standing,
    NPC_RAIL_PHASE.walkingToDoor, NPC_RAIL_PHASE.interiorQueue].includes(transfer.phase);
  if (inside) y = RAIL_CARRIAGE.floorY;
  if (transfer.phase === NPC_RAIL_PHASE.sitting) seatAmount = t;
  if (transfer.phase === NPC_RAIL_PHASE.seated) seatAmount = 1;
  if (transfer.phase === NPC_RAIL_PHASE.standing) seatAmount = 1 - t;
  return Object.freeze({ x, y, z, yaw, mode, seated, seatAmount });
}

/** Fit the real cushion and keep adult soles on the floor; small legs dangle. */
export function npcRailSeatJointPose({ scale = 1, thighOffsetY = 0, lowerLegLength, ankleY = 0.05 }) {
  const hipY = (RAIL_CARRIAGE.seatSurfaceY - RAIL_CARRIAGE.floorY) / Math.max(0.01, scale) + 0.13;
  const drop = hipY + thighOffsetY - ankleY;
  const angle = Math.acos(Math.max(0, Math.min(1, drop / Math.max(0.001, lowerLegLength))));
  return { hipY, thighAngle: -Math.PI / 2, shinAngle: Math.PI / 2 - angle, footAngle: angle };
}

function aislePath(vestibuleX, aisleX, seatZ, progress) {
  const points = [{ x: vestibuleX, z: 0 }, { x: 0, z: 0 },
    { x: 0, z: seatZ }, { x: aisleX, z: seatZ }];
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.z - points[i].z));
  let distance = progress * lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (distance > lengths[i] && i < lengths.length - 1) { distance -= lengths[i]; continue; }
    const a = points[i], b = points[i + 1], t = lengths[i] ? Math.min(1, distance / lengths[i]) : 1;
    return { x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), yaw: Math.atan2(b.x - a.x, b.z - a.z) };
  }
}

export function npcRailTransferPhaseDuration(phase) {
  return ({
    [NPC_RAIL_PHASE.platformQueue]: NPC_RAIL_TIMING.platformQueue,
    [NPC_RAIL_PHASE.crossingIn]: NPC_RAIL_TIMING.crossingIn,
    [NPC_RAIL_PHASE.walkingToSeat]: NPC_RAIL_TIMING.walkingToSeat,
    [NPC_RAIL_PHASE.sitting]: NPC_RAIL_TIMING.sitting,
    [NPC_RAIL_PHASE.standing]: NPC_RAIL_TIMING.standing,
    [NPC_RAIL_PHASE.walkingToDoor]: NPC_RAIL_TIMING.walkingToDoor,
    [NPC_RAIL_PHASE.crossingOut]: NPC_RAIL_TIMING.crossingOut,
    [NPC_RAIL_PHASE.platformEgress]: NPC_RAIL_TIMING.platformEgress,
  })[phase] ?? 0;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !value.length || value.trim() !== value) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new TypeError(`${label} must be a non-negative integer.`);
  return number;
}

function finiteNonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${label} must be finite and non-negative.`);
  return number;
}
