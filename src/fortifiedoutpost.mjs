// Deterministic semantic plans for the first fortified-ruin vertical slice.
//
// This module deliberately knows nothing about THREE. It first produces and
// validates a coherent intact outpost, then derives one independent historical
// collapse event. Rendering, collision and walkable surfaces all consume the
// same stable piece IDs from the resulting plan.

import { mulberry32 } from './noise.js';

export const FORTIFIED_OUTPOST_VERSION = 1;
// The semantic schema remains backwards compatible with the inherited draft,
// while the generation channel is bumped whenever the intact grammar changes.
// Keeping the two numbers separate lets render/collision consumers reject a
// stale cache without invalidating old save metadata.
export const FORTIFIED_OUTPOST_GENERATION_VERSION = 2;

const TAU = Math.PI * 2;
const PLAN_CACHE = new Map();

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// A small canonical hash is useful to workers and streaming caches. It is
// deliberately independent from JSON property insertion order and ignores
// runtime-only functions, so the same semantic plan hashes identically on the
// worker, main thread and in Node audits.
function canonicalHash(hash, value) {
  const add = (byte) => Math.imul(hash ^ byte, 16777619);
  if (value === null || value === undefined) return add(value === null ? 0x6e : 0x75);
  if (typeof value === 'function') return add(0x66);
  if (typeof value === 'number') {
    hash = add(0x64);
    const text = Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : String(value);
    for (const character of text) hash = add(character.charCodeAt(0));
    return hash;
  }
  if (typeof value === 'string') {
    hash = add(0x73);
    for (const character of value) hash = add(character.charCodeAt(0));
    return hash;
  }
  if (typeof value === 'boolean') return add(value ? 0x31 : 0x30);
  if (Array.isArray(value)) {
    hash = add(0x5b);
    for (const child of value) hash = canonicalHash(hash, child);
    return add(0x5d);
  }
  hash = add(0x7b);
  for (const key of Object.keys(value).sort()) {
    // Hash channels are stored alongside the architecture for consumers, but
    // are derived from it and must not recursively affect their own digest.
    if (key === 'architectureHash' || key === 'entropyHash' || key === 'hashes') continue;
    hash = canonicalHash(hash, key);
    hash = canonicalHash(hash, value[key]);
  }
  return add(0x7d);
}

function hashHex(value) {
  return (canonicalHash(2166136261, value) >>> 0).toString(16).padStart(8, '0');
}

function channel(seed, name, attempt = 0) {
  return (Math.imul(seed >>> 0, 2654435761)
    ^ Math.imul(hashText(name), 2246822519)
    ^ Math.imul(attempt + 1, 3266489917)) >>> 0;
}

function rngFor(seed, name, attempt = 0) {
  return mulberry32(channel(seed, name, attempt));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function pointOn(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const length2 = dx * dx + dz * dz;
  const t = length2
    ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / length2))
    : 0;
  return Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t));
}

function polygonContains(points, x, z) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    const crosses = ((a.z > z) !== (b.z > z))
      && x < (b.x - a.x) * (z - a.z) / ((b.z - a.z) || 1e-9) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function makeCurtain(seed, attempt, radiusX, radiusZ, wallHeight, thickness, gateWidth) {
  const jitter = rngFor(seed, 'curtain-shape', attempt);
  const vertices = [];
  const count = 8;
  for (let index = 0; index < count; index++) {
    const angle = Math.PI / 8 + index / count * TAU;
    const radial = 0.90 + jitter() * 0.18;
    vertices.push({
      id: `curtain:vertex:${index}`,
      x: Math.sin(angle) * radiusX * radial,
      z: Math.cos(angle) * radiusZ * radial,
    });
  }

  // The wraparound edge is centered on local +Z and is always the gate wall.
  const gateA = vertices[count - 1], gateB = vertices[0];
  const gateLength = Math.hypot(gateB.x - gateA.x, gateB.z - gateA.z);
  const gapFraction = Math.min(0.42, gateWidth / gateLength);
  const gateLeft = pointOn(gateA, gateB, 0.5 - gapFraction / 2);
  const gateRight = pointOn(gateA, gateB, 0.5 + gapFraction / 2);
  const gateX = (gateLeft.x + gateRight.x) / 2;
  const gateZ = (gateLeft.z + gateRight.z) / 2;
  // The gate edge is authored on the polygon's wraparound side, but its exact
  // outward normal changes with the seeded irregular vertices. Deriving it
  // from the centre keeps the approach, gate opening and collision omissions
  // in agreement for every architectural variation.
  const gateLengthNormal = Math.hypot(gateX, gateZ) || 1;
  const gate = {
    id: 'gate:main',
    x: gateX,
    z: gateZ,
    width: Math.hypot(gateRight.x - gateLeft.x, gateRight.z - gateLeft.z),
    outwardX: gateX / gateLengthNormal, outwardZ: gateZ / gateLengthNormal,
    normalX: gateX / gateLengthNormal, normalZ: gateZ / gateLengthNormal,
    left: gateLeft, right: gateRight,
  };

  const runs = [];
  const addRun = (id, a, b, edgeIndex, gateSide = false) => runs.push({
    id, kind: 'curtain-wall', ax: a.x, az: a.z, bx: b.x, bz: b.z,
    edgeIndex, gateSide, height: wallHeight, thickness, baseY: 0,
    supportIds: [`foundation:curtain:${edgeIndex}`], damageClass: 'masonry-wall',
  });
  for (let edge = 0; edge < count - 1; edge++) {
    addRun(`curtain:wall:${edge}`, vertices[edge], vertices[edge + 1], edge);
  }
  addRun('curtain:wall:gate-left', gateA, gateLeft, count - 1, true);
  addRun('curtain:wall:gate-right', gateRight, gateB, count - 1, true);
  return { vertices, runs, gate };
}

