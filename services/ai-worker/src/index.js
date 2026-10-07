// Anonymous game clients share a bounded inference budget. The provider key,
// model choice, token limits and billing controls belong to the server.
import { speechPayload, proxySpeech } from './speech.js';
import { NPC_TTS_MODEL } from '../../../src/npcspeech.mjs';
export const MODEL = 'qwen/qwen3.7-flash';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

function limit(value, fallback, max) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}

async function boundedText(body, maxBytes) {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error('payload too large');
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || url.origin;
    const origins = String(env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim());
    if (!origins.includes(origin)) return json({ error: 'origin not allowed' }, 403);
    const headers = {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (['/health', '/api/ai/health'].includes(url.pathname) && request.method === 'GET') {
      return json({ configured: Boolean(env.OPENROUTER_API_KEY && env.AI_BUDGET), model: MODEL, speechModel: NPC_TTS_MODEL }, 200, headers);
    }
    const speech = ['/speech', '/api/ai/speech'].includes(url.pathname);
    if ((!speech && !['/chat', '/api/ai/chat'].includes(url.pathname)) || request.method !== 'POST') {
      return json({ error: 'not found' }, 404, headers);
    }
    if (!env.OPENROUTER_API_KEY || !env.AI_BUDGET) {
      return json({ error: 'AI gateway not configured' }, 503, headers);
    }
    if (!request.headers.get('content-type')?.startsWith('application/json')) {
      return json({ error: 'JSON required' }, 415, headers);
    }
    let body;
    let bytes;
    try {
      const text = await boundedText(request.body, MAX_BODY_BYTES);
      bytes = new TextEncoder().encode(text).byteLength;
      body = JSON.parse(text);
    } catch (error) {
      return json({ error: 'invalid request' }, error.message === 'payload too large' ? 413 : 400, headers);
    }
    const payload = speech ? speechPayload(body, env) : null;
    if (speech && !payload) return json({ error: 'invalid speech request' }, 400, headers);
    if (!speech && (!Array.isArray(body?.messages) || body.messages.length < 2 || body.messages.length > 40
      || body.messages[0]?.role !== 'system' || body.messages.at(-1)?.role !== 'user'
      || body.messages.some((message) => !['system', 'user', 'assistant'].includes(message?.role)
        || typeof message.content !== 'string' || !message.content.trim())
      || (body.schema !== undefined && (!body.schema || body.schema.type !== 'object')))) {
      return json({ error: 'invalid messages or schema' }, 400, headers);
    }
    // This Durable Object is shared across isolates, so limits survive worker
    // restarts and cannot be multiplied by making new browser API keys.
    const budget = env.AI_BUDGET.get(env.AI_BUDGET.idFromName('shared'));
    const ip = request.headers.get('CF-Connecting-IP') || 'local-development';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
    const client = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const admitted = await budget.fetch(new Request('https://budget/admit', {
      method: 'POST', body: JSON.stringify({ client, bytes, kind: speech ? 'speech' : 'chat' }),
    }));
    if (!admitted.ok) return json({ error: 'AI request budget exceeded' }, 429, {
      ...headers, 'retry-after': admitted.headers.get('retry-after') || '60',
    });
    if (speech) return proxySpeech(request, env, headers, payload);
    const messages = body.messages.map(({ role, content }) => ({ role, content }));
    const dialogue = Boolean(body.schema?.properties?.segments);
    if (body.schema) messages[0].content += `\n\nReturn only a JSON object conforming to this schema. This overrides prose formatting instructions for this request: ${JSON.stringify(body.schema)}`;
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages,
          stream: false,
          max_tokens: body.schema ? dialogue ? 650 : 1600 : 350,
          temperature: body.schema && !dialogue ? 0.2 : 0.8,
          reasoning: { enabled: false },
          ...(body.schema ? { response_format: { type: 'json_object' } } : {}),
          provider: { require_parameters: true },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status === 429 ? 429 : 502;
        return json({ error: 'AI provider unavailable' }, status,
          status === 429 ? { ...headers, 'retry-after': '60' } : headers);
      }
      const result = JSON.parse(await boundedText(response.body, MAX_RESPONSE_BYTES));
      const choice = result.choices?.[0];
      const text = choice?.message?.content;
      if (choice?.finish_reason === 'length' || typeof text !== 'string' || !text.trim()) {
        return json({ error: 'AI response incomplete' }, 502, headers);
      }
      if (body.schema) JSON.parse(text);
      return json({ text, model: MODEL }, 200, headers);
    } catch {
      return json({ error: 'AI provider unavailable' }, controller.signal.aborted ? 504 : 502, headers);
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', abort);
    }
  },
};

export class AIBudget {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    return this.state.blockConcurrencyWhile(async () => {
      const { client, bytes, kind } = await request.json();
      const speech = kind === 'speech';
      const usageKey = speech ? 'speech-usage' : 'usage';
      const now = Date.now();
      const minute = Math.floor(now / 60000);
      const day = Math.floor(now / 86400000);
      let usage = await this.state.storage.get(usageKey);
      if (!usage || usage.day !== day) usage = { day, requests: 0, bytes: 0, minute, recent: 0, clients: {} };
      if (usage.minute !== minute) Object.assign(usage, { minute, recent: 0, clients: {} });
      const config = (name, chatDefault, speechDefault, max) => limit(
        this.env[`${speech ? 'SPEECH_' : ''}${name}`], speech ? speechDefault : chatDefault, max);
      const dailyExceeded = usage.requests >= config('DAILY_REQUEST_LIMIT', 10000, 5000, 1000000)
        || usage.bytes + bytes > config('DAILY_INPUT_BYTE_LIMIT', 32000000, 2000000, 1000000000);
      if (dailyExceeded || usage.recent >= config('REQUESTS_PER_MINUTE', 1200, 600, 10000)
        || (usage.clients[client] || 0) >= config('REQUESTS_PER_CLIENT_MINUTE', 30, 20, 300)) {
        const reset = dailyExceeded ? (day + 1) * 86400000 : (minute + 1) * 60000;
        return json({ allowed: false }, 429, { 'retry-after': String(Math.ceil((reset - now) / 1000)) });
      }
      usage.requests++;
      usage.recent++;
      usage.bytes += bytes;
      usage.clients[client] = (usage.clients[client] || 0) + 1;
      await this.state.storage.put(usageKey, usage);
      return json({ allowed: true });
    });
  }
}
