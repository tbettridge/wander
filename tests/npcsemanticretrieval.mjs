import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNpcNarrativeGraph, retrieveNpcNarrative, createNarrativeRetrievalCache } from '../src/npcnarrativegraph.mjs';
import { NpcSemanticRetrieval } from '../src/npcsemanticretrieval.mjs';
import { NpcEmbeddingClient, EMBEDDING_DIMENSIONS, EMBEDDING_PROVIDERS, embeddingInput } from '../src/npcembeddings.mjs';
import { retrievalQuality } from '../src/npcretrievaldebug.js';
import { createNpcNarrativeConversation, retrieveNpcConversationNarrative } from '../src/npcnarrativecontinuity.mjs';
import { npcSemanticRetrieval } from '../src/npcsemanticretrieval.mjs';
import { embeddingCacheNamespace } from '../src/npcembeddingcache.mjs';

const facts = packet => [...packet.speakable, ...packet.consistencyOnly];
const vector = (a = 1, b = 0) => [a, b, ...Array(EMBEDDING_DIMENSIONS - 2).fill(0)];
function graph(revision = 1, extra = []) {
  return buildNpcNarrativeGraph({ revision,
    residents: [{ id: 'keeper', name: 'Alder', role: 'keeper' }, { id: 'smith', name: 'Mira', role: 'smith' }],
    facts: [
      { id: 'repair', statement: 'Mira mends damaged wagons.', subjectId: 'smith', visibility: 'public', privacy: 'public' },
      { id: 'secret', statement: 'Mira owes a hidden debt.', subjectId: 'smith', visibility: 'private', privacy: 'private', knownBy: ['smith'] },
      { id: 'disputed', statement: 'Mira has a disputed claim.', subjectId: 'smith', visibility: 'public', privacy: 'public', status: 'disputed' },
      ...extra,
    ] });
}
function fakeClient() {
  const calls = [];
  return { calls, async embed(provider, purpose, texts) {
    calls.push({ provider, purpose, texts });
    return { vectors: texts.map(text => purpose === 'query' || text.includes('mends') ? vector() : vector(0, 1)),
      usage: { estimatedTokens: texts.length * 10, estimatedCostUsd: texts.length * 0.00001 } };
  } };
}
const request = { speakerId: 'keeper', text: 'Who could fix a broken cart?', maxFacts: 1, conversationId: 'test' };

test('persistent vectors survive service recreation, isolate models and only embed changed text', async () => {
  const records = new Map();
  const storage = {
    async getMany(provider, purpose, texts) { return texts.map(text => records.get(`${embeddingCacheNamespace(provider, purpose)}|${text}`)); },
    async putMany(provider, purpose, texts, vectors) { texts.forEach((text, i) => records.set(`${embeddingCacheNamespace(provider, purpose)}|${text}`, vectors[i])); },
  };
  const first = new NpcSemanticRetrieval({ storage, client: fakeClient() });
  await first.prepare(graph(), 'keeper', 'qwen');
  await first.queryVector('qwen', request.text, false);
  const client = fakeClient(), reloaded = new NpcSemanticRetrieval({ storage, client });
  await reloaded.prepare(graph(), 'keeper', 'qwen');
  assert.equal((await reloaded.queryVector('qwen', request.text, false)).cacheHit, true);
  assert.equal(client.calls.length, 0);
  assert.equal(reloaded.totals.qwen.estimatedCostUsd, 0);
  await reloaded.prepare(graph(2, [{ id: 'new', statement: 'Mira now repairs boats.', subjectId: 'smith', visibility: 'public', privacy: 'public' }]), 'keeper', 'qwen');
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].texts.length, 1);
  assert.ok(!client.calls[0].texts.some(text => text.includes('hidden debt')));
  await reloaded.prepare(graph(), 'keeper', 'gemini');
  assert.equal(client.calls.at(-1).provider, 'gemini');
  await reloaded.queryVector('qwen', request.text, true);
  assert.equal(client.calls.at(-1).purpose, 'query');
});

test('failed persistent storage falls back to memory without losing retrieval', async () => {
  const client = fakeClient();
  const service = new NpcSemanticRetrieval({ client, storage: { async getMany() { throw new Error('quota'); } } });
  await service.prepare(graph(), 'keeper', 'qwen');
  assert.equal(service.storage, null);
  await service.queryVector('qwen', request.text, false);
  await service.queryVector('qwen', request.text, false);
  assert.equal(client.calls.filter(call => call.purpose === 'query').length, 1);
});

