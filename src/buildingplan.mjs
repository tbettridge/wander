import { mulberry32 } from './noise.js';
import { planMasses, validateMasses } from './buildingmassing.mjs';

const PROGRAMS = Object.freeze({
  dwelling: { width: [7, 11], depth: [6, 9], floors: [1, 2], rooms: ['common', 'sleeping'] },
  // A barn's height is the point of it: you stack a crop to the rafters. At a
  // domestic 2.8 m to the eaves it was a smithy with a wider footprint, and the
  // two were the closest pair in the world by shape.
  //
  // The FOOTPRINT is deliberately left alone. Widening it to match was tried
  // and the settlement soak caught it: a bigger pad spans more ground, and on
  // rolling terrain the relief across it went past the 2.5 m a lot can be
  // levelled by. Height costs nothing on the ground and carries the whole read.
  barn: { width: [10, 15], depth: [7, 11], floors: [1, 1], rooms: ['work', 'storage'], floorHeight: 4.7 },
  workshop: { width: [8, 12], depth: [6, 10], floors: [1, 2], rooms: ['shop', 'storage'] },
  // Taller storeys than a house has. An inn's ground floor is a public room and
  // its upper floor is let out, so both are built to a size a cottage never is;
  // at domestic floor height an inn was a dwelling with a bigger footprint and
  // nothing else to tell them apart.
  inn: { width: [12, 18], depth: [9, 13], floors: [2, 2], rooms: ['public', 'kitchen', 'sleeping'], floorHeight: 3.15 },
  // A hall is ONE tall room, not a house with a big footprint. Given two
  // storeys and a domestic floor height it came out as an inn with a different
  // sign: same volume, same two rows of windows, same silhouette. A single
  // storey at four metres reads as civic from across a square, because the one
  // thing a domestic building never has is a room that tall.
  hall: { width: [12, 19], depth: [8, 13], floors: [1, 1], rooms: ['public', 'office'], floorHeight: 4.2 },
  // The civic programs a station village is built around. A church is a long
  // nave rather than a wide box — the proportion is what makes the tower on the
  // end of it read as a tower.
  church: { width: [9, 12], depth: [16, 24], floors: [1, 1], rooms: ['nave', 'vestry'], floorHeight: 5.4 },
  school: { width: [11, 15], depth: [8, 11], floors: [1, 1], rooms: ['classroom', 'office'], floorHeight: 3.4 },
  'market-hall': { width: [10, 14], depth: [10, 14], floors: [1, 1], rooms: ['public'], floorHeight: 3.6 },
  smithy: { width: [8, 11], depth: [7, 10], floors: [1, 1], rooms: ['forge', 'storage'] },
  granary: { width: [5, 7], depth: [5, 7], floors: [2, 2], rooms: ['storage'] },
  'station-house': { width: [10, 14], depth: [7, 9], floors: [1, 2], rooms: ['public', 'office'] },
});

export const BUILDING_PROGRAMS = Object.freeze(Object.keys(PROGRAMS));

/**
 * How far a program pulls its fabric away from the village's own default.
 *
 * A village builds its church out of the best it can quarry and its barn out of
 * whatever was to hand, and that hierarchy is most of what makes a real
 * settlement legible: the material tells you what a building is before the
 * shape does. Drawing every building from one bias — which is what happened
 * here until now — makes a church as likely to be plaster and thatch as a
 * cottage, and turns a village into a speckle of four combinations.
 *
 * `wall` shifts the plaster/stone threshold and `roof` the slate/thatch one, so
 * NEGATIVE wall means stone and POSITIVE roof means slate. The village bias
 * still sets the baseline, so a plaster village has plaster cottages and a
 * stone church, and a stone village is stone throughout. The church is stone in
 * both, which is exactly why it reads from the next valley.
 */
const FABRIC_BY_PROGRAM = Object.freeze({
  // Built collectively, meant to outlast everyone who paid for them.
  church: Object.freeze({ wall: -0.62, roof: 0.42 }),
  hall: Object.freeze({ wall: -0.40, roof: 0.30 }),
  school: Object.freeze({ wall: -0.34, roof: 0.26 }),
  'market-hall': Object.freeze({ wall: -0.30, roof: 0.24 }),
  'station-house': Object.freeze({ wall: -0.36, roof: 0.34 }),
  // Working buildings, put up cheaply and mended rather than rebuilt.
  barn: Object.freeze({ wall: 0.40, roof: -0.45 }),
  granary: Object.freeze({ wall: 0.34, roof: -0.38 }),
  workshop: Object.freeze({ wall: 0.22, roof: -0.24 }),
  // A forge is the one working building with a reason to be non-combustible.
  smithy: Object.freeze({ wall: -0.24, roof: 0.18 }),
  // Homes follow the village and nothing else. An inn is a large home.
  dwelling: Object.freeze({ wall: 0, roof: 0 }),
  inn: Object.freeze({ wall: -0.10, roof: 0.12 }),
});

