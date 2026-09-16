import { BASIN_REGION_SIZE } from './hydrologyformat.mjs';
import { WATER_REGION_HALO } from './hydrologyregions.mjs';
import { WaterField, prepareWaterField } from './waterfield.mjs';
import { decodeWaterPlanJSON } from './waterstage.mjs';

const WINDOW_PLAN_COUNT = 9;
const MAX_WIRE_BYTES = 32 * 1024 * 1024;
const PROFILE_PHASES = ['cache-read', 'generation', 'cache-write', 'finalization', 'encoding'];

function readProfiling(value) {
  if (!value || typeof value !== 'object' || !value.phaseMs) return null;
  const phaseMs = {};
  for (const name of PROFILE_PHASES) {
    const ms = value.phaseMs[name];
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 3600000) return null;
    phaseMs[name] = ms;
  }
  return Object.freeze({ phaseMs: Object.freeze(phaseMs) });
}

function hostYield() {
  return new Promise(resolve => {
    if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(resolve);
    else if (typeof globalThis.setImmediate === 'function') globalThis.setImmediate(resolve);
    else globalThis.setTimeout(resolve, 0);
  });
}

function validateWindowPlans(plans, seed, pending) {
  if (!Array.isArray(plans) || plans.length !== WINDOW_PLAN_COUNT
    || plans.some(plan => !plan || plan.seed !== seed || plan.generationVersion !== 3 || plan.regional !== 1
      || !Number.isSafeInteger(plan.regionX) || !Number.isSafeInteger(plan.regionZ)
      || Math.abs(plan.regionX - pending.regionX) > 1 || Math.abs(plan.regionZ - pending.regionZ) > 1)
    || new Set(plans.map(plan => `${plan.regionX},${plan.regionZ}`)).size !== WINDOW_PLAN_COUNT) {
    throw new Error('Incomplete water window');
  }
}

// One in-flight request, one newest destination and one ready result. Travel
// cannot build an unbounded queue, and old responses never move the active map.
export class HydrologyStream {
  constructor(seed, worker, { onProgress = null, yieldTask = hostYield } = {}) {
    this.seed = seed; this.worker = worker; this.nextId = 1;
    this.active = null; this.desired = null; this.pending = null; this.ready = null;
    this.error = null; this.disposed = false; this.progress = null; this.onProgress = onProgress;
    this.profiling = null;
    this.yieldTask = yieldTask;
    this.preparing = null;
    worker.onmessage = ({ data }) => this.receive(data);
    worker.onerror = e => this.fail(e.message || 'Water planning worker failed');
  }
  request(regionX, regionZ) {
    if (this.disposed) return;
    if (![regionX, regionZ].every(Number.isSafeInteger)) throw new Error('Invalid streaming region');
    const key = `${regionX},${regionZ}`;
    if (this.desired?.key !== key) {
      this.desired = { key, regionX, regionZ };
      this.ready = null; this.error = null;
      this.cancelPreparation();
    }
    this.pump();
  }
  pump() {
    if (this.disposed || this.pending || this.preparing || this.error || !this.desired
      || this.active?.key === this.desired.key || this.ready?.key === this.desired.key) return;
    this.pending = { ...this.desired, id: this.nextId++ };
    this.progress = null;
    this.profiling = null;
    this.armTimeout();
    this.worker.postMessage({ type: 'plan-water-window', seed: this.seed,
      // initialize() also covers a blocking lakeshore relocation before the
      // first scene. It may use the loading-screen worker pool even when an
      // earlier search window is already committed; walking updates may not.
      startup: this.active === null || !!this.initialResolve, ...this.pending });
  }
  armTimeout() {
    clearTimeout(this.timeout);
    // Allow long first-time generation while completed regions keep arriving.
    this.timeout = setTimeout(() => this.fail('Water planning stopped responding'), 120000);
    this.timeout.unref?.();
  }
  receive(data) {
    if (this.disposed || data.id !== this.pending?.id) return;
    if (data.type === 'water-window-progress') {
      if (data.seed !== this.seed || data.regionX !== this.pending.regionX || data.regionZ !== this.pending.regionZ
        || data.total !== 25 || !Number.isInteger(data.completed) || data.completed < 0 || data.completed > 25
        || !Number.isInteger(data.reused) || data.reused < 0 || data.reused > data.completed
        || (this.progress && (data.completed <= this.progress.completed || data.reused < this.progress.reused))) return;
      this.progress = { completed: data.completed, total: data.total, reused: data.reused };
      this.armTimeout();
      if (this.pending.key === this.desired?.key) this.onProgress?.(this.progress);
      return;
    }
    clearTimeout(this.timeout);
    const pending = this.pending; this.pending = null;
    if (pending.key !== this.desired?.key) { this.pump(); return; }
    if (data.type !== 'water-window-planned' || data.seed !== this.seed
      || data.regionX !== pending.regionX || data.regionZ !== pending.regionZ) { this.fail(data.error || 'Water window identity mismatch'); return; }
    this.profiling = readProfiling(data.profiling);
    try {
      if (data.plansJSON !== undefined) {
        if (!Array.isArray(data.plansJSON) || data.plansJSON.length !== WINDOW_PLAN_COUNT) {
          throw new Error('Incomplete water window');
        }
        const bytes = data.plansJSON.reduce((total, value) => {
          if (typeof value !== 'string') throw new Error('Invalid worker water plan payload');
          return total + value.length;
        }, 2 + WINDOW_PLAN_COUNT - 1);
        if (bytes > MAX_WIRE_BYTES) throw new Error('Water plan memory budget exceeded');
        this.beginWirePreparation(pending, data.plansJSON);
        return;
      }
      validateWindowPlans(data.plans, this.seed, pending);
      // The raw object form is retained for older test/tools callers. It is
      // still fully validated and defensively cloned; only the new wire form
      // takes the cooperative path used by the game worker.
      const preparedField = new WaterField(this.seed, data.plans);
      this.ready = { ...pending, plans: preparedField.plans, preparedField };
      this.initialResolve?.(this.ready); this.initialResolve = null; this.initialReject = null;
    } catch (error) { this.fail(error.message); }
  }