function roomPieces(room) {
  const x0 = room.x - room.width / 2, x1 = room.x + room.width / 2;
  const z0 = room.z - room.depth / 2, z1 = room.z + room.depth / 2;
  const doorLeft = room.x - room.doorWidth / 2, doorRight = room.x + room.doorWidth / 2;
  const wall = (id, ax, az, bx, bz) => ({
    id, kind: 'room-wall', ax, az, bx, bz, baseY: 0, height: room.height,
    thickness: 0.65, supportIds: ['foundation:room'], damageClass: 'masonry-wall',
  });
  return [
    wall('room:wall:left', x0, z0, x0, z1),
    wall('room:wall:right', x1, z1, x1, z0),
    wall('room:wall:back', x1, z0, x0, z0),
    wall('room:wall:front-left', x0, z1, doorLeft, z1),
    wall('room:wall:front-right', doorRight, z1, x1, z1),
    {
      id: 'room:door-lintel', kind: 'lintel', x: room.x, y: room.doorHeight,
      z: z1, width: room.doorWidth + 0.8, height: 0.42, depth: 0.85,
      portalId: 'portal:guard-room',
      supportIds: ['room:wall:front-left', 'room:wall:front-right'], damageClass: 'lintel',
    },
    {
      id: 'room:floor', kind: 'floor', x: room.x, y: 0.12, z: room.z,
      width: room.width - 0.5, depth: room.depth - 0.5,
      portalIds: ['portal:guard-room', 'portal:dungeon-floor'],
      supportIds: ['foundation:room'], damageClass: 'floor',
    },
  ];
}

