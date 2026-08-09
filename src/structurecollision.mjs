import { buildingWorldPoint } from './buildingplan.mjs';
import { massCollides, MASS_ROLE } from './buildingmassing.mjs';
import { propCollisionRadius } from './settlementprops.mjs';
import { BUILDING_FLOOR_SURFACE, FOUNDATION_MARGIN, FOUNDATION_STEP_UP } from './settlementplan.mjs';
import { frontageAssetMetadata } from './settlementfrontagecatalog.mjs';
import { managedVegetationAssetMetadata } from './managedvegetationcatalog.sol.mjs';

export const PLAYER_STRUCTURE_RADIUS = 0.34;

function segment(id, building, ax, az, bx, bz, height, portalId = null) {
  const a = buildingWorldPoint(building, ax, az), b = buildingWorldPoint(building, bx, bz);
  return { id, buildingId: building.id, ax: a.x, az: a.z, bx: b.x, bz: b.z, minY: building.y, maxY: building.y + height, portalId };
}

/**
 * The outside walls of the solid volumes hung off a building's core.
 *
 * A tower or a wing is not enterable, so it needs no doorway and no partitions
 * — just four sides you cannot walk through. Without these a church tower is a
 * picture you stroll straight into.
 */
function massSegmentsForBuilding(building) {
  const segments = [];
  for (const item of building.masses || []) {
    if (item.role === MASS_ROLE.core || !massCollides(item)) continue;
    const w = item.width / 2, d = item.depth / 2;
    const corners = [[-w, -d], [w, -d], [w, d], [-w, d]];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
      segments.push(segment(
        `${building.id}:${item.role}:${item.dx.toFixed(2)}:${item.dz.toFixed(2)}:side:${i}`,
        building, item.dx + ax, item.dz + az, item.dx + bx, item.dz + bz,
        item.baseY + item.height,
      ));
    }
  }
  return segments;
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

/**
 * The sides of a raised plot, where it is too high to step onto.
 *
 * A plinth is a step, not a wall, until it is not. Below the step-up threshold
 * the walkable claim quietly lifts the player onto the plot and walls here
 * would only stop them getting to their own front door. Above it the pad is a
 * bank of earth and stone, and without sides the player walks into the space it
 * occupies and stands inside the plot rather than on it.
 *
 * The sides stop at the plinth top, so the moment the player is above it they
 * are free to walk on — the claim takes over from there.
 */
function foundationSegmentsForBuilding(building) {
  // How far the pad's top stands above the ground it meets at its rim.
  //
  // Measured against padMinTerrain, not the terrain fit's minTerrain. The fit's
  // figure is the CORE's low point, and the fit rejects lots whose core is
  // uneven — so it is always small, and using it here meant no plot ever
  // qualified as raised however far its downhill rim stood out of the hill.
  if (!Number.isFinite(building.padMinTerrain)) return [];
  const standing = building.y + BUILDING_FLOOR_SURFACE - building.padMinTerrain;
  if (standing <= FOUNDATION_STEP_UP) return [];
  const fp = building.footprint || {
    minX: -building.width / 2, maxX: building.width / 2,
    minZ: -building.depth / 2, maxZ: building.depth / 2,
  };
  const x0 = fp.minX - FOUNDATION_MARGIN, x1 = fp.maxX + FOUNDATION_MARGIN;
  const z0 = fp.minZ - FOUNDATION_MARGIN, z1 = fp.maxZ + FOUNDATION_MARGIN;
  const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const segments = [];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    const a = buildingWorldPoint(building, ax, az), b = buildingWorldPoint(building, bx, bz);
    segments.push({
      id: `${building.id}:foundation:${i}`, buildingId: building.id,
      ax: a.x, az: a.z, bx: b.x, bz: b.z,
      // From the ground it stands out of, up to the surface of the plot.
      minY: building.y + BUILDING_FLOOR_SURFACE - standing,
      maxY: building.y + BUILDING_FLOOR_SURFACE - 0.02,
      portalId: null,
    });
  }
  return segments;
}

/**
 * The square's furniture, as things you cannot walk through.
 *
 * A square you can stroll through the well of is worse than an empty one, so
 * the solid props get four sides each. Benches are deliberately excluded — see
 * settlementprops: being caught on one crossing the square is more annoying
 * than stepping over it is unrealistic.
 */
