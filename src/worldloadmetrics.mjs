// Small, bounded instrumentation for the loading acceptance gate described in
// docs/mountain-watershed-plan.md.  The tracker stores one record per stage and
// readiness gate; it deliberately does not retain a frame or progress history.

export const WORLD_LOAD_METRICS_SCHEMA_VERSION = 1;

export const WORLD_LOAD_BUDGETS_MS = Object.freeze({
  cold: 35_000,
  warm: 15_000,
});

export const WORLD_LOAD_STAGES = Object.freeze([
  'navigation',
  'app-launch',
  'cache-read',
  'world-generation',
  'validation',
  'terrain',
  'water',
  'collision',
  'asset-upload',
  'first-draw',
  'usable',
]);

export const REQUIRED_READINESS_GATES = Object.freeze([
  'terrain',
  'water',
  'collision',
  'first-draw',
]);

export const CACHE_CLASSIFICATIONS = Object.freeze([
  'cold',
  'warm',
  'mixed',
  'unknown',
]);

const STAGE_ALIASES = Object.freeze({
  appLaunch: 'app-launch',
  app_start: 'app-launch',
  appstart: 'app-launch',
  cacheRead: 'cache-read',
  cacheread: 'cache-read',
  worldGeneration: 'world-generation',
  worldgeneration: 'world-generation',
  assetUpload: 'asset-upload',
  assetupload: 'asset-upload',
  waterPlanning: 'water-planning',
  waterplanning: 'water-planning',
  scenePreparation: 'scene-preparation',
  scenepreparation: 'scene-preparation',
  firstDraw: 'first-draw',
  firstdraw: 'first-draw',
});

const GATE_ALIASES = Object.freeze({
  firstDraw: 'first-draw',
  firstdraw: 'first-draw',
  terrainReady: 'terrain',
  terrainready: 'terrain',
  waterReady: 'water',
  waterready: 'water',
  collisionReady: 'collision',
  collisionready: 'collision',
  nearbyCollision: 'nearby-collision',
  nearbycollision: 'nearby-collision',
  distantScene: 'distant-scene',
  distantscene: 'distant-scene',
});

const CACHE_STATUS_ALIASES = Object.freeze({
  hit: 'hit',
  hits: 'hit',
  reused: 'hit',
  reuse: 'hit',
  warm: 'hit',
  miss: 'miss',
  misses: 'miss',
  generated: 'miss',
  regenerated: 'miss',
  cold: 'miss',
  invalid: 'invalid',
  invalidated: 'invalid',
  corrupt: 'invalid',
  stale: 'invalid',
  unknown: 'unknown',
});

const DEFAULT_MAX_DIAGNOSTICS = 32;

function fallbackNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function keyFor(value, aliases = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('World-load metric names cannot be empty');
  const compact = raw.replace(/[\s_]+/g, '-');
  const lower = compact.toLowerCase();
  return aliases[raw] || aliases[compact] || aliases[lower]
    || aliases[raw.replace(/[-]/g, '')]
    || lower;
}

function stageKey(value) {
  return keyFor(value, STAGE_ALIASES);
}

function gateKey(value) {
  return keyFor(value, GATE_ALIASES);
}

function statusKey(value) {
  if (typeof value === 'boolean') return value ? 'hit' : 'miss';
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  return CACHE_STATUS_ALIASES[raw] || 'unknown';
}

function copyDetails(value, depth = 0) {
  if (value == null || typeof value === 'string' || typeof value === 'number'
      || typeof value === 'boolean') return value;
  if (depth >= 2) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 8).map(item => copyDetails(item, depth + 1));
  if (typeof value !== 'object') return String(value);
  const result = {};
  for (const key of Object.keys(value).slice(0, 16)) result[key] = copyDetails(value[key], depth + 1);
  return result;
}

function readonly(value) {
  return value == null ? value : copyDetails(value);
}

/**
 * Return a monotonic clock wrapper around performance.now(), Date.now(), or a
 * test clock. A clock regression is clamped instead of producing a negative
 * stage or load duration.
 */
export function createMonotonicClock(source = fallbackNow) {
  if (typeof source !== 'function') throw new Error('World-load clock must be a function');
  let last = -Infinity;
  return () => {
    const value = finiteNumber(source());
    if (value == null) {
      if (!Number.isFinite(last)) last = 0;
      return last;
    }
    if (value < last) return last;
    last = value;
    return value;
  };
}

function addStatus(counts, value, amount = 1) {
  const status = statusKey(value);
  counts[status] += Math.max(0, Number(amount) || 0);
}

