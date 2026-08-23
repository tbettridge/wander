// Renderer-free inspection helpers for the procedural ruin slices.
//
// These reports are intentionally made from the same immutable semantic plans
// that feed rendering, collision, and walkable surfaces. They provide a useful
// deterministic fallback when pointer lock, WebXR, or a browser automation
// session cannot drive a player through an instance, and are also small enough
// to expose through the in-game debug console.

import {
  createFortifiedOutpostWalkableClaims,
  fortifiedOutpostClaimHeight,
} from './fortifiedoutpost.mjs';
import {
  dungeonEntranceTerrainReport,
  dungeonWorldPoint,
  createFortifiedDungeonPlan,
} from './fortifieddungeon.mjs';

export const RUIN_INSPECTION_VERSION = 1;
export const RUIN_PLAYER_RADIUS = 0.34;

function finitePoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y)
    && Number.isFinite(point?.z);
}

function closestOnSegment(proxy, x, z) {
  const dx = proxy.bx - proxy.ax, dz = proxy.bz - proxy.az;
  const length2 = dx * dx + dz * dz;
  const t = length2
    ? Math.max(0, Math.min(1, ((x - proxy.ax) * dx + (z - proxy.az) * dz) / length2))
    : 0;
  const px = proxy.ax + dx * t, pz = proxy.az + dz * t;
  return Math.hypot(x - px, z - pz);
}

function proxyHit(proxies, point, playerRadius = RUIN_PLAYER_RADIUS) {
  for (const proxy of proxies || []) {
    if (!Number.isFinite(proxy.minY) || !Number.isFinite(proxy.maxY)) continue;
    if (point.y < proxy.minY - 0.2 || point.y > proxy.maxY + 0.2) continue;
    const reach = playerRadius + Math.max(0, Number(proxy.thickness) || 0) * 0.5;
    if (closestOnSegment(proxy, point.x, point.z) < reach) return proxy;
  }
  return null;
}

function routeReport(route, nodes, proxies, { samplesPerSegment = 12 } = {}) {
  const missingNodes = [];
  const blockedSamples = [];
  const segments = [];
  let maxGrade = 0;
  let minClearance = Infinity;

  for (let index = 0; index < route.length - 1; index++) {
    const from = nodes.get(route[index]), to = nodes.get(route[index + 1]);
    if (!from || !to) {
      missingNodes.push(!from ? route[index] : route[index + 1]);
      continue;
    }
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const horizontal = Math.hypot(dx, dz);
    maxGrade = Math.max(maxGrade, Math.abs(dy) / Math.max(0.01, horizontal));
    const segment = {
      from: from.id, to: to.id, horizontal, vertical: dy,
      grade: Math.abs(dy) / Math.max(0.01, horizontal),
      blockedSamples: 0,
    };
    for (let sample = 1; sample < samplesPerSegment; sample++) {
      const t = sample / samplesPerSegment;
      const point = {
        x: from.x + dx * t, y: from.y + dy * t, z: from.z + dz * t,
      };
      const hit = proxyHit(proxies, point);
      if (hit) {
        segment.blockedSamples++;
        blockedSamples.push({
          from: from.id, to: to.id, t, sourcePieceId: hit.sourcePieceId || hit.id,
          x: point.x, y: point.y, z: point.z,
        });
      } else {
        minClearance = Math.min(minClearance, ...(proxies || []).map((proxy) => {
          if (point.y < proxy.minY - 0.2 || point.y > proxy.maxY + 0.2) return Infinity;
          return closestOnSegment(proxy, point.x, point.z)
            - Math.max(0, Number(proxy.thickness) || 0) * 0.5;
        }));
      }
    }
    segments.push(segment);
  }
  return {
    nodeCount: route.length,
    segments,
    missingNodes: [...new Set(missingNodes)],
    blockedSamples,
    maxGrade,
    minClearance: Number.isFinite(minClearance) ? minClearance : null,
    continuous: missingNodes.length === 0 && segments.every((segment) => segment.horizontal > 0.1),
    clear: blockedSamples.length === 0,
  };
}

