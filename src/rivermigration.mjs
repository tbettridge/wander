import { descriptorHash } from './hydrologyformat.mjs';
import { RiverRoutePlanner } from './riverroute.mjs';
import { fitRiverReach, RiverReachField } from './riverterrain.mjs';
import { readCrossingManifest } from './crossingregistry.mjs';
import { mergeRiverRoutes, segmentRiverGraph } from './rivergraph.mjs';
import { fitRiverComponent } from './rivercomponent.mjs';

export const RIVER_MIGRATION_VERSION = 1;
const RETAIN_STEP = 12;
const RETAIN_RADIUS = 220;

function projectLegacyCentre(world, x, z) {
  for (let iteration = 0; iteration < 8; iteration++) {
    const epsilon = 2, signal = world._riverSignalAt(x, z);
    const gx = (world._riverSignalAt(x + epsilon, z) - world._riverSignalAt(x - epsilon, z)) / (2 * epsilon);
    const gz = (world._riverSignalAt(x, z + epsilon) - world._riverSignalAt(x, z - epsilon)) / (2 * epsilon);
    const squared = gx * gx + gz * gz;
    if (squared < 1e-12) break;
    const gradient = Math.sqrt(squared);
    const correction = Math.max(-24, Math.min(24, signal / gradient));
    x -= gx / gradient * correction; z -= gz / gradient * correction;
  }
  return { x, z };
}

function traceLegacyDirection(world, start, sign, maxSteps) {
  let point = projectLegacyCentre(world, start.x, start.z), tangentX = 0, tangentZ = 0;
  const points = [];
  for (let index = 0; index < maxSteps; index++) {
    const natural = {}, river = {};
    world._naturalHeight(point.x, point.z, natural);
    world._riverSectionAt(point.x, point.z, natural, river);
    points.push({ x: point.x, z: point.z });
    if (index > 4 && natural.base < -0.5) return { status: 'accepted', end: 'ocean', points };
    if (index > 4 && !river.riverInfluence) return { status: 'accepted', end: 'source', points };
    const epsilon = 3;
    const gx = (world._riverSignalAt(point.x + epsilon, point.z) - world._riverSignalAt(point.x - epsilon, point.z)) / (2 * epsilon);
    const gz = (world._riverSignalAt(point.x, point.z + epsilon) - world._riverSignalAt(point.x, point.z - epsilon)) / (2 * epsilon);
    const length = Math.hypot(gx, gz);
    if (length < 1e-8) return { status: 'retain-world-generation', reason: 'legacy-gradient-degenerate', points };
    let nextX = -gz / length, nextZ = gx / length;
    if (!index) { nextX *= sign; nextZ *= sign; }
    else if (nextX * tangentX + nextZ * tangentZ < 0) { nextX = -nextX; nextZ = -nextZ; }
    tangentX = nextX; tangentZ = nextZ;
    point = projectLegacyCentre(world, point.x + nextX * RETAIN_STEP, point.z + nextZ * RETAIN_STEP);
    for (let previous = 0; previous < points.length - 20; previous += 4) {
      if (Math.hypot(point.x - points[previous].x, point.z - points[previous].z) < RETAIN_STEP * 0.75) {
        return { status: 'retain-world-generation', reason: 'legacy-component-cycle', points };
      }
    }
  }
  return { status: 'retain-world-generation', reason: 'legacy-trace-budget', points };
}