/**
 * Programs built of painted board rather than of the village's own walling.
 *
 * A barn is not masonry or render, it is timber cladding over a frame, and it
 * gets painted because paint is what stops the boards rotting. That is why
 * barns are a colour no house in the village is: the pigment is cheap iron
 * oxide, bought for the job, and nobody renders a house in it.
 */
const BOARDED_PROGRAMS = Object.freeze(new Set(['barn']));

function fabricThreshold(base, shift) {
  // Clamped short of certainty on purpose: a village where every single barn is
  // thatched reads as a rule rather than a habit, and the odd slate barn is
  // what makes the pattern look observed instead of enforced.
  return Math.min(0.94, Math.max(0.06, base + shift));
}

function hashText(value) {
  let h = 2166136261;
  for (const c of String(value)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function validateBuildingPlan(plan) {
  const errors = [];
  if (!plan?.id || !PROGRAMS[plan.program]) errors.push('unknown-program');
  if (!(plan?.width >= 4.5 && plan?.depth >= 4.5)) errors.push('invalid-footprint');
  if (!plan?.portals?.some((portal) => portal.kind === 'exterior-door')) errors.push('missing-exterior-door');
  if (!plan?.rooms?.length) errors.push('missing-rooms');
  for (const portal of plan?.portals || []) if (!plan.rooms.some((room) => room.id === portal.toRoomId)) errors.push('orphan-portal');
  const massing = validateMasses(plan?.masses);
  if (!massing.valid) errors.push(...massing.errors);
  return { valid: errors.length === 0, errors };
}

export function createBuildingPlan({ id, program = 'dwelling', seed = 1, x = 0, y = 0, z = 0, yaw = 0, style = null } = {}) {
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
  const floorHeight = spec.floorHeight ?? 2.8;
  // The village's taste, where it has one. A settlement passes the same style
  // to every building it plans, which is what makes one village read as slate
  // and stone and the next as thatch and plaster, instead of every village
  // being an even scatter of both.
  const fabric = FABRIC_BY_PROGRAM[program] || FABRIC_BY_PROGRAM.dwelling;
  const roofBias = fabricThreshold(style?.roofBias ?? 0.65, fabric.roof);
  const wallBias = fabricThreshold(style?.wallBias ?? 0.5, fabric.wall);
  const roof = { kind: rng() < (style?.hipBias ?? 0.28) ? 'hip' : 'gable', pitch: 0.45 + rng() * 0.35, overhang: 0.35 };
  const { masses, footprint } = planMasses({
    program, width, depth, height: floorCount * floorHeight, floorHeight, roof, rng, style: style || {},
    doorWidth: exteriorDoorWidth,
  });
  const wallRoll = rng();
  const plan = {
    version: 2, id: String(id || `building:${seed}`), program, seed: seed >>> 0, x, y, z, yaw,
    width, depth, floorCount, floorHeight, rooms, portals,
    // The core is still the interior; `footprint` is what the building occupies
    // once its wings and towers are counted. Spatial code wants the second.
    masses, footprint,
    roof,
    materials: {
      // The roll is taken either way so a boarded program consumes the same
      // stream position as any other, and swapping one in does not reshuffle
      // every decision downstream of it.
      wall: BOARDED_PROGRAMS.has(program)
        ? 'board'
        : (wallRoll < wallBias ? 'plaster' : 'stone'),
      roof: rng() < roofBias ? 'slate' : 'thatch',
      trimHue: style?.trimHue ?? rng(),
    },
    style: {
      foundation: rng() < 0.7 ? 'stone' : 'brick',
      timberFrame: rng() < (program === 'barn' ? 0.85 : (style?.timberBias ?? 0.38)),
      porch: program === 'dwelling' ? rng() < 0.7 : program === 'inn' || program === 'school',
      chimney: program === 'workshop' || program === 'smithy' || program === 'inn'
        || (program === 'dwelling' && rng() < 0.75),
      windowRhythm: program === 'church' ? 3.2 : 1.9 + rng() * 0.9,
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
