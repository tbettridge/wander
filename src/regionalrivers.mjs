// Regional river systems grown from the land's own drainage.
//
// One region publishes at most one large river system. Its main river is the
// main stem of the best sea-draining basin: it rises as a spring near the
// basin's divide in the hills, gathers its feeders where their valleys meet,
// widens with the area it drains and meanders across the flats before it
// reaches the sea. The feeders are the basin's large side valleys, and their
// own side valleys feed them in turn, so the network branches like a tree.
//
// Shaping proposes geometry only. Every channel is then fitted jointly with
// the existing section, earthwork, junction-ownership and sparse-mesh rules;
// a feeder that cannot meet them is dropped rather than bent to fit.

import { surveyDrainage, drainageMouths, drainageTree, surveyX, surveyZ, DRAINAGE_KIND } from './regionaldrainage.mjs';
import {
  valleyCentreline, meanderCentreline, attachBranch, riverHalfWidth, riverFootprint,
  polylineArcs, resamplePolyline, fairCentreline,
} from './regionalrivershape.mjs';
import { prepareRiverReach, finishRiverReach } from './riverterrain.mjs';
import { solveRiverGraph } from './rivergraph.mjs';
import { prepareRiverJunctions } from './riverjunctions.mjs';
import { bakeSparseRiverComponent } from './riversparsemesh.mjs';
import { waterPlanningTerrain } from './waterplanningterrain.mjs';
import { BASIN_REGION_SIZE, descriptorHash } from './hydrologyformat.mjs';
import { riverChannelInspection } from './riverchannelreport.mjs';
import { planDistributaries } from './riverdelta.mjs';
import { planCreeks } from './regionalcreeks.mjs';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const BROAD_HALF_WIDTH = 16;
const CHANNEL_HALF_WIDTH = 5;
const MAX_CELLS = 30000;
export const REGIONAL_RIVER_MAX_BYTES = 2100000;

const cellPoints = (survey, cells) => cells.map(k => ({ x: surveyX(survey, k), z: surveyZ(survey, k), area: survey.area[k] }));

// Whether the survey classes the nearest cell as open sea.
function surveySea(survey, x, z) {
  const i = Math.round((x - survey.minX) / survey.cell), j = Math.round((z - survey.minZ) / survey.cell);
  if (i < 0 || j < 0 || i >= survey.cols || j >= survey.rows) return false;
  return survey.kind[j * survey.cols + i] === DRAINAGE_KIND.OCEAN;
}

function nearestStation(points, x, z) {
  let best = 0, distance = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = (points[i].x - x) ** 2 + (points[i].z - z) ** 2;
    if (d < distance) { distance = d; best = i; }
  }
  return best;
}

// Continue a river past its last land cell down the seabed until it is
// clearly below the tide, so the mouth hands its water to the ocean surface.
function extendToSea(world, points) {
  const out = points.map(p => ({ ...p }));
  const end = points.at(-1), back = points[Math.max(0, points.length - 4)];
  let dx = end.x - back.x, dz = end.z - back.z, length = Math.hypot(dx, dz) || 1;
  dx /= length; dz /= length;
  let x = end.x, z = end.z, travelled = 0;
  for (let step = 0; step < 24; step++) {
    let best = null;
    for (let k = 0; k < 16; k++) {
      const a = k / 16 * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
      const turn = ux * dx + uz * dz;
      if (turn < 0.5) continue;
      const h = world._naturalHeight(x + ux * 16, z + uz * 16);
      const score = h - turn * 0.6;
      if (!best || score < best.score) best = { ux, uz, h, score };
    }
    if (!best) return null;
    dx = dx * 0.5 + best.ux * 0.5; dz = dz * 0.5 + best.uz * 0.5;
    length = Math.hypot(dx, dz) || 1; dx /= length; dz /= length;
    x += dx * 16; z += dz * 16; travelled += 16;
    out.push({ ...end, x, z });
    const h = world._naturalHeight(x, z);
    if (travelled >= 48 && h < -1) return out;
  }
  return world._naturalHeight(x, z) < -0.3 ? out : null;
}

/**
 * The water profile a channel can hold. Scans upstream from its outlet level
 * and keeps the longest reach whose water can stay within a few metres of the
 * ground without rising faster than `grade`. The head is then trimmed to a
 * surface spring. Returns the first kept index and preferred levels.
 */
