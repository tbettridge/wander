// The painted palette: one source of truth for every pigment in the world.
//
// These values were previously hex/float literals spread across ~20 modules,
// which made whole-image coherence — ground against blade against canopy
// against the colour a shadow falls to — impossible to tune as one thing. They
// live here instead, alongside the band constants that drive the three-tone
// painted ramp in painterly.mjs.
//
// THREE-free, like chunkgen.js and vegdata.js, so the worker (which does not
// share the page's import map) can reach it through world.js.
//
// IMPORTANT: these are the renderer's working-space values, moved verbatim from
// their previous homes. Nothing here changes the current look on its own — the
// point of the module is that there is now one place to change it from.

// ── ground pigments, by biome ────────────────────────────────────────────────
// Sampled by groundColor() in world.js and written into terrain vertex colour.
export const GROUND = Object.freeze({
  deepSea:   Object.freeze([0.10, 0.16, 0.18]),
  shallows:  Object.freeze([0.55, 0.52, 0.38]),
  beach:     Object.freeze([0.76, 0.72, 0.59]),
  desert:    Object.freeze([0.77, 0.64, 0.42]),
  savanna:   Object.freeze([0.58, 0.52, 0.28]),
  jungle:    Object.freeze([0.20, 0.33, 0.13]),
  grassland: Object.freeze([0.40, 0.48, 0.24]),
  forest:    Object.freeze([0.29, 0.37, 0.18]),
  taiga:     Object.freeze([0.30, 0.36, 0.25]),
  tundra:    Object.freeze([0.48, 0.46, 0.36]),
  snow:      Object.freeze([0.90, 0.91, 0.94]),
  rock:      Object.freeze([0.44, 0.41, 0.38]),
});

// ── light pigments ───────────────────────────────────────────────────────────
// A shadow in a painted frame is a HUE change, not an absence of light. These
// are the colours value drifts toward at either end of the ramp.
export const LIGHT = Object.freeze({
  // cool blue at midday, drifting violet at the rims of the day (dawn/dusk)
  shadowDay: Object.freeze([0.25, 0.27, 0.38]),
  shadowLow: Object.freeze([0.32, 0.23, 0.43]),
  // the pigment a deep cave recess settles to instead of the lifted outdoor one
  shadowCave: Object.freeze([0.16, 0.19, 0.27]),
  // warm cream the lit band walks toward
  sunWarm: Object.freeze([1.00, 0.95, 0.84]),
  // hemispheric fill: cool from the sky, warm from the ground bounce
  ambSky: Object.freeze([0.62, 0.78, 0.90]),
  ambGround: Object.freeze([0.67, 0.61, 0.39]),
});

// ── meadow mosaic ────────────────────────────────────────────────────────────
// Ground pigment is varied toward a lusher or a drier tone by the SAME field
// the blades standing on it were planted from (groundMacroPatch in world.js,
// already carried per terrain vertex as aGroundMacro and per blade instance).
// Sharing the field rather than inventing a second one is the whole point: the
// ground mosaic then lines up exactly with the mosaic in the grass, instead of
// being an independent pattern that fights it.
//
// Both targets are applied at matched luminance, so this shifts hue only and
// cannot disturb the ramp's value structure.
export const MEADOW = Object.freeze({
  lush: Object.freeze([0.42, 0.60, 0.34]),   // cool deep green of the wet hollows
  dry: Object.freeze([0.85, 0.75, 0.45]),    // seed-head straw on exposed shoulders
  amount: 0.30,        // how far the mosaic may pull a pigment from its base
  strokeScale: 0.085,  // world-space frequency of the finer stroke band
  strokeAmount: 0.35,  // the stroke band's share of the dryness mix
});

