// Pure vegetation data + math, free of any THREE dependency, so it can be
// imported by both the main thread (to build the geometry library) and the
// chunk-generation Web Worker (to place instances). Keep the numbers here in
// sync — VARIANT_COUNTS must match what createVegetationLibrary() builds.

export const VARIANT_COUNTS = {
  conifer: 4, broadleaf: 5, drytree: 4, palm: 3, cactus: 3,
  oak: 3, birch: 3, willow: 3, poplar: 3, baobab: 2, blossom: 2, apple: 3,
  shrub: 4, dryshrub: 3, deadtree: 3, rock: 8, boulder: 8, pebble: 4,
  reed: 3,
  // ground clutter — small props that break up empty ground (ferns/flowers now
  // live in the understory billboard atlas, not as 3D archetypes)
  mushroom: 3, fallenLog: 3, snag: 3, litter: 2, driftwood: 3, seaweed: 4,
  tidepool: 4,
  // deterministic trail ecology / crossing props
  plank: 3, trailPost: 3, trailRoot: 3, branchStack: 3, trailMud: 3,
};

// Coastal clutter keeps its variety across chunks rather than within every
// chunk. One deterministic variant per type lets all local instances share one
// InstancedMesh, avoiding expensive r165 BatchedMesh geometry duplication.
export function coastalVariantForChunk(type, cx, cz) {
  const count = VARIANT_COUNTS[type] || 1;
  let hash = (Math.imul(cx | 0, 73856093) ^ Math.imul(cz | 0, 19349663) ^ 0x51ed270b) >>> 0;
  for (let i = 0; i < type.length; i++) hash = (Math.imul(hash ^ type.charCodeAt(i), 16777619)) >>> 0;
  return hash % count;
}

// Tall archetypes that get distance billboards (the ones whose absence reads
// as a forest "edge"); small/sparse types are left to fog instead.
export const IMPOSTOR_TYPES = new Set([
  'conifer', 'broadleaf', 'drytree', 'palm',
  'oak', 'birch', 'willow', 'poplar', 'baobab', 'blossom',
]);

// Per-biome vegetation recipes: [archetype, weight], density = probability
// that one of ~240 scatter attempts per chunk yields a plant.
export const RECIPES = {
  desert:    { density: 0.05, mix: [['cactus', 0.5], ['dryshrub', 0.4], ['deadtree', 0.1]] },
  savanna:   { density: 0.10, mix: [['drytree', 0.48], ['baobab', 0.07], ['dryshrub', 0.35], ['deadtree', 0.1]] },
  jungle:    { density: 0.75, mix: [['broadleaf', 0.6], ['palm', 0.25], ['shrub', 0.15]] },
  grassland: { density: 0.07, mix: [['broadleaf', 0.2], ['oak', 0.18], ['poplar', 0.12], ['willow', 0.06], ['blossom', 0.09], ['shrub', 0.35]] },
  forest:    { density: 0.55, mix: [['broadleaf', 0.3], ['oak', 0.13], ['birch', 0.13], ['willow', 0.04], ['blossom', 0.02], ['conifer', 0.24], ['shrub', 0.14]] },
  taiga:     { density: 0.50, mix: [['conifer', 0.78], ['birch', 0.09], ['shrub', 0.13]] },
  tundra:    { density: 0.07, mix: [['dryshrub', 0.7], ['deadtree', 0.3]] },
  // Temperate strand vegetation: low salt-pruned shrubs only. Beach grasses
  // and flowering plants live in the cheaper understory layer below.
  beach:     { density: 0.045, mix: [['dryshrub', 0.58], ['shrub', 0.42]] },
  snow:      { density: 0.05, mix: [['conifer', 0.9], ['deadtree', 0.1]] },
  ocean:     { density: 0, mix: [] },
};

export const GRASS_COLORS = {
  grassland: [0.45, 0.55, 0.25], forest: [0.36, 0.47, 0.2], jungle: [0.3, 0.48, 0.17],
  savanna: [0.66, 0.58, 0.28], taiga: [0.34, 0.42, 0.24], tundra: [0.52, 0.5, 0.34],
  beach: [0.48, 0.52, 0.31], desert: [0.6, 0.55, 0.3],
};
export const GRASS_DENSITY = {
  grassland: 1.0, forest: 0.7, jungle: 0.8, savanna: 0.75,
  taiga: 0.4, tundra: 0.25, beach: 0.18, desert: 0.04,
};

