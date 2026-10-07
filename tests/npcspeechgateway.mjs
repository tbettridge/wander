import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { AIBudget } from '../services/ai-worker/src/index.js';
import { NPC_TTS_MODEL, NPC_DIALOGUE_SCHEMA } from '../src/npcspeech.mjs';

const env = { ALLOWED_ORIGINS: 'https://wander.example', OPENROUTER_API_KEY: 'fake-key',
  AI_BUDGET: { idFromName: () => 'shared', get: () => ({ fetch: async () => Response.json({ allowed: true }) }) } };
const body = { npcId: 'npc:maren', voice: 'Kore', input: 'Hello. <chuckle>', style: 'warm and amused' };
const request = (value = body, signal, path = '/speech') => new Request(`https://ai.example${path}`, {
  method: 'POST', headers: { origin: 'https://wander.example', 'content-type': 'application/json' },
  body: JSON.stringify(value), signal,
});

test('speech gateway fixes Gemini Flash, PCM, preset/custom voice and metadata without exposing its key', async () => {
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = { url, ...options, body: JSON.parse(options.body) };
    return new Response(new Uint8Array([0, 0, 1, 0]), { headers: { 'content-type': 'audio/pcm' } });
  };
  try {
    const response = await worker.fetch(request({ ...body, model: 'expensive', response_format: 'mp3', provider: {} }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/pcm');
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://wander.example');
    assert.equal(sent.url, 'https://openrouter.ai/api/v1/audio/speech');
    assert.equal(sent.body.model, NPC_TTS_MODEL);
    assert.equal(sent.body.response_format, 'pcm');
    assert.equal(sent.body.input, body.input);
    assert.equal(sent.body.provider.options['google-ai-studio'].speech_metadata.style, body.style);
    assert.equal(sent.headers.authorization, 'Bearer fake-key');
    const configured = { ...env, NPC_VOICES_JSON: '{"npc:maren":"voice_custom123"}' };
    await worker.fetch(request(), configured);
    assert.equal(sent.body.voice, 'voice_custom123');
    assert.equal((await worker.fetch(request({ ...body, voice: 'voice_clientInjected' }), env)).status, 400);
  } finally { globalThis.fetch = original; }
});

test('invalid speech and exhausted budgets are rejected before calling a paid provider', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not call'); };
  try {
    assert.equal((await worker.fetch(request({ ...body, input: 'x'.repeat(1201) }), env)).status, 400);
    assert.equal((await worker.fetch(request({ ...body, style: 'x'.repeat(161) }), env)).status, 400);
    assert.equal((await worker.fetch(request(), { ...env, OPENROUTER_API_KEY: null })).status, 503);
    const limited = { ...env, AI_BUDGET: { idFromName: () => 'shared', get: () => ({ fetch: async (admission) => {
      assert.equal((await admission.json()).kind, 'speech');
      return new Response(null, { status: 429, headers: { 'retry-after': '42' } });
    } }) } };
    const response = await worker.fetch(request(), limited);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '42');
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('speech failures, invalid audio and oversized streams never leak upstream details', async () => {
  const original = globalThis.fetch;
  let upstream = new Response('secret-upstream-detail', { status: 401 });
  globalThis.fetch = async () => upstream;
  try {
    let response = await worker.fetch(request(), env);
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('secret'));
    upstream = new Response('wrong-format', { headers: { 'content-type': 'text/html' } });
    assert.equal((await worker.fetch(request(), env)).status, 502);
    upstream = new Response(new Uint8Array(6000002), { headers: { 'content-type': 'audio/pcm' } });
    assert.equal((await worker.fetch(request(), env)).status, 502);
    upstream = new Response(new Uint8Array(3), { headers: { 'content-type': 'audio/pcm' } });
    assert.equal((await worker.fetch(request(), env)).status, 502);
  } finally { globalThis.fetch = original; }
});

test('speech cancellation reaches the upstream request', async () => {
  const original = globalThis.fetch;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  globalThis.fetch = async (url, { signal }) => new Promise((resolve, reject) => {
    entered(); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  try {
    const controller = new AbortController();
    const pending = worker.fetch(request(body, controller.signal), env);
    await ready; controller.abort();
    assert.equal((await pending).status, 504);
  } finally { globalThis.fetch = original; }
});

test('dialogue JSON uses a bounded creative response instead of the memory synthesis settings', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const sent = JSON.parse(options.body);
    assert.equal(sent.max_tokens, 650);
    assert.equal(sent.temperature, 0.8);
    assert.deepEqual(sent.response_format, { type: 'json_object' });
    return Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: '{"segments":[{"text":"Hello. <chuckle>","style":"amused"}]}',
    } }] });
  };
  try {
    assert.equal((await worker.fetch(request({ messages: [
      { role: 'system', content: 'You are Maren.' }, { role: 'user', content: 'Hello.' },
    ], schema: NPC_DIALOGUE_SCHEMA }, undefined, '/chat'), env)).status, 200);
  } finally { globalThis.fetch = original; }
});

test('speech budgets are persistent and independent of dialogue budgets', async () => {
  const store = new Map();
  let queue = Promise.resolve();
  const state = { storage: { get: async (key) => structuredClone(store.get(key)),
    put: async (key, value) => store.set(key, structuredClone(value)) },
  blockConcurrencyWhile: (callback) => { const next = queue.then(callback); queue = next.catch(() => {}); return next; } };
  const config = { SPEECH_DAILY_REQUEST_LIMIT: '1' };
  const admit = (kind) => new Request('https://budget/admit', { method: 'POST',
    body: JSON.stringify({ kind, client: 'one', bytes: 100 }) });
  const budget = new AIBudget(state, config);
  assert.equal((await budget.fetch(admit('speech'))).status, 200);
  assert.equal((await new AIBudget(state, config).fetch(admit('speech'))).status, 429);
  assert.equal((await budget.fetch(admit('chat'))).status, 200);
});