function buildIntact(seed, attempt = 0) {
  const dimensions = rngFor(seed, 'dimensions', attempt);
  const radiusX = 18 + dimensions() * 5;
  const radiusZ = 18 + dimensions() * 5;
  const wallHeight = 4.2 + dimensions() * 1.1;
  const thickness = 0.9 + dimensions() * 0.25;
  const gateWidth = 3.2 + dimensions() * 0.8;
  const curtain = makeCurtain(seed, attempt, radiusX, radiusZ, wallHeight, thickness, gateWidth);

  const arrangement = rngFor(seed, 'arrangement', attempt);
  const primarySide = arrangement() < 0.5 ? -1 : 1;
  const towerCount = arrangement() < 0.56 ? 1 : 2;
  const towerRadius = 3.15 + arrangement() * 0.65;
  const lookoutY = 3.9 + arrangement() * 0.65;
  const primary = {
    id: 'tower:lookout', kind: 'tower', role: 'lookout',
    // Keep the lookout inside the curtain rather than straddling its rear
    // wall. The former perimeter-biased placement made the authored
    // ramp-to-lookout route cross a surviving curtain proxy for many seeds;
    // the tower remains visually prominent while its doorway now has a clear
    // courtyard-side approach.
    x: primarySide * radiusX * 0.56, z: -radiusZ * 0.54,
    radius: towerRadius, height: 7.2 + arrangement() * 2.0,
    doorwayAngle: 0, supportIds: ['foundation:tower:lookout'], damageClass: 'tower-shell',
  };
  // doorwayAngle is measured from +X. It is aligned to the ramp approach
  // below, so the authored route enters the lookout through the same opening
  // that the simplified tower collision proxy omits.
  primary.doorwayAngle = Math.PI / 2;
  const towers = [primary];
  if (towerCount === 2) towers.push({
    id: 'tower:secondary', kind: 'tower', role: 'solid',
    x: -primarySide * radiusX * 0.70, z: radiusZ * 0.48,
    radius: 2.8 + arrangement() * 0.55, height: 6.0 + arrangement() * 1.8,
    doorwayAngle: null, supportIds: ['foundation:tower:secondary'], damageClass: 'tower-shell',
  });

  const room = {
    id: 'room:guard', kind: 'room', purpose: 'guard-room',
    // Leave a real courtyard approach between the room and the rear curtain.
    // A perimeter-hugging room placed its floor path through the wall's
    // conservative thickness on some irregular curtain shapes.
    x: -primarySide * radiusX * 0.24, z: -radiusZ * 0.43,
    width: 7.0 + arrangement() * 1.5, depth: 5.4 + arrangement() * 1.2,
    height: 3.4 + arrangement() * 0.6, doorWidth: 1.35, doorHeight: 2.2,
  };

  const rampWidth = 2.15;
  const rampEnd = { x: primary.x, z: primary.z + primary.radius * 0.68 };
  const rampStart = { x: primary.x, z: Math.min(radiusZ * 0.25, rampEnd.z + 14.5) };
  const ramp = {
    id: 'circulation:ramp', kind: 'ramp',
    ax: rampStart.x, az: rampStart.z, ay: 0.18,
    bx: rampEnd.x, bz: rampEnd.z, by: lookoutY,
    width: rampWidth, supportIds: ['foundation:ramp'], damageClass: 'stair',
  };
  const landing = {
    id: 'lookout:landing', kind: 'landing', x: primary.x, y: lookoutY, z: primary.z,
    width: primary.radius * 1.45, depth: primary.radius * 1.45,
    supportIds: [primary.id, ramp.id], damageClass: 'floor',
  };

  const courtyard = { id: 'courtyard:main', kind: 'courtyard', points: curtain.vertices.map(({ x, z }) => ({ x, z })) };
  const roomDoor = {
    id: 'portal:guard-room', x: room.x, z: room.z + room.depth / 2,
    width: room.doorWidth, height: room.doorHeight, kind: 'interior-door',
  };
  // This is intentionally metadata only in the surface slice. A dungeon may
  // claim the floor portal later without changing the immutable ruin or its
  // route; the optional seam is explicit so streaming can negotiate it.
  const dungeonSeam = {
    version: 1, id: 'portal:dungeon-floor', kind: 'optional-floor-shaft',
    surfacePieceId: 'room:floor', surfaceRoomId: room.id,
    x: room.x, y: 0.12, z: room.z,
    radius: 1.15, enabled: false, reserved: true,
    protectedRoute: true,
  };
  const routeNodes = [
    { id: 'route:approach', kind: 'approach',
      x: curtain.gate.x + curtain.gate.outwardX * 5, y: 0,
      z: curtain.gate.z + curtain.gate.outwardZ * 5 },
    { id: 'route:gate', kind: 'gate', x: curtain.gate.x, y: 0, z: curtain.gate.z },
    { id: 'route:courtyard', kind: 'courtyard', x: 0, y: 0, z: 1 },
    // Approach the room door on its centreline before crossing the threshold.
    // A single diagonal courtyard→door edge can enter the conservative wall
    // thickness beside the opening when the room is offset in the enclosure.
    { id: 'route:room-approach', kind: 'portal-approach', x: room.x, y: 0.12,
      z: roomDoor.z + 2.0 },
    { id: 'route:room-door', kind: 'portal', x: roomDoor.x, y: 0.12, z: roomDoor.z },
    { id: 'route:room', kind: 'room', x: room.x, y: 0.12, z: room.z },
    { id: 'route:ramp-base', kind: 'ramp-base', x: ramp.ax, y: ramp.ay, z: ramp.az },
    { id: 'route:ramp-top', kind: 'ramp-top', x: ramp.bx, y: ramp.by, z: ramp.bz },
    { id: 'route:lookout', kind: 'lookout', x: landing.x, y: landing.y, z: landing.z },
  ];
  const routeEdges = [
    ['route:approach', 'route:gate'], ['route:gate', 'route:courtyard'],
    ['route:courtyard', 'route:room-approach'],
    ['route:room-approach', 'route:room-door'], ['route:room-door', 'route:room'],
    ['route:courtyard', 'route:ramp-base'], ['route:ramp-base', 'route:ramp-top'],
    ['route:ramp-top', 'route:lookout'],
  ].map(([from, to], index) => ({ id: `route:edge:${index}`, from, to, bidirectional: true }));
  const approach = {
    id: 'approach:gate', kind: 'gate-facing-approach', gateId: curtain.gate.id,
    start: routeNodes[0], end: routeNodes[1], width: curtain.gate.width + 2.4,
  };

  const pieces = [];
  for (const run of curtain.runs) {
    pieces.push(run, {
      id: `${run.id}:parapet`, kind: 'parapet', ax: run.ax, az: run.az, bx: run.bx, bz: run.bz,
      baseY: wallHeight, height: 0.62, thickness: thickness * 1.05,
      supportIds: [run.id], damageClass: 'wall-top',
    });
  }
  // The visible stair is a rendering piece over one continuous ramp support.
  // Collision and locomotion consume only the ramp/landing recipes, so small
  // stair stones can never create a discontinuous foot surface.
  const stair = {
    id: 'circulation:stair', kind: 'stair', supportIds: [ramp.id],
    ax: ramp.ax, az: ramp.az, ay: ramp.ay, bx: ramp.bx, bz: ramp.bz, by: ramp.by,
    width: ramp.width, steps: 9, damageClass: 'stair-visual',
  };
  pieces.push(...towers, ...roomPieces(room), ramp, stair, landing);

  const intact = {
    version: FORTIFIED_OUTPOST_VERSION,
    generationVersion: FORTIFIED_OUTPOST_GENERATION_VERSION,
    id: `fortified-outpost:${seed >>> 0}`,
    seed: seed >>> 0,
    attempt,
    bounds: { minX: -radiusX - 2, maxX: radiusX + 2, minZ: -radiusZ - 2, maxZ: radiusZ + 7 },
    footprintRadius: Math.hypot(radiusX, radiusZ) + 3,
    style: { wallHeight, thickness, towerCount, primarySide },
    curtain,
    approach,
    courtyard,
    room,
    portals: [roomDoor, dungeonSeam],
    dungeonSeam,
    towers,
    ramp,
    landing,
    pieces,
    supportGraph: pieces.map((piece) => ({ pieceId: piece.id, supportIds: [...(piece.supportIds || [])] })),
    supportNodes: [
      ...curtain.runs.map((run) => `foundation:curtain:${run.edgeIndex}`),
      'foundation:room', 'foundation:ramp',
      ...towers.map((tower) => tower.supportIds[0]),
    ].filter((id, index, ids) => ids.indexOf(id) === index).map((id) => ({ id, kind: 'foundation' })),
    circulation: {
      nodes: routeNodes, edges: routeEdges,
      protectedRoute: [
        'route:approach', 'route:gate', 'route:courtyard', 'route:room-approach',
        'route:room-door', 'route:room',
        'route:room-door', 'route:room-approach', 'route:courtyard',
        'route:ramp-base', 'route:ramp-top',
        'route:lookout', 'route:ramp-top', 'route:ramp-base', 'route:courtyard', 'route:gate', 'route:approach',
      ],
    },
    channelSeeds: {
      architecture: channel(seed, 'architecture', attempt),
      entropy: channel(seed, 'entropy-event', 0),
    },
  };
  intact.architectureSeed = intact.channelSeeds.architecture;
  intact.entropySeed = intact.channelSeeds.entropy;
  intact.architectureHash = hashHex(intact);
  return deepFreeze(intact);
}

