export const DEFAULT_ASSEMBLY_MAX_CHUNKS = 1;
export const DEFAULT_ASSEMBLY_BUDGET_MS = 3.0;
export const DEFAULT_GENERATION_MAX_PENDING = 8;
export const DEFAULT_GENERATION_MAX_READY_BYTES = 32 * 1024 * 1024;

export function terrainDispatchCapacity({ ready = 0, inFlight = 0, readyBytes = 0 } = {}) {
  if (readyBytes >= DEFAULT_GENERATION_MAX_READY_BYTES) return 0;
  return Math.max(0, DEFAULT_GENERATION_MAX_PENDING - ready - inFlight);
}

export function canContinueAssembly({
  assembled,
  examined,
  elapsedMs,
  maxChunks = DEFAULT_ASSEMBLY_MAX_CHUNKS,
  budgetMs = DEFAULT_ASSEMBLY_BUDGET_MS,
}) {
  if (assembled >= maxChunks) return false;
  // Always inspect at least one result. A chunk cannot be split safely between
  // frames yet, but stale results are cheap and may be skipped within budget.
  return examined === 0 || elapsedMs < budgetMs;
}
