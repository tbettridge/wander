// Deterministic interior cave dressing: dripstone (stalactites, stalagmites,
// columns), breakdown rubble, deep-cave fungi, and near-entrance root falls.
// Purely visual — like hydrology, dressing never participates in collision.
// The planner is THREE-free so tests can audit placement (anchoring, route
// clearance, geology character, determinism) without a renderer, and the
// geometry builder emits the same triangle-soup layout the streamed blocks
// use (positions/normals/aSurface), so props render with the ONE cave
// material and inherit its palette, lighting, wet streaks and fog for free.

import { dungeonMasonryFor } from './fortifieddungeon.mjs';

export const CAVE_DRESSING_PROFILES = Object.freeze({
  limestone: Object.freeze({ dripstone: 1.00, rubble: 0.35, fungi: 0.50, roots: 0.80 }),
  cathedral: Object.freeze({ dripstone: 1.20, rubble: 0.30, fungi: 0.35, roots: 0.60 }),
  grotto: Object.freeze({ dripstone: 1.10, rubble: 0.25, fungi: 1.00, roots: 1.00 }),
  boulder: Object.freeze({ dripstone: 0.25, rubble: 1.00, fungi: 0.30, roots: 0.70 }),
  fracture: Object.freeze({ dripstone: 0.45, rubble: 0.60, fungi: 0.35, roots: 0.50 }),
  ice: Object.freeze({ dripstone: 0.90, rubble: 0.20, fungi: 0.00, roots: 0.10 }),
  volcanic: Object.freeze({ dripstone: 0.15, rubble: 0.70, fungi: 0.15, roots: 0.20 }),
});

// Roots only make sense where living things grow overhead.
const ROOT_BIOMES = new Set(['forest', 'taiga', 'jungle', 'grassland', 'savanna']);

// The guaranteed walking corridor: floor props stay outside it, and hanging
// props above it keep their tips out of head height.
const ROUTE_CLEARANCE = 2.0;
const HANG_HEADROOM = 2.4;

function hash32(value) {
  let h = value >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
function roll(seed, salt) { return hash32((seed >>> 0) ^ Math.imul(salt + 1, 0x9e3779b1)) / 4294967296; }
function mix(a, b, t) { return a + (b - a) * t; }
function clamp01(value) { return Math.max(0, Math.min(1, value)); }

export function caveDressingProfile(geology = 'limestone') {
  return CAVE_DRESSING_PROFILES[geology] || CAVE_DRESSING_PROFILES.limestone;
}

function sampledFloor(field, x, z, guess, radius = 5) {
  return field.floorHeightNear?.(x, z, guess, radius, radius) ?? field.floorHeight?.(x, z) ?? null;
}

// First air→rock crossing scanning UP from just above the floor.
function sampledCeiling(field, x, z, floorY, maxRise = 24) {
  const sdf = field.sdf;
  if (typeof sdf !== 'function') return null;
  const step = 0.30;
  let previous = sdf(x, floorY + 0.4, z);
  if (previous >= 0) return null;
  for (let rise = 0.4 + step; rise <= maxRise; rise += step) {
    const value = sdf(x, floorY + rise, z);
    if (value >= 0) {
      let lo = floorY + rise - step, hi = floorY + rise;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) * 0.5;
        if (sdf(x, mid, z) < 0) lo = mid;
        else hi = mid;
      }
      return lo;
    }
    previous = value;
  }
  return null;
}

function routeSegments(graph) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const segments = [];
  for (const edge of graph.edges) {
    const a = nodeById.get(edge.a)?.p, b = nodeById.get(edge.b)?.p;
    if (a && b) segments.push([a, b]);
  }
  return segments;
}

function routeDistance2(segments, x, z) {
  let best = Infinity;
  for (const [a, b] of segments) {
    const abx = b[0] - a[0], abz = b[2] - a[2];
    const denom = abx * abx + abz * abz || 1;
    const t = clamp01(((x - a[0]) * abx + (z - a[2]) * abz) / denom);
    best = Math.min(best, Math.hypot(x - (a[0] + abx * t), z - (a[2] + abz * t)));
  }
  return best;
}

