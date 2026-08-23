// What a keep's undercroft means, and the masonry that says so.
//
// The topology is a cave — the same graph grammar, the same field, carved and
// lit by the same runtime, because a passage under a keep is a passage. What
// makes it a cellar rather than a cave is what has been built into it: a door
// arch at the mouth, thresholds at the junctions, piers down the passages, and
// one room that is a crypt or a cistern or an underkeep footing.
//
// So this module no longer plans a dungeon. It decides what a given cave graph
// *is*, and hands the dressing a list of stones in cave-local coordinates.
// Movement, collision, lighting and the terrain cut all belong to CaveExperiment.

import { caveHash } from './cavegen.mjs';

export const FORTIFIED_DUNGEON_VERSION = 1;
export const FORTIFIED_DUNGEON_GENERATION_VERSION = 1;
export const FORTIFIED_DUNGEON_PROGRAM_VERSION = 1;

const TAU = Math.PI * 2;

// The cave graph supplies the physical skeleton; this small program grammar
// decides what that skeleton means architecturally. It is deliberately kept
// separate from the entropy channel below, so a different collapse history
// never masquerades as a different intact design.
export const DUNGEON_PROGRAM_FAMILIES = Object.freeze([
  'cellar', 'crypt', 'cistern', 'underkeep', 'tower-descent', 'catacomb',
]);

const PROGRAM_SPECS = Object.freeze([
  Object.freeze({
    family: 'cellar', entranceFamily: 'cellar-stairs', destination: 'stores',
    features: Object.freeze(['cellar', 'corridor', 'chamber', 'purposeful-dead-end']),
  }),
  Object.freeze({
    family: 'crypt', entranceFamily: 'crypt-access', destination: 'crypt-vault',
    features: Object.freeze(['crypt', 'passages', 'chamber', 'burial-recesses']),
  }),
  Object.freeze({
    family: 'cistern', entranceFamily: 'courtyard-hatch', destination: 'water-store',
    features: Object.freeze(['well-shaft', 'gallery', 'chamber', 'overflow-branch']),
  }),
  Object.freeze({
    family: 'underkeep', entranceFamily: 'gatehouse-undercroft', destination: 'underkeep',
    features: Object.freeze(['cellar', 'corridor', 'chamber', 'support-bays']),
  }),
  Object.freeze({
    family: 'tower-descent', entranceFamily: 'tower-descent', destination: 'lookout-footing',
    features: Object.freeze(['spiral-descent', 'passages', 'chamber', 'shaft']),
  }),
  Object.freeze({
    family: 'catacomb', entranceFamily: 'breached-access', destination: 'ossuary',
    features: Object.freeze(['crypt', 'loops', 'chambers', 'collapsed-wing']),
  }),
]);

function channelUnit(seed, salt, index = 0) {
  return caveHash(seed >>> 0, salt, index) / 4294967296;
}

// Which entrance the architecture can claim. A keep reaches its undercroft
// through a door in a bank, so the door itself is the constant; the family only
// colours what you find on the other side of it.
const UNDERCROFT_ENTRANCE_FAMILIES = Object.freeze([
  'cellar-stairs', 'crypt-access', 'courtyard-hatch',
  'gatehouse-undercroft', 'tower-descent',
]);

function coupleDungeonProgram(program, requestedEntrance = null) {
  const preferredByFamily = {
    'tower-descent': 'tower-descent', underkeep: 'gatehouse-undercroft',
    cistern: 'courtyard-hatch', crypt: 'crypt-access', catacomb: 'crypt-access',
  };
  const preferred = requestedEntrance || preferredByFamily[program.family] || 'cellar-stairs';
  const chosen = UNDERCROFT_ENTRANCE_FAMILIES.includes(preferred) ? preferred : 'cellar-stairs';
  return {
    ...program,
    entranceFamily: chosen,
    surfaceAccessKind: 'undercroft-door',
    entranceFallback: chosen !== preferred,
  };
}