export function validateFortifiedOutpostIntact(plan) {
  // Accept either the raw intact record or a realized plan for callers that
  // validate immediately after streaming/cache lookup.
  if (plan?.intact && !plan?.curtain) plan = plan.intact;
  const errors = [];
  if (plan?.version !== FORTIFIED_OUTPOST_VERSION) errors.push('version');
  if (plan?.generationVersion !== FORTIFIED_OUTPOST_GENERATION_VERSION) errors.push('generation-version');
  if (!plan?.curtain?.runs?.length || plan.curtain.runs.length < 8) errors.push('curtain');
  if (!(plan?.curtain?.gate?.width >= 3)) errors.push('gate-width');
  if (!plan?.room || !plan?.ramp || !plan?.landing || !plan?.dungeonSeam || !plan?.approach) errors.push('required-program');
  if (!(plan?.towers?.length === 1 || plan?.towers?.length === 2)) errors.push('tower-count');
  const footprintWidth = (plan?.bounds?.maxX ?? 0) - (plan?.bounds?.minX ?? 0);
  const footprintDepth = (plan?.bounds?.maxZ ?? 0) - (plan?.bounds?.minZ ?? 0);
  if (footprintWidth < 35 || footprintWidth > 58 || footprintDepth < 35 || footprintDepth > 62) {
    errors.push(`footprint:${footprintWidth.toFixed(1)}x${footprintDepth.toFixed(1)}`);
  }
  if (!Number.isFinite(plan?.curtain?.gate?.normalX)
    || !Number.isFinite(plan?.curtain?.gate?.normalZ)) errors.push('gate-normal');
  if (!plan?.pieces?.some((piece) => piece.id === 'circulation:stair')) errors.push('missing-stair');
  if (plan?.dungeonSeam?.enabled) errors.push('dungeon-seam-enabled-in-intact');
  const ids = new Set();
  for (const piece of plan?.pieces || []) {
    if (!piece.id || ids.has(piece.id)) errors.push(`piece-id:${piece.id || 'missing'}`);
    ids.add(piece.id);
  }
  for (const entry of plan?.supportGraph || []) {
    for (const support of entry.supportIds) {
      if (!support.startsWith('foundation:') && !ids.has(support)) errors.push(`missing-support:${entry.pieceId}:${support}`);
    }
  }
  const pieceById = new Map((plan?.pieces || []).map((piece) => [piece.id, piece]));
  const supportIds = new Set((plan?.supportNodes || []).map((support) => support.id));
  if (!supportIds.has('foundation:room') || !supportIds.has('foundation:ramp')) errors.push('support-foundations');
  for (const piece of plan?.pieces || []) {
    for (const support of piece.supportIds || []) {
      if (support.startsWith('foundation:')) {
        if (!supportIds.has(support)) errors.push(`missing-foundation:${piece.id}:${support}`);
        continue;
      }
      if (!pieceById.has(support)) errors.push(`piece-missing-support:${piece.id}:${support}`);
    }
  }
  if (plan?.dungeonSeam?.surfacePieceId !== 'room:floor') errors.push('dungeon-seam-surface');
  if (!plan?.circulation?.protectedRoute?.includes('route:approach')
    || !plan.circulation.protectedRoute.includes('route:lookout')) errors.push('protected-route');
  const nodes = new Map((plan?.circulation?.nodes || []).map((node) => [node.id, node]));
  const adjacency = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const edge of plan?.circulation?.edges || []) {
    adjacency.get(edge.from)?.push(edge.to);
    if (edge.bidirectional) adjacency.get(edge.to)?.push(edge.from);
  }
  const reached = new Set(['route:approach']), queue = ['route:approach'];
  while (queue.length) {
    for (const next of adjacency.get(queue.shift()) || []) if (!reached.has(next)) {
      reached.add(next); queue.push(next);
    }
  }
  for (const id of ['route:room', 'route:lookout']) if (!reached.has(id)) errors.push(`unreachable:${id}`);
  const rampLength = Math.hypot(plan?.ramp?.bx - plan?.ramp?.ax, plan?.ramp?.bz - plan?.ramp?.az);
  const rampGrade = Math.abs(plan?.ramp?.by - plan?.ramp?.ay) / Math.max(0.01, rampLength);
  if (rampGrade > 0.34) errors.push(`ramp-grade:${rampGrade.toFixed(3)}`);
  if (Math.hypot(plan?.ramp?.bx - plan?.ramp?.ax, plan?.ramp?.bz - plan?.ramp?.az) < 8) errors.push('ramp-length');
  if (!polygonContains(plan?.courtyard?.points || [], 0, 0)) errors.push('courtyard-origin');
  if (plan?.architectureHash && plan.architectureHash !== hashHex({ ...plan, architectureHash: undefined })) {
    errors.push('architecture-hash');
  }
  return { valid: errors.length === 0, errors, rampGrade, footprint: { width: footprintWidth, depth: footprintDepth } };
}

