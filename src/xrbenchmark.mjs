import { missedXRFrames } from './xrprofiles.mjs';

export const QUEST_BENCHMARK_STORAGE_KEY = 'wander.questBenchmark.latest';

export const QUEST_BENCHMARK_SCENES = Object.freeze([
  Object.freeze({ id: 'dense-meadow', label: 'Dense meadow', settleSeconds: 8 }),
  Object.freeze({ id: 'storm-water', label: 'Storm / water', settleSeconds: 10 }),
  Object.freeze({ id: 'station-train', label: 'Station / train', settleSeconds: 10 }),
  Object.freeze({ id: 'cave-lantern', label: 'Cave / lantern', settleSeconds: 12 }),
]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function percentile(values, amount) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * amount)));
  return sorted[index];
}

function average(values) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function rounded(value, digits = 2) {
  return +finite(value).toFixed(digits);
}

export function summarizeQuestBenchmarkFrames(frames, refreshRate) {
  const intervals = frames.map((frame) => finite(frame.intervalSeconds) * 1000);
  const cpu = frames.map((frame) => finite(frame.cpuMs));
  const drawCalls = frames.map((frame) => finite(frame.drawCalls));
  const triangles = frames.map((frame) => finite(frame.triangles));
  const gpu = [];
  let lastGpuSerial = null;
  for (const frame of frames) {
    const serial = finite(frame.gpuSampleSerial, -1);
    const gpuMs = finite(frame.gpuMs);
    if (gpuMs > 0 && serial !== lastGpuSerial) {
      gpu.push(gpuMs);
      lastGpuSerial = serial;
    }
  }

  const durationSeconds = intervals.reduce((total, value) => total + value, 0) / 1000;
  let missedFrames = 0;
  let displaySlots = 0;
  if (refreshRate > 0) {
    for (const frame of frames) {
      const missed = missedXRFrames(finite(frame.intervalSeconds), refreshRate);
      missedFrames += missed;
      displaySlots += missed + 1;
    }
  }
  const missedPercent = displaySlots ? missedFrames / displaySlots * 100 : 0;
  const runtimeStages = [];
  for (const frame of frames) {
    const stage = frame.runtimeStage || 'unknown';
    if (runtimeStages.at(-1)?.stage !== stage) {
      runtimeStages.push({
        stage,
        atSeconds: rounded(frame.sampleElapsedSeconds || 0),
      });
    }
  }

  return {
    durationSeconds: rounded(durationSeconds),
    frameCount: frames.length,
    refreshRate: rounded(refreshRate, 1),
    averageFps: rounded(durationSeconds > 0 ? frames.length / durationSeconds : 0),
    missedFrames,
    missedPercent: rounded(missedPercent),
    frameMs: {
      p50: rounded(percentile(intervals, 0.50)),
      p95: rounded(percentile(intervals, 0.95)),
      p99: rounded(percentile(intervals, 0.99)),
      worst: rounded(Math.max(0, ...intervals)),
    },
    cpuMs: {
      average: rounded(average(cpu)),
      p50: rounded(percentile(cpu, 0.50)),
      p95: rounded(percentile(cpu, 0.95)),
      p99: rounded(percentile(cpu, 0.99)),
      worst: rounded(Math.max(0, ...cpu)),
    },
    gpuMs: gpu.length ? {
      samples: gpu.length,
      average: rounded(average(gpu)),
      p50: rounded(percentile(gpu, 0.50)),
      p95: rounded(percentile(gpu, 0.95)),
      worst: rounded(Math.max(0, ...gpu)),
    } : null,
    render: {
      averageDrawCalls: rounded(average(drawCalls), 1),
      p95DrawCalls: Math.round(percentile(drawCalls, 0.95)),
      maxDrawCalls: Math.round(Math.max(0, ...drawCalls)),
      averageTriangles: Math.round(average(triangles)),
      p95Triangles: Math.round(percentile(triangles, 0.95)),
      maxTriangles: Math.round(Math.max(0, ...triangles)),
    },
    runtimeStages,
  };
}

export class QuestBenchmarkRunner {
  constructor({
    scenes = QUEST_BENCHMARK_SCENES,
    prepareScene = () => {},
    canRun = () => true,
    context = () => ({}),
    storage,
    warmupSeconds = 5,
    sampleSeconds = 20,
  } = {}) {
    this.scenes = scenes.map((scene) => ({ ...scene }));
    this.prepareScene = prepareScene;
    this.canRun = canRun;
    this.context = context;
    if (storage === undefined) {
      try { storage = globalThis.localStorage; } catch (error) { storage = null; }
    }
    this.storage = storage;
    this.onComplete = null;
    this.running = false;
    this.phase = 'idle';
    this.phaseElapsed = 0;
    this.queue = [];
    this.currentScene = null;
    this.frames = [];
    this.results = [];
    this.runStartedAt = null;
    this._statusBucket = -1;
    this.lastReport = this._loadReport();
    this.debug = {
      warmupSeconds,
      sampleSeconds,
      scene: scenes[0]?.id || '',
      status: this.lastReport ? 'previous report available' : 'idle',
      latest: this.lastReport ? this._reportLabel(this.lastReport) : 'none',
      runSuite: () => this.startSuite(),
      runScene: () => this.startScene(this.debug.scene),
      stop: () => this.stop('stopped by user'),
      download: () => this.downloadLatest(),
    };
  }

  _loadReport() {
    try {
      const value = this.storage?.getItem(QUEST_BENCHMARK_STORAGE_KEY);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      return null;
    }
  }

  _reportLabel(report) {
    return `${report.results?.length || 0} scene(s) · ${report.completedAt || 'incomplete'}`;
  }