function chooseDungeonProgram(seed, graph, override = null) {
  const requested = typeof override === 'string' ? override : override?.family;
  const requestedIndex = requested ? DUNGEON_PROGRAM_FAMILIES.indexOf(requested) : -1;
  const fallback = !!requested && requestedIndex < 0;
  // A named architecture channel is the only source for this choice. The
  // entropy planner uses a different salt and never consumes this roll.
  const index = requestedIndex >= 0
    ? requestedIndex
    : caveHash(seed, 0x44505247, graph.seed, graph.archetype === 'descent' ? 1 : 0)
      % PROGRAM_SPECS.length;
  const spec = PROGRAM_SPECS[index] || PROGRAM_SPECS[0];
  const depthPattern = graph.levelCount >= 3 || graph.budget?.targetLevels >= 3
    ? 'stacked-helix'
    : (graph.levelCount === 2 || graph.budget?.targetLevels === 2 ? 'split-level' : 'single-drop');
  const topologyPattern = graph.budget?.targetLoops
    ? 'looped-circuit'
    : (graph.budget?.targetBranches >= 3 ? 'branching-wings' : 'spine-with-purposeful-dead-ends');
  const shaft = spec.features.includes('well-shaft') || spec.features.includes('shaft')
    || channelUnit(seed, 0x44505253, index) < 0.26;
  return {
    version: FORTIFIED_DUNGEON_PROGRAM_VERSION,
    channel: 'dungeon-architecture',
    index,
    id: `dungeon-program:${spec.family}`,
    family: spec.family,
    entranceFamily: spec.entranceFamily,
    destination: spec.destination,
    depthPattern,
    topologyPattern,
    features: [...spec.features],
    shaft,
    fallback,
    architectureSeed: caveHash(seed, 0x44505247, index),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

// Interpolates height as well as ground position. It used to return x and z
// only, so the one caller that wanted a point in a sloping passage read an
// undefined y, and a single NaN vertex stopped the whole cave streaming.
function pointOnSegment(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function transformPoint(point, transform) {
  return {
    x: transform.x + point[0] * Math.cos(transform.yaw) + point[2] * Math.sin(transform.yaw),
    y: transform.y + point[1],
    z: transform.z - point[0] * Math.sin(transform.yaw) + point[2] * Math.cos(transform.yaw),
  };
}

function transformXZ(point, transform) {
  const world = transformPoint([point.x, 0, point.z], transform);
  return { x: world.x, z: world.z };
}

function edgeLine(graph, edge, transform, side, index) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const a = transformPoint(nodes.get(edge.a).p, transform);
  const b = transformPoint(nodes.get(edge.b).p, transform);
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz) || 1;
  const nx = -dz / length, nz = dx / length;
  const radius = Math.max(edge.rxA ?? edge.rx, edge.rxB ?? edge.rx) + 0.42;
  // Leave a generous semantic doorway at both endpoints. Adjacent passage
  // walls meet at a graph junction, so extending every side all the way to
  // the node would turn a branch or bend into an invisible crossbar.
  const inset = Math.min(length * 0.24, Math.max(1.8, radius * 0.82));
  const t0 = inset / length, t1 = 1 - t0;
  const ax = a.x + dx * t0, az = a.z + dz * t0;
  const bx = a.x + dx * t1, bz = a.z + dz * t1;
  return {
    id: `dungeon:passage:${edge.id}:${side}`,
    sourcePieceId: `dungeon:passage:${edge.id}`,
    ax: ax + nx * radius * side, az: az + nz * radius * side,
    bx: bx + nx * radius * side, bz: bz + nz * radius * side,
    minY: Math.min(a.y, b.y) - 0.35, maxY: Math.max(a.y, b.y) + edge.ry * 1.8,
    thickness: 0.48,
    edgeId: edge.id,
  };
}

function edgeFrame(graph, edge, transform) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const localA = nodes.get(edge.a)?.p, localB = nodes.get(edge.b)?.p;
  if (!localA || !localB) return null;
  const a = transformPoint(localA, transform), b = transformPoint(localB, transform);
  const dx = b.x - a.x, dz = b.z - a.z;
  const length = Math.hypot(dx, dz) || 1;
  return {
    a, b, dx, dz, length,
    nx: -dz / length, nz: dx / length,
    yaw: Math.atan2(dx, dz),
    radius: Math.max(edge.rxA ?? edge.rx ?? 4, edge.rxB ?? edge.rx ?? 4) + 0.42,
    midpoint: { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5, z: (a.z + b.z) * 0.5 },
  };
}

