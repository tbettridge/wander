import { NPC_PREBUILT_VOICES } from '../../../src/npcspeech.mjs';
import { NPC_LIVE_MODEL, NPC_LIVE_TOKEN_SECONDS, NPC_LIVE_TOOLS } from '../../../src/npcliveprotocol.mjs';

export function liveTokenPayload(body, now = Date.now()) {
  if (typeof body?.npcId !== 'string' || !body.npcId.trim() || body.npcId.length > 160
    || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 36000
    || !NPC_PREBUILT_VOICES.includes(body.voice)) return null;
  const setup = {
    model: `models/${NPC_LIVE_MODEL}`,
    generationConfig: { responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: body.voice } } } },
    systemInstruction: { parts: [{ text: body.prompt }] },
    tools: NPC_LIVE_TOOLS,
    inputAudioTranscription: {}, outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    contextWindowCompression: { triggerTokens: 8192, slidingWindow: { targetTokens: 4096 } },
  };
  return { uses: 1, expireTime: new Date(now + NPC_LIVE_TOKEN_SECONDS * 1000).toISOString(),
    newSessionExpireTime: new Date(now + 60000).toISOString(), bidiGenerateContentSetup: setup };
}

export async function provisionLiveToken(payload, env, headers, fetchImpl = (...args) => fetch(...args)) {
  try {
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
      const error = await response.json().catch(() => ({}));
      const unsupportedFields = [...String(error.error?.message || '').matchAll(/Unknown name "([A-Za-z0-9_]+)"/g)].map(match => match[1]);
      return Response.json({ error: 'Live voice provisioning unavailable', providerStatus: response.status,
        unsupportedFields }, { status: response.status === 429 ? 429 : 502, headers });
    }
    const token = await response.json();
    if (typeof token.name !== 'string' || !token.name.startsWith('auth_tokens/')) throw new Error('Invalid Live token');
    return Response.json({ token: token.name, model: NPC_LIVE_MODEL, apiVersion, expiresAt: payload.expireTime,
      setup: payload.bidiGenerateContentSetup }, { headers: { ...headers, 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ error: 'Live voice provisioning unavailable' }, { status: 502, headers });
  }
}
