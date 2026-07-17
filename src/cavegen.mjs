// Phase-1 deterministic cave placement and topology grammar. THREE-free so it
// can run in tests, workers, and the main thread without representation drift.

export const CAVE_CELL_SIZE = 2200;
export const CAVE_CELL_PRESENCE = 0.34;
const ENTRANCE_MARGIN = 330;

function mix(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export function caveHash(...values) {
  let h = 2166136261;
  for (const value of values) {
    h ^= value | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return () => {
    let t = seed += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BIOME_WEIGHT = {
  ocean: 0, beach: 0, jungle: 0.18, grassland: 0.40, savanna: 0.42,
  forest: 0.54, desert: 0.68, taiga: 0.78, tundra: 0.94, snow: 0.84,
};

export function scoreCaveEntrance(world, x, z, orientationSeed = 0) {
  const biome = world.biomeAt(x, z);
  const e = 12;
  const gx = (world.height(x + e, z) - world.height(x - e, z)) / (2 * e);
  const gz = (world.height(x, z + e) - world.height(x, z - e)) / (2 * e);
  const gradient = Math.hypot(gx, gz);
  const fallbackAngle = (orientationSeed / 4294967296) * Math.PI * 2;
  const inwardX = gradient > 1e-5 ? gx / gradient : Math.sin(fallbackAngle);
  const inwardZ = gradient > 1e-5 ? gz / gradient : Math.cos(fallbackAngle);
  const yaw = Math.atan2(inwardX, inwardZ);
  const coverRise = world.height(x + inwardX * 38, z + inwardZ * 38) - biome.h;

  let wetNearby = false;
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI * 0.25;
    const river = world.riverAt(x + Math.cos(a) * 30, z + Math.sin(a) * 30);
    if (river.wet) { wetNearby = true; break; }
  }

  const biomeWeight = BIOME_WEIGHT[biome.id] ?? 0.25;
  const altitudeScore = smoothstep(28, 150, biome.h) * (1 - smoothstep(360, 520, biome.h));
  const slopeScore = smoothstep(0.045, 0.16, biome.slope) * (1 - smoothstep(0.36, 0.56, biome.slope));
  const coverScore = smoothstep(1.5, 13, coverRise);
  const score = altitudeScore * 0.28 + slopeScore * 0.32 + coverScore * 0.25 + biomeWeight * 0.15;

  const reasons = [];
  if (biomeWeight <= 0) reasons.push(`unsuitable ${biome.id}`);
  if (biome.h < 22) reasons.push('too close to sea level');
  if (biome.slope < 0.035) reasons.push('no readable rock face');
  if (biome.slope > 0.58) reasons.push('cliff approach too steep');
  if (coverRise < 1.25) reasons.push('insufficient uphill cover');
  if (wetNearby) reasons.push('river or wet channel nearby');
  if (score < 0.43) reasons.push('low suitability score');

  return {
    x, z, surfaceY: biome.h, biome: biome.id, slope: biome.slope,
    score, valid: reasons.length === 0, reasons, yaw, inwardX, inwardZ,
    coverRise, wetNearby,
  };
}

// At most one canonical candidate belongs to a macro-cell. Several nearby
// deterministic probes let the cell select a credible face without increasing
// cave density or losing cross-chunk ownership.
export function caveAnchorForCell(world, cellX, cellZ, worldSeed) {
  const seed = caveHash(worldSeed, cellX, cellZ, 0x43415645);
  const rng = mulberry32(seed);
  if (rng() > CAVE_CELL_PRESENCE) return null;

  const span = CAVE_CELL_SIZE - ENTRANCE_MARGIN * 2;
  const baseX = cellX * CAVE_CELL_SIZE + ENTRANCE_MARGIN + rng() * span;
  const baseZ = cellZ * CAVE_CELL_SIZE + ENTRANCE_MARGIN + rng() * span;
  let best = null;
  for (let i = 0; i < 7; i++) {
    const radius = i === 0 ? 0 : 70 + rng() * 190;
    const angle = rng() * Math.PI * 2;
    const x = baseX + Math.cos(angle) * radius;
    const z = baseZ + Math.sin(angle) * radius;
    const candidate = scoreCaveEntrance(world, x, z, caveHash(seed, i));
    if (!best || candidate.score > best.score) best = candidate;
  }

  return {
    ...best,
    id: `cave:${cellX}:${cellZ}`,
    key: `${cellX}_${cellZ}`,
    cellX, cellZ, seed,
  };
}

export function caveAnchorsAround(world, px, pz, worldSeed, radius, out = [], includeRejected = false) {
  out.length = 0;
  const x0 = Math.floor((px - radius) / CAVE_CELL_SIZE);
  const x1 = Math.floor((px + radius) / CAVE_CELL_SIZE);
  const z0 = Math.floor((pz - radius) / CAVE_CELL_SIZE);
  const z1 = Math.floor((pz + radius) / CAVE_CELL_SIZE);
  for (let cellZ = z0; cellZ <= z1; cellZ++) {
    for (let cellX = x0; cellX <= x1; cellX++) {
      const anchor = caveAnchorForCell(world, cellX, cellZ, worldSeed);
      if (!anchor || (!includeRejected && !anchor.valid)) continue;
      const dx = anchor.x - px, dz = anchor.z - pz;
      if (dx * dx + dz * dz <= radius * radius) out.push(anchor);
    }
  }
  out.sort((a, b) => {
    const da = (a.x - px) ** 2 + (a.z - pz) ** 2;
    const db = (b.x - px) ** 2 + (b.z - pz) ** 2;
    return da - db || a.id.localeCompare(b.id);
  });
  return out;
}


// Phase 2 deterministic topology grammar. V3 scales the network to the
// region-plan targets: 150–400 m of traversable passage, 12–30 nodes,
// 5–10 chambers, 2–4 branch arms of 2–3 nodes, and occasional loops outside
// the circuit archetype (rolled only when the branch budget landed on its
// minimum, which keeps the worst-case total length under the 400 m ceiling).
export const CAVE_GRAPH_VERSION = 4;
export const CAVE_ARCHETYPES = Object.freeze(['gallery', 'branching', 'circuit', 'descent']);

const ARCHETYPE_SPEC = Object.freeze({
  gallery: Object.freeze({
    spine: [11, 13], length: [13.0, 15.8], turn: 0.18, grade: [0.065, 0.095],
    branches: [2, 3], branchNodes: [2, 3], loops: 0, loopChance: 0.30,
    chambers: [6, 8], vertical: [10, 22], levels: [1, 2],
  }),
  branching: Object.freeze({
    spine: [10, 12], length: [13.0, 15.8], turn: 0.27, grade: [0.072, 0.105],
    branches: [3, 4], branchNodes: [2, 3], loops: 0, loopChance: 0,
    chambers: [6, 9], vertical: [9, 22], levels: [1, 2],
  }),
  circuit: Object.freeze({
    // the loop must close at its own elevation, so circuits stay single-level
    spine: [11, 13], length: [13.0, 15.8], turn: 0.22, grade: [0.075, 0.108],
    branches: [1, 2], branchNodes: [2, 3], loops: 1, loopChance: 0,
    chambers: [6, 8], vertical: [10, 22], levels: [1, 1],
  }),
  descent: Object.freeze({
    // V4.1: descent is the stacked archetype — its verticality now comes from
    // helix connectors between 2–3 levels rather than one continuous steep run.
    // The spine is long enough that a 3-level roll (two 5-segment connectors)
    // still leaves level sections with room for both branch arms to attach.
    spine: [16, 18], length: [13.0, 15.0], turn: 0.30, grade: [0.085, 0.12],
    branches: [2, 2], branchNodes: [2, 3], loops: 0, loopChance: 0.20,
    chambers: [5, 8], vertical: [18, 36], levels: [2, 3],
  }),
});

// J-hook connector between vertical levels: two straight steep segments veer
// off and displace the descending column ~28 m from the approach corridor,
// then three spiral turns near the grade cap finish the drop inside a ~10 m
// radius. Total drop ≈ 11–13 m — enough rock for a corridor to run beneath
// another. A plain spiral from the junction would sweep its shallow early
// turns back across the approach at ~4 m depth, which is exactly the floor-
// punching band the clearance validator rejects.
const CONNECTOR_SEGMENTS = 6;
const CONNECTOR_STRAIGHT = 3;
const CONNECTOR_LENGTH = [13.5, 15.0];
const CONNECTOR_GRADE = [0.160, 0.172];
const CONNECTOR_STEP_ANGLE = [1.42, 1.56];
const CONNECTOR_OFFSET_ANGLE = 0.55;

const WIDTH_PROFILE = Object.freeze({
  tight: Object.freeze({ rx: [3.45, 3.95], aspect: [0.78, 0.84] }),
  standard: Object.freeze({ rx: [4.05, 4.85], aspect: [0.79, 0.87] }),
  broad: Object.freeze({ rx: [4.9, 5.8], aspect: [0.82, 0.90] }),
});

// --- Geological shape language (V4.2) ----------------------------------------
// Every cave carries a macro-geology that drives passage cross-section
// profiles, chamber forms, and field noise. Topology stays archetype-driven;
// geology is how the same skeleton reads as a different kind of cave. Ice and
// volcanic tubes only appear where the surface biome supports them, so the
// roll takes an optional biome hint (worker and tests omit it and get the
// default table — determinism holds per (seed, biome) pair).
export const CAVE_GEOLOGIES = Object.freeze([
  'limestone', 'cathedral', 'boulder', 'grotto', 'fracture', 'ice', 'volcanic',
]);
export const CAVE_PROFILES = Object.freeze(['rounded', 'keyhole', 'bedding', 'fracture', 'eroded']);
export const CAVE_CHAMBER_FORMS = Object.freeze(['dome', 'fault', 'bowl', 'shelf', 'columned']);

const GEOLOGY_TABLE = Object.freeze({
  gallery: [['limestone', 4.0], ['grotto', 2.2], ['cathedral', 1.4], ['boulder', 1.2], ['fracture', 0.6]],
  branching: [['limestone', 3.2], ['boulder', 2.2], ['cathedral', 1.6], ['fracture', 1.4], ['grotto', 0.8]],
  circuit: [['limestone', 3.4], ['grotto', 2.4], ['cathedral', 1.8], ['boulder', 1.0], ['fracture', 0.6]],
  descent: [['fracture', 3.0], ['limestone', 2.2], ['boulder', 1.8], ['grotto', 0.7], ['cathedral', 0.5]],
});

const GEOLOGY_PROFILES = Object.freeze({
  limestone: [['rounded', 4.0], ['keyhole', 2.6], ['eroded', 2.2], ['bedding', 1.2]],
  cathedral: [['rounded', 4.5], ['bedding', 2.2], ['eroded', 1.4]],
  boulder: [['eroded', 4.0], ['rounded', 2.4], ['bedding', 1.8]],
  grotto: [['eroded', 3.4], ['rounded', 2.8], ['bedding', 1.6]],
  fracture: [['fracture', 4.5], ['keyhole', 2.4], ['rounded', 1.0]],
  ice: [['rounded', 5.0], ['bedding', 1.4]],
  volcanic: [['rounded', 6.0]],
});

const GEOLOGY_FORMS = Object.freeze({
  limestone: [['dome', 3.5], ['shelf', 2.2], ['fault', 1.4], ['columned', 1.2], ['bowl', 0.8]],
  cathedral: [['columned', 3.4], ['dome', 3.0], ['shelf', 1.2]],
  boulder: [['bowl', 4.0], ['fault', 2.0], ['dome', 1.4]],
  grotto: [['shelf', 3.0], ['dome', 2.6], ['bowl', 1.0]],
  fracture: [['fault', 4.0], ['dome', 1.6], ['shelf', 1.2]],
  ice: [['dome', 5.0], ['shelf', 1.0]],
  volcanic: [['dome', 4.0], ['bowl', 1.2]],
});

function weightedPick(table, roll) {
  const total = table.reduce((sum, [, weight]) => sum + weight, 0);
  let remaining = roll * total;
  for (const [value, weight] of table) {
    remaining -= weight;
    if (remaining <= 0) return value;
  }
  return table[table.length - 1][0];
}

function chooseGeology(seed, archetype, biome) {
  const rng = mulberry32(caveHash(seed, 0x47454f4c));
  const gateRoll = rng();                 // consumed for every cave — stream stability
  if ((biome === 'snow' || biome === 'tundra') && gateRoll < 0.30) return 'ice';
  if ((biome === 'desert' || biome === 'savanna') && gateRoll < 0.25) return 'volcanic';
  return weightedPick(GEOLOGY_TABLE[archetype] || GEOLOGY_TABLE.gallery, rng());
}

// Closest approach between two XZ segments A→B and C→D (either may be a
// point); returns the plan distance and both interpolation parameters so the
// caller can compare elevations at exactly the closest spot.
function closestSegmentParams(ax, az, bx, bz, cx, cz, dx, dz) {
  const ux = bx - ax, uz = bz - az;
  const vx = dx - cx, vz = dz - cz;
  const wx = ax - cx, wz = az - cz;
  const a = ux * ux + uz * uz, b = ux * vx + uz * vz, c = vx * vx + vz * vz;
  const d = ux * wx + uz * wz, e = vx * wx + vz * wz;
  const denom = a * c - b * b;
  let t = denom > 1e-9 ? clamp((b * e - c * d) / denom, 0, 1) : 0;
  const u = c > 1e-9 ? clamp((b * t + e) / c, 0, 1) : 0;
  t = a > 1e-9 ? clamp((b * u - d) / a, 0, 1) : 0;
  const px = ax + ux * t - (cx + vx * u), pz = az + uz * t - (cz + vz * u);
  return { d: Math.hypot(px, pz), t, u };
}

function hashUnit(...values) { return caveHash(...values) / 4294967296; }
function rngFor(seed, attempt, salt) { return mulberry32(caveHash(seed, attempt, salt)); }
function round6(value) { return Math.round(value * 1000000) / 1000000; }
function distance3(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); }
function horizontalDistance(a, b) { return Math.hypot(b[0] - a[0], b[2] - a[2]); }

function archetypeForSeed(seed) {
  // One extra PRNG avalanche avoids visible runs when adjacent integer seeds
  // share high FNV bits, while remaining independent from every layout stream.
  const index = Math.min(3, Math.floor(mulberry32(caveHash(seed, 0x41524348))() * 4));
  return CAVE_ARCHETYPES[index];
}

function edgeWidth(widthClass, rng) {
  const profile = WIDTH_PROFILE[widthClass];
  const fromRx = mix(profile.rx[0], profile.rx[1], rng());
  const toRx = clamp(fromRx * mix(0.88, 1.12, rng()), profile.rx[0], profile.rx[1]);
  const fromRy = fromRx * mix(profile.aspect[0], profile.aspect[1], rng());
  const toRy = toRx * mix(profile.aspect[0], profile.aspect[1], rng());
  return {
    rx: round6((fromRx + toRx) * 0.5),
    ry: round6((fromRy + toRy) * 0.5),
    rxA: round6(fromRx), rxB: round6(toRx),
    ryA: round6(fromRy), ryB: round6(toRy),
    // Both spellings are emitted while field and planner APIs converge. They
    // describe the same endpoint taper and are covered by the graph signature.
    rx0: round6(fromRx), rx1: round6(toRx),
    ry0: round6(fromRy), ry1: round6(toRy),
    widthClass,
    taper: {
      fromRx: round6(fromRx), toRx: round6(toRx),
      fromRy: round6(fromRy), toRy: round6(toRy),
    },
  };
}

function addEdge(edges, nodeById, aId, bId, route, order, widthClass, rng) {
  const a = nodeById.get(aId), b = nodeById.get(bId);
  const horizontal = horizontalDistance(a.p, b.p);
  const length = distance3(a.p, b.p);
  edges.push({
    id: `e${edges.length}`,
    a: aId,
    b: bId,
    type: route === 'main' ? 'spine' : route,
    route,
    order,
    ...edgeWidth(widthClass, rng),
    length: round6(length),
    grade: round6(Math.abs(b.p[1] - a.p[1]) / Math.max(horizontal, 0.001)),
  });
}

function mainWidthClass(archetype, index, count) {
  if (index === 0 || index === count - 1) return 'standard';
  if (archetype === 'gallery') return index % 3 === 1 ? 'tight' : (index % 4 === 0 ? 'broad' : 'standard');
  if (archetype === 'branching') return index % 3 === 0 ? 'broad' : 'standard';
  if (archetype === 'circuit') return index === Math.floor(count * 0.5) ? 'broad' : (index % 3 === 1 ? 'tight' : 'standard');
  return index % 3 === 1 ? 'tight' : (index % 4 === 2 ? 'broad' : 'standard');
}

// Per-segment level script: sections of gentle passage at each level with
// helix connectors between them. Membership is decided up front so the RNG
// stream length never depends on geometry outcomes.
function buildLevelScript(segmentCount, levelCount) {
  const roles = [];
  const connectors = levelCount - 1;
  const sectionBudget = segmentCount - connectors * CONNECTOR_SEGMENTS;
  const base = Math.floor(sectionBudget / levelCount);
  let extra = sectionBudget - base * levelCount;
  for (let level = 0; level < levelCount; level++) {
    const take = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    for (let index = 0; index < take; index++) roles.push({ level, connector: false, step: index });
    if (level < connectors) {
      for (let index = 0; index < CONNECTOR_SEGMENTS; index++) {
        roles.push({ level: level + 1, connector: true, step: index });
      }
    }
  }
  return roles;
}

function buildMainSpine(seed, attempt, archetype, spec, nodes, edges, options = {}) {
  const layoutRng = rngFor(seed, attempt, 0x5350494e);
  const widthRng = rngFor(seed, attempt, 0x57494454);
  const segmentCount = spec.spine[0] + Math.floor(layoutRng() * (spec.spine[1] - spec.spine[0] + 1));
  // the roll is consumed either way, so forcing a single level (the terminal
  // fallback when stacked attempts keep colliding) never shifts the stream
  const levelRoll = spec.levels[0] + Math.floor(layoutRng() * (spec.levels[1] - spec.levels[0] + 1));
  const levelCount = options.forceSingleLevel ? 1 : levelRoll;
  const roles = buildLevelScript(segmentCount, levelCount);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  nodes[0].level = 0;
  const mainPath = ['n0'];
  let base = 0;                                     // section heading
  let wander = (layoutRng() - 0.5) * 0.12;
  let helixSign = layoutRng() < 0.5 ? -1 : 1;
  let helixStart = 0, helixStep = 0;
  for (let index = 0; index < roles.length; index++) {
    const role = roles[index];
    const previous = nodeById.get(mainPath[mainPath.length - 1]);
    let heading, length, grade;
    if (role.connector) {
      if (role.step === 0) {
        helixSign = -helixSign;
        helixStart = base + wander + helixSign * CONNECTOR_OFFSET_ANGLE;
        helixStep = mix(CONNECTOR_STEP_ANGLE[0], CONNECTOR_STEP_ANGLE[1], layoutRng());
      }
      heading = role.step < CONNECTOR_STRAIGHT
        ? helixStart + (layoutRng() - 0.5) * 0.15
        : helixStart + helixSign * helixStep * (role.step - CONNECTOR_STRAIGHT + 1);
      length = mix(CONNECTOR_LENGTH[0], CONNECTOR_LENGTH[1], layoutRng());
      grade = mix(CONNECTOR_GRADE[0], CONNECTOR_GRADE[1], layoutRng());
      if (role.step === CONNECTOR_SEGMENTS - 1) {
        // the next section doubles back to run beneath the one above, sliding
        // sideways off the spiral column rather than crossing straight over it
        base = base + Math.PI + (layoutRng() - 0.5) * 1.0;
        wander = helixSign * 0.45;
      }
    } else {
      wander = clamp(wander + (layoutRng() - 0.5) * spec.turn, -0.68, 0.68);
      heading = base + wander;
      length = mix(spec.length[0], spec.length[1], layoutRng());
      grade = mix(spec.grade[0], spec.grade[1], layoutRng());
    }
    const id = `n${nodes.length}`;
    const node = {
      id,
      type: index === roles.length - 1 ? 'terminal' : 'passage',
      role: index === roles.length - 1 ? 'goal' : 'transit',
      route: 'main',
      beat: index + 1,
      level: role.level,
      p: [
        round6(previous.p[0] + Math.sin(heading) * length),
        round6(previous.p[1] - length * grade),
        round6(previous.p[2] + Math.cos(heading) * length),
      ],
    };
    if (role.connector) node.levelRole = 'connector';
    nodes.push(node);
    nodeById.set(id, node);
    mainPath.push(id);
    addEdge(edges, nodeById, previous.id, id, 'main', index,
      role.connector ? 'tight' : mainWidthClass(archetype, index, roles.length), widthRng);
  }
  return { mainPath, nodeById, levelCount };
}

function mainHeading(nodeById, mainPath, index) {
  const before = nodeById.get(mainPath[Math.max(0, index - 1)]).p;
  const after = nodeById.get(mainPath[Math.min(mainPath.length - 1, index + 1)]).p;
  return Math.atan2(after[0] - before[0], after[2] - before[2]);
}

function addSideBranch(seed, attempt, branchIndex, attachIndex, side, nodeCount, mainPath, nodes, edges, nodeById) {
  const layoutRng = rngFor(seed, attempt, 0x4252414e + branchIndex * 977);
  const widthRng = rngFor(seed, attempt, 0x42574944 + branchIndex * 991);
  let previous = nodeById.get(mainPath[attachIndex]);
  const branchLevel = previous.level ?? 0;
  let heading = mainHeading(nodeById, mainPath, attachIndex) + side * mix(0.90, 1.13, layoutRng());
  const branchNodeIds = [];
  previous.type = 'junction';
  if (previous.role === 'transit') previous.role = 'choice';
  const last = nodeCount - 1;
  for (let index = 0; index < nodeCount; index++) {
    const length = mix(13.2, 16.8, layoutRng());
    if (index > 0) heading += side * mix(-0.08, 0.14, layoutRng());
    const grade = mix(0.045, 0.11, layoutRng());
    const id = `n${nodes.length}`;
    const node = {
      id,
      type: index === last ? 'branch-end' : 'branch',
      role: index === last ? 'secret' : 'transit',
      route: `branch-${branchIndex}`,
      beat: index + 1,
      level: branchLevel,
      p: [
        round6(previous.p[0] + Math.sin(heading) * length),
        round6(previous.p[1] - length * grade),
        round6(previous.p[2] + Math.cos(heading) * length),
      ],
    };
    nodes.push(node);
    nodeById.set(id, node);
    branchNodeIds.push(id);
    addEdge(edges, nodeById, previous.id, id, `branch-${branchIndex}`, index, index === last ? 'standard' : 'tight', widthRng);
    previous = node;
  }
  return branchNodeIds;
}

function addCircuit(seed, attempt, mainPath, nodes, edges, nodeById) {
  const layoutRng = rngFor(seed, attempt, 0x43495243);
  const widthRng = rngFor(seed, attempt, 0x4c4f4f50);
  const startIndex = 2;
  // clamp the loop's span so its return path stays within the length budget
  // even on the longest spines
  const endIndex = Math.min(mainPath.length - 2, 6);
  const start = nodeById.get(mainPath[startIndex]);
  const end = nodeById.get(mainPath[endIndex]);
  const dx = end.p[0] - start.p[0], dz = end.p[2] - start.p[2];
  const horizontal = Math.hypot(dx, dz) || 1;
  const side = layoutRng() < 0.5 ? -1 : 1;
  const nx = side * dz / horizontal, nz = side * -dx / horizontal;
  const offset = mix(17.5, 22.5, layoutRng());
  const control = [
    (start.p[0] + end.p[0]) * 0.5 + nx * offset,
    (start.p[2] + end.p[2]) * 0.5 + nz * offset,
  ];
  const loopNodeIds = [];
  let previous = start;
  start.type = 'junction'; start.role = 'choice';
  end.type = 'junction'; if (end.role === 'transit') end.role = 'return';
  for (let index = 1; index <= 3; index++) {
    const t = index / 4, omt = 1 - t;
    const id = `n${nodes.length}`;
    const node = {
      id,
      type: 'loop',
      role: index === 2 ? 'loop-reveal' : 'transit',
      route: 'loop',
      beat: index,
      level: start.level ?? 0,
      p: [
        round6(omt * omt * start.p[0] + 2 * omt * t * control[0] + t * t * end.p[0]),
        round6(mix(start.p[1], end.p[1], t) - Math.sin(Math.PI * t) * mix(0.2, 1.0, layoutRng())),
        round6(omt * omt * start.p[2] + 2 * omt * t * control[1] + t * t * end.p[2]),
      ],
    };
    nodes.push(node);
    nodeById.set(id, node);
    loopNodeIds.push(id);
    addEdge(edges, nodeById, previous.id, id, 'loop', index - 1, index === 2 ? 'broad' : 'standard', widthRng);
    previous = node;
  }
  addEdge(edges, nodeById, previous.id, end.id, 'loop', 3, 'standard', widthRng);
  return loopNodeIds;
}

function chamberRadii(role, rng) {
  let ranges;
  if (role === 'hero') ranges = [[11.5, 14.8], [8.0, 10.4], [12.0, 16.8]];
  else if (role === 'reveal' || role === 'loop-reveal') ranges = [[8.3, 10.8], [6.1, 8.0], [8.8, 12.2]];
  else if (role === 'secret') ranges = [[6.3, 8.5], [5.1, 6.7], [6.6, 9.2]];
  else ranges = [[6.7, 9.0], [5.3, 7.0], [7.0, 10.0]];
  return ranges.map(([lo, hi]) => round6(mix(lo, hi, rng())));
}

function normalizePassageFloorRadii(nodes, edges) {
  for (const node of nodes) {
    const incident = edges.flatMap((edge) => {
      if (edge.a === node.id) return [edge.ryA];
      if (edge.b === node.id) return [edge.ryB];
      return [];
    });
    if (!incident.length) continue;
    const connectorRy = round6(incident.reduce((sum, value) => sum + value, 0) / incident.length);
    for (const edge of edges) {
      if (edge.a === node.id) edge.ryA = edge.ry0 = edge.taper.fromRy = connectorRy;
      if (edge.b === node.id) edge.ryB = edge.ry1 = edge.taper.toRy = connectorRy;
    }
  }
  for (const edge of edges) edge.ry = round6((edge.ryA + edge.ryB) * 0.5);
}

function buildChambers(seed, attempt, spec, mainPath, nodeById, specialNodeIds, edges) {
  const rng = rngFor(seed, attempt, 0x4348414d);
  const target = spec.chambers[0] + Math.floor(rng() * (spec.chambers[1] - spec.chambers[0] + 1));
  const chosen = [];
  const add = (nodeId, role) => {
    if (!nodeId || chosen.some((entry) => entry.nodeId === nodeId) || chosen.length >= target) return;
    if (nodeById.get(nodeId)?.levelRole === 'connector') return;   // no rooms mid-helix
    chosen.push({ nodeId, role });
  };
  // nearest level-section node to a spine index (helix nodes make no rooms)
  const sectionAt = (index) => {
    for (let offset = 0; offset < mainPath.length; offset++) {
      for (const candidate of [index + offset, index - offset]) {
        if (candidate < 1 || candidate >= mainPath.length) continue;
        if (nodeById.get(mainPath[candidate])?.levelRole !== 'connector') return mainPath[candidate];
      }
    }
    return null;
  };
  const last = mainPath.length - 1;
  add(mainPath[last], 'hero');
  add(sectionAt(2), 'threshold');
  add(sectionAt(Math.round(last * 0.45)), 'rest');
  add(sectionAt(Math.round(last * 0.70)), 'reveal');
  for (const nodeId of specialNodeIds) {
    const node = nodeById.get(nodeId);
    if (node?.role === 'secret') add(nodeId, 'secret');
    else if (node?.role === 'loop-reveal') add(nodeId, 'loop-reveal');
  }
  for (let index = 3; index < mainPath.length && chosen.length < target; index += 2) {
    add(mainPath[index], index % 4 === 1 ? 'rest' : 'reveal');
  }
  chosen.sort((a, b) => (a.role === 'hero') - (b.role === 'hero')
    || Number(a.nodeId.slice(1)) - Number(b.nodeId.slice(1)));
  const chambers = chosen.map((entry, index) => {
    const node = nodeById.get(entry.nodeId);
    if (entry.role !== 'hero' && node.role === 'transit') node.role = entry.role;
    const radii = chamberRadii(entry.role, rng);
    const incidentRadii = edges.flatMap((edge) => {
      if (edge.a === entry.nodeId) return [edge.ryA];
      if (edge.b === entry.nodeId) return [edge.ryB];
      return [];
    });
    const connectorRy = round6(incidentRadii.reduce((sum, value) => sum + value, 0)
      / Math.max(1, incidentRadii.length));
    // Every passage endpoint meeting this room shares its floor radius. This
    // prevents the flat shelf from turning unequal tunnel bottoms into a steep
    // invisible step that the real player capsule cannot traverse.
    for (const edge of edges) {
      if (edge.a === entry.nodeId) edge.ryA = edge.ry0 = edge.taper.fromRy = connectorRy;
      if (edge.b === entry.nodeId) edge.ryB = edge.ry1 = edge.taper.toRy = connectorRy;
    }
    return {
      id: `c${index}`,
      nodeId: entry.nodeId,
      role: entry.role,
      scale: entry.role === 'hero' ? 'hero' : (entry.role === 'secret' ? 'small' : 'medium'),
      yaw: round6(rng() * Math.PI * 2),
      c: [...node.p],
      r: radii,
      connectorRy,
      // Keep the broad shelf slightly above the route bottom. The passages
      // then carve a shallow, smoothly blended walking channel through the
      // room instead of the shelf undercutting a descending corridor.
      floorLift: 1.9,
      floorY: round6(node.p[1] - connectorRy + 1.9),
      floorBlend: entry.role === 'hero' ? 0.72 : 0.56,
    };
  });
  for (const edge of edges) {
    edge.ry = round6((edge.ryA + edge.ryB) * 0.5);
    edge.taper.fromRy = edge.ryA;
    edge.taper.toRy = edge.ryB;
  }
  return chambers;
}

function boundsFromVolume(volume) {
  return {
    minX: volume.min[0], minY: volume.min[1], minZ: volume.min[2],
    maxX: volume.max[0], maxY: volume.max[1], maxZ: volume.max[2],
  };
}

function chamberAxisExtents(chamber) {
  const yaw = chamber.yaw ?? chamber.rotationY ?? 0;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  return [
    Math.abs(cos) * chamber.r[0] + Math.abs(sin) * chamber.r[2],
    chamber.r[1],
    Math.abs(sin) * chamber.r[0] + Math.abs(cos) * chamber.r[2],
  ];
}

// Pure and THREE-free so terrain-aware integration can adjust finalized
// elevations, then recompute volume/bounds before hashing and worker dispatch.
export function deriveCaveVolume(graph, options = {}) {
  const margin = options.margin ?? graph.volume?.margin ?? 4;
  const alignment = options.alignment ?? graph.volume?.alignment ?? 8;
  const primitivePadding = options.primitivePadding ?? graph.volume?.primitivePadding ?? 2.2;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const include = (center, radius) => {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], center[axis] - radius[axis]);
      max[axis] = Math.max(max[axis], center[axis] + radius[axis]);
    }
  };
  for (const edge of graph.edges) {
    const a = nodeById.get(edge.a)?.p, b = nodeById.get(edge.b)?.p;
    if (!a || !b) continue;
    const radius = [Math.max(edge.rxA ?? edge.rx, edge.rxB ?? edge.rx) + primitivePadding,
      Math.max(edge.ryA ?? edge.ry, edge.ryB ?? edge.ry) + primitivePadding,
      Math.max(edge.rxA ?? edge.rx, edge.rxB ?? edge.rx) + primitivePadding];
    include(a, radius); include(b, radius);
  }
  for (const chamber of graph.chambers) include(chamber.c, chamberAxisExtents(chamber).map((value) => value + primitivePadding));
  if (graph.entrance && nodeById.has(graph.entrance.rootNodeId)) {
    const radius = [graph.entrance.rx + primitivePadding, graph.entrance.ry + primitivePadding, graph.entrance.rx + primitivePadding];
    include(nodeById.get(graph.entrance.rootNodeId).p, radius);
    include(graph.entrance.mouth, radius);
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) throw new Error('Cannot derive cave volume without finite primitives');
  const alignedMin = min.map((value) => Math.floor((value - margin) / alignment) * alignment);
  const alignedMax = max.map((value) => Math.ceil((value + margin) / alignment) * alignment);
  const volume = { min: alignedMin, max: alignedMax, margin, alignment, primitivePadding };
  return { ...volume, bounds: boundsFromVolume(volume) };
}

