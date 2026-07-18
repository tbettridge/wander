// Pure collision helpers for the terrain-to-cave transition. The entrance
// implicit field follows the cave convention: negative values are navigable
// air and positive values are solid terrain/rock.

export function implicitFloorHeightNear(
  field,
  bounds,
  localX,
  localZ,
  referenceY = null,
  maxStep = Infinity,
  maxDrop = Infinity,
  options = {},
) {
  if (!field || !bounds || localX < bounds.minX || localX > bounds.maxX
    || localZ < bounds.minZ || localZ > bounds.maxZ) return null;

  const scanSteps = options.scanSteps ?? 92;
  const refineSteps = options.refineSteps ?? 10;
  const floorOffset = options.floorOffset ?? 0.08;
  const crossings = [];
  let previousY = bounds.minY;
  let previousD = field(localX, previousY, localZ);

  for (let i = 1; i <= scanSteps; i++) {
    const y = bounds.minY + (bounds.maxY - bounds.minY) * i / scanSteps;
    const d = field(localX, y, localZ);
    if (previousD >= 0 && d < 0) {
      let lo = previousY, hi = y;
      for (let iteration = 0; iteration < refineSteps; iteration++) {
        const mid = (lo + hi) * 0.5;
        if (field(localX, mid, localZ) >= 0) lo = mid;
        else hi = mid;
      }
      crossings.push(hi + floorOffset);
    }
    previousY = y;
    previousD = d;
  }

  if (!crossings.length) return null;
  if (!Number.isFinite(referenceY)) return crossings[0];

  let best = null, bestDistance = Infinity;
  for (const floorY of crossings) {
    const delta = floorY - referenceY;
    if (delta > maxStep || delta < -maxDrop) continue;
    const distance = Math.abs(delta);
    if (distance < bestDistance) {
      best = floorY;
      bestDistance = distance;
    }
  }
  return best;
}

export function implicitBodyFits(
  field,
  localX,
  localZ,
  floorY,
  radius = 0.30,
  height = 1.72,
  skin = 0.035,
) {
  if (floorY === null || !field) return false;
  const offsets = [
    [0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius],
  ];
  const levels = [0.34, Math.max(0.86, height * 0.55), height];
  for (const [offsetX, offsetZ] of offsets) {
    for (const level of levels) {
      if (field(localX + offsetX, floorY + level, localZ + offsetZ) >= -skin) return false;
    }
  }
  return true;
}

export function resolveImplicitHorizontal(
  field,
  bounds,
  fromX,
  fromZ,
  toX,
  toZ,
  referenceY,
  options = {},
) {
  const maxSubstep = options.maxSubstep ?? 0.20;
  const radius = options.radius ?? 0.30;
  const height = options.height ?? 1.72;
  const skin = options.skin ?? 0.035;
  const maxStep = options.maxStep ?? 0.50;
  const maxDrop = options.maxDrop ?? 1.05;
  const cameraField = options.cameraField ?? null;
  const cameraHeight = options.cameraHeight ?? 1.70;
  const cameraSkin = options.cameraSkin ?? 0.055;
  const dx = toX - fromX, dz = toZ - fromZ;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / maxSubstep));
  const sx = dx / steps, sz = dz / steps;
  let x = fromX, z = fromZ, floorY = referenceY;
  let acceptedDistance = 0, blocked = false, recovered = false;

  const fitsAt = (testX, testZ, testFloor) => implicitBodyFits(
    field, testX, testZ, testFloor, radius, height, skin,
  ) && (!cameraField
    || cameraField(testX, testFloor + Math.min(cameraHeight, height), testZ) < -cameraSkin);

  const tryPoint = (nextX, nextZ) => {
    const nextFloor = implicitFloorHeightNear(
      field, bounds, nextX, nextZ, floorY, maxStep, maxDrop,
    );
    if (nextFloor === null || !fitsAt(nextX, nextZ, nextFloor)) return false;
    acceptedDistance += Math.hypot(nextX - x, nextZ - z);
    x = nextX;
    z = nextZ;
    floorY = nextFloor;
    return true;
  };

  const currentFloor = implicitFloorHeightNear(
    field, bounds, x, z, floorY, maxStep + 0.35, maxDrop + 0.45,
  );
  if (currentFloor !== null && fitsAt(x, z, currentFloor)) {
    recovered = Math.abs(currentFloor - floorY) > 0.025;
    floorY = currentFloor;
  } else {
    const recoveryFloorAt = (rx, rz) => {
      // Near a folded entrance bank the closest upward crossing may be the
      // bank itself rather than the walking floor. Recovery gets a broader
      // vertical window, still bounded tightly enough not to change levels.
      const candidateFloor = implicitFloorHeightNear(
        field, bounds, rx, rz, floorY, maxStep + 2.5, maxDrop + 2.5,
      );
      return candidateFloor !== null && fitsAt(rx, rz, candidateFloor)
        ? candidateFloor
        : null;
    };
    recovery:
    for (let ring = 1; ring <= 12; ring++) {
      const recoveryRadius = ring * 0.07;
      for (let sample = 0; sample < 16; sample++) {
        const angle = sample / 16 * Math.PI * 2;
        const rx = x + Math.cos(angle) * recoveryRadius;
        const rz = z + Math.sin(angle) * recoveryRadius;
        const candidateFloor = recoveryFloorAt(rx, rz);
        if (candidateFloor === null) continue;
        x = rx; z = rz; floorY = candidateFloor; recovered = true;
        break recovery;
      }
    }
  }

  for (let i = 0; i < steps; i++) {
    const startX = x, startZ = z;
    if (tryPoint(startX + sx, startZ + sz)) continue;
    blocked = true;
    if (Math.abs(sx) >= Math.abs(sz)) {
      tryPoint(startX + sx, startZ);
      tryPoint(x, z + sz);
    } else {
      tryPoint(startX, startZ + sz);
      tryPoint(x + sx, z);
    }
    if (Math.hypot(x - startX, z - startZ) < 1e-7) {
      const length = Math.hypot(sx, sz);
      const heading = Math.atan2(sz, sx);
      for (const turn of [Math.PI / 8, -Math.PI / 8, Math.PI / 4, -Math.PI / 4,
        Math.PI * 3 / 8, -Math.PI * 3 / 8, Math.PI / 2, -Math.PI / 2]) {
        if (tryPoint(
          startX + Math.cos(heading + turn) * length,
          startZ + Math.sin(heading + turn) * length,
        )) break;
      }
    }
  }
  return { x, z, floorY, acceptedDistance, blocked, recovered };
}

