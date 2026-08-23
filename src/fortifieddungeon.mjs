// A compact dungeon slice that reuses the deterministic cave topology while
// adding a surface-ruin relationship. The graph and field stay THREE-free;
// renderer/streaming code can place the whole slice with `surfaceTransform`.

import {
  caveHash,
  deriveCaveVolume,
  generateDungeonGraph,
  validateCaveGraph,
} from './cavegen.mjs';
import { createCaveField } from './cavefield.mjs';
import { buildCaveDressingPlan } from './cavedressing.mjs';
import { createFortifiedOutpostPlan } from './fortifiedoutpost.mjs';

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

function deriveSurfaceContext(surfacePlan, seam) {
  const intact = surfacePlan?.intact || surfacePlan || {};
  const anchorPieceId = seam?.surfacePieceId || 'room:floor';
  const anchorKind = anchorPieceId.startsWith('tower') ? 'tower'
    : (anchorPieceId.includes('gate') ? 'gatehouse' : (anchorPieceId.includes('courtyard') ? 'courtyard' : 'room'));
  const towers = (intact.pieces || []).filter((piece) => piece.kind === 'tower');
  const protectedRoute = intact.circulation?.protectedRoute || [];
  const availableEntranceFamilies = anchorKind === 'tower'
    ? ['tower-descent', 'cellar-stairs', 'crypt-access']
    : anchorKind === 'gatehouse'
      ? ['gatehouse-undercroft', 'cellar-stairs', 'crypt-access']
      : anchorKind === 'courtyard'
        ? ['courtyard-hatch', 'cellar-stairs', 'crypt-access']
        : ['cellar-stairs', 'crypt-access'];
  const worldTransform = surfacePlan?.worldTransform || { x: 0, y: 0, z: 0, yaw: 0 };
  return {
    kind: intact.curtain && intact.room ? 'fortified-outpost' : 'surface-structure',
    surfacePlanId: surfacePlan?.id || null,
    anchorPieceId,
    anchorRoomId: seam?.surfaceRoomId || intact.room?.id || null,
    anchorKind,
    orientationYaw: Number(worldTransform.yaw || 0),
    footprintRadius: Number(intact.footprintRadius || 0),
    towerCount: towers.length,
    towerIds: towers.map((tower) => tower.id),
    gateId: intact.curtain?.gate?.id || null,
    courtyardId: intact.courtyard?.id || null,
    roomId: intact.room?.id || null,
    surfaceRouteNodeIds: [...protectedRoute],
    availableEntranceFamilies,
    vegetationExclusion: {
      kind: 'surface-footprint',
      radius: Math.max(34, Number(intact.footprintRadius || 0)),
      anchorPieceId,
    },
    trailContract: {
      approachKind: 'gate-facing-approach',
      gateId: intact.curtain?.gate?.id || null,
      routeNodeId: 'route:gate',
    },
    seam: seam ? { x: seam.x, y: seam.y, z: seam.z, radius: seam.radius } : null,
  };
}

