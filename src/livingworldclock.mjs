export const LIVING_WORLD_CLOCK_VERSION = 1;

export function createLivingWorldClock({ activeSeconds = 0, worldHours = 0 } = {}) {
  return {
    version: LIVING_WORLD_CLOCK_VERSION,
    activeSeconds: finiteNonNegative(activeSeconds),
    worldHours: finiteNonNegative(worldHours),
  };
}

export function normalizeLivingWorldClock(value) {
  return createLivingWorldClock(value && typeof value === 'object' ? value : {});
}

export function advanceLivingWorldClock(clock, {
  dt = 0,
  hours = 0,
  active = true,
} = {}) {
  if (!active) return clock;
  clock.activeSeconds += finiteNonNegative(dt);
  clock.worldHours += finiteNonNegative(hours);
  return clock;
}

export function snapshotLivingWorldClock(clock) {
  const normalized = normalizeLivingWorldClock(clock);
  return {
    activeSeconds: normalized.activeSeconds,
    worldHours: normalized.worldHours,
  };
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}
