import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { AIBudget } from '../services/ai-worker/src/index.js';
import { liveTokenPayload } from '../services/ai-worker/src/live.js';

const body = { npcId: 'npc:maren', voice: 'Kore', prompt: 'You are Maren, a Scottish station keeper. Speak English.' };
const env = { ALLOWED_ORIGINS: 'https://wander.example', OPENROUTER_API_KEY: 'fake-router-key', GEMINI_API_KEY: 'fake-google-key',
  AI_BUDGET: { idFromName: () => 'shared', get: () => ({ fetch: async request => {
    assert.equal((await request.json()).kind, 'live'); return Response.json({ allowed: true });
  } }) } };
const request = (value = body, origin = 'https://wander.example') => new Request('https://ai.example/live-token', {
  method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(value),
});

test('Live credentials constrain the model, voice, tools, context size and three-minute lifetime', () => {
  const payload = liveTokenPayload({ ...body, model: 'expensive', tools: [{ evil: true }], uses: 999 }, 0);
  assert.equal(payload.uses, 1);
  assert.equal(Date.parse(payload.expireTime), 180000);
  assert.equal(Date.parse(payload.newSessionExpireTime), 60000);
  const setup = payload.bidiGenerateContentSetup;
  assert.equal(setup.model, 'models/gemini-3.8-live');
  assert.equal(setup.generationConfig.enableAffectiveDialog, undefined, 'the current native Live endpoint rejects this optional flag');
  assert.equal(setup.enableAffectiveDialog, undefined, 'SDK options must use the actual WebSocket wire format');
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.equal(setup.contextWindowCompression.slidingWindow.targetTokens, 4096);
  assert.deepEqual(setup.realtimeInputConfig, { automaticActivityDetection: { disabled: true } });
  assert.deepEqual(setup.tools[0].functionDeclarations.map(tool => tool.name), ['lookup_world_context', 'queue_gesture']);
  assert.equal(liveTokenPayload({ ...body, voice: 'voice_injected' }), null);
  assert.equal(liveTokenPayload({ ...body, prompt: 'x'.repeat(36001) }), null);
});

test('gateway returns a short-lived token and setup without exposing either permanent key', async () => {
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = { url, headers: options.headers, body: JSON.parse(options.body) };
    return Response.json({ name: 'auth_tokens/test' });
  };
  try {
    const response = await worker.fetch(request(), env), result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(result.token, 'auth_tokens/test');
    assert.equal(result.setup.model, 'models/gemini-3.8-live');
    assert.equal(sent.headers['x-goog-api-key'], 'fake-google-key');
    assert.ok(!JSON.stringify(result).includes('fake-google-key'));
    assert.ok(!JSON.stringify(result).includes('fake-router-key'));
  } finally { globalThis.fetch = original; }
});

test('invalid, unconfigured, disallowed and exhausted Live requests never reach Google', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not call Google'); };
  try {
    assert.equal((await worker.fetch(request({ ...body, voice: 'unknown' }), env)).status, 400);
    assert.equal((await worker.fetch(request(), { ...env, GEMINI_API_KEY: null })).status, 503);
    assert.equal((await worker.fetch(request(body, 'https://other.example'), env)).status, 403);
    assert.equal((await worker.fetch(request(), { ...env, AI_BUDGET: { idFromName: () => 'shared', get: () => ({
      fetch: async () => new Response(null, { status: 429, headers: { 'retry-after': '60' } }),
    }) } })).status, 429);
  } finally { globalThis.fetch = original; }
});

test('persistent Live budget is isolated from chat and speech and bounds renewal attempts', async () => {
  const store = new Map();
  const state = { blockConcurrencyWhile: callback => callback(), storage: {
    get: async key => structuredClone(store.get(key)), put: async (key, value) => store.set(key, structuredClone(value)),
  } };
  const admit = kind => new Request('https://budget/admit', { method: 'POST', body: JSON.stringify({ kind, client: 'one', bytes: 10 }) });
  const budget = new AIBudget(state, { LIVE_DAILY_REQUEST_LIMIT: '1' });
  assert.equal((await budget.fetch(admit('live'))).status, 200);
  assert.equal((await new AIBudget(state, { LIVE_DAILY_REQUEST_LIMIT: '1' }).fetch(admit('live'))).status, 429);
  assert.equal((await budget.fetch(admit('chat'))).status, 200);
  assert.equal((await budget.fetch(admit('speech'))).status, 200);
});
