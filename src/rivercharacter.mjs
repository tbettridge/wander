// Deterministic, low-frequency character for fitted river sections.
//
// The profile is deliberately independent of the route sampling lattice.  A
// caller can therefore split or re-sample a reach while retaining the same
// global arc origin and receiving the same width/depth character.

export {
  RIVER_MORPHOLOGY_MAX_SIDE_BEND_MULTIPLIER,
  RIVER_MORPHOLOGY_MAX_WIDTH_MULTIPLIER,
  riverMorphologyClearanceMultiplier,
} from './riverbendshape.mjs';

const MAX_HALF_WIDTH = 22.5;
const MIN_HALF_WIDTH = 1;
const DEFAULT_WIDTH_VARIATION = 0.14;
const DEFAULT_DEPTH_VARIATION = 0.12;
const NATURAL_WIDTH_VARIATION = 0.34;
const NORMALIZED_PROFILES = new WeakSet();
const PROFILE_SEEDS = new WeakMap();

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function hashString(value, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
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

function seedFor(profile, salt) {
  let seeds = PROFILE_SEEDS.get(profile);
  if (!seeds) { seeds = new Map(); PROFILE_SEEDS.set(profile, seeds); }
  if (seeds.has(salt)) return seeds.get(salt);
  const numericSeed = Number.isFinite(profile.variationSeed)
    ? Math.trunc(profile.variationSeed) : 0;
  const seed = mix32(hashString(`${profile.id}:${numericSeed}:${salt}`));
  seeds.set(salt, seed);
  return seed;
}

function unitFromHash(seed) {
  return (mix32(seed) >>> 0) / 4294967296;
}

// Quintic interpolation gives a zero slope at lattice boundaries.  This is
// value noise rather than a periodic trigonometric signal: adjacent lattice
// values are unrelated, so a long reach does not acquire a repeated pulse.
function valueNoise1D(x, seed) {
  const lower = Math.floor(x);
  const fraction = x - lower;
  const t = fraction * fraction * fraction * (fraction * (fraction * 6 - 15) + 10);
  // Both sides use the same lattice hash.  Using separate salts for the two
  // endpoints would create a discontinuity at every lattice boundary.
  const lattice = n => unitFromHash(seed ^ Math.imul(n | 0, 0x9e3779b9));
  const left = lattice(lower), right = lattice(lower + 1);
  return left + (right - left) * t;
}

function boundedVariation(profile, globalArc, salt, amplitude, shaped = false) {
  // The two scales are intentionally incommensurate.  The broad component
  // carries the shape over a walkable stretch, while the smaller component
  // prevents a reach from looking like one smooth linear ramp.
  const broad = valueNoise1D(globalArc / 96, seedFor(profile, salt));
  const local = valueNoise1D(globalArc / 37, seedFor(profile, salt + 1));
  const centred = (broad - 0.5) * 0.72 + (local - 0.5) * 0.28;
  return 1 + (shaped ? Math.sin(centred * Math.PI) : centred * 2) * amplitude;
}

function finiteOr(value, fallback) {
  return value === undefined ? fallback : value;
}

/**
 * Validate and copy a channel character profile.
 *
 * `startHalfWidth`, `endHalfWidth`, `arcOffset` and `variationSeed` are
 * optional so a producer can author only the nominal anchors.  A producer
 * that splits one profile across several reaches may also provide the paired
 * global `trendStartArc`/`trendEndArc` bounds; without those bounds the
 * start/end trend is local to the fitted reach.  The returned copy always
 * carries explicit values for the six core fields, which keeps a serialized
 * fitted reach self-contained and deterministic. `morphology` is copied only
 * when explicitly supplied so legacy descriptors retain their exact shape.
 */
export function normalizeChannelProfile(profile) {
  // Regional trunks declare a separate, terrain-validated scale. Ordinary
  // headwater profiles retain their established 22.5m section contract.
  const limit = profile?.regionalTrunk === true ? 80 : MAX_HALF_WIDTH;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)
    || typeof profile.id !== 'string' || !profile.id.length
    || !Number.isFinite(profile.halfWidth)
    || profile.halfWidth < MIN_HALF_WIDTH || profile.halfWidth > limit
    || !Number.isFinite(profile.depth) || profile.depth <= 0) {
    throw new Error('Invalid river channel profile');
  }
  const startHalfWidth = finiteOr(profile.startHalfWidth, profile.halfWidth);
  const endHalfWidth = finiteOr(profile.endHalfWidth, profile.halfWidth);
  const arcOffset = finiteOr(profile.arcOffset, 0);
  const variationSeed = finiteOr(profile.variationSeed, 0);
  const hasTrendStart = profile.trendStartArc !== undefined;
  const hasTrendEnd = profile.trendEndArc !== undefined;
  const hasMorphology = profile.morphology !== undefined;
  if (profile.regionalTrunk !== undefined && typeof profile.regionalTrunk !== 'boolean') {
    throw new Error('Invalid river channel profile');
  }
  if (hasMorphology && typeof profile.morphology !== 'boolean') {
    throw new Error('Invalid river channel profile');
  }
  const trendStartArc = profile.trendStartArc;
  const trendEndArc = profile.trendEndArc;
  if (![startHalfWidth, endHalfWidth].every(Number.isFinite)
    || startHalfWidth < MIN_HALF_WIDTH || startHalfWidth > limit
    || endHalfWidth < MIN_HALF_WIDTH || endHalfWidth > limit
    || !Number.isFinite(arcOffset) || !Number.isFinite(variationSeed)
    || hasTrendStart !== hasTrendEnd
    || (hasTrendStart && (!Number.isFinite(trendStartArc) || !Number.isFinite(trendEndArc)
      || trendEndArc <= trendStartArc))) {
    throw new Error('Invalid river channel profile');
  }
  const normalized = Object.freeze({
    id: profile.id,
    halfWidth: profile.halfWidth,
    depth: profile.depth,
    startHalfWidth,
    endHalfWidth,
    arcOffset,
    variationSeed,
    ...(hasTrendStart ? { trendStartArc, trendEndArc } : {}),
    ...(hasMorphology ? { morphology: profile.morphology } : {}),
    ...(profile.regionalTrunk === true ? { regionalTrunk: true } : {}),
  });
  NORMALIZED_PROFILES.add(normalized);
  return normalized;
}

