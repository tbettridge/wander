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

// How ambitious a tower site is. Not every rise wants a castle on it: the lone
// broken drum on a hilltop is the silhouette this world was built around, so
// most sites keep it, some grow a wall around it, and a minority become a keep
// with a hall and something underneath. One edit here retunes the whole world.
export const OUTPOST_TIERS = Object.freeze(['watch', 'outpost', 'keep']);
const TIER_SHARES = Object.freeze({ watch: 0.45, outpost: 0.30, keep: 0.25 });

export function fortifiedOutpostTier(seed) {
  const roll = rngFor(seed >>> 0, 'site-tier')();
  let cumulative = 0;
  for (const tier of OUTPOST_TIERS) {
    cumulative += TIER_SHARES[tier];
    if (roll < cumulative) return tier;
  }
  return 'keep';
}

/**
 * The ruined drum at the centre of every tower site.
 *
 * This is the watchtower — the same slim, tall, half-collapsed cylinder the
 * world has always had. At `watch` scale it stands alone; at `keep` scale the
 * curtain wall is built around it and it becomes the donjon. It is authored
 * here, in the renderer-free plan, so the stones, the collision proxies and the
 * route all agree about which arc of it survived.
 */
function buildDonjon(seed, attempt) {
  const rng = rngFor(seed, 'donjon', attempt);
  const radius = 2.7 + rng() * 0.5;                 // slim drum → reads tall
  // Ashlar, not boulders. A ~0.55m course on a 5.5m drum is the scale that
  // reads as cut and laid stone; the old metre-high blocks made a tower look
  // like it was stacked out of crates, and a low curtain wall built from them
  // was only four blocks tall.
  const courseHeight = 0.52 + rng() * 0.10;
  const courses = 26 + (rng() * 8 | 0);            // ~14–17 m of standing shell
  const tallAngle = rng() * Math.PI * 2;            // best-preserved direction
  // The doorway pierces the standing shell, not the stub.
  const doorAngle = tallAngle + (rng() < 0.5 ? -1 : 1) * (0.5 + rng() * 0.3);
  return {
    id: 'tower:donjon', kind: 'tower', role: 'donjon',
    x: 0, z: 0, radius, courses, courseHeight,
    height: courses * courseHeight,
    tallAngle, doorAngle, wedge: 0.95 + rng() * 0.3,
    jagSeed: channel(seed, 'donjon-break', attempt) % 89,
    // towerSegments() reads this to leave the doorway genuinely open.
    doorwayAngle: doorAngle,
    doorCourses: Math.round(2.1 / courseHeight),   // a ~2.1 m opening
    supportIds: ['foundation:tower:donjon'], damageClass: 'tower-shell',
  };
}

/**
 * Surviving height, in courses, at one bearing around the drum.
 *
 * A full-height shell over roughly a third of the circle, then a steep jagged
 * break down to a low stub. Rendering lays stones under this line and collision
 * caps its proxies at it, so what you can see is what stops you.
 */
export function donjonRimCourses(donjon, angle) {
  // Normalised first: the jag is keyed on the bearing, and a caller working in
  // [-π, π] must get the same broken wall as one working in [0, 2π). Rendering,
  // collision and route inspection each reach this from a different direction.
  const bearing = ((angle % TAU) + TAU) % TAU;
  const distance = angleDistance(bearing, donjon.tallAngle);
  const t = Math.min(1, Math.max(0, (distance - donjon.wedge) / 0.6));
  const p = 1 - t * t * (3 - 2 * t);
  const jag = (hashUnit(Math.round(bearing * 9), donjon.jagSeed * 0.13, 1.7) - 0.5) * 2.6;
  return Math.max(0, donjon.courses * (0.14 + 0.86 * p) + jag);
}

function angleDistance(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return Math.abs(d);
}

// The same sin-hash landmarkmesh has always used for the break profile, kept
// here so the plan stays renderer-free and Node audits reproduce it exactly.
function hashUnit(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
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
      portalIds: ['portal:guard-room'],
      supportIds: ['foundation:room'], damageClass: 'floor',
    },
  ];
}

