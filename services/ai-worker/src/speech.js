import { NPC_TTS_MODEL, NPC_PREBUILT_VOICES, parseNpcDelivery } from '../../../src/npcspeech.mjs';
import { npcCastVoice, npcCastKeys, npcServerVoiceId as validVoice } from '../../../src/npcvoiceidentity.mjs';

function speechVoiceBank(env) {
  const bank = {};
  // Each Cloudflare secret is capped at 5 KB; the full cast spans small chunks.
  for (const json of [env.NPC_VOICE_BANK_JSON,
    ...Array.from({ length: 8 }, (_, i) => env[`NPC_VOICE_BANK_${i}_JSON`])]) {
    try {
      for (const [key, value] of Object.entries(JSON.parse(json || '{}') || {})) {
        if (npcCastVoice(key) && validVoice(value)) bank[key] = value;
      }
    } catch { /* keep other configured chunks and the preset fallback */ }
  }
  return bank;
}

export function speechCastStatus(env) {
  const configured = env.GEMINI_API_KEY ? Object.keys(speechVoiceBank(env)).length : 0;
  const total = npcCastKeys().length;
  return { mode: configured === total ? 'regional' : configured ? 'partial-regional' : 'presets', configured, total };
}

export function speechPayload(body, env) {
  if (typeof body?.input !== 'string' || !body.input.trim() || body.input.length > 1200
    || typeof body.npcId !== 'string' || body.npcId.length > 160
    || (body.style !== undefined && (typeof body.style !== 'string' || body.style.length > 160))
    || (body.stream !== undefined && typeof body.stream !== 'boolean')
    || (body.regionalOnly !== undefined && typeof body.regionalOnly !== 'boolean')
    || !NPC_PREBUILT_VOICES.includes(body.voice)
    || (body.voiceKey !== undefined && !npcCastVoice(body.voiceKey))) return null;
  let voices = {};
  try { voices = JSON.parse(env.NPC_VOICES_JSON || '{}'); } catch { /* preset fallback */ }
  const custom = Object.hasOwn(voices || {}, body.npcId) ? voices[body.npcId] : null;
  const bank = speechVoiceBank(env);
  const bankVoice = body.voiceKey && Object.hasOwn(bank || {}, body.voiceKey) ? bank[body.voiceKey] : null;
  const voice = validVoice(custom) ? custom : body.voice;
  const googleVoice = env.GEMINI_API_KEY && (validVoice(custom) ? custom : validVoice(bankVoice) ? bankVoice : null);
  if ((body.regionalOnly || body.stream) && !googleVoice) return null;
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
  if (body.stream) Object.defineProperty(payload, 'stream', { value: true });
  return payload;
}

function googleSpeechRequest(payload, stream = false) {
  const style = payload.provider.options['google-ai-studio'].speech_metadata.style;
  return { model: 'gemini-3.8-flash-tts',
    input: [{ type: 'user_input', content: [{ type: 'text', text: payload.input,
      annotations: [{ type: 'speech_metadata', style }] }] }],
    response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
    generation_config: { speech_config: [{ voice: payload.googleVoice }] },
    ...(stream ? { stream: true } : {}),
  };
}

async function googleSpeech(payload, env, signal) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(googleSpeechRequest(payload)), signal,
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
  if (payload.stream) return proxySpeechStream(request, env, headers, payload);
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
    return new Response(pcm, { headers: { ...headers, 'content-type': 'audio/pcm', 'cache-control': 'no-store',
      'access-control-expose-headers': 'x-wander-voice-source',
      'x-wander-voice-source': payload.googleVoice
        ? payload.googleVoice.startsWith('voice_') ? 'designed' : 'regional-library'
        : validVoice(payload.voice) ? 'custom' : 'preset',
    } });
  } catch { return error(controller.signal.aborted ? 504 : 502); }
  finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
}

// Decode the provider's event stream inside the gateway. Clients receive only
// raw PCM and the cast-source header, never provider metadata or credentials.
async function proxySpeechStream(request, env, headers, payload) {
  const aborter = new AbortController(), abort = () => aborter.abort();
  const timer = setTimeout(abort, 35000);
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  let reader;
  const cleanup = () => { clearTimeout(timer); request.signal.removeEventListener('abort', abort); };
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(googleSpeechRequest(payload, true)), signal: aborter.signal,
    });
    if (!response.ok || !/text\/event-stream/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel(); cleanup();
      return Response.json({ error: 'Regional speech unavailable' }, { status: response.status === 429 ? 429 : 502, headers });
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer = '', inputBytes = 0, audioBytes = 0, ended = false;
    const pending = [];
    const parse = frame => {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n').trim();
      if (!data || data === '[DONE]') return;
      const event = JSON.parse(data);
      if (event.error || ['error', 'interaction.failed'].includes(event.event_type)) throw new Error('Regional stream failed');
      if (event.event_type !== 'step.delta' || event.delta?.type !== 'audio') return;
      if (typeof event.delta.data !== 'string' || event.delta.data.length > 2000000
        || event.delta.mime_type && !/audio\/(l16|pcm)(;|$)/i.test(event.delta.mime_type)) throw new Error('Invalid audio frame');
      const raw = atob(event.delta.data); audioBytes += raw.length;
      if (!raw.length || raw.length % 2 || audioBytes > 6000000) throw new Error('Invalid regional PCM');
      pending.push(Uint8Array.from(raw, ch => ch.charCodeAt(0)));
    };
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          while (!pending.length && !ended) {
            const { value, done } = await reader.read();
            if (aborter.signal.aborted) throw new Error('Cancelled');
            if (done) {
              ended = true; buffer += decoder.decode(); if (buffer.trim()) parse(buffer);
              if (!audioBytes) throw new Error('Empty regional audio');
              break;
            }
            inputBytes += value.length;
            if (inputBytes > 12000000) throw new Error('Oversized regional stream');
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop();
            if (buffer.length > 2000000) throw new Error('Oversized event');
            for (const frame of frames) parse(frame);
          }
          if (pending.length) controller.enqueue(pending.shift());
          else { cleanup(); reader.releaseLock(); controller.close(); }
        } catch { abort(); cleanup(); await reader.cancel().catch(() => {}); controller.error(new Error('Regional speech stream unavailable')); }
      },
      async cancel() { abort(); cleanup(); await reader.cancel().catch(() => {}); },
    });
    return new Response(stream, { headers: { ...headers, 'content-type': 'audio/pcm', 'cache-control': 'no-store',
      'access-control-expose-headers': 'x-wander-voice-source',
      'x-wander-voice-source': payload.googleVoice.startsWith('voice_') ? 'designed' : 'regional-library' } });
  } catch { abort(); cleanup(); return Response.json({ error: 'Regional speech unavailable' }, { status: 502, headers }); }
}
