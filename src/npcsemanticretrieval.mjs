import { FACT_ACCESS_MODE, narrativeFactAccess, retrieveNpcNarrative } from './npcnarrativegraph.mjs?v=embeddings1';
import { EMBEDDING_PROVIDERS, NpcEmbeddingClient } from './npcembeddings.mjs';
import { NpcEmbeddingCache } from './npcembeddingcache.mjs';

const MODELS = ['baseline', 'qwen', 'gemini'];
const now = () => globalThis.performance?.now?.() ?? Date.now();

export function narrativeEmbeddingText(graph, fact) {
  const names = fact.entityIds.map(id => graph.entities.get(id)?.name).filter(Boolean);
  return `${names.join(', ')}\n${fact.statement}\n${fact.topics.join(', ')}`.trim().slice(0, 2000);
}

/** Disposable indexes are isolated by graph object, speaker and provider.
 * Only content vectors are shared; permissions and fact selection are always fresh.
 */
export class NpcSemanticRetrieval {
  constructor({ client = new NpcEmbeddingClient(), storage = new NpcEmbeddingCache(), maxIndexedFacts = 1024, onUpdate = () => {} } = {}) {
    this.client = client;
    this.storage = storage;
    this.maxIndexedFacts = maxIndexedFacts;
    this.onUpdate = onUpdate;
    this.provider = 'baseline';
    this.compare = false;
    this.indexes = new WeakMap();
    this.documents = { qwen: new Map(), gemini: new Map() };
    this.queries = { qwen: new Map(), gemini: new Map() };
    this.cooldown = { qwen: 0, gemini: 0 };
    this.totals = { qwen: { estimatedTokens: 0, estimatedCostUsd: 0, requests: 0 }, gemini: { estimatedTokens: 0, estimatedCostUsd: 0, requests: 0 } };
    this.runs = [];
    this.snapshots = new Map();
    this.nextId = 1;
    this.status = 'Current graph retrieval';
  }

  configure({ provider = this.provider, compare = this.compare } = {}) {
    if (!MODELS.includes(provider)) throw new Error('Unknown retrieval provider.');
    this.provider = provider;
    this.compare = Boolean(compare);
    this.status = provider === 'baseline' ? 'Current graph retrieval' : `${provider} · waiting for a conversation`;
    const latest = this.snapshots.get(this.runs.at(-1)?.id);
    if (latest) this.warm(latest.graph, latest.request.speakerId);
    this.emit();
  }

  emit() { this.onUpdate(this); }
  providers() { return this.compare ? ['qwen', 'gemini'] : this.provider === 'baseline' ? [] : [this.provider]; }

  recordBaseline(graph, request, cache) {
    const started = now();
    let ranking;
    const packet = retrieveNpcNarrative(graph, { ...request, onRanking: value => { ranking = value; } }, cache);
    const run = { id: this.nextId++, capturedAt: new Date().toISOString(), worldRevision: graph.worldRevision,
      speakerId: request.speakerId, query: request.text, selectedProvider: 'baseline', actualProvider: 'baseline', compare: false,
      baseline: { provider: 'baseline', status: 'ready', packet, facts: ranking, latencyMs: now() - started }, results: {} };
    this.runs.push(run); this.snapshots.set(run.id, { graph, request: structuredClone(request) });
    while (this.runs.length > 10) this.snapshots.delete(this.runs.shift().id);
    this.emit();
    return packet;
  }

  warm(graph, speakerId) {
    for (const provider of this.providers()) this.prepare(graph, speakerId, provider, { background: true }).catch(() => {});
  }

  async embed(provider, purpose, texts, options) {
    const result = await this.client.embed(provider, purpose, texts, options);
    const usage = result.usage || {};
    const totals = this.totals[provider];
    totals.requests++;
    totals.estimatedTokens += Number(usage.estimatedTokens) || 0;
    totals.estimatedCostUsd += Number(usage.estimatedCostUsd) || 0;
    return result;
  }

  async restore(provider, purpose, texts, cache) {
    if (!this.storage || !texts.length) return;
    try {
      const vectors = await this.storage.getMany(provider, purpose, texts);
      texts.forEach((text, i) => { if (vectors[i]) cache.set(text, vectors[i]); });
    } catch { this.storage = null; } // Storage is optional; never interrupt dialogue.
  }

  async persist(provider, purpose, texts, vectors) {
    try { await this.storage?.putMany(provider, purpose, texts, vectors); }
    catch { this.storage = null; }
  }