function buildIntact(seed, attempt = 0, options = {}) {
  const tier = options.tier || fortifiedOutpostTier(seed);
  const dimensions = rngFor(seed, 'dimensions', attempt);
  const donjon = buildDonjon(seed, attempt);
  const walled = tier !== 'watch';
  const full = tier === 'keep';

  // An outpost throws a low ring around the drum; a keep builds a real curtain.
  const radiusX = walled ? 18 + dimensions() * 5 : 0;
  const radiusZ = walled ? 18 + dimensions() * 5 : 0;
  const wallHeight = (full ? 4.2 : 3.1) + dimensions() * 1.1;
  const thickness = 0.9 + dimensions() * 0.25;
  const gateWidth = 3.2 + dimensions() * 0.8;
  const curtain = walled
    ? makeCurtain(seed, attempt, radiusX, radiusZ, wallHeight, thickness, gateWidth)
    : null;

  // The bailey is a ring around the drum, not an open field with the drum in
  // the middle of it. Everything on the site hangs off that ring, so no route
  // is ever a straight line from one side of the courtyard to the other —
  // which is a line through the tower.
  const RING_NODES = 6;
  // Tight enough that the buildings around the bailey stay outside it, wide
  // enough to walk between the drum and whatever is on the ring.
  const ringRadius = donjon.radius + 3.2;

  const arrangement = rngFor(seed, 'arrangement', attempt);
  const primarySide = arrangement() < 0.5 ? -1 : 1;

  const towers = [donjon];

  const room = full ? (() => {
    const width = 7.0 + arrangement() * 1.5;
    const depth = 5.4 + arrangement() * 1.2;
    return {
      id: 'room:guard', kind: 'room', purpose: 'guard-room',
      // Against the rear of the bailey, door facing in. Far enough back that
      // the circulation ring around the drum passes in front of it rather than
      // through it, and clear of the curtain behind.
      x: -primarySide * radiusX * 0.20,
      z: -(donjon.radius + 6.2 + depth / 2),
      width, depth,
      height: 3.4 + arrangement() * 0.6, doorWidth: 1.35, doorHeight: 2.2,
    };
  })() : null;

  // The wall-walk. A keep's ramp climbs to the parapet of the best-preserved
  // curtain run rather than up the ruined drum, so the walk is somewhere you
  // can actually stand and the donjon stays a ruin you enter at ground level.
  let ramp = null, landing = null, wallwalkEdge = -1, rampSpan = [];
  if (full && curtain) {
    // The curtain's vertex 0 sits front-right and the gate spans the front, so
    // the rear runs are where the hall is. Put the wall-walk on the far side
    // from it: a ramp that cuts across the hall is a ramp through a wall.
    wallwalkEdge = room.x > 0 ? 5 : 1;
    const inner = curtain.vertices.map((vertex) => {
      const radius = Math.hypot(vertex.x, vertex.z) || 1;
      const scale = Math.max(0, radius - thickness / 2 - 1.15) / radius;
      return { x: vertex.x * scale, z: vertex.z * scale };
    });
    const run = curtain.runs[wallwalkEdge];
    const midRadius = Math.hypot((run.ax + run.bx) / 2, (run.az + run.bz) / 2) || 1;
    const midScale = Math.max(0, midRadius - thickness / 2 - 1.6) / midRadius;
    // The landing is further along the wall-walk than the ramp's head, so
    // arriving at the top and standing on the walk are two different places.
    const runLength = Math.hypot(run.bx - run.ax, run.bz - run.az) || 1;
    const alongX = (run.bx - run.ax) / runLength, alongZ = (run.bz - run.az) / runLength;
    const topX = (run.ax + run.bx) / 2 * midScale, topZ = (run.az + run.bz) / 2 * midScale;
    const landingX = topX + alongX * 2.4, landingZ = topZ + alongZ * 2.4;
    // Walk back around the inner face until the climb is gentle enough to be a
    // ramp rather than a ladder. A steeper one is not walkable, and the surface
    // claim would happily carry you up it anyway, which reads as a bug.
    const MAX_GRADE = 0.27;
    // Try climbing from either end of the wall. Both give the same grade, so
    // take the one whose foot ends up further from the hall — a ramp foot in
    // front of the hall door puts the walk to the hall through the ramp.
    const candidate = (direction) => {
      for (let back = 1; back <= 3; back++) {
        const index = (wallwalkEdge + direction * back + inner.length * 4) % inner.length;
        const span = Math.hypot(topX - inner[index].x, topZ - inner[index].z);
        if (span > 0 && wallHeight / span <= MAX_GRADE) {
          return { index, clearance: Math.hypot(inner[index].x - room.x, inner[index].z - room.z) };
        }
      }
      return null;
    };
    const back = candidate(-1), forward = candidate(1);
    const chosen = [back, forward].filter(Boolean)
      .sort((a, b) => b.clearance - a.clearance)[0] || { index: wallwalkEdge };
    const baseIndex = chosen.index;
    const base = inner[baseIndex];
    // Which curtain vertices the ramp runs past, so nothing gets built on them.
    const step = baseIndex === (wallwalkEdge + 1) % inner.length ? -1 : 1;
    for (let index = baseIndex, guard = 0; guard <= inner.length; guard++) {
      rampSpan.push(index);
      if (index === (step > 0 ? (wallwalkEdge + 1) % inner.length : wallwalkEdge)) break;
      index = (index + step + inner.length) % inner.length;
    }
    ramp = {
      id: 'circulation:ramp', kind: 'ramp',
      ax: base.x, az: base.z, ay: 0.18,
      bx: topX, bz: topZ, by: wallHeight,
      width: 2.15, supportIds: ['foundation:ramp'], damageClass: 'stair',
    };
    landing = {
      id: 'wallwalk:landing', kind: 'landing', x: landingX, y: wallHeight, z: landingZ,
      width: 3.0, depth: 3.0,
      supportIds: [run.id, ramp.id], damageClass: 'floor',
    };
  }

  // Flanking turrets are the drum again at a smaller radius, standing on the
  // curtain. They exist so a keep's silhouette is the watchtower's shape
  // repeated, rather than a second shape introduced. Never on a vertex the
  // ramp climbs past, and never beside the hall.
  if (full && curtain) {
    const taken = new Set(rampSpan);
    const roomBearing = Math.atan2(room.z, room.x);
    const free = curtain.vertices
      .map((vertex, index) => ({ vertex, index }))
      .filter(({ index }) => !taken.has(index))
      .filter(({ vertex }) => Math.hypot(vertex.x - room.x, vertex.z - room.z)
        > Math.max(room.width, room.depth) * 0.85)
      .sort((a, b) => angleDistance(Math.atan2(b.vertex.z, b.vertex.x), roomBearing)
        - angleDistance(Math.atan2(a.vertex.z, a.vertex.x), roomBearing));
    const turretCount = Math.min(free.length, arrangement() < 0.55 ? 1 : 2);
    for (let index = 0; index < turretCount; index++) {
      const vertex = free[index].vertex;
      const turretRng = rngFor(seed, `turret-${index}`, attempt);
      const courses = 12 + (turretRng() * 6 | 0);
      towers.push({
        id: `tower:turret:${index}`, kind: 'tower', role: 'flanking',
        x: vertex.x * 0.97, z: vertex.z * 0.97,
        radius: 2.0 + turretRng() * 0.45, courses, courseHeight: donjon.courseHeight,
        height: courses * donjon.courseHeight,
        tallAngle: turretRng() * TAU, wedge: 1.15 + turretRng() * 0.4,
        jagSeed: channel(seed, `turret-break-${index}`, attempt) % 89,
        doorAngle: null, doorwayAngle: null, doorCourses: 0,
        supportIds: [`foundation:tower:turret:${index}`], damageClass: 'tower-shell',
      });
    }
  }

  // The undercroft. Its bearing comes from terrain — the stream hands in the
  // direction with real cover behind it — because a door into a bank has to be
  // in a bank. Without one, a seeded bearing keeps the plan pure for tests.
  const undercroftRng = rngFor(seed, 'undercroft', attempt);
  const undercroftBearing = Number.isFinite(options.undercroftBearing)
    ? options.undercroftBearing : undercroftRng() * TAU;
  const undercroft = full ? (() => {
    // Clear of the circulation ring, and inside the curtain with room for the
    // retaining wall either side. The door's jambs are solid, so a door standing
    // on the ring would wall off the bailey; one in the curtain would be a hole
    // in it. Between those, the terrain picks.
    // Set well back from the curtain. Two metres of clearance put the retaining
    // wall flat against the rampart, and the two merged into one grey mass with
    // no door in it: an undercroft has to read as its own building.
    const inner = Math.min(radiusX, radiusZ) * 0.90 - thickness / 2 - 6.0;
    const wanted = Number.isFinite(options.undercroftReach)
      ? options.undercroftReach : Math.min(radiusX, radiusZ) * 0.62;
    const reach = Math.min(Math.max(wanted, ringRadius + 4.5), Math.max(inner, ringRadius + 4.5));
    const x = Math.cos(undercroftBearing) * reach;
    const z = Math.sin(undercroftBearing) * reach;
    // Which way the hill rises here, which is the way the passage runs. The
    // door looks back down it, so you walk uphill to go in.
    const facing = Number.isFinite(options.undercroftFacing)
      ? options.undercroftFacing : undercroftBearing;
    return {
      id: 'undercroft:door', kind: 'undercroft',
      bearing: undercroftBearing, facing,
      yaw: Math.atan2(-Math.cos(facing), -Math.sin(facing)),
      x, y: -0.5, z, width: 2.4, height: 2.45, sillDrop: 0.5,
      // Stand back down the slope from the door to approach it.
      stepAx: x - Math.cos(facing) * 5.2,
      stepAz: z - Math.sin(facing) * 5.2,
      supportIds: ['foundation:undercroft'], damageClass: 'masonry-wall',
    };
  })() : null;

  const courtyard = curtain
    ? { id: 'courtyard:main', kind: 'courtyard', points: curtain.vertices.map(({ x, z }) => ({ x, z })) }
    : { id: 'courtyard:main', kind: 'courtyard', points: [
      { x: -8, z: -8 }, { x: 8, z: -8 }, { x: 8, z: 8 }, { x: -8, z: 8 },
    ] };

  const roomDoor = room ? {
    id: 'portal:guard-room', x: room.x, z: room.z + room.depth / 2,
    width: room.doorWidth, height: room.doorHeight, kind: 'interior-door',
  } : null;
  // The floor shaft the earlier draft reserved is gone: the way down is the
  // undercroft door, a thing you can see from the gate, not a hole in a floor.
  const dungeonSeam = undercroft ? {
    version: 2, id: 'portal:undercroft', kind: 'undercroft-door',
    surfacePieceId: undercroft.id, surfaceRoomId: 'courtyard:main',
    x: undercroft.x, y: undercroft.y, z: undercroft.z,
    bearing: undercroftBearing, yaw: undercroft.yaw,
    radius: 1.4, enabled: true, reserved: false, protectedRoute: true,
  } : null;

  // The drum's doorway, in local coordinates, so the route enters through the
  // arc the stones actually leave open.
  const donjonDoor = {
    id: 'portal:donjon', kind: 'tower-door',
    x: Math.cos(donjon.doorAngle) * donjon.radius,
    z: Math.sin(donjon.doorAngle) * donjon.radius,
    width: 1.6, height: donjon.courseHeight * donjon.doorCourses,
  };

  const gate = curtain ? curtain.gate : (() => {
    // A lone drum has no gate, but a trail still has to arrive somewhere. The
    // approach comes at the doorway from outside, which is the only way in.
    const reach = donjon.radius + 9;
    return {
      id: 'gate:none',
      x: Math.cos(donjon.doorAngle) * reach, z: Math.sin(donjon.doorAngle) * reach,
      width: 4,
      outwardX: Math.cos(donjon.doorAngle), outwardZ: Math.sin(donjon.doorAngle),
      normalX: Math.cos(donjon.doorAngle), normalZ: Math.sin(donjon.doorAngle),
    };
  })();

  const bearingOf = (x, z) => Math.atan2(z, x);
  const ringIndexFor = (bearing) =>
    ((Math.round(bearing / TAU * RING_NODES) % RING_NODES) + RING_NODES) % RING_NODES;
  const ringId = (index) => `route:bailey:${index}`;
  const routeNodes = [];
  const routePairs = [];
  for (let index = 0; index < RING_NODES; index++) {
    const bearing = index / RING_NODES * TAU;
    routeNodes.push({
      id: ringId(index), kind: 'courtyard',
      x: Math.cos(bearing) * ringRadius, y: 0, z: Math.sin(bearing) * ringRadius,
    });
    routePairs.push([ringId(index), ringId((index + 1) % RING_NODES)]);
  }
  // Spurs join the ring at the node nearest their own bearing, so a spur is
  // always short and always points outward.
  const spurFrom = (x, z) => ringId(ringIndexFor(bearingOf(x, z)));

  routeNodes.push(
    { id: 'route:approach', kind: 'approach',
      x: gate.x + gate.outwardX * 5, y: 0, z: gate.z + gate.outwardZ * 5 },
    { id: 'route:gate', kind: 'gate', x: gate.x, y: 0, z: gate.z },
    { id: 'route:donjon-door', kind: 'portal', x: donjonDoor.x, y: 0, z: donjonDoor.z },
    { id: 'route:donjon', kind: 'tower', x: 0, y: 0, z: 0 },
  );
  routePairs.push(
    ['route:approach', 'route:gate'],
    ['route:gate', spurFrom(gate.x, gate.z)],
    [spurFrom(donjonDoor.x, donjonDoor.z), 'route:donjon-door'],
    ['route:donjon-door', 'route:donjon'],
  );

  if (room && roomDoor) {
    routeNodes.push(
      // Approach the hall door on its centreline before crossing the threshold:
      // one diagonal edge can clip the conservative wall thickness beside it.
      { id: 'route:room-approach', kind: 'portal-approach', x: room.x, y: 0.12, z: roomDoor.z + 2.4 },
      { id: 'route:room-door', kind: 'portal', x: roomDoor.x, y: 0.12, z: roomDoor.z },
      { id: 'route:room', kind: 'room', x: room.x, y: 0.12, z: room.z },
    );
    routePairs.push(
      [spurFrom(room.x, roomDoor.z + 2.4), 'route:room-approach'],
      ['route:room-approach', 'route:room-door'], ['route:room-door', 'route:room'],
    );
  }
  if (ramp && landing) {
    routeNodes.push(
      { id: 'route:ramp-base', kind: 'ramp-base', x: ramp.ax, y: ramp.ay, z: ramp.az },
      { id: 'route:ramp-top', kind: 'ramp-top', x: ramp.bx, y: ramp.by, z: ramp.bz },
      { id: 'route:wallwalk', kind: 'wallwalk', x: landing.x, y: landing.y, z: landing.z },
    );
    routePairs.push(
      [spurFrom(ramp.ax, ramp.az), 'route:ramp-base'],
      ['route:ramp-base', 'route:ramp-top'], ['route:ramp-top', 'route:wallwalk'],
    );
  }
  if (undercroft) {
    routeNodes.push(
      { id: 'route:undercroft-approach', kind: 'portal-approach',
        x: undercroft.stepAx, y: 0, z: undercroft.stepAz },
      { id: 'route:undercroft', kind: 'undercroft',
        x: undercroft.x, y: undercroft.y, z: undercroft.z },
    );
    routePairs.push(
      [spurFrom(undercroft.stepAx, undercroft.stepAz), 'route:undercroft-approach'],
      ['route:undercroft-approach', 'route:undercroft'],
    );
  }

  const routeEdges = routePairs.map(([from, to], index) => ({
    id: `route:edge:${index}`, from, to, bidirectional: true,
  }));

  // The protected route is the actual walk: in at the approach, out to each
  // thing that was built, back each time. Entropy may not drop rubble on it,
  // and inspection walks it sample by sample looking for a proxy in the way.
  const adjacency = new Map(routeNodes.map((node) => [node.id, []]));
  for (const [from, to] of routePairs) {
    adjacency.get(from).push(to);
    adjacency.get(to).push(from);
  }
  const pathTo = (goal) => {
    const previous = new Map([['route:approach', null]]);
    const queue = ['route:approach'];
    while (queue.length) {
      const at = queue.shift();
      if (at === goal) break;
      for (const next of adjacency.get(at) || []) {
        if (previous.has(next)) continue;
        previous.set(next, at);
        queue.push(next);
      }
    }
    if (!previous.has(goal)) return [];
    const path = [];
    for (let at = goal; at !== null; at = previous.get(at)) path.unshift(at);
    return path;
  };
  const destinations = ['route:donjon'];
  if (room) destinations.push('route:room');
  if (landing) destinations.push('route:wallwalk');
  if (undercroft) destinations.push('route:undercroft');
  const protectedRoute = [];
  for (const destination of destinations) {
    const path = pathTo(destination);
    // Append the walk out and the walk back, without repeating the node the
    // previous leg already left us standing on.
    const leg = [...path, ...path.slice(0, -1).reverse()];
    for (const id of leg) {
      if (protectedRoute[protectedRoute.length - 1] !== id) protectedRoute.push(id);
    }
  }

  const approach = {
    id: 'approach:gate', kind: 'gate-facing-approach', gateId: gate.id,
    start: routeNodes.find((node) => node.id === 'route:approach'),
    end: routeNodes.find((node) => node.id === 'route:gate'), width: gate.width + 2.4,
  };

  const pieces = [...towers];
  for (const run of curtain?.runs || []) {
    pieces.push(run, {
      id: `${run.id}:parapet`, kind: 'parapet', ax: run.ax, az: run.az, bx: run.bx, bz: run.bz,
      baseY: wallHeight, height: 0.62, thickness: thickness * 1.05,
      supportIds: [run.id], damageClass: 'wall-top',
    });
  }
  if (curtain) pieces.push({
    id: 'gate:arch', kind: 'gate', x: gate.x, z: gate.z,
    yaw: Math.atan2(gate.outwardX, gate.outwardZ),
    width: gate.width, height: Math.min(wallHeight - 0.6, 3.2), thickness,
    supportIds: ['curtain:wall:gate-left', 'curtain:wall:gate-right'], damageClass: 'lintel',
  });
  if (room) pieces.push(...roomPieces(room));
  if (ramp && landing) {
    // The visible stair is a rendering piece over one continuous ramp support.
    // Collision and locomotion consume only the ramp/landing recipes, so small
    // stair stones can never create a discontinuous foot surface.
    pieces.push(ramp, {
      id: 'circulation:stair', kind: 'stair', supportIds: [ramp.id],
      ax: ramp.ax, az: ramp.az, ay: ramp.ay, bx: ramp.bx, bz: ramp.bz, by: ramp.by,
      width: ramp.width, steps: 9, damageClass: 'stair-visual',
    }, landing);
  }
  if (undercroft) pieces.push(undercroft);

  const extent = walled ? Math.max(radiusX, radiusZ) : donjon.radius + 6;
  const intact = {
    version: FORTIFIED_OUTPOST_VERSION,
    generationVersion: FORTIFIED_OUTPOST_GENERATION_VERSION,
    id: `fortified-outpost:${seed >>> 0}`,
    seed: seed >>> 0,
    attempt,
    tier,
    bounds: { minX: -extent - 2, maxX: extent + 2, minZ: -extent - 2, maxZ: extent + 7 },
    footprintRadius: (walled ? Math.hypot(radiusX, radiusZ) : donjon.radius + 5) + 3,
    style: { wallHeight, thickness, towerCount: towers.length, primarySide, tier },
    curtain,
    approach,
    courtyard,
    room,
    donjon,
    donjonDoor,
    undercroft,
    wallwalkEdge,
    portals: [donjonDoor, roomDoor, dungeonSeam].filter(Boolean),
    dungeonSeam,
    towers,
    ramp,
    landing,
    pieces,
    supportGraph: pieces.map((piece) => ({ pieceId: piece.id, supportIds: [...(piece.supportIds || [])] })),
    supportNodes: [
      ...(curtain?.runs || []).map((run) => `foundation:curtain:${run.edgeIndex}`),
      ...(room ? ['foundation:room'] : []),
      ...(ramp ? ['foundation:ramp'] : []),
      ...(undercroft ? ['foundation:undercroft'] : []),
      ...towers.map((tower) => tower.supportIds[0]),
    ].filter((id, index, ids) => ids.indexOf(id) === index).map((id) => ({ id, kind: 'foundation' })),
    circulation: { nodes: routeNodes, edges: routeEdges, protectedRoute },
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
  if (plan?.intact && !plan?.donjon) plan = plan.intact;
  const errors = [];
  const tier = plan?.tier;
  const walled = tier === 'outpost' || tier === 'keep';
  const full = tier === 'keep';
  if (plan?.version !== FORTIFIED_OUTPOST_VERSION) errors.push('version');
  if (plan?.generationVersion !== FORTIFIED_OUTPOST_GENERATION_VERSION) errors.push('generation-version');
  if (!OUTPOST_TIERS.includes(tier)) errors.push(`tier:${tier}`);

  // Every tier is the same building at a different scale, so the drum is the
  // one thing that must always be there and must always be enterable.
  const donjon = plan?.donjon;
  if (!donjon || donjon.id !== 'tower:donjon') errors.push('missing-donjon');
  else {
    if (!(donjon.radius > 2 && donjon.radius < 4)) errors.push(`donjon-radius:${donjon.radius}`);
    if (!(donjon.courses >= 24)) errors.push(`donjon-courses:${donjon.courses}`);
    // The doorway has to be in the part that survived, or it is a door into rubble.
    if (donjonRimCourses(donjon, donjon.doorAngle) < donjon.doorCourses + 1) {
      errors.push('donjon-door-collapsed');
    }
    if (plan?.towers?.[0]?.id !== 'tower:donjon') errors.push('donjon-not-first-tower');
  }

  if (walled) {
    if (!plan?.curtain?.runs?.length || plan.curtain.runs.length < 8) errors.push('curtain');
    if (!(plan?.curtain?.gate?.width >= 3)) errors.push('gate-width');
    if (!Number.isFinite(plan?.curtain?.gate?.normalX)
      || !Number.isFinite(plan?.curtain?.gate?.normalZ)) errors.push('gate-normal');
    if (!plan?.pieces?.some((piece) => piece.id === 'gate:arch')) errors.push('missing-gate-arch');
  } else if (plan?.curtain) errors.push('watch-tier-has-curtain');

  if (full) {
    if (!plan?.room || !plan?.ramp || !plan?.landing || !plan?.undercroft || !plan?.approach) {
      errors.push('required-program');
    }
    if (!plan?.dungeonSeam?.enabled) errors.push('undercroft-not-open');
    if (plan?.dungeonSeam?.surfacePieceId !== 'undercroft:door') errors.push('undercroft-seam-surface');
    if (!plan?.pieces?.some((piece) => piece.id === 'circulation:stair')) errors.push('missing-stair');
    const rampLength = Math.hypot(plan?.ramp?.bx - plan?.ramp?.ax, plan?.ramp?.bz - plan?.ramp?.az);
    const grade = Math.abs(plan?.ramp?.by - plan?.ramp?.ay) / Math.max(0.01, rampLength);
    if (grade > 0.34) errors.push(`ramp-grade:${grade.toFixed(3)}`);
    if (rampLength < 8) errors.push('ramp-length');
  } else if (plan?.room || plan?.ramp || plan?.undercroft) errors.push('program-above-tier');

  const footprintWidth = (plan?.bounds?.maxX ?? 0) - (plan?.bounds?.minX ?? 0);
  const footprintDepth = (plan?.bounds?.maxZ ?? 0) - (plan?.bounds?.minZ ?? 0);
  const [minSpan, maxSpan] = walled ? [35, 62] : [12, 26];
  if (footprintWidth < minSpan || footprintWidth > maxSpan
    || footprintDepth < minSpan || footprintDepth > maxSpan + 5) {
    errors.push(`footprint:${footprintWidth.toFixed(1)}x${footprintDepth.toFixed(1)}`);
  }

  const ids = new Set();
  for (const piece of plan?.pieces || []) {
    if (!piece.id || ids.has(piece.id)) errors.push(`piece-id:${piece.id || 'missing'}`);
    ids.add(piece.id);
  }
  const pieceById = new Map((plan?.pieces || []).map((piece) => [piece.id, piece]));
  const supportIds = new Set((plan?.supportNodes || []).map((support) => support.id));
  for (const piece of plan?.pieces || []) {
    for (const support of piece.supportIds || []) {
      if (support.startsWith('foundation:')) {
        if (!supportIds.has(support)) errors.push(`missing-foundation:${piece.id}:${support}`);
        continue;
      }
      if (!pieceById.has(support)) errors.push(`piece-missing-support:${piece.id}:${support}`);
    }
  }

  const route = plan?.circulation?.protectedRoute || [];
  if (!route.includes('route:approach') || !route.includes('route:donjon')) errors.push('protected-route');
  if (full && !route.includes('route:undercroft')) errors.push('protected-route-undercroft');
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
  const required = ['route:donjon', ...(full ? ['route:room', 'route:wallwalk', 'route:undercroft'] : [])];
  for (const id of required) if (!reached.has(id)) errors.push(`unreachable:${id}`);
  for (const id of route) if (!nodes.has(id)) errors.push(`protected-route-node:${id}`);

  if (!polygonContains(plan?.courtyard?.points || [], 0, 0)) errors.push('courtyard-origin');
  if (plan?.architectureHash && plan.architectureHash !== hashHex({ ...plan, architectureHash: undefined })) {
    errors.push('architecture-hash');
  }
  return { valid: errors.length === 0, errors, tier, footprint: { width: footprintWidth, depth: footprintDepth } };
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
  // A lone drum has already collapsed on its own — that is what its rim profile
  // says. Its historical event is the fall itself, so nothing further is removed
  // and the blocks simply lie where they came down on the ruined side.
  const runs = intact.curtain?.runs || [];
  const candidates = runs.filter((run) => {
    if (run.gateSide) return false;
    const midpoint = { x: (run.ax + run.bx) / 2, z: (run.az + run.bz) / 2 };
    return protectedNodes.every((node) => Math.hypot(node.x - midpoint.x, node.z - midpoint.z) > 5.5)
      && routeClearance(midpoint) > 4.8;
  });
  const target = candidates.length
    ? candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))]
    : runs.find((run) => !run.gateSide) || null;
  const removedPieceIds = target ? [target.id, `${target.id}:parapet`] : [];
  const fallBearing = intact.donjon.tallAngle + Math.PI;
  const mx = target ? (target.ax + target.bx) / 2
    : Math.cos(fallBearing) * intact.donjon.radius;
  const mz = target ? (target.az + target.bz) / 2
    : Math.sin(fallBearing) * intact.donjon.radius;
  const dx = target ? target.bx - target.ax : -Math.sin(fallBearing) * 6;
  const dz = target ? target.bz - target.az : Math.cos(fallBearing) * 6;
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
      id: `entropy:rubble:${index}`, sourcePieceId: target?.id || intact.donjon.id,
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
      id: 'entropy:event:0',
      kind: target ? 'curtain-breach' : 'tower-collapse',
      targetPieceId: target?.id || intact.donjon.id,
      cause: rng() < 0.5 ? 'foundation-failure' : 'long-weathering',
      cascadedPieceIds: target ? [`${target.id}:parapet`] : [],
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

