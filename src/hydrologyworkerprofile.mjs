// Regional planning telemetry is intentionally small and fixed-shape. The
// profile is diagnostic metadata; it must never become part of the water-plan
// identity or affect generation and arbitration.
export const REGIONAL_WINDOW_PROFILE_PHASES = Object.freeze([
  'cache-read', 'generation', 'cache-write', 'finalization', 'encoding',
]);

export const REGIONAL_WINDOW_PROFILE_MAX_MS = 3_600_000;
export const REGIONAL_WINDOW_PROFILE_MAX_SAMPLES = 25;

export function createRegionalWindowProfile() {
  return {
    phaseMs: Object.fromEntries(REGIONAL_WINDOW_PROFILE_PHASES.map(name => [name, 0])),
    samples: 0,
  };
}

export function recordRegionalWindowPhase(profile, name, durationMs) {
  if (!profile || !Object.prototype.hasOwnProperty.call(profile.phaseMs || {}, name)) return;
  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration < 0) return;
  const current = Number(profile.phaseMs[name]);
  profile.phaseMs[name] = Math.min(REGIONAL_WINDOW_PROFILE_MAX_MS,
    Math.max(0, Number.isFinite(current) ? current : 0) + duration);
  profile.samples = Math.min(REGIONAL_WINDOW_PROFILE_MAX_SAMPLES,
    Math.max(0, Number(profile.samples) || 0) + 1);
}

export function snapshotRegionalWindowProfile(profile) {
  const source = profile || createRegionalWindowProfile();
  const phaseMs = Object.fromEntries(REGIONAL_WINDOW_PROFILE_PHASES.map(name => {
    const value = Number(source.phaseMs?.[name]);
    return [name, Number.isFinite(value) && value >= 0
      ? Math.min(REGIONAL_WINDOW_PROFILE_MAX_MS, value) : 0];
  }));
  const sampleCount = Number(source.samples);
  return {
    phaseMs,
    samples: Number.isFinite(sampleCount) && sampleCount >= 0
      ? Math.min(REGIONAL_WINDOW_PROFILE_MAX_SAMPLES, sampleCount) : 0,
  };
}
