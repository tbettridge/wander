// Phase 6 structure selection: given the planned formation profile and the
// original ground, decide what each stretch of line actually *is* — an
// embankment, a cutting, a culvert over a stream, a timber or stone bridge, a
// tall viaduct, or a tunnel candidate — and flag impractical stretches for the
// planner. Pure and THREE-free so it runs in Node tests and can move to a worker.
//
// `kind` stays the five terrain-behaviour classes the rest of the railway
// already understands (surface/cut/fill deform terrain; bridge/tunnel do not).
// `family` is the richer structural identity that drives geometry and materials.

export const STRUCTURE_FAMILY = Object.freeze({
  surface: 0,
  embankment: 1,
  cutting: 2,
  culvert: 3,
  timber: 4,
  stone: 5,
  viaduct: 6,
  tunnel: 7,
});
export const STRUCTURE_FAMILY_NAME = Object.freeze([
  'surface', 'embankment', 'cutting', 'culvert', 'timber', 'stone', 'viaduct', 'tunnel',
]);

const TIMBER_BIOMES = new Set(['forest', 'taiga', 'jungle', 'savanna']);

export const STRUCTURE_LIMITS = Object.freeze({
  fillSurface: 1.35,    // |offset| below this is graded surface, no earthwork
  cutSurface: 1.35,
  highFill: 5.5,        // a dry bank taller than this is carried on a structure
  deepCut: 5.5,         // a cut deeper than this becomes a tunnel candidate
  culvertMaxSpan: 34,   // short watercourse → culvert rather than open bridge
  culvertMaxRise: 4.2,
  timberMaxSpan: 62,    // modest spans in timber country → timber trestle
  timberMaxRise: 8.5,
  viaductRise: 12,      // deep valley / tall deck → viaduct
  viaductSpan: 150,
  retainFill: 3.2,      // steep bank shoulders gain a retaining wall
  retainCut: 3.2,
  guardrailFill: 3.0,
  impracticalRise: 34,  // beyond this the segment is returned to the planner
});

function kindFromOffset(point, offset, limits) {
  if (point.ocean || point.wet) return 'bridge';
  if (offset > limits.highFill) return 'bridge';
  if (offset > limits.fillSurface) return 'fill';
  if (offset < -limits.deepCut) return 'tunnel';
  if (offset < -limits.cutSurface) return 'cut';
  return 'surface';
}

function segmentLength(points, i, n) {
  const a = points[i], b = points[(i + 1) % n];
  return Math.hypot(b.x - a.x, b.z - a.z);
}

// Collect maximal runs of a matching kind on the closed loop, each as
// { start, members[], length, maxRise, wet, biome }. Runs never wrap twice.
function collectRuns(points, kinds, offsets, n, match) {
  // Find a boundary so a run that straddles index 0 is still contiguous.
  let startAt = 0;
  for (let i = 0; i < n; i++) {
    if (kinds[i] !== match) { startAt = i; break; }
    if (i === n - 1) startAt = 0; // whole loop matches (degenerate)
  }
  const runs = [];
  let current = null;
  for (let step = 0; step <= n; step++) {
    const i = (startAt + step) % n;
    const isMatch = kinds[i] === match && step < n;
    if (isMatch) {
      if (!current) current = { start: i, members: [], length: 0, maxRise: 0, wet: false, biomes: {} };
      current.members.push(i);
      current.length += segmentLength(points, i, n);
      current.maxRise = Math.max(current.maxRise, Math.abs(offsets[i]));
      if (points[i].wet || points[i].ocean) current.wet = true;
      current.biomes[points[i].biome] = (current.biomes[points[i].biome] || 0) + 1;
    } else if (current) {
      runs.push(current);
      current = null;
    }
  }
  return runs;
}

function dominantBiome(biomes) {
  let best = null, bestCount = -1;
  for (const [biome, count] of Object.entries(biomes)) {
    if (count > bestCount) { bestCount = count; best = biome; }
  }
  return best;
}

function bridgeFamily(run, limits) {
  const biome = dominantBiome(run.biomes);
  if (run.wet && run.length <= limits.culvertMaxSpan && run.maxRise <= limits.culvertMaxRise) {
    return 'culvert';
  }
  if (run.maxRise >= limits.viaductRise || run.length >= limits.viaductSpan) {
    return 'viaduct';
  }
  if (run.length <= limits.timberMaxSpan && run.maxRise <= limits.timberMaxRise
      && TIMBER_BIOMES.has(biome)) {
    return 'timber';
  }
  return 'stone';
}

/**
 * Classify every route point. Mutates each point with `structure` (kind),
 * `family`, `familyCode`, and `formationOffset`, and returns a summary with
 * family counts and any impractical segments flagged for rerouting.
 */
export function classifyRailwayStructures(points, heights, options = {}) {
  const limits = { ...STRUCTURE_LIMITS, ...options };
  const n = points.length;
  const kinds = new Array(n);
  const offsets = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const offset = heights[i] - points[i].h;
    offsets[i] = offset;
    kinds[i] = kindFromOffset(points[i], offset, limits);
  }

  const family = new Array(n);
  for (let i = 0; i < n; i++) {
    const kind = kinds[i];
    if (kind === 'fill') family[i] = 'embankment';
    else if (kind === 'cut') family[i] = 'cutting';
    else if (kind === 'tunnel') family[i] = 'tunnel';
    else if (kind === 'surface') family[i] = 'surface';
    else family[i] = 'stone'; // provisional; refined per bridge run below
  }

  // Bridges get their identity from the whole crossing, not a single sample —
  // a short wet dip is a culvert, a long deep gap is a viaduct.
  for (const run of collectRuns(points, kinds, offsets, n, 'bridge')) {
    const fam = bridgeFamily(run, limits);
    for (const i of run.members) family[i] = fam;
  }

  const summary = {
    families: { surface: 0, embankment: 0, cutting: 0, culvert: 0, timber: 0, stone: 0, viaduct: 0, tunnel: 0 },
    reroutes: [],
  };
  for (let i = 0; i < n; i++) {
    points[i].structure = kinds[i];
    points[i].family = family[i];
    points[i].familyCode = STRUCTURE_FAMILY[family[i]] ?? 0;
    points[i].formationOffset = offsets[i];
    summary.families[family[i]]++;
    // A dry bank or cut beyond the practical envelope is returned to the planner
    // (recorded here; the alignment itself already respects the grade limits).
    if (!points[i].wet && !points[i].ocean && Math.abs(offsets[i]) > limits.impracticalRise) {
      summary.reroutes.push({ index: i, offset: offsets[i], x: points[i].x, z: points[i].z });
    }
  }
  return summary;
}