function propSegments(plan) {
  const segments = [];
  for (const prop of plan.props || []) {
    const radius = propCollisionRadius(prop);
    if (!radius) continue;
    const c = Math.cos(prop.yaw), s = Math.sin(prop.yaw);
    // Squared off around the prop's own facing, which matters for a stall: it
    // is a counter, not a post, and blocks along its width.
    const hx = (prop.width ? prop.width / 2 : radius);
    const hz = (prop.depth ? prop.depth / 2 : radius);
    const corners = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
    const world = corners.map(([lx, lz]) => ({ x: prop.x + lx * c + lz * s, z: prop.z - lx * s + lz * c }));
    for (let i = 0; i < 4; i++) {
      const a = world[i], b = world[(i + 1) % 4];
      segments.push({
        id: `${prop.id}:side:${i}`, buildingId: prop.id,
        ax: a.x, az: a.z, bx: b.x, bz: b.z,
        minY: prop.y, maxY: prop.y + (prop.height || 1), portalId: null,
      });
    }
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

function frontageWorldPoint(building, placement, localX, localZ) {
  const c = Math.cos(placement.yaw || 0), s = Math.sin(placement.yaw || 0);
  return buildingWorldPoint(
    building,
    placement.localX + localX * c + localZ * s,
    placement.localZ - localX * s + localZ * c,
  );
}

/** Only authored frontage colliders enter the movement index; marks and herbs stay non-blocking. */
export function collisionSegmentsForFamilyFrontage(building, frontage) {
  const result = [];
  const entries = [...(frontage?.attachments || []), ...(frontage?.yardElements || [])];
  for (const entry of entries) {
    const metadata = frontageAssetMetadata(entry.assetId), placement = entry.placement;
    const collider = metadata?.collision;
    if (!collider || collider.mode === 'none' || !placement) continue;
    const y = building.y + (placement.localY || 0);
    const maxY = y + (metadata.height || 1);
    if (collider.mode === 'footprint') {
      const [minX, minZ, maxX, maxZ] = collider.bounds;
      const corners = [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]];
      for (let index = 0; index < corners.length; index++) {
        const from = frontageWorldPoint(building, placement, ...corners[index]);
        const to = frontageWorldPoint(building, placement, ...corners[(index + 1) % corners.length]);
        result.push({
          id: `${frontage.id}:${entry.assetId}:collision:${index}`,
          buildingId: building.id, ax: from.x, az: from.z, bx: to.x, bz: to.z,
          minY: y + (metadata.localBounds?.min?.[1] || 0), maxY, portalId: null,
        });
      }
    } else if (collider.mode === 'segments') {
      for (const [index, [ax, az, bx, bz, width]] of collider.segments.entries()) {
        const from = frontageWorldPoint(building, placement, ax, az);
        const to = frontageWorldPoint(building, placement, bx, bz);
        result.push({
          id: `${frontage.id}:${entry.assetId}:collision:${index}`,
          buildingId: building.id, ax: from.x, az: from.z, bx: to.x, bz: to.z,
          minY: y + (metadata.localBounds?.min?.[1] || 0), maxY,
          portalId: null, radius: width,
        });
      }
    }
  }
  return result;
}

function managedWorldPoint(placement, localX, localZ) {
  const c = Math.cos(placement.yaw || 0), s = Math.sin(placement.yaw || 0);
  return {
    x: placement.x + localX * c + localZ * s,
    z: placement.z - localX * s + localZ * c,
  };
}

/** Convert only catalog-declared blocking envelopes into the movement index. */
export function collisionSegmentsForManagedVegetation(placement) {
  const asset = managedVegetationAssetMetadata(placement?.assetId);
  const collider = asset?.collision;
  if (!asset || !collider?.blocksMovement || collider.mode === 'none') return [];
  const minY = placement.y + asset.localBounds.min[1];
  const maxY = placement.y + asset.localBounds.max[1];
  const result = [];
  const addPolygon = (points, suffix) => {
    for (let index = 0; index < points.length; index++) {
      const a = managedWorldPoint(placement, ...points[index]);
      const b = managedWorldPoint(placement, ...points[(index + 1) % points.length]);
      result.push({
        id: `${placement.id}:collision:${suffix}:${index}`,
        buildingId: placement.buildingId, ax: a.x, az: a.z, bx: b.x, bz: b.z,
        minY, maxY, portalId: null,
      });
    }
  };
  if (collider.mode === 'footprint') {
    const [minX, minZ, maxX, maxZ] = collider.bounds;
    addPolygon([[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]], 'footprint');
  } else if (collider.mode === 'circles') {
    for (const [circleIndex, [x, z, radius]] of collider.circles.entries()) {
      addPolygon(Array.from({ length: 8 }, (_, index) => {
        const angle = index / 8 * Math.PI * 2;
        return [x + Math.cos(angle) * radius, z + Math.sin(angle) * radius];
      }), `circle:${circleIndex}`);
    }
  } else if (collider.mode === 'segments') {
    for (const [index, [ax, az, bx, bz, width]] of collider.segments.entries()) {
      const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz) || 1;
      const nx = -dz / length * width / 2, nz = dx / length * width / 2;
      addPolygon([
        [ax + nx, az + nz], [bx + nx, bz + nz],
        [bx - nx, bz - nz], [ax - nx, az - nz],
      ], `segment:${index}`);
    }
  }
  return result;
}

/** Only freestanding sign posts enter movement collision; wall signs remain visual. */
export function collisionSegmentsForBusinessSign(building, sign) {
  if (!building || sign?.placement?.mount !== 'post') return [];
  const { width } = sign.placement.dimensions;
  const result = [];
  for (const [postIndex, offset] of [-width * 0.32, width * 0.32].entries()) {
    const centre = buildingWorldPoint(building,
      sign.placement.localX + offset, sign.placement.localZ);
    const points = Array.from({ length: 8 }, (_, index) => {
      const angle = index / 8 * Math.PI * 2;
      return { x: centre.x + Math.cos(angle) * 0.1, z: centre.z + Math.sin(angle) * 0.1 };
    });
    for (let index = 0; index < points.length; index++) {
      const a = points[index], b = points[(index + 1) % points.length];
      result.push({
        id: `${sign.id}:post:${postIndex}:${index}`, buildingId: building.id,
        ax: a.x, az: a.z, bx: b.x, bz: b.z,
        minY: building.y, maxY: building.y + (sign.placement.boardCenterY || 1.55),
        portalId: null,
      });
    }
  }
  return result;
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
      staticSegments: [
        ...plan.buildings.flatMap((building) => [
          ...collisionSegmentsForBuilding(building),
          ...massSegmentsForBuilding(building),
          ...foundationSegmentsForBuilding(building),
          ...collisionSegmentsForFamilyFrontage(
            building,
            plan.familyFrontages?.find((frontage) => frontage.buildingId === building.id),
          ),
          ...collisionSegmentsForBusinessSign(
            building,
            plan.businessSigns?.find((sign) => sign.buildingId === building.id),
          ),
        ]),
        ...propSegments(plan),
        ...(plan.managedVegetation?.placements || []).flatMap(collisionSegmentsForManagedVegetation),
      ],
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
