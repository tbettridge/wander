import { WATER_CACHE_REVISION } from './hydrologyformat.mjs';

export function normalizeWorldGeneration(value) {
  if (value == null) return { terrain: 2, hydrology: 0, layout: 'legacy' };
  const { terrain, hydrology, layout } = value;
  if (terrain === 2 && hydrology === 0 && layout === 'legacy') return { terrain, hydrology, layout };
  if (terrain !== 3 || !Number.isSafeInteger(hydrology) || hydrology < 1
    || typeof layout !== 'string' || !/^(regional|preview:[a-f0-9]{8})$/.test(layout)) throw new Error('Unsupported world generation identity');
  return { terrain, hydrology, layout };
}

export function worldGenerationFor(world) {
  if (world.generationVersion !== 3) return normalizeWorldGeneration();
  const plans = world.waterField?.plans || [];
  return normalizeWorldGeneration({ terrain: 3, hydrology: WATER_CACHE_REVISION,
    layout: plans.length && plans.every(p => p.regional === 1) ? 'regional' : `preview:${world.waterPlanHash || '00000000'}` });
}

export function worldGenerationScope(value) {
  const generation = normalizeWorldGeneration(value);
  return generation.terrain === 2 ? '' : `.generation-${generation.terrain}-${generation.hydrology}-${encodeURIComponent(generation.layout)}`;
}

export function sameWorldGeneration(a, b) { return worldGenerationScope(a) === worldGenerationScope(b); }

export function assertSharedWorldGeneration(value, regionalEnabled = false) {
  const generation = normalizeWorldGeneration(value);
  if (generation.terrain === 2 || (regionalEnabled && generation.layout === 'regional' && generation.hydrology === WATER_CACHE_REVISION)) return;
  if (generation.terrain !== 2) throw new Error('Water previews are single-player until shared landscape loading is ready.');
}