// --- Region partition (V4) ---------------------------------------------------
// The network is divided into deterministic topological regions: main-spine
// runs of a few segments, one region per branch arm, and the loop arc.
// Membership is pure topology, so it survives terrain fitting unchanged;
// bounds are geometry and must be refreshed whenever fitting moves nodes
// (refreshCaveRegionBounds). Streaming activates the player's region plus its
// graph neighbours, which makes look-ahead route-aware — the far arms of a
// 300 m network never mesh while you walk its first gallery.

const REGION_RUN_SEGMENTS = 3;

export function partitionCaveRegions(graph) {
  const regions = [];
  const regionOfNode = new Map();
  const byId = new Map();
  const addRegion = (id, kind) => {
    const region = { id, kind, nodeIds: [], edgeIds: [], chamberIds: [], neighbors: [] };
    regions.push(region);
    byId.set(id, region);
    return region;
  };

  // spine runs — a shared boundary node belongs to the EARLIER run
  const mainPath = graph.mainPath;
  const runCount = Math.max(1, Math.ceil((mainPath.length - 1) / REGION_RUN_SEGMENTS));
  for (let run = 0; run < runCount; run++) {
    const region = addRegion(`m${run}`, 'spine');
    const startIdx = run * REGION_RUN_SEGMENTS;
    const endIdx = Math.min(mainPath.length - 1, startIdx + REGION_RUN_SEGMENTS);
    for (let index = startIdx; index <= endIdx; index++) {
      const nodeId = mainPath[index];
      if (regionOfNode.has(nodeId)) continue;
      regionOfNode.set(nodeId, region.id);
      region.nodeIds.push(nodeId);
    }
  }
  // branch arms and the loop arc — nodes carry their route
  const sideRegionForRoute = (route) => {
    if (route === 'loop') return byId.get('l0') || addRegion('l0', 'loop');
    const match = /^branch-(\d+)$/.exec(route);
    if (!match) return null;
    const id = `b${match[1]}`;
    return byId.get(id) || addRegion(id, 'branch');
  };
  for (const node of graph.nodes) {
    if (regionOfNode.has(node.id)) continue;
    const region = sideRegionForRoute(node.route);
    if (!region) continue;
    regionOfNode.set(node.id, region.id);
    region.nodeIds.push(node.id);
  }

  // edge ownership: main edges by path order, side edges by their route
  for (const edge of graph.edges) {
    let region = null;
    if (edge.route === 'main') region = byId.get(`m${Math.floor(edge.order / REGION_RUN_SEGMENTS)}`);
    else region = sideRegionForRoute(edge.route);
    (region || regions[0]).edgeIds.push(edge.id);
  }
  for (const chamber of graph.chambers) {
    const region = byId.get(regionOfNode.get(chamber.nodeId)) || regions[0];
    region.chamberIds.push(chamber.id);
  }

  // adjacency: regions sharing an edge endpoint are neighbours
  const nodeRegion = (nodeId) => regionOfNode.get(nodeId);
  const neighborSets = new Map(regions.map((region) => [region.id, new Set()]));
  for (const edge of graph.edges) {
    const a = nodeRegion(edge.a), b = nodeRegion(edge.b);
    if (!a || !b || a === b) continue;
    neighborSets.get(a).add(b);
    neighborSets.get(b).add(a);
  }
  // an edge owned by one region whose endpoints both sit elsewhere (loop
  // closure) still links the owner to both endpoint regions
  for (const edge of graph.edges) {
    const owner = regions.find((region) => region.edgeIds.includes(edge.id))?.id;
    for (const endpoint of [edge.a, edge.b]) {
      const other = nodeRegion(endpoint);
      if (owner && other && owner !== other) {
        neighborSets.get(owner).add(other);
        neighborSets.get(other).add(owner);
      }
    }
  }
  for (const region of regions) region.neighbors = [...neighborSets.get(region.id)].sort();

  graph.regions = regions;
  refreshCaveRegionBounds(graph);
  return regions;
}

