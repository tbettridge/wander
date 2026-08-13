// Renderer-independent passenger-car geometry and collision contract.
//
// Local frame: X crosses the carriage, Z runs along it, and Y is measured from
// the vehicle root. Keeping the visible shell, doorway tests and player
// collision on one set of dimensions prevents an apparently open door from
// retaining an invisible rail or collider.

export const RAIL_CARRIAGE = Object.freeze({
  bodyHalfWidth: 1.275,
  wallX: 1.24,
  interiorHalfWidth: 1.18,
  halfLength: 3.5,
  interiorHalfLength: 3.40,
  floorY: 0.925,
  ceilingY: 3.275,
  roofCenterY: 3.37,
  roofHeight: 0.14,
  sidePanelBottomY: 0.87,
  sideSillTopY: 1.55,
  sideHeaderBottomY: 3.0,
  windowTrimThickness: 0.06,
  gangwayHalfWidth: 0.54,
  gangwayDoorHalfWidth: 0.58,
  gangwayDoorTopY: 3.0,
  gangwayReach: 1.2,
  doorwayHalfWidth: 0.62,
  doorWidth: 1.16,
  doorBottom: 0.87,
  doorHeight: 0.74,
  doorOpenZ: -1.16 * 0.92,
  playerRadius: 0.34,
  entryReach: 1.15,
  entryMaxTravel: 1.5,
  seatInteractionRange: 1.15,
  aisleStandX: 0.34,
});

export const RAIL_CARRIAGE_SEATS = Object.freeze([
  Object.freeze({ label: 'left front', x: -0.84, z: 1.5, yaw: -Math.PI * 0.5 }),
  Object.freeze({ label: 'right front', x: 0.84, z: 1.5, yaw: Math.PI * 0.5 }),
  Object.freeze({ label: 'left rear', x: -0.84, z: -1.5, yaw: -Math.PI * 0.5 }),
  Object.freeze({ label: 'right rear', x: 0.84, z: -1.5, yaw: Math.PI * 0.5 }),
]);