function entropyFor(intact) {
  const rng = rngFor(intact.seed, 'entropy-event');
  const protectedNodes = intact.circulation.nodes.filter((node) =>
    intact.circulation.protectedRoute.includes(node.id));
  const routeById = new Map(intact.circulation.nodes.map((node) => [node.id, node]));
  const routeSegments = [];
  for (const edge of intact.circulation.edges) {
    const a = routeById.get(edge.from), b = routeById.get(edge.to);
    if (a && b) routeSegments.push([a, b]);
  }
  const routeClearance = (point) => routeSegments.reduce((best, [a, b]) =>
    Math.min(best, distanceToSegment(point, a, b)), Infinity);
  const candidates = intact.curtain.runs.filter((run) => {
    if (run.gateSide) return false;
    const midpoint = { x: (run.ax + run.bx) / 2, z: (run.az + run.bz) / 2 };
    return protectedNodes.every((node) => Math.hypot(node.x - midpoint.x, node.z - midpoint.z) > 5.5)
      && routeClearance(midpoint) > 4.8;
  });
  const target = candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))]
    || intact.curtain.runs.find((run) => !run.gateSide);
  const removedPieceIds = [target.id, `${target.id}:parapet`];
  const mx = (target.ax + target.bx) / 2, mz = (target.az + target.bz) / 2;
  const dx = target.bx - target.ax, dz = target.bz - target.az;
  const length = Math.hypot(dx, dz) || 1;
  let outwardX = -dz / length, outwardZ = dx / length;
  if (mx * outwardX + mz * outwardZ < 0) { outwardX = -outwardX; outwardZ = -outwardZ; }
  const rubble = [];
  const rubbleCount = 7 + Math.floor(rng() * 4);
  for (let index = 0; index < rubbleCount; index++) {
    const along = (rng() - 0.5) * Math.min(7, length * 0.8);
    const outward = 0.8 + rng() * 4.4;
    const x = mx + dx / length * along + outwardX * outward;
    const z = mz + dz / length * along + outwardZ * outward;
    let rubblePoint = { x, z };
    // The intact validation protects route nodes; this second check protects
    // the entire route corridor from stable rubble, not just its waypoints.
    // A deterministic outward push is preferable to a reroll because it keeps
    // the single entropy draw count and event identity stable.
    let push = 0;
    while (routeClearance(rubblePoint) < 2.25 && push < 4) {
      push += 0.75;
      rubblePoint = { x: x + outwardX * push, z: z + outwardZ * push };
    }
    rubble.push({
      id: `entropy:rubble:${index}`, sourcePieceId: target.id,
      kind: index < 2 ? 'large-rubble' : 'small-rubble',
      x: rubblePoint.x, y: 0, z: rubblePoint.z,
      width: index < 2 ? 1.25 + rng() * 0.55 : 0.45 + rng() * 0.55,
      height: index < 2 ? 0.55 + rng() * 0.35 : 0.25 + rng() * 0.35,
      depth: index < 2 ? 0.9 + rng() * 0.55 : 0.4 + rng() * 0.5,
      yaw: rng() * TAU, stable: index < 2,
    });
  }
  const entropy = {
    version: 1,
    seed: channel(intact.seed, 'entropy-event'),
    events: [{
      id: 'entropy:event:0', kind: 'curtain-breach', targetPieceId: target.id,
      cause: rng() < 0.5 ? 'foundation-failure' : 'long-weathering',
      cascadedPieceIds: [`${target.id}:parapet`],
    }],
    removedPieceIds,
    rubble,
    protectedRoute: [...intact.circulation.protectedRoute],
    channel: 'entropy-event',
    eventCount: 1,
    architectureHash: intact.architectureHash,
    entropySeed: channel(intact.seed, 'entropy-event'),
  };
  entropy.entropyHash = hashHex(entropy);
  return deepFreeze(entropy);
}