// Recompute each chamber's through-direction from current edge headings.
// applyGeology stamps it at generation, but terrain fitting bends and
// compresses the network afterwards — stale axes would let columns and rubble
// mounds rotate into the walking route.
export function refreshChamberThroughYaw(graph) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const chamber of graph.chambers) {
    let sx = 0, sz = 0;
    for (const edge of graph.edges) {
      if (edge.a !== chamber.nodeId && edge.b !== chamber.nodeId) continue;
      const from = nodeById.get(edge.a)?.p, to = nodeById.get(edge.b)?.p;
      if (!from || !to) continue;
      const hx = to[0] - from[0], hz = to[2] - from[2];
      const len = Math.hypot(hx, hz) || 1;
      const angle = Math.atan2(hx / len, hz / len);
      sx += Math.sin(angle * 2);
      sz += Math.cos(angle * 2);
    }
    chamber.throughYaw = round6(Math.atan2(sx, sz) / 2);
  }
  return graph;
}

// Recompute per-region AABBs from current node/chamber geometry. Called at
// generation and again after every terrain-fit deformation.
export function refreshCaveRegionBounds(graph) {
  if (!Array.isArray(graph.regions)) return graph;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const chamberById = new Map(graph.chambers.map((chamber) => [chamber.id, chamber]));
  const padding = graph.volume?.primitivePadding ?? 2.2;
  for (const region of graph.regions) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const include = (p, rXZ, rY) => {
      min[0] = Math.min(min[0], p[0] - rXZ); max[0] = Math.max(max[0], p[0] + rXZ);
      min[1] = Math.min(min[1], p[1] - rY); max[1] = Math.max(max[1], p[1] + rY);
      min[2] = Math.min(min[2], p[2] - rXZ); max[2] = Math.max(max[2], p[2] + rXZ);
    };
    for (const edgeId of region.edgeIds) {
      const edge = edgeById.get(edgeId);
      const a = nodeById.get(edge?.a), b = nodeById.get(edge?.b);
      if (!a || !b) continue;
      const rXZ = Math.max(edge.rxA ?? edge.rx, edge.rxB ?? edge.rx) + padding;
      const rY = Math.max(edge.ryA ?? edge.ry, edge.ryB ?? edge.ry) + padding;
      include(a.p, rXZ, rY);
      include(b.p, rXZ, rY);
    }
    for (const chamberId of region.chamberIds) {
      const chamber = chamberById.get(chamberId);
      if (!chamber) continue;
      const [ex, ey, ez] = chamberAxisExtents(chamber);
      include(chamber.c, Math.max(ex, ez) + padding, ey + padding);
    }
    for (const nodeId of region.nodeIds) {
      const node = nodeById.get(nodeId);
      if (node) include(node.p, padding, padding);
    }
    region.bounds = {
      minX: round6(min[0]), minY: round6(min[1]), minZ: round6(min[2]),
      maxX: round6(max[0]), maxY: round6(max[1]), maxZ: round6(max[2]),
    };
  }
  return graph;
}

