const clamp01 = (value) => Math.max(0, Math.min(1, value));

// Three r185's Sky addon emits the solar disc as raw linear HDR. Wander's
// bloom was tuned against r165, whose Sky shader applied a strong shoulder
// curve before the disc reached the composer. Keep the modern linear sky, but
// trim only that tiny HDR source so the surrounding landscape retains detail.
export const MODERN_SKY_SUN_DISC = Object.freeze({
  highSunGain: 0.002,
  horizonGain: 0.009,
  horizonWidth: 0.16,
  overcastFloor: 0.18,
  hdrShoulder: 0.8,
  hdrKnee: 0.75,
  nightToePower: 0.55,
  nightToeStrength: 0.78,
});

export function modernSkySunDiscGain(sunElevation, sunVisibility = 1) {
  const elevation = Number.isFinite(sunElevation) ? sunElevation : 0;
  const width = MODERN_SKY_SUN_DISC.horizonWidth;
  const horizon = Math.exp(-(elevation * elevation) / (2 * width * width));
  const clearGain = MODERN_SKY_SUN_DISC.highSunGain
    + (MODERN_SKY_SUN_DISC.horizonGain - MODERN_SKY_SUN_DISC.highSunGain) * horizon;
  const visibility = clamp01(Number.isFinite(sunVisibility) ? sunVisibility : 1);
  return clearGain * (MODERN_SKY_SUN_DISC.overcastFloor
    + (1 - MODERN_SKY_SUN_DISC.overcastFloor) * visibility);
}

export function modernSkyHighlightShoulder(value) {
  const linear = Math.max(0, Number.isFinite(value) ? value : 0);
  const excess = Math.max(0, linear - MODERN_SKY_SUN_DISC.hdrKnee);
  return linear / (1 + excess * MODERN_SKY_SUN_DISC.hdrShoulder);
}

export function modernSkyNightToe(value, nightAmount = 1) {
  const linear = Math.max(0, Number.isFinite(value) ? value : 0);
  const night = clamp01(Number.isFinite(nightAmount) ? nightAmount : 1);
  const lifted = Math.pow(linear, MODERN_SKY_SUN_DISC.nightToePower);
  return linear + (lifted - linear) * night * MODERN_SKY_SUN_DISC.nightToeStrength;
}