  beginWirePreparation(pending, encoded) {
    const state = {
      pending, encoded, plans: [], planBytes: new Map(), index: 0,
      controller: new AbortController(), cancelled: false,
    };
    this.preparing = state;
    this.armTimeout();
    Promise.resolve().then(() => this.yieldTask())
      .then(() => this.decodeNext(state), error => this.preparationFailed(state, error));
  }

  decodeNext(state) {
    if (!this.isCurrentPreparation(state)) return;
    try {
      const plan = decodeWaterPlanJSON(state.encoded[state.index]);
      state.plans.push(plan);
      if (Number.isSafeInteger(plan.regionX) && Number.isSafeInteger(plan.regionZ)) {
        state.planBytes.set(`${plan.regionX},${plan.regionZ}`, state.encoded[state.index].length);
      }
      state.index++;
      this.armTimeout();
      if (state.index < state.encoded.length) {
        Promise.resolve().then(() => this.yieldTask())
          .then(() => this.decodeNext(state), error => this.preparationFailed(state, error));
      } else {
        validateWindowPlans(state.plans, this.seed, state.pending);
        this.beginPlanPreparation(state.pending, state.plans, {
          adopt: true, workerPlansJSON: state.encoded, planBytes: state.planBytes, state,
        });
      }
    } catch (error) { this.preparationFailed(state, error); }
  }

  beginPlanPreparation(pending, plans, { adopt, workerPlansJSON = null, planBytes = null, state = null } = {}) {
    if (state && !this.isCurrentPreparation(state)) return;
    const preparation = state || {
      pending, controller: new AbortController(), cancelled: false,
    };
    this.preparing = preparation;
    this.armTimeout();
    prepareWaterField(this.seed, plans, {
      adopt, workerPlansJSON, planBytes, signal: preparation.controller.signal,
      yieldTask: this.yieldTask,
      onProgress: () => this.armTimeout(),
    }).then(field => this.finishPreparation(preparation, plans, field), error => this.preparationFailed(preparation, error));
  }

  isCurrentPreparation(state) {
    return !this.disposed && !state.cancelled && this.preparing === state
      && state.pending.key === this.desired?.key;
  }

  finishPreparation(state, plans, preparedField) {
    if (!this.isCurrentPreparation(state)) return;
    clearTimeout(this.timeout);
    this.preparing = null;
    const ready = { ...state.pending, plans: preparedField.plans, preparedField };
    this.ready = ready;
    this.initialResolve?.(ready); this.initialResolve = null; this.initialReject = null;
  }

  preparationFailed(state, error) {
    if (!this.isCurrentPreparation(state)) return;
    this.fail(error?.message || 'Water field preparation failed');
  }

  cancelPreparation() {
    const state = this.preparing;
    if (!state) return;
    state.cancelled = true;
    state.controller.abort();
    this.preparing = null;
  }

  fail(message) {
    clearTimeout(this.timeout);
    this.cancelPreparation();
    this.error = message; this.pending = null;
    this.initialReject?.(new Error(message)); this.initialResolve = null; this.initialReject = null;
  }
  initialize(x, z) {
    return new Promise((resolve, reject) => {
      this.initialResolve = resolve; this.initialReject = reject; this.request(x, z);
    });
  }
  commit(window) {
    if (!window || window !== this.ready || window.key !== this.desired?.key) throw new Error('Stale water window');
    this.active = { key: window.key, regionX: window.regionX, regionZ: window.regionZ };
    this.ready = null;
  }
  update(x, z) { this.request(Math.floor(x / BASIN_REGION_SIZE), Math.floor(z / BASIN_REGION_SIZE)); }
  contains(x, z, margin = 0) {
    if (!this.active) return false;
    const { regionX, regionZ } = this.active;
    return x >= (regionX - 1) * BASIN_REGION_SIZE + WATER_REGION_HALO + margin
      && z >= (regionZ - 1) * BASIN_REGION_SIZE + WATER_REGION_HALO + margin
      && x < (regionX + 2) * BASIN_REGION_SIZE - WATER_REGION_HALO - margin
      && z < (regionZ + 2) * BASIN_REGION_SIZE - WATER_REGION_HALO - margin;
  }
  dispose() {
    this.disposed = true; clearTimeout(this.timeout); this.cancelPreparation();
    this.worker.terminate(); this.ready = null; this.pending = null;
    this.initialReject?.(new Error('Water stream disposed')); this.initialResolve = null; this.initialReject = null;
  }
}

// Counts are completed surrounding areas, not a misleading time estimate.
export function waterPlanningMessage(progress, initial = false) {
  const prefix = initial ? (progress?.reused > 0 && progress.reused === progress.completed
    ? 'Restoring your landscape' : 'Creating your landscape') : 'Preparing the valley ahead';
  if (!progress || progress.completed === 0) return `${prefix}… Finding rivers, ponds and lakes. This may take a little while.`;
  if (progress.completed === progress.total) return 'Joining rivers and lakes to the surrounding terrain…';
  return `${prefix}… ${progress.completed} of ${progress.total} surrounding areas prepared.`;
}