function boxLoop(piece, minY, maxY, thickness = 0) {
  const c = Math.cos(piece.yaw || 0), s = Math.sin(piece.yaw || 0);
  const hx = piece.width / 2, hz = piece.depth / 2;
  const local = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  const points = local.map(([x, z]) => ({
    x: piece.x + x * c + z * s,
    z: piece.z - x * s + z * c,
  }));
  return points.map((point, index) => ({
    id: `${piece.id}:collision:${index}`, sourcePieceId: piece.id,
    ax: point.x, az: point.z,
    bx: points[(index + 1) % points.length].x, bz: points[(index + 1) % points.length].z,
    minY, maxY, thickness,
  }));
}

function towerSegments(tower) {
  const count = 12, result = [];
  for (let index = 0; index < count; index++) {
    const a0 = index / count * TAU, a1 = (index + 1) / count * TAU;
    const middle = (a0 + a1) / 2;
    const doorDistance = tower.doorwayAngle === null ? Infinity
      : Math.abs(Math.atan2(Math.sin(middle - tower.doorwayAngle), Math.cos(middle - tower.doorwayAngle)));
    // The rendered doorway is intentionally wider than one coarse arc: the
    // continuous ramp has a 2.15m footprint and must not snag on the adjacent
    // simplified segments while entering the lookout.
    if (doorDistance < 0.54) continue;
    result.push({
      id: `${tower.id}:collision:${index}`, sourcePieceId: tower.id,
      ax: tower.x + Math.cos(a0) * tower.radius, az: tower.z + Math.sin(a0) * tower.radius,
      bx: tower.x + Math.cos(a1) * tower.radius, bz: tower.z + Math.sin(a1) * tower.radius,
      minY: 0, maxY: tower.height, thickness: 0.82,
    });
  }
  return result;
}

function realize(intact, entropy) {
  const removed = new Set(entropy.removedPieceIds);
  const survivingPieces = intact.pieces.filter((piece) => !removed.has(piece.id));
  const renderPieces = [...survivingPieces, ...entropy.rubble];
  const collisionProxies = [];
  for (const piece of survivingPieces) {
    if (piece.kind === 'curtain-wall' || piece.kind === 'parapet' || piece.kind === 'room-wall') {
      collisionProxies.push({
        id: `${piece.id}:collision`, sourcePieceId: piece.id,
        ax: piece.ax, az: piece.az, bx: piece.bx, bz: piece.bz,
        minY: piece.baseY || 0, maxY: (piece.baseY || 0) + piece.height,
        thickness: piece.thickness || 0,
      });
    } else if (piece.kind === 'tower') collisionProxies.push(...towerSegments(piece));
  }
  for (const piece of entropy.rubble.filter((item) => item.stable)) {
    collisionProxies.push(...boxLoop(piece, 0, piece.height));
  }

  const room = intact.room;
  const claims = [
    {
      id: `${intact.id}:surface:room`, sourcePieceId: 'room:floor', kind: 'floor', mode: 'fixed', y: 0.12,
      shape: { kind: 'box', x: room.x, z: room.z, width: room.width - 0.7, depth: room.depth - 0.7, yaw: 0 },
      routeNodeIds: ['route:room-door', 'route:room'],
    },
    {
      id: `${intact.id}:surface:ramp`, sourcePieceId: intact.ramp.id, kind: 'ramp', mode: 'ramp',
      ax: intact.ramp.ax, az: intact.ramp.az, ay: intact.ramp.ay,
      bx: intact.ramp.bx, bz: intact.ramp.bz, by: intact.ramp.by, width: intact.ramp.width,
      routeNodeIds: ['route:ramp-base', 'route:ramp-top'],
    },
    {
      id: `${intact.id}:surface:landing`, sourcePieceId: intact.landing.id, kind: 'landing', mode: 'fixed', y: intact.landing.y,
      shape: { kind: 'box', x: intact.landing.x, z: intact.landing.z, width: intact.landing.width, depth: intact.landing.depth, yaw: 0 },
      routeNodeIds: ['route:ramp-top', 'route:lookout'],
    },
  ];
  return deepFreeze({
    survivingPieces, renderPieces, collisionProxies,
    // recipes are the JSON-safe source of truth. Runtime adapters can attach
    // contains/height/normal functions without changing these records.
    walkableClaims: claims,
    walkableRecipes: claims,
    collisionRecipes: collisionProxies,
  });
}