export function channelProfile(world, points, { endLevel = 0, grade = 0.025, cut = 8, fill = 1 } = {}) {
  const n = points.length, arcs = polylineArcs(points);
  for (let i = 1; i < n; i++) if (!(arcs[i] > arcs[i - 1])) return null;
  const heights = points.map(p => world._naturalHeight(p.x, p.z));
  // A channel sits a little below the lowest ground across its banks, so the
  // floodplain's small hollows stay dry beside it instead of filling.
  const lateralLow = (p, a, b) => {
    const tx = b.x - a.x, tz = b.z - a.z, length = Math.hypot(tx, tz) || 1;
    const span = (p.foot ?? riverFootprint(riverHalfWidth(p.area))) + 14;
    let low = Infinity;
    for (let offset = -span; offset <= span; offset += 3) {
      low = Math.min(low, world._naturalHeight(p.x - tz / length * offset, p.z + tx / length * offset));
    }
    return low;
  };
  const lows = points.map((p, i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
    let low = Math.min(heights[i], lateralLow(p, a, b));
    // Halfway to each neighbour as well: a hollow between survey lines can
    // still sit inside the bank envelope.
    for (const q of [a, b]) if (q !== p) {
      const m = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2, foot: p.foot, area: p.area };
      low = Math.min(low, lateralLow(m, a, b));
    }
    return low;
  });
  const minY = heights.map(h => Math.max(0, h - cut)), maxY = heights.map(h => Math.max(0, h + fill));
  const gradeAt = typeof grade === 'function' ? grade : () => grade;
  const grades = points.map(p => gradeAt(p));
  let lo = endLevel, hi = endLevel, start = 0;
  for (let i = n - 2; i >= 0; i--) {
    lo = Math.max(lo, minY[i]); hi = Math.min(hi + grades[i] * (arcs[i + 1] - arcs[i]), maxY[i]);
    if (lo > hi + 1e-9) { start = i + 1; break; }
  }
  // Two-pass interval propagation with each section's own drop limit, then a
  // greedy descent that follows the preferred levels.
  const count = n - start;
  if (count < 2) return null;
  const lower = new Float64Array(count), upper = new Float64Array(count), drop = new Float64Array(count);
  const preferred = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    const i = start + k, last = k === count - 1;
    lower[k] = last ? endLevel : minY[i]; upper[k] = last ? endLevel : maxY[i];
    preferred[k] = last ? endLevel : Math.max(0, Math.min(heights[i] - 0.6, lows[i] - 0.5));
    if (!last) drop[k] = grades[i] * (arcs[i + 1] - arcs[i]);
  }
  for (let k = 1; k < count; k++) {
    lower[k] = Math.max(lower[k], lower[k - 1] - drop[k - 1]); upper[k] = Math.min(upper[k], upper[k - 1]);
  }
  for (let k = count - 2; k >= 0; k--) {
    lower[k] = Math.max(lower[k], lower[k + 1]); upper[k] = Math.min(upper[k], upper[k + 1] + drop[k]);
  }
  for (let k = 0; k < count; k++) if (lower[k] > upper[k] + 1e-9) return null;
  // Look ahead: where the ground falls faster than the water may, begin the
  // descent upstream so the river arrives below the lower ground in time.
  for (let k = count - 2; k >= 0; k--) {
    preferred[k] = Math.max(lower[k], Math.min(preferred[k], preferred[k + 1] + drop[k]));
  }
  const levels = new Float64Array(count);
  levels[0] = clamp(preferred[0], lower[0], upper[0]);
  for (let k = 1; k < count; k++) {
    levels[k] = clamp(preferred[k], Math.max(lower[k], levels[k - 1] - drop[k - 1]), Math.min(upper[k], levels[k - 1]));
  }
  const solved = { levels };
  // A spring rises at the surface, not at the bottom of a cutting. The lowest
  // ground across the channel decides, so a knoll on the line cannot push the
  // spring far downstream.
  let spring = 0;
  while (spring < count - 2 && arcs[start + spring] - arcs[start] < 320
    && lows[start + spring] - solved.levels[spring] > 1.5) spring++;
  return { start: start + spring, scanStart: start, levels: Array.from(solved.levels.slice(spring)), heights: heights.slice(start + spring) };
}

/** Sea-draining basins this region owns, best first. */
export function regionalBasinCandidates(survey, regionX, regionZ, { minArea = 250000, limit = 4 } = {}) {
  const x0 = regionX * BASIN_REGION_SIZE, z0 = regionZ * BASIN_REGION_SIZE;
  const candidates = [];
  for (const mouth of drainageMouths(survey, minArea)) {
    const tree = drainageTree(survey, mouth, { branchArea: [], maxBranches: 1 });
    const cells = tree[0].cells, middle = cells[Math.floor(cells.length / 2)];
    const mx = surveyX(survey, middle), mz = surveyZ(survey, middle);
    // The region holding the middle of the main stem owns the basin, so two
    // neighbouring surveys never both publish the same river.
    if (mx < x0 || mx >= x0 + BASIN_REGION_SIZE || mz < z0 || mz >= z0 + BASIN_REGION_SIZE) continue;
    let length = 0;
    for (let i = 1; i < cells.length; i++) {
      length += Math.hypot(surveyX(survey, cells[i]) - surveyX(survey, cells[i - 1]),
        surveyZ(survey, cells[i]) - surveyZ(survey, cells[i - 1]));
    }
    const source = survey.height[cells[0]];
    candidates.push({ mouth, length, area: survey.area[mouth], source,
      score: length + 420 * Math.sqrt(survey.area[mouth] / 1e6) + 4 * clamp(source, 0, 90) });
  }
  return candidates.sort((a, b) => b.score - a.score || a.mouth - b.mouth).slice(0, limit);
}

function profileLevelAt(route, index) {
  return route.levels[clamp(index, 0, route.levels.length - 1)];
}

// Attach confined widths and envelope estimates to a route's points.
function annotateWidths(world, route) {
  const { widths, openness } = channelWidths(world, route);
  route.points.forEach((p, i) => {
    p.hw = widths[i]; p.open = openness[i]; p.level = route.levels[i];
    p.foot = widths[i] * 1.7 + 9 + 8 * openness[i] + (route.order === 0 && widths[i] >= 12 ? 25 * openness[i] : 0);
  });
  return route;
}

/**
 * Shape the channel tree of one basin. Returns the trunk and accepted feeders
 * with their junction stations, or null when the main river is unsupported.
 */
