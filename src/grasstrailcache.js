import {
  GRASS_FIELD_COVER,
  GRASS_FIELD_SIZE,
  GRASS_TRAIL_MASK_SIZE,
} from './grasstrailprep.mjs';

export class GrassTrailCache {
  constructor(seed, { limit = 8 } = {}) {
    this.seed = seed;
    this.limit = limit;
    this.cache = new Map();
    this.queued = new Map();
    this.active = null;
    this.nextId = 1;
    this.ready = false;
    this.worker = null;
    this.debug = {
      state: 'idle',
      cache: `0/${limit} · 0 hits · 0 misses`,
      timing: '—',
      late: 0,
      hits: 0,
      misses: 0,
    };
  }

  ensureWorker() {
    if (this.worker) return;
    this.debug.state = 'starting worker';
    this.worker = new Worker(new URL('./grasstrailworker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event) => this.onMessage(event.data);
    this.worker.onerror = (event) => {
      this.debug.state = `worker error: ${event.message || 'unknown'}`;
      this.active = null;
    };
    this.worker.postMessage({ type: 'init', seed: this.seed });
  }

  touch(key, value) {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
    this.updateCacheDebug();
    return value;
  }

  updateCacheDebug() {
    this.debug.cache = `${this.cache.size}/${this.limit} · ${this.debug.hits} hits · ${this.debug.misses} misses`;
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const value = this.cache.get(key);
    this.debug.hits++;
    this.updateCacheDebug();
    return this.touch(key, value);
  }

  request(spec, priority = 0) {
    const cached = this.get(spec.key);
    if (cached) return cached;
    if (this.active?.spec.key === spec.key) {
      this.active.priority = Math.max(this.active.priority, priority);
      return null;
    }
    const existing = this.queued.get(spec.key);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
      return null;
    }
    this.debug.misses++;
    this.updateCacheDebug();
    // Only the newest speculative direction matters. Required requests remain
    // queued, while obsolete prewarm guesses are cheaply discarded.
    if (priority <= 0) {
      for (const [key, job] of this.queued) {
        if (job.priority <= 0) this.queued.delete(key);
      }
    }
    this.queued.set(spec.key, { spec: {
      ...spec,
      cover: GRASS_FIELD_COVER,
      fieldSize: GRASS_FIELD_SIZE,
      maskSize: GRASS_TRAIL_MASK_SIZE,
    }, priority, order: this.nextId++ });
    this.ensureWorker();
    this.dispatch();
    return null;
  }

  dispatch() {
    if (!this.ready || this.active || this.queued.size === 0) return;
    let selected = null;
    for (const job of this.queued.values()) {
      if (!selected || job.priority > selected.priority
        || (job.priority === selected.priority && job.order < selected.order)) selected = job;
    }
    this.queued.delete(selected.spec.key);
    this.active = selected;
    this.debug.state = `${selected.priority > 0 ? 'required' : 'prewarming'} · ${selected.spec.key}`;
    this.worker.postMessage({ type: 'prepare', id: selected.order, spec: selected.spec });
  }

  onMessage(message) {
    if (message.type === 'ready') {
      this.ready = true;
      this.debug.state = 'idle';
      this.dispatch();
      return;
    }
    if (!this.active || message.id !== this.active.order) return;
    const active = this.active;
    this.active = null;
    if (message.type === 'prepared') {
      const bundle = message.bundle;
      this.touch(bundle.key, bundle);
      this.debug.timing = `${bundle.totalMs.toFixed(1)}ms · query ${bundle.queryMs.toFixed(1)} · ecology ${bundle.ecologyMs.toFixed(1)} · ${bundle.edgeCount} edges`;
      this.debug.state = this.queued.size ? 'queued' : 'idle';
    } else {
      this.debug.state = `failed: ${message.message || active.spec.key}`;
    }
    this.dispatch();
  }

  markLate() {
    this.debug.late++;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.cache.clear();
    this.queued.clear();
    this.active = null;
  }
}