// Stamp the geology's shape language onto a built skeleton: passage profiles
// per edge, a form + through-direction per chamber. Helix connectors and the
// first two entrance edges stay 'rounded' — their clearance geometry is load-
// bearing (stacked-level separation, the approved entrance contract).
function applyGeology(seed, attempt, geology, edges, chambers, nodeById) {
  const rng = rngFor(seed, attempt, 0x50524f46);
  for (const edge of edges) {
    const a = nodeById.get(edge.a), b = nodeById.get(edge.b);
    const connector = a?.levelRole === 'connector' || b?.levelRole === 'connector';
    const nearEntrance = edge.route === 'main' && edge.order <= 1;
    edge.profile = (connector || nearEntrance)
      ? 'rounded'
      : weightedPick(GEOLOGY_PROFILES[geology], rng());
    edge.lean = rng() < 0.5 ? -1 : 1;
    edge.channel = geology === 'grotto' && !connector && !nearEntrance;
    edge.breakdown = (geology === 'boulder' && !connector && rng() < 0.55)
      ? 1 + Math.floor(rng() * 2)
      : 0;
  }
  const formRng = rngFor(seed, attempt, 0x464f524d);
  chambers.forEach((chamber, index) => {
    // through-direction: axial mean of incident edge headings (doubled-angle
    // trick so opposite directions reinforce) — form features like columns,
    // rubble mounds, and shelf slabs sit beside this axis, never across it
    let sx = 0, sz = 0;
    for (const edge of edges) {
      if (edge.a !== chamber.nodeId && edge.b !== chamber.nodeId) continue;
      const from = nodeById.get(edge.a).p, to = nodeById.get(edge.b).p;
      const hx = to[0] - from[0], hz = to[2] - from[2];
      const len = Math.hypot(hx, hz) || 1;
      const angle = Math.atan2(hx / len, hz / len);
      sx += Math.sin(angle * 2);
      sz += Math.cos(angle * 2);
    }
    chamber.throughYaw = round6(Math.atan2(sx, sz) / 2);
    chamber.form = weightedPick(GEOLOGY_FORMS[geology], formRng());
    chamber.formSeed = caveHash(seed, attempt, 0x464f524d, index);
  });
}

