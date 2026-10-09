import { EMBEDDING_DIMENSIONS, EMBEDDING_FORMAT_VERSION, EMBEDDING_PROVIDERS, embeddingInput, normalizedEmbedding } from '../../../src/npcembeddings.mjs';

export function embeddingPayload(body) {
  if (!Object.hasOwn(EMBEDDING_PROVIDERS, body?.provider) || !['query', 'document'].includes(body?.purpose)
    || !Array.isArray(body.texts) || !body.texts.length || body.texts.length > 16
    || (body.purpose === 'query' && body.texts.length !== 1)
    || body.texts.some(text => typeof text !== 'string' || !text.trim() || text.length > 2000)) return null;
  return { provider: body.provider, purpose: body.purpose, texts: body.texts.map(text => text.trim()) };
}

export function embeddingAvailability(env) {
  return { qwen: Boolean(env.AI && env.AI_BUDGET), gemini: Boolean(env.GEMINI_API_KEY && env.AI_BUDGET) };
}

export async function proxyEmbeddings(request, env, headers, payload, { boundedText, json }) {
  const { provider, purpose, texts } = payload;
  const model = EMBEDDING_PROVIDERS[provider].model;
  const inputs = texts.map(text => embeddingInput(provider, purpose, text));
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  let timeout;
  try {
    const inference = async () => {
      if (provider === 'qwen') {
        const result = await env.AI.run(model, { text: inputs });
        return result.data;
      }
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`, {
        method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ requests: inputs.map(text => ({ model: `models/${model}`,
          content: { parts: [{ text }] }, outputDimensionality: EMBEDDING_DIMENSIONS })) }),
        signal: controller.signal,
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Embedding provider unavailable.'); }
      const result = JSON.parse(await boundedText(response.body, 512 * 1024));
      return result.embeddings?.map(embedding => embedding.values);
    };
    // Workers AI binding cannot be aborted; bound the response wait as well.
    const vectors = await Promise.race([inference(), new Promise((_, reject) => {
      timeout = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 10000);
    })]);
    if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new Error('Invalid embedding count.');
    const normalized = vectors.map(vector => normalizedEmbedding(vector));
    const estimatedTokens = inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
    return json({ model, dimensions: EMBEDDING_DIMENSIONS, formatVersion: EMBEDDING_FORMAT_VERSION, vectors: normalized,
      usage: { estimatedTokens, estimatedCostUsd: estimatedTokens * EMBEDDING_PROVIDERS[provider].price / 1000000, estimated: true } }, 200, headers);
  } catch {
    return json({ error: 'Embedding provider unavailable' }, controller.signal.aborted ? 504 : 502, headers);
  } finally { clearTimeout(timeout); request.signal.removeEventListener('abort', abort); }
}
