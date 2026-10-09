// Both hosted models use 768 dimensions, but remain separate vector spaces.
export const EMBEDDING_DIMENSIONS = 768;
export const EMBEDDING_PROVIDERS = Object.freeze({
  qwen: { model: '@cf/qwen/qwen3-embedding-0.6b', price: 0.012 },
  gemini: { model: 'gemini-embedding-2', price: 0.20 },
});
export const EMBEDDING_FORMAT_VERSION = 1;

export function embeddingInput(provider, purpose, text) {
  if (!Object.hasOwn(EMBEDDING_PROVIDERS, provider) || !['query', 'document'].includes(purpose)) throw new Error('Invalid embedding provider or purpose.');
  if (provider === 'gemini') return purpose === 'query'
    ? `task: search result | query: ${text}` : `title: none | text: ${text}`;
  return purpose === 'query'
    ? `Instruct: Given a question about a fictional world, retrieve relevant facts and memories that answer it.\nQuery: ${text}` : text;
}

export function normalizedEmbedding(values, dimensions = EMBEDDING_DIMENSIONS) {
  if (!Array.isArray(values) || values.length < dimensions || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Invalid embedding vector.');
  }
  const vector = values.slice(0, dimensions);
  const norm = Math.hypot(...vector);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Invalid embedding norm.');
  return vector.map(value => value / norm);
}

export class NpcEmbeddingClient {
  constructor({ endpoint = globalThis.WANDER_AI_URL || '/api/ai', fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 4000, indexingTimeoutMs = 12000 } = {}) {
    this.endpoint = String(endpoint).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.indexingTimeoutMs = indexingTimeoutMs;
  }

  async embed(provider, purpose, texts, { timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? (purpose === 'document' ? this.indexingTimeoutMs : this.timeoutMs));
    try {
      const response = await this.fetchImpl(`${this.endpoint}/embeddings`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, purpose, texts }), signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Embedding gateway unavailable (${response.status}).`);
      const result = await response.json();
      if (result.model !== EMBEDDING_PROVIDERS[provider]?.model || result.dimensions !== EMBEDDING_DIMENSIONS
        || result.formatVersion !== EMBEDDING_FORMAT_VERSION || result.vectors?.length !== texts.length) {
        throw new Error('Embedding gateway returned an incompatible model or shape.');
      }
      return { ...result, vectors: result.vectors.map(vector => normalizedEmbedding(vector)) };
    } finally { clearTimeout(timer); }
  }
}
