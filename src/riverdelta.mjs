// Distributaries for a river that reaches the sea across low coastal ground.
//
// A real delta forms where a river slows on a flat coast and drops its load:
// the channel splits a few channel-widths inland, and its arms run on toward
// the same shore, drawing gradually apart across the low ground until each
// opens into the sea at its own mouth, with low islands left between them.
// An arm here leaves the fork along the main channel's general line, drifting
// sideways as it goes, so the arms fan out instead of striking off at an
// angle. Once clear of the main channel's banks it finds its own way to the
// sea through the lowest ground, the way spilling water does, and wanders
// with bends of its own, so no arm copies its neighbour's course. Arms are
// proposals; the joint river fit still owns every level, bank and ownership
// check, and a delta that does not fit is not built.

import { polylineArcs, resamplePolyline, fairCentreline, gaussianPolyline, meanderCentreline } from './regionalrivershape.mjs';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function frameAt(points, i) {
  const a = points[Math.max(0, i - 2)], b = points[Math.min(points.length - 1, i + 2)];
  const tx = b.x - a.x, tz = b.z - a.z, length = Math.hypot(tx, tz) || 1;
  return { tx: tx / length, tz: tz / length, nx: -tz / length, nz: tx / length };
}

function distanceToPolyline(p, points, from = 1) {
  let best = Infinity;
  for (let i = Math.max(1, from); i < points.length; i++) {
    const a = points[i - 1], b = points[i], dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
    const t = length > 0 ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / length, 0, 1) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t));
  }
  return best;
}

// Binary heap of cell indices keyed by a shared array; ties break on index.
function cellHeap(key) {
  const items = [];
  const less = (a, b) => key[a] < key[b] || (key[a] === key[b] && a < b);
  return {
    get size() { return items.length; },
    push(value) {
      let i = items.length;
      items.push(value);
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (!less(value, items[parent])) break;
        items[i] = items[parent]; i = parent;
      }
      items[i] = value;
    },
    pop() {
      const top = items[0], last = items.pop();
      if (items.length) {
        let i = 0;
        for (;;) {
          let child = i * 2 + 1;
          if (child >= items.length) break;
          if (child + 1 < items.length && less(items[child + 1], items[child])) child++;
          if (!less(items[child], last)) break;
          items[i] = items[child]; i = child;
        }
        items[i] = last;
      }
      return top;
    },
  };
}

// The cheapest course from `course[from]` to open sea near a proposed line.
// Low, wet ground is cheap and every rise is dear, so the arm threads the
// swales between hummocks the way spilling water does; the corridor around
// the proposal keeps it heading for its own stretch of shore. `blocked` marks
// ground the arm must not touch, such as the banks of the main channel.
// Returns points from the start to a cell clearly below the tide, or null.
function lowGroundPath(world, course, from, { corridor, blocked, sea, cell = 16 }) {
  const start = course[from], rest = course.slice(from);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of rest) {
    minX = Math.min(minX, p.x - corridor); maxX = Math.max(maxX, p.x + corridor);
    minZ = Math.min(minZ, p.z - corridor); maxZ = Math.max(maxZ, p.z + corridor);
  }
  const cols = Math.ceil((maxX - minX) / cell) + 1, rows = Math.ceil((maxZ - minZ) / cell) + 1;
  if (cols * rows > 40000) return null;
  const count = cols * rows, cost = new Float64Array(count), goal = new Uint8Array(count);
  const at = k => ({ x: minX + (k % cols) * cell, z: minZ + Math.floor(k / cols) * cell });
  for (let k = 0; k < count; k++) {
    const p = at(k), d = distanceToPolyline(p, rest);
    if (d > corridor) { cost[k] = Infinity; continue; }
    const h = world._naturalHeight(p.x, p.z), open = h < -0.8 && sea(p.x, p.z);
    if ((!open && h > 4.8) || blocked(p)) { cost[k] = Infinity; continue; }
    cost[k] = 1 + 0.9 * Math.pow(clamp(h - 0.3, 0, 6), 1.5) + 0.6 * (d / corridor) ** 2;
    if (open && h < -1.2) goal[k] = 1;
  }
  const cellOf = p => Math.round((p.z - minZ) / cell) * cols + Math.round((p.x - minX) / cell);
  const first = cellOf(start);
  if (!(cost[first] < Infinity)) return null;
  const g = new Float64Array(count).fill(Infinity);
  const previous = new Int32Array(count).fill(-1), closed = new Uint8Array(count);
  const heap = cellHeap(g);
  g[first] = 0; heap.push(first);
  let reached = -1;
  while (heap.size) {
    const k = heap.pop();
    if (closed[k]) continue;
    closed[k] = 1;
    if (goal[k]) { reached = k; break; }
    const ci = k % cols, cj = (k - ci) / cols;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const ni = ci + dx, nj = cj + dz;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const q = nj * cols + ni;
      if (closed[q] || !(cost[q] < Infinity)) continue;
      const step = Math.hypot(dx, dz) * cell * (cost[k] + cost[q]) / 2;
      if (g[k] + step < g[q]) { g[q] = g[k] + step; previous[q] = k; heap.push(q); }
    }
  }
  if (reached < 0) return null;
  const path = [];
  for (let k = reached; k >= 0; k = previous[k]) path.push(at(k));
  path.reverse();
  path[0] = { x: start.x, z: start.z };
  return path;
}

