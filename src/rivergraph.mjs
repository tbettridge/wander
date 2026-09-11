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
    const constraint = { ...edge, drop: edge.fall ? Infinity : edge.length * maxGrade };
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
