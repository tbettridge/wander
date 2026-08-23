// Renderer-free inspection of a tower site's route.
//
// Made from the same immutable plan that feeds rendering, collision and
// walkable surfaces, so it answers the one question a screenshot cannot: can
// you actually get from the approach to every part of this thing. Useful when
// pointer lock, WebXR or an automation session cannot drive a player through
// one, and small enough to read from the in-game console.
//
// The underground has no equivalent here on purpose: an undercroft is a cave,
// and CaveExperiment already owns proving that its floor is walkable.

import {
  createFortifiedOutpostWalkableClaims,
  fortifiedOutpostClaimHeight,
} from './fortifiedoutpost.mjs';

export const RUIN_INSPECTION_VERSION = 1;
export const RUIN_PLAYER_RADIUS = 0.34;

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
  // What has to be reachable depends on what was built: a lone drum has no
  // gate to walk through, and asking for one would fail every watch site.
  const tier = intact.tier || 'keep';
  const required = ['route:approach', 'route:donjon-door', 'route:donjon'];
  if (tier !== 'watch') required.push('route:gate');
  if (tier === 'keep') {
    required.push('route:room', 'route:wallwalk', 'route:undercroft', 'route:undercroft-passage');
  }
  const errors = [];
  if (routeCheck.missingNodes.length) errors.push('route-missing-node');
  if (!routeCheck.continuous) errors.push('route-discontinuous');
  if (!routeCheck.clear) errors.push('route-collision');
  for (const nodeId of required) if (!nodes.has(nodeId)) errors.push(`route-required:${nodeId}`);
  if (tier === 'keep') {
    if (!ramp.present || !ramp.continuous || !ramp.monotonic) errors.push('ramp-continuity');
    if (ramp.grade > 0.34) errors.push('ramp-grade');
  }
  return {
    version: RUIN_INSPECTION_VERSION,
    kind: 'fortified-outpost',
    seed: intact.seed,
    valid: errors.length === 0,
    errors,
    route: routeCheck,
    ramp,
    tier,
    donjonPreserved: !!plan?.survivingPieces?.some((piece) => piece.id === 'tower:donjon'),
    undercroftPreserved: !!plan?.survivingPieces?.some((piece) => piece.id === 'undercroft:door'),
    collisionProxyCount: plan?.collisionProxies?.length || 0,
    claimCount: claims.length,
  };
}