/**
 * The keep's stones, underground.
 *
 * Blocks rather than props: a threshold slab at each junction, piers standing
 * either side of a passage, a door arch at the mouth, and whatever the chamber
 * is for — a well shaft, a burial recess, a footing under a tower. Each carries
 * the floor it stands on, sampled from the field, so nothing floats in a
 * passage the terrain fit moved.
 */
function dungeonMasonryDressing(graph, field, options) {
  let masonry = null;
  try {
    masonry = dungeonMasonryFor(graph, {
      seed: (graph?.sourceSeed ?? graph?.seed ?? 1) >>> 0,
      entranceFamily: options.entranceFamily || null,
    });
  } catch (error) {
    // A graph the programme grammar cannot read is still a walkable cave. An
    // undressed undercroft is a far better outcome than no undercroft.
    return { available: false, reason: error.message, blocks: [], lines: [] };
  }
  const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
  const blocks = [];
  for (const piece of masonry.pieces) {
    if (piece.kind === 'chamber-shell' || piece.kind === 'masonry-passage'
      || piece.kind === 'masonry-branch' || piece.kind === 'masonry-loop') continue;
    if (!Number.isFinite(piece.width) || !Number.isFinite(piece.height)) continue;
    if (!Number.isFinite(piece.x) || !Number.isFinite(piece.z)) continue;
    const floorY = sampledFloor(field, piece.x, piece.z, finite(piece.y), 3.5);
    if (!Number.isFinite(floorY)) continue;
    // Pieces authored relative to a passage floor keep their offset from it;
    // the field, not the graph, decides where that floor ended up. Anything the
    // grammar left unresolved sits on the floor rather than at NaN — one piece
    // with a NaN height poisons the whole merged buffer and the cave never
    // finishes streaming.
    const lift = finite(piece.y) - finite(piece.floorY, finite(piece.y));
    blocks.push({
      id: piece.id, kind: piece.kind,
      x: piece.x, y: floorY + Math.max(0, finite(lift)), z: piece.z,
      width: piece.width, height: piece.height,
      depth: finite(piece.depth, piece.width),
      yaw: finite(piece.yaw),
      weathering: finite(piece.weatheringIntensity,
        finite(masonry.weathering?.intensity, 0.4)),
    });
  }
  return {
    available: true,
    program: masonry.program,
    weathering: masonry.weathering,
    blocks,
    // Wall faces either side of each passage, as line records the geometry
    // builder walks into courses.
    lines: masonry.passageLines.map((line) => ({
      id: line.id, ax: line.ax, az: line.az, bx: line.bx, bz: line.bz,
      minY: line.minY, maxY: line.maxY, thickness: line.thickness,
    })),
  };
}

