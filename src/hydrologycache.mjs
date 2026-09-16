import { BASIN_PLAN_VERSION, descriptorHash, WATER_CACHE_REVISION } from './hydrologyformat.mjs';
import { WaterField } from './waterfield.mjs';

// Bump whenever terrain, candidate generation, fitting or mesh output changes.
// Cached candidates are disposable; this is not a world-save format.
export { WATER_CACHE_REVISION } from './hydrologyformat.mjs';
export const WATER_CACHE_BYTES = 96 * 1024 * 1024;
const REGION_BYTES = 3000000;

export function waterCacheKey(seed, x, z) {
  return `${WATER_CACHE_REVISION}:${seed}:${x}:${z}`;
}

export function decodeWaterCandidate(text, seed, x, z) {
  if (typeof text !== 'string' || text.length > REGION_BYTES) throw new Error('Invalid cached region size');
  const plan = JSON.parse(text);
  if (!plan || plan.seed !== seed || plan.regionX !== x || plan.regionZ !== z
    || plan.version !== BASIN_PLAN_VERSION || plan.generationVersion !== 3 || plan.regional !== 1
    || plan.preview !== true || !Array.isArray(plan.basins) || !Array.isArray(plan.components)
    || plan.reaches?.length) throw new Error('Cached region identity mismatch');
  const { hash, diagnostics, ...payload } = plan;
  if (hash !== descriptorHash(payload)) throw new Error('Cached region checksum mismatch');
  // Check extents before constructing spatial bins, including malformed records
  // that carry a freshly computed checksum rather than accidental corruption.
  for (const object of [...plan.basins, ...plan.components]) {
    const b = object.bounds;
    if (!b || ![b.minX, b.maxX, b.minZ, b.maxZ].every(Number.isFinite)
      || b.minX >= b.maxX || b.minZ >= b.maxZ || b.minX < x * 4096 - 1024
      || b.maxX > (x + 1) * 4096 + 1024 || b.minZ < z * 4096 - 1024
      || b.maxZ > (z + 1) * 4096 + 1024) throw new Error('Invalid cached region bounds');
  }
  new WaterField(seed, [plan]);
  return plan;
}

// A cache failure must never prevent generation or publish unvalidated terrain.
export class WaterCandidateCache {
  constructor(storage) { this.storage = storage; this.disabled = !storage; }
  async get(seed, x, z) {
    if (this.disabled) return null;
    const key = waterCacheKey(seed, x, z);
    try {
      const text = await this.storage.get(key);
      if (text == null) return null;
      try { return decodeWaterCandidate(text, seed, x, z); }
      catch { await this.storage.delete(key); return null; }
    } catch { this.disabled = true; return null; }
  }
  async put(plan) {
    if (this.disabled) return;
    const text = JSON.stringify(plan);
    if (text.length > REGION_BYTES) return;
    try { await this.storage.put(waterCacheKey(plan.seed, plan.regionX, plan.regionZ), text); }
    catch { this.disabled = true; }
  }
}

// Separate metadata avoids loading every multi-megabyte plan for LRU eviction.
// One transaction publishes the record, metadata and evictions atomically,
// including when several game tabs share this origin.
export class IndexedWaterStorage {
  constructor(indexedDB = globalThis.indexedDB, { name = 'wander-water-candidates', maxBytes = WATER_CACHE_BYTES, maxEntries = 64 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > WATER_CACHE_BYTES
      || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 64) throw new Error('Invalid persistent water cache budget');
    this.indexedDB = indexedDB; this.opening = null;
    this.name = name; this.maxBytes = maxBytes; this.maxEntries = maxEntries;
  }
  open() {
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, db) => {
        if (settled) { db?.close(); return; }
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(db);
      };
      const timer = setTimeout(() => finish(new Error('Water cache unavailable')), 3000);
      let request;
      try { request = this.indexedDB.open(this.name, 1); }
      catch (error) { finish(error); return; }
      request.onupgradeneeded = () => {
        request.result.createObjectStore('plans');
        request.result.createObjectStore('metadata', { keyPath: 'key' });
      };
      request.onerror = () => finish(request.error);
      request.onblocked = () => finish(new Error('Water cache blocked'));
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        finish(null, request.result);
      };
    });
    return this.opening;
  }
  async transaction(action) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['plans', 'metadata'], 'readwrite');
      let result;
      const timer = setTimeout(() => { tx.abort(); }, 5000);
      tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
      tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(tx.error || new Error('Water cache transaction failed')); };
      try { action(tx.objectStore('plans'), tx.objectStore('metadata'), value => { result = value; }); }
      catch (error) { clearTimeout(timer); tx.abort(); reject(error); }
    });
  }
  get(key) {
    return this.transaction((plans, metadata, done) => {
      const request = plans.get(key);
      request.onsuccess = () => {
        const text = request.result;
        if (typeof text === 'string') metadata.put({ key, bytes: new TextEncoder().encode(text).length, accessed: Date.now() });
        done(text);
      };
    });
  }
  delete(key) { return this.transaction((plans, metadata) => { plans.delete(key); metadata.delete(key); }); }
  put(key, text) {
    return this.transaction((plans, metadata) => {
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > REGION_BYTES) return;
      plans.put(text, key);
      metadata.put({ key, bytes, accessed: Date.now() });
      const request = metadata.getAll();
      request.onsuccess = () => {
        const records = request.result.sort((a, b) => a.accessed - b.accessed || a.key.localeCompare(b.key));
        let total = records.reduce((n, record) => n + record.bytes, 0), count = records.length;
        for (const record of records) {
          if (total <= this.maxBytes && count <= this.maxEntries) break;
          plans.delete(record.key); metadata.delete(record.key); total -= record.bytes; count--;
        }
      };
    });
  }
}