export function shapeRegionalNetwork(world, survey, mouth, {
  seed = world.seed, id = `river:${world.seed}:${mouth}`, trunkMeanders = 1, exclude = new Set(),
  maxFeeders = 8, maxSubFeeders = 6, feederBudget = 7000, inside = null,
} = {}) {
  const tree = drainageTree(survey, mouth, { headArea: 15000, branchArea: [100000, 50000], maxBranches: 28 });
  let trunk = valleyCentreline(world, cellPoints(survey, tree[0].cells), { sigma: 40,
    probe: p => Math.max(6, riverFootprint(riverHalfWidth(p.area)) * 0.7) });
  const failed = reason => ({ status: 'rejected', reason });
  trunk = extendToSea(world, trunk);
  if (!trunk) return failed('trunk-sea-handoff');
  const trunkGrade = p => channelGrade(p.hw ?? riverHalfWidth(p.area));
  let profile = channelProfile(world, trunk, { endLevel: 0, grade: trunkGrade, cut: 12 });
  if (!profile || polylineArcs(trunk.slice(profile.start)).at(-1) < 900) return failed('trunk-profile');
  trunk = annotateWidths(world, { order: 0, points: trunk.slice(profile.start), levels: profile.levels }).points;
  trunk = fairCentreline(trunk, p => p.foot);
  if (!trunk) return failed('trunk-bends');
  // Junctions should land on calm, straight water. Quiet the meander train
  // where the large side valleys come in.
  const arcs = polylineArcs(trunk);
  const quiet = tree.filter(b => b.parent === 0 && survey.area[b.cells.at(-2)] >= 100000).map(b => {
    const at = nearestStation(trunk, surveyX(survey, b.cells.at(-1)), surveyZ(survey, b.cells.at(-1)));
    return { arc: arcs[at], radius: trunk[at].foot * 1.6 + 40 };
  });
  // Meanders are proposals: weaken them until the meandered river can still
  // hold a falling water surface everywhere along the faired line.
  let shaped = null;
  for (const strength of [trunkMeanders, trunkMeanders * 0.6, trunkMeanders * 0.3, 0]) {
    let line = strength > 0 ? meanderCentreline(world, trunk, { seed: seed * 31 + mouth, strength,
      ratio: 0.17, wavelength: 12, endFade: 300, quiet, halfWidthAt: p => p.hw, footAt: p => p.foot }) : trunk;
    let fit = channelProfile(world, line, { endLevel: 0, grade: trunkGrade, cut: 12 });
    if (!fit || polylineArcs(line.slice(fit.start)).at(-1) < 900) continue;
    line = fairCentreline(annotateWidths(world, { order: 0, points: line.slice(fit.start), levels: fit.levels }).points, p => p.foot);
    if (!line) continue;
    fit = channelProfile(world, line, { endLevel: 0, grade: trunkGrade, cut: 12 });
    if (!fit || polylineArcs(line.slice(fit.start)).at(-1) < 900) continue;
    shaped = { line: line.slice(fit.start), fit, strength };
    break;
  }
  if (!shaped) return failed('trunk-meanders');
  trunk = shaped.line; profile = shaped.fit;
  const routes = [annotateWidths(world, { id: `${id}:0`, branch: 0, order: 0, parent: null, points: trunk,
    levels: profile.levels, joins: [] })];
  const byBranch = new Map([[0, routes[0]]]);
  const routeArcs = route => route.arcs || (route.arcs = polylineArcs(route.points));
  const foot = (route, i) => route.points[i].foot;
  let budget = feederBudget;
  const accepted = { 1: 0, 2: 0 }, rejected = [];
  const skip = (branch, reason) => { rejected.push({ branch: branch.id, order: branch.order, reason }); };
  const candidates = tree.slice(1).filter(b => !exclude.has(b.id))
    .sort((a, b) => a.order - b.order || survey.area[b.cells.at(-2)] - survey.area[a.cells.at(-2)] || a.id - b.id);
  for (const branch of candidates) {
    const parent = byBranch.get(branch.parent);
    if (!parent) { skip(branch, 'parent'); continue; }
    if (accepted[branch.order] >= (branch.order === 1 ? maxFeeders : maxSubFeeders)) { skip(branch, 'count'); continue; }
    let points = valleyCentreline(world, cellPoints(survey, branch.cells), { sigma: 24,
      probe: p => Math.max(6, riverFootprint(riverHalfWidth(p.area)) * 0.7) });
    const near = nearestStation(parent.points, points.at(-1).x, points.at(-1).z);
    const grade = p => channelGrade(p.hw ?? riverHalfWidth(p.area));
    const shape = channelProfile(world, points, { endLevel: profileLevelAt(parent, near), grade, cut: 6 });
    if (!shape) { skip(branch, 'profile'); continue; }
    points = points.slice(shape.start);
    if (polylineArcs(points).at(-1) < (branch.order === 1 ? 260 : 200)) { skip(branch, 'short'); continue; }
    points = annotateWidths(world, { order: branch.order, points, levels: shape.levels }).points;
    points = meanderCentreline(world, points, { seed: seed * 17 + branch.id * 101 + mouth,
      strength: 0.6, ratio: 0.12, wavelength: 13, startFade: 80, endFade: 140,
      halfWidthAt: p => p.hw, footAt: p => p.foot });
    const parentArcs = routeArcs(parent), parentLength = parentArcs.at(-1);
    // Stay off the receiving river's spring, its mouth level and the station
    // where it meets its own receiver.
    const endReserve = parent.order === 0 ? 220 : foot(byBranch.get(parent.parentBranch), parent.joinStation) * 1.5 + 80;
    const minIndex = parentArcs.findIndex(a => a >= 60);
    let maxIndex = parentArcs.findLastIndex(a => a <= parentLength - endReserve);
    if (minIndex < 0 || maxIndex < minIndex) { skip(branch, 'parent-span'); continue; }
    const childFoot = Math.max(...points.slice(-6).map(p => p.foot));
    const attached = attachBranch(points, parent.points, { minIndex, maxIndex,
      parentFoot: j => foot(parent, j), parentHalfWidth: j => parent.points[j].hw, childFoot: () => childFoot });
    if (!attached) { skip(branch, 'attach'); continue; }
    const faired = fairCentreline(attached.points, p => p.foot ?? childFoot);
    if (!faired) { skip(branch, 'bend'); continue; }
    attached.points = faired;
    const joinArc = parentArcs[attached.index];
    const spacing = 2.2 * foot(parent, attached.index) + 1.4 * childFoot + 60;
    if (parent.joins.some(j => Math.abs(parentArcs[j.index] - joinArc) < spacing)) { skip(branch, 'spacing'); continue; }
    const length = polylineArcs(attached.points).at(-1);
    if (length > budget) { skip(branch, 'budget'); continue; }
    if (inside && !attached.points.every(p => inside(p.x, p.z, (p.foot ?? childFoot) + 40))) { skip(branch, 'extent'); continue; }
    // Feeders may not touch any other channel except at their own junction.
    const clash = routes.some(other => {
      if (other === parent) return false;
      const reach = other.points;
      for (let i = 0; i < attached.points.length - 1; i += 2) {
        const p = attached.points[i];
        for (let j = 0; j < reach.length; j += 2) {
          const q = reach[j], clearance = (p.foot ?? childFoot) + q.foot + 12;
          if (Math.abs(p.x - q.x) < clearance && Math.abs(p.z - q.z) < clearance
            && Math.hypot(p.x - q.x, p.z - q.z) < clearance) return true;
        }
      }
      return false;
    });
    if (clash) { skip(branch, 'clash'); continue; }
    const childProfile = channelProfile(world, attached.points, { endLevel: profileLevelAt(parent, attached.index), grade, cut: 7 });
    if (!childProfile || childProfile.start > 2) { skip(branch, 'attached-profile'); continue; }
    const route = annotateWidths(world, { id: `${id}:${branch.id}`, branch: branch.id, order: branch.order, parent: parent.id,
      parentBranch: branch.parent, joinStation: attached.index, points: attached.points.slice(childProfile.start),
      levels: childProfile.levels, joins: [] });
    parent.joins.push({ index: attached.index, child: route.id });
    routes.push(route); byBranch.set(branch.id, route);
    budget -= length; accepted[branch.order]++;
  }
  // Below the last large confluence the river may fork into distributaries
  // across the coastal flats. Feeders come first: a delta forms on the plain
  // beneath the river's tributaries, never in place of them. The fork keeps
  // clear of the smaller side valleys too, so their creeks join above or
  // below it rather than at it.
  let delta = null;
  if (!exclude.has('delta')) {
    const stem = tree[0].cells, inflows = [];
    for (let index = 1; index < stem.length; index++) {
      const cell = stem[index];
      for (let i = survey.donorStart[cell]; i < survey.donorStart[cell + 1]; i++) {
        const donor = survey.donors[i];
        if (donor !== stem[index - 1] && survey.area[donor] >= 22000) {
          inflows.push({ x: surveyX(survey, cell), z: surveyZ(survey, cell), radius: 170 });
        }
      }
    }
    const main = routes[0], mainArcs = routeArcs(main);
    const below = main.joins.reduce((arc, join) => Math.max(arc, mainArcs[join.index] + 2.2 * main.points[join.index].foot + 100), 0);
    delta = planDistributaries(world, main, { seed: seed + mouth, avoid: inflows, below,
      bends: !exclude.has('delta-bends'), isSea: (x, z) => surveySea(survey, x, z) });
  }
  if (delta) {
    const main = routes[0], apex = main.points[delta.apex], arcsMain = polylineArcs(main.points);
    const flare = (arc, total) => 1 + 1.4 * smoothstepValue(total - 160, total, arc) ** 2;
    // The main channel gives up each arm's share of the flow at its fork.
    for (let i = delta.apex + 1; i < main.points.length; i++) {
      const share = 1 - delta.armShare * delta.arms.filter(arm => arm.fork < i).length;
      main.points[i].area = apex.area * share * flare(arcsMain[i], arcsMain.at(-1));
    }
    annotateWidths(world, main);
    delta.arms.forEach((arm, k) => {
      const fork = main.points[arm.fork];
      const armArcs = polylineArcs(arm.points), total = armArcs.at(-1);
      const points = arm.points.map((p, i) => ({ x: p.x, z: p.z, area: apex.area * delta.armShare * flare(armArcs[i], total) }));
      points[0] = { ...points[0], x: fork.x, z: fork.z };
      // Each arm falls from the fork's level to the tide over its own ground.
      const fall = channelProfile(world, points, { endLevel: 0, grade: 0.025, cut: 8 });
      const top = main.levels[arm.fork];
      const levels = fall && fall.start === 0 ? fall.levels.map((level, i) => Math.min(top, level, i ? Infinity : top))
        : armArcs.map(arc => Math.max(0, top * (1 - arc / total)));
      levels[0] = top;
      for (let i = 1; i < levels.length; i++) levels[i] = Math.min(levels[i], levels[i - 1]);
      const route = annotateWidths(world, { id: `${id}:delta:${k}`, branch: `delta:${k}`, order: 1, distributary: true,
        parent: main.id, parentBranch: 0, joinStation: arm.fork, points, levels, joins: [] });
      main.joins.push({ index: arm.fork, child: route.id });
      routes.push(route); byBranch.set(route.branch, route);
    });
  }
  for (const route of routes) delete route.arcs;
  return { status: 'shaped', id, mouth, routes, rejected, meanderStrength: shaped.strength,
    ...(delta ? { delta: { apex: delta.apex, arms: delta.arms.length + 1, x: routes[0].points[delta.apex].x, z: routes[0].points[delta.apex].z } } : {}) };
}

