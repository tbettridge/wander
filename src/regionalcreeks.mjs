// Headwater creeks of a regional river system.
//
// Water runs downhill, so a creek's water level never rises on its way down.
// Each creek follows a side valley of the drainage tree, from the valley's
// head down to the creek or river channel that receives it, so the creeks
// branch into a tree and never cross.
//
// The ground here was never shaped by water: it is full of little closed
// hollows and the low rims between them, and a line down a valley floor
// climbs over each rim. Real streams cut through such rims, and so does a
// creek here. Its water level is the lowest ground it has passed, but never
// more than MAX_CUT below the highest ground still ahead; the terrain then
// wears a bed under that level (WaterField.creekGround), a shallow channel on
// the way down and a narrow notch through each rim. Where a hollow is so deep
// that even that level would stand above its floor, the hollow would hold a
// pond rather than a creek, so the creek rises below it instead.
//
// Every point carries its water level, falling or level all the way down.
// Pure and deterministic: natural-height samples only, no world mutation.

import { drainageTree, surveyX, surveyZ } from './regionaldrainage.mjs';
import { polylineArcs, resamplePolyline, valleyCentreline } from './regionalrivershape.mjs';
import { settlementsAround } from './settlementplacement.mjs';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

const STEP = 4;                  // metres between creek points
export const MAX_CUT = 2.5;      // deepest a creek's bed is worn below the ground
const MAX_FILL = 0.12;           // how far water may stand above the natural ground
const MIN_LENGTH = 90;
export const CREEK_PIECE = 680;

/** Creek water width (metres) for the area a headwater stream drains. */
export const creekWidth = area => clamp(0.6 + 12 * Math.pow(Math.max(0, area) / 1e6, 0.6), 0.6, 2.6);

/**
 * The water level a creek can hold over `ground` (sampled head to mouth),
 * ending at no less than `endLevel`: the lowest ground passed so far, but no
 * more than MAX_CUT below the highest ground still ahead. Non-increasing.
 */
export function creekLevels(ground, endLevel = -Infinity) {
  const n = ground.length, ahead = new Float64Array(n), levels = new Array(n);
  let high = -Infinity;
  for (let i = n - 1; i >= 0; i--) { high = Math.max(high, ground[i]); ahead[i] = high; }
  let low = Infinity;
  for (let i = 0; i < n; i++) {
    low = Math.min(low, ground[i]);
    levels[i] = Math.max(low, ahead[i] - MAX_CUT, endLevel);
  }
  return levels;
}

function pointSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, length = dx * dx + dz * dz;
  const t = length > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / length, 0, 1) : 0;
  return { t, distance: Math.hypot(px - ax - dx * t, pz - az - dz * t) };
}

// A coarse grid of segments, so "what water is near here?" costs a lookup.
function segmentGrid(size) {
  const grid = new Map();
  return {
    add(entry, pad) {
      const { ax, az, bx, bz } = entry;
      for (let gz = Math.floor((Math.min(az, bz) - pad) / size); gz <= Math.floor((Math.max(az, bz) + pad) / size); gz++) {
        for (let gx = Math.floor((Math.min(ax, bx) - pad) / size); gx <= Math.floor((Math.max(ax, bx) + pad) / size); gx++) {
          const key = `${gx},${gz}`;
          let list = grid.get(key);
          if (!list) grid.set(key, list = []);
          list.push(entry);
        }
      }
    },
    near(x, z) { return grid.get(`${Math.floor(x / size)},${Math.floor(z / size)}`) || []; },
  };
}

// Split a creek's course (head to mouth, over `ground`) into the runs the
// ground can carry. A run above a hollow too deep to cut through ends in a
// pool on the hollow's floor, and the creek rises again past the hollow's
// rim; only the last run reaches the receiving water at `endLevel`. Points of
// each run carry their water level `y`.
function segmentsOf(course, ground, endLevel) {
  const g = ground.map(h => (h === -Infinity ? endLevel : h));
  const levels = creekLevels(g, endLevel), zones = [];
  for (let i = 0; i < g.length; i++) {
    if (!(ground[i] > -Infinity && levels[i] - ground[i] > MAX_FILL)) continue;
    if (zones.length && zones.at(-1)[1] === i - 1) zones.at(-1)[1] = i; else zones.push([i, i]);
  }
  const holds = (points, heights, end) => {
    const y = creekLevels(heights, end);
    return y.every((level, i) => points[i].inChannel || level - heights[i] <= MAX_FILL) ? y : null;
  };
  const segments = [];
  let start = 0;
  for (const [first, last] of zones) {
    let floor = first;
    for (let i = first; i <= last; i++) if (g[i] < g[floor]) floor = i;
    if (floor - start >= 4) {
      const points = course.slice(start, floor + 1), heights = g.slice(start, floor + 1), y = holds(points, heights, -Infinity);
      if (y) segments.push({ points: points.map((p, i) => ({ ...p, y: y[i] })), last: false });
    }
    let rim = last;
    for (let i = last; i < Math.min(g.length, last + 40); i++) if (g[i] > g[rim]) rim = i;
    start = rim + 1;
  }
  if (course.length - start >= 4) {
    const points = course.slice(start), heights = g.slice(start), y = holds(points, heights, endLevel);
    if (y) segments.push({ points: points.map((p, i) => ({ ...p, y: y[i] })), last: true });
  }
  return segments;
}