function addCountFields(counts, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let found = false;
  for (const [field, status] of [
    ['hits', 'hit'], ['hit', 'hit'], ['reused', 'hit'],
    ['misses', 'miss'], ['miss', 'miss'], ['generated', 'miss'],
    ['invalid', 'invalid'], ['invalidated', 'invalid'], ['corrupt', 'invalid'],
    ['unknown', 'unknown'],
  ]) {
    if (!(field in value)) continue;
    const amount = Number(value[field]);
    if (!Number.isFinite(amount) || amount < 0) continue;
    counts[status] += amount;
    found = true;
  }
  return found;
}

/**
 * Classify cache state from explicit evidence. In particular, `memory` hits
 * never become warm evidence: the plan requires a persisted cache that can be
 * reused after a browser restart. Callers that know a progress counter came
 * from persistent storage should pass it as `persistent` themselves.
 */
export function classifyCacheState(input = null) {
  const evidence = typeof input === 'string' ? { persistent: input } : input || {};
  const counts = { hit: 0, miss: 0, invalid: 0, unknown: 0 };
  const memory = { hit: 0, miss: 0, invalid: 0, unknown: 0 };
  let persistentEvidence = false;
  let memoryEvidence = false;
  let explicitCold = evidence.cold === true || evidence.cacheCleared === true
    || evidence.cleared === true || evidence.generationVersionChanged === true;
  let source = evidence.source || evidence.persistentSource || null;

  const persistentValue = evidence.persistent ?? evidence.persistentCache;
  if (persistentValue !== undefined && persistentValue !== null) {
    persistentEvidence = true;
    if (typeof persistentValue === 'object' && !Array.isArray(persistentValue)) {
      if (!addCountFields(counts, persistentValue)) {
        addStatus(counts, persistentValue.status ?? persistentValue.state ?? 'unknown');
      }
      if (persistentValue.source) source ||= persistentValue.source;
    } else addStatus(counts, persistentValue);
  } else if (['persistentHits', 'persistentMisses', 'persistentInvalid', 'persistentUnknown']
    .some(field => field in evidence)) {
    persistentEvidence = true;
    for (const [field, status] of [
      ['persistentHits', 'hit'], ['persistentMisses', 'miss'],
      ['persistentInvalid', 'invalid'], ['persistentUnknown', 'unknown'],
    ]) {
      const amount = Number(evidence[field]);
      if (Number.isFinite(amount) && amount >= 0) counts[status] += amount;
    }
  }

  if (Array.isArray(evidence.entries)) {
    for (const entry of evidence.entries.slice(0, 256)) {
      const entrySource = String(entry?.source || entry?.cache || '').toLowerCase();
      const target = entrySource === 'memory' || entrySource === 'memory-cache' ? memory : counts;
      if (target === memory) memoryEvidence = true;
      else persistentEvidence = true;
      addStatus(target, entry?.status ?? entry?.state ?? entry?.result ?? 'unknown');
      if (entry?.source && !source && target === counts) source = entry.source;
    }
  }

  if (evidence.memoryOnly === true) memoryEvidence = true;
  const memoryValue = evidence.memory;
  if (memoryValue !== undefined && memoryValue !== null) {
    memoryEvidence = true;
    if (!addCountFields(memory, memoryValue)) addStatus(memory, memoryValue);
  }
  if (evidence.memoryHit === true) { memoryEvidence = true; memory.hit++; }
  if (evidence.memoryMiss === true) { memoryEvidence = true; memory.miss++; }

  const restart = evidence.browserRestart ?? evidence.restart ?? evidence.afterRestart;
  const restartRequested = !!(restart === true || (restart && typeof restart === 'object')
    || evidence.restartVerified === true);
  const restartVerified = evidence.restartVerified === true || evidence.afterRestart === true
    || (restart && typeof restart === 'object' && restart.verified === true);
  const memoryOnly = evidence.memoryOnly === true
    || (!persistentEvidence && memoryEvidence && (memory.hit + memory.miss + memory.invalid + memory.unknown > 0));

  const known = counts.hit + counts.miss + counts.invalid;
  let classification = 'unknown';
  if (explicitCold && counts.hit === 0) classification = 'cold';
  else if (counts.hit > 0 && counts.miss === 0 && counts.invalid === 0 && counts.unknown === 0 && !memoryOnly) {
    classification = 'warm';
  } else if (counts.hit === 0 && (counts.miss > 0 || counts.invalid > 0) && counts.unknown === 0) {
    classification = 'cold';
  } else if (counts.hit > 0 && (counts.miss > 0 || counts.invalid > 0 || counts.unknown > 0)) {
    classification = 'mixed';
  } else if (known > 0 && counts.unknown > 0) {
    classification = 'mixed';
  }

  const basis = [];
  if (explicitCold) basis.push('cache was cleared or generation identity changed');
  if (counts.hit) basis.push(`${counts.hit} persistent hit${counts.hit === 1 ? '' : 's'}`);
  if (counts.miss) basis.push(`${counts.miss} persistent miss${counts.miss === 1 ? '' : 'es'}`);
  if (counts.invalid) basis.push(`${counts.invalid} invalid persistent entr${counts.invalid === 1 ? 'y' : 'ies'}`);
  if (counts.unknown) basis.push(`${counts.unknown} persistent entr${counts.unknown === 1 ? 'y is' : 'ies are'} unknown`);
  if (memoryOnly) basis.push('memory-only evidence');
  if (!basis.length) basis.push('no persistent cache evidence');

  return {
    classification,
    persistentHits: counts.hit,
    persistentMisses: counts.miss,
    persistentInvalid: counts.invalid,
    persistentUnknown: counts.unknown,
    persistentEvidence,
    workerFresh: evidence.workerFresh === true,
    cacheCleared: evidence.cacheCleared === true || evidence.cleared === true,
    generationVersionChanged: evidence.generationVersionChanged === true,
    memoryOnly,
    memoryHits: memory.hit,
    memoryMisses: memory.miss,
    restartRequested,
    restartVerified,
    source: source == null ? null : String(source),
    basis,
  };
}