const channelDepth = halfWidth => clamp(0.6 + 0.045 * halfWidth, 0.85, 2.3);
// Small upland streams may run steeper than the broad lowland river.
export const channelGrade = halfWidth => halfWidth < 6 ? 0.04 : halfWidth < 12 ? 0.032 : 0.025;

function gaussianSeries(values, arcs, sigma) {
  return values.map((_, i) => {
    let sum = 0, weight = 0;
    for (let j = 0; j < values.length; j++) {
      const d = arcs[j] - arcs[i];
      if (d < -3 * sigma) continue;
      if (d > 3 * sigma) break;
      const w = Math.exp(-d * d / (2 * sigma * sigma));
      sum += values[j] * w; weight += w;
    }
    return sum / weight;
  });
}

// A river is as wide as its catchment allows where its valley is open, and
// narrower and deeper where hills close in on both banks. Broad floodplain
// banks only form where the valley floor has room for them.
export function channelWidths(world, route) {
  const points = route.points, n = points.length, arcs = polylineArcs(points);
  const valley = points.map((p, i) => {
    const a = points[Math.max(0, i - 2)], b = points[Math.min(n - 1, i + 2)];
    const tx = b.x - a.x, tz = b.z - a.z, length = Math.hypot(tx, tz) || 1;
    const nx = -tz / length, nz = tx / length, ceiling = route.levels[i] + 2.5;
    let total = 0;
    for (const side of [-1, 1]) {
      let offset = 6;
      for (; offset <= 360; offset += 6) {
        if (world._naturalHeight(p.x + nx * offset * side, p.z + nz * offset * side) > ceiling) break;
      }
      total += offset - 6;
    }
    return total;
  });
  const floor = gaussianSeries(valley.map((_, i) => {
    let low = Infinity;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) low = Math.min(low, valley[j]);
    return low;
  }), arcs, 40);
  // Channels in the mesh stay at least a few lattice cells wide; anything
  // narrower is drawn as a headwater creek instead.
  // A channel's spring narrows to the creek that feeds it over its first
  // few tens of metres; that nose lies under the creek's own ribbon.
  const minimum = arc => route.distributary ? CHANNEL_HALF_WIDTH
    : CHANNEL_HALF_WIDTH * (0.5 + 0.5 * smoothstepValue(0, 64, arc));
  const widths = gaussianSeries(points.map((p, i) => {
    const natural = riverHalfWidth(p.area);
    return Math.max(Math.min(natural, floor[i] * 0.3 - 4), Math.min(natural, natural * 0.25 + 1), minimum(arcs[i]));
  }), arcs, 48).map((width, i) => Math.max(width, minimum(arcs[i])));
  const openness = floor.map((width, i) => smoothstepValue(1, 2.2, width / (2 * widths[i] + 60)));
  // Calm the width noise where a channel is only a few lattice cells across.
  const variation = widths.map(width => 0.35 + 0.65 * smoothstepValue(CHANNEL_HALF_WIDTH, CHANNEL_HALF_WIDTH * 2, width));
  return { arcs, widths, openness, variation };
}

