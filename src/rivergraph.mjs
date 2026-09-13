// Shared junction heads for a complete drainage component. Each edge constrains
// the downstream head to [upstream - allowedDrop, upstream]. This is a system
// of difference constraints, including reverse constraints from fixed crossings.
import { drainageOrder } from './riverprofile.mjs';
import { clamp } from './noise.js';

export function solveRiverGraph(nodes, edges, { maxGrade = 0.025 } = {}) {
  if (!Number.isFinite(maxGrade) || maxGrade < 0) throw new Error('Invalid river grade');
  const topology = drainageOrder(nodes, edges);
  if (topology.status !== 'accepted') return topology;
  const byId = new Map(), incident = new Map();
  for (const node of nodes) {
    if (![node.minY, node.maxY, node.preferredY].every(Number.isFinite)) throw new Error('Invalid junction interval');
    byId.set(node.id, { ...node, lower: node.minY, upper: node.maxY });
    incident.set(node.id, []);
  }
  const ids = new Set();
  for (const edge of edges) {
    if (ids.has(edge.id)) throw new Error('Duplicate drainage edge');
    ids.add(edge.id);
    if (!Number.isFinite(edge.length) || edge.length <= 0) throw new Error('Invalid river edge length');
    if (edge.maxDrop !== undefined && (!Number.isFinite(edge.maxDrop) || edge.maxDrop < 0)) {
      throw new Error('Invalid river edge drop');
    }
    const constraint = { ...edge, drop: Math.min(edge.maxDrop ?? Infinity,
      edge.fall ? Infinity : edge.length * maxGrade) };
    incident.get(edge.from).push(constraint);
    incident.get(edge.to).push(constraint);
  }
  const conflict = node => ({ status: 'retain-legacy', reason: 'incompatible-junction-levels',
    id: node.id, minY: node.lower, maxY: node.upper });
  // Queue only changed intervals. Propagating both ways is essential at a
  // confluence: the lower tributary can constrain another tributary upstream.
  const propagate = seeds => {
    const queue = [...seeds], queued = new Set(queue);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const id = queue[cursor]; queued.delete(id);
      const node = byId.get(id);
      if (node.lower > node.upper + 1e-9) return conflict(node);
      for (const edge of incident.get(id)) {
        const a = byId.get(edge.from), b = byId.get(edge.to);
        const limits = [[a, Math.max(a.lower, b.lower), Math.min(a.upper, b.upper + edge.drop)],
          [b, Math.max(b.lower, a.lower - edge.drop), Math.min(b.upper, a.upper)]];
        for (const [target, lower, upper] of limits) {
          if (lower > upper + 1e-9) return conflict({ ...target, lower, upper });
          if (lower > target.lower + 1e-10 || upper < target.upper - 1e-10) {
            target.lower = lower; target.upper = upper;
            if (!queued.has(target.id)) { queue.push(target.id); queued.add(target.id); }
          }
        }
      }
    }
    return null;
  };
  let failure = propagate(topology.order);
  if (failure) return failure;
  // Fix one head at a time, then propagate its implications before selecting
  // another. Independent per-reach fits cannot enforce this shared decision.
  const levels = {};
  for (const id of topology.order) {
    const node = byId.get(id);
    const level = clamp(node.preferredY, node.lower, node.upper);
    node.lower = node.upper = level;
    levels[id] = level;
    failure = propagate([id]);
    if (failure) return failure;
  }
  return { status: 'accepted', levels, order: topology.order };
}

