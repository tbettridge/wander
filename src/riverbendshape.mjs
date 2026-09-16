// Low-frequency, bend-aware width character for opt-in river profiles.
//
// The fitter owns the final section geometry. This module only turns a fitted
// centreline into smooth scalar/side multipliers so a Hermite sampling spike
// cannot become a row of scalloped ponds or a water-level change.

const EPSILON = 1e-9;

export const RIVER_MORPHOLOGY_MAX_WIDTH_MULTIPLIER = 1.30;
export const RIVER_MORPHOLOGY_MAX_SIDE_BEND_MULTIPLIER = 1.10;
export const RIVER_MORPHOLOGY_CURVATURE_SMOOTHING_METERS = 32;
export const RIVER_MORPHOLOGY_POINT_BAR_AMPLITUDE = RIVER_MORPHOLOGY_MAX_SIDE_BEND_MULTIPLIER - 1;

// A 150–650 m bend is broad at the fitted 4 m section scale. Start the
// widening gently in that range and reach the authored cap only on the
// tighter-but-still-open bends that can support a point bar.
const CURVATURE_START = 0.0015;
const CURVATURE_FULL = 0.009;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const smoothstep = (edge0, edge1, value) => {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

function hashString(value, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let i = 0; i < String(value).length; i++) {
    hash ^= String(value).charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function mix32(value) {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

function valueNoise1D(x, seed) {
  const lower = Math.floor(x), fraction = x - lower;
  const t = fraction * fraction * fraction * (fraction * (fraction * 6 - 15) + 10);
  const lattice = n => (mix32(seed ^ Math.imul(n | 0, 0x9e3779b9)) >>> 0) / 4294967296;
  const left = lattice(lower), right = lattice(lower + 1);
  return left + (right - left) * t;
}

function morphologyNoise(profile, globalArc) {
  const seed = mix32(hashString(`${profile?.id ?? ''}:${profile?.variationSeed ?? 0}:morphology`));
  // Both scales are long relative to the 4 m fitting lattice. Their blend is
  // seeded, continuous, and has no short repeating pond-sized pulse.
  const broad = valueNoise1D(globalArc / 144, seed);
  const local = valueNoise1D(globalArc / 58, seed ^ 0x9e3779b9);
  return ((broad - 0.5) * 0.72 + (local - 0.5) * 0.28) * 2;
}

function cumulativeArcs(points) {
  const arcs = [0];
  for (let i = 1; i < points.length; i++) {
    arcs.push(arcs[i - 1] + Math.hypot(points[i].x - points[i - 1].x,
      points[i].z - points[i - 1].z));
  }
  return arcs;
}

function pointCurvature(points, index) {
  const point = points[index], before = points[Math.max(0, index - 1)], after = points[Math.min(points.length - 1, index + 1)];
  const aLength = Math.hypot(point.x - before.x, point.z - before.z);
  const bLength = Math.hypot(after.x - point.x, after.z - point.z);
  const span = Math.hypot(after.x - before.x, after.z - before.z);
  if (aLength < EPSILON || bLength < EPSILON || span < EPSILON) return 0;
  const cross = (point.x - before.x) * (after.z - point.z)
    - (point.z - before.z) * (after.x - point.x);
  return 2 * cross / (aLength * bLength * span);
}

function smoothCurvatures(arcs, raw) {
  const radius = RIVER_MORPHOLOGY_CURVATURE_SMOOTHING_METERS;
  return raw.map((value, index) => {
    let weighted = 0, weightTotal = 0;
    for (let j = index; j >= 0 && arcs[index] - arcs[j] <= radius; j--) {
      const weight = 1 - (arcs[index] - arcs[j]) / radius;
      weighted += raw[j] * weight; weightTotal += weight;
    }
    for (let j = index + 1; j < raw.length && arcs[j] - arcs[index] <= radius; j++) {
      const weight = 1 - (arcs[j] - arcs[index]) / radius;
      weighted += raw[j] * weight; weightTotal += weight;
    }
    return weightTotal > EPSILON ? weighted / weightTotal : value;
  });
}

function terrainSupport(world, points, index, footprint) {
  const point = points[index];
  if (typeof world?._naturalHeight !== 'function') return 1;
  const radius = Math.max(24, footprint + 16);
  const before = points[Math.max(0, index - 1)], after = points[Math.min(points.length - 1, index + 1)];
  const tx = Number.isFinite(point.tx) ? point.tx : after.x - before.x;
  const tz = Number.isFinite(point.tz) ? point.tz : after.z - before.z;
  const tangentLength = Math.hypot(tx, tz);
  const nx = -tz / Math.max(EPSILON, tangentLength);
  const nz = tx / Math.max(EPSILON, tangentLength);
  const centre = world._naturalHeight(point.x, point.z);
  const left = world._naturalHeight(point.x + nx * radius, point.z + nz * radius);
  const right = world._naturalHeight(point.x - nx * radius, point.z - nz * radius);
  if (![centre, left, right].every(Number.isFinite)) return 1;
  const crossRise = Math.max(Math.abs(left - centre), Math.abs(right - centre));
  // A rapid cross-valley rise means the wider point-bar shelf has no room.
  return 1 - smoothstep(0.08, 0.22, crossRise / radius);
}

/**
 * Build smooth bend shape multipliers for a fitted centreline.
 * `profileArcLength` anchors the seeded noise to the canonical graph span,
 * while curvature smoothing uses the physical fitted distances.
 */
export function buildRiverBendShape(points, { profile = null, world = null, profileArcLength = 0 } = {}) {
  if (!Array.isArray(points) || points.length < 2
    || points.some(point => !point || ![point.x, point.z].every(Number.isFinite))) {
    throw new Error('Invalid river bend shape path');
  }
  const arcs = cumulativeArcs(points), totalArc = arcs.at(-1);
  const raw = points.map((_, index) => pointCurvature(points, index));
  const smoothed = smoothCurvatures(arcs, raw);
  const canonicalLength = Number.isFinite(profileArcLength) && profileArcLength > EPSILON
    ? profileArcLength : totalArc;
  const anchor = Math.max(profile?.halfWidth ?? 4, profile?.startHalfWidth ?? 0,
    profile?.endHalfWidth ?? 0);
  const footprint = Math.max(1, anchor);
  // Keep the strict raw-curvature fold check conservative. A morphology
  // bulge is attenuated before that check becomes marginal, using the same
  // nominal noise/bank/blend envelope that the fitter uses for its guard.
  const nominalFootprint = anchor * 1.14 * 1.12 + 8 + 8;
  return points.map((point, index) => {
    const canonicalArc = totalArc > EPSILON ? arcs[index] / totalArc * canonicalLength : 0;
    const globalArc = canonicalArc + (profile?.arcOffset ?? 0);
    const support = terrainSupport(world, points, index, footprint);
    const endpointFade = smoothstep(0, RIVER_MORPHOLOGY_CURVATURE_SMOOTHING_METERS, arcs[index])
      * smoothstep(0, RIVER_MORPHOLOGY_CURVATURE_SMOOTHING_METERS, totalArc - arcs[index]);
    const effectiveCurvature = smoothed[index] * endpointFade;
    const curvatureStrength = smoothstep(CURVATURE_START, CURVATURE_FULL, Math.abs(effectiveCurvature))
      * support;
    const foldRisk = Math.abs(raw[index]) * nominalFootprint;
    const morphologySafety = 1 - smoothstep(0.58, 0.78, foldRisk);
    const noise = morphologyNoise(profile, globalArc);
    const organic = 1 + noise * 0.08 * morphologySafety;
    const bendWidening = clamp(organic * (1
      + (RIVER_MORPHOLOGY_MAX_WIDTH_MULTIPLIER - 1) * curvatureStrength
        * morphologySafety * (0.94 + noise * 0.06)), 0.86, RIVER_MORPHOLOGY_MAX_WIDTH_MULTIPLIER);
    const signedBend = clamp(effectiveCurvature / CURVATURE_FULL, -1, 1);
    const pointBar = RIVER_MORPHOLOGY_POINT_BAR_AMPLITUDE * curvatureStrength;
    return {
      smoothedCurvature: smoothed[index],
      effectiveCurvature,
      bendWidening,
      support,
      curvatureStrength,
      morphologySafety,
      // The terrain fitter's positive lateral side is `right`; retaining its
      // sign convention keeps point-bar widening continuous with old shelves.
      leftMultiplier: 1 - signedBend * pointBar,
      rightMultiplier: 1 + signedBend * pointBar,
    };
  });
}

/** Return the extra proposal-clearance factor required by morphology. */
export function riverMorphologyClearanceMultiplier(profile) {
  return profile?.morphology === true
    ? RIVER_MORPHOLOGY_MAX_WIDTH_MULTIPLIER * RIVER_MORPHOLOGY_MAX_SIDE_BEND_MULTIPLIER
    : 1;
}
