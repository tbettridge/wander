import { EMBEDDING_DIMENSIONS, EMBEDDING_FORMAT_VERSION, EMBEDDING_PROVIDERS, embeddingInput, normalizedEmbedding } from './npcembeddings.mjs';

// Include the prompt as well as the model: equal dimensions do not imply compatible vectors.
export function embeddingCacheNamespace(provider, purpose) {
  return JSON.stringify([EMBEDDING_PROVIDERS[provider].model, EMBEDDING_DIMENSIONS,
    EMBEDDING_FORMAT_VERSION, purpose, embeddingInput(provider, purpose, '')]);
}

/** Browser-local acceleration only. Never stores permissions or authoritative memories. */
export class NpcEmbeddingCache {
  constructor({ indexedDB = globalThis.indexedDB, name = 'wander-npc-embeddings', maxDocuments = 4096, maxQueries = 128 } = {}) {
    this.indexedDB = indexedDB; this.name = name; this.opening = null;
    this.maxDocuments = maxDocuments; this.maxQueries = maxQueries;
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
      const timer = setTimeout(() => finish(new Error('Embedding cache unavailable')), 2000);
      let request;
      try { request = this.indexedDB.open(this.name, 1); }
      catch (error) { finish(error); return; }
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('vectors', { keyPath: 'key' });
        store.createIndex('namespace', 'namespace');
        store.createIndex('recent', ['namespace', 'accessed']);
      };
      request.onerror = () => finish(request.error);
      request.onblocked = () => finish(new Error('Embedding cache blocked'));
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); this.opening = null; };
        finish(null, request.result);
      };
    });
    return this.opening;
  }

  async transaction(action) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('vectors', 'readwrite');
      let result;
      const timer = setTimeout(() => tx.abort(), 2000);
      tx.oncomplete = () => { clearTimeout(timer); resolve(result); };
      tx.onabort = tx.onerror = () => { clearTimeout(timer); reject(tx.error || new Error('Embedding cache transaction failed')); };
      try { action(tx.objectStore('vectors'), value => { result = value; }); }
      catch (error) { clearTimeout(timer); tx.abort(); reject(error); }
    });
  }

  async getMany(provider, purpose, texts) {
    if (!texts.length) return [];
    const namespace = embeddingCacheNamespace(provider, purpose);
    return this.transaction((store, done) => {
      const values = new Array(texts.length).fill(null);
      let remaining = texts.length;
      texts.forEach((text, i) => {
        const request = store.get(JSON.stringify([namespace, text]));
        request.onsuccess = () => {
          const record = request.result;
          if (record) {
            try {
              if (record.vector?.length !== EMBEDDING_DIMENSIONS) throw new Error('Invalid cached dimensions');
              values[i] = normalizedEmbedding(record.vector);
              store.put({ ...record, accessed: Date.now() });
            } catch { store.delete(record.key); }
          }
          if (--remaining === 0) done(values);
        };
      });
    });
  }

  async putMany(provider, purpose, texts, vectors) {
    if (!texts.length) return;
    const namespace = embeddingCacheNamespace(provider, purpose);
    const limit = purpose === 'document' ? this.maxDocuments : this.maxQueries;
    return this.transaction(store => {
      texts.forEach((text, i) => store.put({ key: JSON.stringify([namespace, text]), namespace,
        accessed: Date.now(), vector: normalizedEmbedding(vectors[i]) }));
      const count = store.index('namespace').count(namespace);
      count.onsuccess = () => {
        let excess = count.result - limit;
        if (excess <= 0) return;
        const cursor = store.index('recent').openCursor(IDBKeyRange.bound([namespace, 0], [namespace, Number.MAX_SAFE_INTEGER]));
        cursor.onsuccess = () => {
          if (!cursor.result || excess-- <= 0) return;
          cursor.result.delete(); cursor.result.continue();
        };
      };
    });
  }
}
