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


// Phase 2 deterministic topology grammar.
export const CAVE_GRAPH_VERSION = 2;
export const CAVE_ARCHETYPES = Object.freeze(['gallery', 'branching', 'circuit', 'descent']);

const ARCHETYPE_SPEC = Object.freeze({
  gallery: Object.freeze({
    spine: [8, 9], length: [13.2, 16.4], turn: 0.18, grade: [0.065, 0.095],
    branches: 1, loops: 0, chambers: [4, 5], vertical: [8, 14],
  }),
  branching: Object.freeze({
    spine: [7, 8], length: [13.0, 16.2], turn: 0.27, grade: [0.072, 0.105],
    branches: 2, loops: 0, chambers: [5, 7], vertical: [8, 17],
  }),
  circuit: Object.freeze({
    spine: [8, 9], length: [13.3, 16.4], turn: 0.22, grade: [0.075, 0.108],
    branches: 0, loops: 1, chambers: [5, 6], vertical: [9, 18],
  }),
  descent: Object.freeze({
    spine: [8, 9], length: [14.0, 17.2], turn: 0.72, grade: [0.135, 0.165],
    branches: 1, loops: 0, chambers: [4, 6], vertical: [18, 28],
  }),
});

const WIDTH_PROFILE = Object.freeze({
  tight: Object.freeze({ rx: [3.45, 3.95], aspect: [0.78, 0.84] }),
  standard: Object.freeze({ rx: [4.05, 4.85], aspect: [0.79, 0.87] }),
  broad: Object.freeze({ rx: [4.9, 5.8], aspect: [0.82, 0.90] }),
});

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

function buildMainSpine(seed, attempt, archetype, spec, nodes, edges) {
  const layoutRng = rngFor(seed, attempt, 0x5350494e);
  const widthRng = rngFor(seed, attempt, 0x57494454);
  const segmentCount = spec.spine[0] + Math.floor(layoutRng() * (spec.spine[1] - spec.spine[0] + 1));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const mainPath = ['n0'];
  let angle = (layoutRng() - 0.5) * 0.12;
  for (let index = 0; index < segmentCount; index++) {
    const previous = nodes[mainPath.length - 1];
    if (archetype === 'descent') {
      const target = (index % 4 < 2 ? 1 : -1) * (0.40 + layoutRng() * 0.24);
      angle = angle * 0.35 + target * 0.65;
    } else {
      angle = clamp(angle + (layoutRng() - 0.5) * spec.turn, -0.68, 0.68);
    }
    const length = mix(spec.length[0], spec.length[1], layoutRng());
    const grade = mix(spec.grade[0], spec.grade[1], layoutRng());
    const id = `n${nodes.length}`;
    const node = {
      id,
      type: index === segmentCount - 1 ? 'terminal' : 'passage',
      role: index === segmentCount - 1 ? 'goal' : 'transit',
      route: 'main',
      beat: index + 1,
      p: [
        round6(previous.p[0] + Math.sin(angle) * length),
        round6(previous.p[1] - length * grade),
        round6(previous.p[2] + Math.cos(angle) * length),
      ],
    };
    nodes.push(node);
    nodeById.set(id, node);
    mainPath.push(id);
    addEdge(edges, nodeById, previous.id, id, 'main', index, mainWidthClass(archetype, index, segmentCount), widthRng);
  }
  return { mainPath, nodeById };
}

function mainHeading(nodeById, mainPath, index) {
  const before = nodeById.get(mainPath[Math.max(0, index - 1)]).p;
  const after = nodeById.get(mainPath[Math.min(mainPath.length - 1, index + 1)]).p;
  return Math.atan2(after[0] - before[0], after[2] - before[2]);
}