function smoothstepValue(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function knotsFor(arcs, values, first, last, spacing = 32) {
  const knots = [[arcs[first], values[first]]];
  for (let i = first + 1; i < last; i++) {
    if (arcs[i] - knots.at(-1)[0] >= spacing && arcs[last] - arcs[i] >= spacing * 0.5) knots.push([arcs[i], values[i]]);
  }
  knots.push([arcs[last], values[last]]);
  return knots;
}

// Water only touches a receiving river within its own wet channel. Treat that
// water as bank support while fitting a feeder's confluence sections; the
// joint bake still checks the real terrain everywhere.
function receivingSupport(world, reaches) {
  const bins = new Map(), size = 32;
  for (const reach of reaches) for (let i = 1; i < reach.points.length; i++) {
    const a = reach.points[i - 1], b = reach.points[i];
    const margin = Math.max(a.leftWidth, a.rightWidth, b.leftWidth, b.rightWidth);
    for (let z = Math.floor((Math.min(a.z, b.z) - margin) / size); z <= Math.floor((Math.max(a.z, b.z) + margin) / size); z++) {
      for (let x = Math.floor((Math.min(a.x, b.x) - margin) / size); x <= Math.floor((Math.max(a.x, b.x) + margin) / size); x++) {
        const key = `${x},${z}`;
        if (!bins.has(key)) bins.set(key, []);
        bins.get(key).push([a, b]);
      }
    }
  }
  const support = Object.create(world);
  support._naturalHeight = (x, z, out) => {
    const natural = world._naturalHeight(x, z, out);
    let level = -Infinity;
    for (const [a, b] of bins.get(`${Math.floor(x / size)},${Math.floor(z / size)}`) || []) {
      const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
      const t = length > 0 ? clamp(((x - a.x) * dx + (z - a.z) * dz) / length, 0, 1) : 0;
      const px = a.x + dx * t, pz = a.z + dz * t, lateral = (x - px) * -(dz) + (z - pz) * dx;
      const width = lateral < 0 ? a.leftWidth + (b.leftWidth - a.leftWidth) * t
        : a.rightWidth + (b.rightWidth - a.rightWidth) * t;
      if (Math.hypot(x - px, z - pz) < width * 0.92) level = Math.max(level, a.preferredY + (b.preferredY - a.preferredY) * t);
    }
    const height = level > -Infinity ? Math.max(natural, level + 0.2) : natural;
    if (out) out.h = height;
    return height;
  };
  return support;
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
  const t = length > 0 ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / length, 0, 1) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

const sectionMargin = p => Math.max(p.leftWidth + p.leftBankWidth + p.leftBlendWidth,
  p.rightWidth + p.rightBankWidth + p.rightBlendWidth);

// Flat collar lengths around each junction: every section whose envelope can
// meet another incident reach's envelope, or the circular confluence cap, must
// carry the junction's own level. Returns null when a collar is unsupported.
function junctionCollars(reaches, junctionIds, limit) {
  const collars = new Map([...junctionIds].map(id => [id, { length: 0, reachLengths: new Map() }]));
  const ends = reach => [reach.points[0].nodeId, reach.points.at(-1).nodeId];
  const distance = (reach, point, owner) => reach.points[0].nodeId === owner ? point.arc : reach.points.at(-1).arc - point.arc;
  const extend = (owner, reach, length) => {
    const collar = collars.get(owner);
    collar.reachLengths.set(reach.id, Math.max(collar.reachLengths.get(reach.id) || 0, length));
    collar.length = Math.max(collar.length, collar.reachLengths.get(reach.id));
  };
  for (const owner of junctionIds) {
    const incident = reaches.filter(reach => ends(reach).includes(owner));
    const ownerPoint = incident[0]?.points.find(p => p.nodeId === owner);
    if (!ownerPoint) continue;
    const cap = Math.max(...incident.map(reach => sectionMargin(reach.points[0].nodeId === owner ? reach.points[0] : reach.points.at(-1))));
    for (const reach of incident) for (const point of reach.points) {
      if (Math.hypot(point.x - ownerPoint.x, point.z - ownerPoint.z) < cap + sectionMargin(point) + 2) {
        extend(owner, reach, distance(reach, point, owner) + 4);
      }
    }
    for (let i = 0; i < incident.length; i++) for (let k = i + 1; k < incident.length; k++) {
      const left = incident[i], right = incident[k];
      for (let a = 1; a < left.points.length; a++) {
        const a0 = left.points[a - 1], a1 = left.points[a], am = Math.max(sectionMargin(a0), sectionMargin(a1));
        for (let b = 1; b < right.points.length; b++) {
          const b0 = right.points[b - 1], b1 = right.points[b], bm = Math.max(sectionMargin(b0), sectionMargin(b1));
          const reachDistance = am + bm + 8;
          if (Math.abs(a0.x - b0.x) > reachDistance + 8 || Math.abs(a0.z - b0.z) > reachDistance + 8) continue;
          if (Math.min(pointSegmentDistance(a0, b0, b1), pointSegmentDistance(a1, b0, b1),
            pointSegmentDistance(b0, a0, a1), pointSegmentDistance(b1, a0, a1)) >= am + bm) continue;
          extend(owner, left, Math.max(distance(left, a0, owner), distance(left, a1, owner)) + 4);
          extend(owner, right, Math.max(distance(right, b0, owner), distance(right, b1, owner)) + 4);
        }
      }
    }
    if (collars.get(owner).length > limit) return { failed: owner };
  }
  return collars;
}

function routePoint(point, extra = {}) {
  return { x: point.x, z: point.z, waterY: point.waterY, ...extra };
}

/**
 * Fit a shaped network as one component. Every route is split at its
 * junction stations; widths step up below each confluence. On failure the
 * result names the route most likely responsible so the caller can drop it.
 */
export function fitRegionalNetwork(world, network, { collarLimit = 440 } = {}) {
  const routes = network.routes, byId = new Map(routes.map(route => [route.id, route]));
  const junctionId = (route, index) => `${route.id}:join:${index}`;
  const segments = [];
  for (const route of routes) {
    const n = route.points.length;
    const cuts = [...new Set(route.joins.map(join => join.index))].sort((a, b) => a - b);
    const bounds = [0, ...cuts, n - 1];
    const { arcs, widths, openness, variation } = channelWidths(world, route);
    const parent = route.parent ? byId.get(route.parent) : null;
    const forkId = parent ? junctionId(parent, route.joinStation) : null;
    const endId = parent && !route.distributary ? forkId : `${route.id}:mouth`;
    for (let s = 1; s < bounds.length; s++) {
      const first = bounds[s - 1], last = bounds[s];
      if (last - first < 1) continue;
      const slice = route.points.slice(first, last + 1);
      const levels = route.levels.slice(first, last + 1);
      const points = slice.map((point, i) => routePoint({ ...point, waterY: levels[i] }));
      const startId = first === 0 ? (route.distributary ? forkId : `${route.id}:source`) : junctionId(route, first);
      points[0].id = startId;
      points[points.length - 1].id = last === n - 1 ? endId : junctionId(route, last);
      const widthKnots = knotsFor(arcs, widths, first, last);
      const opennessKnots = knotsFor(arcs, openness, first, last);
      const variationKnots = knotsFor(arcs, variation, first, last);
      const segmentWidths = widthKnots.map(knot => knot[1]);
      const halfWidth = segmentWidths.reduce((sum, w) => sum + w, 0) / segmentWidths.length;
      const broad = route.order === 0 && Math.max(...segmentWidths) >= BROAD_HALF_WIDTH;
      const length = arcs[last] - arcs[first];
      const reachId = `${route.id}:${s - 1}`;
      segments.push({ route, first, last, id: reachId, startId, endId: points.at(-1).id,
        candidate: { status: 'candidate', id: reachId, source: startId, points, profileArcLength: length },
        options: { id: reachId, maxCut: 18, maxFill: route.order === 0 ? 4 : 2.5,
          maxGrade: channelGrade(Math.min(...segmentWidths)),
          sourceClosure: first === 0 && !route.distributary,
          oceanMouth: (route.order === 0 || route.distributary === true) && last === n - 1,
          channelProfile: { id: `${network.id}:${route.branch}`, halfWidth,
            startHalfWidth: segmentWidths[0], endHalfWidth: segmentWidths.at(-1), wide: true,
            widthKnots, opennessKnots, variationKnots,
            depth: channelDepth(halfWidth), arcOffset: arcs[first],
            variationSeed: world.seed + (Number.isFinite(route.branch) ? route.branch : 9000 + route.joins.length + route.points.length) * 7919,
            morphology: true, ...(broad ? { regionalTrunk: true } : {}) } } });
    }
  }
  // Prepare parents first so a feeder's confluence can see the receiving water.
  const prepared = new Map();
  for (const order of [0, 1, 2, 3]) {
    for (const segment of segments.filter(s => s.route.order === order)) {
      let terrain = world;
      const parent = segment.route.parent ? byId.get(segment.route.parent) : null;
      if (parent && (segment.route.distributary ? segment.first === 0 : segment.last === segment.route.points.length - 1)) {
        terrain = receivingSupport(world, segments.filter(s => s.route === parent).map(s => prepared.get(s.id)).filter(Boolean));
      }
      const reach = prepareRiverReach(terrain, segment.candidate, segment.options);
      if (reach.status !== 'prepared') return { status: 'rejected', stage: 'prepare', reason: reach.reason, route: segment.route.id,
        ...(Number.isFinite(reach.x) ? { x: reach.x, z: reach.z } : {}) };
      prepared.set(segment.id, reach);
    }
  }
  const reaches = segments.map(segment => prepared.get(segment.id));
  const junctionIds = new Set();
  for (const route of routes) for (const join of route.joins) junctionIds.add(junctionId(route, join.index));
  const collars = junctionCollars(reaches, junctionIds, collarLimit);
  if (collars.failed) {
    const child = routes.find(route => route.parent && junctionId(byId.get(route.parent), route.joinStation) === collars.failed);
    return { status: 'rejected', stage: 'collar', reason: 'junction-collar-budget', route: child?.id ?? null };
  }
  const nodes = new Map(), edges = [], owner = new Map();
  for (let r = 0; r < reaches.length; r++) {
    const reach = reaches[r], segment = segments[r], length = reach.points.at(-1).arc;
    const startCollar = collars.get(reach.points[0].nodeId)?.reachLengths.get(reach.id) || 0;
    const endCollar = collars.get(reach.points.at(-1).nodeId)?.reachLengths.get(reach.id) || 0;
    for (let i = 0; i < reach.points.length; i++) {
      const point = reach.points[i], id = point.nodeId || `section:${reach.id}:${i}`;
      point.nodeId = id;
      const prior = nodes.get(id);
      if (prior) {
        if (Math.abs(prior.x - point.x) > 1e-9 || Math.abs(prior.z - point.z) > 1e-9) {
          return { status: 'rejected', stage: 'graph', reason: 'conflicting-junction', route: segment.route.id };
        }
        prior.minY = Math.max(prior.minY, point.minY); prior.maxY = Math.min(prior.maxY, point.maxY);
        prior.preferredY = Math.min(prior.preferredY, point.preferredY);
      } else {
        nodes.set(id, { id, x: point.x, z: point.z, minY: point.minY, maxY: point.maxY, preferredY: point.preferredY });
        owner.set(id, segment.route.id);
      }
      if (!i) continue;
      const previous = reach.points[i - 1], run = point.arc - previous.arc;
      const level = previous.arc < startCollar || length - point.arc < endCollar
        || (reach.oceanMouth && length - point.arc < 96);
      edges.push({ id: `${reach.id}:${i}`, from: previous.nodeId, to: id, length: run,
        maxDrop: level ? 0 : run * reach.maxGrade });
    }
  }
  const solved = solveRiverGraph([...nodes.values()], edges, { maxGrade: 0.04 });
  if (solved.status !== 'accepted') {
    return { status: 'rejected', stage: 'levels', reason: solved.reason, route: owner.get(solved.id) ?? null,
      node: solved.id, ...(nodes.get(solved.id) ? { x: nodes.get(solved.id).x, z: nodes.get(solved.id).z } : {}) };
  }
  const fitted = reaches.map(reach => finishRiverReach(reach, reach.points.map(p => solved.levels[p.nodeId])));
  const routeOf = new Map(segments.map(segment => [segment.id, segment.route.id]));
  const junctions = [...junctionIds].sort().map(nodeId => {
    const incoming = fitted.filter(r => r.points.at(-1).nodeId === nodeId).map(r => r.id).sort();
    const outgoing = fitted.filter(r => r.points[0].nodeId === nodeId);
    // A fork's continuation is the river that owns the node.
    const owner = segments.find(segment => junctionId(segment.route, segment.first) === nodeId)?.route.id;
    const continuing = outgoing.find(r => routeOf.get(r.id) === owner) || outgoing[0];
    const point = (continuing || fitted.find(r => r.points.at(-1).nodeId === nodeId)).points
      .find(p => p.nodeId === nodeId);
    return { id: `junction:${nodeId}`, nodeId, x: point.x, z: point.z, waterY: solved.levels[nodeId],
      levelLength: collars.get(nodeId).length, incomingReachIds: incoming, outgoingReachId: continuing?.id ?? null,
      ...(outgoing.length > 1 ? { outgoingReachIds: outgoing.map(r => r.id).sort() } : {}) };
  });
  return { status: 'fitted', preciseOwnership: true, reaches: fitted, junctions, routeOf };
}

// The feeder most likely responsible for a failure near (x, z): the one whose
// confluence or channel lies closest.
function blameFeeder(network, x, z, reach = 500) {
  let best = null, distance = Infinity;
  for (const route of network.routes) {
    for (const join of route.joins) {
      const p = route.points[join.index], d = Math.hypot(p.x - x, p.z - z);
      if (d < distance) { distance = d; best = network.routes.find(child => child.id === join.child); }
    }
    if (route.order > 0) for (const p of route.points) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < distance) { distance = d; best = route; }
    }
  }
  return distance < reach ? best : null;
}

