import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_READINESS_GATES,
  WORLD_LOAD_BUDGETS_MS,
  classifyCacheState,
  createMonotonicClock,
  createWorldLoadMetrics,
} from '../src/worldloadmetrics.mjs';

function completeGameLoad(metrics, { firstDrawAt = 80, usableAt = 100 } = {}) {
  for (const gate of ['terrain', 'water', 'collision']) {
    assert.equal(metrics.markGate(gate, { ready: true, at: firstDrawAt - 20 }).accepted, true);
  }
  assert.equal(metrics.markFirstDraw({ at: firstDrawAt, rendered: true, frameId: 1 }).accepted, true);
  return metrics.markUsable({ at: usableAt, controllable: true });
}

test('monotonic clock clamps a regressing source and stage timings never go negative', () => {
  const values = [10, 7, 14];
  const clock = createMonotonicClock(() => values.shift());
  assert.deepEqual([clock(), clock(), clock()], [10, 10, 14]);

  const metrics = createWorldLoadMetrics({
    navigationStart: 0,
    now: () => 0,
    cacheEvidence: { persistent: 'miss', source: 'test' },
  });
  metrics.startStage('scene-preparation', 20);
  const ended = metrics.endStage('scene-preparation', 12);
  assert.equal(ended.accepted, true);
  assert.equal(ended.stage.durationMs, 0);
  assert.ok(metrics.snapshot().diagnostics.some(({ code }) => code === 'clock-regression'));
  assert.ok(Object.values(metrics.snapshot().stages).every(stage =>
    stage.durationMs == null || stage.durationMs >= 0));
});

test('game acceptance stays unmeasured until every water, terrain, collision and draw gate plus controllability', () => {
  assert.deepEqual(REQUIRED_READINESS_GATES, ['terrain', 'water', 'collision', 'first-draw']);
  const metrics = createWorldLoadMetrics({
    navigationStart: 0,
    now: () => 0,
    cacheEvidence: { persistent: { misses: 25 }, source: 'test' },
  });
  assert.equal(metrics.evaluateBudget().measured, false);
  assert.equal(metrics.evaluateBudget().withinBudget, false);
  assert.equal(metrics.markFirstDraw({ at: 10, rendered: false }).accepted, false);
  assert.equal(metrics.markGate('first-draw', { ready: true, at: 10 }).accepted, false);
  assert.match(metrics.markUsable({ at: 20, controllable: true }).reason, /missing/);

  const result = completeGameLoad(metrics, { firstDrawAt: 80, usableAt: 100 });
  assert.equal(result.accepted, true);
  const report = metrics.snapshot();
  assert.equal(report.readiness.ready, true);
  assert.deepEqual(report.readiness.missing, []);
  assert.equal(report.firstDraw.observed, true);
  assert.equal(report.usable.controllable, true);
  assert.equal(report.usable.totalMs, 100);
  assert.equal(report.acceptance.status, 'pass');
  assert.equal(report.acceptance.budgetMs, WORLD_LOAD_BUDGETS_MS.cold);
  assert.equal(report.acceptance.measured, true);
});

test('a scene draw cannot claim a usable game before controls are actually available', () => {
  const metrics = createWorldLoadMetrics({
    navigationStart: 0,
    now: () => 0,
    cacheEvidence: { persistent: 'hit', source: 'persistent-test' },
  });
  for (const gate of ['terrain', 'water', 'collision']) metrics.markGate(gate, { at: 20 });
  metrics.markFirstDraw({ at: 30, rendered: true });
  assert.equal(metrics.markUsable({ at: 40, controllable: false }).accepted, false);
  assert.equal(metrics.snapshot().acceptance.measured, false);
  assert.equal(metrics.markUsable({ at: 50, controllable: true }).accepted, true);
  assert.equal(metrics.snapshot().acceptance.budgetMs, WORLD_LOAD_BUDGETS_MS.warm);
});