export function buildCaveDressingPlan(graph, field, hydrology, options = {}) {
  const geology = graph?.geology || 'limestone';
  const profile = caveDressingProfile(geology);
  // An undercroft is a cave someone built in. Nothing grows in it: instead of
  // dripstone and fungus it is dressed with the keep's own masonry, cut from
  // the same programme grammar that decided whether it is a cellar or a crypt.
  if (options.mode === 'dungeon' || options.suppressNaturalDressing || graph?.mode === 'dungeon'
    || graph?.dressingSuppressed) {
    return {
      mode: 'dungeon', suppressed: true, geology, profile,
      stalactites: [], stalagmites: [], columns: [], rubble: [], fungi: [], roots: [],
      masonry: dungeonMasonryDressing(graph, field, options),
    };
  }
  const seed = (graph?.seed ?? 1) >>> 0;
  const mouth = graph.entrance.mouth;
  const segments = routeSegments(graph);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const surfaceAt = typeof field.surfaceAt === 'function' ? field.surfaceAt : null;

  const stalactites = [], stalagmites = [], columns = [];
  const rubble = [], fungi = [], roots = [];

  // --- dripstone grows where water drips ------------------------------------
  const drips = hydrology?.drips || [];
  for (let index = 0; index < drips.length; index++) {
    const drip = drips[index];
    if (roll(seed, index * 7 + 11) > profile.dripstone) continue;
    const gap = drip.top - drip.bottom;
    if (gap < 2.6) continue;
    const clearance = routeDistance2(segments, drip.x, drip.z);
    const inCorridor = clearance < ROUTE_CLEARANCE;
    const columnRoll = roll(seed, index * 13 + 41);
    if (!inCorridor && columnRoll < 0.20 * profile.dripstone) {
      // full floor-to-ceiling flowstone pillar — girth grows with the climb
      columns.push({
        x: drip.x, z: drip.z, top: drip.top, bottom: drip.bottom,
        radius: mix(0.20, 0.42, roll(seed, index * 17 + 71)) + gap * 0.035,
        seed: hash32(seed ^ (index * 2654435761)),
      });
      continue;
    }
    // stalactite: cap its reach so tips over the walking corridor keep
    // headroom; elsewhere it may reach most of the way down
    const maxReach = inCorridor
      ? Math.max(0.35, gap - HANG_HEADROOM)
      : gap * 0.55;
    const length = Math.min(mix(0.5, 2.4, roll(seed, index * 19 + 101)), maxReach);
    if (length >= 0.32) {
      stalactites.push({
        x: drip.x, z: drip.z, top: drip.top, length,
        radius: mix(0.12, 0.32, roll(seed, index * 23 + 131)),
        seed: hash32(seed ^ (index * 40503)),
      });
    }
    if (!inCorridor && roll(seed, index * 29 + 161) < 0.6 * profile.dripstone) {
      stalagmites.push({
        x: drip.x + (roll(seed, index * 31 + 191) - 0.5) * 0.5,
        z: drip.z + (roll(seed, index * 37 + 211) - 0.5) * 0.5,
        bottom: drip.bottom - 0.12,
        height: mix(0.30, 1.15, roll(seed, index * 41 + 241)),
        radius: mix(0.18, 0.42, roll(seed, index * 43 + 271)),
        seed: hash32(seed ^ (index * 65537)),
      });
    }
  }

  // --- extra ceiling dripstone along wet passages ---------------------------
  let edgeSalt = 500;
  for (let edgeIndex = 0; edgeIndex < graph.edges.length; edgeIndex++) {
    const edge = graph.edges[edgeIndex];
    const a = nodeById.get(edge.a)?.p, b = nodeById.get(edge.b)?.p;
    if (!a || !b) continue;
    const tries = Math.round(2 * profile.dripstone);
    for (let attempt = 0; attempt < tries; attempt++) {
      edgeSalt += 7;
      const t = 0.2 + roll(seed, edgeSalt) * 0.6;
      const side = (roll(seed, edgeSalt + 1) - 0.5) * 3.4;
      const abx = b[0] - a[0], abz = b[2] - a[2];
      const len = Math.hypot(abx, abz) || 1;
      const x = a[0] + abx * t - (abz / len) * side;
      const z = a[2] + abz * t + (abx / len) * side;
      const guessY = a[1] + (b[1] - a[1]) * t;
      const floor = sampledFloor(field, x, z, guessY - 3, 6);
      if (floor === null) continue;
      const ceiling = sampledCeiling(field, x, z, floor);
      if (ceiling === null || ceiling - floor < 2.8) continue;
      const semantics = surfaceAt ? surfaceAt(x, ceiling - 0.2, z) : { wet: 0.5 };
      if (semantics.wet < 0.38) continue;
      const clearance = routeDistance2(segments, x, z);
      const inCorridor = clearance < ROUTE_CLEARANCE;
      const gap = ceiling - floor;
      const maxReach = inCorridor ? Math.max(0.3, gap - HANG_HEADROOM) : gap * 0.5;
      const length = Math.min(mix(0.4, 1.8, roll(seed, edgeSalt + 2)), maxReach);
      if (length < 0.3) continue;
      stalactites.push({
        x, z, top: ceiling, length,
        radius: mix(0.10, 0.26, roll(seed, edgeSalt + 3)),
        seed: hash32(seed ^ (edgeSalt * 977)),
      });
    }
  }

  // --- breakdown rubble under fractured ceilings ----------------------------
  let rubbleSalt = 2000;
  for (let chamberIndex = 0; chamberIndex < graph.chambers.length; chamberIndex++) {
    const chamber = graph.chambers[chamberIndex];
    const bowlBoost = chamber.form === 'bowl' ? 1.8 : 1;
    const tries = Math.round(6 * profile.rubble * bowlBoost);
    for (let attempt = 0; attempt < tries; attempt++) {
      rubbleSalt += 11;
      const angle = roll(seed, rubbleSalt) * Math.PI * 2;
      const radial = (0.25 + roll(seed, rubbleSalt + 1) * 0.55) * Math.min(chamber.r[0], chamber.r[2]);
      const x = chamber.c[0] + Math.cos(angle) * radial;
      const z = chamber.c[2] + Math.sin(angle) * radial;
      if (routeDistance2(segments, x, z) < ROUTE_CLEARANCE) continue;
      const floor = sampledFloor(field, x, z, chamber.floorY ?? chamber.c[1] - chamber.r[1], chamber.r[1] + 2);
      if (floor === null) continue;
      const semantics = surfaceAt ? surfaceAt(x, floor + 0.3, z) : { fracture: 0.5 };
      if (semantics.fracture < 0.17 && bowlBoost === 1) continue;
      rubble.push({
        x, z, bottom: floor - 0.10,
        radius: mix(0.22, 0.62, roll(seed, rubbleSalt + 2)),
        seed: hash32(seed ^ (rubbleSalt * 1231)),
      });
    }
  }

  // --- fungi in the damp deeps ----------------------------------------------
  let fungiSalt = 4000;
  if (profile.fungi > 0.001) {
    for (let chamberIndex = 0; chamberIndex < graph.chambers.length; chamberIndex++) {
      const chamber = graph.chambers[chamberIndex];
      const depth = Math.hypot(chamber.c[0] - mouth[0], chamber.c[1] - mouth[1], chamber.c[2] - mouth[2]);
      if (depth < 24) continue;
      const tries = Math.round(3 * profile.fungi);
      for (let attempt = 0; attempt < tries; attempt++) {
        fungiSalt += 13;
        const angle = roll(seed, fungiSalt) * Math.PI * 2;
        const radial = (0.30 + roll(seed, fungiSalt + 1) * 0.50) * Math.min(chamber.r[0], chamber.r[2]);
        const x = chamber.c[0] + Math.cos(angle) * radial;
        const z = chamber.c[2] + Math.sin(angle) * radial;
        if (routeDistance2(segments, x, z) < 1.6) continue;
        const floor = sampledFloor(field, x, z, chamber.floorY ?? chamber.c[1] - chamber.r[1], chamber.r[1] + 2);
        if (floor === null) continue;
        const semantics = surfaceAt ? surfaceAt(x, floor + 0.2, z) : { wet: 0.6 };
        if (semantics.wet < 0.42) continue;
        const cluster = 3 + Math.floor(roll(seed, fungiSalt + 2) * 4);
        for (let cap = 0; cap < cluster; cap++) {
          const capAngle = roll(seed, fungiSalt + 3 + cap) * Math.PI * 2;
          const capRadial = roll(seed, fungiSalt + 9 + cap) * 0.55;
          const capX = x + Math.cos(capAngle) * capRadial;
          const capZ = z + Math.sin(capAngle) * capRadial;
          if (routeDistance2(segments, capX, capZ) < 1.6) continue;
          const capFloor = sampledFloor(field, capX, capZ, floor, 2) ?? floor;
          fungi.push({
            x: capX, z: capZ, bottom: capFloor,
            radius: mix(0.06, 0.19, roll(seed, fungiSalt + 15 + cap)),
            glow: 0.5 + roll(seed, fungiSalt + 21 + cap) * 0.5,
            seed: hash32(seed ^ ((fungiSalt + cap) * 2246822519)),
          });
        }
      }
    }
  }

  // --- roots reach through the ceiling near the entrance --------------------
  let rootSalt = 6000;
  const biome = options.biome || 'forest';
  if (profile.roots > 0.001 && ROOT_BIOMES.has(biome)) {
    const tries = Math.round(5 * profile.roots);
    for (let attempt = 0; attempt < tries; attempt++) {
      rootSalt += 17;
      const along = 2 + roll(seed, rootSalt) * 16;      // metres inward of mouth
      const side = (roll(seed, rootSalt + 1) - 0.5) * 4.2;
      const x = mouth[0] + side;
      const z = mouth[2] + along;
      const floor = sampledFloor(field, x, z, mouth[1] - 2, 7);
      if (floor === null) continue;
      const ceiling = sampledCeiling(field, x, z, floor);
      if (ceiling === null || ceiling - floor < 2.7) continue;
      const clearance = routeDistance2(segments, x, z);
      const inCorridor = clearance < ROUTE_CLEARANCE;
      const gap = ceiling - floor;
      const maxReach = inCorridor ? Math.max(0.4, gap - HANG_HEADROOM) : gap * 0.7;
      const length = Math.min(mix(0.8, 2.2, roll(seed, rootSalt + 2)), maxReach);
      if (length < 0.4) continue;
      roots.push({
        x, z, top: ceiling, length,
        strands: 3 + Math.floor(roll(seed, rootSalt + 3) * 3),
        seed: hash32(seed ^ (rootSalt * 48271)),
      });
    }
  }

  // Drop ceiling-hung props where the entrance cut has removed the roof above
  // them: without this they dangle in the open mouth, visible from outside with
  // nothing overhead. Floor props (stalagmites, rubble, fungi) sit on the
  // throat floor and stay. The predicate is supplied by the host (cave.js),
  // which alone knows the terrain-cut footprint; tests omit it (no filtering).
  const exposedAt = typeof options.exposedAt === 'function' ? options.exposedAt : null;
  if (exposedAt) {
    const rooted = (p) => !exposedAt(p.x, p.z);
    return {
      geology, profile,
      stalactites: stalactites.filter(rooted),
      stalagmites,
      columns: columns.filter(rooted),
      rubble, fungi,
      roots: roots.filter(rooted),
    };
  }

  return { geology, profile, stalactites, stalagmites, columns, rubble, fungi, roots };
}