// Merge canonical routing nodes before fitting their river sections. Shared
// coordinates/intervals are checked instead of whichever source arrived last
// silently taking ownership of a junction.
export function mergeRiverRoutes(routes) {
  const nodes = new Map(), edges = new Map();
  for (const route of [...routes].sort((a, b) => String(a.source).localeCompare(String(b.source)))) {
    if (route.status !== 'candidate') return { status: 'retain-legacy', reason: 'unresolved-component-route' };
    for (let i = 0; i < route.points.length; i++) {
      const point = route.points[i], previous = nodes.get(point.id);
      if (previous) {
        if (previous.x !== point.x || previous.z !== point.z) throw new Error('Conflicting drainage node coordinates');
        previous.minY = Math.max(previous.minY, point.minY);
        previous.maxY = Math.min(previous.maxY, point.maxY);
        previous.preferredY = Math.min(previous.preferredY, point.waterY);
      } else nodes.set(point.id, { id: point.id, x: point.x, z: point.z,
        minY: point.minY, maxY: point.maxY, preferredY: point.waterY });
      if (!i) continue;
      const from = route.points[i - 1], id = `${from.id}>${point.id}`;
      if (!edges.has(id)) edges.set(id, { id, from: from.id, to: point.id,
        length: Math.hypot(point.x - from.x, point.z - from.z) });
    }
  }
  const graph = { nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  // Rivers may merge, but an unexplained split gives a component two different
  // downstream owners. Keep it unresolved until an explicit distributary exists.
  const downstream = new Map();
  for (const edge of graph.edges) {
    if (downstream.has(edge.from) && downstream.get(edge.from) !== edge.to) {
      return { status: 'retain-legacy', reason: 'ambiguous-downstream-owner', id: edge.from };
    }
    downstream.set(edge.from, edge.to);
  }
  const topology = drainageOrder(graph.nodes, graph.edges);
  return topology.status === 'accepted' ? { status: 'candidate', ...graph } : topology;
}

// Partition an already merged, solved graph into edge-disjoint reaches. Every
// source, confluence and mouth is a boundary. The junction records are the only
// owners of shared endpoints; reach meshes may later meet them but must not
// each invent their own confluence topology.
export function segmentRiverGraph(graph, levels) {
  if (graph?.status !== 'candidate' || !levels || typeof levels !== 'object') {
    throw new Error('Invalid solved river graph');
  }
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map(graph.nodes.map(node => [node.id, []]));
  const outgoing = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) throw new Error('Unresolved drainage endpoint');
    incoming.get(edge.to).push(edge); outgoing.get(edge.from).push(edge);
  }
  for (const node of graph.nodes) {
    if (!Number.isFinite(levels[node.id])) throw new Error('Missing solved river level');
    if (outgoing.get(node.id).length > 1) {
      return { status: 'retain-legacy', reason: 'ambiguous-downstream-owner', id: node.id };
    }
  }
  const boundary = id => incoming.get(id).length !== 1 || outgoing.get(id).length !== 1;
  const seen = new Set(), reaches = [];
  const starts = graph.nodes.filter(node => boundary(node.id)).sort((a, b) => a.id.localeCompare(b.id));
  for (const start of starts) for (const first of outgoing.get(start.id)) {
    if (seen.has(first.id)) continue;
    const edges = [], points = [{ ...start, waterY: levels[start.id] }];
    let edge = first;
    while (edge) {
      if (seen.has(edge.id)) throw new Error('Drainage edge assigned twice');
      seen.add(edge.id); edges.push(edge.id);
      const node = byId.get(edge.to);
      points.push({ ...node, waterY: levels[node.id] });
      if (boundary(node.id)) break;
      edge = outgoing.get(node.id)[0];
    }
    const end = points.at(-1), payload = { from: start.id, to: end.id, edges };
    reaches.push({ status: 'candidate', id: `graph-reach:${descriptorId(payload)}`,
      source: start.id, outlet: end.id, points, edgeIds: edges,
      sourceClosure: incoming.get(start.id).length === 0,
      oceanMouth: outgoing.get(end.id).length === 0 && Math.abs(levels[end.id]) <= 1e-9 });
  }
  if (seen.size !== graph.edges.length) return { status: 'retain-legacy', reason: 'unassigned-drainage-edge' };
  const reachAtStart = new Map(reaches.map(reach => [reach.source, reach.id]));
  const reachAtEnd = new Map();
  for (const reach of reaches) {
    if (!reachAtEnd.has(reach.outlet)) reachAtEnd.set(reach.outlet, []);
    reachAtEnd.get(reach.outlet).push(reach.id);
  }
  const junctions = graph.nodes.filter(node => incoming.get(node.id).length > 1).map(node => ({
    id: `junction:${node.id}`, nodeId: node.id, x: node.x, z: node.z, waterY: levels[node.id],
    incomingReachIds: (reachAtEnd.get(node.id) || []).sort(),
    outgoingReachId: reachAtStart.get(node.id) || null,
  })).sort((a, b) => a.id.localeCompare(b.id));
  return { status: 'candidate', reaches: reaches.sort((a, b) => a.id.localeCompare(b.id)), junctions };
}

function descriptorId(value) {
  // FNV-1a is only an identity suffix; descriptor integrity is still provided
  // by the containing plan hash.
  let hash = 2166136261;
  for (const character of JSON.stringify(value)) {
    hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
