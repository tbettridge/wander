// Planning is deliberately outside terrain vertex queries and render frames.
// Legacy comparison requests capture old layouts; fresh plans precede trails.
import { World } from './world.js';
import { trailsAround, clearTrailCache } from './trails.js';
import { captureCrossingManifest, CrossingReservations } from './crossingpreservation.mjs';
import { planBasins, BASIN_REGION_SIZE } from './basinplanner.mjs';
import { setWorldRailwayTerrain } from './railwayterrain.mjs';
import { landmarksAround, majorLandmarksAround, fortifiedOutpostsAround } from './landmarks.js';
import { settlementsAround } from './settlementplacement.mjs';
import { caveAnchorsAround } from './cavegen.mjs';
import { RiverRoutePlanner } from './riverroute.mjs';
import { fitRiverReach } from './riverterrain.mjs';
import { BASIN_PLAN_VERSION, descriptorHash } from './hydrologyformat.mjs';
import { auditCrossingMigration } from './rivermigration.mjs';
import { surveyLegacyFootprint } from './legacyfootprint.mjs';
import { fitRiverComponent } from './rivercomponent.mjs';
import { bakeRiverComponent } from './rivercomponentmesh.mjs';
import { planRiverNetwork } from './rivernetwork.mjs';
import { bakeSparseRiverComponent } from './riversparsemesh.mjs';
import { planLakeSystem } from './basininlets.mjs';
import { WaterCandidateCache, IndexedWaterStorage } from './hydrologycache.mjs';
import { WaterRegionPlanner, planWaterRegionCandidates } from './hydrologyregions.mjs';
import { surveyBasinOutlet, fitBasinOutlet, planBasinDrainage } from './basinoutlet.mjs';

export function prepareRegionalPreview({ seed, regionX, regionZ, basinId, x, z }) {
  if (![x, z].every(Number.isFinite)) throw new Error('Invalid regional preview target');
  const plan = planWaterRegionCandidates(seed, regionX, regionZ);
  const component = plan.components.find(c => c.basinIds?.includes(basinId));
  if (!component) throw new Error('Requested connected basin was not installed');
  return { plan, target: { x, z }, basinCount: component.basinIds.length,
    inletCount: component.reachIds.filter(id => id.startsWith('lake-inlet:')).length };
}

export function prepareBasinDrainagePreview({ seed, regionX, regionZ, basinId = null }) {
  if (![regionX, regionZ].every(Number.isSafeInteger)) throw new Error('Invalid lake drainage region');
  const world = new World(seed, { generationVersion: 3 }), failures = [];
  for (const basin of planBasins(world, regionX, regionZ).basins) {
    if (basinId && basin.id !== basinId) continue;
    const result = planLakeSystem(world, basin, { inland: false });
    if (result.status !== 'baked') { failures.push(`${result.stage}: ${result.reason}`); continue; }
    const target = { x: basin.centerX, z: basin.centerZ };
    const payload = { version: BASIN_PLAN_VERSION, generationVersion: 3, seed, regionX, regionZ,
      preview: true, basins: [], components: [result.mesh], spawnTarget: target };
    return { plan: { ...payload, hash: descriptorHash(payload) }, target, basinKind: basin.kind, inletCount: result.inletCount,
      outletLength: result.component.reaches[0].points.at(-1).arc };
  }
  throw new Error(`No lake outlet passed drainage validation in this region (${failures.join('; ')})`);
}

export function prepareBasinOutletSurvey({ seed, regionX, regionZ }) {
  if (![regionX, regionZ].every(Number.isSafeInteger)) throw new Error('Invalid basin outlet region');
  const world = new World(seed, { generationVersion: 3 });
  const { basins } = planBasins(world, regionX, regionZ);
  return { report: { seed, regionX, regionZ, activationReady: false,
    outlets: basins.map(basin => {
      const survey = surveyBasinOutlet(world, basin);
      const fit = fitBasinOutlet(world, basin, survey);
      return { ...survey, bankFit: { status: fit.status, reason: fit.reason || null } };
    }) } };
}

