import { World } from './world.js';
import { planBasins, BASIN_REGION_SIZE } from './basinplanner.mjs';
import { BASIN_PLAN_VERSION, descriptorHash } from './hydrologyformat.mjs';
import { connectInlandBasins } from './basinconnections.mjs';
import { connectBasinToRiver, lakeRiverConnectionDistance } from './basinriverconnections.mjs';
import { planLakeSystem, addBasinInlets } from './basininlets.mjs';
import { planRiverNetwork } from './rivernetwork.mjs';
import { bakeSparseRiverComponent } from './riversparsemesh.mjs';
import { validatedMeanderMesh } from './rivermeanderfit.mjs';

export const WATER_REGION_HALO = 1024;
export const WATER_REGION_BYTES = 3000000;
export const WATER_REGION_LAKE_BYTES = 1750000;
export const waterBoundsOverlap = (a, b) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
const regionKey = (x, z) => `${x},${z}`;
const extent = p => [...p.basins, ...(p.components || [])];

// Raw candidates depend only on their owning region, never on arrival order.
// A finite extent makes the eight neighbouring regions a complete conflict set.
export function planWaterRegionCandidates(seed, regionX, regionZ, {
  riverCharacter = true, riverMeanders = true, riverMorphology = true,
  lakeTransitions = true,
} = {}) {
  if (![seed, regionX, regionZ].every(Number.isSafeInteger)) throw new Error('Invalid water region');
  if (typeof riverCharacter !== 'boolean' || typeof riverMeanders !== 'boolean'
    || typeof riverMorphology !== 'boolean' || typeof lakeTransitions !== 'boolean') {
    throw new Error('Invalid regional river options');
  }
  const world = new World(seed, { generationVersion: 3 });
  const basins = [], components = [], diagnostics = { closed: 0, flowing: 0, inland: 0, lakeLinks: 0, riverLinks: 0, multipleInlets: 0, inlets: 0, rivers: 0,
    riverCharacter, riverMeanders, riverMorphology, lakeTransitions, featureFallbacks: {}, rejected: {} };
  let usedBytes = JSON.stringify({ basins, components }).length, connectedLakeBytes = 0;
  const reject = reason => diagnostics.rejected[reason] = (diagnostics.rejected[reason] || 0) + 1;
  const outer = { minX: regionX * BASIN_REGION_SIZE - WATER_REGION_HALO, minZ: regionZ * BASIN_REGION_SIZE - WATER_REGION_HALO,
    maxX: (regionX + 1) * BASIN_REGION_SIZE + WATER_REGION_HALO, maxZ: (regionZ + 1) * BASIN_REGION_SIZE + WATER_REGION_HALO };
  const add = (object, collection) => {
    const b = object.bounds;
    if (b.minX < outer.minX || b.minZ < outer.minZ || b.maxX > outer.maxX || b.maxZ > outer.maxZ) { reject('extent'); return false; }
    if ([...basins, ...components].some(other => waterBoundsOverlap(b, other.bounds))) { reject('overlap'); return false; }
    const cost = JSON.stringify(object).length + (collection.length ? 1 : 0);
    if (object.basinIds?.length && connectedLakeBytes + cost > WATER_REGION_LAKE_BYTES) { reject('lake-detail-budget'); return false; }
    if (usedBytes + cost > WATER_REGION_BYTES - 4096) { reject('memory'); return false; }
    collection.push(object); usedBytes += cost;
    if (object.basinIds?.length) connectedLakeBytes += cost;
    return true;
  };
  const candidates = planBasins(world, regionX, regionZ).basins;
  const systems = new Map(candidates.map(basin => [basin.id, planLakeSystem(world, basin)]));
  // Nearby companion depressions are proposals only, never extra standalone
  // lakes. The ordinary 700m spacing still controls independent encounters.
  const primaryIds = new Set(candidates.map(b => b.id));
  const companions = candidates.length ? planBasins(world, regionX, regionZ, { maxBasins: 12, minSpacing: 96 }).basins : [];
  const pool = [...candidates, ...companions.filter(b => !primaryIds.has(b.id))];
  const pairs = pool.flatMap(source => pool.filter(target => source.id !== target.id && source.level > target.level + 0.2
    && (primaryIds.has(source.id) || primaryIds.has(target.id))
    && (!systems.has(source.id) || systems.get(source.id).status !== 'baked' || systems.get(source.id).inland))
    .map(target => ({ source, target, distance: Math.hypot(source.centerX - target.centerX, source.centerZ - target.centerZ) })))
    .filter(pair => pair.distance <= (primaryIds.has(pair.source.id) && primaryIds.has(pair.target.id) ? 1400 : 700))
    .sort((a, b) => a.distance - b.distance || a.source.id.localeCompare(b.source.id) || a.target.id.localeCompare(b.target.id));
  const linked = new Set();
  const record = system => {
    diagnostics.flowing++; diagnostics.inlets += system.inletCount || 0;
    if (system.inland) diagnostics.inland++;
    if (system.inletCount > 1) diagnostics.multipleInlets++;
  };
  for (const { source, target } of pairs.slice(0, 4)) {
    const downstream = systems.get(target.id);
    // Reserve the inter-lake channel before optional incoming streams. Keep an
    // established lower-lake outlet; replan inlets around the joined geometry.
    let result = connectInlandBasins(world, source, target, { existingReaches:
      downstream?.status === 'baked' ? downstream.component.reaches.filter(r => !r.sourceClosure) : [] });
    const inletCounts = [];
    if (result.status === 'baked' && JSON.stringify(result.mesh).length <= WATER_REGION_LAKE_BYTES) {
      for (const basin of result.component.basins) {
        result = addBasinInlets(world, { ...result, basin }, { maxBytes: WATER_REGION_LAKE_BYTES - 64 });
        inletCounts.push(result.inletCount);
      }
    }
    result = applyLakeTransitions(world, result, lakeTransitions);
    if (result.status === 'baked' && add(result.mesh, components)) {
      linked.add(source.id); linked.add(target.id); diagnostics.lakeLinks++;
      inletCounts.forEach(inletCount => record({ inletCount, inland: !result.mesh.oceanHandoff }));
      break;
    } else if (result.status !== 'baked') reject(`lake-link:${result.reason}`);
  }
  // Sample more densely than the original nine-cell lattice. Starting
  // on locally lower terrain improves useful valley coverage without lowering
  // the bank, slope, excavation or mesh acceptance standards.
  const sources = [];
  for (let z = 0; z < 13; z++) for (let x = 0; x < 13; x++) {
    const px = regionX * BASIN_REGION_SIZE + (x + 0.5) * BASIN_REGION_SIZE / 13;
    const pz = regionZ * BASIN_REGION_SIZE + (z + 0.5) * BASIN_REGION_SIZE / 13;
    let point = { x: px, z: pz }, height = world._naturalHeight(px, pz);
    for (const [dx, dz] of [[-48, 0], [48, 0], [0, -48], [0, 48]]) {
      const h = world._naturalHeight(px + dx, pz + dz);
      if (h >= 1.5 && h < height) { point = { x: px + dx, z: pz + dz }; height = h; }
    }
    if (height >= 1.5 && height <= 35) sources.push(point);
  }
  const network = planRiverNetwork(world, sources, { maxSources: 169, maxVisited: 2048, mouthLength: 64,
    riverCharacter, riverMeanders, riverMorphology });
  // Reserve space for complete lake/river systems before independent lake
  // meshes consume the detail allowance. Failed attempts publish nothing.
  const riverPairs = candidates.filter(basin => !linked.has(basin.id)
    && (systems.get(basin.id).status !== 'baked' || systems.get(basin.id).inland))
    .flatMap(basin => network.components.filter(c => c.reaches.reduce((n, r) => n + r.points.at(-1).arc, 0) >= 120)
      .map(component => ({ basin, component, distance: lakeRiverConnectionDistance(basin, component) })))
    .filter(pair => Number.isFinite(pair.distance))
    .sort((a, b) => a.distance - b.distance || a.basin.id.localeCompare(b.basin.id)
      || a.component.sources.join('|').localeCompare(b.component.sources.join('|')));
  const joinedNetworks = new Set();
  // At most four complete proposals per region; stop after the first accepted
  // system so ordinary lakes and standalone rivers retain room to appear.
  for (const { basin, component } of riverPairs.slice(0, 4)) {
    const system = systems.get(basin.id);
    const result = connectBasinToRiver(world, basin, component, {
      existingReaches: system.status === 'baked' ? system.component.reaches : [],
      riverCharacter, riverMeanders, riverMorphology, lakeTransitions,
    });
    if (result.status === 'baked' && add(result.mesh, components)) {
      if (result.component?.featureFallback) {
        const key = result.component.featureFallback;
        diagnostics.featureFallbacks[key] = (diagnostics.featureFallbacks[key] || 0) + 1;
      }
      record({ ...system, inland: false });
      diagnostics.riverLinks++; diagnostics.rivers += component.sources.length;
      linked.add(basin.id); joinedNetworks.add(component);
      break;
    }
    if (result.status !== 'baked') reject(`lake-river:${result.reason}`);
  }
  const orderedBasins = [...candidates].sort((a, b) => {
    const rank = basin => (basin.kind === 'lake' ? 4 : 0) + (systems.get(basin.id).inletCount || 0);
    return rank(b) - rank(a) || a.id.localeCompare(b.id);
  });
  for (const basin of orderedBasins) {
    if (linked.has(basin.id)) continue;
    const system = systems.get(basin.id);
    const publishedSystem = applyLakeTransitions(world, system, lakeTransitions);
    if (publishedSystem.status === 'baked' && add(publishedSystem.mesh, components)) record(publishedSystem);
    else if (add(basin, basins)) diagnostics.closed++;
  }
  for (const component of network.components.sort((a, b) => b.sources.length - a.sources.length
    || b.reaches.reduce((n, r) => n + r.points.at(-1).arc, 0) - a.reaches.reduce((n, r) => n + r.points.at(-1).arc, 0))) {
    if (joinedNetworks.has(component) || component.reaches.reduce((n, r) => n + r.points.at(-1).arc, 0) < 120) continue;
    const mesh = validatedMeanderMesh(component) || bakeSparseRiverComponent(world, component, { lakeTransitions });
    if (mesh.status !== 'baked') { reject(mesh.reason); continue; }
    if (!add(mesh, components)) continue;
    diagnostics.rivers += component.sources.length;
  }
  const payload = { version: BASIN_PLAN_VERSION, generationVersion: 3, preview: true, regional: 1,
    seed, regionX, regionZ, basins, components };
  return { ...payload, hash: descriptorHash(payload), diagnostics };
}

