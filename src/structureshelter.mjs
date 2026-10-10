// Semantic roof and ground footprints; no scene traversal or mesh raycasts.
import { massCollides } from './buildingmassing.mjs';

export const MAX_RAIN_COVERS = 24;
export const RAIN_COVER_RANGE = 58;

function footprint(building, item, pad = 0) {
  const cos = Math.cos(building.yaw), sin = Math.sin(building.yaw);
  const halfWidth = item.width / 2 + pad, halfDepth = item.depth / 2 + pad;
  const x = building.x + item.dx * cos + item.dz * sin;
  const z = building.z - item.dx * sin + item.dz * cos;
  return { x, z, cos, sin, halfWidth, halfDepth,
    reachX: Math.abs(cos) * halfWidth + Math.abs(sin) * halfDepth,
    reachZ: Math.abs(sin) * halfWidth + Math.abs(cos) * halfDepth };
}

export function buildingAnimalFootprints(building) {
  const masses = building.masses?.length ? building.masses
    : [{ role: 'core', dx: 0, dz: 0, width: building.width, depth: building.depth, baseY: 0 }];
  return masses.filter(item => item.role === 'core' || massCollides(item))
    .map(item => ({ ...footprint(building, item), buildingId: building.id }));
}

export function buildingRainCovers(building) {
  const core = building.masses?.find(item => item.role === 'core');
  const h = building.floorCount * building.floorHeight;
  const row = building.row;
  const coreItem = { dx: row ? (row.right.overhang - row.left.overhang) / 2 : 0, dz: 0,
    width: row ? building.width + row.left.overhang + row.right.overhang : building.width + 1,
    depth: building.depth + 1 };
  const covers = [{ ...footprint(building, coreItem), y: building.y + (core?.baseY || 0) + h,
    rise: row ? row.rise : Math.max(1.3, building.width * building.roof.pitch * .34),
    kind: row ? 3 : building.roof.kind === 'hip' ? 2 : 1, slopeX: 0, slopeZ: 0 }];
  for (const item of building.masses || []) {
    if (item.role === 'core' || item.role === 'stair') continue;
    // Solid attachments and raised canopy plates also intercept rain.
    const hasRoof = !!item.roof;
    covers.push({ ...footprint(building, item, hasRoof ? .35 : 0),
      y: building.y + item.baseY + item.height,
      rise: hasRoof ? Math.max(.9, item.width * item.roof.pitch * .32) : 0,
      kind: hasRoof ? item.roof.kind === 'hip' ? 2 : 1 : 0, slopeX: 0, slopeZ: 0 });
  }
  return covers;
}

// A carriage's horizontal roof plane follows yaw AND track pitch. Dimensions
// refer to its authored roof, not the player boarding/seat state.
export function roofCoverFromMatrix(e, halfWidth, halfDepth, localY) {
  const length = Math.hypot(e[0], e[2]) || 1;
  const cos = e[0] / length, sin = -e[2] / length;
  const ny = Math.abs(e[5]) > 1e-6 ? e[5] : 1;
  return { x: e[12] + e[4] * localY, z: e[14] + e[6] * localY,
    y: e[13] + e[5] * localY, halfWidth, halfDepth, cos, sin,
    kind: 0, rise: 0, slopeX: -(e[4] * cos - e[6] * sin) / ny,
    slopeZ: -(e[4] * sin + e[6] * cos) / ny };
}

export function pointBelowRainCover(cover, point) {
  const dx = point.x - cover.x, dz = point.z - cover.z;
  const x = dx * cover.cos - dz * cover.sin, z = dx * cover.sin + dz * cover.cos;
  if (Math.abs(x) > cover.halfWidth || Math.abs(z) > cover.halfDepth) return false;
  const fx = Math.max(0, 1 - Math.abs(x) / cover.halfWidth);
  const fz = Math.max(0, 1 - Math.abs(z) / cover.halfDepth);
  const profile = cover.kind === 1 ? fx : cover.kind === 2 ? Math.min(fx, fz) : cover.kind === 3 ? fz : 0;
  return point.y <= cover.y + cover.rise * profile + cover.slopeX * x + cover.slopeZ * z;
}