function chamberRing(chamber, transform, sourcePieceId = 'dungeon:chamber:main', graph = null) {
  const center = transformPoint(chamber.c, transform);
  const radius = Math.max(chamber.r[0], chamber.r[2]);
  // `transformPoint` rotates local X/Z by -yaw in the world plane. Rotate
  // incident passage bearings by the same amount before deciding which ring
  // arcs are doorway omissions; otherwise a transformed dungeon can retain a
  // wall across its otherwise open semantic passage.
  const worldYaw = Number(transform?.yaw || 0);
  const openings = (graph?.edges || []).filter((edge) => edge.a === chamber.nodeId || edge.b === chamber.nodeId)
    .map((edge) => {
      const otherId = edge.a === chamber.nodeId ? edge.b : edge.a;
      const other = graph.nodes.find((node) => node.id === otherId);
      return other
        ? Math.atan2(other.p[2] - chamber.c[2], other.p[0] - chamber.c[0]) - worldYaw
        : null;
    }).filter(Number.isFinite);
  const angleDistance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const result = [];
  for (let index = 0; index < 12; index++) {
    const a0 = index / 12 * TAU, a1 = (index + 1) / 12 * TAU;
    const middle = (a0 + a1) * 0.5;
    // A chamber wall is an enclosure, not an invisible sealed disk. Omit the
    // short arc facing every incident passage so the semantic route can enter
    // and leave without relying on a render-only doorway.
    if (openings.some((opening) => angleDistance(middle, opening) < 0.52)) continue;
    result.push({
      id: `dungeon:${chamber.id}:collision:${index}`,
      sourcePieceId,
      ax: center.x + Math.cos(a0) * radius, az: center.z + Math.sin(a0) * radius,
      bx: center.x + Math.cos(a1) * radius, bz: center.z + Math.sin(a1) * radius,
      minY: center.y - chamber.r[1], maxY: center.y + chamber.r[1],
      thickness: 0.55,
      chamberId: chamber.id,
    });
  }
  return result;
}

function boxLoop(piece) {
  const c = Math.cos(piece.yaw || 0), s = Math.sin(piece.yaw || 0);
  const hx = piece.width / 2, hz = piece.depth / 2;
  const corners = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([x, z]) => ({
    x: piece.x + x * c + z * s, z: piece.z - x * s + z * c,
  }));
  return corners.map((a, index) => {
    const b = corners[(index + 1) % corners.length];
    return {
      id: `${piece.id}:collision:${index}`, sourcePieceId: piece.id,
      ax: a.x, az: a.z, bx: b.x, bz: b.z,
      minY: piece.y, maxY: piece.y + piece.height, thickness: 0.12,
    };
  });
}

function pickEntropyEdge(graph) {
  const branches = graph.edges.filter((edge) => edge.route !== 'main');
  if (branches.length) return branches[caveHash(graph.sourceSeed, 0x454e5452) % branches.length];
  // The graph grammar always has branches, but keep the fallback away from the
  // protected entrance throat if a future grammar changes that guarantee.
  return graph.edges.find((edge) => edge.route === 'main' && edge.order > 2) || null;
}