test('the warm acceptance limit is strict while the cold limit is inclusive', () => {
  const warm = createWorldLoadMetrics({
    navigationStart: 0,
    now: () => 0,
    cacheEvidence: { persistent: 'hit', source: 'persistent-test' },
  });
  completeGameLoad(warm, { firstDrawAt: 14_990, usableAt: WORLD_LOAD_BUDGETS_MS.warm });
  assert.equal(warm.evaluateBudget().status, 'fail');

  const cold = createWorldLoadMetrics({
    navigationStart: 0,
    now: () => 0,
    cacheEvidence: { persistent: 'miss', source: 'test' },
  });
  completeGameLoad(cold, { firstDrawAt: 34_990, usableAt: WORLD_LOAD_BUDGETS_MS.cold });
  assert.equal(cold.evaluateBudget().status, 'pass');
});

test('inspection scope reports its own benchmark readiness and cannot pass the game budget', () => {
  const metrics = createWorldLoadMetrics({
    scope: 'inspection',
    requiredGates: ['field', 'distant-scene', 'viewpoint', 'nearby-collision', 'first-draw'],
    navigationStart: 0,
    now: () => 0,
    cacheEvidence: { persistent: { hits: 25 }, source: 'persistent-test' },
  });
  for (const gate of ['field', 'distant-scene', 'viewpoint', 'nearby-collision']) {
    assert.equal(metrics.markGate(gate, { at: 40 }).accepted, true);
  }
  assert.equal(metrics.markFirstDraw({ at: 60, rendered: true }).accepted, true);
  assert.equal(metrics.markInspectionReady({ at: 70 }).accepted, true);
  assert.equal(metrics.markUsable({ at: 80, controllable: true }).accepted, false);
  const report = metrics.snapshot();
  assert.equal(report.inspection.measured, true);
  assert.equal(report.inspection.totalMs, 70);
  assert.equal(report.acceptance.status, 'out-of-scope');
  assert.equal(report.acceptance.withinBudget, false);
  assert.equal(report.acceptance.budgetMs, null);
});

test('cache evidence distinguishes cold, persistent warm, mixed and unknown states', () => {
  assert.equal(classifyCacheState({ persistent: { misses: 25 } }).classification, 'cold');
  assert.equal(classifyCacheState({ persistent: { hits: 25 } }).classification, 'warm');
  assert.equal(classifyCacheState({ persistent: { hits: 24, misses: 1 } }).classification, 'mixed');
  assert.equal(classifyCacheState({ persistent: 'unknown' }).classification, 'unknown');
  const memory = classifyCacheState({ memory: 'hit', memoryOnly: true });
  assert.equal(memory.classification, 'unknown');
  assert.equal(memory.memoryOnly, true);
  assert.equal(classifyCacheState({ cacheCleared: true }).classification, 'cold');
});

test('persistent cache reuse after a simulated browser restart is explicit and separately verifiable', () => {
  // A new tracker represents a new page/worker process. The evidence is
  // supplied by the test storage adapter; no global cache is deleted or used.
  const persisted = {
    source: 'test-persistent-storage',
    persistent: { hits: 25, misses: 0 },
    browserRestart: true,
    restartVerified: true,
  };
  const afterRestart = createWorldLoadMetrics({
    navigationStart: 0,
    now: () => 0,
    cacheEvidence: persisted,
  });
  assert.equal(afterRestart.snapshot().cache.classification, 'warm');
  completeGameLoad(afterRestart, { firstDrawAt: 100, usableAt: 120 });
  const acceptance = afterRestart.evaluateBudget({ requireRestart: true });
  assert.equal(acceptance.measured, true);
  assert.equal(acceptance.status, 'pass');
  assert.equal(acceptance.withinBudget, true);

  const unverified = createWorldLoadMetrics({
    navigationStart: 0,
    now: () => 0,
    cacheEvidence: { persistent: { hits: 25 }, source: 'persistent-test' },
  });
  completeGameLoad(unverified, { firstDrawAt: 100, usableAt: 120 });
  assert.equal(unverified.evaluateBudget({ requireRestart: true }).measured, false);
});

test('stage end without a start is diagnosed without inventing a duration', () => {
  const metrics = createWorldLoadMetrics({ navigationStart: 0, now: () => 0 });
  const result = metrics.endStage('validation', 10);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'stage-not-started');
  assert.equal(metrics.snapshot().stages.validation, undefined);
});

console.log('worldloadmetrics PASS · bounded stage timing · gated first draw · explicit cache classes');
