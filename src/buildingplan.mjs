import { mulberry32 } from './noise.js';

const PROGRAMS = Object.freeze({
  dwelling: { width: [7, 11], depth: [6, 9], floors: [1, 2], rooms: ['common', 'sleeping'] },
  barn: { width: [10, 15], depth: [7, 11], floors: [1, 1], rooms: ['work', 'storage'] },
  workshop: { width: [8, 12], depth: [6, 10], floors: [1, 2], rooms: ['shop', 'storage'] },
  inn: { width: [12, 18], depth: [9, 13], floors: [2, 2], rooms: ['public', 'kitchen', 'sleeping'] },
  hall: { width: [12, 19], depth: [8, 13], floors: [1, 2], rooms: ['public', 'office'] },
});

function hashText(value) {
  let h = 2166136261;
  for (const c of String(value)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function validateBuildingPlan(plan) {
  const errors = [];
  if (!plan?.id || !PROGRAMS[plan.program]) errors.push('unknown-program');
  if (!(plan?.width >= 5 && plan?.depth >= 5)) errors.push('invalid-footprint');
  if (!plan?.portals?.some((portal) => portal.kind === 'exterior-door')) errors.push('missing-exterior-door');
  if (!plan?.rooms?.length) errors.push('missing-rooms');
  for (const portal of plan?.portals || []) if (!plan.rooms.some((room) => room.id === portal.toRoomId)) errors.push('orphan-portal');
  return { valid: errors.length === 0, errors };
}

export function createBuildingPlan({ id, program = 'dwelling', seed = 1, x = 0, y = 0, z = 0, yaw = 0 } = {}) {
  const spec = PROGRAMS[program] || PROGRAMS.dwelling;
  const rng = mulberry32((seed ^ hashText(id || program)) >>> 0);
  const width = spec.width[0] + rng() * (spec.width[1] - spec.width[0]);
  const depth = spec.depth[0] + rng() * (spec.depth[1] - spec.depth[0]);
  const floorCount = spec.floors[0] + Math.floor(rng() * (spec.floors[1] - spec.floors[0] + 1));
  const roomDepth = depth / spec.rooms.length;
  const rooms = spec.rooms.map((purpose, index) => ({
    id: `${id}:room:${index}`, purpose, floor: 0,
    bounds: { minX: -width / 2 + 0.25, maxX: width / 2 - 0.25, minZ: -depth / 2 + index * roomDepth + 0.25, maxZ: -depth / 2 + (index + 1) * roomDepth - 0.25 },
  }));
  const doorRoom = rooms[rooms.length - 1];
  const exteriorDoorWidth = program === 'barn' ? 2.6 : program === 'inn' || program === 'hall' ? 1.45 : 1.15;
  const portals = [{
    id: `${id}:door:front`, kind: 'exterior-door', from: { kind: 'settlement', key: `${id}:outside` },
    to: { kind: 'room', key: doorRoom.id }, toRoomId: doorRoom.id,
    x: 0, y, z: depth / 2, yaw: Math.PI, width: exteriorDoorWidth, height: program === 'barn' ? 2.65 : 2.15,
  }];
  for (let i = 1; i < rooms.length; i++) portals.push({
    id: `${id}:door:${i}`, kind: 'interior-door', from: { kind: 'room', key: rooms[i - 1].id },
    to: { kind: 'room', key: rooms[i].id }, toRoomId: rooms[i].id,
    x: width * (rng() - 0.5) * 0.45, y, z: -depth / 2 + i * roomDepth, yaw: 0, width: 1.25, height: 2.12,
  });
  const plan = {
    version: 1, id: String(id || `building:${seed}`), program, seed: seed >>> 0, x, y, z, yaw,
    width, depth, floorCount, floorHeight: 2.8, rooms, portals,
    roof: { kind: rng() < 0.72 ? 'gable' : 'hip', pitch: 0.45 + rng() * 0.35, overhang: 0.35 },
    materials: { wall: rng() < 0.5 ? 'plaster' : 'stone', roof: rng() < 0.65 ? 'slate' : 'thatch', trimHue: rng() },
    style: {
      foundation: rng() < 0.7 ? 'stone' : 'brick',
      timberFrame: rng() < (program === 'barn' ? 0.85 : 0.38),
      porch: program === 'dwelling' ? rng() < 0.7 : program === 'inn',
      chimney: program === 'workshop' || program === 'inn' || (program === 'dwelling' && rng() < 0.75),
      windowRhythm: 1.9 + rng() * 0.9,
      extension: rng() < 0.28,
      weathering: 0.15 + rng() * 0.7,
    },
    actionAnchors: rooms.map((room, i) => ({ id: `${room.id}:anchor`, kind: room.purpose, roomId: room.id, x: 0, y, z: -depth / 2 + (i + 0.5) * roomDepth })),
  };
  const validation = validateBuildingPlan(plan);
  if (!validation.valid) throw new Error(`Invalid building plan: ${validation.errors.join(', ')}`);
  return Object.freeze(plan);
}

export function buildingWorldPoint(building, localX, localZ) {
  const c = Math.cos(building.yaw), s = Math.sin(building.yaw);
  return { x: building.x + localX * c + localZ * s, y: building.y, z: building.z - localX * s + localZ * c };
}
