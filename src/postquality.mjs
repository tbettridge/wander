const VALID_OVERRIDES = new Set([0, 2, 4]);

export const DESKTOP_LANTERN_GRADE = Object.freeze({
  proximityScale: 14,
  proximityDecay: 1.7,
  signalStart: 0.001,
  signalFull: 0.035,
  hueSignalStart: 0.0002,
  hueSignalFull: 0.006,
});

// Hoshi-style policy: let FXAA carry the inexpensive tiers, retain a modest
// multisample resolve on the foliage-heavy high tiers, and keep 4x only as an
// explicit comparison against WANDER's former default.
export function msaaSamplesForTier(tierName) {
  return tierName === 'high' || tierName === 'ultra' ? 2 : 0;
}

export function resolveMsaaSamples(tierName, override = 'auto') {
  if (override === 'auto' || override == null) return msaaSamplesForTier(tierName);
  const samples = Number(override);
  return VALID_OVERRIDES.has(samples) ? samples : msaaSamplesForTier(tierName);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function smoothstep01(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

// Desktop's painterly grade normally deepens and groups shadows after ACES.
// A carried light needs its low-energy tail left continuous, so expose a
// smooth protection amount only while both underground and meaningfully lit.
export function desktopLanternGradeProtection(
  lanternIntensity,
  referenceIntensity = 4.2,
) {
  const normalized = clamp01(
    Number(lanternIntensity) / Math.max(0.001, Number(referenceIntensity) || 4.2),
  );
  const ignition = smoothstep01((normalized - 0.04) / 0.28);
  return ignition;
}

export function desktopLanternPixelProtection(
  localLight,
  viewDistance,
  luminance,
  options = DESKTOP_LANTERN_GRADE,
) {
  const distance = Math.max(0, Number(viewDistance) || 0);
  const scale = Math.max(0.001, Number(options.proximityScale) || 14);
  const decay = Math.max(0.1, Number(options.proximityDecay) || 1.7);
  const proximity = 1 / (1 + Math.pow(distance / scale, decay));
  const signalSpan = Math.max(0.0001, options.signalFull - options.signalStart);
  const signal = smoothstep01((Number(luminance) - options.signalStart) / signalSpan);
  return clamp01(localLight) * proximity * signal;
}