// Planning report remains separate from installable preview plans. Components
// pass the sparse mesh and ocean handoff checks individually below.
export function prepareNetworkRegion({ seed, regionX, regionZ }) {
  if (![regionX, regionZ].every(Number.isSafeInteger)) throw new Error('Invalid network region');
  const world = new World(seed, { generationVersion: 3 }), sources = [];
  for (let z = 0; z < 9; z++) for (let x = 0; x < 9; x++) {
    const point = { x: regionX * BASIN_REGION_SIZE + (x + 0.5) * BASIN_REGION_SIZE / 9,
      z: regionZ * BASIN_REGION_SIZE + (z + 0.5) * BASIN_REGION_SIZE / 9 };
    const height = world._naturalHeight(point.x, point.z);
    if (height >= 1.5 && height <= 35) sources.push(point);
  }
  const network = planRiverNetwork(world, sources, { mouthLength: 64 });
  return { network: { ...network, seed, regionX, regionZ,
    meshReadiness: network.components.map(component => {
      const mesh = bakeSparseRiverComponent(world, component);
      return { sources: component.sources, status: mesh.status, reason: mesh.reason || null };
    }) } };
}

export function prepareNetworkPreview(request) {
  const { network } = prepareNetworkRegion(request);
  const world = new World(request.seed, { generationVersion: 3 });
  const failures = [];
  for (const component of [...network.components].sort((a, b) => b.sources.length - a.sources.length)) {
    if (!component.junctions.length) continue;
    const mesh = bakeSparseRiverComponent(world, component);
    if (mesh.status !== 'baked') { failures.push(`${mesh.reason}${mesh.detail ? `: ${mesh.detail}` : ''}`); continue; }
    const payload = { version: BASIN_PLAN_VERSION, generationVersion: 3, seed: request.seed,
      regionX: request.regionX, regionZ: request.regionZ, preview: true, basins: [], components: [mesh],
      spawnTarget: { x: component.junctions[0].x, z: component.junctions[0].z } };
    return { plan: { ...payload, hash: descriptorHash(payload) },
      target: { x: component.junctions[0].x, z: component.junctions[0].z },
      sourceCount: component.sources.length, junctionCount: component.junctions.length };
  }
  throw new Error(`No joined network passed mesh validation in this region${failures.length ? ` (${failures.join('; ')})` : ''}`);
}

// A local junction fixture on actual generated ground. The three short arms
// isolate joined geometry; they are not a completed source-to-sea network.
export function prepareJunctionPreview({ seed, x, z }) {
  if (![x, z].every(Number.isFinite)) throw new Error('Invalid junction coordinates');
  const world = new World(seed, { generationVersion: 3 });
  const preferred = Math.max(0, world._naturalHeight(x, z) - 2);
  const point = (id, dx, dz) => ({ id: `junction-preview:${seed}:${x}:${z}:${id}`, x: x + dx, z: z + dz, waterY: preferred });
  const join = point('join', 0, 0);
  const route = (id, a, b) => ({ id: `${join.id}:${id}`, status: 'candidate', sourceClosure: false,
    oceanMouth: false, points: [a, b] });
  const component = fitRiverComponent(world, { status: 'candidate', reaches: [
    route('left', point('left', -40, -80), join), route('right', point('right', 40, -80), join),
    route('out', join, point('out', 0, 80)),
  ], junctions: [{ id: join.id, nodeId: join.id }] }, { junctionLength: 64 });
  const mesh = bakeRiverComponent(world, component);
  if (mesh.status !== 'baked') throw new Error(`Junction rejected: ${mesh.reason}`);
  const payload = { version: BASIN_PLAN_VERSION, generationVersion: 3, seed, preview: true,
    regionX: Math.floor(x / BASIN_REGION_SIZE), regionZ: Math.floor(z / BASIN_REGION_SIZE), basins: [], components: [mesh] };
  return { plan: { ...payload, hash: descriptorHash(payload) } };
}

