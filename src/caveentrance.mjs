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
  const offsets = [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]];
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
  const dx = toX - fromX, dz = toZ - fromZ;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / maxSubstep));
  const sx = dx / steps, sz = dz / steps;
  let x = fromX, z = fromZ, floorY = referenceY;
  let acceptedDistance = 0, blocked = false;

  const tryPoint = (nextX, nextZ) => {
    const nextFloor = implicitFloorHeightNear(
      field, bounds, nextX, nextZ, floorY, maxStep, maxDrop,
    );
    if (nextFloor === null
      || !implicitBodyFits(field, nextX, nextZ, nextFloor, radius, height, skin)) return false;
    acceptedDistance += Math.hypot(nextX - x, nextZ - z);
    x = nextX;
    z = nextZ;
    floorY = nextFloor;
    return true;
  };

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
  }
  return { x, z, floorY, acceptedDistance, blocked };
}

// Mirrors CaveExperiment.resolveMovement's decision boundary. Keeping this
// pure makes the important "buried cave must not affect outdoor walking"
// invariant directly testable without Three.js or streamed cave chunks.
export function entranceTransitionState(bounds, inside, from, target, options = {}) {
  if (!bounds) {
    return { targetInEntrance: false, active: false, outdoorAuthoritative: !inside };
  }
  const xInset = options.xInset ?? 0.45;
  const zInset = options.zInset ?? 0.20;
  const targetInEntrance = target.z >= bounds.minZ + zInset
    && target.z <= bounds.maxZ - zInset
    && target.x >= bounds.minX + xInset
    && target.x <= bounds.maxX - xInset;
  const outdoorAuthoritative = !inside && !targetInEntrance;
  const active = !outdoorAuthoritative && (targetInEntrance || (inside
    && Math.max(from.z, target.z) >= bounds.minZ + zInset
    && Math.min(from.z, target.z) <= bounds.maxZ - zInset));
  return { targetInEntrance, active, outdoorAuthoritative };
}

export function entrancePortalNear(bounds, local, options = {}) {
  if (!bounds || !local) return false;
  const xMargin = options.xMargin ?? 1.2;
  const zMargin = options.zMargin ?? 1.8;
  return local.x >= bounds.minX - xMargin && local.x <= bounds.maxX + xMargin
    && local.z >= bounds.minZ - zMargin && local.z <= bounds.maxZ + zMargin;
}