function failureCulprit(network, failure, routeOf = null) {
  const route = network.routes.find(r => r.id === failure.route);
  if (route?.order > 0) return route;
  if (failure.reachIds && routeOf) {
    const routes = failure.reachIds.map(id => network.routes.find(r => r.id === routeOf.get(id)))
      .filter(r => r && r.order > 0).sort((a, b) => b.order - a.order || a.points.length - b.points.length);
    if (routes.length) return routes[0];
  }
  return Number.isFinite(failure.x) ? blameFeeder(network, failure.x, failure.z) : null;
}

// A delta's channel lines, from a little above the fork to every mouth. The
// terrain dresses the low ground around them as reed marsh and tidal mud
// rather than a sand beach.
function deltaPlainOf(network) {
  const main = network.routes[0], from = Math.max(0, network.delta.apex - 12);
  const lines = [main.points.slice(from), ...network.routes.filter(route => route.distributary).map(route => route.points)];
  return { channels: lines.map(line => resamplePolyline(line, 32).map(p => [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10])) };
}

/**
 * Plan one region's river system: the best basin whose main stem lies in the
 * region, with as many of its feeders as fit the joint terrain, junction and
 * mesh rules. `outer` bounds every published vertex.
 */
export function planRegionalRiver(world, regionX, regionZ, { outer, maxBytes = REGIONAL_RIVER_MAX_BYTES, basins = 3 } = {}) {
  if (!outer || ![outer.minX, outer.minZ, outer.maxX, outer.maxZ].every(Number.isFinite)) throw new Error('Invalid regional river extent');
  world = waterPlanningTerrain(world);
  const margin = 192;
  const survey = surveyDrainage(world, { minX: outer.minX + margin, minZ: outer.minZ + margin,
    maxX: outer.maxX - margin, maxZ: outer.maxZ - margin, cell: 16 });
  const inside = (x, z, pad) => x - pad >= outer.minX && x + pad <= outer.maxX && z - pad >= outer.minZ && z + pad <= outer.maxZ;
  const attempts = [];
  for (const basin of regionalBasinCandidates(survey, regionX, regionZ).slice(0, basins)) {
    const id = `river:${world.seed}:${regionX},${regionZ}:${basin.mouth}`;
    const exclude = new Set();
    let trunkMeanders = 1;
    for (let attempt = 0; attempt < 14; attempt++) {
      const network = shapeRegionalNetwork(world, survey, basin.mouth, { id, exclude, inside, trunkMeanders });
      const record = (stage, reason, extra = {}) => attempts.push({ basin: basin.mouth, attempt, stage, reason, ...extra });
      if (network.status !== 'shaped') { record('shape', network.reason); break; }
      const trunk = network.routes[0];
      if (!trunk.points.every(p => inside(p.x, p.z, p.foot + 30))) { record('shape', 'trunk-extent'); break; }
      let failure = null, fitted = fitRegionalNetwork(world, network);
      if (fitted.status !== 'fitted') failure = fitted;
      else {
        const ownership = prepareRiverJunctions(fitted);
        if (ownership.status !== 'prepared') failure = { ...ownership, stage: 'junctions' };
      }
      let mesh = null;
      if (!failure) {
        mesh = bakeSparseRiverComponent(world, fitted, { gridStep: 4, maxCells: 60000, quantize: true });
        if (mesh.status !== 'baked') failure = { ...mesh, stage: 'mesh' };
        else if (JSON.stringify(mesh).length > maxBytes) failure = { stage: 'mesh', reason: 'regional-river-bytes' };
      }
      if (!failure) {
        // Headwater creeks complete the tree above the river mesh, and a
        // delta names the channels its marsh plain spreads around. Both are
        // published with the component so neighbours resolve them together.
        const creeks = planCreeks(world, survey, network, { inside });
        const extras = { ...(creeks.length ? { creeks } : {}), ...(network.delta ? { delta: deltaPlainOf(network) } : {}) };
        if (Object.keys(extras).length) {
          const { status, hash, activationReady, ...payload } = mesh;
          Object.assign(payload, extras);
          if (JSON.stringify(payload).length <= maxBytes) mesh = { status, ...payload, hash: descriptorHash(payload), activationReady };
        }
        return { status: 'baked', component: fitted, mesh, network, ...(network.delta ? { delta: network.delta } : {}),
          diagnostics: { basin: { mouth: basin.mouth, area: basin.area, length: basin.length, source: basin.source },
            attempts, trunkMeanders, routes: network.routes.length, rejectedFeeders: network.rejected.length } };
      }
      record(failure.stage, failure.reason, Number.isFinite(failure.x) ? { x: failure.x, z: failure.z } : {});
      if (failure.reason === 'regional-river-bytes' || failure.reason === 'component-mesh-budget') {
        const smallest = network.routes.filter(r => r.order > 0 && !r.joins.length && !r.distributary)
          .sort((a, b) => a.points.length - b.points.length || a.branch - b.branch)[0];
        if (smallest) { exclude.add(smallest.branch); continue; }
        if (!network.delta) break;
        exclude.add('delta'); continue;
      }
      const culprit = failureCulprit(network, failure, fitted?.routeOf);
      // A delta that will not fit tries calmer arms before giving them up.
      if (culprit?.distributary) { exclude.add(exclude.has('delta-bends') ? 'delta' : 'delta-bends'); continue; }
      if (culprit) { exclude.add(culprit.branch); continue; }
      // The main river itself failed: try it with gentler meanders before
      // giving up on this basin.
      if (trunkMeanders > 0) { trunkMeanders = trunkMeanders > 0.5 ? 0.4 : 0; continue; }
      break;
    }
  }
  return { status: 'rejected', reason: 'regional-river-terrain', diagnostics: { attempts } };
}

