const VALID_OVERRIDES = new Set([0, 2, 4]);

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
