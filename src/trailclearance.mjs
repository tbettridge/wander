// Keeping a trail off the things people have built.
//
// Trails are solved over terrain alone, a hundred metres a lane, so the solver
// has no way to see a house — and a route that happens to cross a village lays
// its worn ribbon straight through the inn, the market hall and the cottages
// beside them. Anyone following it walks into a wall.
//
// This takes a solved route and the solid things near it, finds the stretches
// that run into them, and re-plans only those stretches on a fine grid: around
// the walls, along the village's own streets where it can, and back onto the
// original line on the far side. Everything outside those stretches, endpoints
// included, is left exactly where the terrain solver put it.
//
// Pure and THREE-free: the caller supplies the obstacles and any extra cost, so
// the promise (no point of the returned route inside a padded obstacle) can be
// tested without a world.

const DEFAULTS = Object.freeze({
  cell: 1.5,          // metres per grid cell
  approach: 40,       // re-plan this far either side of the stretch that hits something
  margin: 70,         // grid reaches this far round the stretch, so a detour has room
  favour: 0.55,       // cost of a metre along a street, against 1 on open ground
  blocked: 80,        // cost of a metre through an obstacle: a last resort, never a wall
  maxCells: 360000,
  maxSpacing: 12,     // longest segment the returned route keeps
  minSpacing: 3,      // shortest, except where a detour rejoins the solved line
});

/**
 * Obstacles as one list of shapes:
 *   { kind: 'rect', x, z, yaw, minX, maxX, minZ, maxZ }   a footprint in its own frame
 *   { kind: 'capsule', ax, az, bx, bz, radius }          a wall or fence run
 *   { kind: 'circle', x, z, radius }                     a well, a trough, a tree
 * Rect local axes follow the settlement plan: local x = dx·cos − dz·sin, z = dx·sin + dz·cos.
 */
export function insideObstacle(shape, x, z, padding = 0) {
  if (shape.kind === 'rect') {
    const dx = x - shape.x, dz = z - shape.z;
    const c = Math.cos(shape.yaw || 0), s = Math.sin(shape.yaw || 0);
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    return lx > shape.minX - padding && lx < shape.maxX + padding
      && lz > shape.minZ - padding && lz < shape.maxZ + padding;
  }
  if (shape.kind === 'circle') return Math.hypot(x - shape.x, z - shape.z) < shape.radius + padding;
  const dx = shape.bx - shape.ax, dz = shape.bz - shape.az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - shape.ax) * dx + (z - shape.az) * dz) / l2)) : 0;
  return Math.hypot(x - (shape.ax + dx * t), z - (shape.az + dz * t)) < (shape.radius || 0) + padding;
}

function shapeBounds(shape, padding) {
  if (shape.kind === 'rect') {
    const r = Math.max(Math.hypot(shape.minX, shape.minZ), Math.hypot(shape.maxX, shape.minZ),
      Math.hypot(shape.minX, shape.maxZ), Math.hypot(shape.maxX, shape.maxZ)) + padding;
    return [shape.x - r, shape.z - r, shape.x + r, shape.z + r];
  }
  if (shape.kind === 'circle') {
    const r = shape.radius + padding;
    return [shape.x - r, shape.z - r, shape.x + r, shape.z + r];
  }
  const r = (shape.radius || 0) + padding;
  return [Math.min(shape.ax, shape.bx) - r, Math.min(shape.az, shape.bz) - r,
    Math.max(shape.ax, shape.bx) + r, Math.max(shape.az, shape.bz) + r];
}

/** The route as points every metre or so, with arc length. */
function densify(pts, step = 1) {
  const xs = [], zs = [], arc = [];
  let base = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
    const span = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(span / step));
    for (let k = 0; k < n; k++) { xs.push(ax + (bx - ax) * k / n); zs.push(az + (bz - az) * k / n); arc.push(base + span * k / n); }
    base += span;
  }
  xs.push(pts[pts.length - 2]); zs.push(pts[pts.length - 1]); arc.push(base);
  return { xs, zs, arc, length: base };
}