test('switching embeddings off stops subsequent background indexing batches', async () => {
  let finish;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const calls = [];
  const service = new NpcSemanticRetrieval({ client: { embed: async (_provider, _purpose, texts) => {
    calls.push(texts);
    signalStarted();
    await new Promise(resolve => { finish = resolve; });
    return { vectors: texts.map(() => vector()), usage: {} };
  } } });
  const g = graph(1, Array.from({ length: 40 }, (_, i) => ({ id: `extra:${i}`, subjectId: 'smith',
    statement: `Public memory ${i}`, visibility: 'public', privacy: 'public' })));
  service.configure({ provider: 'qwen' }); service.warm(g, 'keeper');
  const pending = service.index(g, 'keeper', 'qwen').promise;
  await started;
  service.configure({ provider: 'baseline', compare: false });
  finish(); await pending;
  assert.equal(calls.length, 1);
  assert.equal(service.index(g, 'keeper', 'qwen').status, 'paused');
  assert.equal(service.status, 'Current graph retrieval');
  assert.deepEqual(service.providers(), []);
});

test('semantic candidates recover a paraphrase while preserving knowledge access and packet limits', async () => {
  const client = fakeClient(), service = new NpcSemanticRetrieval({ client });
  const g = graph();
  service.configure({ provider: 'qwen' });
  await service.prepare(g, 'keeper', 'qwen');
  const packet = await service.retrieve(g, request);
  assert.equal(facts(packet)[0].id, 'repair');
  assert.equal(facts(packet).length, 1);
  assert.ok(client.calls.every(call => call.texts.every(text => !text.includes('hidden debt'))), 'inaccessible facts never reach the embedder');
  const forced = retrieveNpcNarrative(g, { ...request, maxFacts: 8, semanticScores: new Map([['secret', 1], ['disputed', 1]]) });
  assert.ok(!facts(forced).some(fact => fact.id === 'secret'));
  assert.ok(forced.consistencyOnly.some(fact => fact.id === 'disputed'));
});

test('named entities are not displaced by semantic candidates about a different person', () => {
  const g = graph(1, [{ id: 'other', statement: 'Alder repairs things.', subjectId: 'keeper', visibility: 'public', privacy: 'public' }]);
  const baseline = retrieveNpcNarrative(g, { ...request, text: 'Mira', maxFacts: 8 });
  const hybrid = retrieveNpcNarrative(g, { ...request, text: 'Mira', maxFacts: 8, semanticScores: new Map([['other', 1]]) });
  assert.deepEqual(hybrid, baseline);
});

test('provider caches stay separate, content updates re-embed, and access is speaker scoped', async () => {
  const client = fakeClient(), service = new NpcSemanticRetrieval({ client });
  const g = graph();
  service.configure({ provider: 'qwen' });
  await service.prepare(g, 'keeper', 'qwen');
  await service.retrieve(g, request);
  const count = client.calls.length;
  await service.retrieve(g, request);
  assert.equal(client.calls.length, count, 'warm document and query caches eliminate repeat calls');
  service.configure({ provider: 'gemini' });
  await service.prepare(g, 'keeper', 'gemini');
  await service.retrieve(g, request);
  assert.ok(client.calls.some(call => call.provider === 'gemini' && call.purpose === 'query'));
  const updated = graph(2);
  updated.facts.get('repair').statement = 'Mira now mends damaged boats.';
  await service.prepare(updated, 'keeper', 'qwen');
  assert.ok(client.calls.at(-1).texts.some(text => text.includes('boats')));
  await service.prepare(g, 'smith', 'qwen');
  assert.ok(client.calls.at(-1).texts.some(text => text.includes('hidden debt')));
});

test('unavailable providers return the baseline and never cache a partial index as ready', async () => {
  const service = new NpcSemanticRetrieval({ client: { embed: async () => { throw new Error('offline'); } } });
  service.configure({ provider: 'gemini' });
  const g = graph();
  const expected = retrieveNpcNarrative(g, request);
  assert.deepEqual(await service.retrieve(g, request), expected);
  assert.equal(service.runs.at(-1).actualProvider, 'baseline');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(service.index(g, 'keeper', 'gemini').status, 'unavailable');
});

test('replay evaluates both providers against the original snapshot with fresh queries', async () => {
  const client = fakeClient(), service = new NpcSemanticRetrieval({ client });
  const g = graph();
  service.recordBaseline(g, request);
  const id = service.runs[0].id;
  const newer = graph(2);
  newer.facts.delete('repair');
  service.recordBaseline(newer, request);
  service.cooldown.qwen = Date.now() + 30000;
  const replay = await service.replay(id);
  assert.equal(replay.results.qwen.packet.worldRevision, '1');
  assert.equal(replay.results.gemini.packet.worldRevision, '1');
  assert.equal(replay.results.qwen.facts[0].id, 'repair');
  assert.equal(replay.results.qwen.queryCacheHit, false);
  assert.deepEqual(retrievalQuality([{ id: 'wrong' }, { id: 'repair' }], ['repair']), { recall: 1, precision: 0.5, reciprocalRank: 0.5 });
});