export function createFortifiedOutpostPlan(seed = 1) {
  if (seed && typeof seed === 'object') seed = seed.seed ?? 1;
  seed = Number(seed) >>> 0;
  const key = `${seed >>> 0}:${FORTIFIED_OUTPOST_GENERATION_VERSION}`;
  if (PLAN_CACHE.has(key)) return PLAN_CACHE.get(key);
  let intact = null, validation = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const candidate = buildIntact(seed >>> 0, attempt);
    const report = validateFortifiedOutpostIntact(candidate);
    if (report.valid) { intact = candidate; validation = report; break; }
  }
  // The grammar is constructed to validate, but retain a deterministic minimal
  // retry rather than ever publishing an invalid structure after future edits.
  if (!intact) {
    intact = buildIntact(channel(seed, 'safe-fallback'), 0);
    validation = validateFortifiedOutpostIntact(intact);
    if (!validation.valid) throw new Error(`Invalid fortified outpost: ${validation.errors.join(', ')}`);
  }
  const entropy = entropyFor(intact);
  const realization = realize(intact, entropy);
  const plan = {
    version: FORTIFIED_OUTPOST_VERSION,
    generationVersion: FORTIFIED_OUTPOST_GENERATION_VERSION,
    id: intact.id,
    seed: seed >>> 0,
    architectureSeed: intact.architectureSeed,
    entropySeed: entropy.entropySeed,
    architectureHash: intact.architectureHash,
    entropyHash: entropy.entropyHash,
    hashes: {
      architecture: intact.architectureHash,
      entropy: entropy.entropyHash,
    },
    intact,
    entropy,
    ...realization,
    dungeonSeam: intact.dungeonSeam,
    diagnostics: {
      attempts: intact.attempt + 1, fallback: intact.seed !== (seed >>> 0), validation,
      channels: { architecture: intact.channelSeeds.architecture, entropy: entropy.seed },
      entropyEvents: entropy.events.length,
      lookoutPreserved: realization.survivingPieces.some((piece) => piece.id === 'tower:lookout')
        && realization.survivingPieces.some((piece) => piece.id === 'lookout:landing'),
    },
  };
  plan.planHash = hashHex({
    version: plan.version, generationVersion: plan.generationVersion,
    id: plan.id, architectureHash: plan.architectureHash, entropyHash: plan.entropyHash,
  });
  deepFreeze(plan);
  PLAN_CACHE.set(key, plan);
  if (PLAN_CACHE.size > 512) PLAN_CACHE.delete(PLAN_CACHE.keys().next().value);
  return plan;
}

export function fortifiedOutpostFootprintRadius(seed) {
  return createFortifiedOutpostPlan(seed).intact.footprintRadius;
}

export function fortifiedOutpostGateLocal(seed, outside = 3) {
  const gate = createFortifiedOutpostPlan(seed).intact.curtain.gate;
  return { x: gate.x + gate.outwardX * outside, z: gate.z + gate.outwardZ * outside };
}

export function pointInsideFortifiedOutpost(plan, x, z) {
  return polygonContains(plan.intact.courtyard.points, x, z);
}

export function protectedRouteClearance(plan, point) {
  const nodes = new Map(plan.intact.circulation.nodes.map((node) => [node.id, node]));
  let distance = Infinity;
  const route = plan.intact.circulation.protectedRoute;
  for (let index = 1; index < route.length; index++) {
    const a = nodes.get(route[index - 1]), b = nodes.get(route[index]);
    if (a && b) distance = Math.min(distance, distanceToSegment(point, a, b));
  }
  return distance;
}

function shapeContains(shape, x, z) {
  if (!shape) return false;
  if (shape.kind === 'box') {
    const c = Math.cos(shape.yaw || 0), s = Math.sin(shape.yaw || 0);
    const dx = x - shape.x, dz = z - shape.z;
    const localX = dx * c - dz * s, localZ = dx * s + dz * c;
    return Math.abs(localX) <= shape.width / 2 && Math.abs(localZ) <= shape.depth / 2;
  }
  if (shape.kind === 'circle') return Math.hypot(x - shape.x, z - shape.z) <= shape.radius;
  return Array.isArray(shape.points) ? polygonContains(shape.points, x, z) : false;
}

export function fortifiedOutpostClaimContains(claim, x, z) {
  if (claim?.mode === 'ramp') {
    const dx = claim.bx - claim.ax, dz = claim.bz - claim.az;
    const length2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - claim.ax) * dx + (z - claim.az) * dz) / length2));
    const px = claim.ax + dx * t, pz = claim.az + dz * t;
    return Math.hypot(x - px, z - pz) <= claim.width / 2;
  }
  return shapeContains(claim?.shape, x, z);
}

export function fortifiedOutpostClaimHeight(claim, x, z) {
  if (claim?.mode !== 'ramp') return Number.isFinite(claim?.y) ? claim.y : null;
  const dx = claim.bx - claim.ax, dz = claim.bz - claim.az;
  const length2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - claim.ax) * dx + (z - claim.az) * dz) / length2));
  return claim.ay + (claim.by - claim.ay) * t;
}

export function fortifiedOutpostClaimNormal(claim) {
  if (claim?.mode !== 'ramp') return [0, 1, 0];
  const dx = claim.bx - claim.ax, dy = claim.by - claim.ay, dz = claim.bz - claim.az;
  const length = Math.hypot(dx, dy, dz) || 1;
  // The authored ramp is a straight plane. Its normal is stable regardless of
  // which point the foot query samples.
  const horizontal = Math.hypot(dx, dz) || 1;
  return [-dy * dx / (horizontal * length), horizontal / length,
    -dy * dz / (horizontal * length)];
}

/**
 * Adapt the JSON-safe recipes to WalkableSurface's runtime contract. The
 * planner never stores closures, which keeps worker parity and snapshotting
 * straightforward; this adapter is the only place where spatial predicates
 * are attached.
 */