/**
 * Propose up to `maxArms` distributaries leaving the trunk at one apex.
 * `trunk.points` run from source to a mouth point already in the sea and
 * carry `area`, `hw`, `foot` and `level`. `avoid` lists side-valley inflows
 * ({ x, z, radius }) the fork should keep clear of, so a creek never meets
 * the river exactly where it splits. The fork stands at least `below`
 * metres down the trunk, clear of the confluences of its feeders. `bends:
 * false` keeps the arms to their low-ground courses without bends of their
 * own. Returns { apex, arms: [{ side, fork, points }], mainShare, armShare }
 * or null when the coast offers no low ground for a delta.
 */
export function planDistributaries(world, trunk, { seed = 0, maxArms = 2, isSea = null, avoid = [], below = 0, bends = true } = {}) {
  const points = trunk.points, n = points.length, arcs = polylineArcs(points);
  const height = p => world._naturalHeight(p.x, p.z);
  const sea = isSea || ((x, z) => world._naturalHeight(x, z) < -0.8);
  let coast = n - 1;
  while (coast > 0 && height(points[coast]) < -0.25) coast--;
  if (coast < 8) return null;
  const width = points[coast].hw, armWidth = width * 0.62, footArm = armWidth * 1.7 + 17;
  const span = clamp(width * 6 + 140, 280, 600);
  const lowFork = i => points[i].level <= 1.6 && height(points[i]) <= 3.5;
  const options = [];
  for (let i = coast - 1; i > 2; i--) {
    const distance = arcs[coast] - arcs[i];
    if (distance < span) continue;
    if (distance > span + 360 || arcs[i] < below) break;
    // The fork sits on nearly tidal water over low ground.
    if (!lowFork(i)) continue;
    // How far inside the nearest side valley's reach the fork would sit.
    const crowding = avoid.reduce((worst, zone) => Math.max(worst,
      zone.radius - Math.hypot(points[i].x - zone.x, points[i].z - zone.z)), 0);
    options.push({ i, crowding });
  }
  // Where side valleys come in all along the lower river, fork where they
  // crowd it least.
  const clear = options.filter(option => option.crowding <= 0);
  const crowded = options.filter(option => option.crowding > 0).sort((a, b) => a.crowding - b.crowding || b.i - a.i);
  const candidates = [...clear.filter((_, k) => k % 2 === 0).slice(0, 5), ...crowded.slice(0, 3)].map(c => c.i);
  const order = (seed >>> 0) % 2 ? [1, -1] : [-1, 1];
  // No two deltas alike: about a third split only once, and each arm has its
  // own reach across the flats and its own way of drawing off the main
  // channel, early or late, so the arms never splay as a symmetric trident.
  const chance = k => (Math.imul((seed >>> 0) ^ Math.imul(k, 0x9e3779b1), 0x85ebca6b) >>> 0) / 4294967296;
  const wanted = Math.min(maxArms, chance(1) < 0.35 ? 1 : 2);
  const heading = (line, reach) => {
    const lineArcs = polylineArcs(line), total = lineArcs.at(-1);
    const from = line[Math.max(0, lineArcs.findIndex(arc => arc >= total - reach))], to = line.at(-1);
    const length = Math.hypot(to.x - from.x, to.z - from.z) || 1;
    return { x: (to.x - from.x) / length, z: (to.z - from.z) / length };
  };
  const mainHeading = heading(points.slice(Math.max(0, coast - 12)), 160);

  // Bends for an arm across the flats: a few to each, fading in below the
  // fork and out again before the mouth flares open. (The broad main channel
  // bends on a wavelength longer than the whole delta, so it keeps its own
  // course.)
  const wander = (line, halfWidthAt, footAt, key) => meanderCentreline(world, resamplePolyline(line, 16), {
    seed: (seed >>> 0) * 7 + key, strength: 1, ratio: 0.11, wavelength: 9, startFade: 140, endFade: 170, halfWidthAt, footAt });
  // An arm's banks need more room than its own channel where the fork's
  // junction collar widens it, and where its mouth flares over the last 160 m.
  const flaredFoot = line => {
    const lineArcs = polylineArcs(line), total = lineArcs.at(-1);
    return line.map((p, i) => ({ ...p, foot: footArm * (1 + 0.5 * (1 - clamp(lineArcs[i] / 220, 0, 1)) ** 2)
      * (1 + 0.62 * clamp((lineArcs[i] - total + 160) / 160, 0, 1) ** 2) }));
  };

  // One arm leaving the trunk at `fork` toward `side`, clear of `others`;
  // `tail` is the main channel's own course below the fork.
  function proposeArm(fork, side, others, tail) {
    const tailArcs = polylineArcs(tail);
    // Arms follow the main channel's general line, not each of its bends.
    const guide = gaussianPolyline(tail, 120);
    const coastArc = arcs[coast] - arcs[fork];
    const footMain = points[Math.min(n - 1, fork + 4)].foot;
    const lean = 0.8 + 0.45 * chance(side > 0 ? 2 : 3), bow = 1.15 + 0.7 * chance(side > 0 ? 4 : 5);
    for (const [attempt, spread] of [1, 0.75, 1.3].entries()) {
      // Lateral drift reaches its full value at the shore; the arm leaves
      // the fork tangent to the main current.
      const drift = clamp(width * 3.2 + 170, 230, 480) * spread * lean;
      let arm = guide.map((p, k) => {
        const f = frameAt(guide, k), t = Math.min(1, tailArcs[k] / Math.max(1, coastArc));
        const offset = side * drift * Math.pow(t, bow) * (1 + 0.06 * Math.sin(tailArcs[k] / 70 + side + seed % 7));
        return { x: p.x + f.nx * offset, z: p.z + f.nz * offset };
      });
      // Continue past the trunk's own mouth until this arm is in the sea.
      const end = arm.at(-1), f = frameAt(guide, guide.length - 1);
      for (let d = 16; d <= 240 && !(height(arm.at(-1)) < -0.8 && sea(arm.at(-1).x, arm.at(-1).z)); d += 16) {
        arm.push({ x: end.x + f.tx * d, z: end.z + f.tz * d });
      }
      arm = resamplePolyline(arm, 16);
      // Once clear of the main channel's banks the arm finds its own way
      // down through the low ground toward its mouth.
      const apart = footMain + footArm + 12;
      const detach = arm.findIndex((p, k) => k > 3 && distanceToPolyline(p, tail) >= apart);
      if (detach > 0 && detach < arm.length - 4) {
        const own = lowGroundPath(world, arm, detach, { corridor: clamp(drift * 0.45, 110, 220), sea,
          blocked: p => distanceToPolyline(p, tail) < apart - 4
            || others.some(other => distanceToPolyline(p, other.points) < footArm * 2 + 6) });
        if (own) arm = gaussianPolyline(resamplePolyline([...arm.slice(0, detach), ...own], 8), 28);
      }
      // Each arm wanders across the flats on its own.
      if (bends) arm = wander(arm, () => armWidth, () => footArm, (side > 0 ? 1 : 2) * 131 + attempt * 17);
      const faired = fairCentreline(flaredFoot(resamplePolyline(arm, 16)), p => p.foot, { strict: true });
      if (!faired) continue;
      arm = faired;
      const last = arm.at(-1);
      if (!(height(last) < -0.8 && sea(last.x, last.z))) continue;
      // A delta opens onto one stretch of coast: every mouth faces the sea
      // the main channel enters, each well apart from the others.
      const facing = heading(arm, 160);
      if (facing.x * mainHeading.x + facing.z * mainHeading.z < 0.42) continue;
      if ([points.at(-1), ...others.map(other => other.points.at(-1))]
        .some(q => Math.hypot(q.x - last.x, q.z - last.z) < 130)) continue;
      const armArcs = polylineArcs(arm), shared = Math.max(240, 2.4 * (footMain + footArm));
      let clean = true, previous = 0;
      for (let k = 1; k < arm.length && clean; k++) {
        const p = arm[k], h = height(p);
        if (h > 4.8 && !sea(p.x, p.z)) clean = false;
        const main = distanceToPolyline(p, tail);
        // An arm may wander, but never swing back toward the main channel.
        if (armArcs[k] > 40 && previous > armWidth && main < previous * 0.7 - 2) clean = false;
        previous = Math.max(previous, main);
        if (armArcs[k] > shared && main < footMain + footArm + 6) clean = false;
        for (const other of others) {
          const d = distanceToPolyline(p, other.points);
          if ((armArcs[k] > 40 && d < armWidth) || (armArcs[k] > shared && d < footArm * 2 + 6)) clean = false;
        }
      }
      if (clean) return { side, fork, points: arm };
    }
    return null;
  }

  for (const apex of candidates) {
    const tail = resamplePolyline(points.slice(apex), 16);
    const arms = [];
    for (const side of order) {
      const arm = proposeArm(apex, side, arms, tail);
      if (arm) arms.push(arm);
      if (arms.length >= wanted) break;
    }
    if (arms.length) {
      return { apex: Math.min(...arms.map(arm => arm.fork)), arms,
        mainShare: arms.length > 1 ? 0.46 : 0.6, armShare: arms.length > 1 ? 0.27 : 0.4 };
    }
  }
  return null;
}