  _begin(ids) {
    if (this.running) this.stop('restarted');
    if (!this.canRun()) {
      this.debug.status = 'enter an immersive XR session first';
      return false;
    }
    this.queue = ids.map((id) => this.scenes.find((scene) => scene.id === id)).filter(Boolean);
    if (!this.queue.length) {
      this.debug.status = 'no benchmark scene selected';
      return false;
    }
    this.running = true;
    this.results = [];
    this.runStartedAt = new Date().toISOString();
    this.runContext = this.context();
    this._prepareNext();
    return true;
  }

  startSuite() {
    return this._begin(this.scenes.map((scene) => scene.id));
  }

  startScene(id) {
    return this._begin([id]);
  }

  _prepareNext() {
    this.currentScene = this.queue.shift() || null;
    if (!this.currentScene) {
      this._finish();
      return;
    }
    this.phase = 'preparing';
    this.phaseElapsed = 0;
    this._statusBucket = -1;
    this.frames = [];
    this.debug.status = `${this.currentScene.label} · preparing`;
    let prepared;
    try {
      prepared = this.prepareScene(this.currentScene);
    } catch (error) {
      this._failScene(error);
      return;
    }
    Promise.resolve(prepared).then(() => {
      if (!this.running || this.phase !== 'preparing') return;
      this.phase = 'settling';
      this.phaseElapsed = 0;
      this._statusBucket = -1;
    }).catch((error) => this._failScene(error));
  }

  _failScene(error) {
    const message = error?.message || String(error);
    this.results.push({
      id: this.currentScene?.id,
      label: this.currentScene?.label,
      error: message,
    });
    this.debug.status = `${this.currentScene?.label || 'scene'} failed · ${message}`;
    this._prepareNext();
  }

  tick(intervalSeconds, sample = {}) {
    if (!this.running) return;
    if (!this.canRun()) {
      this.stop('XR session ended');
      return;
    }
    if (this.phase === 'preparing') return;
    const dt = Math.max(0, finite(intervalSeconds));
    this.phaseElapsed += dt;

    if (this.phase === 'settling') {
      const limit = Math.max(0, finite(this.currentScene.settleSeconds));
      this._progressStatus('settle', limit);
      if (this.phaseElapsed >= limit) {
        this.phase = 'warming';
        this.phaseElapsed = 0;
        this._statusBucket = -1;
      }
      return;
    }
    if (this.phase === 'warming') {
      const limit = Math.max(0, finite(this.debug.warmupSeconds));
      this._progressStatus('warm-up', limit);
      if (this.phaseElapsed >= limit) {
        this.phase = 'sampling';
        this.phaseElapsed = 0;
        this.frames = [];
        this._statusBucket = -1;
      }
      return;
    }
    if (this.phase !== 'sampling') return;

    this.frames.push({
      intervalSeconds: dt,
      cpuMs: sample.cpuMs,
      gpuMs: sample.gpuMs,
      gpuSampleSerial: sample.gpuSampleSerial,
      drawCalls: sample.drawCalls,
      triangles: sample.triangles,
      runtimeStage: sample.runtimeStage,
      sampleElapsedSeconds: this.phaseElapsed,
    });
    const limit = Math.max(0.25, finite(this.debug.sampleSeconds, 20));
    this._progressStatus('sample', limit);
    if (this.phaseElapsed < limit) return;

    this.results.push({
      id: this.currentScene.id,
      label: this.currentScene.label,
      ...summarizeQuestBenchmarkFrames(this.frames, finite(sample.refreshRate)),
      context: this.context(),
    });
    this._prepareNext();
  }

  _progressStatus(label, limit) {
    // Keep the benchmark observer cheap: update UI text at 4 Hz, not at the
    // headset display rate whose main-thread cost we are trying to measure.
    const bucket = Math.floor(this.phaseElapsed * 4);
    if (bucket === this._statusBucket) return;
    this._statusBucket = bucket;
    this.debug.status = `${this.currentScene.label} · ${label} ${Math.min(this.phaseElapsed, limit).toFixed(1)}/${limit.toFixed(0)}s`;
  }

  stop(reason = 'stopped') {
    if (!this.running) return false;
    this.running = false;
    this.phase = 'idle';
    this.queue = [];
    this.debug.status = reason;
    return true;
  }

  _finish() {
    const report = {
      schemaVersion: 1,
      benchmark: 'WANDER Quest 2 scene suite',
      startedAt: this.runStartedAt,
      completedAt: new Date().toISOString(),
      configuration: {
        warmupSeconds: finite(this.debug.warmupSeconds),
        sampleSeconds: finite(this.debug.sampleSeconds),
        scenes: this.scenes.map((scene) => ({
          id: scene.id,
          settleSeconds: finite(scene.settleSeconds),
        })),
      },
      context: this.runContext,
      results: this.results.map((result) => ({ ...result })),
    };
    this.lastReport = report;
    this.running = false;
    this.phase = 'complete';
    this.currentScene = null;
    this.debug.status = `complete · ${report.results.length} scene(s)`;
    this.debug.latest = this._reportLabel(report);
    try {
      this.storage?.setItem(QUEST_BENCHMARK_STORAGE_KEY, JSON.stringify(report));
    } catch (error) { /* private browsing/storage limits */ }
    this.onComplete?.(report);
  }

  downloadLatest() {
    if (!this.lastReport || typeof document === 'undefined') {
      this.debug.status = 'no completed report to download';
      return false;
    }
    const blob = new Blob([`${JSON.stringify(this.lastReport, null, 2)}\n`], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `wander-quest-benchmark-${this.lastReport.completedAt.replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  }
}
