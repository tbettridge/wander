import { LivingWorldAI } from './livingworld.mjs?v=speech3';
import { ContextPressureError } from './livingworldairuntime.mjs';

export const OPENROUTER_MODEL = 'qwen/qwen3.7-flash';

export function savedAIProvider(storage) {
  try { return (storage || globalThis.localStorage)?.getItem('wander.livingWorld.provider') === 'local' ? 'local' : 'openrouter'; }
  catch { return 'openrouter'; }
}

// Adapt the existing session interface so prompts, memory validation and
// recovery stay identical for local and hosted inference. No provider key is
// accepted here: this endpoint is WANDER's server-side gateway.
export class OpenRouterLivingWorldAI extends LivingWorldAI {
  constructor({ endpoint = globalThis.WANDER_AI_URL || '/api/ai', fetchImpl = (...args) => globalThis.fetch(...args), ...options } = {}) {
    super(options);
    this.endpoint = String(endpoint).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.provider = 'openrouter';
  }

  async availability({ signal } = {}) {
    const response = await this.fetchImpl(`${this.endpoint}/health`, { signal });
    if (!response.ok) return 'unavailable';
    const health = await response.json();
    return health.configured === true ? 'available' : 'unavailable';
  }

  async _createSession({ systemPrompt, signal } = {}) {
    signal?.throwIfAborted();
    // Only the warm initialization probes the gateway; chat sessions are
    // lightweight message histories and do not make a billable request.
    if (!systemPrompt && await this.availability({ signal }) !== 'available') {
      throw new Error('OpenRouter gateway is unavailable or not configured.');
    }
    signal?.throwIfAborted();
    return new GatewaySession(this, systemPrompt || 'You are a resident of WANDER.');
  }
}

class GatewaySession {
  constructor(ai, systemPrompt) {
    this.ai = ai;
    this.messages = [{ role: 'system', content: systemPrompt }];
    this.contextWindow = 16000;
    this.closed = new AbortController();
  }

  get contextUsage() {
    return this.messages.reduce((sum, message) => sum + Math.ceil(message.content.length / 3), 0);
  }

  measureContextUsage(prompt, { responseConstraint } = {}) {
    return Math.ceil((String(prompt).length + JSON.stringify(responseConstraint || {}).length) / 3);
  }

  async prompt(content, { signal, responseConstraint } = {}) {
    const controller = new AbortController();
    const relay = () => controller.abort(signal?.aborted ? signal.reason : this.closed.signal.reason);
    signal?.addEventListener('abort', relay, { once: true });
    this.closed.signal.addEventListener('abort', relay, { once: true });
    if (signal?.aborted || this.closed.signal.aborted) relay();
    const messages = [...this.messages, { role: 'user', content: String(content) }];
    try {
      controller.signal.throwIfAborted();
      const response = await this.ai.fetchImpl(`${this.ai.endpoint}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, ...(responseConstraint ? { schema: responseConstraint } : {}) }),
        signal: controller.signal,
      });
      if (response.status === 413) throw new ContextPressureError('Cloud prompt needs compaction.');
      if (!response.ok) throw new Error(`OpenRouter gateway request failed (${response.status}).`);
      const result = await response.json();
      controller.signal.throwIfAborted();
      if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('Cloud model returned an empty reply.');
      const text = result.text.trim();
      // Failed or cancelled turns never become part of subsequent prompts.
      this.messages = [...messages, { role: 'assistant', content: text }];
      return text;
    } finally {
      signal?.removeEventListener('abort', relay);
      this.closed.signal.removeEventListener('abort', relay);
    }
  }

  destroy() {
    this.closed.abort(new DOMException('AI session closed.', 'AbortError'));
    this.messages = [];
  }
}
