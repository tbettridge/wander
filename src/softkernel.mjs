// Kernels for the distance-wash blur, kept THREE-free so their weights can be
// asserted without a GPU.
//
// Both must sum to 1. A kernel that does not is a silent brightness bug: the
// wash would lighten or darken far ground as a side effect of blurring it, and
// because it only shows up where fog is already strong it reads as "the fog
// colour is slightly off" rather than as a broken filter.

// 13-tap dual-filter downsample (Jimenez/CoD). Chosen over a naive bilinear
// halving because that aliases thin bright grass blades into crawling speckle
// when the camera moves — the whole point is a stable wash, and a flickering
// one would read as noise rather than paint.
export const DOWN_WEIGHTS = Object.freeze({
  centre: 0.125,
  corners: 0.03125,   // ×4, at ±2 texels
  edges: 0.0625,      // ×4, at ±2 texels
  inner: 0.125,       // ×4, at ±1 texel
});

// Separable 5-tap gaussian, run once horizontally and once vertically.
export const BLUR_WEIGHTS = Object.freeze({
  centre: 0.227,
  near: 0.316,        // ×2, at ±1.3846 texels (linear-sampled pair)
  far: 0.070,         // ×2, at ±3.2308 texels
});

export function downKernelSum(w = DOWN_WEIGHTS) {
  return w.centre + 4 * w.corners + 4 * w.edges + 4 * w.inner;
}

export function blurKernelSum(w = BLUR_WEIGHTS) {
  return w.centre + 2 * w.near + 2 * w.far;
}

// How the grade pass turns DISTANCE into a wash amount.
//
// Distance comes from the depth buffer, not from the composer's alpha channel.
// Alpha looks free but is not: Three forces it to 1.0 for every material with
// OPAQUE defined, transparent materials blend their opacity through it, and
// custom ShaderMaterials write whatever they write — three conflicting
// meanings already in the channel, spread over every material in the renderer.
// Depth is written once, by the same rasteriser, with one meaning.
//
// It also reads better: fog saturates (Wander's Fog(200, 900) is barely engaged
// at most viewpoints), whereas depth keeps resolving all the way out to the
// far terrain at 7.5 km.
export const WASH = Object.freeze({
  near: 90,           // metres: nothing closer is touched at all
  far: 900,           // metres: the wash reaches full strength here
  maxWet: 0.85,       // even the far horizon keeps a little structure
  softMix: 0.42,      // maximum mix toward the blurred buffer
  chromaBleed: 0.17,  // maximum chroma pull toward the neighbourhood's hue
  // Depth values at or above this are background — nothing was rasterised
  // there. The sky dome has depthWrite:false, so the sky lands here and must
  // read as NEAR: it is the one large surface a distance wash would visibly
  // ruin, and it is already smooth enough to gain nothing from blurring.
  //
  // Exactly 1.0, not a slack epsilon. Perspective depth crowds hard at the far
  // plane: with Wander's 0.1/11000 camera the far terrain at 7.5 km sits at
  // depth 0.999996, so a 0.9999 cutoff would have classified the entire distant
  // horizon — the thing this effect most wants to soften — as sky. Cleared
  // depth is exactly 1.0 and rasterised geometry is strictly below it, so the
  // exact test is both safer and more correct than any epsilon.
  skyDepth: 1.0,
});

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** The wash amount at a given view distance in metres. */
export function washAmount(distance, wetness = 1, wash = WASH) {
  if (!(distance > 0)) return 0;
  const ramp = smoothstep(wash.near, wash.far, distance);
  return ramp * wash.maxWet * Math.min(Math.max(wetness, 0), 1);
}

/** Linear view-distance encoding carried in the soft buffer's alpha channel. */
export function softDistanceAlpha(distance, wash = WASH) {
  if (!(distance > 0)) return 0;
  return Math.min(distance / wash.far, 1);
}

/** Recover the existing wash curve from the linear distance encoding. */
export function washAmountFromSoftAlpha(alpha, wetness = 1, wash = WASH) {
  return washAmount(Math.max(0, Number(alpha) || 0) * wash.far, wetness, wash);
}

/** Background (nothing rasterised) must never wash — see WASH.skyDepth. */
export function isBackgroundDepth(depth, wash = WASH) {
  return depth >= wash.skyDepth;
}

/**
 * Perspective depth buffer value -> view-space distance in metres, matching
 * Three's perspectiveDepthToViewZ. Mirrored here so the ramp can be checked
 * against real near/far values without a GPU.
 */
export function depthToDistance(depth, near, far) {
  const z = depth * 2 - 1;
  return (2 * near * far) / (far + near - z * (far - near));
}
