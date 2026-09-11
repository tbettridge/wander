// Longitudinal water constraints. Elevation belongs to a section of the river,
// never to its lateral bank vertices. Infeasible reaches remain explicit
// migration failures; callers must not repair them by curling the water edge.
import { clamp } from './noise.js';

export function solveRiverProfile(sections, { maxGrade = 0.025 } = {}) {
  if (!Array.isArray(sections) || sections.length < 2 || !Number.isFinite(maxGrade) || maxGrade < 0) {
    throw new Error('Invalid river profile');
  }
  const count = sections.length, lower = new Float64Array(count), upper = new Float64Array(count);
  const drop = new Float64Array(count - 1);
  for (let i = 0; i < count; i++) {
    const s = sections[i];
    if (![s.arc, s.minY, s.maxY, s.preferredY].every(Number.isFinite) || (i && s.arc <= sections[i - 1].arc)) {
      throw new Error('Invalid river section bounds');
    }
    lower[i] = s.minY; upper[i] = s.maxY;
    if (i) drop[i - 1] = sections[i - 1].fall ? Infinity : (s.arc - sections[i - 1].arc) * maxGrade;
  }
  const conflict = i => ({ status: 'retain-legacy', reason: 'incompatible-water-intervals',
    section: i, id: sections[i].id || null, minY: lower[i], maxY: upper[i] });
  // Propagate feasible intervals in both directions along the chain. The
  // downstream level cannot exceed upstream, nor fall faster than the declared
  // grade. A real fall is a separately authored edge, not a steep mesh cell.
  for (let i = 0; i < count; i++) {
    if (i) {
      lower[i] = Math.max(lower[i], lower[i - 1] - drop[i - 1]);
      upper[i] = Math.min(upper[i], upper[i - 1]);
    }
    if (lower[i] > upper[i] + 1e-9) return conflict(i);
  }
  for (let i = count - 2; i >= 0; i--) {
    lower[i] = Math.max(lower[i], lower[i + 1]);
    upper[i] = Math.min(upper[i], upper[i + 1] + drop[i]);
    if (lower[i] > upper[i] + 1e-9) return conflict(i);
  }
  const levels = new Float64Array(count), falls = [];
  levels[0] = clamp(sections[0].preferredY, lower[0], upper[0]);
  for (let i = 1; i < count; i++) {
    const min = Math.max(lower[i], levels[i - 1] - drop[i - 1]);
    const max = Math.min(upper[i], levels[i - 1]);
    levels[i] = clamp(sections[i].preferredY, min, max);
    if (sections[i - 1].fall && levels[i - 1] > levels[i] + 0.01) {
      falls.push({ from: i - 1, to: i, lipY: levels[i - 1], poolY: levels[i] });
    }
  }
  return { status: 'accepted', levels, falls };
}

// Reject cycles before fitting reaches. Basin nodes are ordinary junctions
// with a shared level; an explicitly closed basin has no downstream edge.
export function drainageOrder(nodes, edges) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error('Duplicate drainage node');
  const degree = new Map(nodes.map(node => [node.id, 0])), outgoing = new Map();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) throw new Error('Unresolved drainage endpoint');
    if (byId.get(edge.from).closed) throw new Error('Closed basin has a flowing outlet');
    degree.set(edge.to, degree.get(edge.to) + 1);
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }
  const queue = nodes.filter(node => degree.get(node.id) === 0).map(node => node.id).sort();
  const order = [];
  while (queue.length) {
    const id = queue.shift(); order.push(id);
    for (const next of (outgoing.get(id) || []).sort()) {
      degree.set(next, degree.get(next) - 1);
      if (degree.get(next) === 0) { queue.push(next); queue.sort(); }
    }
  }
  if (order.length !== nodes.length) return { status: 'retain-legacy', reason: 'drainage-cycle' };
  return { status: 'accepted', order };
}