export function createFortifiedOutpostWalkableClaims(plan) {
  const source = plan?.walkableRecipes || plan?.walkableClaims || [];
  return source.map((recipe) => ({
    ...recipe,
    contains: (x, z) => fortifiedOutpostClaimContains(recipe, x, z),
    heightAt: (x, z) => fortifiedOutpostClaimHeight(recipe, x, z),
    normalAt: () => fortifiedOutpostClaimNormal(recipe),
    y: Number.isFinite(recipe.y) ? recipe.y : recipe.ay,
  }));
}

export function fortifiedOutpostCollisionRecipes(plan) {
  return [...(plan?.collisionRecipes || plan?.collisionProxies || [])];
}

export function fortifiedOutpostRenderRecipes(plan) {
  return [...(plan?.renderPieces || plan?.survivingPieces || [])];
}

function transformXZ(point, transform) {
  const c = Math.cos(transform.yaw || 0), s = Math.sin(transform.yaw || 0);
  return {
    x: (transform.x || 0) + point.x * c + point.z * s,
    z: (transform.z || 0) - point.x * s + point.z * c,
  };
}

/** Place runtime recipes in world space without mutating the local plan. */
export function transformFortifiedOutpostPlan(plan, transform = {}) {
  const t = { x: transform.x || 0, y: transform.y || 0, z: transform.z || 0, yaw: transform.yaw || 0 };
  const collisionProxies = fortifiedOutpostCollisionRecipes(plan).map((proxy) => {
    const a = transformXZ({ x: proxy.ax, z: proxy.az }, t);
    const b = transformXZ({ x: proxy.bx, z: proxy.bz }, t);
    return { ...proxy, ax: a.x, az: a.z, bx: b.x, bz: b.z,
      minY: proxy.minY + t.y, maxY: proxy.maxY + t.y };
  });
  const walkableClaims = (plan.walkableRecipes || plan.walkableClaims || []).map((claim) => {
    if (claim.mode === 'ramp') {
      const a = transformXZ({ x: claim.ax, z: claim.az }, t);
      const b = transformXZ({ x: claim.bx, z: claim.bz }, t);
      return { ...claim, ax: a.x, az: a.z, bx: b.x, bz: b.z,
        ay: claim.ay + t.y, by: claim.by + t.y, y: (claim.y ?? claim.ay) + t.y };
    }
    const shape = claim.shape?.kind === 'box'
      ? { ...claim.shape, ...transformXZ(claim.shape, t), yaw: (claim.shape.yaw || 0) + t.yaw }
      : claim.shape;
    return { ...claim, shape, y: claim.y + t.y };
  });
  const seamPoint = transformXZ(plan.dungeonSeam || { x: 0, z: 0 }, t);
  const dungeonSeam = plan.dungeonSeam
    ? { ...plan.dungeonSeam, x: seamPoint.x, z: seamPoint.z, y: plan.dungeonSeam.y + t.y }
    : plan.dungeonSeam;
  return {
    ...plan, worldTransform: t, collisionProxies, collisionRecipes: collisionProxies,
    walkableClaims, walkableRecipes: walkableClaims, dungeonSeam,
  };
}

export function fortifiedOutpostArchitectureHash(seed) {
  return createFortifiedOutpostPlan(seed).architectureHash;
}

export function fortifiedOutpostEntropyHash(seed) {
  return createFortifiedOutpostPlan(seed).entropyHash;
}

export const validateFortifiedOutpost = validateFortifiedOutpostIntact;

export function validateFortifiedOutpostRealization(plan) {
  const errors = [];
  const removed = new Set(plan?.entropy?.removedPieceIds || []);
  const intactIds = new Set(plan?.intact?.pieces?.map((piece) => piece.id) || []);
  for (const id of removed) if (!intactIds.has(id)) errors.push(`removed-unknown:${id}`);
  for (const piece of plan?.survivingPieces || []) if (removed.has(piece.id)) errors.push(`survivor-removed:${piece.id}`);
  if (!plan?.survivingPieces?.some((piece) => piece.id === 'tower:lookout')) errors.push('lookout-collapsed');
  if (!plan?.survivingPieces?.some((piece) => piece.id === 'lookout:landing')) errors.push('landing-collapsed');
  const renderIds = new Set(plan?.renderPieces?.map((piece) => piece.id) || []);
  for (const proxy of plan?.collisionProxies || []) {
    if (!renderIds.has(proxy.sourcePieceId)) errors.push(`proxy-orphan:${proxy.id}`);
  }
  if (plan?.entropy?.events?.length !== 1) errors.push('entropy-event-count');
  return { valid: errors.length === 0, errors };
}

/**
 * Validate whichever representation a caller has in hand. A worker often
 * checks the intact grammar before realization, while a stream/cache audit
 * receives the realized record; keeping this entry point tolerant avoids
 * making those consumers know which phase produced their value.
 */
export function validateFortifiedOutpostPlan(plan) {
  const intact = validateFortifiedOutpostIntact(plan);
  const realization = plan?.intact || plan?.survivingPieces
    ? validateFortifiedOutpostRealization(plan)
    : { valid: true, errors: [] };
  const errors = [...intact.errors, ...realization.errors];
  return { valid: errors.length === 0, errors, intact, realization };
}