// --- geometry ----------------------------------------------------------------
// Flat-shaded triangle soup matching the faceted look of the streamed blocks.

function pushTriangle(out, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) return;                       // degenerate — skip silently
  nx /= len; ny /= len; nz /= len;
  out.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  out.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
}

// A smooth, rounded taper. sign=-1 hangs down from (x, y, z); sign=+1 grows up.
// roundness in [0,1] blends a straight cone (0) with a domed ellipsoid (1), so
// higher values give convex, bulbous flanks and a blunt, rounded tip instead of
// a needle. A single gentle lean — applied as t², not per-ring jitter — keeps
// forms organic without the zig-zag "bent" look; plenty of sides and rings keep
// the silhouette smooth.
function spikeGeometry(out, x, y, z, length, radius, sign, seed, sides = 9, rings = 6, roundness = 0.72) {
  const leanX = (roll(seed, 1) - 0.5) * radius * 0.5;
  const leanZ = (roll(seed, 2) - 0.5) * radius * 0.5;
  const ringPoints = [];
  for (let ring = 0; ring <= rings; ring++) {
    const t = ring / rings;
    const cone = 1 - t;
    const dome = Math.sqrt(Math.max(0, 1 - t * t));
    const r = radius * mix(cone, dome, roundness) * (0.96 + roll(seed, ring + 3) * 0.08);
    const cx = x + leanX * t * t;
    const cz = z + leanZ * t * t;
    const level = [];
    for (let side = 0; side < sides; side++) {
      const angle = (side / sides) * Math.PI * 2;
      level.push([cx + Math.cos(angle) * r, y + sign * length * t, cz + Math.sin(angle) * r]);
    }
    ringPoints.push(level);
  }
  for (let ring = 0; ring < rings; ring++) {
    const lower = ringPoints[ring], upper = ringPoints[ring + 1];
    const apex = ring + 1 === rings;            // final ring collapses to the tip
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      const a = lower[side], b = lower[next], c = upper[side], d = upper[next];
      if (sign < 0) {
        pushTriangle(out, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        if (!apex) pushTriangle(out, b[0], b[1], b[2], d[0], d[1], d[2], c[0], c[1], c[2]);
      } else {
        pushTriangle(out, a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
        if (!apex) pushTriangle(out, b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
      }
    }
  }
}

// Flowstone column: a rounded barrel — flared where it fuses into the floor and
// ceiling, gently waisted in the middle. No pinched hourglass point.
function columnGeometry(out, column) {
  const sides = 10, rings = 8;
  const y0 = column.bottom - 0.1, y1 = column.top + 0.1;   // embed into rock
  const ringPoints = [];
  for (let ring = 0; ring <= rings; ring++) {
    const t = ring / rings;
    const waist = 1 - 0.26 * Math.sin(Math.PI * t);         // dip to ~0.74R mid
    const flare = 1 + 0.35 * (Math.pow(1 - t, 4) + Math.pow(t, 4)); // widen at both ends
    const r = column.radius * waist * flare * (0.97 + roll(column.seed, ring + 5) * 0.06);
    const y = mix(y0, y1, t);
    const level = [];
    for (let side = 0; side < sides; side++) {
      const angle = (side / sides) * Math.PI * 2;
      level.push([column.x + Math.cos(angle) * r, y, column.z + Math.sin(angle) * r]);
    }
    ringPoints.push(level);
  }
  for (let ring = 0; ring < rings; ring++) {
    const lower = ringPoints[ring], upper = ringPoints[ring + 1];
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      const a = lower[side], b = lower[next], c = upper[side], d = upper[next];
      pushTriangle(out, a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
      pushTriangle(out, b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    }
  }
}

// Rounded low-poly boulder: a squashed sphere with gentle facet jitter. Pole
// triangles collapse and are dropped by the degenerate guard.
function rockGeometry(out, x, y, z, radius, seed) {
  const sides = 7, rings = 4;
  const jitter = (salt) => 0.86 + roll(seed, salt) * 0.28;
  const ringPoints = [];
  for (let ring = 0; ring <= rings; ring++) {
    const phi = (ring / rings) * Math.PI;               // 0 (bottom) → PI (top)
    const rr = Math.sin(phi) * radius;
    const yy = y - Math.cos(phi) * radius * 0.7;         // squashed vertically
    const level = [];
    for (let side = 0; side < sides; side++) {
      const angle = (side / sides) * Math.PI * 2;
      const j = jitter(ring * 7 + side + 10);
      level.push([x + Math.cos(angle) * rr * j, yy, z + Math.sin(angle) * rr * j]);
    }
    ringPoints.push(level);
  }
  for (let ring = 0; ring < rings; ring++) {
    const lower = ringPoints[ring], upper = ringPoints[ring + 1];
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      const a = lower[side], b = lower[next], c = upper[side], d = upper[next];
      pushTriangle(out, a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
      pushTriangle(out, b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    }
  }
}

// Shared mushroom proportions, so the geometry and the glow anchor agree.
function fungusMetrics(f) {
  const stemH = f.radius * (1.2 + roll(f.seed, 1) * 0.8);
  const capH = f.radius * 0.85;
  const capBase = f.bottom + stemH * 0.82;
  return { stemH, capH, capBase, crownY: capBase + capH };
}

// Small mushroom: smooth tapered stem + rounded, domed cap.
function fungusGeometry(out, fungus) {
  const { stemH, capH, capBase } = fungusMetrics(fungus);
  const x = fungus.x, z = fungus.z, base = fungus.bottom;
  spikeGeometry(out, x, base, z, stemH, fungus.radius * 0.32, 1, fungus.seed, 7, 4, 0.5);
  // Domed cap: rings sweeping a quarter-circle from the rim up to a rounded crown.
  const capR = fungus.radius, sides = 9, capRings = 3;
  const ringPoints = [];
  for (let ring = 0; ring <= capRings; ring++) {
    const t = ring / capRings;
    const r = capR * Math.cos(t * Math.PI * 0.5);
    const yy = capBase + capH * Math.sin(t * Math.PI * 0.5);
    const level = [];
    for (let side = 0; side < sides; side++) {
      const angle = (side / sides) * Math.PI * 2;
      level.push([x + Math.cos(angle) * r, yy, z + Math.sin(angle) * r]);
    }
    ringPoints.push(level);
  }
  for (let ring = 0; ring < capRings; ring++) {
    const lower = ringPoints[ring], upper = ringPoints[ring + 1];
    const apex = ring + 1 === capRings;
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      const a = lower[side], b = lower[next], c = upper[side], d = upper[next];
      pushTriangle(out, a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
      if (!apex) pushTriangle(out, b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    }
  }
}

// Root fall: several thin, smoothly drooping strands from one ceiling anchor.
function rootGeometry(out, root) {
  for (let strand = 0; strand < root.strands; strand++) {
    const offsetX = (roll(root.seed, strand * 5 + 1) - 0.5) * 0.7;
    const offsetZ = (roll(root.seed, strand * 5 + 2) - 0.5) * 0.7;
    const length = root.length * (0.55 + roll(root.seed, strand * 5 + 3) * 0.45);
    spikeGeometry(
      out,
      root.x + offsetX, root.top, root.z + offsetZ,
      length, 0.05 + roll(root.seed, strand * 5 + 4) * 0.05,
      -1, hash32(root.seed ^ (strand * 7919)), 6, 5, 0.4,
    );
  }
}

// --- masonry ----------------------------------------------------------------
// Built stone, for an undercroft. The same triangle-soup output as every other
// prop here, so the keep's cellar renders with the one cave material and picks
// up its lighting, wet streaks and fog exactly as the rock around it does.

function pushBox(out, cx, cy, cz, halfW, halfH, halfD, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const corner = (sx, sy, sz) => {
    const x = sx * halfW, z = sz * halfD;
    return [cx + x * c + z * s, cy + sy * halfH, cz - x * s + z * c];
  };
  const v = [
    corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1),
    corner(-1, 1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(-1, 1, 1),
  ];
  const quad = (a, b, cc, d) => {
    pushTriangle(out, ...v[a], ...v[b], ...v[cc]);
    pushTriangle(out, ...v[a], ...v[cc], ...v[d]);
  };
  quad(4, 5, 6, 7);   // top
  quad(3, 2, 1, 0);   // bottom
  quad(0, 1, 5, 4);   // -z
  quad(2, 3, 7, 6);   // +z
  quad(1, 2, 6, 5);   // +x
  quad(3, 0, 4, 7);   // -x
}

// A passage wall face, laid in courses rather than as one slab: a lined cellar
// wall reads as built only if you can see the individual stones in it.
const MASONRY_COURSE = 0.52;
const MASONRY_BLOCK = 0.86;
// How far up a passage gets lined. Above this the rock it was cut into shows,
// which is what an undercroft actually looks like.
const MASONRY_LINING_RISE = 2.6;

function masonryWallSoup(out, line, field, seed) {
  const dx = line.bx - line.ax, dz = line.bz - line.az;
  const runLength = Math.hypot(dx, dz);
  if (runLength < 0.5) return 0;
  const yaw = Math.atan2(dx, dz);
  const blocks = Math.max(1, Math.round(runLength / (MASONRY_BLOCK * 0.86)));
  const courses = Math.max(1, Math.round(MASONRY_LINING_RISE / MASONRY_COURSE));
  let laid = 0;
  for (let k = 0; k < blocks; k++) {
    const t = (k + 0.5) / blocks;
    const x = line.ax + dx * t, z = line.az + dz * t;
    const floorY = sampledFloor(field, x, z, (line.minY + line.maxY) * 0.5, 3.0);
    if (floorY === null || !Number.isFinite(floorY)) continue;
    for (let course = 0; course < courses; course++) {
      // Running bond: alternate courses step half a block along the run, or the
      // joints line up and it reads as a grid rather than a wall.
      const offset = (course % 2) * 0.5 / blocks;
      const tc = t + offset;
      if (tc > 1) continue;
      const bx = line.ax + dx * tc, bz = line.az + dz * tc;
      const y = floorY + course * MASONRY_COURSE + MASONRY_COURSE * 0.5;
      if (y > line.maxY) break;
      const jitter = roll(seed, k * 31 + course * 7) - 0.5;
      pushBox(out, bx, y, bz,
        MASONRY_BLOCK * (0.5 + jitter * 0.06), MASONRY_COURSE * 0.48,
        (line.thickness || 0.45) * 0.5, yaw + jitter * 0.04);
      laid++;
    }
  }
  return laid;
}

export function buildCaveDressingGeometry(plan, field) {
  const out = { positions: [], normals: [] };
  const propRanges = [];
  const mark = (kind, anchorX, anchorY, anchorZ) => {
    propRanges.push({ kind, from: out.positions.length, anchorX, anchorY, anchorZ });
  };
  for (const s of plan.stalactites) {
    mark('stalactite', s.x, s.top - 0.2, s.z);
    spikeGeometry(out, s.x, s.top, s.z, s.length, s.radius, -1, s.seed, 9, 6, 0.72);
  }
  for (const s of plan.stalagmites) {
    mark('stalagmite', s.x, s.bottom + 0.2, s.z);
    spikeGeometry(out, s.x, s.bottom, s.z, s.height, s.radius, 1, s.seed, 9, 6, 0.9);
  }
  for (const c of plan.columns) {
    mark('column', c.x, (c.top + c.bottom) / 2, c.z);
    columnGeometry(out, c);
  }
  for (const r of plan.rubble) {
    mark('rubble', r.x, r.bottom + r.radius * 0.4, r.z);
    rockGeometry(out, r.x, r.bottom + r.radius * 0.35, r.z, r.radius, r.seed);
  }
  for (const f of plan.fungi) {
    mark('fungus', f.x, f.bottom + 0.15, f.z);
    fungusGeometry(out, f);
  }
  for (const r of plan.roots) {
    mark('root', r.x, r.top - 0.3, r.z);
    rootGeometry(out, r);
  }
  if (plan.masonry?.available) {
    const seed = (plan.masonry.program?.architectureSeed ?? 1) >>> 0;
    for (const block of plan.masonry.blocks) {
      mark('masonry', block.x, block.y, block.z);
      pushBox(out, block.x, block.y + block.height * 0.5, block.z,
        block.width * 0.5, block.height * 0.5, block.depth * 0.5, block.yaw);
    }
    // A cap on the lining, not on the built pieces: an unusually branchy graph
    // should lose wall face, never its door arch or its crypt recess.
    let laid = 0;
    for (const line of plan.masonry.lines) {
      if (laid > 3200) break;
      mark('masonry', (line.ax + line.bx) * 0.5, line.minY, (line.az + line.bz) * 0.5);
      laid += masonryWallSoup(out, line, field, seed);
    }
  }
  const positions = new Float32Array(out.positions);
  const normals = new Float32Array(out.normals);
  // Per-prop semantic classification: one field lookup per prop, spread to its
  // vertices — a stalactite wears its ceiling's wetness and mineral character.
  const vertexCount = positions.length / 3;
  const surfaces = new Uint8Array(vertexCount * 4);
  const surfaceAt = typeof field?.surfaceAt === 'function' ? field.surfaceAt : null;
  for (let range = 0; range < propRanges.length; range++) {
    const info = propRanges[range];
    const end = range + 1 < propRanges.length ? propRanges[range + 1].from : out.positions.length;
    let wet = 0.35, sediment = 0.3, mineral = 0.3, fracture = 0.2;
    if (surfaceAt) {
      const s = surfaceAt(info.anchorX, info.anchorY, info.anchorZ);
      wet = s.wet; sediment = s.sediment; mineral = s.mineral; fracture = s.fracture;
    }
    if (info.kind === 'stalactite' || info.kind === 'stalagmite' || info.kind === 'column') {
      mineral = Math.min(1, mineral + 0.35);            // dripstone is flowstone
      wet = Math.min(1, wet + 0.2);
    } else if (info.kind === 'fungus') {
      wet = Math.min(1, wet + 0.3); mineral *= 0.4; fracture *= 0.3;
    } else if (info.kind === 'rubble') {
      fracture = Math.min(1, fracture + 0.4);
    } else if (info.kind === 'root') {
      wet *= 0.7; mineral *= 0.25; sediment = Math.min(1, sediment + 0.4);
    } else if (info.kind === 'masonry') {
      // Cut stone, not the rock around it: dry, even, and without the mineral
      // bloom that dripstone gets. What it does pick up is the wall's fracture,
      // because a wall built into a shattered face weathers with it.
      wet *= 0.55; mineral *= 0.35; sediment = Math.min(1, sediment + 0.2);
      fracture = Math.min(1, fracture * 0.6 + 0.15);
    }
    for (let v = info.from / 3; v < end / 3; v++) {
      surfaces[v * 4] = Math.round(wet * 255);
      surfaces[v * 4 + 1] = Math.round(sediment * 255);
      surfaces[v * 4 + 2] = Math.round(mineral * 255);
      surfaces[v * 4 + 3] = Math.round(fracture * 255);
    }
  }
  // Fungi glow anchor points for the additive accent pass. Anchored at the cap
  // crown (not the stem base) so the halo sits above the cap it lights rather
  // than being hidden behind it — which lets the glow keep depth-testing and so
  // stay correctly occluded by cave walls.
  const glowPoints = [];
  for (const f of plan.fungi) {
    const { crownY } = fungusMetrics(f);
    glowPoints.push(f.x, crownY + f.radius * 0.12, f.z, f.glow);
  }
  return {
    positions, normals, surfaces,
    triangles: vertexCount / 3,
    glowPoints: new Float32Array(glowPoints),
  };
}
