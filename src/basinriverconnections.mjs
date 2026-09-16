import { refineBasinConnection } from './basinmembership.mjs';
import { drainageAnchors } from './basinoutlet.mjs';
import { RiverRoutePlanner } from './riverroute.mjs';
import { mergeRiverRoutes, segmentRiverGraph } from './rivergraph.mjs';
import { fitRiverComponent } from './rivercomponent.mjs';
import { prepareRiverJunctions } from './riverjunctions.mjs';
import { bakeSparseRiverComponent } from './riversparsemesh.mjs';

// The lake and the entire receiving network acquire one mesh owner. Inputs
// remain untouched when routing, profile solving or mesh validation rejects.
export function connectBasinToRiver(world, basin, network, {
  maxVisited = 2048, maxAttempts = 4, existingReaches = [],
} = {}) {
  if (!Number.isInteger(maxVisited) || maxVisited < 1 || maxVisited > 8192
    || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) throw new Error('Invalid lake river budget');
  if (!Array.isArray(existingReaches) || existingReaches.some(r => r.status !== 'fitted')) throw new Error('Invalid lake inlet reaches');
  const reject = (reason, visited = 0) => ({ status: 'rejected', reason, sourceId: basin?.id, visited });
  if (existingReaches.some(r => r.oceanMouth || !r.sourceClosure)) return reject('lake-already-has-outlet');
  if (network?.status !== 'fitted' || !network.routes?.length || network.basins?.length) return reject('invalid-receiving-network');
  let lake;
  try { lake = refineBasinConnection(world, basin); }
  catch (error) {
    if (['Basin connection grid budget exceeded', 'Uncontained refined basin'].includes(error.message)) return reject('uncontained-inland-lake');
    throw error;
  }
  const targets = riverConnectionTargets(lake, network);
  if (!targets.size) return reject('no-downstream-river');
  const distance = p => Math.min(...[...targets.values()].map(t => Math.hypot(t.x - p.x, t.z - p.z)));
  const anchors = drainageAnchors(world, lake, { x: lake.centerX, z: lake.centerZ })
    .sort((a, b) => distance(a) - distance(b) || a.x - b.x || a.z - b.z);
  let visited = 0, reason = 'lake-river-search-budget';
  for (const anchor of anchors.slice(0, maxAttempts)) {
    if (visited >= 8192) break;
    const source = { ...anchor, id: `lake-outlet:${lake.id}`, minY: lake.level, maxY: lake.level };
    const branch = new RiverRoutePlanner(world, { maxVisited: Math.min(maxVisited, 8192 - visited) })
      .route(source, { deferProfile: true, hydraulic: true, basinSource: lake, downstream: targets, requireDownstream: true });
    visited += branch.visited || 0;
    if (branch.status !== 'candidate' || !branch.joins) { reason = branch.reason || 'missed-receiving-river'; continue; }
    const owner = network.routes.find(r => r.points.some(p => p.id === branch.joins));
    const points = [...branch.points, ...owner.points.slice(owner.points.findIndex(p => p.id === branch.joins) + 1)].map(p => ({ ...p }));
    let arc = 0;
    for (let i = 0; i < points.length; i++) {
      if (i) arc += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
      points[i].arc = arc;
    }
    const routes = [...network.routes, { ...branch, points, outlet: points.at(-1).id }];
    const graph = mergeRiverRoutes(routes);
    if (graph.status !== 'candidate') { reason = graph.reason; continue; }
    const segmented = segmentRiverGraph(graph, Object.fromEntries(graph.nodes.map(p => [p.id, p.preferredY])));
    if (segmented.status !== 'candidate') { reason = segmented.reason; continue; }
    for (const reach of segmented.reaches) if (reach.source === source.id) reach.sourceClosure = false;
    let fitted;
    for (const junctionLength of [64, 96, 128, 192, 256]) {
      fitted = fitRiverComponent(world, segmented, { basins: [lake], junctionLength, mouthLength: 64,
        fixedLevels: [{ ...anchor, nodeId: source.id, minY: lake.level, maxY: lake.level }] });
      if (fitted.status !== 'fitted') break;
      const ownership = prepareRiverJunctions(fitted);
      if (ownership.status === 'prepared') break;
      fitted = ownership;
      if (ownership.reason !== 'junction-collar-too-short') break;
    }
    if (fitted.status !== 'fitted') { reason = fitted.reason; continue; }
    const component = { ...fitted, basins: [lake], reaches: [...fitted.reaches, ...existingReaches],
      graph, routes, sources: [...network.sources, source.id].sort() };
    const mesh = bakeSparseRiverComponent(world, component);
    if (mesh.status !== 'baked') { reason = mesh.reason; continue; }
    return { status: 'baked', component, mesh, sourceId: lake.id, joins: branch.joins, visited };
  }
  return reject(reason, visited);
}

function riverConnectionTargets(lake, network) {
  const incoming = new Map(), outgoing = new Map();
  for (const edge of network.graph.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    outgoing.set(edge.from, edge.to);
  }
  const levels = new Map(network.reaches.flatMap(r => r.points.filter(p => p.nodeId).map(p => [p.nodeId, p.waterY])));
  const targets = new Map();
  for (const route of network.routes) for (const p of route.points) {
    const waterY = levels.get(p.id);
    // Join an interior two-arm node, leaving existing confluences and spring
    // caps intact. Canonical 64m routing coordinates match the network planner.
    if (Number.isInteger(p.ix) && Number.isInteger(p.iz) && p.h >= -0.25
      && incoming.get(p.id) === 1 && outgoing.has(p.id) && Number.isFinite(waterY)
      && waterY < lake.level - 0.2 && Math.hypot(p.x - lake.centerX, p.z - lake.centerZ) <= 1400) {
      targets.set(p.id, { ...p, minY: waterY, maxY: waterY, waterY });
    }
  }
  return targets;
}

export function lakeRiverConnectionDistance(lake, network) {
  return Math.min(...[...riverConnectionTargets(lake, network).values()]
    .map(p => Math.hypot(p.x - lake.centerX, p.z - lake.centerZ)));
}
