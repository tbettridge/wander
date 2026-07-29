// Standalone WebXR presentation profiles. These are deliberately separate
// from quality.js: desktop tiers describe world complexity and the post
// pipeline, while XR profiles describe the headset framebuffer/session.

export const XR_PROFILE_STORAGE_KEY = 'wander.xrProfile';
export const DEFAULT_XR_PROFILE = 'painterly';

export const XR_PROFILES = Object.freeze({
  painterly: Object.freeze({
    name: 'painterly',
    label: 'Painterly',
    description: 'Quest-oriented clarity with richer grass and gentler peripheral savings than Survival.',
    worldTier: 'high',
    framebufferScale: 0.75,
    foveation: 0.80,
    preferredFrameRate: 72,
    grassPatchRadius: 1,
    grassBladeBudget: 1500,
    grassGrowNear: 34,
    grassGrowFar: 60,
    grassMidStart: 22,
    grassMidEnd: 118,
    grassMidBladeBudget: 90000,
    grassFarEnd: 190,
    shadowSize: 256,
    shadowHz: 6,
    shadowRange: 72,
  }),
  survival: Object.freeze({
    name: 'survival',
    label: 'Survival',
    description: 'Lower eye-buffer cost and stronger peripheral savings for thermally limited headsets.',
    worldTier: 'high',
    framebufferScale: 0.70,
    foveation: 0.90,
    preferredFrameRate: 72,
    grassPatchRadius: 1,
    grassBladeBudget: 950,
    grassGrowNear: 30,
    grassGrowFar: 52,
    grassMidStart: 20,
    grassMidEnd: 100,
    grassMidBladeBudget: 60000,
    grassFarEnd: 170,
    shadowSize: 256,
    shadowHz: 6,
    shadowRange: 62,
  }),
});

export function normalizeXRProfileName(name) {
  return Object.hasOwn(XR_PROFILES, name) ? name : DEFAULT_XR_PROFILE;
}

export function xrProfileForName(name) {
  return XR_PROFILES[normalizeXRProfileName(name)];
}

export function normalizedSupportedFrameRates(frameRates) {
  if (!frameRates || typeof frameRates[Symbol.iterator] !== 'function') return [];
  return [...new Set(Array.from(frameRates)
    .map(Number)
    .filter((rate) => Number.isFinite(rate) && rate > 0))]
    .sort((a, b) => a - b);
}

// Prefer the requested refresh exactly. If it is absent, preserve the comfort
// floor by choosing the lowest supported rate above it; only fall below when
// the device offers no rate at or above the preference.
export function chooseXRFrameRate(frameRates, preferredFrameRate = 72) {
  const supported = normalizedSupportedFrameRates(frameRates);
  if (!supported.length) return null;
  const exact = supported.find((rate) => Math.abs(rate - preferredFrameRate) < 0.1);
  if (exact != null) return exact;
  return supported.find((rate) => rate > preferredFrameRate) ?? supported.at(-1);
}

export function xrFrameBudgetMs(frameRate) {
  return Number.isFinite(frameRate) && frameRate > 0 ? 1000 / frameRate : Infinity;
}

// Convert one observed display-frame interval into the number of refresh slots
// that were probably missed. Rounding tolerates ordinary compositor jitter.
export function missedXRFrames(intervalSeconds, frameRate) {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0
      || !Number.isFinite(frameRate) || frameRate <= 0) return 0;
  return Math.max(0, Math.round(intervalSeconds * frameRate) - 1);
}