function rampReport(claims) {
  const ramp = claims.find((claim) => claim.mode === 'ramp');
  if (!ramp) return { present: false, continuous: false, grade: null, samples: [] };
  const horizontal = Math.hypot(ramp.bx - ramp.ax, ramp.bz - ramp.az);
  const grade = Math.abs(ramp.by - ramp.ay) / Math.max(0.01, horizontal);
  const samples = [];
  let previous = null;
  let monotonic = true;
  for (let index = 0; index <= 12; index++) {
    const t = index / 12;
    const x = ramp.ax + (ramp.bx - ramp.ax) * t;
    const z = ramp.az + (ramp.bz - ramp.az) * t;
    const y = fortifiedOutpostClaimHeight(ramp, x, z);
    samples.push({ t, x, z, y });
    if (previous !== null && y < previous - 1e-6) monotonic = false;
    previous = y;
  }
  return {
    present: true, continuous: horizontal > 8 && Number.isFinite(ramp.width) && ramp.width >= 1.8,
    horizontal, grade, width: ramp.width, monotonic, samples,
  };
}

/**
 * Inspect the authored outpost's protected route without creating any THREE
 * objects. `valid` is deliberately strict: a route proxy intersection is a
 * traversal defect, not a warning that can be hidden by a visual smoke test.
 */
export function inspectFortifiedOutpostTraversal(plan, options = {}) {
  const intact = plan?.intact || plan;
  if (!intact?.circulation?.nodes) {
    return { version: RUIN_INSPECTION_VERSION, kind: 'fortified-outpost', valid: false, errors: ['missing-plan'] };
  }
  const nodes = new Map(intact.circulation.nodes.map((node) => [node.id, node]));
  const claims = createFortifiedOutpostWalkableClaims(plan?.intact ? plan : { ...plan, walkableRecipes: plan?.walkableRecipes });
  const route = intact.circulation.protectedRoute || [];
  const routeCheck = routeReport(route, nodes, plan?.collisionProxies || [], options);
  const ramp = rampReport(claims);
  const required = ['route:approach', 'route:gate', 'route:courtyard', 'route:room', 'route:lookout'];
  const errors = [];
  if (routeCheck.missingNodes.length) errors.push('route-missing-node');
  if (!routeCheck.continuous) errors.push('route-discontinuous');
  if (!routeCheck.clear) errors.push('route-collision');
  for (const nodeId of required) if (!nodes.has(nodeId)) errors.push(`route-required:${nodeId}`);
  if (!ramp.present || !ramp.continuous || !ramp.monotonic) errors.push('ramp-continuity');
  if (ramp.grade > 0.34) errors.push('ramp-grade');
  return {
    version: RUIN_INSPECTION_VERSION,
    kind: 'fortified-outpost',
    seed: intact.seed,
    valid: errors.length === 0,
    errors,
    route: routeCheck,
    ramp,
    lookoutPreserved: !!plan?.survivingPieces?.some((piece) => piece.id === 'tower:lookout')
      && !!plan?.survivingPieces?.some((piece) => piece.id === 'lookout:landing'),
    collisionProxyCount: plan?.collisionProxies?.length || 0,
    claimCount: claims.length,
  };
}

function dungeonRouteReport(plan, proxies = [], options = {}) {
  const route = plan?.graph?.mainPath || [];
  const points = new Map(route.map((nodeId) => {
    const point = dungeonWorldPoint(plan, nodeId);
    return [nodeId, point ? { ...point, id: nodeId } : null];
  }).filter(Boolean));
  const segments = [];
  let maxGrade = 0;
  for (let index = 0; index < route.length - 1; index++) {
    const from = points.get(route[index]), to = points.get(route[index + 1]);
    if (!finitePoint(from) || !finitePoint(to)) continue;
    const horizontal = Math.hypot(to.x - from.x, to.z - from.z);
    const grade = Math.abs(to.y - from.y) / Math.max(0.01, horizontal);
    maxGrade = Math.max(maxGrade, grade);
    segments.push({ from: route[index], to: route[index + 1], horizontal, vertical: to.y - from.y, grade });
  }
  const collision = routeReport(route, points, proxies, options);
  return {
    nodeCount: route.length,
    segments,
    maxGrade,
    continuous: route.length > 1 && segments.length === route.length - 1,
    collision,
  };
}

