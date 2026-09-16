import { BASIN_REGION_SIZE } from './hydrologyformat.mjs';
import { WATER_REGION_HALO } from './hydrologyregions.mjs';

// One in-flight request, one newest destination and one ready result. Travel
// cannot build an unbounded queue, and old responses never move the active map.
export class HydrologyStream {
  constructor(seed, worker, { onProgress = null } = {}) {
    this.seed = seed; this.worker = worker; this.nextId = 1;
    this.active = null; this.desired = null; this.pending = null; this.ready = null;
    this.error = null; this.disposed = false; this.progress = null; this.onProgress = onProgress;
    worker.onmessage = ({ data }) => this.receive(data);
    worker.onerror = e => this.fail(e.message || 'Water planning worker failed');
  }
  request(regionX, regionZ) {
    if (this.disposed) return;
    if (![regionX, regionZ].every(Number.isSafeInteger)) throw new Error('Invalid streaming region');
    const key = `${regionX},${regionZ}`;
    if (this.desired?.key !== key) { this.desired = { key, regionX, regionZ }; this.ready = null; this.error = null; }
    this.pump();
  }
  pump() {
    if (this.disposed || this.pending || this.error || !this.desired
      || this.active?.key === this.desired.key || this.ready?.key === this.desired.key) return;
    this.pending = { ...this.desired, id: this.nextId++ };
    this.progress = null;
    this.armTimeout();
    this.worker.postMessage({ type: 'plan-water-window', seed: this.seed, ...this.pending });
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
    if (!Array.isArray(data.plans) || data.plans.length !== 9
      || data.plans.some(p => !p || p.seed !== this.seed || p.generationVersion !== 3 || p.regional !== 1
        || !Number.isSafeInteger(p.regionX) || !Number.isSafeInteger(p.regionZ)
        || Math.abs(p.regionX - pending.regionX) > 1 || Math.abs(p.regionZ - pending.regionZ) > 1)
      || new Set(data.plans.map(p => `${p.regionX},${p.regionZ}`)).size !== 9) {
      this.fail('Incomplete water window'); return;
    }
    this.ready = { ...pending, plans: data.plans };
    this.initialResolve?.(this.ready); this.initialResolve = null; this.initialReject = null;
  }
  fail(message) {
    clearTimeout(this.timeout);
    this.error = message; this.pending = null;
    this.initialReject?.(new Error(message)); this.initialResolve = null; this.initialReject = null;
  }
  initialize(x, z) {
    return new Promise((resolve, reject) => {
      this.initialResolve = resolve; this.initialReject = reject; this.request(x, z);
    });
  }
  commit(window) {
    if (window !== this.ready || window.key !== this.desired?.key) throw new Error('Stale water window');
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
  dispose() { this.disposed = true; clearTimeout(this.timeout); this.worker.terminate(); this.ready = null; this.pending = null; }
}

// Counts are completed surrounding areas, not a misleading time estimate.
export function waterPlanningMessage(progress, initial = false) {
  const prefix = initial ? (progress?.reused > 0 && progress.reused === progress.completed
    ? 'Restoring your landscape' : 'Creating your landscape') : 'Preparing the valley ahead';
  if (!progress || progress.completed === 0) return `${prefix}… Finding rivers, ponds and lakes. This may take a little while.`;
  if (progress.completed === progress.total) return 'Joining rivers and lakes to the surrounding terrain…';
  return `${prefix}… ${progress.completed} of ${progress.total} surrounding areas prepared.`;
}