function addSideBranch(seed, attempt, branchIndex, attachIndex, side, mainPath, nodes, edges, nodeById) {
  const layoutRng = rngFor(seed, attempt, 0x4252414e + branchIndex * 977);
  const widthRng = rngFor(seed, attempt, 0x42574944 + branchIndex * 991);
  let previous = nodeById.get(mainPath[attachIndex]);
  let heading = mainHeading(nodeById, mainPath, attachIndex) + side * mix(0.90, 1.13, layoutRng());
  const branchNodeIds = [];
  previous.type = 'junction';
  if (previous.role === 'transit') previous.role = 'choice';
  for (let index = 0; index < 2; index++) {
    const length = mix(13.2, 16.8, layoutRng());
    if (index > 0) heading += side * mix(-0.08, 0.14, layoutRng());
    const grade = mix(0.045, 0.11, layoutRng());
    const id = `n${nodes.length}`;
    const node = {
      id,
      type: index === 1 ? 'branch-end' : 'branch',
      role: index === 1 ? 'secret' : 'transit',
      route: `branch-${branchIndex}`,
      beat: index + 1,
      p: [
        round6(previous.p[0] + Math.sin(heading) * length),
        round6(previous.p[1] - length * grade),
        round6(previous.p[2] + Math.cos(heading) * length),
      ],
    };
    nodes.push(node);
    nodeById.set(id, node);
    branchNodeIds.push(id);
    addEdge(edges, nodeById, previous.id, id, `branch-${branchIndex}`, index, index === 1 ? 'standard' : 'tight', widthRng);
    previous = node;
  }
  return branchNodeIds;
}

