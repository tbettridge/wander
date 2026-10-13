import { NPC_PREBUILT_VOICES } from '../../../src/npcspeech.mjs';
import { NPC_LIVE_MODEL, NPC_LIVE_TOKEN_SECONDS, NPC_LIVE_TOOLS } from '../../../src/npcliveprotocol.mjs';

export function liveTokenPayload(body, now = Date.now()) {
  if (typeof body?.npcId !== 'string' || !body.npcId.trim() || body.npcId.length > 160
    || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 36000
    || !NPC_PREBUILT_VOICES.includes(body.voice)
    || (body.speechVocabulary !== undefined && (!Array.isArray(body.speechVocabulary) || body.speechVocabulary.length > 100
      || body.speechVocabulary.some(term => typeof term !== 'string' || !term.trim() || term.length > 120
        || /[\u0000-\u001f\u007f]/.test(term))))) return null;
  const vocabulary = [...new Set((body.speechVocabulary || []).map(term => term.trim()))];
  const setup = {
    model: `models/${NPC_LIVE_MODEL}`,
    generationConfig: { responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: body.voice } } } },
    systemInstruction: { parts: [{ text: body.prompt }] },
    tools: NPC_LIVE_TOOLS,
    inputAudioTranscription: vocabulary.length ? { customVocabulary: vocabulary, languageCodes: ['en'] } : {},
    outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    contextWindowCompression: { triggerTokens: 8192, slidingWindow: { targetTokens: 4096 } },
  };
  return { uses: 1, expireTime: new Date(now + NPC_LIVE_TOKEN_SECONDS * 1000).toISOString(),
    newSessionExpireTime: new Date(now + 60000).toISOString(), bidiGenerateContentSetup: setup };
}

export async function provisionLiveToken(payload, env, headers, fetchImpl = (...args) => fetch(...args)) {
  try {
    let activePayload = payload;
    const options = {
      method: 'POST', headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(12000),
    };
    let apiVersion = 'v1beta';
    let response = await fetchImpl(`https://generativelanguage.googleapis.com/${apiVersion}/auth_tokens`, options);
    if (response.status === 404) {
      await response.body?.cancel(); apiVersion = 'v1alpha';
      response = await fetchImpl(`https://generativelanguage.googleapis.com/${apiVersion}/auth_tokens`, options);
    }
    if (!response.ok) {
      let error = await response.json().catch(() => ({}));
      // Vocabulary support differs across Live models/API versions. Retry only
      // an explicitly unsupported hint, keeping voice, tools and all budgets.
      if (response.status === 400 && payload.bidiGenerateContentSetup.inputAudioTranscription.customVocabulary
        && /(?:custom_?vocabulary|language_?codes)/i.test(String(error.error?.message || ''))
        && /unknown|unsupported|not supported|not allowed/i.test(String(error.error?.message || ''))) {
        activePayload = { ...payload, bidiGenerateContentSetup: { ...payload.bidiGenerateContentSetup, inputAudioTranscription: {} } };
        response = await fetchImpl(`https://generativelanguage.googleapis.com/${apiVersion}/auth_tokens`, {
          ...options, body: JSON.stringify(activePayload), signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) error = await response.json().catch(() => ({}));
      }
      if (!response.ok) {
        const unsupportedFields = [...String(error.error?.message || '').matchAll(/Unknown name "([A-Za-z0-9_]+)"/g)].map(match => match[1]);
        return Response.json({ error: 'Live voice provisioning unavailable', providerStatus: response.status,
          unsupportedFields }, { status: response.status === 429 ? 429 : 502, headers });
      }
    }
    const token = await response.json();
    if (typeof token.name !== 'string' || !token.name.startsWith('auth_tokens/')) throw new Error('Invalid Live token');
    return Response.json({ token: token.name, model: NPC_LIVE_MODEL, apiVersion, expiresAt: payload.expireTime,
      setup: activePayload.bidiGenerateContentSetup,
      vocabularyHints: Boolean(activePayload.bidiGenerateContentSetup.inputAudioTranscription.customVocabulary) },
      { headers: { ...headers, 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ error: 'Live voice provisioning unavailable' }, { status: 502, headers });
  }
}