export function traceRetainedLegacyComponent(world, entry, { maxSteps = 2000 } = {}) {
  if (!entry?.solved || !(maxSteps > 8)) throw new Error('Invalid retained crossing component');
  const start = { x: entry.solved.x, z: entry.solved.z };
  const a = traceLegacyDirection(world, start, -1, maxSteps);
  const b = traceLegacyDirection(world, start, 1, maxSteps);
  if (a.status !== 'accepted' || b.status !== 'accepted') {
    return { status: 'retain-world-generation', reason: a.reason || b.reason,
      crossingId: entry.id, ends: [a.end || null, b.end || null] };
  }
  const points = [...a.points.slice(1).reverse(), ...b.points];
  const bounds = { minX: Math.min(...points.map(point => point.x)) - RETAIN_RADIUS,
    minZ: Math.min(...points.map(point => point.z)) - RETAIN_RADIUS,
    maxX: Math.max(...points.map(point => point.x)) + RETAIN_RADIUS,
    maxZ: Math.max(...points.map(point => point.z)) + RETAIN_RADIUS };
  const payload = { id: `legacy:${world.seed}:${entry.id}`, crossingIds: [entry.id],
    radius: RETAIN_RADIUS, step: RETAIN_STEP, ends: [a.end, b.end].sort(), bounds, points };
  // Tracing a centreline plus a fixed-width envelope does not establish the
  // full connected influence footprint. This is a survey, never an activation
  // certificate: old noise bands can merge or widen beyond the envelope.
  return { status: 'surveyed', activationReady: false,
    component: { ...payload, hash: descriptorHash(payload) } };
}

function crossingAnchor(entry) {
  return { id: entry.id, x: entry.solved.x, z: entry.solved.z,
    minY: entry.waterInterval[0], maxY: entry.waterInterval[1] };
}

function routedCrossingPath(world, planner, entry, options) {
  const anchor = crossingAnchor(entry);
  const route = planner.route({ ...anchor, id: `crossing:${entry.id}` }, { deferProfile: true,
    maxGrade: options.maxGrade });
  if (route.status !== 'candidate') return route;
  const crossing = route.points[0], downstream = route.points[1];
  const length = Math.hypot(downstream.x - crossing.x, downstream.z - crossing.z);
  if (length < 1e-6) return { status: 'retain-legacy', reason: 'degenerate-crossing-route' };
  // Give the crossing a complete upstream bed instead of treating it as a
  // zero-depth spring. The later component planner can replace this provisional
  // head with a shared upstream junction without changing the crossing anchor.
  const distance = Math.max(32, Math.min(64, length));
  const x = crossing.x - (downstream.x - crossing.x) / length * distance;
  const z = crossing.z - (downstream.z - crossing.z) / length * distance;
  const h = world._naturalHeight(x, z);
  route.points.unshift({ id: `source:${entry.id}`, x, z, h,
    waterY: Math.max(anchor.minY, h - 0.6), minY: Math.max(anchor.minY, h - 4.6), maxY: h + 1.4 });
  // The recorded span follows the trail, which can cross the river obliquely.
  // It is not the channel's lateral width. Fit a metre-based channel and then
  // validate its actual intersection with every preserved crossing.
  const halfWidth = Math.min(options.maxChannelWidth / 2, options.halfWidth);
  const depth = Math.max(0.08, entry.solved.depth);
  return { ...route, crossingId: entry.id, halfWidth, depth };
}

function fitCrossingPath(world, route, entry, options) {
  if (route.status !== 'candidate') return route;
  return fitRiverReach(world, route, { id: `migrated:${entry.id}`,
    halfWidth: route.halfWidth, depth: route.depth,
    maxFill: options.maxFill, maxCut: options.maxCut, maxGrade: options.maxGrade,
    fixedLevels: [crossingAnchor(entry)], approachTolerance: options.approachTolerance,
    protectedApproaches: entry.reservation.points });
}

