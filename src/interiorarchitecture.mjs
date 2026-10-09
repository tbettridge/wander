// Semantic interiors live inside the existing envelope. No THREE, terrain
// sampling or consumed building RNG: an interior cannot move a village's lots.
export const INTERIOR_VERSION = 1;
export const INTERIOR_FLOOR = 0.16;
export function interiorHash(text) {
  let h = 2166136261;
  for (const c of String(text)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
export function interiorLocal(building, point) {
  const dx = point.x - building.x, dz = point.z - building.z;
  const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c,
    y: (point.y ?? building.y) - interiorBaseY(building) };
}
export function interiorBaseY(b) {
  return b.y + ((b.masses || []).find(m => m.role === 'core')?.baseY || 0);
}
export function interiorWorld(b, p) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  return { x: b.x + p.x * c + p.z * s, z: b.z - p.x * s + p.z * c,
    y: interiorBaseY(b) + (p.y ?? INTERIOR_FLOOR) };
}
const FRONT_PURPOSES = {
  dwelling: ['sleeping', 'common'], 'row-house': ['storage', 'common'],
  'infill-house': ['storage', 'common'], inn: ['storage', 'kitchen', 'public'],
  barn: ['storage', 'work'], workshop: ['storage', 'shop'], smithy: ['storage', 'forge'],
  church: ['vestry', 'nave'], school: ['office', 'classroom'], hall: ['office', 'public'],
  'community-hall': ['office', 'public'], 'station-house': ['office', 'public'],
};
function deckRects(bounds, stair) {
  if (!stair) return [{ ...bounds }];
  // Three non-overlapping slabs leave a REAL opening, not a dark painted hole.
  const hole = stair.bounds;
  return [
    { ...bounds, minX: hole.maxX },
    { minX: bounds.minX, maxX: hole.maxX, minZ: bounds.minZ, maxZ: Math.min(bounds.maxZ, hole.minZ) },
    { minX: bounds.minX, maxX: hole.maxX, minZ: Math.max(bounds.minZ, hole.maxZ), maxZ: bounds.maxZ },
  ].filter(r => r.maxX - r.minX > 0.01 && r.maxZ - r.minZ > 0.01);
}
export function createInteriorArchitecture(b) {
  const purposes = FRONT_PURPOSES[b.program];
  const loft = b.program === 'barn' && interiorHash(`${b.id}:loft`) % 3 !== 0
    || b.floorCount === 2 && ['dwelling', 'workshop'].includes(b.program)
      && interiorHash(`${b.id}:loft`) % 3 === 0;
  const upperCount = b.floorCount - 1 || (loft ? 1 : 0);
  const levels = [{ index: 0, y: INTERIOR_FLOOR, kind: 'ground', rectangles: [] }];
  const rooms = b.rooms.map((r, i) => ({ ...r, floor: 0, y: INTERIOR_FLOOR,
    purpose: purposes?.[i] || r.purpose, bounds: { ...r.bounds } }));
  if (upperCount && ['dwelling', 'row-house', 'infill-house'].includes(b.program)) rooms[0].purpose = 'storage';
  const portals = b.portals.map(p => ({ ...p, y: INTERIOR_FLOOR }));
  const stairs = [], partitions = [];
  const inside = { minX: -b.width / 2 + 0.14, maxX: b.width / 2 - 0.14,
    minZ: -b.depth / 2 + 0.14, maxZ: b.depth / 2 - 0.14 };
  for (let floor = 1; floor <= upperCount; floor++) {
    const y = b.program === 'barn' ? 2.51 : INTERIOR_FLOOR + floor * b.floorHeight;
    const lowerY = levels[floor - 1].y;
    const x = inside.minX + 0.68, width = 1.16;
    // Landings clear both the rail and attached exterior wings, whose walls
    // overlap the core envelope slightly at the back of some workshops.
    const startZ = inside.maxZ - 1.15, endZ = inside.minZ + 1.15;
    const stair = { id: `${b.id}:stair:${floor}`, fromFloor: floor - 1, toFloor: floor,
      x, width, startZ, endZ, lowerY, upperY: y,
      bounds: { minX: x - width / 2 - 0.06, maxX: x + width / 2 + 0.06, minZ: endZ, maxZ: startZ },
      steps: Math.ceil((y - lowerY) / 0.175) };
    stairs.push(stair);
    const bounds = { ...inside, maxZ: loft ? -b.depth / 2 + b.depth * 0.56 : inside.maxZ };
    levels.push({ index: floor, y, kind: loft ? 'loft' : 'storey', bounds,
      rectangles: deckRects(bounds, stair) });
    const n = ['inn', 'infill-house'].includes(b.program) ? 2 : 1;
    const roomDepth = (bounds.maxZ - bounds.minZ) / n;
    for (let i = 0; i < n; i++) {
      rooms.push({ id: `${b.id}:room:upper:${floor}:${i}`, floor, y,
        purpose: ['barn', 'granary', 'workshop'].includes(b.program) ? 'storage'
          : b.program === 'station-house' ? 'office' : 'sleeping',
        bounds: { minX: stair.bounds.maxX + 0.12, maxX: bounds.maxX - 0.11,
          minZ: bounds.minZ + i * roomDepth + 0.11, maxZ: bounds.minZ + (i + 1) * roomDepth - 0.11 } });
    }
    const lowerRooms = rooms.filter(r => r.floor === floor - 1);
    const from = lowerRooms.find(r => startZ >= r.bounds.minZ && startZ <= r.bounds.maxZ) || lowerRooms.at(-1);
    const to = rooms.find(r => r.floor === floor);
    portals.push({ id: stair.id, kind: 'stair', from: { kind: 'room', key: from.id },
      to: { kind: 'room', key: to.id }, toRoomId: to.id, x, z: endZ, y, width, height: 2.15 });
  }
  for (const level of levels) {
    const floorRooms = rooms.filter(r => r.floor === level.index);
    for (let i = 1; i < floorRooms.length; i++) {
      const a = floorRooms[i - 1], r = floorRooms[i];
      const z = (a.bounds.maxZ + r.bounds.minZ) / 2;
      let portal = portals.find(p => p.kind === 'interior-door' && p.toRoomId === r.id);
      if (!portal) {
        portal = { id: `${r.id}:door`, kind: 'interior-door', from: { kind: 'room', key: a.id },
          to: { kind: 'room', key: r.id }, toRoomId: r.id, x: stairs[0]?.bounds.maxX + 0.7 || 0,
          z, y: level.y, width: 1.25, height: 2.12 };
        portals.push(portal);
      }
      portal.x = level.index ? stairs[0].bounds.maxX + 0.7 : 0;
      portal.width = 1.25;
      partitions.push({ id: `${r.id}:partition`, floor: level.index, y: level.y - INTERIOR_FLOOR,
        z, height: level.index === 0 ? levels[1]?.kind === 'loft' ? levels[1].y-INTERIOR_FLOOR : b.floorHeight
          : Math.min(b.floorHeight, b.floorCount * b.floorHeight - level.y + INTERIOR_FLOOR),
        openings: [{ x: portal.x, width: portal.width, height: portal.height },
          ...(stairs.length ? [{ x: stairs[0].x, width: 1.32, height: b.floorHeight + 0.2 }] : [])] });
    }
  }
  return { version: INTERIOR_VERSION, levels, rooms, portals, stairs, partitions,
    layoutHash: interiorHash(`${b.id}:${b.seed}:${b.width}:${b.depth}:${b.floorCount}:interior${INTERIOR_VERSION}`) };
}
export function interiorRoomAt(b, point) {
  const p = interiorLocal(b, point);
  return b.interior?.rooms.find(r => Math.abs(p.y - r.y) < 1.1
    && p.x >= r.bounds.minX - 0.12 && p.x <= r.bounds.maxX + 0.12
    && p.z >= r.bounds.minZ - 0.12 && p.z <= r.bounds.maxZ + 0.12) || null;
}
export function interiorWalkableClaims(b) {
  if (!b.interior) return [];
  const claims = [];
  for (const level of b.interior.levels.slice(1)) for (const [i, rect] of level.rectangles.entries()) {
    claims.push({ id: `${b.id}:upper-floor:${level.index}:${i}`, buildingId: b.id, kind: 'floor',
      y: interiorBaseY(b) + level.y, contains(x, z) {
        const p = interiorLocal(b, { x, z });
        return p.x >= rect.minX && p.x <= rect.maxX && p.z >= rect.minZ && p.z <= rect.maxZ;
      } });
  }
  for (const stair of b.interior.stairs) {
    const a = interiorWorld(b, { x: stair.x, z: stair.startZ, y: stair.lowerY });
    const c = interiorWorld(b, { x: stair.x, z: stair.endZ, y: stair.upperY });
    claims.push({ id: stair.id, buildingId: b.id, kind: 'steps', mode: 'ramp',
      ax: a.x, az: a.z, ay: a.y, bx: c.x, bz: c.z, by: c.y, width: stair.width });
  }
  return claims;
}
export function interiorPartitionSegments(b) {
  const out = [];
  for (const part of b.interior?.partitions || []) {
    const intervals = part.openings.map(o => [o.x - o.width / 2, o.x + o.width / 2]).sort((a, c) => a[0] - c[0]);
    let x = -b.width / 2;
    for (const [lo, hi] of [...intervals, [b.width / 2, b.width / 2]]) {
      if (lo > x) out.push(localSegment(b, `${part.id}:${x}`, x, part.z, lo, part.z,
        part.y + INTERIOR_FLOOR, part.y + part.height - 0.08));
      x = Math.max(x, hi);
    }
  }
  for (const stair of b.interior?.stairs || []) {
    out.push(localSegment(b, `${stair.id}:side`, stair.bounds.maxX, stair.endZ,
      stair.bounds.maxX, stair.startZ, stair.lowerY, stair.upperY + 0.85));
  }
  for (const level of b.interior?.levels || []) if (level.kind === 'loft') {
    out.push(localSegment(b, `${b.id}:loft-edge:${level.index}`, b.interior.stairs[0].bounds.maxX,
      level.bounds.maxZ, level.bounds.maxX, level.bounds.maxZ, level.y, level.y + 0.9));
  }
  return out;
}
export function localSegment(b, id, ax, az, bx, bz, minY, maxY) {
  const a = interiorWorld(b, { x: ax, z: az, y: minY }), c = interiorWorld(b, { x: bx, z: bz, y: maxY });
  return { id, buildingId: b.id, ax: a.x, az: a.z, bx: c.x, bz: c.z, minY: a.y, maxY: c.y };
}