  index(graph, speakerId, provider) {
    let indexes = this.indexes.get(graph);
    if (!indexes) this.indexes.set(graph, indexes = new Map());
    const key = `${speakerId}|${provider}`;
    if (!indexes.has(key)) {
      // Filter before indexing: inaccessible facts do not reach the embedder.
      const eligible = [...graph.facts.values()].filter(fact => narrativeFactAccess(graph, fact, speakerId) !== FACT_ACCESS_MODE.inaccessible)
        .sort((a, b) => b.salience - a.salience || a.id.localeCompare(b.id));
      indexes.set(key, { status: 'empty', eligible: eligible.length, entries: eligible.slice(0, this.maxIndexedFacts)
        .map(fact => ({ id: fact.id, text: narrativeEmbeddingText(graph, fact), vector: null })), indexed: 0, promise: null, error: null, indexingMs: 0,
        usage: { estimatedTokens: 0, estimatedCostUsd: 0 } });
    }
    return indexes.get(key);
  }

  async prepare(graph, speakerId, provider, { background = false } = {}) {
    const index = this.index(graph, speakerId, provider);
    if (index.status === 'ready') return index;
    if (index.promise) return index.promise;
    if (this.cooldown[provider] > Date.now()) throw new Error(index.error || `${provider} temporarily unavailable.`);
    index.status = 'indexing';
    const started = now();
    index.promise = (async () => {
      try {
        const cache = this.documents[provider];
        await this.restore(provider, 'document', [...new Set(index.entries.filter(entry => !cache.has(entry.text)).map(entry => entry.text))], cache);
        const missing = [...new Set(index.entries.filter(entry => !cache.has(entry.text)).map(entry => entry.text))];
        for (let offset = 0; offset < missing.length; offset += 16) {
          if (background && !this.providers().includes(provider)) {
            index.status = 'paused';
            return index;
          }
          const batch = missing.slice(offset, offset + 16);
          const { vectors, usage } = await this.embed(provider, 'document', batch);
          index.usage.estimatedTokens += Number(usage?.estimatedTokens) || 0;
          index.usage.estimatedCostUsd += Number(usage?.estimatedCostUsd) || 0;
          batch.forEach((text, i) => cache.set(text, vectors[i]));
          await this.persist(provider, 'document', batch, vectors);
          index.indexed = index.entries.filter(entry => cache.has(entry.text)).length;
          if (!background || this.providers().includes(provider)) this.status = `${provider} · indexing ${index.indexed}/${index.entries.length}`;
          this.emit();
        }
        index.entries.forEach(entry => { entry.vector = cache.get(entry.text); });
        index.indexed = index.entries.length;
        index.status = 'ready'; index.error = null;
        // Entries own their vectors, so pruning shared caches cannot break indexes.
        while (cache.size > 4096) cache.delete(cache.keys().next().value);
        if (!background || this.providers().includes(provider)) this.status = `${provider} · ready (${index.indexed}/${index.eligible} facts)`;
        return index;
      } catch (error) {
        index.status = 'unavailable'; index.error = error.message;
        this.cooldown[provider] = Date.now() + 30000;
        if (!background || this.providers().includes(provider)) this.status = `${provider} · unavailable; using current retrieval`;
        throw error;
      } finally {
        index.indexingMs = now() - started;
        index.promise = null;
        this.emit();
      }
    })();
    return index.promise;
  }

  async queryVector(provider, text, fresh, timeoutMs) {
    const started = now();
    const cache = this.queries[provider];
    if (!fresh && !cache.has(text)) await this.restore(provider, 'query', [text], cache);
    if (!fresh && cache.has(text)) return { vector: cache.get(text), cacheHit: true, usage: {}, queryLatencyMs: 0 };
    const { vectors: [vector], usage } = await this.embed(provider, 'query', [text.slice(0, 2000)], { timeoutMs });
    cache.set(text, vector);
    await this.persist(provider, 'query', [text], [vector]);
    while (cache.size > 128) cache.delete(cache.keys().next().value);
    return { vector, cacheHit: false, usage, queryLatencyMs: now() - started };
  }