// True only when the player's torso is actually at (or just touching) the
// cave-only throat. The terrain-minus-cave entrance field cannot answer this:
// ordinary outdoor air is negative there too, which made someone walking over
// the roof look indistinguishable from someone entering through the aperture.
export function entranceThroatEngaged(caveAirAt, local, options = {}) {
  if (typeof caveAirAt !== 'function' || !local) return false;
  const bodyCenter = options.bodyCenter ?? 0.86;
  const engageDistance = options.engageDistance ?? 0.18;
  const distance = caveAirAt(local.x, local.y + bodyCenter, local.z);
  return Number.isFinite(distance) && distance <= engageDistance;
}

// Recovery for the old failure mode: if portal state says "inside" while the
// body is not in the throat and the feet are still on the outdoor surface,
// outdoor movement must immediately regain authority. This is deliberately
// narrow; a genuine cave occupant far below the terrain is never released.
export function entranceShouldRecoverOutdoor(
  inside,
  throatEngaged,
  localY,
  outdoorSurfaceY,
  options = {},
) {
  if (!inside || throatEngaged || !Number.isFinite(localY) || !Number.isFinite(outdoorSurfaceY)) return false;
  const belowTolerance = options.belowTolerance ?? 0.75;
  const delta = localY - outdoorSurfaceY;
  // There is intentionally no upper limit: a debug teleport or a previous
  // bad floor snap can leave the rig several metres above the roof. A genuine
  // cave occupant is below the outdoor surface, so any point at/above it is an
  // unambiguous recovery candidate.
  return delta >= -belowTolerance;
}

// Mirrors CaveExperiment.resolveMovement's decision boundary. Keeping this
// pure makes the important "buried cave must not affect outdoor walking"
// invariant directly testable without Three.js or streamed cave chunks.
export function entranceTransitionState(bounds, inside, from, target, options = {}) {
  if (!bounds) {
    return {
      targetInEntrance: false,
      targetInFootprint: false,
      segmentCrossesFootprint: false,
      throatRelevant: false,
      active: false,
      outdoorAuthoritative: !inside,
    };
  }
  const xInset = options.xInset ?? 0.45;
  const zInset = options.zInset ?? 0.20;
  const targetInFootprint = target.z >= bounds.minZ + zInset
    && target.z <= bounds.maxZ - zInset
    && target.x >= bounds.minX + xInset
    && target.x <= bounds.maxX - xInset;
  // Callers that provide cave-only throat samples get the height-aware path.
  // Defaulting to true preserves the helper's previous behavior for external
  // callers that have only the compact bounds available.
  const fromThroat = options.fromThroat ?? true;
  const targetThroat = options.targetThroat ?? true;
  const throatRelevant = inside || fromThroat || targetThroat;
  const targetInEntrance = targetInFootprint && throatRelevant;
  const outdoorAuthoritative = !inside && !targetInEntrance;
  // A cave route is free to bend back across the entrance's Z band after it
  // has travelled well to one side of the mouth.  The old inside fallback
  // tested Z alone, which re-activated the compact entrance collider at those
  // bends and produced an invisible wall.  Require the movement segment to
  // overlap the compact footprint on both horizontal axes.
  const segmentCrossesFootprint = Math.max(from.x, target.x) >= bounds.minX + xInset
    && Math.min(from.x, target.x) <= bounds.maxX - xInset
    && Math.max(from.z, target.z) >= bounds.minZ + zInset
    && Math.min(from.z, target.z) <= bounds.maxZ - zInset;
  const active = !outdoorAuthoritative && (targetInEntrance || (inside
    && segmentCrossesFootprint));
  return {
    targetInEntrance,
    targetInFootprint,
    segmentCrossesFootprint,
    throatRelevant,
    active,
    outdoorAuthoritative,
  };
}

export function entrancePortalNear(bounds, local, options = {}) {
  if (!bounds || !local) return false;
  const xMargin = options.xMargin ?? 1.2;
  const zMargin = options.zMargin ?? 1.8;
  return local.x >= bounds.minX - xMargin && local.x <= bounds.maxX + xMargin
    && local.z >= bounds.minZ - zMargin && local.z <= bounds.maxZ + zMargin;
}