/**
 * A drum as things you cannot walk through.
 *
 * Twelve arcs around the circle, capped at the height that actually survived at
 * each bearing, with the doorway arc left out. Capping at the rim matters: half
 * the drum is a two-course stub, and a full-height proxy there would be an
 * invisible wall standing over rubble you can see straight across.
 */
function towerSegments(tower) {
  const count = 12, result = [];
  const ruined = Number.isFinite(tower.courses) && Number.isFinite(tower.courseHeight);
  for (let index = 0; index < count; index++) {
    const a0 = index / count * TAU, a1 = (index + 1) / count * TAU;
    const middle = (a0 + a1) / 2;
    const doorDistance = tower.doorwayAngle === null || tower.doorwayAngle === undefined
      ? Infinity
      : Math.abs(Math.atan2(Math.sin(middle - tower.doorwayAngle), Math.cos(middle - tower.doorwayAngle)));
    // The rendered doorway is intentionally wider than one coarse arc, so a
    // body with a 0.34m radius never snags on the segments either side of it.
    if (doorDistance < 0.54) continue;
    // Where the rim says nothing is left standing, nothing blocks: you can see
    // straight over the rubble there, so an invisible wall would be a lie.
    const standing = ruined ? donjonRimCourses(tower, middle) : Infinity;
    if (standing < 0.35) continue;
    const maxY = ruined ? standing * tower.courseHeight : tower.height;
    result.push({
      id: `${tower.id}:collision:${index}`, sourcePieceId: tower.id,
      ax: tower.x + Math.cos(a0) * tower.radius, az: tower.z + Math.sin(a0) * tower.radius,
      bx: tower.x + Math.cos(a1) * tower.radius, bz: tower.z + Math.sin(a1) * tower.radius,
      minY: 0, maxY, thickness: 0.82,
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

  // The undercroft door is a hole in a bank, so it gets jambs you cannot walk
  // through and a genuinely open threshold between them.
  const undercroft = intact.undercroft;
  if (undercroft && !removed.has(undercroft.id)) {
    const c = Math.cos(undercroft.yaw), s = Math.sin(undercroft.yaw);
    for (const side of [-1, 1]) {
      const along = side * (undercroft.width / 2 + 0.32);
      const ax = undercroft.x + along * c + -0.5 * s;
      const az = undercroft.z - along * s + -0.5 * c;
      const bx = undercroft.x + along * c + 0.5 * s;
      const bz = undercroft.z - along * s + 0.5 * c;
      collisionProxies.push({
        id: `${undercroft.id}:collision:${side < 0 ? 'left' : 'right'}`,
        sourcePieceId: undercroft.id,
        ax, az, bx, bz,
        minY: undercroft.y, maxY: undercroft.y + undercroft.height + 0.8, thickness: 0.62,
      });
    }
  }

  const room = intact.room;
  const claims = [];
  if (room) claims.push({
    id: `${intact.id}:surface:room`, sourcePieceId: 'room:floor', kind: 'floor', mode: 'fixed', y: 0.12,
    shape: { kind: 'box', x: room.x, z: room.z, width: room.width - 0.7, depth: room.depth - 0.7, yaw: 0 },
    routeNodeIds: ['route:room-door', 'route:room'],
  });
  if (intact.ramp) claims.push({
    id: `${intact.id}:surface:ramp`, sourcePieceId: intact.ramp.id, kind: 'ramp', mode: 'ramp',
    ax: intact.ramp.ax, az: intact.ramp.az, ay: intact.ramp.ay,
    bx: intact.ramp.bx, bz: intact.ramp.bz, by: intact.ramp.by, width: intact.ramp.width,
    routeNodeIds: ['route:ramp-base', 'route:ramp-top'],
  });
  if (intact.landing) claims.push({
    id: `${intact.id}:surface:landing`, sourcePieceId: intact.landing.id, kind: 'landing',
    mode: 'fixed', y: intact.landing.y,
    shape: { kind: 'box', x: intact.landing.x, z: intact.landing.z, width: intact.landing.width, depth: intact.landing.depth, yaw: 0 },
    routeNodeIds: ['route:ramp-top', 'route:wallwalk'],
  });
  return deepFreeze({
    survivingPieces, renderPieces, collisionProxies,
    // recipes are the JSON-safe source of truth. Runtime adapters can attach
    // contains/height/normal functions without changing these records.
    walkableClaims: claims,
    walkableRecipes: claims,
    collisionRecipes: collisionProxies,
  });
}

/**
 * `options.undercroftBearing` comes from terrain: the stream probes the ground
 * around a site and hands back the direction with real cover behind it, because
 * a door into a bank has to be in a bank. Everything else about the plan is a
 * pure function of the seed.
 */
/**
 * Can you actually walk the protected route, given what is standing?
 *
 * The grammar places the hall, the ramp and the turrets clear of each other by
 * construction, but the undercroft's bearing comes from the hillside and can
 * land across a spur. Rather than let a keep publish a route with a wall in it,
 * the factory checks and re-rolls.
 */
function protectedRouteIsClear(intact, collisionProxies) {
  const nodes = new Map(intact.circulation.nodes.map((node) => [node.id, node]));
  const route = intact.circulation.protectedRoute;
  const reachOf = (proxy) => 0.34 + Math.max(0, Number(proxy.thickness) || 0) * 0.5;
  for (let index = 0; index < route.length - 1; index++) {
    const from = nodes.get(route[index]), to = nodes.get(route[index + 1]);
    if (!from || !to) return false;
    if (Math.hypot(to.x - from.x, to.z - from.z) <= 0.1) return false;
    for (let sample = 1; sample < 14; sample++) {
      const t = sample / 14;
      const point = { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t };
      const y = from.y + (to.y - from.y) * t;
      for (const proxy of collisionProxies) {
        if (y < proxy.minY - 0.2 || y > proxy.maxY + 0.2) continue;
        if (distanceToSegment(point, { x: proxy.ax, z: proxy.az }, { x: proxy.bx, z: proxy.bz })
          < reachOf(proxy)) return false;
      }
    }
  }
  return true;
}

// Nudges applied to the terrain-chosen undercroft bearing on later attempts.
// Half a radian either way is still the same face of the same hill, so the door
// keeps its bank while the bailey around it gets another arrangement.
const BEARING_NUDGES = Object.freeze([0, 0.26, -0.26, 0.52, -0.52, 0.78]);

export function createFortifiedOutpostPlan(seed = 1, options = {}) {
  if (seed && typeof seed === 'object') { options = seed; seed = seed.seed ?? 1; }
  seed = Number(seed) >>> 0;
  const bearing = Number.isFinite(options.undercroftBearing)
    ? Math.round(options.undercroftBearing * 1e4) / 1e4 : null;
  const reach = Number.isFinite(options.undercroftReach)
    ? Math.round(options.undercroftReach * 100) / 100 : null;
  const facing = Number.isFinite(options.undercroftFacing)
    ? Math.round(options.undercroftFacing * 1e4) / 1e4 : null;
  const key = `${seed >>> 0}:${FORTIFIED_OUTPOST_GENERATION_VERSION}:${options.tier || '-'}`
    + `:${bearing ?? '-'}:${reach ?? '-'}:${facing ?? '-'}`;
  if (PLAN_CACHE.has(key)) return PLAN_CACHE.get(key);
  let intact = null, validation = null, entropy = null, realization = null;
  for (let attempt = 0; attempt < BEARING_NUDGES.length; attempt++) {
    const candidate = buildIntact(seed >>> 0, attempt, {
      tier: options.tier,
      undercroftBearing: bearing === null ? undefined : bearing + BEARING_NUDGES[attempt],
      undercroftReach: reach === null ? undefined : reach,
      undercroftFacing: facing === null ? undefined : facing,
    });
    const report = validateFortifiedOutpostIntact(candidate);
    if (!report.valid) continue;
    const candidateEntropy = entropyFor(candidate);
    const candidateRealization = realize(candidate, candidateEntropy);
    if (!protectedRouteIsClear(candidate, candidateRealization.collisionProxies)) continue;
    intact = candidate; validation = report;
    entropy = candidateEntropy; realization = candidateRealization;
    break;
  }
  // The grammar is constructed to validate, but retain a deterministic minimal
  // retry rather than ever publishing an invalid structure after future edits.
  if (!intact) {
    intact = buildIntact(channel(seed, 'safe-fallback'), 0, { tier: options.tier });
    validation = validateFortifiedOutpostIntact(intact);
    if (!validation.valid) throw new Error(`Invalid fortified outpost: ${validation.errors.join(', ')}`);
    entropy = entropyFor(intact);
    realization = realize(intact, entropy);
  }
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
    tier: intact.tier,
    intact,
    entropy,
    ...realization,
    dungeonSeam: intact.dungeonSeam,
    diagnostics: {
      attempts: intact.attempt + 1, fallback: intact.seed !== (seed >>> 0), validation,
      tier: intact.tier,
      channels: { architecture: intact.channelSeeds.architecture, entropy: entropy.seed },
      entropyEvents: entropy.events.length,
      donjonPreserved: realization.survivingPieces.some((piece) => piece.id === 'tower:donjon'),
      undercroftOpen: !!intact.undercroft
        && realization.survivingPieces.some((piece) => piece.id === 'undercroft:door'),
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

/**
 * Where a trail should stop when it reaches a site: outside the gate at a walled
 * one, short of the drum's doorway at a lone tower. A trail that ends in the
 * middle of a bailey reads as a path someone abandoned.
 */
export function fortifiedOutpostGateLocal(seed, outside = 3) {
  const intact = createFortifiedOutpostPlan(seed).intact;
  const gate = intact.curtain?.gate;
  if (gate) return { x: gate.x + gate.outwardX * outside, z: gate.z + gate.outwardZ * outside };
  const door = intact.donjonDoor;
  const radius = Math.hypot(door.x, door.z) || 1;
  const reach = (radius + outside + 2) / radius;
  return { x: door.x * reach, z: door.z * reach };
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
  // The drum is the site. An entropy event that takes it away leaves nothing
  // for the world to have been built around, so it is never a valid target.
  if (!plan?.survivingPieces?.some((piece) => piece.id === 'tower:donjon')) errors.push('donjon-collapsed');
  if (plan?.intact?.tier === 'keep') {
    for (const id of ['wallwalk:landing', 'undercroft:door']) {
      if (!plan?.survivingPieces?.some((piece) => piece.id === id)) errors.push(`collapsed:${id}`);
    }
  }
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