  async evaluate(graph, request, provider, { waitForIndex = false, fresh = false, timeoutMs } = {}) {
    const started = now();
    const index = this.index(graph, request.speakerId, provider);
    // Explicit offline replay may retry a failed provider; ordinary dialogue
    // honours cooldown so a slow service cannot repeatedly delay the player.
    if (waitForIndex) this.cooldown[provider] = 0;
    try {
      if (index.status !== 'ready') {
        const preparing = this.prepare(graph, request.speakerId, provider, { background: !waitForIndex });
        if (waitForIndex) await preparing;
        else { preparing.catch(() => {}); throw new Error(index.status === 'unavailable' ? index.error : 'Index is building.'); }
      }
      if (this.cooldown[provider] > Date.now()) throw new Error('Provider temporarily unavailable.');
      const { vector, cacheHit, usage, queryLatencyMs } = await this.queryVector(provider, request.text, fresh, timeoutMs);
      const scores = new Map(index.entries.map(entry => [entry.id, entry.vector.reduce((sum, value, i) => sum + value * vector[i], 0)]));
      let ranking;
      const packet = retrieveNpcNarrative(graph, { ...request, semanticScores: scores, onRanking: value => { ranking = value; } });
      return { provider, model: EMBEDDING_PROVIDERS[provider].model, status: 'ready', packet,
        facts: ranking,
        latencyMs: now() - started, queryLatencyMs, queryCacheHit: cacheHit, indexedFacts: index.indexed, eligibleFacts: index.eligible,
        indexingMs: index.indexingMs, indexingUsage: { ...index.usage }, estimatedTokens: Number(usage?.estimatedTokens) || 0,
        estimatedCostUsd: Number(usage?.estimatedCostUsd) || 0 };
    } catch (error) {
      if (index.status === 'ready') this.cooldown[provider] = Date.now() + 30000;
      return { provider, status: index.status === 'indexing' ? 'indexing' : 'unavailable', error: error.message,
        latencyMs: now() - started, indexedFacts: index.indexed, eligibleFacts: index.eligible,
        indexingUsage: { ...index.usage } };
    }
  }

  async retrieve(graph, request, cache) {
    const provider = this.provider, compare = this.compare;
    const started = now();
    let ranking;
    const baseline = retrieveNpcNarrative(graph, { ...request, onRanking: value => { ranking = value; } }, cache);
    const run = { id: this.nextId++, capturedAt: new Date().toISOString(), worldRevision: graph.worldRevision,
      speakerId: request.speakerId, query: request.text, selectedProvider: provider, compare,
      baseline: { provider: 'baseline', status: 'ready', packet: baseline, facts: ranking, latencyMs: now() - started }, results: {} };
    const providers = compare ? ['qwen', 'gemini'] : provider === 'baseline' ? [] : [provider];
    const results = await Promise.all(providers.map(name => this.evaluate(graph, request, name)));
    results.forEach(result => { run.results[result.provider] = result; });
    const selected = run.results[provider];
    run.actualProvider = selected?.status === 'ready' ? provider : 'baseline';
    run.fallback = provider !== 'baseline' && run.actualProvider === 'baseline';
    run.totalLatencyMs = now() - started;
    this.runs.push(run); this.snapshots.set(run.id, { graph, request: structuredClone(request) });
    while (this.runs.length > 10) this.snapshots.delete(this.runs.shift().id);
    this.status = `${run.actualProvider}${run.fallback ? ` (${provider} fallback)` : ''} · ${Math.round(run.totalLatencyMs)} ms`;
    this.emit();
    return selected?.status === 'ready' ? selected.packet : baseline;
  }

  async replay(id = this.runs.at(-1)?.id) {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) throw new Error('Ask an NPC a question first.');
    const run = this.runs.find(item => item.id === id);
    const results = await Promise.all(['qwen', 'gemini'].map(provider => this.evaluate(snapshot.graph, snapshot.request, provider, { waitForIndex: true, fresh: true, timeoutMs: 12000 })));
    // Replay uses the captured graph, not the current world, and never prompts an NPC.
    run.replay = { capturedAt: new Date().toISOString(), results: Object.fromEntries(results.map(result => [result.provider, result])) };
    this.emit();
    return run.replay;
  }

  markStale(packet, currentRevision) {
    const run = [...this.runs].reverse().find(item => item.worldRevision === packet.worldRevision
      && item.speakerId === packet.speakerId && item.query === packet.query.text);
    if (run) {
      run.actualProvider = 'baseline'; run.fallback = true;
      run.staleRevision = true; run.currentWorldRevision = currentRevision;
    }
    this.status = 'World changed during lookup · using current retrieval';
    this.emit();
  }

  report() { return { version: 1, provider: this.provider, compare: this.compare, status: this.status,
    maxIndexedFacts: this.maxIndexedFacts, estimatedUsage: this.totals, runs: this.runs }; }
}

export const npcSemanticRetrieval = new NpcSemanticRetrieval();
