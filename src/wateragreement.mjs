import { descriptorHash, WATER_CACHE_REVISION } from './hydrologyformat.mjs';
import { normalizeWorldGeneration } from './worldgeneration.mjs';

export const WATER_AGREEMENT_SUPPORT = Object.freeze({ version: 1, terrain: 3, hydrology: WATER_CACHE_REVISION });
export function supportsWaterAgreement(value) {
  return value?.version === 1 && value.terrain === 3 && value.hydrology === WATER_CACHE_REVISION;
}

export function normalizeWaterAgreement(value, expectedSeed = value?.seed) {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.seed) || value.seed !== expectedSeed
    || !Number.isSafeInteger(value.regionX) || !Number.isSafeInteger(value.regionZ)
    || !Array.isArray(value.regions) || value.regions.length !== 9) throw new Error('Invalid landscape agreement');
  const generation = normalizeWorldGeneration(value.generation);
  if (generation.terrain !== 3 || generation.layout !== 'regional' || generation.hydrology !== WATER_CACHE_REVISION) {
    throw new Error('This landscape requires a different world generator');
  }
  const regions = value.regions.map(region => {
    if (!region || !Number.isSafeInteger(region.x) || !Number.isSafeInteger(region.z)
      || Math.abs(region.x - value.regionX) > 1 || Math.abs(region.z - value.regionZ) > 1
      || typeof region.hash !== 'string' || !/^[a-f0-9]{8}$/.test(region.hash)) throw new Error('Invalid landscape region');
    return { x: region.x, z: region.z, hash: region.hash };
  }).sort((a, b) => a.x - b.x || a.z - b.z);
  if (new Set(regions.map(r => `${r.x},${r.z}`)).size !== 9) throw new Error('Incomplete landscape agreement');
  const payload = { version: 1, seed: value.seed, generation, regionX: value.regionX, regionZ: value.regionZ, regions };
  if (value.hash !== descriptorHash(payload)) throw new Error('Landscape agreement checksum mismatch');
  return { ...payload, hash: value.hash };
}

export function createWaterAgreement(seed, regionX, regionZ, plans) {
  const payload = { version: 1, seed, generation: { terrain: 3, hydrology: WATER_CACHE_REVISION, layout: 'regional' },
    regionX, regionZ, regions: plans.map(p => {
      if (p.seed !== seed || p.regional !== 1 || p.generationVersion !== 3) throw new Error('Landscape plan identity mismatch');
      return { x: p.regionX, z: p.regionZ, hash: p.hash };
    }).sort((a, b) => a.x - b.x || a.z - b.z) };
  return normalizeWaterAgreement({ ...payload, hash: descriptorHash(payload) });
}

export function verifyWaterAgreement(value, plans) {
  const agreement = normalizeWaterAgreement(value);
  // Recompute descriptor checksums: trusting just a copied hash would conceal
  // damaged geometry, even if the manifest itself survived transmission.
  for (const plan of plans) {
    const { diagnostics, hash, ...payload } = plan;
    if (hash !== descriptorHash(payload)) throw new Error('Local landscape plan checksum mismatch');
  }
  const local = createWaterAgreement(agreement.seed, agreement.regionX, agreement.regionZ, plans);
  if (local.hash !== agreement.hash) throw new Error('Your landscape does not match the host');
  return agreement;
}

// Planning/validation is complete before the returned stream may be installed
// in a guest World. Reuse the persistent cache through the standard worker.
export async function prepareAgreedWaterLandscape(value, { signal, onProgress, workerFactory } = {}) {
  const agreement = normalizeWaterAgreement(value);
  if (signal?.aborted) throw new Error('Landscape preparation cancelled');
  const { HydrologyStream } = await import('./hydrologystream.mjs');
  const { World } = await import('./world.js');
  if (signal?.aborted) throw new Error('Landscape preparation cancelled');
  const worker = workerFactory ? workerFactory() : new Worker(new URL('./hydrologyworker.js?v=hydrology10', import.meta.url), { type: 'module' });
  const stream = new HydrologyStream(agreement.seed, worker, { onProgress });
  const cancel = () => { stream.fail('Landscape preparation cancelled'); stream.dispose(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await stream.initialize(agreement.regionX, agreement.regionZ);
    if (signal?.aborted) throw new Error('Landscape preparation cancelled');
    verifyWaterAgreement(agreement, result.plans);
    const world = new World(agreement.seed, { waterPlans: result.plans, generationVersion: 3 });
    stream.commit(result);
    return { world, waterPlans: result.plans, generationVersion: 3, stream, agreement };
  } catch (error) { if (!stream.disposed) stream.dispose(); throw error; }
  finally { signal?.removeEventListener('abort', cancel); }
}