function buildEntropy(graph, transform) {
  const target = pickEntropyEdge(graph);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const rubbleId = 'dungeon:entropy:rubble:0';
  const targetPieceId = target ? `dungeon:passage:${target.id}` : null;
  const blocksRoute = !!target && target.route !== 'main';
  const event = target ? {
    id: 'dungeon:entropy:event:0', kind: target.route === 'main'
      ? 'partial-entrance-collapse' : 'blocked-side-passage',
    targetEdgeId: target.id, blockedEdgeIds: blocksRoute ? [target.id] : [],
    protectedRoute: [...graph.mainPath],
    supportCascade: {
      kind: 'local-support-cascade',
      rootPieceId: targetPieceId,
      failedSupportIds: [`dungeon:support:passage:${target.id}`],
      rubbleIds: [rubbleId],
    },
    alternateAccess: !blocksRoute
      ? { kind: 'protected-main-spine', nodeId: graph.entranceNodeId }
      : { kind: 'protected-main-spine', nodeId: graph.mainPath[Math.max(0, graph.mainPath.length - 1)] },
  } : {
    id: 'dungeon:entropy:event:0', kind: 'partial-entrance-collapse',
    targetEdgeId: null, blockedEdgeIds: [], protectedRoute: [...graph.mainPath],
    supportCascade: { kind: 'none', rootPieceId: null, failedSupportIds: [], rubbleIds: [] },
    alternateAccess: { kind: 'protected-main-spine', nodeId: graph.entranceNodeId },
  };
  const rubble = [];
  if (target) {
    const a = transformPoint(nodes.get(target.a).p, transform);
    const b = transformPoint(nodes.get(target.b).p, transform);
    const midpoint = pointOnSegment(a, b, 0.52);
    rubble.push({
      id: rubbleId, sourceEdgeId: target.id, sourcePieceId: targetPieceId,
      kind: 'collapsed-masonry', x: midpoint.x, y: midpoint.y - 0.5, z: midpoint.z,
      width: 2.0, depth: 1.5, height: 1.1, yaw: Math.atan2(b.x - a.x, b.z - a.z),
      stable: blocksRoute, obstacleSide: blocksRoute, topClaim: false,
    });
  }
  return {
    version: 1, channel: 'dungeon-entropy', eventCount: 1,
    seed: caveHash(graph.sourceSeed, 0x454e5452), events: [event], rubble,
    weathering: {
      channel: 'dungeon-entropy-weathering',
      variant: ['dry-dust', 'damp-joint', 'moss-shadow', 'salt-stain'][
        caveHash(graph.sourceSeed, 0x454e5457) % 4
      ],
      intensity: 0.28 + (caveHash(graph.sourceSeed, 0x454e5458) / 4294967296) * 0.42,
    },
  };
}

