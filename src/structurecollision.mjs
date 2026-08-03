import { buildingWorldPoint } from './buildingplan.mjs';

export const PLAYER_STRUCTURE_RADIUS = 0.34;

function segment(id, building, ax, az, bx, bz, height, portalId = null) {
  const a = buildingWorldPoint(building, ax, az), b = buildingWorldPoint(building, bx, bz);
  return { id, buildingId: building.id, ax: a.x, az: a.z, bx: b.x, bz: b.z, minY: building.y, maxY: building.y + height, portalId };
}

export function collisionSegmentsForBuilding(building) {
  const w = building.width / 2, d = building.depth / 2, h = building.floorCount * building.floorHeight;
  const door = building.portals.find((portal) => portal.kind === 'exterior-door');
  const dl = door.x - door.width / 2, dr = door.x + door.width / 2;
  const segments = [
    segment(`${building.id}:wall:left`, building, -w, -d, -w, d, h),
    segment(`${building.id}:wall:right`, building, w, -d, w, d, h),
    segment(`${building.id}:wall:back`, building, -w, -d, w, -d, h),
    segment(`${building.id}:wall:front-left`, building, -w, d, dl, d, h),
    segment(`${building.id}:wall:front-right`, building, dr, d, w, d, h),
  ];
  for (let i = 1; i < building.rooms.length; i++) {
    const z = -d + building.depth / building.rooms.length * i;
    const portal = building.portals.find((entry) => entry.kind === 'interior-door' && entry.toRoomId === building.rooms[i].id);
    const left = portal.x - portal.width / 2, right = portal.x + portal.width / 2;
    segments.push(segment(`${building.id}:partition:${i}:left`, building, -w, z, left, z, building.floorHeight));
    segments.push(segment(`${building.id}:partition:${i}:right`, building, right, z, w, z, building.floorHeight));
  }
  return segments;
}

function doorSegmentsForBuilding(building) {
  // Interior portals are open archways in the current renderer. Giving them a
  // closed-door segment created an invisible barrier because only exterior
  // leaves participate in the portal open/close interaction loop.
  return building.portals.filter((portal) => portal.kind === 'exterior-door').map((portal) => {
    const z = building.depth / 2;
    return segment(`${portal.id}:collision`, building, portal.x - portal.width / 2, z, portal.x + portal.width / 2, z, portal.height, portal.id);
  });
}

function closestOnSegment(item, x, z) {
  const dx = item.bx - item.ax, dz = item.bz - item.az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((x - item.ax) * dx + (z - item.az) * dz) / l2)) : 0;
  return { x: item.ax + dx * t, z: item.az + dz * t, dx, dz };
}

export class StructureCollisionIndex {
  constructor(getState = () => null) {
    this.getState = getState; this.records = new Map();
  }

  registerPlan(plan) {
    const record = {
      id: plan.id,
      staticSegments: plan.buildings.flatMap(collisionSegmentsForBuilding),
      doorSegments: plan.buildings.flatMap(doorSegmentsForBuilding),
    };
    this.records.set(plan.id, record);
    return () => this.records.delete(plan.id);
  }

  activeSegments(y = Infinity) {
    const result = [], portalState = this.getState()?.portals || {};
    for (const record of this.records.values()) {
      for (const item of record.staticSegments) if (y >= item.minY - 0.2 && y <= item.maxY + 0.2) result.push(item);
      for (const item of record.doorSegments) {
        const door = portalState[item.portalId];
        if ((!door || door.progress < 0.72) && y >= item.minY - 0.2 && y <= item.maxY + 0.2) result.push(item);
      }
    }
    return result;
  }

  collides(x, z, y = Infinity, radius = PLAYER_STRUCTURE_RADIUS) {
    for (const item of this.activeSegments(y)) {
      const near = closestOnSegment(item, x, z);
      if ((x - near.x) ** 2 + (z - near.z) ** 2 < radius * radius) return item;
    }
    return null;
  }

  resolveMovement(position, previous, radius = PLAYER_STRUCTURE_RADIUS) {
    const targetX = position.x, targetZ = position.z;
    const totalX = targetX - previous.x, totalZ = targetZ - previous.z;
    const total = Math.hypot(totalX, totalZ), steps = Math.max(1, Math.ceil(total / (radius * 0.42)));
    let x = previous.x, z = previous.z;
    const segments = this.activeSegments(position.y);
    for (let step = 0; step < steps; step++) {
      let nx = x + totalX / steps, nz = z + totalZ / steps;
      for (let pass = 0; pass < 4; pass++) {
        let deepest = null;
        for (const item of segments) {
          const near = closestOnSegment(item, nx, nz), dx = nx - near.x, dz = nz - near.z;
          const distance = Math.hypot(dx, dz);
          if (distance < radius && (!deepest || radius - distance > deepest.depth)) deepest = { item, near, dx, dz, distance, depth: radius - distance };
        }
        if (!deepest) break;
        let ux, uz;
        if (deepest.distance > 1e-7) { ux = deepest.dx / deepest.distance; uz = deepest.dz / deepest.distance; }
        else {
          const length = Math.hypot(deepest.near.dx, deepest.near.dz) || 1;
          ux = -deepest.near.dz / length; uz = deepest.near.dx / length;
          if ((x - deepest.near.x) * ux + (z - deepest.near.z) * uz < 0) { ux = -ux; uz = -uz; }
        }
        nx += ux * (deepest.depth + 0.001); nz += uz * (deepest.depth + 0.001);
      }
      x = nx; z = nz;
    }
    position.x = x; position.z = z;
    return { acceptedDistance: Math.hypot(x - previous.x, z - previous.z), blocked: Math.hypot(x - targetX, z - targetZ) > 0.005 };
  }
}