function connectedRouteGroups(routes) {
  const sorted = [...routes].sort((a, b) => a.crossingId.localeCompare(b.crossingId));
  const parent = sorted.map((_, i) => i), owner = new Map();
  const root = i => parent[i] === i ? i : (parent[i] = root(parent[i]));
  const join = (a, b) => { a = root(a); b = root(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  for (let i = 0; i < sorted.length; i++) for (const point of sorted[i].points) {
    if (owner.has(point.id)) join(i, owner.get(point.id)); else owner.set(point.id, i);
  }
  const groups = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const id = root(i);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(sorted[i]);
  }
  return [...groups.values()].sort((a, b) => a[0].crossingId.localeCompare(b[0].crossingId));
}

function auditDrainageComponents(world, routes, entries, options) {
  const byCrossing = new Map(entries.map(entry => [entry.id, entry])), reports = [];
  for (const group of connectedRouteGroups(routes.filter(route => route.status === 'candidate'))) {
    const crossingIds = group.map(route => route.crossingId).sort();
    const merged = mergeRiverRoutes(group);
    if (merged.status !== 'candidate') {
      reports.push({ crossingIds, status: 'retained', reason: merged.reason }); continue;
    }
    const segmented = segmentRiverGraph(merged, Object.fromEntries(merged.nodes.map(node => [node.id, node.preferredY])));
    if (segmented.status !== 'candidate') {
      reports.push({ crossingIds, status: 'retained', reason: segmented.reason,
        nodes: merged.nodes.length, edges: merged.edges.length }); continue;
    }
    let failure = null;
    const component = fitRiverComponent(world, segmented, { ...options,
      halfWidth: Math.min(options.halfWidth, options.maxChannelWidth / 2),
      depth: Math.max(...group.map(item => item.depth)),
      protectedApproaches: entries.flatMap(entry => entry.reservation.points
        .filter(point => !point.wet).map(point => ({ ...point, crossingId: entry.id }))),
      fixedLevels: crossingIds.map(id => ({ ...crossingAnchor(byCrossing.get(id)), nodeId: `crossing:${id}` })) });
    if (component.status !== 'fitted') failure = component;
    const fitted = failure ? [] : component.reaches.map((reach, i) => ({ reach, route: segmented.reaches[i] }));
    if (!failure) for (const crossingId of crossingIds) {
      const entry = byCrossing.get(crossingId), nodeId = `crossing:${crossingId}`;
      const owners = fitted.filter(item => item.route.points.some(point => point.id === nodeId));
      const validations = owners.map(item => validateCrossingReplacement(world, entry, item.reach, options));
      if (!validations.some(validation => validation.status === 'accepted')) {
        failure = validations[0] || { reason: 'crossing-reach-owner-missing' }; break;
      }
    }
    // Level ownership and edge-disjoint reaches are established, but a join
    // still needs one shared bed/bank mesh before it can replace terrain.
    if (!failure && segmented.junctions.length) failure = { reason: 'junction-geometry-pending' };
    reports.push({ crossingIds, status: failure ? 'retained' : 'candidate',
      reason: failure?.reason || null, nodes: merged.nodes.length, edges: merged.edges.length,
      reaches: segmented.reaches.length, junctions: segmented.junctions.length,
      outletIds: merged.nodes.filter(node => !merged.edges.some(edge => edge.from === node.id))
        .map(node => node.id).sort() });
  }
  for (const route of routes.filter(route => route.status !== 'candidate').sort((a, b) => a.crossingId.localeCompare(b.crossingId))) {
    reports.push({ crossingIds: [route.crossingId], status: 'retained', reason: route.reason });
  }
  return reports.sort((a, b) => a.crossingIds[0].localeCompare(b.crossingIds[0]));
}

export function validateCrossingReplacement(world, entry, reach, { approachTolerance = 0.25 } = {}) {
  const field = new RiverReachField(reach), sample = {};
  if (!field.sample(entry.solved.x, entry.solved.z,
    world._naturalHeight(entry.solved.x, entry.solved.z), sample) || sample.signedDepth <= 0.03) {
    return { status: 'retain-legacy', reason: 'crossing-water-missing' };
  }
  const [minimum, maximum] = entry.waterInterval;
  if (sample.waterY < minimum - 1e-6 || sample.waterY > maximum + 1e-6) {
    return { status: 'retain-legacy', reason: 'crossing-water-interval' };
  }
  const clearance = entry.solved.surfaceY - sample.waterY;
  const minimumClearance = entry.solved.kind === 'bridge' ? 0.52 : 0.04;
  if (clearance < minimumClearance - 1e-6) {
    return { status: 'retain-legacy', reason: 'crossing-clearance' };
  }
  // Dry approach samples are part of the preserved traversal contract. A
  // replacement may settle them slightly into its bank, but cannot create a
  // new step or hollow beneath the existing route.
  let approachDelta = 0, approachInsideDelta = 0, approachOutsideDelta = 0;
  for (const point of entry.reservation?.points || []) {
    if (point.wet) continue;
    const out = {};
    const natural = world._naturalHeight(point.x, point.z);
    const inside = field.sample(point.x, point.z, natural, out);
    const floor = inside ? out.floor : natural, delta = Math.abs(floor - point.floor);
    approachDelta = Math.max(approachDelta, delta);
    if (inside) approachInsideDelta = Math.max(approachInsideDelta, delta);
    else approachOutsideDelta = Math.max(approachOutsideDelta, delta);
  }
  if (approachDelta > approachTolerance) {
    return { status: 'retain-legacy', reason: 'crossing-approach-support', approachDelta,
      approachInsideDelta, approachOutsideDelta };
  }
  return { status: 'accepted', reach, waterY: sample.waterY, depth: sample.signedDepth,
    clearance, approachDelta, approachInsideDelta, approachOutsideDelta };
}

export function auditCrossingMigration(world, manifest, {
  maxChannelWidth = 45, maxFill = 2, maxCut = 6, maxGrade = 0.025,
  halfWidth = 4, approachTolerance = 0.25, plannerOptions = {},
} = {}) {
  if (!manifest || manifest.seed !== world.seed) throw new Error('Crossing migration identity mismatch');
  manifest = readCrossingManifest(manifest, { seed: world.seed });
  const options = { maxFill, maxCut, maxGrade, approachTolerance, halfWidth, maxChannelWidth };
  if (!Object.values(options).every(Number.isFinite) || halfWidth < 1 || halfWidth > 22.5
    || maxChannelWidth < 2 || maxChannelWidth > 45 || maxFill < 0 || maxCut < 0 || maxGrade < 0
    || approachTolerance < 0) throw new Error('Invalid migration fitting options');
  const planner = new RiverRoutePlanner(world, plannerOptions), results = [], routes = [], validEntries = [];
  for (const entry of [...manifest.crossings].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!entry.solved) {
      results.push({ id: entry.id, status: 'retained', reason: 'original-crossing-unbuilt' });
      continue;
    }
    if (!entry.reservation || !Array.isArray(entry.waterInterval)
      || entry.waterInterval.length !== 2 || entry.waterInterval[0] > entry.waterInterval[1]) {
      results.push({ id: entry.id, status: 'retained', reason: 'invalid-crossing-contract' });
      continue;
    }
    const route = routedCrossingPath(world, planner, entry, options);
    routes.push(route.status === 'candidate' ? route : { ...route, crossingId: entry.id });
    validEntries.push(entry);
    const reach = fitCrossingPath(world, route, entry, options);
    if (reach.status !== 'fitted') {
      results.push({ id: entry.id, status: 'retained', reason: reach.reason,
        section: reach.section ?? null, x: reach.x ?? null, z: reach.z ?? null });
      continue;
    }
    const validation = validateCrossingReplacement(world, entry, reach, options);
    results.push({ id: entry.id, ...validation,
      status: validation.status === 'accepted' ? 'candidate' : 'retained' });
  }
  const accepted = results.filter(result => result.status === 'candidate');
  const retained = results.filter(result => result.status === 'retained');
  const components = auditDrainageComponents(world, routes, validEntries, options);
  const payload = { version: RIVER_MIGRATION_VERSION, seed: world.seed,
    manifestHash: manifest.hash, options, activationReady: false, candidates: accepted.map(result => result.id),
    retained: retained.map(result => ({ id: result.id, reason: result.reason })),
    components };
  return { ...payload, hash: descriptorHash(payload), results, components,
    diagnostics: { candidates: accepted.length, retained: retained.length,
      componentCandidates: components.filter(component => component.status === 'candidate').length,
      componentRetained: components.filter(component => component.status === 'retained').length,
      reasons: Object.fromEntries([...new Set(retained.map(result => result.reason))].sort()
        .map(reason => [reason, retained.filter(result => result.reason === reason).length])) } };
}
