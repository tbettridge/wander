import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { AIBudget } from '../services/ai-worker/src/index.js';
import { EMBEDDING_DIMENSIONS } from '../src/npcembeddings.mjs';

const vector = length => [2, ...Array(length - 1).fill(0)];
const body = { provider: 'qwen', purpose: 'query', texts: ['Who fixes carts?'] };
const request = (value = body, origin = 'https://wander.example', path = '/embeddings') => new Request(`https://ai.example${path}`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(value),
});
const env = { ALLOWED_ORIGINS: 'https://wander.example', GEMINI_API_KEY: 'server-secret',
  AI: { run: async () => ({ data: [vector(1024)] }) },
  AI_BUDGET: { idFromName: () => 'shared', get: () => ({ fetch: async request => {
    assert.equal((await request.json()).kind, 'embeddings'); return Response.json({ allowed: true });
  } }) },
};

test('Qwen binding uses fixed model and query instruction, slices and normalizes vectors without needing OpenRouter', async () => {
  let sent;
  const response = await worker.fetch(request({ ...body, model: 'expensive', dimensions: 3072 }), { ...env, AI: { run: async (model, payload) => {
    sent = { model, payload }; return { data: [vector(1024)] };
  } } });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(sent.model, '@cf/qwen/qwen3-embedding-0.6b');
  assert.match(sent.payload.text[0], /^Instruct:/);
  assert.equal(result.vectors[0].length, EMBEDDING_DIMENSIONS);
  assert.equal(result.vectors[0][0], 1);
  assert.equal(result.usage.estimated, true);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://wander.example');
  assert.ok(!JSON.stringify(result).includes('server-secret'));
});

test('Gemini uses separate batch contents for documents and sends permanent key only upstream', async () => {
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = { url, headers: options.headers, body: JSON.parse(options.body) };
    return Response.json({ embeddings: [{ values: vector(768) }, { values: vector(768) }] });
  };
  try {
    const response = await worker.fetch(request({ provider: 'gemini', purpose: 'document', texts: ['Alder is a keeper.', 'Mira is a smith.'] }), env);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.match(sent.url, /gemini-embedding-2:batchEmbedContents$/);
    assert.equal(sent.headers['x-goog-api-key'], 'server-secret');
    assert.equal(sent.body.requests.length, 2);
    assert.ok(sent.body.requests.every(item => item.model === 'models/gemini-embedding-2' && item.outputDimensionality === 768 && !item.taskType));
    assert.match(sent.body.requests[0].content.parts[0].text, /^title: none \| text:/);
    assert.equal(result.vectors.length, 2);
    assert.ok(!JSON.stringify(result).includes('server-secret'));
  } finally { globalThis.fetch = original; }
});

test('malformed, unconfigured, disallowed and exhausted embedding requests do not run inference', async () => {
  const blockedEnv = { ...env, AI: { run: async () => { throw new Error('must not infer'); } } };
  for (const bad of [null, {}, { ...body, provider: 'toString' }, { ...body, provider: 'other' },
    { ...body, texts: [] }, { ...body, texts: ['one', 'two'] }, { ...body, texts: ['a'.repeat(2001)] },
    { ...body, purpose: 'document', texts: Array(17).fill('fact') }]) {
    assert.equal((await worker.fetch(request(bad), blockedEnv)).status, 400);
  }
  assert.equal((await worker.fetch(request(body, 'https://evil.example'), blockedEnv)).status, 403);
  assert.equal((await worker.fetch(request(), { ...blockedEnv, AI: null })).status, 503);
  assert.equal((await worker.fetch(request({ ...body, provider: 'gemini' }), { ...blockedEnv, GEMINI_API_KEY: null })).status, 503);
  assert.equal((await worker.fetch(request(), { ...blockedEnv, AI_BUDGET: { idFromName: () => 'shared', get: () => ({
    fetch: async () => new Response(null, { status: 429 }),
  }) } })).status, 429);
});

test('invalid provider vectors fail closed rather than entering the index', async () => {
  for (const data of [[], [vector(10)], [Array(768).fill(0)], [vector(768).map(() => NaN)]]) {
    assert.equal((await worker.fetch(request(), { ...env, AI: { run: async () => ({ data }) } })).status, 502);
  }
});

test('embedding budget persists independently from chat, speech and Live', async () => {
  const store = new Map();
  const state = { blockConcurrencyWhile: callback => callback(), storage: {
    get: async key => structuredClone(store.get(key)), put: async (key, value) => store.set(key, structuredClone(value)),
  } };
  const budget = new AIBudget(state, { EMBEDDING_DAILY_REQUEST_LIMIT: '1' });
  const admit = kind => budget.fetch(new Request('https://budget/admit', { method: 'POST', body: JSON.stringify({ kind, client: 'one', bytes: 10 }) }));
  assert.equal((await admit('embeddings')).status, 200);
  assert.equal((await admit('embeddings')).status, 429);
  assert.equal((await admit('chat')).status, 200);
  assert.equal((await admit('speech')).status, 200);
  assert.equal((await admit('live')).status, 200);
});
