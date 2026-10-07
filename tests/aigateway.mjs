import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { AIBudget, MODEL } from '../services/ai-worker/src/index.js';

const messages = [{ role: 'system', content: 'You are Maren.' }, { role: 'user', content: 'Hello.' }];
const env = {
  ALLOWED_ORIGINS: 'https://wander.example', OPENROUTER_API_KEY: 'fake-test-key',
  AI_BUDGET: { idFromName: () => 'shared', get: () => ({ fetch: async () => Response.json({ allowed: true }) }) },
};
function request(body = { messages }, path = '/chat') {
  return new Request(`https://ai.example${path}`, { method: 'POST',
    headers: { origin: 'https://wander.example', 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('gateway health and origin checks never call the provider', async () => {
  assert.equal((await worker.fetch(new Request('https://ai.example/health', {
    headers: { origin: 'https://wander.example' },
  }), env)).status, 200);
  assert.equal((await worker.fetch(new Request('https://ai.example/health'), env)).status, 403);
  assert.equal((await worker.fetch(request(), { ...env, OPENROUTER_API_KEY: undefined })).status, 503);
  const preflight = await worker.fetch(new Request('https://ai.example/chat', {
    method: 'OPTIONS', headers: { origin: 'https://wander.example' },
  }), env);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://wander.example');
});

test('gateway fixes model, disables thinking and bounds outputs regardless of client parameters', async () => {
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = { url, ...options, body: JSON.parse(options.body) };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Good morning.' } }] });
  };
  try {
    const response = await worker.fetch(request({ messages, model: 'expensive-model', max_tokens: 100000,
      reasoning: { enabled: true }, stream: true }), env);
    assert.equal((await response.json()).text, 'Good morning.');
    assert.equal(sent.body.model, MODEL);
    assert.equal(sent.body.max_tokens, 350);
    assert.deepEqual(sent.body.reasoning, { enabled: false });
    assert.equal(sent.headers.authorization, 'Bearer fake-test-key');
    assert.equal(JSON.stringify(await worker.fetch(request(), env)).includes('fake-test-key'), false);
  } finally { globalThis.fetch = original; }
});

test('gateway rejects oversized/invalid prompts and exhausted shared budget before inference', async () => {
  assert.equal((await worker.fetch(request({ messages: [] }), env)).status, 400);
  assert.equal((await worker.fetch(request({ messages: [{ role: 'system', content: 'x'.repeat(65536) }, messages[1]] }), env)).status, 413);
  const limited = { ...env, AI_BUDGET: { idFromName: () => 'shared', get: () => ({
    fetch: async () => new Response(null, { status: 429, headers: { 'retry-after': '123' } }),
  }) } };
  const response = await worker.fetch(request(), limited);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '123');
});

test('JSON synthesis uses supported JSON-object mode and rejects invalid/truncated output without leaking provider errors', async () => {
  const original = globalThis.fetch;
  let result = { choices: [{ finish_reason: 'stop', message: { content: '{"summary":"A meeting."}' } }] };
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.max_tokens, 1600);
    assert.match(body.messages[0].content, /schema/);
    assert.equal(body.messages.at(-1).role, 'user');
    return Response.json(result);
  };
  try {
    const body = { messages, schema: { type: 'object', properties: { summary: { type: 'string' } } } };
    assert.equal((await worker.fetch(request(body), env)).status, 200);
    result.choices[0].message.content = 'not JSON';
    assert.equal((await worker.fetch(request(body), env)).status, 502);
    result.choices[0].finish_reason = 'length';
    assert.equal((await worker.fetch(request(body), env)).status, 502);
    globalThis.fetch = async () => new Response('upstream-secret-detail', { status: 401 });
    const response = await worker.fetch(request(body), env);
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes('upstream-secret-detail'), false);
  } finally { globalThis.fetch = original; }
});

function stateWithStorage(saved) {
  let value = saved;
  let queue = Promise.resolve();
  return {
    storage: { get: async () => structuredClone(value), put: async (key, next) => { value = structuredClone(next); } },
    blockConcurrencyWhile: (callback) => { const work = queue.then(callback); queue = work.catch(() => {}); return work; },
  };
}
function admission(client = 'client-a', bytes = 100) {
  return new Request('https://budget/admit', { method: 'POST', body: JSON.stringify({ client, bytes }) });
}

test('persistent shared budget enforces per-client, total and daily byte limits atomically', async () => {
  const state = stateWithStorage();
  const config = { REQUESTS_PER_CLIENT_MINUTE: '2', REQUESTS_PER_MINUTE: '3', DAILY_INPUT_BYTE_LIMIT: '300' };
  const budget = new AIBudget(state, config);
  assert.equal((await budget.fetch(admission())).status, 200);
  assert.equal((await budget.fetch(admission())).status, 200);
  assert.equal((await budget.fetch(admission())).status, 429);
  const restarted = new AIBudget(state, config);
  assert.equal((await restarted.fetch(admission('client-b'))).status, 200);
  assert.equal((await restarted.fetch(admission('client-c'))).status, 429);
  const concurrent = new AIBudget(stateWithStorage(), { REQUESTS_PER_MINUTE: '3' });
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => concurrent.fetch(admission(`client-${index}`))));
  assert.equal(results.filter(({ status }) => status === 200).length, 3);
});