// ── painted ramp constants ───────────────────────────────────────────────────
// Band edges sit where they do because a half-lambert wrap puts flat sunlit
// ground near 0.75 and a shadowed slope near 0.30, so the two edges below land
// one on either side of "in shadow but not black".
export const PAINT = Object.freeze({
  bandLow: 0.17,          // shade -> mid
  bandHigh: 0.58,         // mid -> lit
  softNear: 0.085,        // band width up close: a crisp brush edge
  softFar: 0.20,          // and at distance, where detail should go flat
  jitter: 0.055,          // world-space wobble on the band edge
  wrapScale: 0.62,        // half-lambert: ndl * wrapScale + wrapBias
  wrapBias: 0.46,
  shadowFloor: 0.34,      // how far down the ramp a fully shadowed pixel falls
  shadeMul: 0.62,         // value multiplier for the shade tone
  // How far the shade tone walks toward the shadow pigment. Small on purpose:
  // the walk matches LUMINANCE, so for a green-dominant ground pigment a blue
  // shadow pigment contributes far more blue chroma than the base ever had.
  // At 0.34 a dusk landscape came out neon blue. A hand-authored palette can
  // afford a big number here because it authors a green shadow tone directly;
  // a derived one has to stay near the pigment's own hue family.
  shadeHue: 0.12,
  litMul: 1.16,           // value multiplier for the lit tone
  litHue: 0.14,           // how far the lit tone walks toward sun warmth
  midSat: 1.06,           // midtones carry slightly more chroma than the base
  // How much of the ramp's CHROMA survives into the transfer applied over
  // Three's lighting. Value banding is the point; the hue shift is seasoning,
  // and at full strength it fights the post grade's own shadow pigment.
  transferChroma: 0.55,
});

const LUMA = [0.2126, 0.7152, 0.0722];

export function luminance(rgb) {
  return rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
}

// sRGB hex -> linear float triple, for pigments authored as hex elsewhere.
export function hexToLinear(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  const to = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return [to(((n >> 16) & 255) / 255), to(((n >> 8) & 255) / 255), to((n & 255) / 255)];
}

// Emits a GLSL vec3 literal. Kept to five decimals: more is noise, less shows
// up as banding in the sky gradient.
export function glslVec3(rgb) {
  return `vec3(${rgb[0].toFixed(5)},${rgb[1].toFixed(5)},${rgb[2].toFixed(5)})`;
}

// The palette as injectable GLSL constants. Every shader that paints gets the
// same block, so a pigment can never disagree between two materials.
export function paletteGlsl() {
  return `
const vec3 K_SHADOW_DAY = ${glslVec3(LIGHT.shadowDay)};
const vec3 K_SHADOW_LOW = ${glslVec3(LIGHT.shadowLow)};
const vec3 K_SUN_WARM   = ${glslVec3(LIGHT.sunWarm)};
const vec3 K_AMB_SKY    = ${glslVec3(LIGHT.ambSky)};
const vec3 K_AMB_GND    = ${glslVec3(LIGHT.ambGround)};
const float K_BAND_LOW    = ${PAINT.bandLow.toFixed(4)};
const float K_BAND_HIGH   = ${PAINT.bandHigh.toFixed(4)};
const float K_SOFT_NEAR   = ${PAINT.softNear.toFixed(4)};
const float K_SOFT_FAR    = ${PAINT.softFar.toFixed(4)};
const float K_JITTER      = ${PAINT.jitter.toFixed(4)};
const float K_WRAP_SCALE  = ${PAINT.wrapScale.toFixed(4)};
const float K_WRAP_BIAS   = ${PAINT.wrapBias.toFixed(4)};
const float K_SHADOW_FLOOR= ${PAINT.shadowFloor.toFixed(4)};
const float K_SHADE_MUL   = ${PAINT.shadeMul.toFixed(4)};
const float K_SHADE_HUE   = ${PAINT.shadeHue.toFixed(4)};
const float K_LIT_MUL     = ${PAINT.litMul.toFixed(4)};
const float K_LIT_HUE     = ${PAINT.litHue.toFixed(4)};
const float K_MID_SAT     = ${PAINT.midSat.toFixed(4)};
const float K_XFER_CHROMA = ${PAINT.transferChroma.toFixed(4)};
const vec3  K_MEADOW_LUSH = ${glslVec3(MEADOW.lush)};
const vec3  K_MEADOW_DRY  = ${glslVec3(MEADOW.dry)};
const float K_MEADOW_AMT  = ${MEADOW.amount.toFixed(4)};
const float K_MEADOW_FREQ = ${MEADOW.strokeScale.toFixed(4)};
const float K_MEADOW_STRK = ${MEADOW.strokeAmount.toFixed(4)};
const vec3  K_LUMA        = vec3(${LUMA[0]},${LUMA[1]},${LUMA[2]});
`;
}