/** The point at `at` metres along the original route. */
function pointAt(pts, at) {
  let base = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
    const span = Math.hypot(bx - ax, bz - az);
    if (base + span >= at || i + 4 >= pts.length) {
      const t = span > 1e-9 ? Math.max(0, Math.min(1, (at - base) / span)) : 0;
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, index: i / 2, t };
    }
    base += span;
  }
  return { x: pts[pts.length - 2], z: pts[pts.length - 1], index: pts.length / 2 - 1, t: 0 };
}

/** The stretches of route that come within `clearance` of an obstacle, as arc ranges. */
export function obstructedStretches(pts, shapes, clearance, step = 1) {
  const route = densify(pts, step);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < route.xs.length; i++) {
    minX = Math.min(minX, route.xs[i]); maxX = Math.max(maxX, route.xs[i]);
    minZ = Math.min(minZ, route.zs[i]); maxZ = Math.max(maxZ, route.zs[i]);
  }
  const near = shapes.filter(shape => {
    const [x0, z0, x1, z1] = shapeBounds(shape, clearance);
    return x1 >= minX && x0 <= maxX && z1 >= minZ && z0 <= maxZ;
  });
  const hits = [];
  if (!near.length) return { hits, route };
  for (let i = 0; i < route.xs.length; i++) {
    for (const shape of near) {
      if (insideObstacle(shape, route.xs[i], route.zs[i], clearance)) { hits.push(route.arc[i]); break; }
    }
  }
  return { hits, route };
}

// A small binary heap keyed on f-cost.
class Heap {
  constructor() { this.ids = []; this.keys = []; }
  get size() { return this.ids.length; }
  push(id, key) {
    const ids = this.ids, keys = this.keys;
    let i = ids.length; ids.push(id); keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p]; keys[i] = keys[p]; i = p;
    }
    ids[i] = id; keys[i] = key;
  }
  pop() {
    const ids = this.ids, keys = this.keys, top = ids[0];
    const lastId = ids.pop(), lastKey = keys.pop();
    if (ids.length) {
      let i = 0;
      while (true) {
        const l = i * 2 + 1, r = l + 1;
        if (l >= ids.length) break;
        const c = r < ids.length && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c]; keys[i] = keys[c]; i = c;
      }
      ids[i] = lastId; keys[i] = lastKey;
    }
    return top;
  }
}

