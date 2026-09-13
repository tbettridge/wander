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

if (typeof self !== 'undefined') self.onmessage = event => {
  const request = event.data;
  if (!['plan-basins', 'plan-fresh', 'plan-reach-preview', 'audit-migration'].includes(request.type)) return;
  try {
    if (request.type === 'plan-fresh') self.postMessage({ type: 'fresh-planned', id: request.id, ...prepareFreshRegion(request) });
    else if (request.type === 'audit-migration') self.postMessage({ type: 'migration-audited', id: request.id,
      report: prepareMigrationAudit(request) });
    else if (request.type === 'plan-reach-preview') self.postMessage({ type: 'reach-planned', id: request.id, ...prepareReachPreview(request) });
    else self.postMessage({ type: 'basins-planned', id: request.id, ...prepareBasinRegion(request) });
  } catch (error) {
    self.postMessage({ type: 'plan-error', id: request.id, error: error.message });
  }
};