function addCircuit(seed, attempt, mainPath, nodes, edges, nodeById) {
  const layoutRng = rngFor(seed, attempt, 0x43495243);
  const widthRng = rngFor(seed, attempt, 0x4c4f4f50);
  const startIndex = 2;
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
    chosen.push({ nodeId, role });
  };
  const last = mainPath.length - 1;
  add(mainPath[last], 'hero');
  add(mainPath[2], 'threshold');
  add(mainPath[Math.round(last * 0.45)], 'rest');
  add(mainPath[Math.round(last * 0.70)], 'reveal');
  for (const nodeId of specialNodeIds) {
    const node = nodeById.get(nodeId);
    if (node?.role === 'secret') add(nodeId, 'secret');
    else if (node?.role === 'loop-reveal') add(nodeId, 'loop-reveal');
  }
  for (let index = 3; index < mainPath.length && chosen.length < target; index++) {
    add(mainPath[index], index % 2 ? 'rest' : 'reveal');
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

function buildGraphAttemptV2(seed, attempt) {
  const sourceSeed = seed >>> 0;
  const archetype = archetypeForSeed(sourceSeed);
  const spec = ARCHETYPE_SPEC[archetype];
  const nodes = [{ id: 'n0', type: 'entrance', role: 'entrance', route: 'main', beat: 0, p: [0, 2.0, -27.5] }];
  const entrance = {
    rootNodeId: 'n0', mouth: [0, 2.15, -36.0], outward: [0, 0, -1],
    rx: 4.15, ry: 3.15,
  };
  const edges = [];
  const { mainPath, nodeById } = buildMainSpine(sourceSeed, attempt, archetype, spec, nodes, edges);
  const specialNodeIds = [];
  if (archetype === 'gallery') {
    specialNodeIds.push(...addSideBranch(sourceSeed, attempt, 0, Math.floor(mainPath.length * 0.55), hashUnit(sourceSeed, 0x47414c53) < 0.5 ? -1 : 1, mainPath, nodes, edges, nodeById));
  } else if (archetype === 'branching') {
    specialNodeIds.push(...addSideBranch(sourceSeed, attempt, 0, 2, -1, mainPath, nodes, edges, nodeById));
    specialNodeIds.push(...addSideBranch(sourceSeed, attempt, 1, mainPath.length - 3, 1, mainPath, nodes, edges, nodeById));
  } else if (archetype === 'circuit') {
    specialNodeIds.push(...addCircuit(sourceSeed, attempt, mainPath, nodes, edges, nodeById));
  } else {
    specialNodeIds.push(...addSideBranch(sourceSeed, attempt, 0, Math.floor(mainPath.length * 0.58), hashUnit(sourceSeed, 0x44455343) < 0.5 ? -1 : 1, mainPath, nodes, edges, nodeById));
  }
  normalizePassageFloorRadii(nodes, edges);
  const chambers = buildChambers(sourceSeed, attempt, spec, mainPath, nodeById, specialNodeIds, edges);
  const goalNodeId = mainPath.at(-1);
  const mainLength = edges.filter((edge) => edge.route === 'main').reduce((sum, edge) => sum + edge.length, 0);
  const ys = nodes.map((node) => node.p[1]);
  const graph = {
    version: CAVE_GRAPH_VERSION,
    seed: caveHash(sourceSeed, attempt, 0x47524150),
    sourceSeed,
    attempt,
    archetype,
    budget: {
      targetMainLength: round6(mainLength),
      targetDrop: round6(nodes[0].p[1] - nodeById.get(goalNodeId).p[1]),
      mainSegments: mainPath.length - 1,
      targetBranches: spec.branches,
      targetLoops: spec.loops,
      targetChambers: chambers.length,
      maxGrade: 0.18,
      maxDegree: 3,
      routeRange: [70, 180],
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

export function validateCaveGraph(graph) {
  const errors = [];
  if (graph.version !== CAVE_GRAPH_VERSION) errors.push(`unsupported graph version ${graph.version}`);
  if (!CAVE_ARCHETYPES.includes(graph.archetype)) errors.push(`unknown archetype ${graph.archetype}`);
  if (!Array.isArray(graph.nodes) || graph.nodes.length < 8 || graph.nodes.length > 18) errors.push('node count outside 8–18');
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
  if (mainLength < 70 || mainLength > 180) errors.push(`main route length ${mainLength.toFixed(1)}m`);
  const { farthestRoute } = shortestRouteMetrics(graph, adjacency);
  if (farthestRoute < 70 || farthestRoute > 180) errors.push(`farthest route ${farthestRoute.toFixed(1)}m`);

  const loops = Math.max(0, edges.length - nodes.length + 1);
  if (loops > 1) errors.push('more than one loop');
  if (graph.archetype === 'circuit' && loops !== 1) errors.push('circuit lacks its loop');
  if (graph.archetype !== 'circuit' && loops !== 0) errors.push(`${graph.archetype} unexpectedly loops`);
  const branches = nodes.filter((node) => (adjacency.get(node.id)?.length || 0) >= 3).length;
  if (graph.archetype === 'branching' && branches < 2) errors.push('branching cave lacks choices');

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
  if (chambers.length < 4 || chambers.length > 7) errors.push('chamber count outside 4–7');
  if (heroes !== 1) errors.push(`expected one hero chamber, got ${heroes}`);

  const ys = nodes.map((node) => node.p[1]);
  const verticalRelief = Math.max(...ys) - Math.min(...ys);
  if (verticalRelief < 8) errors.push(`vertical relief ${verticalRelief.toFixed(1)}m`);
  if (graph.archetype === 'descent' && verticalRelief < 18) errors.push(`descent relief ${verticalRelief.toFixed(1)}m`);
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
    if (dimensions.some((value) => value <= 0 || value > 256)) errors.push(`invalid cave volume ${dimensions.join('x')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    reachable: seen.size,
    loops,
    branches,
    maxGrade,
    minClearance,
    nodes: nodes.length,
    edges: edges.length,
    chambers: chambers.length,
    mainLength,
    farthestRoute,
    verticalRelief,
    volume: graph.volume,
  };
}

export function generateCaveGraph(seed) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const graph = buildGraphAttemptV2(seed >>> 0, attempt);
    const validation = validateCaveGraph(graph);
    if (validation.valid) return { ...graph, validation };
  }
  throw new Error(`Unable to produce valid cave graph for seed ${seed >>> 0}`);
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