const BENCH_RUNS = Object.freeze([
  Object.freeze({ z0: -3.0, z1: -RAIL_CARRIAGE.doorwayHalfWidth }),
  Object.freeze({ z0: RAIL_CARRIAGE.doorwayHalfWidth, z1: 3.0 }),
]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function carriageDoorPanelZ(doorFactor = 0) {
  return RAIL_CARRIAGE.doorOpenZ * clamp(Number(doorFactor) || 0, 0, 1);
}

export function carriageDoorIsPassable(doorFactor = 0, radius = RAIL_CARRIAGE.playerRadius) {
  const centre = carriageDoorPanelZ(doorFactor);
  const panelMax = centre + RAIL_CARRIAGE.doorWidth / 2;
  const freeFromPanel = RAIL_CARRIAGE.doorwayHalfWidth - panelMax;
  return freeFromPanel >= radius * 2 + 0.04;
}

/**
 * Detect an intentional walk into an open side doorway even when the exterior
 * capsule resolver has stopped the player at the jamb. Exact plane crossing
 * remains the normal path; this is the forgiving auto-step seam at the final
 * few centimetres. It returns a safe local Z centre inside the clear aperture.
 */
export function carriageBoardingApproach(previous, current, {
  doorFactor = 0,
  radius = RAIL_CARRIAGE.playerRadius,
} = {}) {
  if (!carriageDoorIsPassable(doorFactor, radius)) return null;
  const values = [previous?.x, previous?.z, current?.x, current?.z].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [previousX, previousZ, currentX, currentZ] = values;
  const travel = Math.hypot(currentX - previousX, currentZ - previousZ);
  if (!(travel > 1e-6) || travel > RAIL_CARRIAGE.entryMaxTravel) return null;

  const panelMax = carriageDoorPanelZ(doorFactor) + RAIL_CARRIAGE.doorWidth * 0.5;
  const safeMinZ = panelMax + radius + 0.015;
  const safeMaxZ = RAIL_CARRIAGE.doorwayHalfWidth - radius - 0.015;
  // The user's centre may overlap a jamb slightly when its capsule is stopped.
  // Accept the visible aperture, then funnel only that small overlap into the
  // genuinely capsule-clear interval before the established step-up runs.
  const approachMinZ = panelMax + radius * 0.12;
  const approachMaxZ = RAIL_CARRIAGE.doorwayHalfWidth - radius * 0.12;
  if (currentZ < approachMinZ || currentZ > approachMaxZ) return null;

  for (const side of [-1, 1]) {
    const plane = side * RAIL_CARRIAGE.wallX;
    const before = (previousX - plane) * side;
    const after = (currentX - plane) * side;
    const inwardTravel = before - after;
    if (before < -0.02 || before > RAIL_CARRIAGE.entryReach
      || after > radius + 0.10 || inwardTravel <= 1e-5) continue;
    return {
      side,
      z: clamp(currentZ, safeMinZ, safeMaxZ),
      entering: true,
      exiting: false,
      approach: true,
    };
  }
  return null;
}

function closestOnSegment(item, x, z) {
  const dx = item.bx - item.ax, dz = item.bz - item.az;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared
    ? clamp(((x - item.ax) * dx + (z - item.az) * dz) / lengthSquared, 0, 1) : 0;
  return { x: item.ax + dx * t, z: item.az + dz * t, dx, dz };
}

function sideSegments(doorFactor, interCarEnd = 0, gangwayReach = RAIL_CARRIAGE.gangwayReach) {
  const p = RAIL_CARRIAGE;
  const segments = [];
  for (const side of [-1, 1]) {
    const x = side * p.wallX;
    segments.push(
      { ax: x, az: -p.halfLength, bx: x, bz: -p.doorwayHalfWidth, kind: 'wall' },
      { ax: x, az: p.doorwayHalfWidth, bx: x, bz: p.halfLength, kind: 'wall' },
    );
    const panelZ = carriageDoorPanelZ(doorFactor);
    segments.push({
      ax: x, az: panelZ - p.doorWidth / 2,
      bx: x, bz: panelZ + p.doorWidth / 2,
      kind: 'door', side,
    });
  }
  for (const end of [-1, 1]) {
    const z = end * p.interiorHalfLength;
    if (end !== interCarEnd) {
      segments.push({ ax: -p.wallX, az: z, bx: p.wallX, bz: z, kind: 'end-wall' });
      continue;
    }
    // The coupled end is solid around a centred gangway opening. Two narrow
    // guards then carry that opening to the ownership midpoint between cars.
    segments.push(
      { ax: -p.wallX, az: z, bx: -p.gangwayDoorHalfWidth, bz: z, kind: 'end-wall' },
      { ax: p.gangwayDoorHalfWidth, az: z, bx: p.wallX, bz: z, kind: 'end-wall' },
      {
        ax: -p.gangwayHalfWidth, az: z,
        bx: -p.gangwayHalfWidth, bz: z + end * gangwayReach,
        kind: 'gangway-guard',
      },
      {
        ax: p.gangwayHalfWidth, az: z,
        bx: p.gangwayHalfWidth, bz: z + end * gangwayReach,
        kind: 'gangway-guard',
      },
    );
  }
  return segments;
}

function benchSegments() {
  const segments = [];
  for (const side of [-1, 1]) for (const run of BENCH_RUNS) {
    const innerX = side * 0.56;
    const outerX = side * 1.14;
    const x0 = Math.min(innerX, outerX), x1 = Math.max(innerX, outerX);
    segments.push(
      { ax: x0, az: run.z0, bx: x1, bz: run.z0, kind: 'bench' },
      { ax: x1, az: run.z0, bx: x1, bz: run.z1, kind: 'bench' },
      { ax: x1, az: run.z1, bx: x0, bz: run.z1, kind: 'bench' },
      { ax: x0, az: run.z1, bx: x0, bz: run.z0, kind: 'bench' },
    );
  }
  return segments;
}

/** Swept capsule collision in carriage-local X/Z. Mutates `position`. */
export function resolveCarriageMovementLocal(position, previous, {
  doorFactor = 0,
  radius = RAIL_CARRIAGE.playerRadius,
  includeBenches = true,
  interCarEnd = 0,
  gangwayReach = RAIL_CARRIAGE.gangwayReach,
} = {}) {
  const targetX = Number(position.x), targetZ = Number(position.z);
  const fromX = Number(previous.x), fromZ = Number(previous.z);
  if (![targetX, targetZ, fromX, fromZ].every(Number.isFinite)) {
    return { acceptedDistance: 0, blocked: true };
  }
  const totalX = targetX - fromX, totalZ = targetZ - fromZ;
  const total = Math.hypot(totalX, totalZ);
  const steps = Math.max(1, Math.ceil(total / Math.max(0.04, radius * 0.4)));
  const segments = [
    ...sideSegments(doorFactor, Math.sign(interCarEnd), gangwayReach),
    ...(includeBenches ? benchSegments() : []),
  ];
  let x = fromX, z = fromZ;
  for (let step = 0; step < steps; step++) {
    let nx = x + totalX / steps, nz = z + totalZ / steps;
    for (let pass = 0; pass < 6; pass++) {
      let deepest = null;
      for (const item of segments) {
        const near = closestOnSegment(item, nx, nz);
        const dx = nx - near.x, dz = nz - near.z;
        const distance = Math.hypot(dx, dz);
        if (distance < radius && (!deepest || radius - distance > deepest.depth)) {
          deepest = { item, near, dx, dz, distance, depth: radius - distance };
        }
      }
      if (!deepest) break;
      let ux, uz;
      if (deepest.distance > 1e-8) {
        ux = deepest.dx / deepest.distance; uz = deepest.dz / deepest.distance;
      } else {
        const length = Math.hypot(deepest.near.dx, deepest.near.dz) || 1;
        ux = -deepest.near.dz / length; uz = deepest.near.dx / length;
        if ((x - deepest.near.x) * ux + (z - deepest.near.z) * uz < 0) {
          ux = -ux; uz = -uz;
        }
      }
      nx += ux * (deepest.depth + 0.001);
      nz += uz * (deepest.depth + 0.001);
    }
    x = nx; z = nz;
  }
  position.x = x; position.z = z;
  return {
    acceptedDistance: Math.hypot(x - fromX, z - fromZ),
    blocked: Math.hypot(x - targetX, z - targetZ) > 0.005,
  };
}

/** Return a doorway crossing or null. Both points are carriage-local. */
export function carriageThresholdCrossing(previous, current, {
  doorFactor = 0,
  direction = 'either',
  radius = RAIL_CARRIAGE.playerRadius,
} = {}) {
  if (!carriageDoorIsPassable(doorFactor, radius)) return null;
  const travel = Math.hypot(current.x - previous.x, current.z - previous.z);
  if (!(travel > 1e-6) || travel > RAIL_CARRIAGE.entryMaxTravel) return null;
  for (const side of [-1, 1]) {
    const plane = side * RAIL_CARRIAGE.wallX;
    const before = (previous.x - plane) * side;
    const after = (current.x - plane) * side;
    const entering = before > 0 && after <= 0;
    const exiting = before <= 0 && after > 0;
    if ((!entering && !exiting)
      || (direction === 'enter' && !entering)
      || (direction === 'exit' && !exiting)) continue;
    const denominator = previous.x - current.x;
    const t = Math.abs(denominator) > 1e-8 ? (previous.x - plane) / denominator : 0;
    const z = previous.z + (current.z - previous.z) * clamp(t, 0, 1);
    // The sliding panel retreats toward -Z; test the actual free interval.
    const panelMax = carriageDoorPanelZ(doorFactor) + RAIL_CARRIAGE.doorWidth / 2;
    if (z < panelMax + radius || z > RAIL_CARRIAGE.doorwayHalfWidth - radius) continue;
    return { side, z, entering, exiting, t: clamp(t, 0, 1) };
  }
  return null;
}

export function carriageAisleStandForSeat(seatIndex) {
  const seat = RAIL_CARRIAGE_SEATS[seatIndex];
  if (!seat) return null;
  return {
    x: Math.sign(seat.x) * RAIL_CARRIAGE.aisleStandX,
    y: RAIL_CARRIAGE.floorY,
    z: seat.z,
    yaw: seat.yaw,
  };
}

export function nearestCarriageSeat(x, z, unavailable = () => false) {
  let best = null;
  for (let index = 0; index < RAIL_CARRIAGE_SEATS.length; index++) {
    if (unavailable(index)) continue;
    const seat = RAIL_CARRIAGE_SEATS[index];
    const distance = Math.hypot(seat.x - x, seat.z - z);
    if (distance <= RAIL_CARRIAGE.seatInteractionRange
      && (!best || distance < best.distance)) best = { index, seat, distance };
  }
  return best;
}