function applyLakeTransitions(world, drainage, lakeTransitions) {
  if (!lakeTransitions || drainage?.status !== 'baked' || !drainage.component?.basins?.length) return drainage;
  const transitioned = bakeSparseRiverComponent(world, drainage.component, { lakeTransitions: true });
  if (transitioned.status !== 'baked' || JSON.stringify(transitioned).length > WATER_REGION_LAKE_BYTES) return drainage;
  return { ...drainage, mesh: transitioned };
}

export function resolveWaterRegion(candidate, neighbours) {
  const rank = p => `${descriptorHash(['water-owner', p.seed, p.regionX, p.regionZ])}:${p.regionX},${p.regionZ}`;
  const priority = rank(candidate);
  const blockers = neighbours.filter(p => rank(p) < priority).flatMap(extent);
  const keep = object => !blockers.some(other => waterBoundsOverlap(object.bounds, other.bounds));
  const { hash, diagnostics, ...raw } = candidate;
  const payload = { ...raw, basins: raw.basins.filter(keep), components: raw.components.filter(keep) };
  return { ...payload, hash: descriptorHash(payload), diagnostics: { ...diagnostics,
    boundaryRejected: extent(candidate).length - payload.basins.length - payload.components.length } };
}

export class WaterRegionPlanner {
  constructor(seed, { maxEntries = 36, createCandidates = planWaterRegionCandidates } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 9 || maxEntries > 64) throw new Error('Invalid water cache budget');
    this.seed = seed; this.maxEntries = maxEntries; this.createCandidates = createCandidates; this.cache = new Map();
  }
  candidates(x, z, onCandidate) {
    const key = regionKey(x, z);
    let plan = this.cache.get(key);
    const reused = !!plan;
    if (!plan) plan = this.createCandidates(this.seed, x, z);
    this.cache.delete(key); this.cache.set(key, plan);
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
    onCandidate?.(key, reused);
    return plan;
  }
  region(x, z, onCandidate) {
    const candidate = this.candidates(x, z, onCandidate), neighbours = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (dx || dz) neighbours.push(this.candidates(x + dx, z + dz, onCandidate));
    }
    return resolveWaterRegion(candidate, neighbours);
  }
  async cachedWindow(x, z, persistent, onProgress, {
    onPhase = null, generateCandidates = null, generationConcurrency = 1,
  } = {}) {
    if (![x, z].every(Number.isSafeInteger)) throw new Error('Invalid water window');
    if (!Number.isInteger(generationConcurrency) || generationConcurrency < 1 || generationConcurrency > 3
      || (generateCandidates !== null && typeof generateCandidates !== 'function')) throw new Error('Invalid candidate scheduler');
    const clock = () => globalThis.performance?.now?.() ?? Date.now();
    const measure = (name, started) => onPhase?.(name, Math.max(0, clock() - started));
    const entries = [];
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const rx = x + dx, rz = z + dz, key = regionKey(rx, rz);
      entries.push({ x: rx, z: rz, key, plan: this.cache.get(key) || null });
    }
    let completed = 0, reused = 0;
    const report = () => onProgress?.({ completed, total: 25, reused });
    report();
    const uncached = entries.filter(entry => !entry.plan);
    let started = clock();
    const restored = typeof persistent.getMany === 'function'
      ? await persistent.getMany(this.seed, uncached)
      : await Promise.all(uncached.map(entry => persistent.get(this.seed, entry.x, entry.z)));
    measure('cache-read', started);
    if (!Array.isArray(restored) || restored.length !== uncached.length) throw new Error('Invalid candidate cache batch');
    uncached.forEach((entry, index) => { entry.plan = restored[index]; });
    for (const entry of entries) if (entry.plan) { completed++; reused++; report(); }
    const missing = entries.filter(entry => !entry.plan);
    let cursor = 0;
    started = clock();
    const generate = generateCandidates || ((seed, rx, rz) => this.createCandidates(seed, rx, rz));
    // Fixed lanes bound both live candidate graphs and worker requests. Results
    // can finish out of order, but all arbitration/LRU/writes below are canonical.
    await Promise.all(Array.from({ length: Math.min(generationConcurrency, missing.length) }, async () => {
      while (cursor < missing.length) {
        const entry = missing[cursor++];
        entry.plan = await generate(this.seed, entry.x, entry.z);
        if (!entry.plan || entry.plan.seed !== this.seed || entry.plan.regionX !== entry.x
          || entry.plan.regionZ !== entry.z) throw new Error('Candidate generation identity mismatch');
        completed++; report();
      }
    }));
    measure('generation', started);
    started = clock();
    if (typeof persistent.putMany === 'function') await persistent.putMany(missing.map(entry => entry.plan));
    else for (const entry of missing) await persistent.put(entry.plan);
    measure('cache-write', started);
    started = clock();
    const candidates = new Map();
    for (const entry of entries) {
      candidates.set(entry.key, entry.plan);
      this.cache.delete(entry.key); this.cache.set(entry.key, entry.plan);
      while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
    }
    const plans = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const rx = x + dx, rz = z + dz, neighbours = [];
      for (let nz = -1; nz <= 1; nz++) for (let nx = -1; nx <= 1; nx++) {
        if (nx || nz) neighbours.push(candidates.get(regionKey(rx + nx, rz + nz)));
      }
      plans.push(resolveWaterRegion(candidates.get(regionKey(rx, rz)), neighbours));
    }
    measure('finalization', started);
    return plans;
  }
  window(x, z, onProgress) {
    if (![x, z].every(Number.isSafeInteger)) throw new Error('Invalid water window');
    const plans = [], seen = new Set();
    let reused = 0;
    const report = (key, cached) => {
      if (seen.has(key)) return;
      seen.add(key); reused += Number(cached);
      onProgress?.({ completed: seen.size, total: 25, reused });
    };
    onProgress?.({ completed: 0, total: 25, reused: 0 });
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) plans.push(this.region(x + dx, z + dz, report));
    return plans;
  }
}

export function changedWaterBounds(before, after) {
  const objects = plans => new Map(plans.flatMap(extent).map(o => [o.hash || descriptorHash(o), o]));
  const a = objects(before), b = objects(after), changed = [];
  for (const [key, object] of a) if (!b.has(key)) changed.push(object.bounds);
  for (const [key, object] of b) if (!a.has(key)) changed.push(object.bounds);
  return changed;
}