function coupleDungeonProgram(program, surfaceContext, requestedEntrance = null) {
  const preferredByFamily = {
    'tower-descent': 'tower-descent', underkeep: 'gatehouse-undercroft',
    cistern: 'courtyard-hatch', crypt: 'crypt-access', catacomb: 'crypt-access',
  };
  const preferred = requestedEntrance || preferredByFamily[program.family] || 'cellar-stairs';
  const chosen = surfaceContext.availableEntranceFamilies.includes(preferred)
    ? preferred : surfaceContext.availableEntranceFamilies[0] || 'cellar-stairs';
  return {
    ...program,
    entranceFamily: chosen,
    surfaceAccessKind: surfaceContext.anchorKind,
    surfaceAnchorPieceId: surfaceContext.anchorPieceId,
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

function pointOnSegment(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
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

function buildWalkables(graph, transform, chamber) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const root = transformPoint(nodes.get(graph.entranceNodeId).p, transform);
  const mainPath = graph.mainPath || [];
  const edgeFor = (a, b) => graph.edges.find((edge) => edge.route === 'main' && edge.a === a && edge.b === b);
  const claims = [{
    id: 'dungeon:surface:apex', sourcePieceId: 'portal:dungeon-floor', kind: 'dungeon-apex',
    mode: 'fixed', y: root.y, shape: { kind: 'circle', x: root.x, z: root.z, radius: 2.4 },
    routeNodeIds: ['surface:portal', graph.entranceNodeId],
  }];

  // Publish one continuous analytic plane for every protected main-spine
  // edge. The cave field may later provide the visible floor, but movement,
  // NPC gait, and the renderer-free inspection all consume this same semantic
  // route contract. Keeping the first claim id stable preserves the original
  // descent recipe used by existing callers.
  const addEdgeClaim = (edge, index, kind) => {
    const a = nodes.get(edge.a), b = nodes.get(edge.b);
    if (!a || !b || !edge) return;
    const from = transformPoint(a.p, transform), to = transformPoint(b.p, transform);
    const radius = Math.max(edge.rxA ?? edge.rx ?? 4, edge.rxB ?? edge.rx ?? 4);
    claims.push({
      id: index === 0 && kind === 'main' ? 'dungeon:walkable:descent' : `dungeon:walkable:${kind}:${edge.id}`,
      sourcePieceId: `dungeon:floor:${edge.id}`, kind: index === 0 && kind === 'main' ? 'dungeon-ramp' : `dungeon-${kind}`,
      mode: 'ramp', ax: from.x, az: from.z, ay: from.y,
      bx: to.x, bz: to.z, by: to.y,
      width: Math.max(2.4, Math.min(8.4, radius * 1.2)),
      routeNodeIds: [a.id, b.id],
    });
  };
  for (let index = 0; index < mainPath.length - 1; index++) {
    const edge = edgeFor(mainPath[index], mainPath[index + 1]);
    if (!edge) continue;
    addEdgeClaim(edge, index, 'main');
  }
  for (const edge of graph.edges) {
    if (edge.route === 'main') continue;
    addEdgeClaim(edge, 1, edge.route === 'loop' ? 'loop' : 'branch');
  }
  const chambers = graph.chambers || (chamber ? [chamber] : []);
  for (const entry of chambers) {
    const center = transformPoint(entry.c, transform);
    const primary = entry === chamber;
    claims.push({
      id: primary ? 'dungeon:walkable:chamber' : `dungeon:walkable:chamber:${entry.id}`,
      sourcePieceId: primary ? 'dungeon:chamber:main' : `dungeon:chamber:${entry.id}`,
      kind: 'dungeon-chamber', mode: 'fixed', y: entry.floorY + transform.y,
      shape: { kind: 'circle', x: center.x, z: center.z, radius: Math.min(entry.r[0], entry.r[2]) * 0.68 },
      routeNodeIds: [entry.nodeId],
    });
  }
  return claims;
}

function buildLocalNavigation(graph, transform, entropy) {
  const nodes = graph.nodes.map((node) => {
    const world = transformPoint(node.p, transform);
    return {
      id: node.id, kind: node.role || node.type || 'passage',
      x: world.x, y: world.y, z: world.z,
      floorY: world.y, stackLevel: node.level || 0,
    };
  });
  const root = nodes.find((node) => node.id === graph.entranceNodeId);
  const navigationNodes = [
    { id: 'surface:portal', kind: 'surface-portal', x: root?.x || 0, y: root?.y || 0, z: root?.z || 0, floorY: root?.y || 0, stackLevel: 0 },
    ...nodes,
  ];
  const blocked = new Set(entropy.events?.flatMap((event) => event.blockedEdgeIds || []) || []);
  const edges = [{
    id: 'navigation:surface-portal', from: 'surface:portal', to: graph.entranceNodeId,
    bidirectional: true, enabled: true, kind: 'portal', width: 2.8,
    headroom: 3.2, grade: 0, sourcePieceId: 'portal:dungeon-floor',
  }];
  for (const edge of graph.edges) {
    const a = graph.nodes.find((node) => node.id === edge.a);
    const b = graph.nodes.find((node) => node.id === edge.b);
    if (!a || !b) continue;
    const from = transformPoint(a.p, transform), to = transformPoint(b.p, transform);
    const horizontal = Math.hypot(to.x - from.x, to.z - from.z);
    edges.push({
      id: `navigation:${edge.id}`, from: edge.a, to: edge.b, bidirectional: true,
      enabled: !blocked.has(edge.id), blockedBy: blocked.has(edge.id) ? `dungeon:entropy:event:0` : null,
      kind: edge.route === 'main' && (a.levelRole === 'connector' || b.levelRole === 'connector') ? 'ramp' : 'passage',
      width: Math.max(2.4, Math.min(8.4, Math.max(edge.rxA ?? edge.rx ?? 4, edge.rxB ?? edge.rx ?? 4) * 1.2)),
      headroom: Math.max(2.1, Math.min(8.0, Math.max(edge.ryA ?? edge.ry ?? 3, edge.ryB ?? edge.ry ?? 3) * 1.6)),
      grade: Math.abs(to.y - from.y) / Math.max(0.01, horizontal),
      sourcePieceId: `dungeon:floor:${edge.id}`,
      route: edge.route,
    });
  }
  const roundTrip = ['surface:portal', ...graph.mainPath, ...graph.mainPath.slice(0, -1).reverse(), 'surface:portal'];
  return {
    version: 1, channel: 'dungeon-local-navigation', nodes: navigationNodes, edges,
    protectedRoute: roundTrip,
    returnRoute: ['surface:portal', ...graph.mainPath.slice().reverse(), 'surface:portal'],
    alternateAccess: entropy.events?.[0]?.alternateAccess || null,
  };
}

function normalizeArgs(seedOrOptions, maybeOptions) {
  if (seedOrOptions && typeof seedOrOptions === 'object') {
    // Accept both createDungeonPlan({ surfacePlan, seed }) and the convenient
    // createDungeonPlan(outpostPlan, { seed }) spelling used by stream code.
    if (seedOrOptions.intact && seedOrOptions.id) {
      const extra = maybeOptions && typeof maybeOptions === 'object' ? maybeOptions : {};
      return { ...extra, surfacePlan: seedOrOptions, seed: extra.seed ?? seedOrOptions.seed ?? 1 };
    }
    return { ...seedOrOptions };
  }
  return { ...(maybeOptions || {}), seed: seedOrOptions ?? maybeOptions?.seed ?? 1 };
}

export function createFortifiedDungeonPlan(seedOrOptions = 1, maybeOptions = {}) {
  const options = normalizeArgs(seedOrOptions, maybeOptions);
  const seed = Number(options.seed ?? 1) >>> 0;
  const surfacePlan = options.surfacePlan || options.outpostPlan || createFortifiedOutpostPlan(seed);
  const seam = surfacePlan.dungeonSeam || surfacePlan.intact?.dungeonSeam;
  const surfaceX = Number(options.surfaceX ?? seam?.x ?? surfacePlan.intact?.room?.x ?? 0);
  const surfaceY = Number(options.surfaceY ?? seam?.y ?? 0.12);
  const surfaceZ = Number(options.surfaceZ ?? seam?.z ?? surfacePlan.intact?.room?.z ?? 0);
  const yaw = Number(options.yaw ?? surfacePlan.worldTransform?.yaw ?? 0);
  const graph = generateDungeonGraph(seed, {
    biome: options.biome,
    hillClass: options.hillClass || 'low',
    geology: options.geology || 'limestone',
  });
  const root = graph.nodes.find((node) => node.id === graph.entranceNodeId);
  const rootCos = Math.cos(yaw), rootSin = Math.sin(yaw);
  const rotatedRootX = root.p[0] * rootCos + root.p[2] * rootSin;
  const rotatedRootZ = -root.p[0] * rootSin + root.p[2] * rootCos;
  const surfaceTransform = {
    x: surfaceX - rotatedRootX, y: surfaceY - root.p[1], z: surfaceZ - rotatedRootZ, yaw,
  };
  // Validate the canonical graph before attaching world-space adapters. This
  // preserves cave worker parity and makes surface placement a pure transform.
  const graphValidation = validateCaveGraph(graph);
  if (!graphValidation.valid) throw new Error(`Invalid dungeon cave graph: ${graphValidation.errors.slice(0, 4).join(' · ')}`);
  const worldRoot = transformPoint(root.p, surfaceTransform);
  const worldMouth = transformPoint(graph.entrance.mouth, surfaceTransform);
  const surfaceContext = deriveSurfaceContext(surfacePlan, seam);
  const program = coupleDungeonProgram(
    chooseDungeonProgram(seed, graph, options.program || options.architectureProgram),
    surfaceContext,
    options.entranceFamily,
  );
  const entropy = buildEntropy(graph, surfaceTransform);
  const architecture = buildArchitecture(graph, surfaceTransform, entropy, program);
  const walkableClaims = buildWalkables(graph, surfaceTransform, architecture.chamber);
  const localNavigation = buildLocalNavigation(graph, surfaceTransform, entropy);
  const protectedRoute = ['surface:portal', ...graph.mainPath, 'surface:portal'];
  const plan = {
    version: FORTIFIED_DUNGEON_VERSION,
    generationVersion: FORTIFIED_DUNGEON_GENERATION_VERSION,
    id: `fortified-dungeon:${seed}`,
    seed,
    mode: 'fortified-dungeon',
    surfaceLink: {
      surfacePlanId: surfacePlan.id,
      outpostPieceId: surfaceContext.anchorPieceId,
      portalId: seam?.id || 'portal:dungeon-floor',
      kind: 'surface-ruin-to-cave',
      accessKind: surfaceContext.anchorKind,
      entranceFamily: program.entranceFamily,
      orientationYaw: surfaceContext.orientationYaw,
      surfaceRouteNodeIds: surfaceContext.surfaceRouteNodeIds,
      vegetationExclusion: surfaceContext.vegetationExclusion,
      trailContract: surfaceContext.trailContract,
    },
    surfaceTransform,
    graph,
    graphValidation,
    localNavigation,
    navigation: localNavigation,
    program,
    surfaceContext,
    diagnostics: {
      graphAttempt: graph.attempt,
      graphAttemptBudget: 48,
      programFallback: !!program.fallback,
      entranceFallback: !!program.entranceFallback,
      surfaceAnchorKind: surfaceContext.anchorKind,
      protectedRouteNodeCount: graph.mainPath.length,
    },
    entrance: {
      kind: program.entranceFamily, rootNodeId: graph.entranceNodeId,
      surface: worldRoot, mouth: worldMouth,
      flatGround: true, terrainOpening: true,
      protected: true,
      surfaceAccess: {
        kind: surfaceContext.anchorKind,
        pieceId: surfaceContext.anchorPieceId,
        roomId: surfaceContext.anchorRoomId,
        fallback: !!program.entranceFallback,
      },
    },
    terrainOpening: {
      id: 'dungeon:terrain-opening', kind: 'apex-aperture',
      x: worldRoot.x, y: worldRoot.y, z: worldRoot.z, radius: 2.65,
      surfacePieceId: surfaceContext.anchorPieceId,
      surfaceReservationRadius: surfaceContext.seam?.radius ?? null,
      cut: { shape: 'circle', depth: 1.5, occludesSurface: true },
      occlusion: { enabled: true, mode: 'terrain-hole', radius: 3.1, depth: 2.4 },
    },
    architecture: {
      program,
      pieces: architecture.pieces,
      collisionProxies: architecture.collisionProxies,
      renderProxies: architecture.renderProxies,
      collapseOmissions: architecture.collapseOmissions,
      materialVariants: [...new Set(architecture.pieces.map((piece) => piece.material).filter(Boolean))],
      portals: [
        { id: 'portal:dungeon-floor', kind: 'surface-apex', nodeId: graph.entranceNodeId, open: true, protected: true },
        { id: 'dungeon:portal:chamber', kind: 'chamber-portal', nodeId: architecture.chamber?.nodeId || graph.goalNodeId, open: true },
      ],
      supports: [
        { id: 'dungeon:entrance:arch', kind: 'masonry-arch', pieceIds: ['dungeon:entrance:pier:left', 'dungeon:entrance:pier:right', 'dungeon:entrance:lintel'] },
        { id: 'dungeon:support:passage', kind: 'passage-foundation', pieceIds: architecture.pieces.filter((piece) => piece.edgeId).map((piece) => piece.id) },
        ...graph.edges.map((edge) => ({
          id: `dungeon:support:passage:${edge.id}`, kind: 'passage-support',
          status: entropy.events[0]?.blockedEdgeIds?.includes(edge.id) ? 'failed' : 'stable',
          pieceIds: architecture.pieces.filter((piece) => piece.edgeId === edge.id).map((piece) => piece.id),
        })),
        { id: 'dungeon:support:chamber', kind: 'chamber-support', pieceIds: architecture.chamber ? ['dungeon:chamber:main'] : [] },
        { id: 'dungeon:support:collapse', kind: 'collapse-rest', pieceIds: entropy.rubble.map((piece) => piece.id) },
      ],
    },
    collisionProxies: architecture.collisionProxies,
    collisionRecipes: architecture.collisionProxies,
    walkableClaims,
    walkableRecipes: walkableClaims,
    protectedRoute,
    entropy,
    dressing: {
      mode: 'dungeon', enabled: false, suppressed: true, naturalSuppressed: true,
      masonryEnabled: true, weathering: entropy.weathering,
    },
    lightingAnchors: [
      { id: 'dungeon:light:entrance', kind: 'entrance-fill', ...worldRoot, intensity: 0.45 },
      ...(architecture.chamber ? [{ id: 'dungeon:light:chamber', kind: 'encounter-anchor', ...transformPoint(architecture.chamber.c, surfaceTransform), intensity: 0.28 }] : []),
    ],
    encounterAnchors: architecture.chamber ? [{
      id: 'dungeon:encounter:chamber', kind: 'chamber', nodeId: architecture.chamber.nodeId,
      ...transformPoint(architecture.chamber.c, surfaceTransform),
    }] : [],
    volume: deriveCaveVolume(graph),
  };
  plan.architectureHash = caveHash(
    seed, graph.seed, program.architectureSeed, program.index,
    architecture.pieces.length, architecture.collisionProxies.length,
  ).toString(16).padStart(8, '0');
  plan.entropyHash = caveHash(
    seed, entropy.seed, entropy.rubble.length,
    Math.round((entropy.weathering?.intensity || 0) * 1000),
  ).toString(16).padStart(8, '0');
  plan.hashes = { architecture: plan.architectureHash, entropy: plan.entropyHash };
  return deepFreeze(plan);
}

export const createDungeonPlan = createFortifiedDungeonPlan;
export const dungeonPlanForOutpost = createFortifiedDungeonPlan;

export function createFortifiedDungeonField(plan) {
  if (!plan?.graph) throw new TypeError('A dungeon plan is required.');
  return createCaveField(plan.graph);
}

export function buildFortifiedDungeonDressingPlan(plan, field, hydrology) {
  if (!plan?.graph) throw new TypeError('A dungeon plan is required.');
  return buildCaveDressingPlan(plan.graph, field, hydrology, { mode: 'dungeon', suppressNaturalDressing: true });
}

export function validateFortifiedDungeon(plan) {
  const errors = [];
  if (plan?.version !== FORTIFIED_DUNGEON_VERSION) errors.push('version');
  if (plan?.mode !== 'fortified-dungeon') errors.push('mode');
  if (plan?.program?.version !== FORTIFIED_DUNGEON_PROGRAM_VERSION
    || plan.program.channel !== 'dungeon-architecture'
    || !DUNGEON_PROGRAM_FAMILIES.includes(plan.program.family)
    || !Array.isArray(plan.program.features)
    || !Number.isInteger(plan.program.index)) errors.push('program');
  if (!plan?.surfaceContext?.anchorPieceId
    || plan.surfaceLink?.outpostPieceId !== plan.surfaceContext.anchorPieceId
    || plan.terrainOpening?.surfacePieceId !== plan.surfaceContext.anchorPieceId
    || !plan.surfaceLink?.surfaceRouteNodeIds?.includes('route:room')) errors.push('surface-context');
  if (!Number.isInteger(plan?.diagnostics?.graphAttempt)
    || plan.diagnostics.graphAttempt < 0
    || plan.diagnostics.graphAttempt >= plan.diagnostics.graphAttemptBudget) errors.push('generation-diagnostics');
  if (!plan?.surfaceLink?.surfacePlanId || !plan.surfaceLink.portalId) errors.push('surface-link');
  if (!plan?.entrance?.flatGround || !plan.terrainOpening?.occlusion?.enabled) errors.push('entrance-opening');
  if (!plan?.graph?.mainPath?.length || plan.graph.mainPath[0] !== plan.graph.entranceNodeId) errors.push('main-route');
  const navigation = plan?.localNavigation || plan?.navigation;
  if (navigation?.channel !== 'dungeon-local-navigation'
    || !navigation.nodes?.some((node) => node.id === 'surface:portal')
    || !navigation.edges?.some((edge) => edge.id === 'navigation:surface-portal')) errors.push('navigation-contract');
  for (const edge of navigation?.edges || []) {
    if (!Number.isFinite(edge.headroom) || edge.headroom < 2.0) errors.push(`headroom:${edge.id}`);
    if (!Number.isFinite(edge.grade) || edge.grade > 0.45) errors.push(`grade:${edge.id}`);
  }
  const navEdges = new Map((navigation?.edges || []).map((edge) => [`${edge.from}:${edge.to}`, edge]));
  for (let index = 0; index < (navigation?.protectedRoute?.length || 0) - 1; index++) {
    const from = navigation.protectedRoute[index], to = navigation.protectedRoute[index + 1];
    const edge = navEdges.get(`${from}:${to}`) || navEdges.get(`${to}:${from}`);
    if (!edge || !edge.enabled) errors.push(`navigation-route:${from}:${to}`);
  }
  if (!plan?.architecture?.pieces?.some((piece) => piece.kind === 'masonry-lintel')) errors.push('masonry-entrance');
  if (!plan?.architecture?.pieces?.some((piece) => piece.kind === 'chamber-shell')) errors.push('chamber');
  if (!plan?.architecture?.pieces?.some((piece) => piece.kind === 'masonry-floor')) errors.push('masonry-floor');
  if (!plan?.architecture?.pieces?.some((piece) => piece.kind === 'masonry-arch')) errors.push('masonry-arch');
  if (!plan?.architecture?.pieces?.some((piece) => piece.kind === 'masonry-pillar')) errors.push('masonry-pillar');
  if (plan?.architecture?.program?.id !== plan?.program?.id) errors.push('program-parity');
  const pieceIds = new Set(plan?.architecture?.pieces?.map((piece) => piece.id) || []);
  for (const proxy of plan?.collisionProxies || []) {
    if (!pieceIds.has(proxy.sourcePieceId)) errors.push(`proxy-orphan:${proxy.id}`);
  }
  for (const proxy of plan?.architecture?.renderProxies || []) {
    if (!pieceIds.has(proxy.sourcePieceId)) errors.push(`render-proxy-orphan:${proxy.id}`);
  }
  for (const claim of plan?.walkableClaims || []) {
    if (claim.sourcePieceId !== 'portal:dungeon-floor' && !pieceIds.has(claim.sourcePieceId)) {
      errors.push(`claim-orphan:${claim.id}`);
    }
  }
  if (!plan?.collisionProxies?.length || !plan?.walkableClaims?.length) errors.push('runtime-recipes');
  if (!plan?.dressing?.suppressed || plan.dressing.enabled || !plan.dressing.naturalSuppressed || !plan.dressing.masonryEnabled) errors.push('dressing-not-suppressed');
  if (plan?.entropy?.eventCount !== 1 || plan?.entropy?.events?.length !== 1) errors.push('entropy-count');
  const entropyEvent = plan?.entropy?.events?.[0];
  const rubbleIds = new Set(plan?.entropy?.rubble?.map((piece) => piece.id) || []);
  if (entropyEvent?.targetEdgeId && (!entropyEvent.supportCascade?.rootPieceId
    || !entropyEvent.supportCascade.rubbleIds?.every((id) => rubbleIds.has(id)))) errors.push('entropy-cascade');
  if (entropyEvent?.targetEdgeId && entropyEvent.blockedEdgeIds?.length
    && !(plan.architecture?.collapseOmissions?.length >= 2)) errors.push('entropy-omission');
  const supportIds = new Set(plan?.architecture?.supports?.map((support) => support.id) || []);
  for (const supportId of entropyEvent?.supportCascade?.failedSupportIds || []) {
    if (!supportIds.has(supportId)) errors.push(`missing-failed-support:${supportId}`);
  }
  for (const rubble of plan?.entropy?.rubble || []) {
    const edge = plan?.graph?.edges?.find((candidate) => candidate.id === rubble.sourceEdgeId);
    if (!edge || rubble.sourcePieceId !== `dungeon:passage:${rubble.sourceEdgeId}`) errors.push(`rubble-source:${rubble.id}`);
  }
  if (!plan?.entropy?.weathering?.channel || !Number.isFinite(plan.entropy.weathering.intensity)) errors.push('entropy-weathering');
  const blocked = new Set(plan?.entropy?.events?.[0]?.blockedEdgeIds || []);
  if (plan?.graph?.mainPath?.some((nodeId, index) => index > 0 && blocked.has(plan.graph.edges.find((edge) => edge.route === 'main' && edge.a === plan.graph.mainPath[index - 1] && edge.b === nodeId)?.id))) {
    errors.push('protected-route-blocked');
  }
  return { valid: errors.length === 0, errors, nodes: plan?.graph?.nodes?.length || 0, chambers: plan?.graph?.chambers?.length || 0 };
}

/** Cross-plan seam audit used by streaming and deterministic tests. */
export function validateFortifiedDungeonSurfaceLink(plan, surfacePlan) {
  const errors = [];
  const seam = surfacePlan?.dungeonSeam || surfacePlan?.intact?.dungeonSeam;
  if (!plan?.surfaceLink || !seam) errors.push('missing-surface-seam');
  if (plan?.surfaceLink?.surfacePlanId !== surfacePlan?.id) errors.push('surface-plan-id');
  if (plan?.surfaceLink?.outpostPieceId !== seam?.surfacePieceId) errors.push('surface-piece-id');
  if (plan?.surfaceLink?.portalId !== seam?.id) errors.push('surface-portal-id');
  const near = (a, b, tolerance = 1e-5) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  if (!near(plan?.entrance?.surface?.x, seam?.x) || !near(plan?.entrance?.surface?.z, seam?.z)) errors.push('entrance-transform');
  if (!near(plan?.terrainOpening?.x, seam?.x) || !near(plan?.terrainOpening?.z, seam?.z)) errors.push('opening-transform');
  if (plan?.terrainOpening?.surfacePieceId !== seam?.surfacePieceId) errors.push('opening-surface-piece');
  if (plan?.surfaceLink?.orientationYaw !== Number(surfacePlan?.worldTransform?.yaw || 0)) errors.push('orientation');
  if (!plan?.surfaceLink?.surfaceRouteNodeIds?.includes('route:room')) errors.push('surface-route-contract');
  if (plan?.surfaceLink?.trailContract?.gateId !== (surfacePlan?.intact?.curtain?.gate?.id || null)) errors.push('trail-contract');
  if (!(plan?.surfaceLink?.vegetationExclusion?.radius >= Math.max(34, Number(surfacePlan?.intact?.footprintRadius || 0)))) errors.push('vegetation-contract');
  return { valid: errors.length === 0, errors };
}

export function dungeonWorldPoint(plan, nodeId) {
  const node = plan?.graph?.nodes?.find((entry) => entry.id === nodeId);
  return node ? transformPoint(node.p, plan.surfaceTransform) : null;
}

export function dungeonOpeningContains(plan, x, z) {
  const opening = plan?.terrainOpening;
  return !!opening && Math.hypot(x - opening.x, z - opening.z) <= opening.radius;
}

export function dungeonOcclusionAt(plan, x, z) {
  const occlusion = plan?.terrainOpening?.occlusion;
  return !!occlusion && Math.hypot(x - plan.terrainOpening.x, z - plan.terrainOpening.z) <= occlusion.radius;
}

export function dungeonEntranceTerrainReport(plan, terrainAt) {
  if (typeof terrainAt !== 'function' || !plan?.entrance?.surface) {
    return { valid: false, reason: 'terrain sampler required' };
  }
  const p = plan.entrance.surface;
  const samples = [
    terrainAt(p.x, p.z), terrainAt(p.x + 1.5, p.z), terrainAt(p.x - 1.5, p.z),
    terrainAt(p.x, p.z + 1.5), terrainAt(p.x, p.z - 1.5),
  ];
  const finite = samples.every(Number.isFinite);
  const maxDelta = finite ? Math.max(...samples.map((value) => Math.abs(value - p.y))) : Infinity;
  return { valid: finite && maxDelta <= 0.35 && dungeonOpeningContains(plan, p.x, p.z),
    surfaceY: p.y, maxDelta, samples };
}

export function dungeonRegionsForNode(plan, nodeId) {
  const region = plan?.graph?.regions?.find((candidate) => candidate.nodeIds.includes(nodeId));
  if (!region) return [];
  return [region.id, ...(region.neighbors || [])];
}

export function createDungeonStreamingState(plan) {
  const active = new Set();
  return {
    update(nodeId) {
      const desired = new Set(dungeonRegionsForNode(plan, nodeId));
      for (const id of desired) active.add(id);
      for (const id of [...active]) if (!desired.has(id)) active.delete(id);
      return [...active].sort();
    },
    clear() { active.clear(); },
    snapshot() { return [...active].sort(); },
  };
}

export function dungeonProtectedRoute(plan) {
  return [...(plan?.protectedRoute || [])];
}
