import { refineBasinConnection } from './basinmembership.mjs';
import { drainageAnchors } from './basinoutlet.mjs';
import { RiverRoutePlanner } from './riverroute.mjs';
import { mergeRiverRoutes, segmentRiverGraph } from './rivergraph.mjs';
import { fitRiverComponent } from './rivercomponent.mjs';
import { fitRiverReach } from './riverterrain.mjs';
import { prepareRiverJunctions } from './riverjunctions.mjs';
import { bakeSparseRiverComponent } from './riversparsemesh.mjs';
import { buildRiverHierarchy } from './riverhierarchy.mjs';

// The lake and the entire receiving network acquire one mesh owner. Inputs
// remain untouched when routing, profile solving or mesh validation rejects.
export function connectBasinToRiver(world, basin, network, {
  maxVisited = 2048, maxAttempts = 4, existingReaches = [],
  riverCharacter = false, riverMeanders = false, riverMorphology = false,
  lakeTransitions = false,
} = {}) {
  if (!Number.isInteger(maxVisited) || maxVisited < 1 || maxVisited > 8192
    || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8
    || typeof riverCharacter !== 'boolean' || typeof riverMeanders !== 'boolean'
    || typeof riverMorphology !== 'boolean' || typeof lakeTransitions !== 'boolean') {
    throw new Error('Invalid lake river budget');
  }
  if (!Array.isArray(existingReaches) || existingReaches.some(r => r.status !== 'fitted')) throw new Error('Invalid lake inlet reaches');
  const reject = (reason, visited = 0) => ({ status: 'rejected', reason, sourceId: basin?.id, visited });
  if (existingReaches.some(r => r.oceanMouth || !r.sourceClosure)) return reject('lake-already-has-outlet');
  if (network?.status !== 'fitted' || !network.routes?.length || !Array.isArray(network.reaches)
    || !network.reaches.length || network.basins?.length) return reject('invalid-receiving-network');
  let lake;
  try { lake = refineBasinConnection(world, basin); }
  catch (error) {
    if (['Basin connection grid budget exceeded', 'Uncontained refined basin'].includes(error.message)) return reject('uncontained-inland-lake');
    throw error;
  }
  // A network's graph/routes are the routing skeleton only. Character and
  // meander fitting can move the rendered bank tens of metres, so derive both
  // the candidate targets and the retained network routes from the fitted
  // sections. The raw graph is still used for topology (incoming/outgoing
  // ownership), never for the connection geometry.
  const authority = authoritativeNetworkRoutes(world, network);
  if (!authority) return reject('invalid-fitted-network');
  const targets = riverConnectionTargets(lake, network, authority);
  if (!targets.size) return reject('no-downstream-river');
  // The bounded lattice search needs the canonical cell centre to recognize a
  // target. Keep its hydraulic interval, then swap in the fitted displaced
  // coordinates immediately after the search returns the target ID.
  const routingTargets = new Map([...targets].map(([id, target]) => {
    const node = network.graph.nodes.find(value => value.id === id);
    return [id, { ...target, x: node.x, z: node.z }];
  }));
  const distance = p => Math.min(...[...targets.values()].map(t => Math.hypot(t.x - p.x, t.z - p.z)));
  const anchors = drainageAnchors(world, lake, { x: lake.centerX, z: lake.centerZ })
    .sort((a, b) => distance(a) - distance(b) || a.x - b.x || a.z - b.z);
  let visited = 0, reason = 'lake-river-search-budget';
  for (const anchor of anchors.slice(0, maxAttempts)) {
    if (visited >= 8192) break;
    const source = { ...anchor, id: `lake-outlet:${lake.id}`, minY: lake.level, maxY: lake.level };
    const branch = new RiverRoutePlanner(world, { maxVisited: Math.min(maxVisited, 8192 - visited) })
      .route(source, { deferProfile: true, hydraulic: true, basinSource: lake, downstream: routingTargets, requireDownstream: true });
    visited += branch.visited || 0;
    if (branch.status !== 'candidate' || !branch.joins) { reason = branch.reason || 'missed-receiving-river'; continue; }
    const target = targets.get(branch.joins);
    if (!target) { reason = 'missing-fitted-downstream-target'; continue; }
    const points = branch.points.map(p => ({ ...p }));
    // The route search stops at a canonical cell ID. Replace that final
    // coarse cell with the exact fitted section used as the target before the
    // graph is merged, so no stale target is published. Spread a displaced
    // cell's offset over the final route samples to keep the branch's turn
    // bounded instead of introducing a short, sharp approach segment.
    const coarse = points.at(-1), deltaX = target.x - coarse.x, deltaZ = target.z - coarse.z;
    const span = Math.min(4, points.length - 1);
    if (Math.hypot(deltaX, deltaZ) > 1e-6) {
      for (let i = points.length - 1 - span; i < points.length - 1; i++) {
        const t = (i - (points.length - 1 - span)) / span;
        const smooth = t * t * (3 - 2 * t);
        points[i].x += deltaX * smooth; points[i].z += deltaZ * smooth;
      }
    }
    points[points.length - 1] = { ...coarse, ...target, id: branch.joins,
      nodeId: branch.joins, waterY: target.waterY, preferredY: target.waterY };
    let arc = 0;
    for (let i = 0; i < points.length; i++) {
      if (i) arc += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
      points[i].arc = arc;
    }
    const routes = [...authority.routes, { ...branch, points, outlet: points.at(-1).id }];
    let graph;
    try { graph = mergeRiverRoutes(routes); }
    catch (error) {
      if (error.message === 'Conflicting drainage node coordinates') {
        reason = 'conflicting-downstream-geometry'; continue;
      }
      throw error;
    }
    if (graph.status !== 'candidate') { reason = graph.reason; continue; }
    const segmented = segmentRiverGraph(graph, Object.fromEntries(graph.nodes.map(p => [p.id, p.preferredY])));
    if (segmented.status !== 'candidate') { reason = segmented.reason; continue; }
    for (const reach of segmented.reaches) if (reach.source === source.id) reach.sourceClosure = false;
    let hierarchy = null;
    if (riverCharacter || riverMorphology) {
      const receivers = new Set(graph.edges.map(edge => edge.from));
      const terminals = graph.nodes.filter(node => !receivers.has(node.id)).map(node => ({
        nodeId: node.id, kind: 'ocean',
        verified: world._naturalHeight(node.x, node.z) < -0.25,
      }));
      hierarchy = buildRiverHierarchy(graph, segmented, {
        seed: world.seed, riverMorphology, defaultSourceContribution: 1, terminals,
      });
      if (hierarchy.status !== 'planned' || hierarchy.unsupportedProfiles.length) {
        reason = hierarchy.reason || hierarchy.unsupportedProfiles[0]?.reason || 'invalid-river-hierarchy';
        continue;
      }
    }
    const fit = channelProfiles => {
      let result;
      for (const junctionLength of [64, 96, 128, 192, 256]) {
        result = fitRiverComponent(world, segmented, { basins: [lake], junctionLength, mouthLength: 64,
          fixedLevels: [{ ...anchor, nodeId: source.id, minY: lake.level, maxY: lake.level }],
          ...(channelProfiles ? { channelProfiles } : {}) });
        if (result.status !== 'fitted') break;
        const ownership = prepareRiverJunctions(result);
        if (ownership.status === 'prepared') break;
        result = ownership;
        if (ownership.reason !== 'junction-collar-too-short') break;
      }
      return result;
    };
    let featureFallback = null;
    // Keep receiving reaches on their hierarchy profiles, but give the new
    // lake outlet the same conservative nominal envelope as the validated
    // connector. A unit lake source otherwise receives a narrow headwater
    // profile whose low bank crest can make the fixed lake level infeasible.
    const joinProfiles = hierarchy ? { ...hierarchy.channelProfiles } : null;
    if (joinProfiles) for (const reach of segmented.reaches) if (reach.source === source.id) {
      const profile = joinProfiles[reach.id];
      joinProfiles[reach.id] = { ...profile,
        halfWidth: Math.max(4, profile.halfWidth),
        startHalfWidth: Math.max(4, profile.startHalfWidth),
        endHalfWidth: Math.max(4, profile.endHalfWidth),
        morphology: false,
      };
    }
    let fitted = fit(joinProfiles);
    // A lake shore can impose a level at a point where a newly requested
    // width profile has no feasible bank crest. Keep the authoritative fitted
    // centreline and topology, then retry the joined component with the
    // existing conservative section envelope. This retains a safe connection
    // while allowing compatible reaches in the regional network to use the
    // latest character/morphology output.
    if (fitted.status !== 'fitted' && hierarchy) {
      featureFallback = fitted.reason || 'feature-fit-rejected';
      fitted = fit(null);
    }
    let component;
    if (fitted.status === 'fitted') {
      component = { ...fitted, basins: [lake], reaches: [...fitted.reaches, ...existingReaches],
        graph, routes, sources: [...network.sources, source.id].sort(),
        ...(hierarchy ? { hierarchy } : {}),
        ...(featureFallback ? { featureFallback } : {}) };
    } else if (hierarchy) {
      featureFallback = fitted.reason || 'feature-fit-rejected';
      component = fittedValidatedJoin(world, lake, network, authority, branch, anchor, target,
        graph, routes, existingReaches, source.id);
      if (component) component = { ...component, hierarchy, featureFallback };
    }
    if (!component) { reason = fitted.reason; continue; }
    const mesh = bakeConnectedComponent(world, component, lakeTransitions);
    if (mesh.status !== 'baked') {
      if (hierarchy && !component.featureFallback) {
        featureFallback = mesh.reason || 'feature-mesh-rejected';
        component = fittedValidatedJoin(world, lake, network, authority, branch, anchor, target,
          graph, routes, existingReaches, source.id);
        if (component) component = { ...component, hierarchy, featureFallback };
      }
      if (!component) { reason = mesh.reason; continue; }
      const fallbackMesh = bakeConnectedComponent(world, component, lakeTransitions);
      if (fallbackMesh.status !== 'baked') { reason = fallbackMesh.reason; continue; }
      return { status: 'baked', component, mesh: fallbackMesh, sourceId: lake.id, joins: branch.joins, visited };
    }
    return { status: 'baked', component, mesh, sourceId: lake.id, joins: branch.joins, visited };
  }
  return reject(reason, visited);
}