export function prepareMigrationAudit({ seed, regionX, regionZ, railwaySpec = null }) {
  const world = new World(seed);
  if (railwaySpec) setWorldRailwayTerrain(world, railwaySpec);
  clearTrailCache();
  const size = BASIN_REGION_SIZE;
  const edges = trailsAround(world, (regionX + 0.5) * size, (regionZ + 0.5) * size,
    seed, size * 0.5 + 600, []);
  const manifest = captureCrossingManifest(world, edges, { layoutSignature: descriptorHash(railwaySpec) });
  const report = auditCrossingMigration(world, manifest);
  const anchors = manifest.crossings.filter(entry => entry.solved).map(entry => ({
    id: entry.id, x: entry.solved.x, z: entry.solved.z,
  }));
  const footprint = anchors.length ? surveyLegacyFootprint(world, anchors) : null;
  return { ...report, regionX, regionZ, footprint };
}

export function prepareBasinRegion({ seed, regionX, regionZ, railwaySpec = null }) {
  const world = new World(seed);
  if (railwaySpec) setWorldRailwayTerrain(world, railwaySpec);
  clearTrailCache();
  const size = BASIN_REGION_SIZE, x = (regionX + 0.5) * size, z = (regionZ + 0.5) * size;
  const radius = size * 0.5 + 600;
  const edges = trailsAround(world, x, z, seed, radius, []);
  const manifest = captureCrossingManifest(world, edges, { layoutSignature: descriptorHash(railwaySpec) });
  const reservations = new CrossingReservations([manifest]);
  const sites = landmarksAround(world, x, z, seed, radius, []);
  majorLandmarksAround(world, x, z, seed, radius, sites, true);
  sites.push(...fortifiedOutpostsAround(world, x, z, seed, radius, []));
  sites.push(...settlementsAround(world, x, z, seed, radius, []));
  sites.push(...caveAnchorsAround(world, x, z, seed, radius, []));
  const blockedAt = (px, pz) => sites.some(site =>
    Math.hypot(px - site.x, pz - site.z) < (site.exclusionHalo || site.halo || site.radius || 70) + 32);
  const basinPlan = planBasins(world, regionX, regionZ, { reservations, blockedAt });
  const { hash: _hash, diagnostics, ...payload } = basinPlan;
  const versioned = { ...payload, crossingManifestHash: manifest.hash, layoutSignature: manifest.layoutSignature };
  const plan = { ...versioned, hash: descriptorHash(versioned), diagnostics };
  return { plan, manifest };
}

// Fresh geography: water is planned before any trail or crossing is generated.
// This fixed-region preview retains no old river carving or crossing manifests.
export function prepareFreshRegion({ seed, regionX, regionZ }) {
  const world = new World(seed, { generationVersion: 3 });
  const basinPlan = planBasins(world, regionX, regionZ);
  const reaches = [], candidates = [], rejected = {}, planner = new RiverRoutePlanner(world, { maxVisited: 2048 });
  const overlaps = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
  // Evaluate the bounded source set before selecting rivers. Stopping at the
  // first successes favoured tiny coastal channels in raster scan order.
  const cells = 9;
  for (let z = 0; z < cells; z++) for (let x = 0; x < cells; x++) {
    const px = regionX * BASIN_REGION_SIZE + (x + 0.5) * BASIN_REGION_SIZE / cells;
    const pz = regionZ * BASIN_REGION_SIZE + (z + 0.5) * BASIN_REGION_SIZE / cells;
    const height = world._naturalHeight(px, pz);
    if (height < 1.5 || height > 35) continue;
    // Dense bank intervals, rather than coarse routing preferences, decide
    // whether a water profile can actually be built into this terrain.
    const reach = fitRiverReach(world, planner.route({ x: px, z: pz }, { deferProfile: true }));
    if (reach.status !== 'fitted') {
      rejected[reach.reason] = (rejected[reach.reason] || 0) + 1;
      continue;
    }
    if (reach.points.at(-1).arc < 120) continue;
    candidates.push(reach);
  }
  candidates.sort((a, b) => b.points.at(-1).arc - a.points.at(-1).arc || a.id.localeCompare(b.id));
  for (const reach of candidates) {
    if ([...reaches, ...basinPlan.basins].some(other => overlaps(reach.bounds, other.bounds))) continue;
    reaches.push(reach);
    if (reaches.length === 6) break;
  }
  const { hash: oldHash, diagnostics, ...basinPayload } = basinPlan;
  const payload = { ...basinPayload, generationVersion: 3, preview: true, reaches };
  return { plan: { ...payload, hash: descriptorHash(payload), diagnostics: {
    ...diagnostics, rivers: { sourceCells: cells * cells, fittedCandidates: candidates.length,
      selected: reaches.length, rejected },
  } } };
}