/**
 * Evaluate the profile at a section's local arc.
 *
 * `totalArc` is used only for the authored start/end trend.  Noise itself is
 * sampled in global arc space (`arc + arcOffset`) so re-segmentation does not
 * restart the character pattern at a new reach-local origin.
 */
export function channelProfileAt(profile, arc, totalArc) {
  const normalized = profile && typeof profile === 'object' && NORMALIZED_PROFILES.has(profile)
    ? profile : normalizeChannelProfile(profile);
  if (!Number.isFinite(arc) || !Number.isFinite(totalArc) || totalArc < 0) {
    throw new Error('Invalid river channel arc');
  }
  const globalArc = arc + normalized.arcOffset;
  const progress = normalized.trendStartArc !== undefined
    ? clamp((globalArc - normalized.trendStartArc)
      / (normalized.trendEndArc - normalized.trendStartArc), 0, 1)
    : (totalArc > 1e-9 ? clamp(arc / totalArc, 0, 1) : 0);
  const trend = normalized.startHalfWidth
    + (normalized.endHalfWidth - normalized.startHalfWidth)
      * (progress * progress * (3 - 2 * progress));
  const natural = normalized.morphology === true;
  const headwaterProgress = clamp((globalArc - 96) / 160, 0, 1);
  const widthAmplitude = DEFAULT_WIDTH_VARIATION + (NATURAL_WIDTH_VARIATION - DEFAULT_WIDTH_VARIATION)
    * headwaterProgress * headwaterProgress * (3 - 2 * headwaterProgress);
  const widthVariation = boundedVariation(normalized, globalArc, 17,
    natural ? widthAmplitude : DEFAULT_WIDTH_VARIATION, natural);
  const depthVariation = boundedVariation(normalized, globalArc, 53,
    natural ? 0.18 : DEFAULT_DEPTH_VARIATION, natural);
  return {
    halfWidth: trend * widthVariation,
    ...(natural ? { referenceHalfWidth: trend * boundedVariation(normalized, globalArc, 17, DEFAULT_WIDTH_VARIATION) } : {}),
    depth: normalized.depth * depthVariation,
    widthVariation,
    depthVariation,
    globalArc,
    progress,
  };
}

// Both sides have their own broad erosion/deposition pattern. Sampling the
// shared profile distance keeps banks continuous across segmented reaches.
export function channelBankVariation(profile, globalArc, side) {
  const normalized = NORMALIZED_PROFILES.has(profile) ? profile : normalizeChannelProfile(profile);
  if (!Number.isFinite(globalArc) || !['left', 'right'].includes(side)) throw new Error('Invalid river bank sample');
  const salt = side === 'left' ? 101 : 137;
  return {
    width: 0.94 * boundedVariation(normalized, globalArc, salt, 0.24),
    blend: boundedVariation(normalized, globalArc, salt + 5, 0.10),
    shoulder: (boundedVariation(normalized, globalArc, salt + 9, 0.16) - 1) * 0.45,
  };
}

/**
 * Conservative maximum fitted half-width for a channel profile. The bound
 * includes seeded profile noise, the existing lateral bend factor, and the
 * opt-in morphology/point-bar multipliers so proposal clearance can use the
 * same envelope as final terrain fitting.
 */
export function channelProfileHalfWidthBound(profile) {
  const normalized = profile && typeof profile === 'object' && NORMALIZED_PROFILES.has(profile)
    ? profile : normalizeChannelProfile(profile);
  const anchor = Math.max(normalized.halfWidth, normalized.startHalfWidth, normalized.endHalfWidth);
  // Modern sections share one total expansion budget in prepareRiverReach.
  // Its 1.30 × legacy total width, plus the worst permitted side ratio,
  // bounds a half-width by 2.05 × the nominal anchor. Multiplying every
  // independent shape maximum again invents an unused clearance radius.
  return normalized.morphology ? anchor * 2.05 : anchor * (1 + DEFAULT_WIDTH_VARIATION) * 1.12;
}

export const CHANNEL_PROFILE_LIMITS = Object.freeze({
  minHalfWidth: MIN_HALF_WIDTH,
  maxHalfWidth: MAX_HALF_WIDTH,
  widthVariation: DEFAULT_WIDTH_VARIATION,
  depthVariation: DEFAULT_DEPTH_VARIATION,
});
