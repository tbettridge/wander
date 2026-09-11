// Terrain-led candidate routing on an unbounded global lattice. Searches end
// at a real sea cell, never at a planning tile edge. A bounded search that has
// not found an outlet reports a retained legacy component instead of inventing
// an outlet at the boundary. Profile and crossing validation remain separate.
import { MinHeap } from './drainage.mjs';
import { solveRiverProfile } from './riverprofile.mjs';

const DIRECTIONS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

export class RiverRoutePlanner {
  constructor(world, { step = 64, maxVisited = 8192, nodeLimit = 16384 } = {}) {
    if (!(step > 0) || !Number.isInteger(maxVisited) || maxVisited < 1 || nodeLimit < 9) throw new Error('Invalid route budget');
    this.world = world; this.step = step; this.maxVisited = maxVisited; this.nodeLimit = nodeLimit;
    this.nodes = new Map();
  }

  node(ix, iz) {
    const id = `${ix},${iz}`;
    const cached = this.nodes.get(id);
    if (cached) { this.nodes.delete(id); this.nodes.set(id, cached); return cached; }
    const x = ix * this.step, z = iz * this.step;
    let best = { x, z, h: this.world._naturalHeight(x, z), score: Infinity };
    best.score = best.h;
    // Nudge inside the globally owned cell toward its valley floor. The same
    // cell is sampled identically from every source and either side of a tile.
    if (best.h > 0.25) for (const [dx, dz] of DIRECTIONS) {
      const px = x + dx * this.step * 0.25, pz = z + dz * this.step * 0.25;
      const h = this.world._naturalHeight(px, pz);
      const score = h + (dx * dx + dz * dz) * 0.12;
      if (score < best.score) best = { x: px, z: pz, h, score };
    }
    const result = Object.freeze({ id, ix, iz, x: best.x, z: best.z, h: best.h });
    this.nodes.set(id, result);
    if (this.nodes.size > this.nodeLimit) this.nodes.delete(this.nodes.keys().next().value);
    return result;
  }

  route(start, { maxGrade = 0.025 } = {}) {
    if (![start.x, start.z].every(Number.isFinite)) throw new Error('Invalid river source');
    const origin = this.node(Math.round(start.x / this.step), Math.round(start.z / this.step));
    const queue = new MinHeap(), distances = new Map([[origin.id, 0]]), previous = new Map(), settled = new Map();
    queue.push({ index: origin.id, height: 0, node: origin });
    let outlet = null;
    while (queue.items.length && settled.size < this.maxVisited) {
      const next = queue.pop(), node = next.node;
      if (settled.has(node.id) || distances.get(node.id) !== next.height) continue;
      settled.set(node.id, node);
      if (node.h < -0.25) { outlet = node; break; }
      for (const [dx, dz] of DIRECTIONS) {
        const neighbour = this.node(node.ix + dx, node.iz + dz);
        if (settled.has(neighbour.id)) continue;
        // Positive integer costs make ties/reloads reproducible. Uphill cuts
        // are costly, so a route follows a hollow before crossing a ridge.
        const length = Math.hypot(neighbour.x - node.x, neighbour.z - node.z);
        const cost = Math.round(length * 1000) + Math.round(Math.max(0, neighbour.h - node.h) * 64000);
        const distance = next.height + cost;
        const old = distances.get(neighbour.id) ?? Infinity;
        if (distance > old || (distance === old && node.id >= (previous.get(neighbour.id)?.id || ''))) continue;
        distances.set(neighbour.id, distance); previous.set(neighbour.id, node);
        queue.push({ index: neighbour.id, height: distance, node: neighbour });
      }
    }
    if (!outlet) return { status: 'retain-legacy', reason: 'outlet-search-budget', visited: settled.size };
    const nodes = [];
    for (let node = outlet; node; node = previous.get(node.id)) nodes.push(node);
    nodes.reverse();
    if (nodes.length < 2) return { status: 'retain-legacy', reason: 'source-in-ocean', visited: settled.size };
    let arc = 0;
    const sections = nodes.map((node, i) => {
      if (i) arc += Math.hypot(node.x - nodes[i - 1].x, node.z - nodes[i - 1].z);
      const end = i === nodes.length - 1;
      return { id: node.id, arc, minY: end ? 0 : node.h - 4.6, maxY: end ? 0 : node.h + 1.4,
        preferredY: end ? 0 : node.h - 0.6 };
    });
    if (Number.isFinite(start.minY)) sections[0].minY = Math.max(sections[0].minY, start.minY);
    if (Number.isFinite(start.maxY)) sections[0].maxY = Math.min(sections[0].maxY, start.maxY);
    const profile = solveRiverProfile(sections, { maxGrade });
    if (profile.status !== 'accepted') return { ...profile, visited: settled.size };
    // Candidate is intentional: this path has not yet been fitted to all
    // crossings or joined to other sources in its drainage component.
    return { status: 'candidate', visited: settled.size, cost: distances.get(outlet.id),
      source: origin.id, outlet: outlet.id,
      points: nodes.map((node, i) => ({ ...node, arc: sections[i].arc, waterY: profile.levels[i],
        minY: sections[i].minY, maxY: sections[i].maxY })) };
  }
}

export function riverBoundaryPortals(route, regionSize = 4096) {
  if (!(regionSize > 0)) throw new Error('Invalid river region size');
  const portals = [];
  for (let i = 1; i < (route.points?.length || 0); i++) {
    const a = route.points[i - 1], b = route.points[i];
    for (const axis of ['x', 'z']) {
      const delta = b[axis] - a[axis];
      if (Math.abs(delta) < 1e-9) continue;
      const lo = Math.min(a[axis], b[axis]), hi = Math.max(a[axis], b[axis]);
      for (let boundary = Math.floor(lo / regionSize) + 1; boundary <= Math.floor(hi / regionSize); boundary++) {
        const t = (boundary * regionSize - a[axis]) / delta;
        portals.push({ id: `${a.id}>${b.id}:${axis}:${boundary}`, from: a.id, to: b.id, axis, boundary,
          x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
          minY: a.minY + (b.minY - a.minY) * t, maxY: a.maxY + (b.maxY - a.maxY) * t });
      }
    }
  }
  return portals.sort((a, b) => a.id.localeCompare(b.id));
}