export function selectRainCovers(covers, point, out = [], limit = MAX_RAIN_COVERS) {
  out.length = 0;
  const distance = cover => {
    const dx = point.x - cover.x, dz = point.z - cover.z;
    const x = Math.max(0, Math.abs(dx * cover.cos - dz * cover.sin) - cover.halfWidth);
    const z = Math.max(0, Math.abs(dx * cover.sin + dz * cover.cos) - cover.halfDepth);
    return x * x + z * z;
  };
  for (const cover of covers) if (distance(cover) <= RAIN_COVER_RANGE ** 2) out.push(cover);
  out.sort((a, b) => Number(pointBelowRainCover(b, point)) - Number(pointBelowRainCover(a, point))
    || distance(a) - distance(b));
  out.length = Math.min(out.length, limit);
  return out;
}

export function animalFootprintContains(item, x, z, radius = 0) {
  if (Math.abs(x - item.x) > item.reachX + radius || Math.abs(z - item.z) > item.reachZ + radius) return false;
  const dx = x - item.x, dz = z - item.z;
  return Math.abs(dx * item.cos - dz * item.sin) < item.halfWidth + radius
    && Math.abs(dx * item.sin + dz * item.cos) < item.halfDepth + radius;
}

export function resolveAnimalFootprints(position, previous, items, radius) {
  const previousX = previous.x, previousZ = previous.z;
  const targetX = position.x, targetZ = position.z;
  if (!items.length) return { acceptedDistance: Math.hypot(targetX - previousX, targetZ - previousZ), blocked: false };
  const clear = (x, z) => !items.some(item => animalFootprintContains(item, x, z, radius));
  const pushOut = point => {
    for (let pass = 0; pass < 12; pass++) {
      let changed = false;
      for (const item of items) if (animalFootprintContains(item, point.x, point.z, radius)) {
        const dx = point.x - item.x, dz = point.z - item.z;
        let x = dx * item.cos - dz * item.sin, z = dx * item.sin + dz * item.cos;
        const w = item.halfWidth + radius, d = item.halfDepth + radius;
        if (w - Math.abs(x) < d - Math.abs(z)) x = (x < 0 ? -1 : 1) * (w + .002);
        else z = (z < 0 ? -1 : 1) * (d + .002);
        point.x = item.x + x * item.cos + z * item.sin;
        point.z = item.z - x * item.sin + z * item.cos; changed = true;
      }
      if (!changed) return true;
    }
    return clear(point.x, point.z);
  };
  const start = { x: previous.x, z: previous.z };
  if (!pushOut(start)) {
    // A newly streamed row can surround an existing animal. Find a legal
    // nearby exit rather than leaving it oscillating between overlapping lots.
    outer: for (let ring = 1; ring <= 24; ring++) for (let i = 0; i < 24; i++) {
      const angle = i * Math.PI / 12, reach = ring * Math.max(radius, 1);
      const x = previous.x + Math.sin(angle) * reach, z = previous.z + Math.cos(angle) * reach;
      if (clear(x, z)) { start.x = x; start.z = z; break outer; }
    }
  }
  const dx = targetX - previous.x, dz = targetZ - previous.z;
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / Math.max(.12, radius * .42)));
  let x = start.x, z = start.z;
  for (let i = 0; i < steps; i++) {
    const next = { x: x + dx / steps, z: z + dz / steps };
    if (pushOut(next)) { x = next.x; z = next.z; }
  }
  position.x = x; position.z = z;
  return { acceptedDistance: Math.hypot(x - previousX, z - previousZ),
    blocked: Math.hypot(x - targetX, z - targetZ) > .005 };
}