/** Summary and inspection views for a baked regional river system. */
export function regionalRiverDiagnostics(river) {
  const { component, network } = river;
  const trunkId = network.routes[0].id, routeOf = component.routeOf;
  const trunk = component.reaches.filter(r => routeOf?.get(r.id) === trunkId || r.id.startsWith(`${trunkId}:`));
  const trunkPoints = trunk.flatMap(r => r.points);
  const length = trunk.reduce((sum, r) => sum + r.points.at(-1).arc, 0);
  const source = network.routes[0].points[0], mouth = network.routes[0].points.at(-1);
  const widths = trunkPoints.map(p => p.leftWidth + p.rightWidth);
  const inspection = riverChannelInspection(component);
  const view = (kind, label, p) => p && ({ kind, label, x: p.x, z: p.z,
    ...(Number.isFinite(p.tx) ? { tangentX: p.tx, tangentZ: p.tz } : {}) });
  if (inspection) {
    const along = fraction => trunkPoints[Math.min(trunkPoints.length - 1, Math.floor(trunkPoints.length * fraction))];
    const upper = view('upper-main', 'Upper main river', along(0.22));
    if (upper) inspection.views.unshift(upper);
    const bend = trunkPoints.filter(p => p.arc > 96 && p.depth > 0.8)
      .sort((a, b) => Math.abs(b.smoothedCurvature || 0) - Math.abs(a.smoothedCurvature || 0))[0];
    const bendView = inspection.views.find(v => v.kind === 'bend');
    if (bend && bendView) Object.assign(bendView, view('bend', bendView.label, bend));
    const feeder = component.reaches.filter(r => r.sourceClosure && routeOf?.get(r.id) !== trunkId)
      .sort((a, b) => a.points[0].leftWidth + a.points[0].rightWidth - b.points[0].leftWidth - b.points[0].rightWidth)[0];
    const spring = feeder?.points.find(p => p.arc >= 32), springView = inspection.views.find(v => v.kind === 'headwater');
    if (spring && springView) Object.assign(springView, view('headwater', springView.label, spring));
    const confluence = component.junctions.filter(j => j.incomingReachIds?.some(id => routeOf?.get(id) === trunkId))
      .sort((a, b) => b.levelLength - a.levelLength)[0];
    const junctionView = inspection.views.find(v => v.kind === 'junction');
    if (confluence && junctionView) Object.assign(junctionView, { x: confluence.x, z: confluence.z });
    if (river.delta?.arms > 1) inspection.views.push({ kind: 'delta', label: 'River delta',
      x: river.delta.x, z: river.delta.z, outlets: component.reaches.filter(r => r.oceanMouth).map(r => {
        const p = r.points.at(-1); return { x: p.x, z: p.z };
      }) });
  }
  const feeders = network.routes.filter(r => r.order > 0);
  return {
    length, sinuosity: length / Math.max(1, Math.hypot(mouth.x - source.x, mouth.z - source.z)),
    source: { x: source.x, z: source.z }, mouth: { x: mouth.x, z: mouth.z },
    minWidth: Math.min(...widths), maxWidth: Math.max(...widths),
    tributaries: { accepted: feeders.length, orders: feeders.map(r => r.order),
      length: feeders.reduce((sum, r) => sum + polylineArcs(r.points).at(-1), 0) },
    ...(river.delta ? { delta: river.delta } : {}),
    basin: river.diagnostics.basin, attempts: river.diagnostics.attempts.length,
    inspection,
  };
}

export { creekWidth, planCreeks } from './regionalcreeks.mjs';