function buildArchitecture(graph, transform, entropy, program) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const pieces = [];
  const collisionProxies = [];
  const renderProxies = [];
  const collapseOmissions = [];
  const primary = graph.chambers.find((entry) => entry.role !== 'threshold') || graph.chambers[0];
  const mainNodeIds = new Set(graph.mainPath || []);
  const blockedEdgeIds = new Set(entropy.events?.flatMap((event) => event.blockedEdgeIds || []) || []);

  // Every graph edge gets a semantic masonry passage. Near-view rendering can
  // choose a subset later, while collision and local navigation retain stable
  // IDs for branches, loops, and purposeful dead ends as well as the spine.
  const masonryMaterials = ['limestone-pale', 'limestone-ochre', 'basalt-shadow', 'sandstone-warm'];
  const weathering = entropy.weathering || { variant: 'dry-dust', intensity: 0.3 };
  for (const [edgeIndex, edge] of graph.edges.entries()) {
    const frame = edgeFrame(graph, edge, transform);
    if (!frame) continue;
    const connector = nodes.get(edge.a)?.levelRole === 'connector'
      || nodes.get(edge.b)?.levelRole === 'connector';
    const routeKind = edge.route === 'main' ? (connector ? 'masonry-stair' : 'masonry-passage')
      : (edge.route === 'loop' ? 'masonry-loop' : 'masonry-branch');
    const terminal = nodes.get(edge.b)?.role === 'secret' || nodes.get(edge.b)?.type === 'branch-end';
    const collapsed = blockedEdgeIds.has(edge.id);
    const material = masonryMaterials[caveHash(graph.sourceSeed, 0x4d41544c, edgeIndex) % masonryMaterials.length];
    const edgeSupportId = `dungeon:support:passage:${edge.id}`;
    pieces.push({
      id: `dungeon:passage:${edge.id}`, kind: routeKind, edgeId: edge.id,
      route: edge.route, purpose: terminal ? 'purposeful-dead-end' : 'circulation',
      profile: edge.profile || 'rounded',
      collapsed,
      material, weathering: weathering.variant, weatheringIntensity: weathering.intensity,
      supportIds: ['dungeon:support:passage', edgeSupportId],
    });
    if (collapsed) {
      collapseOmissions.push(`dungeon:floor:${edge.id}`, `dungeon:arch:${edge.id}`);
    }
    const floorId = `dungeon:floor:${edge.id}`;
    pieces.push({
      id: floorId, kind: 'masonry-floor', edgeId: edge.id, route: edge.route,
      x: frame.midpoint.x, y: frame.midpoint.y - 0.10, z: frame.midpoint.z,
      width: Math.max(3.4, frame.radius * 2.0), depth: Math.max(1.4, frame.length * 0.94),
      height: 0.18, yaw: frame.yaw, mode: 'ramp', ay: frame.a.y - 0.10, by: frame.b.y - 0.10,
      collapsed, renderSuppressed: collapsed,
      material, weathering: weathering.variant, weatheringIntensity: weathering.intensity,
      supportIds: ['dungeon:support:passage', edgeSupportId],
    });
    // A shallow lintel makes the route read as constructed masonry while
    // remaining above player head height. It is render-only; the natural cave
    // field and the simplified passage proxies own the traversable boundary.
    pieces.push({
      id: `dungeon:arch:${edge.id}`, kind: 'masonry-arch', edgeId: edge.id,
      x: frame.midpoint.x, y: frame.midpoint.y + 2.75, z: frame.midpoint.z,
      width: Math.max(3.6, frame.radius * 2.1), depth: 0.38, height: 0.46,
      yaw: frame.yaw, material, weathering: weathering.variant, collapsed, renderSuppressed: collapsed,
      weatheringIntensity: weathering.intensity, supportIds: ['dungeon:support:passage', edgeSupportId],
    });
    const pillarSide = edgeIndex % 2 ? -1 : 1;
    const pillarBase = {
      id: `dungeon:pillar:${edge.id}`, kind: 'masonry-pillar', edgeId: edge.id,
      x: frame.midpoint.x + frame.nx * pillarSide * (frame.radius + 0.72),
      y: frame.midpoint.y + 1.15,
      z: frame.midpoint.z + frame.nz * pillarSide * (frame.radius + 0.72),
      width: 0.68, depth: 0.68, height: 2.3, yaw: frame.yaw,
      material, weathering: weathering.variant, weatheringIntensity: weathering.intensity,
      supportIds: ['dungeon:support:passage', edgeSupportId],
    };
    pieces.push(pillarBase);
    // The cave SDF owns the continuous tunnel boundary. Pillars remain a
    // restrained visual/support cue in this slice; only entrance piers,
    // explicit chamber rings, and stable collapse rubble become colliders so a
    // folded branch can never place an invisible support across the main route.
    const edgeProxies = [edgeLine(graph, edge, transform, -1), edgeLine(graph, edge, transform, 1)];
    if (!collapsed) renderProxies.push(...edgeProxies);
    // Passage lining remains renderable here; the cave SDF owns the natural
    // tunnel boundary while the first semantic slice keeps its invisible
    // proxy set limited to explicit piers, chamber enclosures, and rubble.
    // Later dressing can split these lines into portal-bounded masonry
    // colliders without changing their stable source IDs.
  }

  // Junction thresholds are ordinary floor pieces, not walls. They make the
  // branch/loop grammar legible in the near view while sharing the same node
  // IDs that local navigation and walkable claims use.
  for (const node of graph.nodes) {
    const incident = graph.edges.find((edge) => edge.a === node.id || edge.b === node.id);
    if (!incident) continue;
    const frame = edgeFrame(graph, incident, transform);
    const center = transformPoint(node.p, transform);
    if (!frame) continue;
    pieces.push({
      id: `dungeon:threshold:${node.id}`, kind: 'masonry-threshold', nodeId: node.id,
      x: center.x, y: center.y - 0.04, z: center.z,
      width: Math.max(3.2, frame.radius * 1.55), depth: 0.46, height: 0.16,
      yaw: frame.yaw, material: masonryMaterials[caveHash(graph.sourceSeed, 0x4d415448, node.beat || 0) % masonryMaterials.length],
      weathering: weathering.variant, weatheringIntensity: weathering.intensity,
      supportIds: ['dungeon:support:passage'],
    });
  }

  const entranceRootLocal = nodes.get(graph.entrance.rootNodeId).p;
  const entranceRoot = transformPoint(entranceRootLocal, transform);
  const entranceYaw = Number(transform?.yaw || 0);
  const entrancePier = (side) => {
    const local = [entranceRootLocal[0] + side * 2.4, entranceRootLocal[1] + 1.9, entranceRootLocal[2]];
    const world = transformPoint(local, transform);
    return {
      id: `dungeon:entrance:pier:${side < 0 ? 'left' : 'right'}`, kind: 'masonry-pier',
      x: world.x, y: world.y, z: world.z, width: 0.65, height: 3.8, depth: 0.8,
      yaw: entranceYaw, supportIds: ['dungeon:entrance:arch'],
    };
  };
  const entrancePierCollision = (side) => {
    const a = transformPoint([
      entranceRootLocal[0] + side * 2.4, entranceRootLocal[1], entranceRootLocal[2] - 0.4,
    ], transform);
    const b = transformPoint([
      entranceRootLocal[0] + side * 2.4, entranceRootLocal[1], entranceRootLocal[2] + 0.4,
    ], transform);
    return {
      id: `dungeon:entrance:pier:${side < 0 ? 'left' : 'right'}:collision`,
      sourcePieceId: `dungeon:entrance:pier:${side < 0 ? 'left' : 'right'}`,
      ax: a.x, az: a.z, bx: b.x, bz: b.z,
      minY: a.y, maxY: a.y + 3.8, thickness: 0.65,
    };
  };
  const leftPier = entrancePier(-1), rightPier = entrancePier(1);
  pieces.push(
    leftPier,
    rightPier,
    { id: 'dungeon:entrance:lintel', kind: 'masonry-lintel', x: entranceRoot.x, y: entranceRoot.y + 3.55, z: entranceRoot.z, width: 5.4, height: 0.7, depth: 0.8, yaw: entranceYaw, supportIds: ['dungeon:entrance:pier:left', 'dungeon:entrance:pier:right'] },
  );
  collisionProxies.push(
    entrancePierCollision(-1), entrancePierCollision(1),
  );

  for (const chamber of graph.chambers) {
    const chamberCenter = transformPoint(chamber.c, transform);
    const pieceId = chamber === primary ? 'dungeon:chamber:main' : `dungeon:chamber:${chamber.id}`;
    const purpose = chamber.role === 'hero' ? program.destination
      : (chamber.role === 'secret' ? 'purposeful-dead-end' : program.family);
    pieces.push({
      id: pieceId, kind: 'chamber-shell', chamberId: chamber.id, role: chamber.role,
      purpose, x: chamberCenter.x, y: chamberCenter.y, z: chamberCenter.z,
      radiusX: chamber.r[0], radiusY: chamber.r[1], radiusZ: chamber.r[2],
      supportIds: ['dungeon:support:chamber'],
    });
    // Side-arm chamber shells are renderable rooms but stay non-blocking in
    // this first protected-route slice; only chambers on the main spine need
    // conservative wall proxies, and their incident openings are explicit.
    // The cave SDF already supplies the natural side wall for every passage.
    // Keep one conservative masonry ring for the primary architectural room;
    // rings on every large terminal chamber can overlap an upstream corridor
    // when the cave grammar folds back near a hero room, creating a false
    // invisible wall across the protected route.
    if (chamber === primary && mainNodeIds.has(chamber.nodeId)) {
      collisionProxies.push(...chamberRing(chamber, transform, pieceId, graph));
    }
  }

  // Program-specific architectural cues are intentionally small, semantic
  // pieces. They make a cellar, crypt, cistern, underkeep, or tower descent
  // legible without inventing a second topology or adding unsafe blockers.
  if (primary) {
    const featureCenter = transformPoint([
      primary.c[0] + Math.max(2.0, primary.r[0] * 0.42),
      primary.floorY + 0.18,
      primary.c[2],
    ], transform);
    if (program.shaft) pieces.push({
      id: 'dungeon:feature:shaft', kind: 'well-shaft', x: featureCenter.x,
      y: featureCenter.y, z: featureCenter.z, width: 2.1, depth: 2.1,
      height: 0.55, yaw: primary.yaw || 0, purpose: 'vertical-service-shaft',
      supportIds: ['dungeon:support:shaft'],
    });
    if (program.family === 'crypt' || program.family === 'catacomb') {
      pieces.push({
        id: 'dungeon:feature:crypt-recess', kind: 'crypt-recess',
        x: featureCenter.x, y: featureCenter.y + 0.7, z: featureCenter.z - 1.6,
        width: 2.4, depth: 0.45, height: 1.1, yaw: primary.yaw || 0,
        purpose: 'burial-recess', supportIds: ['dungeon:support:chamber'],
      });
    }
    if (program.family === 'underkeep' || program.family === 'tower-descent') {
      pieces.push({
        id: 'dungeon:feature:support-bay', kind: 'masonry-support',
        x: featureCenter.x, y: featureCenter.y + 1.25, z: featureCenter.z + 1.6,
        width: 0.7, depth: 0.7, height: 2.5, yaw: primary.yaw || 0,
        purpose: 'load-bearing-support', supportIds: ['dungeon:support:chamber'],
      });
    }
  }

  for (const rubble of entropy.rubble) pieces.push({
    id: rubble.id, kind: 'collapsed-masonry', x: rubble.x, y: rubble.y,
    z: rubble.z, width: rubble.width, depth: rubble.depth, height: rubble.height,
    yaw: rubble.yaw, supportIds: ['dungeon:support:collapse'],
  });
  for (const rubble of entropy.rubble.filter((piece) => piece.stable)) {
    collisionProxies.push(...boxLoop(rubble));
  }
  return {
    pieces, collisionProxies, renderProxies, collapseOmissions,
    chamber: primary, chambers: graph.chambers,
  };
}

