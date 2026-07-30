import assert from 'node:assert/strict';
import {
  QUEST_BENCHMARK_STORAGE_KEY,
  QuestBenchmarkRunner,
  aggregateQuestBenchmarkResults,
  summarizeQuestBenchmarkFrames,
} from '../src/xrbenchmark.mjs';

const frames = Array.from({ length: 72 }, (_, index) => ({
  intervalSeconds: 1 / 72,
  cpuMs: 3 + (index % 4) * 0.1,
  gpuMs: 5 + Math.floor(index / 12) * 0.1,
  gpuSampleSerial: Math.floor(index / 12),
  drawCalls: 70 + (index % 3),
  triangles: 100000 + index * 10,
  runtimeStage: index < 36 ? 'Full' : 'Assisted',
  sampleElapsedSeconds: (index + 1) / 72,
}));
const summary = summarizeQuestBenchmarkFrames(frames, 72);
assert.equal(summary.frameCount, 72);
assert.equal(summary.averageFps, 72);
assert.equal(summary.missedFrames, 0);
assert.equal(summary.gpuMs.samples, 6);
assert.deepEqual(summary.runtimeStages.map((entry) => entry.stage), ['Full', 'Assisted']);
assert.equal(aggregateQuestBenchmarkResults([
  { id: 'a', label: 'A', averageFps: 30, missedPercent: 10, frameMs: { p50: 30, p95: 40 }, cpuMs: { p50: 12 }, render: { averageDrawCalls: 100, averageTriangles: 1000 } },
  { id: 'a', label: 'A', averageFps: 35, missedPercent: 8, frameMs: { p50: 28, p95: 38 }, cpuMs: { p50: 11 }, render: { averageDrawCalls: 90, averageTriangles: 900 } },
]).at(0).samples, 2);

const values = new Map();
const storage = {
  getItem: (key) => values.get(key) || null,
  setItem: (key, value) => values.set(key, value),
};
const prepared = [];
let readinessChecks = 0;
let controlsStarted = 0;
let controlsEnded = 0;
const runner = new QuestBenchmarkRunner({
  scenes: [
    { id: 'a', label: 'Scene A', settleSeconds: 0 },
    { id: 'b', label: 'Scene B', settleSeconds: 0 },
  ],
  prepareScene: (scene) => prepared.push(scene.id),
  canRun: () => true,
  isSceneReady: () => ++readinessChecks >= 3,
  beginControlledRun: () => { controlsStarted++; return { locked: true }; },
  endControlledRun: (token) => {
    controlsEnded++;
    assert.equal(token?.locked, true);
  },
  context: () => ({ profile: 'painterly' }),
  storage,
  warmupSeconds: 0,
  sampleSeconds: 0.25,
  repetitions: 2,
});
assert.equal(runner.startSuite(), true);
await Promise.resolve();
for (let i = 0; i < 180 && runner.running; i++) {
  runner.tick(0.05, {
    cpuMs: 3,
    gpuMs: 5,
    gpuSampleSerial: i,
    drawCalls: 80,
    triangles: 120000,
    refreshRate: 72,
    runtimeStage: 'Full',
  });
  await Promise.resolve();
}
assert.deepEqual(prepared, ['a', 'b', 'a', 'b']);
assert.equal(runner.running, false);
assert.equal(runner.lastReport.schemaVersion, 2);
assert.equal(runner.lastReport.results.length, 4);
assert.equal(runner.lastReport.results[0].frameCount, 5);
assert.equal(runner.lastReport.results[0].settle.streamReady, true);
assert.equal(runner.lastReport.aggregates[0].samples, 2);
assert.equal(controlsStarted, 1);
assert.equal(controlsEnded, 1);
assert.ok(values.has(QUEST_BENCHMARK_STORAGE_KEY));

const blocked = new QuestBenchmarkRunner({ canRun: () => false, storage: null });
assert.equal(blocked.startSuite(), false);
assert.match(blocked.debug.status, /immersive XR/);

console.log('xrbenchmark PASS · deterministic phases · unique GPU samples · persisted scene report');