/** Re-plan one stretch between two fixed points on a grid that knows the obstacles. */
function planStretch(start, end, corridor, shapes, favoured, options) {
  const { clearance, penaltyAt } = options;
  let cell = options.cell;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of corridor) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  minX -= options.margin; minZ -= options.margin; maxX += options.margin; maxZ += options.margin;
  while (((maxX - minX) / cell) * ((maxZ - minZ) / cell) > options.maxCells) cell *= 1.25;
  const cols = Math.ceil((maxX - minX) / cell) + 1, rows = Math.ceil((maxZ - minZ) / cell) + 1;
  const count = cols * rows;
  const at = (c, r) => ({ x: minX + c * cell, z: minZ + r * cell });

  // Base cost: 1 open ground, `favour` on a street, `blocked` inside a padded obstacle.
  const base = new Float32Array(count).fill(1);
  const stamp = (shape, padding, value, keepLower) => {
    const [x0, z0, x1, z1] = shapeBounds(shape, padding);
    const c0 = Math.max(0, Math.floor((x0 - minX) / cell)), c1 = Math.min(cols - 1, Math.ceil((x1 - minX) / cell));
    const r0 = Math.max(0, Math.floor((z0 - minZ) / cell)), r1 = Math.min(rows - 1, Math.ceil((z1 - minZ) / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const index = r * cols + c;
        if (keepLower ? base[index] <= value : base[index] >= value) continue;
        const p = at(c, r);
        if (insideObstacle(shape, p.x, p.z, padding)) base[index] = value;
      }
    }
  };
  for (const street of favoured) stamp(street, 0, options.favour, true);
  for (const shape of shapes) stamp(shape, clearance, options.blocked, false);

  // Terrain the caller cares about (water, the railway) is asked lazily: only
  // the cells the search actually reaches pay for a query.
  const extra = penaltyAt ? new Float32Array(count).fill(NaN) : null;
  const cost = index => {
    if (!extra) return base[index];
    let e = extra[index];
    if (Number.isNaN(e)) { const p = at(index % cols, (index / cols) | 0); e = extra[index] = penaltyAt(p.x, p.z) || 0; }
    return base[index] * (1 + e);
  };

  const cellOf = p => {
    const c = Math.max(0, Math.min(cols - 1, Math.round((p.x - minX) / cell)));
    const r = Math.max(0, Math.min(rows - 1, Math.round((p.z - minZ) / cell)));
    return r * cols + c;
  };
  const from = cellOf(start), goal = cellOf(end);
  const gx = goal % cols, gz = (goal / cols) | 0;
  const g = new Float64Array(count).fill(Infinity);
  const parent = new Int32Array(count).fill(-1);
  const closed = new Uint8Array(count);
  const heap = new Heap();
  const floor = Math.min(1, options.favour);
  const h = index => Math.hypot((index % cols) - gx, ((index / cols) | 0) - gz) * cell * floor;
  g[from] = 0; heap.push(from, h(from));
  const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.size) {
    const current = heap.pop();
    if (closed[current]) continue;
    closed[current] = 1;
    if (current === goal) break;
    const c = current % cols, r = (current / cols) | 0;
    const here = cost(current);
    for (const [dc, dr, len] of steps) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const next = nr * cols + nc;
      if (closed[next]) continue;
      const tentative = g[current] + len * cell * (here + cost(next)) * 0.5;
      if (tentative < g[next]) { g[next] = tentative; parent[next] = current; heap.push(next, tentative + h(next)); }
    }
  }
  if (!Number.isFinite(g[goal])) return null;
  const chain = [];
  for (let index = goal; index !== -1; index = parent[index]) chain.push(index);
  chain.reverse();
  const points = chain.map(index => at(index % cols, (index / cols) | 0));
  points[0] = { x: start.x, z: start.z };
  points[points.length - 1] = { x: end.x, z: end.z };
  const cumulative = [0];
  for (let i = 1; i < chain.length; i++) cumulative.push(g[chain[i]]);

  // Pull the staircase taut: from each kept point, jump to the furthest later
  // point whose straight line costs no more than the grid path between them.
  const lineCost = (a, b) => {
    const span = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(span / (cell * 0.5)));
    let total = 0;
    for (let k = 0; k <= n; k++) total += cost(cellOf({ x: a.x + (b.x - a.x) * k / n, z: a.z + (b.z - a.z) * k / n })) * (k === 0 || k === n ? 0.5 : 1);
    return total * span / n;
  };
  const taut = [points[0]];
  for (let i = 0; i < points.length - 1;) {
    let next = i + 1;
    for (let j = Math.min(points.length - 1, i + 400); j > i + 1; j--) {
      if (lineCost(points[i], points[j]) <= cumulative[j] - cumulative[i] + cell * 0.25) { next = j; break; }
    }
    taut.push(points[next]);
    i = next;
  }
  return { points: taut, cell, lineCost };
}

function clear(points, shapes, padding) {
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.5));
    for (let k = 0; k <= n; k++) {
      const x = a.x + (b.x - a.x) * k / n, z = a.z + (b.z - a.z) * k / n;
      for (const shape of shapes) if (insideObstacle(shape, x, z, padding)) return false;
    }
  }
  return true;
}

