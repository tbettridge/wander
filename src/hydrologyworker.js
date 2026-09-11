// Planning is deliberately outside terrain vertex queries and render frames.
// A request captures the old layout before constructing its new basin field.
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

// A lab-only reach, not a migrated drainage component. The game startup path
// never requests this descriptor until crossing and network migration is ready.
export function prepareReachPreview({ seed, x, z }) {
  const world = new World(seed);
  const reach = fitRiverReach(world, new RiverRoutePlanner(world).route({ x, z }));
  if (reach.status !== 'fitted') throw new Error(`River candidate rejected: ${reach.reason}`);
  const payload = { version: BASIN_PLAN_VERSION, seed, regionX: Math.floor(x / BASIN_REGION_SIZE),
    regionZ: Math.floor(z / BASIN_REGION_SIZE), preview: true, basins: [], reaches: [reach] };
  return { plan: { ...payload, hash: descriptorHash(payload) } };
}

if (typeof self !== 'undefined') self.onmessage = event => {
  const request = event.data;
  if (!['plan-basins', 'plan-reach-preview'].includes(request.type)) return;
  try {
    if (request.type === 'plan-reach-preview') self.postMessage({ type: 'reach-planned', id: request.id, ...prepareReachPreview(request) });
    else self.postMessage({ type: 'basins-planned', id: request.id, ...prepareBasinRegion(request) });
  } catch (error) {
    self.postMessage({ type: 'plan-error', id: request.id, error: error.message });
  }
};