function riverConnectionTargets(lake, network, authority) {
  const incoming = new Map(), outgoing = new Map();
  for (const edge of network.graph.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    outgoing.set(edge.from, edge.to);
  }
  const targets = new Map();
  for (const [id, point] of authority.targets) {
    const waterY = point.waterY;
    const node = network.graph.nodes.find(value => value.id === id);
    // Join an interior two-arm node, leaving existing confluences and spring
    // caps intact. The target coordinates come from the fitted path above;
    // the raw node is consulted only to preserve the old topology filter.
    if (node && incoming.get(id) === 1 && outgoing.has(id)
      && worldNaturalLand(node, authority.world) && Number.isFinite(waterY)
      && waterY < lake.level - 0.2 && Math.hypot(point.x - lake.centerX, point.z - lake.centerZ) <= 1400) {
      targets.set(id, { ...point, minY: waterY, maxY: waterY, waterY });
    }
  }
  return targets;
}

// Convert fitted, potentially displaced reach sections into candidate routes
// with stable IDs at every prospective receiving cell. This is the sole
// geometry source used when a lake branch is merged into a network.
function authoritativeNetworkRoutes(world, network) {
  const graphNodes = new Map((network.graph?.nodes || []).map(node => [node.id, node]));
  const graphEdges = new Map((network.graph?.edges || []).map(edge => [edge.id, edge]));
  if (!graphNodes.size || !graphEdges.size) return null;
  const targetIds = new Set();
  const incoming = new Map(), outgoing = new Map();
  for (const edge of graphEdges.values()) {
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    outgoing.set(edge.from, (outgoing.get(edge.from) || 0) + 1);
  }
  for (const node of graphNodes.values()) {
    if (incoming.get(node.id) === 1 && outgoing.get(node.id) === 1
      && worldNaturalLand(node, world)) targetIds.add(node.id);
  }
  const targets = new Map(), routes = [];
  const routeOutgoing = new Map();
  for (const edge of graphEdges.values()) {
    if (!routeOutgoing.has(edge.from)) routeOutgoing.set(edge.from, []);
    routeOutgoing.get(edge.from).push(edge);
  }
  for (const edges of routeOutgoing.values()) edges.sort((a, b) => a.id.localeCompare(b.id));
  for (const reach of network.reaches) {
    if (reach.status !== 'fitted' || !Array.isArray(reach.points) || reach.points.length < 2) return null;
    const points = reach.points.map((point, index) => ({ ...point,
      id: point.nodeId || `fitted:${reach.id}:${index}`,
      waterY: point.waterY,
      preferredY: point.waterY,
      minY: Number.isFinite(point.minY) ? point.minY : point.waterY,
      maxY: Number.isFinite(point.maxY) ? point.maxY : point.waterY,
      h: Number.isFinite(point.h) ? point.h : (world ? world._naturalHeight(point.x, point.z) : point.waterY),
    }));
    const start = points[0].nodeId, end = points.at(-1).nodeId;
    if (typeof start !== 'string' || typeof end !== 'string') return null;
    const edgeIds = [];
    const seen = new Set();
    let current = start;
    while (current !== end) {
      const edges = routeOutgoing.get(current) || [];
      if (edges.length !== 1 || seen.has(current)) return null;
      const edge = edges[0];
      if (seen.has(edge.id)) return null;
      seen.add(edge.id); edgeIds.push(edge.id); current = edge.to;
    }
    const rawIds = [];
    const rawArcs = [0];
    for (let i = 0; i < edgeIds.length; i++) {
      const edge = graphEdges.get(edgeIds[i]);
      if (!edge) return null;
      if (!i) rawIds.push(edge.from);
      rawIds.push(edge.to);
      rawArcs.push(rawArcs.at(-1) + Math.max(0, edge.length));
    }
    if (rawIds.length < 2 || rawArcs.at(-1) <= 0) return null;
    const fittedArcs = [0];
    for (let i = 1; i < points.length; i++) fittedArcs.push(fittedArcs.at(-1)
      + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
    const fittedTotal = fittedArcs.at(-1);
    if (!(fittedTotal > 0)) return null;
    const assignedIndices = new Set();
    for (let rawIndex = 1; rawIndex + 1 < rawIds.length; rawIndex++) {
      const id = rawIds[rawIndex];
      if (!targetIds.has(id)) continue;
      const existingIndex = points.findIndex((point, index) => index > 0 && index + 1 < points.length
        && point.id === id);
      if (existingIndex >= 0) {
        assignedIndices.add(existingIndex);
        targets.set(id, { ...points[existingIndex], id });
        continue;
      }
      const desiredArc = rawArcs[rawIndex] / rawArcs.at(-1) * fittedTotal;
      const candidates = [];
      for (let i = 1; i + 1 < points.length; i++) candidates.push({
        index: i, distance: Math.abs(fittedArcs[i] - desiredArc),
      });
      candidates.sort((a, b) => a.distance - b.distance || a.index - b.index);
      const choice = candidates.find(candidate => !assignedIndices.has(candidate.index)
        && !points[candidate.index].nodeId);
      if (!choice) return null;
      const fittedIndex = choice.index;
      assignedIndices.add(fittedIndex);
      points[fittedIndex].id = id;
      targets.set(id, { ...points[fittedIndex], id });
    }
    routes.push({ ...reach, status: 'candidate', source: points[0].id, points, outlet: points.at(-1).id, edgeIds });
  }
  return { world, routes, targets };
}

// Compatibility join used when the requested width/morphology profile cannot
// satisfy a lake shore interval after the existing fitted network is merged.
// It keeps every accepted receiving section (including its displaced path),
// splits only the target section to expose a real three-arm collar, and fits
// the new lake outlet with the conservative legacy envelope.
function fittedValidatedJoin(world, lake, network, authority, branch, anchor, target,
  graph, routes, existingReaches, sourceId) {
  const branchSource = routes.at(-1)?.source === sourceId ? routes.at(-1) : branch;
  const branchPoints = branchSource.points.map(point => ({ ...point }));
  if (branchPoints.length < 2 || !target) return null;
  branchPoints[branchPoints.length - 1] = { ...branchPoints.at(-1), ...target,
    id: target.id, nodeId: target.id, waterY: target.waterY, preferredY: target.waterY };
  const branchRoute = { ...branch, status: 'candidate', source: sourceId, outlet: target.id, points: branchPoints };
  const branchReach = fitRiverReach(world, branchRoute, {
    id: sourceId, basins: [lake], sourceClosure: false, oceanMouth: false,
    halfWidth: 4, fixedLevels: [
      { ...anchor, nodeId: sourceId, minY: lake.level, maxY: lake.level },
      { x: target.x, z: target.z, nodeId: target.id, minY: target.waterY, maxY: target.waterY },
    ],
  });
  if (branchReach.status !== 'fitted' || !branchReach.basinIds?.includes(lake.id)) return null;

  const bounds = points => {
    const radius = point => Math.max(...['left', 'right'].map(side =>
      point[`${side}Width`] + point[`${side}BankWidth`] + point[`${side}BlendWidth`]));
    return { minX: Math.min(...points.map(point => point.x - radius(point))),
      minZ: Math.min(...points.map(point => point.z - radius(point))),
      maxX: Math.max(...points.map(point => point.x + radius(point))),
      maxZ: Math.max(...points.map(point => point.z + radius(point))) };
  };
  const rebase = points => {
    const copy = points.map(point => ({ ...point }));
    let arc = 0;
    for (let i = 0; i < copy.length; i++) {
      if (i) arc += Math.hypot(copy[i].x - copy[i - 1].x, copy[i].z - copy[i - 1].z);
      copy[i].arc = arc;
    }
    return copy;
  };
  const reaches = [];
  let split = false;
  for (const route of authority.routes) {
    const index = route.points.findIndex(point => point.id === target.id);
    if (index <= 0 || index >= route.points.length - 1) {
      reaches.push({ ...route, status: 'fitted', points: rebase(route.points), bounds: bounds(route.points) });
      continue;
    }
    const before = route.points.slice(0, index + 1).map(point => ({ ...point }));
    const after = route.points.slice(index).map(point => ({ ...point }));
    before.at(-1).id = target.id; before.at(-1).nodeId = target.id;
    after[0].id = target.id; after[0].nodeId = target.id;
    reaches.push({ ...route, id: `${route.id}:upstream:${target.id}`, status: 'fitted',
      sourceClosure: route.sourceClosure, oceanMouth: false, points: rebase(before), bounds: bounds(before) });
    reaches.push({ ...route, id: `${route.id}:downstream:${target.id}`, status: 'fitted',
      sourceClosure: false, oceanMouth: route.oceanMouth, points: rebase(after), bounds: bounds(after) });
    split = true;
  }
  if (!split) return null;
  reaches.push(branchReach, ...existingReaches.map(reach => ({ ...reach,
    points: rebase(reach.points),
  })));
  const junctions = [...(network.junctions || []).filter(junction => junction.nodeId !== target.id), {
    id: `junction:${target.id}`, nodeId: target.id, x: target.x, z: target.z, waterY: target.waterY,
    incomingReachIds: [], outgoingReachId: null,
  }].map(junction => {
    // Splitting the authoritative receiving reach changes the reach IDs at the
    // new collar. Derive ownership from the final fitted endpoints so the
    // descriptor and mesh agree, including any accepted lake inlets retained
    // below. Existing junction metadata still contributes its stable ID and
    // level length, while endpoint IDs are always authoritative here.
    const incomingReachIds = reaches.filter(reach => reach.points.at(-1)?.nodeId === junction.nodeId)
      .map(reach => reach.id).sort();
    const outgoing = reaches.find(reach => reach.points[0]?.nodeId === junction.nodeId);
    return { ...junction, incomingReachIds,
      outgoingReachId: outgoing?.id || null };
  });
  return { status: 'fitted', reaches, junctions, basins: [lake], graph, routes,
    sources: [...(network.sources || []), sourceId].sort() };
}

function worldNaturalLand(node, world) {
  return Number.isFinite(node?.x) && Number.isFinite(node?.z)
    && (!world || world._naturalHeight(node.x, node.z) >= -0.25);
}

function bakeConnectedComponent(world, component, lakeTransitions) {
  const mesh = bakeSparseRiverComponent(world, component, { lakeTransitions });
  if (mesh.status === 'baked' || !lakeTransitions) return mesh;
  // Contacts only author currents. If their bounded ownership survey cannot
  // certify this component, retain the already validated geometry rather than
  // dropping a safe lake/rivers system from the regional plan.
  return bakeSparseRiverComponent(world, component);
}

export function lakeRiverConnectionDistance(lake, network) {
  const authority = authoritativeNetworkRoutes(null, network);
  if (!authority) return Infinity;
  const targets = riverConnectionTargets(lake, network, authority);
  return Math.min(...[...targets.values()]
    .map(p => Math.hypot(p.x - lake.centerX, p.z - lake.centerZ)));
}
