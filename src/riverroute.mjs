// Terrain-led candidate routing on an unbounded global lattice. Searches end
// at a real sea cell, never at a planning tile edge. A bounded search that has
// not found an outlet reports a retained legacy component instead of inventing
// an outlet at the boundary. Profile and crossing validation remain separate.
import { MinHeap } from './drainage.mjs';
import { solveRiverProfile } from './riverprofile.mjs';

const DIRECTIONS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

export class RiverRoutePlanner {
  constructor(world, { step = 64, maxVisited = 8192, nodeLimit = 16384 } = {}) {
    if (!Number.isFinite(step) || step <= 0 || !Number.isInteger(maxVisited) || maxVisited < 1
      || !Number.isInteger(nodeLimit) || nodeLimit < 9) throw new Error('Invalid route budget');
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

  route(start, { maxGrade = 0.025, deferProfile = false } = {}) {
    if (![start.x, start.z].every(Number.isFinite)) throw new Error('Invalid river source');
    const sourceHeight = this.world._naturalHeight(start.x, start.z);
    if (sourceHeight < -0.25) return { status: 'retain-legacy', reason: 'source-in-ocean', visited: 0 };
    const source = Object.freeze({ id: start.id || `source:${start.x},${start.z}`,
      x: start.x, z: start.z, h: sourceHeight });
    const queue = new MinHeap(), distances = new Map(), previous = new Map(), states = new Map(), settled = new Map();
    // Seed the search from the exact source into nearby globally owned cells.
    // This keeps a preserved crossing on its real centre while allowing the
    // downstream graph to converge with routes generated from other sources.
    const centreX = Math.round(start.x / this.step), centreZ = Math.round(start.z / this.step);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const node = this.node(centreX + dx, centreZ + dz);
      const length = Math.hypot(node.x - source.x, node.z - source.z);
      const ux = length > 1e-6 ? (node.x - source.x) / length : 0;
      const uz = length > 1e-6 ? (node.z - source.z) / length : 0;
      // An arbitrary source has a different incoming tangent from a lattice
      // neighbour. Keep its entry state distinct for the turn-cost search.
      const state = `${node.id}|source`;
      if (length < 1e-6) {
        distances.set(state, 0); previous.set(state, null); states.set(state, { node, ux: 0, uz: 0 });
        queue.push({ index: state, height: 0, node, state, ux: 0, uz: 0 });
        continue;
      }
      const cost = Math.round(length * 1000) + Math.round(Math.max(0, node.h - source.h) * 64000);
      const old = distances.get(state) ?? Infinity;
      if (cost < old) {
        distances.set(state, cost); previous.set(state, null); states.set(state, { node, ux, uz });
        queue.push({ index: state, height: cost, node, state, ux, uz });
      }
    }
    let outlet = null;
    while (queue.items.length && settled.size < this.maxVisited) {
      const next = queue.pop(), node = next.node;
      if (settled.has(next.state) || distances.get(next.state) !== next.height) continue;
      settled.set(next.state, next);
      if (node.h < -0.25) { outlet = next; break; }
      for (let direction = 0; direction < DIRECTIONS.length; direction++) {
        const [dx, dz] = DIRECTIONS[direction];
        const neighbour = this.node(node.ix + dx, node.iz + dz);
        const state = `${neighbour.id}|${direction}`;
        if (settled.has(state)) continue;
        // Positive integer costs make ties/reloads reproducible. Uphill cuts
        // are costly, so a route follows a hollow before crossing a ridge.
        const length = Math.hypot(neighbour.x - node.x, neighbour.z - node.z);
        const ux = (neighbour.x - node.x) / length, uz = (neighbour.z - node.z) / length;
        const turn = next.ux || next.uz ? Math.max(0, 1 - (next.ux * ux + next.uz * uz)) : 0;
        // A cheap hydraulic proxy keeps the geometric search from racing down
        // the steepest straight line and only discovering during profile solve
        // that a bounded bank cannot support that drop. The 2m allowance is
        // the ordinary fill budget; exact section intervals remain authoritative.
        const uphill = Math.max(0, neighbour.h - node.h);
        const fastDrop = Math.max(0, node.h - neighbour.h - length * maxGrade - 2);
        const cost = Math.round(length * 1000) + Math.round(uphill * 64000)
          + Math.round(fastDrop * 96000) + Math.round(turn * 180000);
        const distance = next.height + cost;
        const old = distances.get(state) ?? Infinity;
        if (distance > old || (distance === old && next.state >= (previous.get(state) || ''))) continue;
        distances.set(state, distance); previous.set(state, next.state); states.set(state, { node: neighbour, ux, uz });
        queue.push({ index: state, height: distance, node: neighbour, state, ux, uz });
      }
    }
    if (!outlet) return { status: 'retain-legacy', reason: 'outlet-search-budget', visited: settled.size };
    const nodes = [];
    for (let state = outlet.state; state; state = previous.get(state)) nodes.push(states.get(state).node);
    nodes.reverse();
    if (new Set(nodes.map(node => node.id)).size !== nodes.length) {
      return { status: 'retain-legacy', reason: 'river-route-cycle', visited: settled.size };
    }
    if (!nodes.length || Math.hypot(nodes[0].x - source.x, nodes[0].z - source.z) > 1e-6) nodes.unshift(source);
    else nodes[0] = source;
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
    if (profile.status !== 'accepted' && !deferProfile) return { ...profile, visited: settled.size };
    const levels = profile.status === 'accepted'
      ? profile.levels
      : sections.map(section => Math.max(section.minY, Math.min(section.maxY, section.preferredY)));
    // Candidate is intentional: this path has not yet been fitted to all
    // crossings or joined to other sources in its drainage component.
    return { status: 'candidate', visited: settled.size, cost: distances.get(outlet.state),
      source: source.id, outlet: outlet.node.id,
      deferredProfileReason: profile.status === 'accepted' ? null : profile.reason,
      points: nodes.map((node, i) => ({ ...node, arc: sections[i].arc, waterY: levels[i],
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
