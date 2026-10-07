import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { AIBudget } from '../services/ai-worker/src/index.js';
import { NPC_TTS_MODEL, NPC_DIALOGUE_SCHEMA } from '../src/npcspeech.mjs';
import { npcCastKeys } from '../src/npcvoiceidentity.mjs';

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
    assert.equal(response.headers.get('x-wander-voice-source'), 'preset');
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

const castKey = 'yorkshire:female:elder:0';
const googleEnv = { ...env, GEMINI_API_KEY: 'fake-google-key',
  NPC_VOICE_BANK_JSON: JSON.stringify({ [castKey]: 'voice_grandmother' }) };

test('designed regional voices use their Google project and retain delivery cues without leaking keys', async () => {
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = { url, ...options, body: JSON.parse(options.body) };
    return Response.json({ steps: [{ type: 'model_output', content: [
      { type: 'audio', mime_type: 'audio/l16;rate=24000', data: 'AAABAA==' },
      { type: 'audio', mime_type: 'audio/l16', data: 'AgADAA==' },
    ] }] });
  };
  try {
    const response = await worker.fetch(request({ ...body, voiceKey: castKey }), googleEnv);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://wander.example');
    assert.equal(response.headers.get('content-type'), 'audio/pcm');
    assert.equal(response.headers.get('x-wander-voice-source'), 'designed');
    assert.equal(response.headers.get('access-control-expose-headers'), 'x-wander-voice-source');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 0, 1, 0, 2, 0, 3, 0]));
    assert.equal(sent.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(sent.headers['x-goog-api-key'], 'fake-google-key');
    assert.equal(sent.headers.authorization, undefined);
    assert.equal(sent.body.model, 'gemini-3.8-flash-tts');
    assert.deepEqual(sent.body.response_format, { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 });
    assert.deepEqual(sent.body.generation_config.speech_config, [{ voice: 'voice_grandmother' }]);
    assert.equal(sent.body.input[0].content[0].text, body.input);
    assert.deepEqual(sent.body.input[0].content[0].annotations, [{ type: 'speech_metadata', style: body.style }]);
    assert.ok(!JSON.stringify(sent.body).includes('fake-google-key'));
    // A hand-authored NPC voice takes precedence over the shared cast slot.
    await worker.fetch(request({ ...body, voiceKey: castKey }), {
      ...googleEnv, NPC_VOICES_JSON: '{"npc:maren":"voice_personal"}',
    });
    assert.equal(sent.body.generation_config.speech_config[0].voice, 'voice_personal');
    await worker.fetch(request({ ...body, voiceKey: castKey }), {
      ...googleEnv, NPC_VOICE_BANK_JSON: JSON.stringify({ [castKey]: 'en-gb-advisor-1' }),
    });
    assert.equal(sent.body.generation_config.speech_config[0].voice, 'en-gb-advisor-1');
  } finally { globalThis.fetch = original; }
});

test('cast selection is a fixed allowlist with preset fallback until Google is configured', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://openrouter.ai/api/v1/audio/speech');
    const sent = JSON.parse(options.body);
    assert.equal(sent.voice, 'Kore');
    assert.equal(sent.googleVoice, undefined);
    assert.equal(sent.voiceKey, undefined);
    assert.ok(!JSON.stringify(sent).includes('voice_grandmother'));
    return new Response(new Uint8Array([0, 0]), { headers: { 'content-type': 'audio/pcm' } });
  };
  try {
    assert.equal((await worker.fetch(request({ ...body, voiceKey: castKey }), { ...googleEnv, GEMINI_API_KEY: null })).status, 200);
    assert.equal((await worker.fetch(request({ ...body, voiceKey: 'irish:male:adult:1' }), googleEnv)).status, 200);
    assert.equal((await worker.fetch(request({ ...body, voiceKey: castKey }), {
      ...googleEnv, NPC_VOICE_BANK_JSON: JSON.stringify({ [castKey]: 'https://other-provider' }),
    })).status, 200);
    assert.equal((await worker.fetch(request({ ...body, voiceKey: 'invent-a-voice' }), googleEnv)).status, 400);
    assert.equal((await worker.fetch(request({ ...body, voiceKey: {} }), googleEnv)).status, 400);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

test('health distinguishes a complete regional cast from partial and preset setup without exposing credentials or IDs', async () => {
  const get = (config) => worker.fetch(new Request('https://ai.example/health', {
    headers: { origin: 'https://wander.example' },
  }), config);
  const preset = await (await get(env)).json();
  assert.deepEqual(preset.speechVoices, { mode: 'presets', configured: 0, total: 144 });
  const partial = await (await get(googleEnv)).json();
  assert.deepEqual(partial.speechVoices, { mode: 'partial-regional', configured: 1, total: 144 });
  const bank = Object.fromEntries(npcCastKeys().map((key, i) => [key, `voice_test${i}`]));
  bank['constructor:male:adult:0'] = 'voice_injected';
  const full = await (await get({ ...googleEnv, NPC_VOICE_BANK_JSON: JSON.stringify(bank) })).json();
  assert.deepEqual(full.speechVoices, { mode: 'regional', configured: 144, total: 144 });
  assert.ok(!JSON.stringify(full).includes('voice_test'));
  assert.ok(!JSON.stringify(full).includes('fake-google-key'));
  const entries = Object.entries(bank);
  const chunked = { ...googleEnv, NPC_VOICE_BANK_JSON: '{}',
    NPC_VOICE_BANK_0_JSON: JSON.stringify(Object.fromEntries(entries.slice(0, 72))),
    NPC_VOICE_BANK_1_JSON: JSON.stringify(Object.fromEntries(entries.slice(72))),
    NPC_VOICE_BANK_2_JSON: 'malformed',
  };
  assert.deepEqual((await (await get(chunked)).json()).speechVoices, full.speechVoices);
  assert.deepEqual((await (await get({ ...googleEnv, GEMINI_API_KEY: null,
    NPC_VOICE_BANK_JSON: JSON.stringify(bank) })).json()).speechVoices, preset.speechVoices);
});

test('Google errors, malformed PCM and oversized JSON responses are bounded and sanitized', async () => {
  const original = globalThis.fetch;
  let upstream;
  globalThis.fetch = async () => upstream;
  try {
    for (const invalid of [
      new Response('secret-google-error', { status: 401 }),
      Response.json({ steps: [] }),
      Response.json({ output_audio: { mime_type: 'audio/wav', data: 'AAABAA==' } }),
      Response.json({ output_audio: { mime_type: 'audio/l16', data: 'AAAA' } }),
      Response.json({ output_audio: { mime_type: 'audio/l16', data: 'invalid@base64' } }),
      new Response('x'.repeat(12000001)),
    ]) {
      upstream = invalid;
      const response = await worker.fetch(request({ ...body, voiceKey: castKey }), googleEnv);
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: 'Speech provider unavailable' });
    }
    upstream = new Response('secret-rate-limit-detail', { status: 429 });
    const response = await worker.fetch(request({ ...body, voiceKey: castKey }), googleEnv);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
  } finally { globalThis.fetch = original; }
});

test('cancelling designed-voice speech aborts the Google project request', async () => {
  const original = globalThis.fetch;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  globalThis.fetch = async (url, { signal }) => new Promise((resolve, reject) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    entered(); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  try {
    const controller = new AbortController();
    const pending = worker.fetch(request({ ...body, voiceKey: castKey }, controller.signal), googleEnv);
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
