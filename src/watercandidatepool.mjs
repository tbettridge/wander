// A small pool for independent candidate regions. Arbitration and publication
// still happen in canonical region order in WaterRegionPlanner.
export class WaterCandidatePool {
  constructor({ size = 2, workerFactory, maxJobs = 25 } = {}) {
    if (!Number.isInteger(size) || size < 1 || size > 3 || typeof workerFactory !== 'function'
      || !Number.isInteger(maxJobs) || maxJobs < size || maxJobs > 25) throw new Error('Invalid water candidate pool');
    this.size = size; this.workerFactory = workerFactory; this.maxJobs = maxJobs;
    this.slots = []; this.queue = []; this.nextId = 0; this.disposed = false;
  }
  generate(seed, x, z) {
    if (this.disposed) return Promise.reject(new Error('Water candidate pool disposed'));
    if (![seed, x, z].every(Number.isSafeInteger)) return Promise.reject(new Error('Invalid candidate identity'));
    if (this.queue.length + this.slots.filter(slot => slot.job).length >= this.maxJobs) {
      return Promise.reject(new Error('Water candidate queue budget exceeded'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.nextId, seed, x, z, resolve, reject });
      this.pump();
    });
  }
  pump() {
    if (this.disposed) return;
    while (this.queue.length) {
      let slot = this.slots.find(value => !value.job);
      if (!slot) {
        if (this.slots.length >= this.size) return;
        try {
          const worker = this.workerFactory();
          slot = { worker, job: null };
          worker.onmessage = ({ data }) => this.receive(slot, data);
          worker.onerror = error => this.fail(new Error(error.message || 'Water candidate worker failed'));
          this.slots.push(slot);
        } catch (error) { this.fail(error); return; }
      }
      slot.job = this.queue.shift();
      try {
        const { id, seed, x, z } = slot.job;
        slot.worker.postMessage({ type: 'candidate', id, seed, x, z });
      } catch (error) { this.fail(error); return; }
    }
  }
  receive(slot, data) {
    const job = slot.job;
    if (!job || this.disposed || data?.id !== job.id) return;
    try {
      if (data.type !== 'candidate-ready') throw new Error(data.error || 'Invalid candidate worker response');
      if (typeof data.planJSON !== 'string' || data.planJSON.length > 8 * 1024 * 1024) {
        throw new Error('Candidate wire budget exceeded');
      }
      const plan = JSON.parse(data.planJSON);
      if (plan.seed !== job.seed || plan.regionX !== job.x || plan.regionZ !== job.z
        || plan.generationVersion !== 3 || plan.regional !== 1) throw new Error('Candidate identity mismatch');
      slot.job = null; job.resolve(plan); this.pump();
    } catch (error) { this.fail(error); }
  }
  fail(error) {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) { slot.worker.terminate(); slot.job?.reject(error); slot.job = null; }
    for (const job of this.queue.splice(0)) job.reject(error);
    this.slots.length = 0;
  }
  dispose() { this.fail(new Error('Water candidate pool disposed')); }
}

export function waterCandidateConcurrency(hardwareConcurrency) {
  return Number.isFinite(hardwareConcurrency) && hardwareConcurrency >= 8 ? 3
    : Number.isFinite(hardwareConcurrency) && hardwareConcurrency >= 4 ? 2 : 1;
}