function buildGraphAttemptV2(seed, attempt, options = {}) {
  const sourceSeed = seed >>> 0;
  const archetype = archetypeForSeed(sourceSeed);
  const spec = ARCHETYPE_SPEC[archetype];
  const nodes = [{ id: 'n0', type: 'entrance', role: 'entrance', route: 'main', beat: 0, p: [0, 2.0, -27.5] }];
  const entrance = {
    rootNodeId: 'n0', mouth: [0, 2.15, -36.0], outward: [0, 0, -1],
    rx: 4.15, ry: 3.15,
  };
  const edges = [];
  const { mainPath, nodeById, levelCount } = buildMainSpine(sourceSeed, attempt, archetype, spec, nodes, edges, options);
  const specialNodeIds = [];

  // Branch + loop plan. Arm count comes from the spec range; attach points
  // spread along the spine interior with alternating sides and a small jitter.
  // Outside `circuit`, a loop is only rolled when the branch budget landed on
  // its minimum — that conditional keeps the worst-case total passage length
  // under the 400 m ceiling.
  const planRng = rngFor(sourceSeed, attempt, 0x504c414e);
  const branchCount = spec.branches[0] + Math.floor(planRng() * (spec.branches[1] - spec.branches[0] + 1));
  // loops only close on single-level spines — the chord would cross a helix
  // connector otherwise. The roll consumes rng regardless, keeping the stream
  // length independent of the level plan.
  const wantLoop = spec.loops === 1
    || (spec.loopChance > 0 && branchCount === spec.branches[0]
      && planRng() < spec.loopChance && levelCount === 1);
  const loopEndIndex = Math.min(mainPath.length - 2, 6);
  const reserved = new Set([0, 1, mainPath.length - 1]);
  if (wantLoop) { reserved.add(2); reserved.add(loopEndIndex); }
  // never hang a branch off a helix connector — arms attach to level sections
  for (let index = 0; index < mainPath.length; index++) {
    if (nodeById.get(mainPath[index]).levelRole === 'connector') reserved.add(index);
  }
  const lo = 2, hi = mainPath.length - 2;
  let sideSign = planRng() < 0.5 ? -1 : 1;
  for (let branchIndex = 0; branchIndex < branchCount; branchIndex++) {
    const t = (branchIndex + 0.5 + (planRng() - 0.5) * 0.5) / branchCount;
    const ideal = Math.round(lo + t * (hi - lo));
    let attach = ideal;
    while (attach <= hi && reserved.has(attach)) attach++;
    if (attach > hi) {
      attach = ideal;
      while (attach >= lo && reserved.has(attach)) attach--;
    }
    if (attach < lo || reserved.has(attach)) continue;  // crowded spine — validation vetoes
    reserved.add(attach);
    const nodeCount = spec.branchNodes[0] + Math.floor(planRng() * (spec.branchNodes[1] - spec.branchNodes[0] + 1));
    specialNodeIds.push(...addSideBranch(sourceSeed, attempt, branchIndex, attach, sideSign, nodeCount, mainPath, nodes, edges, nodeById));
    sideSign = -sideSign;
  }
  if (wantLoop) specialNodeIds.push(...addCircuit(sourceSeed, attempt, mainPath, nodes, edges, nodeById));
  normalizePassageFloorRadii(nodes, edges);
  const chambers = buildChambers(sourceSeed, attempt, spec, mainPath, nodeById, specialNodeIds, edges);
  const geology = chooseGeology(sourceSeed, archetype, options.biome);
  applyGeology(sourceSeed, attempt, geology, edges, chambers, nodeById);
  const goalNodeId = mainPath.at(-1);
  const mainLength = edges.filter((edge) => edge.route === 'main').reduce((sum, edge) => sum + edge.length, 0);
  const totalLength = edges.reduce((sum, edge) => sum + edge.length, 0);
  const ys = nodes.map((node) => node.p[1]);
  const graph = {
    version: CAVE_GRAPH_VERSION,
    seed: caveHash(sourceSeed, attempt, 0x47524150),
    sourceSeed,
    attempt,
    archetype,
    geology,
    budget: {
      targetMainLength: round6(mainLength),
      targetTotalLength: round6(totalLength),
      targetDrop: round6(nodes[0].p[1] - nodeById.get(goalNodeId).p[1]),
      mainSegments: mainPath.length - 1,
      targetBranches: branchCount,
      targetLoops: wantLoop ? 1 : 0,
      targetLevels: levelCount,
      targetChambers: chambers.length,
      maxGrade: 0.18,
      maxDegree: 3,
      routeRange: [125, 280],
      totalRange: [150, 400],
      verticalRange: [...spec.vertical],
    },
    entranceNodeId: 'n0',
    goalNodeId,
    mainPath,
    entrance,
    nodes,
    edges,
    chambers,
    verticalRelief: round6(Math.max(...ys) - Math.min(...ys)),
    spawnLocal: { x: 0, z: -30.5 },
  };
  graph.volume = deriveCaveVolume(graph);
  graph.bounds = { ...graph.volume.bounds };
  partitionCaveRegions(graph);
  return graph;
}