function budgetFor(classification, scope, requireRestart, cache) {
  if (scope !== 'game') return null;
  if (classification === 'cold') return WORLD_LOAD_BUDGETS_MS.cold;
  if (classification === 'warm' && (!requireRestart || cache.restartVerified)) return WORLD_LOAD_BUDGETS_MS.warm;
  return null;
}

function stageSnapshot(stage) {
  return stage ? {
    name: stage.name,
    startedAt: stage.startedAt,
    endedAt: stage.endedAt,
    durationMs: stage.durationMs,
    ...(stage.details ? { details: readonly(stage.details) } : {}),
  } : null;
}

/**
 * Create one startup/load measurement. The default `game` scope is the only
 * scope eligible for the 35 s/15 s budgets. `inspection` is intended for the
 * overlook fixture and can record a benchmark-ready scene without claiming a
 * controllable full-game load.
 */
export function createWorldLoadMetrics({
  scope = 'game',
  requiredGates = REQUIRED_READINESS_GATES,
  now = fallbackNow,
  navigationStart = null,
  cacheEvidence = null,
  runId = null,
  maxDiagnostics = DEFAULT_MAX_DIAGNOSTICS,
} = {}) {
  if (scope !== 'game' && scope !== 'inspection') throw new Error(`Invalid world-load scope ${String(scope)}`);
  if (!Array.isArray(requiredGates) || !requiredGates.length) {
    throw new Error('World-load metrics require at least one readiness gate');
  }
  const required = [...new Set(requiredGates.map(gateKey))];
  const clock = createMonotonicClock(now);
  const diagnostics = [];
  const maxDiagValue = finiteNumber(maxDiagnostics);
  const maxDiag = Math.max(0, Math.floor(maxDiagValue == null ? DEFAULT_MAX_DIAGNOSTICS : maxDiagValue));
  let lastAt = finiteNumber(navigationStart);
  if (lastAt == null) lastAt = clock();
  const startAt = lastAt;
  const stages = new Map();
  const gates = new Map(required.map(name => [name, {
    name, ready: false, readyAt: null, evidence: null, reason: null,
  }]));
  let cache = classifyCacheState(cacheEvidence);
  let firstDrawAt = null;
  let firstDrawEvidence = null;
  let usableAt = null;
  let inspectionReadyAt = null;
  let usableControllable = null;

  stages.set('navigation', {
    name: 'navigation', startedAt: startAt, endedAt: null, durationMs: null,
  });

  const diagnostic = (code, detail = null) => {
    if (diagnostics.length >= maxDiag) return;
    diagnostics.push({ code, ...(detail == null ? {} : { detail: readonly(detail) }) });
  };

  const timestamp = (raw) => {
    let value = raw === undefined || raw === null ? clock() : finiteNumber(raw);
    if (value == null) {
      diagnostic('invalid-timestamp', raw);
      value = lastAt;
    }
    if (value < lastAt) {
      diagnostic('clock-regression', { received: value, clampedTo: lastAt });
      value = lastAt;
    }
    lastAt = value;
    return value;
  };

  const ensureStage = (name, at = undefined, details = null) => {
    const key = stageKey(name);
    const existing = stages.get(key);
    if (existing) return existing;
    const stage = { name: key, startedAt: timestamp(at), endedAt: null, durationMs: null };
    if (details != null) stage.details = copyDetails(details);
    stages.set(key, stage);
    return stage;
  };

  const startStage = (name, at = undefined, details = null) => {
    const key = stageKey(name);
    const existing = stages.get(key);
    if (existing) {
      if (existing.startedAt == null) existing.startedAt = timestamp(at);
      else if (at !== undefined && finiteNumber(at) != null && finiteNumber(at) < existing.startedAt) {
        diagnostic('stage-start-regression', { stage: key, received: at, kept: existing.startedAt });
      }
      if (details != null) existing.details = { ...(existing.details || {}), ...copyDetails(details) };
      return stageSnapshot(existing);
    }
    return stageSnapshot(ensureStage(key, at, details));
  };

  const endStage = (name, at = undefined, details = null) => {
    const key = stageKey(name);
    const stage = stages.get(key);
    if (!stage) {
      diagnostic('stage-ended-before-start', key);
      return { accepted: false, reason: 'stage-not-started', stage: key };
    }
    if (stage.endedAt != null) return { accepted: false, reason: 'stage-already-ended', stage: stageSnapshot(stage) };
    const endedAt = timestamp(at);
    stage.endedAt = Math.max(endedAt, stage.startedAt);
    stage.durationMs = Math.max(0, stage.endedAt - stage.startedAt);
    if (details != null) stage.details = { ...(stage.details || {}), ...copyDetails(details) };
    return { accepted: true, stage: stageSnapshot(stage) };
  };

  const markGate = (name, readyOrOptions = true) => {
    const key = gateKey(name);
    const options = readyOrOptions && typeof readyOrOptions === 'object'
      ? readyOrOptions : { ready: readyOrOptions };
    const readyValue = options.ready !== false;
    const state = gates.get(key) || { name: key, ready: false, readyAt: null, evidence: null, reason: null };
    gates.set(key, state);
    if (!readyValue) {
      if (state.ready) return { accepted: false, reason: 'readiness-cannot-regress', gate: readonly(state) };
      state.reason = options.reason == null ? null : String(options.reason);
      return { accepted: true, gate: readonly(state) };
    }
    const renderedEvidence = options.rendered === true || options.observed === true
      || options.evidence?.rendered === true || options.evidence?.observed === true;
    if (key === 'first-draw' && !renderedEvidence) {
      diagnostic('first-draw-without-render-evidence');
      return { accepted: false, reason: 'first-draw-requires-render-evidence', gate: readonly(state) };
    }
    if (state.ready) return { accepted: false, reason: 'gate-already-ready', gate: readonly(state) };
    state.ready = true;
    state.readyAt = timestamp(options.at);
    state.reason = options.reason == null ? null : String(options.reason);
    if (options.evidence != null) state.evidence = copyDetails(options.evidence);
    return { accepted: true, gate: readonly(state) };
  };

  const markFirstDraw = ({ at = undefined, rendered = false, observed = false, frameId = null, drawCalls = null, evidence = null } = {}) => {
    if (firstDrawAt != null) return { accepted: false, reason: 'first-draw-already-recorded', at: firstDrawAt };
    if (rendered !== true && observed !== true
        && evidence?.rendered !== true && evidence?.observed !== true) {
      diagnostic('first-draw-without-render-evidence');
      return { accepted: false, reason: 'first-draw-requires-render-evidence' };
    }
    const details = {
      ...(evidence == null ? {} : copyDetails(evidence)),
      rendered: rendered === true,
      observed: observed === true,
      ...(frameId == null ? {} : { frameId: copyDetails(frameId) }),
      ...(drawCalls == null ? {} : { drawCalls: finiteNumber(drawCalls) }),
    };
    const result = markGate('first-draw', { ready: true, at, rendered: true, evidence: details });
    if (!result.accepted) return result;
    firstDrawAt = result.gate.readyAt;
    firstDrawEvidence = details;
    startStage('first-draw', firstDrawAt);
    endStage('first-draw', firstDrawAt);
    return { accepted: true, at: firstDrawAt, evidence: readonly(details) };
  };

  const missingGates = () => required.filter(name => !gates.get(name)?.ready);

  const markUsable = ({ at = undefined, controllable = false } = {}) => {
    if (scope !== 'game') return { accepted: false, reason: 'inspection-scope-requires-markInspectionReady' };
    if (usableAt != null) return { accepted: false, reason: 'usable-already-recorded', at: usableAt };
    const missing = missingGates();
    if (missing.length) return { accepted: false, reason: 'missing-readiness-gates', missing };
    if (controllable !== true) return { accepted: false, reason: 'controllable-scene-required', missing: [] };
    usableAt = timestamp(at);
    usableControllable = true;
    startStage('usable', usableAt);
    endStage('usable', usableAt);
    return { accepted: true, at: usableAt, totalMs: usableAt - startAt };
  };

  const markInspectionReady = ({ at = undefined } = {}) => {
    if (scope !== 'inspection') return { accepted: false, reason: 'game-scope-requires-markUsable' };
    if (inspectionReadyAt != null) return { accepted: false, reason: 'inspection-ready-already-recorded', at: inspectionReadyAt };
    const missing = missingGates();
    if (missing.length) return { accepted: false, reason: 'missing-readiness-gates', missing };
    inspectionReadyAt = timestamp(at);
    startStage('inspection-ready', inspectionReadyAt);
    endStage('inspection-ready', inspectionReadyAt);
    return { accepted: true, at: inspectionReadyAt, totalMs: inspectionReadyAt - startAt };
  };

  const setCacheEvidence = (evidence) => {
    cache = classifyCacheState(evidence);
    return readonly(cache);
  };

  const evaluateBudget = ({ requireRestart = false } = {}) => {
    const budgetMs = budgetFor(cache.classification, scope, requireRestart, cache);
    const totalMs = usableAt == null ? null : Math.max(0, usableAt - startAt);
    const measured = scope === 'game' && totalMs != null && budgetMs != null;
    let status = 'unmeasured';
    let reason = null;
    if (scope !== 'game') { status = 'out-of-scope'; reason = 'inspection measurements do not claim the game budget'; }
    else if (cache.classification === 'unknown' || cache.classification === 'mixed') reason = 'cache classification is not a pure cold or persistent-warm run';
    else if (requireRestart && cache.classification === 'warm' && !cache.restartVerified) reason = 'persistent reuse after browser restart is unverified';
    else if (usableAt == null) reason = 'usable controllable scene has not been recorded';
    else if (budgetMs == null) reason = 'no acceptance budget applies';
    if (measured) {
      // Cold generation has an inclusive 35 s allowance. The subsequent-load
      // requirement is explicitly strict: exactly 15 s is still an overrun.
      const within = cache.classification === 'warm'
        ? totalMs < budgetMs : totalMs <= budgetMs;
      status = within ? 'pass' : 'fail';
    }
    return {
      scope,
      classification: cache.classification,
      totalMs,
      budgetMs,
      measured,
      status,
      withinBudget: measured && status === 'pass',
      ...(reason ? { reason } : {}),
      ...(requireRestart ? { requireRestart } : {}),
    };
  };

  const snapshot = ({ requireRestart = false } = {}) => {
    const stageOutput = Object.fromEntries([...stages].map(([name, stage]) => [name, stageSnapshot(stage)]));
    const gateOutput = Object.fromEntries([...gates].map(([name, gate]) => [name, readonly(gate)]));
    const acceptance = evaluateBudget({ requireRestart });
    return {
      schemaVersion: WORLD_LOAD_METRICS_SCHEMA_VERSION,
      kind: 'world-load',
      runId: runId == null ? null : String(runId),
      scope,
      startedAt: startAt,
      lastAt,
      appLaunchAt: stages.get('app-launch')?.startedAt ?? null,
      stages: stageOutput,
      readiness: {
        required: [...required],
        gates: gateOutput,
        missing: missingGates(),
        ready: missingGates().length === 0,
      },
      firstDraw: {
        at: firstDrawAt,
        observed: firstDrawAt != null,
        evidence: readonly(firstDrawEvidence),
      },
      usable: {
        at: usableAt,
        controllable: usableControllable === true,
        totalMs: usableAt == null ? null : Math.max(0, usableAt - startAt),
      },
      inspection: scope === 'inspection' ? {
        readyAt: inspectionReadyAt,
        totalMs: inspectionReadyAt == null ? null : Math.max(0, inspectionReadyAt - startAt),
        measured: inspectionReadyAt != null,
      } : null,
      cache: readonly(cache),
      acceptance,
      diagnostics: readonly(diagnostics),
    };
  };

  return {
    scope,
    startAt,
    requiredGates: [...required],
    startStage,
    endStage,
    markGate,
    markFirstDraw,
    markUsable,
    markInspectionReady,
    setCacheEvidence,
    evaluateBudget,
    snapshot,
  };
}
