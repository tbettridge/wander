// Pure painterly material policy for cave geology. The WebGL shader consumes
// these palettes, while tests can audit contrast and identity without Three.js.

// Linear-output luminance floor used only once the camera is substantially
// underground. This is deliberately above the darkest fog palette so no
// normal, fracture, wetness or value-grouping combination can produce an
// isolated black wall patch.
export const CAVE_INTERIOR_MIN_LUMINANCE = 0.030;

export function caveInteriorLuminanceFloor(interiorFactor) {
  const t = Math.max(0, Math.min(1, (interiorFactor - 0.46) / (0.92 - 0.46)));
  const eased = t * t * (3 - 2 * t);
  return CAVE_INTERIOR_MIN_LUMINANCE * eased;
}

export const CAVE_MATERIAL_PALETTES = Object.freeze({
  limestone: Object.freeze({
    dark: [0.055, 0.067, 0.066], mid: [0.255, 0.285, 0.250], light: [0.455, 0.445, 0.345],
    sediment: [0.315, 0.245, 0.145], mineral: [0.185, 0.385, 0.350], wet: [0.035, 0.105, 0.105],
    strata: 1.55, mineralStrength: 0.68, fractureStrength: 0.55, crystal: 0.05,
  }),
  cathedral: Object.freeze({
    dark: [0.045, 0.055, 0.075], mid: [0.225, 0.250, 0.285], light: [0.455, 0.430, 0.330],
    sediment: [0.285, 0.220, 0.145], mineral: [0.245, 0.390, 0.420], wet: [0.035, 0.090, 0.115],
    strata: 1.18, mineralStrength: 0.78, fractureStrength: 0.46, crystal: 0.10,
  }),
  boulder: Object.freeze({
    dark: [0.060, 0.055, 0.047], mid: [0.285, 0.245, 0.195], light: [0.495, 0.400, 0.265],
    sediment: [0.355, 0.235, 0.115], mineral: [0.305, 0.330, 0.265], wet: [0.060, 0.075, 0.065],
    strata: 0.72, mineralStrength: 0.38, fractureStrength: 1.05, crystal: 0.02,
  }),
  grotto: Object.freeze({
    dark: [0.025, 0.055, 0.058], mid: [0.125, 0.260, 0.235], light: [0.315, 0.430, 0.315],
    sediment: [0.245, 0.205, 0.115], mineral: [0.105, 0.445, 0.405], wet: [0.015, 0.105, 0.125],
    strata: 0.92, mineralStrength: 0.72, fractureStrength: 0.36, crystal: 0.08,
  }),
  fracture: Object.freeze({
    dark: [0.035, 0.043, 0.060], mid: [0.175, 0.205, 0.255], light: [0.385, 0.390, 0.385],
    sediment: [0.255, 0.185, 0.120], mineral: [0.225, 0.405, 0.500], wet: [0.025, 0.075, 0.115],
    strata: 2.15, mineralStrength: 0.88, fractureStrength: 1.12, crystal: 0.12,
  }),
  ice: Object.freeze({
    dark: [0.035, 0.075, 0.120], mid: [0.190, 0.360, 0.475], light: [0.620, 0.775, 0.825],
    sediment: [0.185, 0.275, 0.315], mineral: [0.350, 0.690, 0.780], wet: [0.035, 0.165, 0.245],
    strata: 0.55, mineralStrength: 0.70, fractureStrength: 0.70, crystal: 0.72,
  }),
  volcanic: Object.freeze({
    dark: [0.028, 0.020, 0.018], mid: [0.155, 0.105, 0.082], light: [0.335, 0.205, 0.115],
    sediment: [0.235, 0.115, 0.055], mineral: [0.620, 0.205, 0.055], wet: [0.050, 0.035, 0.030],
    strata: 0.42, mineralStrength: 0.76, fractureStrength: 0.76, crystal: 0.16,
  }),
});

export function caveMaterialPalette(geology = 'limestone') {
  return CAVE_MATERIAL_PALETTES[geology] || CAVE_MATERIAL_PALETTES.limestone;
}

export function cavePaletteSignature(geology = 'limestone') {
  const palette = caveMaterialPalette(geology);
  return [palette.dark, palette.mid, palette.light, palette.sediment, palette.mineral, palette.wet]
    .flat().map((value) => Math.round(value * 1000)).join(':');
}