// Ground-clutter recipes per biome — small props strewn at ~400 attempts/chunk.
// density is the per-attempt acceptance probability; mix is weighted archetypes.
// Forest/jungle ground gets the lush bonus (fern/mushroom/litter) under canopy,
// beaches get driftwood and pebble drifts, deserts get dry snags, etc.
// Ferns and flowers left this table for the understory billboard layer; the
// remaining 3D props (rebalanced to sum 1) are the woody/rocky ground objects.
// Densities dropped where ferns/flowers used to carry the mix.
export const CLUTTER_RECIPES = {
  forest:    { density: 0.42, mix: [['mushroom', 0.17], ['litter', 0.38], ['fallenLog', 0.17], ['snag', 0.10], ['pebble', 0.18]] },
  taiga:     { density: 0.40, mix: [['mushroom', 0.12], ['litter', 0.27], ['fallenLog', 0.20], ['snag', 0.17], ['pebble', 0.24]] },
  jungle:    { density: 0.42, mix: [['mushroom', 0.24], ['litter', 0.48], ['fallenLog', 0.24], ['pebble', 0.04]] },
  grassland: { density: 0.12, mix: [['pebble', 0.80], ['fallenLog', 0.20]] },
  savanna:   { density: 0.14, mix: [['snag', 0.35], ['pebble', 0.50], ['fallenLog', 0.15]] },
  tundra:    { density: 0.13, mix: [['pebble', 0.65], ['snag', 0.20], ['fallenLog', 0.15]] },
  desert:    { density: 0.10, mix: [['pebble', 0.55], ['snag', 0.30], ['fallenLog', 0.15]] },
  // Strand structure remains explicit below, but the former 0.72 density
  // produced 170–250 full-geometry props in a single mostly-beach chunk.
  beach:     { density: 0.50, mix: [['pebble', 0.38], ['driftwood', 0.24], ['seaweed', 0.32], ['snag', 0.06]] },
  snow:      { density: 0.06, mix: [['pebble', 0.45], ['snag', 0.35], ['fallenLog', 0.20]] },
  ocean:     { density: 0, mix: [] },
};

// --- understory billboard layer ---------------------------------------------
// Cheap crossed-quad plants from one shared atlas (4×3 cells): the whole layer
// is ONE InstancedMesh + draw call per chunk, so density can go far beyond what
// full-geometry clutter affords. Cell indices match makeUnderstoryAtlas():
//   0 bracken · 1 lupin · 2 cow-parsley · 3 pampas · 4 sapling · 5 horsetail
//   6 thistle · 7 bramble · 8 poppy · 9 daisy · 10 harebell · 11 buttercup
export const UNDERSTORY_RECIPES = {
  forest:    { density: 0.58, mix: [[0, 0.36], [2, 0.13], [4, 0.14], [5, 0.12], [6, 0.05], [7, 0.10], [9, 0.05], [10, 0.05]] },
  jungle:    { density: 0.72, mix: [[0, 0.50], [5, 0.25], [4, 0.15], [7, 0.10]] },
  taiga:     { density: 0.40, mix: [[0, 0.42], [5, 0.28], [4, 0.22], [9, 0.08]] },
  grassland: { density: 0.50, mix: [[1, 0.18], [2, 0.16], [3, 0.12], [6, 0.08], [0, 0.08], [8, 0.12], [9, 0.14], [10, 0.06], [11, 0.06]] },
  savanna:   { density: 0.20, mix: [[3, 0.60], [6, 0.30], [11, 0.10]] },
  tundra:    { density: 0.14, mix: [[3, 0.45], [6, 0.35], [10, 0.20]] },
  // Marram-like grass, sea holly/thistle, thrift-like low flowers and daisies.
  beach:     { density: 0.26, mix: [[3, 0.54], [6, 0.20], [10, 0.16], [9, 0.10]] },
  desert:    { density: 0.04, mix: [[6, 1.0]] },
  snow:      { density: 0.02, mix: [[3, 1.0]] },
  ocean:     { density: 0, mix: [] },
};
// The meadow flower drifts: billboard flower CLUSTERS placed with the same slow
// zone noise that used to drive the grass-field diamond wildflowers, so blooms
// gather into painterly patches instead of an even sprinkle.
export const FLOWER_CLUSTER_CELLS = [8, 9, 10, 11, 1, 2]; // poppy, daisy, harebell, buttercup, lupin, parsley
export const FLOWER_CLUSTER_BIOMES = ['grassland', 'forest', 'savanna', 'taiga', 'tundra', 'jungle'];
// per-cell scale ranges [min, max] — flowering spikes must clear the ~1m grass
// field to read in meadows; floor-hugging species stay under the canopy line
export const UNDERSTORY_SCALE = [
  [0.7, 1.3],   // bracken
  [1.0, 1.6],   // lupin
  [1.1, 1.8],   // cow-parsley
  [1.0, 1.8],   // pampas
  [1.0, 1.9],   // sapling
  [0.6, 1.1],   // horsetail
  [0.7, 1.2],   // thistle
  [0.5, 0.9],   // bramble
  [0.95, 1.55], // poppy
  [0.95, 1.4],  // daisy
  [0.95, 1.5],  // harebell
  [0.7, 1.15],  // buttercup
];

// Per-instance rock tint by biome (sandstone / sea-worn / granite), written
// into out[0..2]. Consumes one rng() for beach variation + one for shading,
// matching the original order so the world stays deterministic.
export function rockTint(biomeId, rng, out) {
  if (biomeId === 'desert' || biomeId === 'savanna') { out[0] = 1.08; out[1] = 0.88; out[2] = 0.7; }
  else if (biomeId === 'beach') {
    const t = rng();
    if (t < 0.33) { out[0] = 0.96; out[1] = 0.94; out[2] = 0.9; }
    else if (t < 0.66) { out[0] = 0.9; out[1] = 0.8; out[2] = 0.66; }
    else { out[0] = 0.7; out[1] = 0.73; out[2] = 0.79; }
  } else if (biomeId === 'chalk') { out[0] = 1.14; out[1] = 1.15; out[2] = 1.08; }
  else if (biomeId === 'snow' || biomeId === 'tundra') { out[0] = 0.86; out[1] = 0.9; out[2] = 1.0; }
  else { out[0] = 0.96; out[1] = 0.96; out[2] = 0.96; }
  const k = 0.85 + rng() * 0.3;
  out[0] *= k; out[1] *= k; out[2] *= k;
  return out;
}