// Round off the corners the grid leaves (Chaikin), but never into a wall.
function soften(points, shapes, padding) {
  let current = points;
  for (let pass = 0; pass < 3; pass++) {
    if (current.length < 3) break;
    const next = [current[0]];
    for (let i = 0; i + 1 < current.length; i++) {
      const a = current[i], b = current[i + 1];
      if (i > 0) next.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      if (i + 2 < current.length) next.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    next.push(current[current.length - 1]);
    if (!clear(next, shapes, padding)) break;
    current = next;
  }
  return current;
}

/**
 * The route with every stretch that runs into an obstacle re-planned round it,
 * or null when nothing is in the way.
 *
 * `clearance` is how far the route's centreline must stay off every shape —
 * half the trail's width and a step to spare, so the worn edge stops short of
 * the wall. `favoured` are shapes it would rather walk along (streets), and
 * `penaltyAt(x, z)` adds cost where the caller would rather it did not go
 * (water, a railway). Endpoints never move.
 */
export function routeAroundObstacles(pts, shapes, options = {}) {
  const opts = { ...DEFAULTS, clearance: 2, favoured: [], penaltyAt: null, ...options };
  if (!pts || pts.length < 4 || !shapes.length) return null;
  const { hits, route } = obstructedStretches(pts, shapes, opts.clearance);
  if (!hits.length) return null;

  // Group hits into stretches; two that nearly touch are one detour.
  const stretches = [];
  for (const arc of hits) {
    const last = stretches[stretches.length - 1];
    if (last && arc - last.to <= opts.approach * 2) last.to = arc; else stretches.push({ from: arc, to: arc });
  }
  // Arc length at each vertex of the original route, so the parts left alone
  // are copied vertex for vertex rather than resampled.
  const vertexArc = [0];
  for (let i = 2; i < pts.length; i += 2) vertexArc.push(vertexArc[vertexArc.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
  const out = [];
  const pushOriginal = (fromArc, toArc, inclusiveStart) => {
    for (let v = 0; v < vertexArc.length; v++) {
      const a = vertexArc[v];
      if ((inclusiveStart ? a < fromArc : a <= fromArc) || a >= toArc) continue;
      out.push({ x: pts[v * 2], z: pts[v * 2 + 1] });
    }
  };
  const pushDetour = (points) => {
    for (let i = 0; i < points.length; i++) {
      const p = points[i], last = out[out.length - 1];
      // Smoothing leaves points a hand's width apart on a bend. A route sampled
      // that finely reads every bump as a slope, so keep them a few metres apart.
      const gap = last ? Math.hypot(last.x - p.x, last.z - p.z) : Infinity;
      if (gap < 0.25 || (gap < opts.minSpacing && i < points.length - 1)) continue;
      // Split any long straight run so a segment never spans more than `maxSpacing`.
      if (last) {
        const n = Math.ceil(Math.hypot(p.x - last.x, p.z - last.z) / opts.maxSpacing);
        for (let k = 1; k < n; k++) out.push({ x: last.x + (p.x - last.x) * k / n, z: last.z + (p.z - last.z) * k / n });
      }
      out.push(p);
    }
  };
  let resumeAt = 0, inclusive = true, changed = false;
  for (const stretch of stretches) {
    const fromArc = Math.max(0, stretch.from - opts.approach);
    const toArc = Math.min(route.length, stretch.to + opts.approach);
    const start = pointAt(pts, fromArc), end = pointAt(pts, toArc);
    const corridor = [];
    for (let i = 0; i < route.arc.length; i++) if (route.arc[i] >= fromArc && route.arc[i] <= toArc) corridor.push({ x: route.xs[i], z: route.zs[i] });
    corridor.push(start, end);
    const near = shapes.filter(shape => {
      const [x0, z0, x1, z1] = shapeBounds(shape, opts.clearance);
      return corridor.some(p => p.x > x0 - opts.margin && p.x < x1 + opts.margin && p.z > z0 - opts.margin && p.z < z1 + opts.margin);
    });
    const plan = planStretch(start, end, corridor, near, opts.favoured, opts);
    if (!plan) continue;
    pushOriginal(resumeAt, fromArc, inclusive);
    pushDetour(soften(plan.points, near, opts.clearance * 0.85));
    resumeAt = toArc; inclusive = false;
    changed = true;
  }
  if (!changed) return null;
  pushOriginal(resumeAt, Infinity, inclusive);
  const flat = new Float32Array(out.length * 2);
  out.forEach((p, i) => { flat[i * 2] = p.x; flat[i * 2 + 1] = p.z; });
  return flat;
}