// A lab-only reach, not a migrated drainage component. The game startup path
// never requests this descriptor until crossing and network migration is ready.
export function prepareReachPreview({ seed, x, z }) {
  const world = new World(seed);
  const reach = fitRiverReach(world, new RiverRoutePlanner(world).route({ x, z }));
  if (reach.status !== 'fitted') throw new Error(`River candidate rejected: ${reach.reason}`);
  const payload = { version: BASIN_PLAN_VERSION, generationVersion: 3, seed, regionX: Math.floor(x / BASIN_REGION_SIZE),
    regionZ: Math.floor(z / BASIN_REGION_SIZE), preview: true, basins: [], reaches: [reach] };
  return { plan: { ...payload, hash: descriptorHash(payload) } };
}

let regionalPlanner = null;
const regionalCache = new WaterCandidateCache(new IndexedWaterStorage());
if (typeof self !== 'undefined') self.onmessage = async event => {
  const request = event.data;
  if (request.type === 'plan-water-window') {
    try {
      if (!regionalPlanner || regionalPlanner.seed !== request.seed) regionalPlanner = new WaterRegionPlanner(request.seed);
      const plans = await regionalPlanner.cachedWindow(request.regionX, request.regionZ, regionalCache, progress => {
        self.postMessage({ type: 'water-window-progress', id: request.id, seed: request.seed,
          regionX: request.regionX, regionZ: request.regionZ, ...progress });
      });
      self.postMessage({ type: 'water-window-planned', id: request.id, seed: request.seed,
        regionX: request.regionX, regionZ: request.regionZ, plans });
    } catch (error) { self.postMessage({ type: 'plan-error', id: request.id, error: error.message }); }
    return;
  }
  if (!['plan-basins', 'plan-fresh', 'plan-network', 'plan-network-preview', 'plan-regional-preview', 'plan-basin-drainage-preview', 'survey-basin-outlets', 'plan-reach-preview', 'plan-junction-preview', 'audit-migration'].includes(request.type)) return;
  try {
    if (request.type === 'plan-regional-preview') self.postMessage({ type: 'regional-preview-planned', id: request.id, ...prepareRegionalPreview(request) });
    else if (request.type === 'plan-basin-drainage-preview') self.postMessage({ type: 'basin-drainage-planned', id: request.id, ...prepareBasinDrainagePreview(request) });
    else if (request.type === 'survey-basin-outlets') self.postMessage({ type: 'basin-outlets-surveyed', id: request.id, ...prepareBasinOutletSurvey(request) });
    else if (request.type === 'plan-network-preview') self.postMessage({ type: 'network-preview-planned', id: request.id, ...prepareNetworkPreview(request) });
    else if (request.type === 'plan-network') self.postMessage({ type: 'network-planned', id: request.id, ...prepareNetworkRegion(request) });
    else if (request.type === 'plan-junction-preview') self.postMessage({ type: 'junction-planned', id: request.id, ...prepareJunctionPreview(request) });
    else if (request.type === 'plan-fresh') self.postMessage({ type: 'fresh-planned', id: request.id, ...prepareFreshRegion(request) });
    else if (request.type === 'audit-migration') self.postMessage({ type: 'migration-audited', id: request.id,
      report: prepareMigrationAudit(request) });
    else if (request.type === 'plan-reach-preview') self.postMessage({ type: 'reach-planned', id: request.id, ...prepareReachPreview(request) });
    else self.postMessage({ type: 'basins-planned', id: request.id, ...prepareBasinRegion(request) });
  } catch (error) {
    self.postMessage({ type: 'plan-error', id: request.id, error: error.message });
  }
};