function dungeonNavigationReport(plan) {
  const navigation = plan?.localNavigation || plan?.navigation;
  const edges = new Map((navigation?.edges || []).map((edge) => [`${edge.from}:${edge.to}`, edge]));
  const route = navigation?.protectedRoute || [];
  const missingEdges = [];
  let minHeadroom = Infinity, maxGrade = 0;
  for (let index = 0; index < route.length - 1; index++) {
    const from = route[index], to = route[index + 1];
    const edge = edges.get(`${from}:${to}`) || edges.get(`${to}:${from}`);
    if (!edge || !edge.enabled) {
      missingEdges.push(`${from}:${to}`);
      continue;
    }
    minHeadroom = Math.min(minHeadroom, edge.headroom);
    maxGrade = Math.max(maxGrade, edge.grade);
  }
  return {
    present: !!navigation,
    nodeCount: navigation?.nodes?.length || 0,
    edgeCount: navigation?.edges?.length || 0,
    missingEdges,
    minHeadroom: Number.isFinite(minHeadroom) ? minHeadroom : null,
    maxGrade,
    bidirectional: (navigation?.edges || []).filter((edge) => edge.bidirectional).length,
    valid: !!navigation && missingEdges.length === 0
      && (!Number.isFinite(minHeadroom) || minHeadroom >= 2.0) && maxGrade <= 0.45,
  };
}

/**
 * Inspect the dungeon seam and the currently published semantic walkables.
 * `runtimeReady` is supplied by the optional main-loop stream handle; the
 * terrain/SDF handoff remains explicit because CaveExperiment owns that path.
 */
export function inspectFortifiedDungeonTraversal(planOrSeed, options = {}) {
  const plan = planOrSeed?.graph ? planOrSeed
    : createFortifiedDungeonPlan({ seed: planOrSeed ?? 1, surfaceY: options.surfaceY ?? 0.12 });
  if (!plan?.graph) {
    return { version: RUIN_INSPECTION_VERSION, kind: 'fortified-dungeon', valid: false, errors: ['missing-plan'] };
  }
  const terrain = dungeonEntranceTerrainReport(plan, options.terrainAt || (() => plan.entrance.surface.y));
  const route = dungeonRouteReport(plan, plan.collisionProxies || [], options);
  const navigation = dungeonNavigationReport(plan);
  const firstClaim = plan.walkableClaims?.find((claim) => claim.mode === 'ramp');
  const claimedMainEdges = new Set(
    (plan.walkableClaims || []).flatMap((claim) => claim.routeNodeIds || []),
  );
  const unclaimedNodes = (plan.graph.mainPath || []).filter((nodeId) => !claimedMainEdges.has(nodeId));
  const errors = [];
  if (!terrain.valid) errors.push('entrance-terrain');
  if (!route.continuous) errors.push('route-discontinuous');
  if (!route.collision.clear) errors.push('route-collision');
  if (!firstClaim) errors.push('missing-descent-claim');
  if (unclaimedNodes.length > 1) errors.push('route-claim-coverage');
  if (!navigation.valid) errors.push('navigation-route');
  const runtimeReady = !!options.runtime && typeof options.runtime.snapshot === 'function';
  return {
    version: RUIN_INSPECTION_VERSION,
    kind: 'fortified-dungeon',
    seed: plan.seed,
    valid: errors.length === 0,
    errors,
    runtimeReady,
    runtimeGap: runtimeReady
      ? 'CaveExperiment terrain/SDF opening and manual pointer-locked traversal remain separate validation seams'
      : 'dungeon stream handle not supplied; use the main-loop fortifiedDungeons handle',
    runtimeActive: runtimeReady ? options.runtime.snapshot().length : 0,
    entrance: {
      flatGround: !!plan.entrance.flatGround,
      terrain,
      opening: plan.terrainOpening,
    },
    route,
    navigation,
    claims: {
      count: plan.walkableClaims?.length || 0,
      firstDescent: !!firstClaim,
      unclaimedMainPathNodes: unclaimedNodes,
    },
    entropy: {
      eventCount: plan.entropy?.eventCount || 0,
      blockedEdgeIds: plan.entropy?.events?.flatMap((event) => event.blockedEdgeIds || []) || [],
      protectedRoute: [...(plan.protectedRoute || [])],
    },
  };
}

export function inspectFortifiedRuinPair({ outpost, dungeon, seed = 1 } = {}) {
  const outpostPlan = outpost || undefined;
  const dungeonPlan = dungeon || createFortifiedDungeonPlan({ seed, surfacePlan: outpostPlan });
  return {
    version: RUIN_INSPECTION_VERSION,
    outpost: outpostPlan ? inspectFortifiedOutpostTraversal(outpostPlan) : null,
    dungeon: inspectFortifiedDungeonTraversal(dungeonPlan),
  };
}