test('background indexing and explicit replay can outlast the gameplay query deadline', async () => {
  const client = new NpcEmbeddingClient({ timeoutMs: 5, indexingTimeoutMs: 200,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ model: EMBEDDING_PROVIDERS.qwen.model,
        dimensions: EMBEDDING_DIMENSIONS, formatVersion: 1, vectors: [vector()] })), 30);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    }),
  });
  await assert.rejects(client.embed('qwen', 'query', ['cart']), /aborted/);
  assert.equal((await client.embed('qwen', 'document', ['cart'])).vectors.length, 1);
  assert.equal((await client.embed('qwen', 'query', ['cart'], { timeoutMs: 200 })).vectors.length, 1);
});

test('baseline and hybrid cache keys cannot contaminate each other', () => {
  const g = graph(), cache = createNarrativeRetrievalCache();
  const baseline = retrieveNpcNarrative(g, request, cache);
  const hybrid = retrieveNpcNarrative(g, { ...request, semanticScores: new Map([['repair', 1]]) }, cache);
  assert.equal(hybrid.cacheHit, false);
  assert.equal(facts(hybrid)[0].id, 'repair');
  assert.deepEqual(retrieveNpcNarrative(g, request, cache).speakable, baseline.speakable);
});

test('gateway adapter enforces provider identity, dimension, finite normalized vectors and timeout', async () => {
  const client = new NpcEmbeddingClient({ fetchImpl: async () => Response.json({
    model: EMBEDDING_PROVIDERS.qwen.model, dimensions: EMBEDDING_DIMENSIONS, formatVersion: 1, vectors: [vector(2)],
  }) });
  assert.equal((await client.embed('qwen', 'query', ['cart'])).vectors[0][0], 1);
  await assert.rejects(client.embed('gemini', 'query', ['cart']), /incompatible/);
  const bad = new NpcEmbeddingClient({ fetchImpl: async () => Response.json({ model: EMBEDDING_PROVIDERS.qwen.model,
    dimensions: EMBEDDING_DIMENSIONS, formatVersion: 1, vectors: [vector(0)] }) });
  await assert.rejects(bad.embed('qwen', 'query', ['cart']), /norm/);
  const slow = new NpcEmbeddingClient({ timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  await assert.rejects(slow.embed('qwen', 'query', ['cart']), /aborted/);
  assert.match(embeddingInput('gemini', 'query', 'cart'), /^task: search result \| query:/);
  assert.match(embeddingInput('gemini', 'document', 'cart'), /^title: none \| text:/);
});

test('a retraction during pending inference is revalidated against the current world', async () => {
  const original = npcSemanticRetrieval.client;
  let releaseQuery, queryStarted;
  const started = new Promise(resolve => { queryStarted = resolve; });
  npcSemanticRetrieval.client = { async embed(_provider, purpose, texts) {
    if (purpose === 'query') {
      queryStarted();
      await new Promise(resolve => { releaseQuery = resolve; });
    }
    return { vectors: texts.map(() => vector()), usage: {} };
  } };
  try {
    npcSemanticRetrieval.configure({ provider: 'qwen', compare: false });
    const state = { revision: 1, narrativeFacts: { repair: { id: 'repair', statement: 'Mira mends wagons.',
      subjectId: 'smith', visibility: 'public', privacy: 'public' } } };
    const context = { npc: { id: 'keeper', name: 'Alder' }, homeCommunity: { residents: [
      { id: 'keeper', name: 'Alder', role: 'keeper' }, { id: 'smith', name: 'Mira', role: 'smith' },
    ] } };
    const session = createNpcNarrativeConversation({ state, context });
    await npcSemanticRetrieval.prepare(session.graph, 'keeper', 'qwen');
    const pending = retrieveNpcConversationNarrative(session, { state, context, text: request.text });
    await started;
    state.narrativeFacts.repair.status = 'retracted'; state.revision++;
    releaseQuery();
    const packet = await pending;
    assert.equal(packet.worldRevision, '2');
    assert.ok(!facts(packet).some(fact => fact.id === 'repair'));
    assert.equal(npcSemanticRetrieval.runs.at(-1).staleRevision, true);
    assert.equal(npcSemanticRetrieval.runs.at(-1).actualProvider, 'baseline');
  } finally {
    npcSemanticRetrieval.configure({ provider: 'baseline', compare: false });
    npcSemanticRetrieval.client = original;
  }
});