/**
 * Headwater creeks of a planned river system, as compact pieces of at most
 * ~680 m: { id, receiver?, points: [[x, z, width, waterLevel], ...] }. A
 * piece without a receiver continues into the next piece of its creek; the
 * last names the creek or the 'river' it runs into.
 */
export function planCreeks(world, survey, network, { inside = null, budget = 12000, maxCreeks = 28, report = null } = {}) {
  const tree = drainageTree(survey, network.mouth, { headArea: 12000, branchArea: [30000, 22000, 16000, 12000], maxBranches: 80 });
  const height = (x, z) => world._naturalHeight(x, z);
  // Every channel of the river system, by segment.
  const channels = segmentGrid(32);
  for (const route of network.routes) for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1], b = route.points[i];
    channels.add({ ax: a.x, az: a.z, bx: b.x, bz: b.z, a, b }, Math.max(a.hw, b.hw) + 40);
  }
  const channelAt = (x, z, margin) => {
    let best = null;
    for (const entry of channels.near(x, z)) {
      const { t, distance } = pointSegment(x, z, entry.ax, entry.az, entry.bx, entry.bz);
      const hw = entry.a.hw + (entry.b.hw - entry.a.hw) * t;
      if (distance < hw + margin && (!best || distance - hw < best.gap)) best = { gap: distance - hw, entry, t, hw };
    }
    return best;
  };
  const creeks = [], creekOf = new Map(), creekSegments = segmentGrid(24);
  const creekAt = (x, z, margin, except = null) => {
    let best = null;
    for (const entry of creekSegments.near(x, z)) {
      if (entry.creek === except) continue;
      const { t, distance } = pointSegment(x, z, entry.ax, entry.az, entry.bx, entry.bz);
      if (distance < entry.hw + margin && (!best || distance < best.distance)) best = { distance, entry, t };
    }
    return best;
  };
  let used = 0;
  for (const branch of tree) {
    if (creeks.length >= maxCreeks || used >= budget) break;
    const cells = branch.cells.map(k => ({ x: surveyX(survey, k), z: surveyZ(survey, k), area: survey.area[k] }));
    // Where the stem already runs as a river channel, the creek ends there.
    const covered = cells.findIndex(p => channelAt(p.x, p.z, 2));
    if (covered === 0) { report?.('in-channel'); continue; }
    const parents = covered < 0 ? creekOf.get(branch.parent) : null;
    if (covered < 0 && !parents) { report?.('no-parent'); continue; }
    let parent = null;
    const stem = cells.slice(0, covered < 0 ? cells.length : covered + 1);
    if (stem.length < 4) { report?.('short-stem'); continue; }
    let course = resamplePolyline(valleyCentreline(world, stem, { sigma: 12, spacing: 8, probe: () => 4 }), STEP);
    // The last point lies on the receiving water: the channel's centre side
    // of its bank, or the receiving creek's own line.
    let endLevel, join = null;
    if (covered >= 0) {
      const last = course.at(-1), channel = channelAt(last.x, last.z, 30);
      if (!channel) { report?.('no-channel'); continue; }
      const { entry, t, hw } = channel;
      const qx = entry.ax + (entry.bx - entry.ax) * t, qz = entry.az + (entry.bz - entry.az) * t;
      const d = Math.hypot(last.x - qx, last.z - qz), inset = Math.max(0, d - hw * 0.45);
      for (let k = 1, steps = Math.ceil(inset / STEP); k <= steps; k++) {
        const f = k / steps * inset / Math.max(d, 1e-6);
        course.push({ ...last, x: last.x + (qx - last.x) * f, z: last.z + (qz - last.z) * f, inChannel: true });
      }
      // Pour in a little above the river's surface: its fitted level settles later.
      endLevel = (entry.a.level ?? 0) + ((entry.b.level ?? 0) - (entry.a.level ?? 0)) * t + 0.3;
    } else {
      const last = course.at(-1), hit = creekAt(last.x, last.z, 14);
      if (!hit || !parents.includes(hit.entry.creek)) { report?.('parent-missed'); continue; }
      parent = hit.entry.creek;
      const target = parent.points[hit.entry.index + (hit.t > 0.5 ? 1 : 0)];
      course = course.filter(p => Math.hypot(p.x - target.x, p.z - target.z) > parent.width(target) / 2 + 0.5);
      if (course.length < 4) continue;
      course.push({ x: target.x, z: target.z, area: course.at(-1).area });
      endLevel = target.y; join = target;
    }
    let ground = course.map(p => (p.inChannel ? -Infinity : height(p.x, p.z)));
    // A creek that reaches the shore first runs out onto it and into the sea.
    const shore = ground.findIndex(h => h > -Infinity && h < 0.3);
    let toSea = false;
    if (shore >= 0) {
      course = course.slice(0, shore + 1); ground = ground.slice(0, shore + 1);
      endLevel = -Infinity; join = null; toSea = true;
    }
    const segments = segmentsOf(course, ground, endLevel);
    if (!segments.length) { report?.('hollows'); continue; }
    const kept = [];
    segments.forEach((segment, k) => {
      let points = segment.points;
      // A creek keeps clear of villages; it rises again below the last it reaches.
      let cx = 0, cz = 0;
      for (const p of points) { cx += p.x; cz += p.z; }
      cx /= points.length; cz /= points.length;
      const extent = Math.max(...points.map(p => Math.hypot(p.x - cx, p.z - cz)));
      const sites = settlementsAround(world, cx, cz, world.seed, extent + 40, []);
      let blocked = -1;
      points.forEach((p, i) => {
        if (sites.some(site => Math.hypot(site.x - p.x, site.z - p.z) < (site.exclusionHalo || site.radius || 60) + 12)) blocked = i;
      });
      if (blocked >= 0) points = points.slice(blocked + 3);
      if (points.length < 4) { report?.('village'); return; }
      const length = polylineArcs(points).at(-1);
      if (length < MIN_LENGTH || used + length > budget + 400) { report?.(length < MIN_LENGTH ? 'short' : 'budget'); return; }
      if (inside && !points.every(p => inside(p.x, p.z, 12))) { report?.('extent'); return; }
      // Away from its own mouth a creek touches no other water.
      let clash = false, arc = 0;
      for (let i = 0; i < points.length && !clash; i++) {
        if (i) arc += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
        if (length - arc < 40) break;
        if (channelAt(points[i].x, points[i].z, 6) || creekAt(points[i].x, points[i].z, 6)) clash = true;
      }
      if (clash) { report?.('clash'); return; }
      // Area grows down the creek and never shrinks.
      let area = 12000;
      for (const p of points) { area = Math.max(area, p.area ?? 0); p.area = area; }
      const last = segment.last, floor = points.at(-1);
      const creek = { id: `${network.id}:creek:${branch.id}${segments.length > 1 ? `-${k}` : ''}`, branch: branch.id, points,
        receiver: !last ? 'pool' : toSea ? 'sea' : covered >= 0 ? 'river' : parent.id,
        ...(last && !toSea ? { joins: parent, joinsAt: join } : {}),
        ...(!last ? { pool: [floor.x, floor.z, floor.y + 0.25, clamp(2.6 + creekWidth(area), 3, 5.5)] } : {}),
        width: p => creekWidth(p.area) };
      // The receiving creek carries this water on downstream.
      if (last && !toSea) for (let into = parent, from = join; into; from = into.joinsAt, into = into.joins) {
        const index = into.points.indexOf(from);
        for (let i = Math.max(0, index); i < into.points.length; i++) into.points[i].area += area;
      }
      kept.push(creek);
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        creekSegments.add({ ax: a.x, az: a.z, bx: b.x, bz: b.z, creek, index: i - 1, hw: creekWidth(area) / 2 }, 20);
      }
      used += length;
    });
    if (!kept.length) continue;
    creeks.push(...kept); creekOf.set(branch.id, kept);
  }
  // Pieces stay within a forest-brook cell's reach so the brook streamer finds
  // every one from the cell that holds its first point.
  const pieces = [];
  for (const creek of creeks) {
    const arcs = polylineArcs(creek.points);
    let start = 0, part = 0;
    while (start < creek.points.length - 1) {
      let stop = start;
      while (stop < creek.points.length - 1 && arcs[stop + 1] - arcs[start] <= CREEK_PIECE) stop++;
      if (stop === start) stop++;
      const last = stop === creek.points.length - 1;
      pieces.push({ id: `${creek.id}:${part++}`, ...(last ? { receiver: creek.receiver } : {}),
        ...(last && creek.pool ? { pool: creek.pool.map(v => Math.round(v * 100) / 100) } : {}),
        points: creek.points.slice(start, stop + 1).map(p => [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10,
          Math.round(creekWidth(p.area) * 100) / 100, Math.floor(p.y * 100) / 100]) });
      start = stop;
    }
  }
  return pieces;
}
