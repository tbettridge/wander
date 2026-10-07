import { NPC_TTS_MODEL, NPC_PREBUILT_VOICES, parseNpcDelivery } from '../../../src/npcspeech.mjs';
import { npcCastVoice } from '../../../src/npcvoiceidentity.mjs';

export function speechPayload(body, env) {
  if (typeof body?.input !== 'string' || !body.input.trim() || body.input.length > 1200
    || typeof body.npcId !== 'string' || body.npcId.length > 160
    || (body.style !== undefined && (typeof body.style !== 'string' || body.style.length > 160))
    || !NPC_PREBUILT_VOICES.includes(body.voice)
    || (body.voiceKey !== undefined && !npcCastVoice(body.voiceKey))) return null;
  let voices = {};
  try { voices = JSON.parse(env.NPC_VOICES_JSON || '{}'); } catch { /* preset fallback */ }
  const custom = Object.hasOwn(voices || {}, body.npcId) ? voices[body.npcId] : null;
  let bank = {};
  try { bank = JSON.parse(env.NPC_VOICE_BANK_JSON || '{}'); } catch { /* preset fallback */ }
  const bankVoice = body.voiceKey && Object.hasOwn(bank || {}, body.voiceKey) ? bank[body.voiceKey] : null;
  const validVoice = (value) => typeof value === 'string' && /^voice_[a-zA-Z0-9_-]{1,120}$/.test(value);
  const voice = validVoice(custom) ? custom : body.voice;
  const googleVoice = env.GEMINI_API_KEY && (validVoice(custom) ? custom : validVoice(bankVoice) ? bankVoice : null);
  const input = parseNpcDelivery(body.input).segments.map((part) => part.input).join(' ');
  if (!input) return null;
  const payload = {
    model: NPC_TTS_MODEL, input, voice, response_format: 'pcm',
    provider: { options: { 'google-ai-studio': {
      speech_metadata: { style: (body.style || '').trim() },
    }, 'google-vertex': {
      speech_metadata: { style: (body.style || '').trim() },
    } } },
  };
  // Internal routing metadata is non-enumerable and never forwarded to OpenRouter.
  if (googleVoice) Object.defineProperty(payload, 'googleVoice', { value: googleVoice });
  return payload;
}

async function googleSpeech(payload, env, signal) {
  const style = payload.provider.options['google-ai-studio'].speech_metadata.style;
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-3.8-flash-tts',
      input: [{ type: 'user_input', content: [{ type: 'text', text: payload.input,
        annotations: [{ type: 'speech_metadata', style }] }] }],
      response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
      generation_config: { speech_config: [{ voice: payload.googleVoice }] },
    }), signal,
  });
  if (!response.ok) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 12000000) { await reader.cancel(); throw new Error('Speech response too large'); }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  const result = JSON.parse(text + decoder.decode());
  const parts = result.output_audio ? [result.output_audio]
    : (result.steps || []).filter((step) => step.type === 'model_output')
      .flatMap((step) => (step.content || []).filter((part) => part.type === 'audio'));
  let bytes = 0;
  const chunks = parts.map((part) => {
    if (!/audio\/(?:l16|pcm)(?:;|$)/i.test(part.mime_type || '') || typeof part.data !== 'string') throw new Error('Invalid speech audio');
    const decoded = atob(part.data);
    bytes += decoded.length;
    if (bytes > 6000000) throw new Error('Speech response too large');
    return Uint8Array.from(decoded, (ch) => ch.charCodeAt(0));
  });
  if (!bytes || bytes % 2) throw new Error('Invalid speech audio');
  const pcm = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length; }
  return new Response(pcm, { headers: { 'content-type': 'audio/pcm' } });
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
    const response = payload.googleVoice ? await googleSpeech(payload, env, controller.signal)
      : await fetch('https://openrouter.ai/api/v1/audio/speech', {
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
