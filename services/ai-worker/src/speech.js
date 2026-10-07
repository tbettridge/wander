import { NPC_TTS_MODEL, NPC_PREBUILT_VOICES, parseNpcDelivery } from '../../../src/npcspeech.mjs';

export function speechPayload(body, env) {
  if (typeof body?.input !== 'string' || !body.input.trim() || body.input.length > 1200
    || typeof body.npcId !== 'string' || body.npcId.length > 160
    || (body.style !== undefined && (typeof body.style !== 'string' || body.style.length > 160))
    || !NPC_PREBUILT_VOICES.includes(body.voice)) return null;
  let voices = {};
  try { voices = JSON.parse(env.NPC_VOICES_JSON || '{}'); } catch { /* preset fallback */ }
  const custom = Object.hasOwn(voices || {}, body.npcId) ? voices[body.npcId] : null;
  const voice = typeof custom === 'string' && /^voice_[a-zA-Z0-9_-]{1,120}$/.test(custom)
    ? custom : body.voice;
  const input = parseNpcDelivery(body.input).segments.map((part) => part.input).join(' ');
  if (!input) return null;
  return {
    model: NPC_TTS_MODEL, input, voice, response_format: 'pcm',
    provider: { options: { 'google-ai-studio': {
      speech_metadata: { style: (body.style || '').trim() },
    }, 'google-vertex': {
      speech_metadata: { style: (body.style || '').trim() },
    } } },
  };
}

export async function proxySpeech(request, env, headers, payload) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  const timer = setTimeout(abort, 35000);
  const error = (status) => Response.json({ error: 'Speech provider unavailable' }, {
    status, headers: { ...headers, 'cache-control': 'no-store', ...(status === 429 ? { 'retry-after': '60' } : {}) },
  });
  try {
    const response = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST', headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal,
    });
    if (!response.ok || !/audio\/(?:pcm|l16)/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel();
      return error(response.status === 429 ? 429 : 502);
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 6000000) { await reader.cancel(); return error(502); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (!size || size % 2 || controller.signal.aborted) return error(502);
    const pcm = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(pcm, { headers: { ...headers, 'content-type': 'audio/pcm', 'cache-control': 'no-store' } });
  } catch { return error(controller.signal.aborted ? 504 : 502); }
  finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
}