function shortestRouteMetrics(graph, adjacency) {
  const distances = new Map(graph.nodes.map((node) => [node.id, Infinity]));
  distances.set(graph.entranceNodeId, 0);
  const unvisited = new Set(distances.keys());
  while (unvisited.size) {
    let current = null, best = Infinity;
    for (const id of unvisited) {
      const value = distances.get(id);
      if (value < best) { best = value; current = id; }
    }
    if (current === null) break;
    unvisited.delete(current);
    for (const neighbor of adjacency.get(current) || []) {
      if (!unvisited.has(neighbor.id)) continue;
      const candidate = best + neighbor.length;
      if (candidate < distances.get(neighbor.id)) distances.set(neighbor.id, candidate);
    }
  }
  return {
    distances,
    farthestRoute: Math.max(...[...distances.values()].filter(Number.isFinite)),
  };
}

export function validateCaveGraph(graph, options = {}) {
  const errors = [];
  // Terrain fitting may legitimately compress a cave below the generation
  // floors when the host hill is small — the walkability contracts (grade,
  // clearance, degree, floor continuity) are never relaxed, only the size
  // floors. Fitted graphs are recognised by their terrainFit record.
  const fitted = options.fitted || !!graph.terrainFit;
  const minMain = fitted ? 78 : 125;
  const minFarthest = fitted ? 72 : 110;
  const minTotal = fitted ? 120 : 150;
  const minRelief = fitted ? 5 : 8;
  const minDescentRelief = fitted ? 12 : 18;
  if (graph.version !== CAVE_GRAPH_VERSION) errors.push(`unsupported graph version ${graph.version}`);
  if (!CAVE_ARCHETYPES.includes(graph.archetype)) errors.push(`unknown archetype ${graph.archetype}`);
  if (!Array.isArray(graph.nodes) || graph.nodes.length < 12 || graph.nodes.length > 30) errors.push('node count outside 12–30');
  if (!Array.isArray(graph.edges) || !Array.isArray(graph.chambers)) errors.push('missing graph collections');
  const nodes = graph.nodes || [], edges = graph.edges || [], chambers = graph.chambers || [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  if (nodeById.size !== nodes.length) errors.push('duplicate node id');
  if (!nodeById.has(graph.entranceNodeId)) errors.push('missing entrance');
  if (!graph.entrance || !nodeById.has(graph.entrance?.rootNodeId)) errors.push('missing entrance throat');
  const root = nodeById.get('n0');
  if (!root || root.p[0] !== 0 || root.p[1] !== 2 || root.p[2] !== -27.5) errors.push('phase-1 entrance root contract changed');
  if (graph.entrance) {
    const exactArray = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);
    if (!exactArray(graph.entrance.mouth, [0, 2.15, -36])) errors.push('phase-1 entrance mouth contract changed');
    if (!exactArray(graph.entrance.outward, [0, 0, -1])) errors.push('phase-1 entrance direction contract changed');
    if (graph.entrance.rootNodeId !== 'n0' || graph.entrance.rx !== 4.15 || graph.entrance.ry !== 3.15) errors.push('phase-1 entrance clearance contract changed');
  }

  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  const edgeIds = new Set(), edgePairs = new Set();
  let maxGrade = 0, minClearance = Infinity;
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) errors.push(`duplicate edge id ${edge.id}`);
    edgeIds.add(edge.id);
    const a = nodeById.get(edge.a), b = nodeById.get(edge.b);
    if (!a || !b) { errors.push(`edge ${edge.id} has missing endpoint`); continue; }
    if (edge.a === edge.b) errors.push(`edge ${edge.id} is self-connected`);
    const pair = [edge.a, edge.b].sort().join('|');
    if (edgePairs.has(pair)) errors.push(`duplicate edge ${pair}`);
    edgePairs.add(pair);
    const length = distance3(a.p, b.p);
    const horizontal = horizontalDistance(a.p, b.p);
    const grade = Math.abs(b.p[1] - a.p[1]) / Math.max(horizontal, 0.001);
    adjacency.get(a.id).push({ id: b.id, edge, length });
    adjacency.get(b.id).push({ id: a.id, edge, length });
    maxGrade = Math.max(maxGrade, grade);
    minClearance = Math.min(minClearance, Math.min(edge.ryA ?? edge.ry, edge.ryB ?? edge.ry) * 2);
    if (grade > 0.180001) errors.push(`edge ${edge.id} grade ${grade.toFixed(3)}`);
    if (Math.min(edge.ryA ?? edge.ry, edge.ryB ?? edge.ry) * 2 < 5.1) errors.push(`edge ${edge.id} lacks standing clearance`);
    if (!WIDTH_PROFILE[edge.widthClass]) errors.push(`edge ${edge.id} lacks width class`);
    if (!edge.taper || !['fromRx', 'toRx', 'fromRy', 'toRy'].every((key) => Number.isFinite(edge.taper?.[key]) && edge.taper[key] > 0)) errors.push(`edge ${edge.id} lacks taper metadata`);
    if (!['rxA', 'rxB', 'ryA', 'ryB'].every((key) => Number.isFinite(edge[key]) && edge[key] > 0)) errors.push(`edge ${edge.id} lacks endpoint radii`);
    if (Math.abs((edge.length ?? 0) - length) > 0.002) errors.push(`edge ${edge.id} length metadata drift`);
    if (Math.abs((edge.grade ?? 0) - grade) > 0.000002) errors.push(`edge ${edge.id} grade metadata drift`);
  }

  const seen = new Set(), queue = [graph.entranceNodeId];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id) || !adjacency.has(id)) continue;
    seen.add(id);
    queue.push(...adjacency.get(id).map((neighbor) => neighbor.id));
  }
  if (seen.size !== nodes.length) errors.push('graph is disconnected');
  for (const node of nodes) {
    if ((adjacency.get(node.id)?.length || 0) > 3) errors.push(`node ${node.id} degree exceeds 3`);
    const floorRadii = edges.flatMap((edge) => {
      if (edge.a === node.id) return [edge.ryA];
      if (edge.b === node.id) return [edge.ryB];
      return [];
    });
    if (floorRadii.length && Math.max(...floorRadii) - Math.min(...floorRadii) > 0.000002) {
      errors.push(`node ${node.id} has discontinuous passage floors`);
    }
  }

  let mainLength = 0;
  if (!Array.isArray(graph.mainPath) || graph.mainPath.length < 2
    || graph.mainPath[0] !== graph.entranceNodeId || graph.mainPath.at(-1) !== graph.goalNodeId) {
    errors.push('invalid main path contract');
  } else {
    if (new Set(graph.mainPath).size !== graph.mainPath.length) errors.push('main path repeats a node');
    for (let index = 1; index < graph.mainPath.length; index++) {
      const before = graph.mainPath[index - 1], after = graph.mainPath[index];
      const edge = edges.find((candidate) => candidate.route === 'main'
        && ((candidate.a === before && candidate.b === after) || (candidate.a === after && candidate.b === before)));
      if (!edge) errors.push(`main path gap ${before}-${after}`);
      else mainLength += distance3(nodeById.get(edge.a).p, nodeById.get(edge.b).p);
    }
  }
  if (mainLength < minMain || mainLength > 278) errors.push(`main route length ${mainLength.toFixed(1)}m`);
  const { farthestRoute } = shortestRouteMetrics(graph, adjacency);
  if (farthestRoute < minFarthest || farthestRoute > 280) errors.push(`farthest route ${farthestRoute.toFixed(1)}m`);
  const totalLength = edges.reduce((sum, edge) => {
    const a = nodeById.get(edge.a), b = nodeById.get(edge.b);
    return sum + (a && b ? distance3(a.p, b.p) : 0);
  }, 0);
  if (totalLength < minTotal || totalLength > 400) errors.push(`traversable length ${totalLength.toFixed(1)}m outside limits`);

  const loops = Math.max(0, edges.length - nodes.length + 1);
  if (loops > 1) errors.push('more than one loop');
  if (loops !== (graph.budget?.targetLoops ?? 0)) errors.push(`loop count ${loops} does not match plan`);
  if (graph.archetype === 'circuit' && loops !== 1) errors.push('circuit lacks its loop');
  const branches = nodes.filter((node) => (adjacency.get(node.id)?.length || 0) >= 3).length;
  if (branches < 2) errors.push('fewer than two junctions');
  if (graph.archetype === 'branching' && branches < 3) errors.push('branching cave lacks choices');

  const chamberIds = new Set();
  let heroes = 0;
  for (const chamber of chambers) {
    if (chamberIds.has(chamber.id)) errors.push(`duplicate chamber id ${chamber.id}`);
    chamberIds.add(chamber.id);
    const node = nodeById.get(chamber.nodeId);
    if (!node) errors.push(`chamber ${chamber.id} missing node`);
    if (!Array.isArray(chamber.r) || chamber.r.some((value) => !Number.isFinite(value) || value <= 0)) errors.push(`chamber ${chamber.id} invalid radius`);
    if (node && chamber.c.some((value, axis) => Math.abs(value - node.p[axis]) > 1e-6)) errors.push(`chamber ${chamber.id} center drift`);
    if (!Number.isFinite(chamber.floorY) || !Number.isFinite(chamber.floorBlend)
      || chamber.floorY >= chamber.c[1] || chamber.floorY <= chamber.c[1] - chamber.r[1]
      || chamber.floorBlend < 0.25 || chamber.floorBlend > 1.0) {
      errors.push(`chamber ${chamber.id} invalid floor shelf`);
    }
    const expectedConnectorRy = chamber.c[1] - chamber.floorY + chamber.floorLift;
    if (!Number.isFinite(chamber.connectorRy)
      || !Number.isFinite(chamber.floorLift) || chamber.floorLift < 0.5 || chamber.floorLift > 2.0
      || Math.abs(chamber.connectorRy - expectedConnectorRy) > 0.000002) {
      errors.push(`chamber ${chamber.id} floor connector drift`);
    }
    for (const edge of edges) {
      const endpointRy = edge.a === chamber.nodeId ? edge.ryA
        : (edge.b === chamber.nodeId ? edge.ryB : null);
      if (endpointRy !== null && Math.abs(endpointRy - chamber.connectorRy) > 0.000002) {
        errors.push(`chamber ${chamber.id} passage floor mismatch ${edge.id}`);
      }
    }
    if (chamber.role === 'hero') {
      heroes++;
      if (chamber.nodeId !== graph.goalNodeId) errors.push('hero is not at goal');
    }
  }
  if (chambers.length < 5 || chambers.length > 10) errors.push('chamber count outside 5–10');
  if (heroes !== 1) errors.push(`expected one hero chamber, got ${heroes}`);

  const ys = nodes.map((node) => node.p[1]);
  const verticalRelief = Math.max(...ys) - Math.min(...ys);
  if (verticalRelief < minRelief) errors.push(`vertical relief ${verticalRelief.toFixed(1)}m`);
  if (graph.archetype === 'descent' && verticalRelief < minDescentRelief) errors.push(`descent relief ${verticalRelief.toFixed(1)}m`);
  if (Math.abs((graph.verticalRelief ?? 0) - verticalRelief) > 0.002) errors.push('vertical relief metadata drift');

  let derivedVolume = null;
  try {
    derivedVolume = deriveCaveVolume(graph, {
      margin: graph.volume?.margin ?? 4,
      alignment: graph.volume?.alignment ?? 8,
      primitivePadding: graph.volume?.primitivePadding ?? 2.2,
    });
  } catch (error) {
    errors.push(error.message);
  }
  if (derivedVolume) {
    const volumeMatches = graph.volume && ['min', 'max'].every((key) => graph.volume[key]?.every((value, axis) => value === derivedVolume[key][axis]));
    if (!volumeMatches) errors.push('graph volume is stale');
    if (!graph.bounds || Object.entries(derivedVolume.bounds).some(([key, value]) => graph.bounds[key] !== value)) errors.push('graph bounds are stale');
  }
  if (graph.volume) {
    const dimensions = graph.volume.max.map((value, axis) => value - graph.volume.min[axis]);
    if (dimensions.some((value) => value <= 0 || value > 384)) errors.push(`invalid cave volume ${dimensions.join('x')}`);
  }

  // geology shape language: identity, per-edge profiles, per-chamber forms
  if (!CAVE_GEOLOGIES.includes(graph.geology)) errors.push(`unknown geology ${graph.geology}`);
  for (const edge of edges) {
    if (!CAVE_PROFILES.includes(edge.profile)) errors.push(`edge ${edge.id} lacks a profile`);
    const a = nodeById.get(edge.a), b = nodeById.get(edge.b);
    if ((a?.levelRole === 'connector' || b?.levelRole === 'connector') && edge.profile !== 'rounded') {
      errors.push(`connector edge ${edge.id} must stay rounded`);
    }
  }
  for (const chamber of chambers) {
    if (!CAVE_CHAMBER_FORMS.includes(chamber.form)) errors.push(`chamber ${chamber.id} lacks a form`);
    if (!Number.isFinite(chamber.throughYaw)) errors.push(`chamber ${chamber.id} lacks a through direction`);
    if (!Number.isFinite(chamber.formSeed)) errors.push(`chamber ${chamber.id} lacks a form seed`);
  }

  // vertical levels: the plan decides how many, the nodes must agree
  const targetLevels = graph.budget?.targetLevels ?? 1;
  const levelSet = new Set(nodes.map((node) => node.level ?? 0));
  if (levelSet.size !== targetLevels) errors.push(`level count ${levelSet.size} does not match plan ${targetLevels}`);
  for (const node of nodes) {
    const level = node.level ?? 0;
    if (!Number.isInteger(level) || level < 0 || level >= targetLevels) errors.push(`node ${node.id} level out of range`);
  }

  // Vertical stacking clearance. Where two corridors overlap in plan they must
  // either fully merge (tiny offset — a natural tall cavern) or keep enough
  // rock between them; the band in between means a floor punched through into
  // the passage below, which the player cannot traverse without falling.
  {
    const ROCK = 2.8, MERGE = 2.0;
    // profiles change the real void envelope: a fracture passage is 1.38x
    // taller than its graph ry, a bedding slot 1.28x wider than its rx
    const PROFILE_EXTENT = {
      rounded: [1, 1], keyhole: [1, 1], bedding: [1.28, 0.7],
      fracture: [0.62, 1.38], eroded: [1.12, 0.95],
    };
    const extentOf = (edge) => PROFILE_EXTENT[edge.profile] || [1, 1];
    for (let i = 0; i < edges.length; i++) {
      const e1 = edges[i];
      const a1 = nodeById.get(e1.a), b1 = nodeById.get(e1.b);
      if (!a1 || !b1) continue;
      const [mx1, my1] = extentOf(e1);
      for (let j = i + 1; j < edges.length; j++) {
        const e2 = edges[j];
        if (e1.a === e2.a || e1.a === e2.b || e1.b === e2.a || e1.b === e2.b) continue;
        const a2 = nodeById.get(e2.a), b2 = nodeById.get(e2.b);
        if (!a2 || !b2) continue;
        const [mx2, my2] = extentOf(e2);
        const rx1 = Math.max(e1.rxA ?? e1.rx, e1.rxB ?? e1.rx) * mx1;
        const rx2 = Math.max(e2.rxA ?? e2.rx, e2.rxB ?? e2.rx) * mx2;
        const { d, t, u } = closestSegmentParams(
          a1.p[0], a1.p[2], b1.p[0], b1.p[2],
          a2.p[0], a2.p[2], b2.p[0], b2.p[2],
        );
        if (d >= rx1 + rx2 + 0.6) continue;
        const y1 = a1.p[1] + (b1.p[1] - a1.p[1]) * t;
        const y2 = a2.p[1] + (b2.p[1] - a2.p[1]) * u;
        const vgap = Math.abs(y1 - y2);
        const ry1 = Math.max(e1.ryA ?? e1.ry, e1.ryB ?? e1.ry) * my1;
        const ry2 = Math.max(e2.ryA ?? e2.ry, e2.ryB ?? e2.ry) * my2;
        if (vgap > MERGE && vgap < ry1 + ry2 + ROCK) {
          errors.push(`edges ${e1.id}/${e2.id} stack without clearance (${vgap.toFixed(1)}m)`);
        }
      }
    }
    for (const chamber of chambers) {
      const rXZ = Math.max(chamber.r[0], chamber.r[2]);
      for (const edge of edges) {
        if (edge.a === chamber.nodeId || edge.b === chamber.nodeId) continue;
        const a = nodeById.get(edge.a), b = nodeById.get(edge.b);
        if (!a || !b) continue;
        const [mxE, myE] = extentOf(edge);
        const { d, t } = closestSegmentParams(
          a.p[0], a.p[2], b.p[0], b.p[2],
          chamber.c[0], chamber.c[2], chamber.c[0], chamber.c[2],
        );
        const rxE = Math.max(edge.rxA ?? edge.rx, edge.rxB ?? edge.rx) * mxE;
        if (d >= rxE + rXZ + 0.6) continue;
        const yE = a.p[1] + (b.p[1] - a.p[1]) * t;
        const vgap = Math.abs(yE - chamber.c[1]);
        const ryE = Math.max(edge.ryA ?? edge.ry, edge.ryB ?? edge.ry) * myE;
        if (vgap > MERGE && vgap < ryE + chamber.r[1] + ROCK) {
          errors.push(`chamber ${chamber.id} stacks against ${edge.id} without clearance (${vgap.toFixed(1)}m)`);
        }
      }
    }
  }

  // region partition: exact ownership, symmetric adjacency, fresh bounds
  if (!Array.isArray(graph.regions) || graph.regions.length < 2) {
    errors.push('missing region partition');
  } else {
    const ownedNodes = new Map(), ownedEdges = new Map(), ownedChambers = new Map();
    const regionIds = new Set(graph.regions.map((region) => region.id));
    for (const region of graph.regions) {
      for (const nodeId of region.nodeIds) ownedNodes.set(nodeId, (ownedNodes.get(nodeId) || 0) + 1);
      for (const edgeId of region.edgeIds) ownedEdges.set(edgeId, (ownedEdges.get(edgeId) || 0) + 1);
      for (const chamberId of region.chamberIds) ownedChambers.set(chamberId, (ownedChambers.get(chamberId) || 0) + 1);
      if (!region.bounds || Object.values(region.bounds).some((value) => !Number.isFinite(value))) {
        errors.push(`region ${region.id} lacks finite bounds`);
      }
      for (const neighborId of region.neighbors || []) {
        const other = graph.regions.find((candidate) => candidate.id === neighborId);
        if (!regionIds.has(neighborId)) errors.push(`region ${region.id} references unknown neighbour ${neighborId}`);
        else if (!other.neighbors.includes(region.id)) errors.push(`region adjacency ${region.id}→${neighborId} is not symmetric`);
      }
    }
    for (const node of nodes) if ((ownedNodes.get(node.id) || 0) !== 1) errors.push(`node ${node.id} region ownership ${ownedNodes.get(node.id) || 0}`);
    for (const edge of edges) if ((ownedEdges.get(edge.id) || 0) !== 1) errors.push(`edge ${edge.id} region ownership ${ownedEdges.get(edge.id) || 0}`);
    for (const chamber of chambers) if ((ownedChambers.get(chamber.id) || 0) !== 1) errors.push(`chamber ${chamber.id} region ownership ${ownedChambers.get(chamber.id) || 0}`);
    // bounds freshness: recompute on a structural copy and compare
    const copy = {
      nodes, edges, chambers, volume: graph.volume,
      regions: graph.regions.map((region) => ({ ...region })),
    };
    refreshCaveRegionBounds(copy);
    for (let index = 0; index < graph.regions.length; index++) {
      const actual = graph.regions[index].bounds, expected = copy.regions[index].bounds;
      if (!actual || Object.keys(expected).some((key) => Math.abs(actual[key] - expected[key]) > 0.002)) {
        errors.push(`region ${graph.regions[index].id} bounds are stale`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    regions: graph.regions?.length ?? 0,
    levels: levelSet.size,
    reachable: seen.size,
    loops,
    branches,
    maxGrade,
    minClearance,
    nodes: nodes.length,
    edges: edges.length,
    chambers: chambers.length,
    mainLength,
    totalLength,
    farthestRoute,
    verticalRelief,
    volume: graph.volume,
  };
}

export function generateCaveGraph(seed, options = {}) {
  let lastErrors = [];
  for (let attempt = 0; attempt < 32; attempt++) {
    const graph = buildGraphAttemptV2(seed >>> 0, attempt, options);
    const validation = validateCaveGraph(graph);
    if (validation.valid) return { ...graph, validation };
    lastErrors = validation.errors;
  }
  // Degradation ladder: a seed whose stacked layouts keep colliding falls
  // back to single-level attempts, which have no vertical-clearance hazards.
  for (let attempt = 32; attempt < 48; attempt++) {
    const graph = buildGraphAttemptV2(seed >>> 0, attempt, { ...options, forceSingleLevel: true });
    const validation = validateCaveGraph(graph);
    if (validation.valid) return { ...graph, validation };
    lastErrors = validation.errors;
  }
  throw new Error(`Unable to produce valid cave graph for seed ${seed >>> 0}: ${lastErrors.slice(0, 4).join(' · ')}`);
}

function hashCanonical(hash, value) {
  const addByte = (byte) => Math.imul(hash ^ byte, 16777619);
  if (value === null || value === undefined) return addByte(value === null ? 0x6e : 0x75);
  if (typeof value === 'number') {
    hash = addByte(0x64);
    const normalized = Number.isFinite(value) ? String(round6(value)) : String(value);
    for (let index = 0; index < normalized.length; index++) hash = addByte(normalized.charCodeAt(index));
    return hash;
  }
  if (typeof value === 'string') {
    hash = addByte(0x73);
    for (let index = 0; index < value.length; index++) hash = addByte(value.charCodeAt(index));
    return hash;
  }
  if (typeof value === 'boolean') return addByte(value ? 0x31 : 0x30);
  if (Array.isArray(value)) {
    hash = addByte(0x5b);
    for (const entry of value) hash = hashCanonical(hash, entry);
    return addByte(0x5d);
  }
  hash = addByte(0x7b);
  for (const key of Object.keys(value).sort()) {
    if (key === 'validation') continue;
    hash = hashCanonical(hash, key);
    hash = hashCanonical(hash, value[key]);
  }
  return addByte(0x7d);
}

export function caveGraphSignature(graph) {
  return (hashCanonical(2166136261, graph) >>> 0).toString(16).padStart(8, '0');
}