const IDENTITY = Object.freeze({ x: 0, y: 0, z: 0, yaw: 0 });

/**
 * The stones built into one cave graph, in cave-local coordinates.
 *
 * Called by the dressing planner in place of the stalactites and fungi a
 * natural cave would grow. Everything here is a piece with a stable id, so the
 * same undercroft is dressed the same way every time it streams in.
 */
export function dungeonMasonryFor(graph, {
  seed = graph?.seed ?? 1, program: requestedProgram = null, entranceFamily = null,
} = {}) {
  if (!graph?.nodes?.length) throw new TypeError('A cave graph is required.');
  const program = coupleDungeonProgram(
    chooseDungeonProgram(seed >>> 0, graph, requestedProgram), entranceFamily,
  );
  const entropy = buildEntropy(graph, IDENTITY);
  const architecture = buildArchitecture(graph, IDENTITY, entropy, program);
  return deepFreeze({
    version: FORTIFIED_DUNGEON_VERSION,
    programVersion: FORTIFIED_DUNGEON_PROGRAM_VERSION,
    program,
    weathering: entropy.weathering,
    pieces: architecture.pieces.filter((piece) => !piece.renderSuppressed),
    // The passage lining: two lines per surviving edge, which the dressing
    // turns into the wall face masonry either side of a corridor.
    passageLines: architecture.renderProxies.filter((line) =>
      line.sourcePieceId?.startsWith('dungeon:passage:')),
    chamber: architecture.chamber || null,
    entropy: {
      events: entropy.events, rubble: entropy.rubble,
      blockedEdgeIds: entropy.events[0]?.blockedEdgeIds || [],
    },
  });
}

export { chooseDungeonProgram, coupleDungeonProgram };
