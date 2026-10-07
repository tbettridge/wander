import { NPC_GESTURES } from './npcexpression.mjs?v=2';

export const NPC_LIVE_MODEL = 'gemini-3.8-live';
export const NPC_LIVE_RANGE = 3.5;
export const NPC_LIVE_LEAVE_RANGE = 5;
export const NPC_LIVE_SILENCE_SECONDS = 10;
export const NPC_LIVE_TOKEN_SECONDS = 180;
export const NPC_LIVE_TOOLS = [{ functionDeclarations: [
  { name: 'lookup_world_context', behavior: 'BLOCKING',
    description: 'Look up authoritative game facts and memories this NPC may know. Call before answering about a person, place or past event absent from supplied context. Never invent game facts.',
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] } },
  { name: 'queue_gesture', behavior: 'NON_BLOCKING',
    description: 'Silently schedule a body gesture alongside the spoken phrase. Use one or two per spoken reply. Send before the accompanying phrase; never mention this tool aloud. Point only to a supplied place ID.',
    parameters: { type: 'OBJECT', properties: {
      name: { type: 'STRING', enum: Object.keys(NPC_GESTURES) },
      phrase: { type: 'STRING', description: 'The short spoken phrase this gesture accompanies, verbatim.' },
      placeId: { type: 'STRING', description: 'Optional known place ID for directional pointing.' },
    }, required: ['name', 'phrase'] } },
] }];

export const NPC_LIVE_DELIVERY_INSTRUCTIONS = [
  'This is a live spoken conversation. Speak naturally in English, including when the traveller speaks another language.',
  'Keep the supplied character voice, age, gender, regional accent and personality throughout. Do not adopt an American accent or mimic the traveller\'s accent. Let emotion change delivery without changing vocal identity.',
  'Act the meaning: gentle chuckles, hesitation, sorrow, guarded anger, curiosity, tenderness and whispered gossip when appropriate. Stay consistent with the character and situation. Usually use one to three short conversational sentences.',
  'Audio is the dialogue itself. Never speak JSON, delivery tags, angle brackets, tool names or stage directions.',
  `Silent body gestures: ${Object.entries(NPC_GESTURES).map(([name, clip]) => `${name}: ${clip.description}`).join('; ')}.`,
  'Use queue_gesture for one or two gestures per reply. hand-beats is the default. Two-handed gestures need both hands free. Call before the phrase it accompanies and give its exact short spoken phrase. A point requires a known place ID. If interrupted, stop the abandoned performance and address the new utterance.',
  'GAME context updates and GAME farewell messages are silent instructions from the game. Do not read their labels or content aloud. When a GAME farewell says the traveller has been silent, give one brief, in-character goodbye and stop. Never claim to have moved, given an item or changed the game world.',
].join('\n');

export function nearestLiveNpc(actors, player, radius = NPC_LIVE_RANGE, eligible = () => true) {
  if (!player || !Number.isFinite(player.x) || !Number.isFinite(player.z)) return null;
  let closest = null, distance = radius;
  for (const actor of actors || []) {
    const root = actor?.avatar?.root || actor?.root;
    const position = root?.position || actor?.remotePose;
    if (!actor?.identity?.id || root?.visible === false || !position
      || !Number.isFinite(position.x) || !Number.isFinite(position.z) || !eligible(actor)) continue;
    if (Number.isFinite(player.y) && Number.isFinite(position.y) && Math.abs(player.y - position.y) > 2.5) continue;
    const separation = Math.hypot(position.x - player.x, position.z - player.z);
    if (separation <= distance && (!closest || separation < distance
      || actor.identity.id.localeCompare(closest.identity.id) < 0)) { closest = actor; distance = separation; }
  }
  return closest;
}

// Client-side VAD keeps ambient audio off the network until a nearby encounter.
// A 600 ms trailing pause preserves natural pauses; the caller retains pre-roll.
export class LiveSpeechGate {
  constructor() { this.reset(); }
  reset() { this.speaking = false; this.voiced = 0; this.lastVoice = -Infinity; this.noise = 0.003; }
  update(rms, seconds) {
    const voiced = rms > Math.max(0.018, this.noise * 3.5);
    if (!this.speaking && !voiced) this.noise = this.noise * 0.98 + Math.min(0.012, rms) * 0.02;
    if (voiced) { this.voiced++; this.lastVoice = seconds; } else if (!this.speaking) this.voiced = 0;
    if (!this.speaking && this.voiced >= 3) { this.speaking = true; return 'start'; }
    if (this.speaking && seconds - this.lastVoice >= 1) { this.speaking = false; this.voiced = 0; return 'end'; }
    return null;
  }
}

export function livePcmFrame(samples, sampleRate = 16000) {
  const count = Math.floor(samples.length * 16000 / sampleRate), pcm = new Int16Array(count);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const a = i * sampleRate / 16000, lo = Math.floor(a), blend = a - lo;
    const value = Math.max(-1, Math.min(1, samples[lo] * (1 - blend) + (samples[lo + 1] ?? samples[lo]) * blend));
    pcm[i] = Math.round(value * (value < 0 ? 32768 : 32767)); sum += value * value;
  }
  return { pcm, rms: count ? Math.sqrt(sum / count) : 0 };
}

export function liveGestureCue(args, places = []) {
  if (!args || !Object.hasOwn(NPC_GESTURES, args.name) || typeof args.phrase !== 'string') return null;
  const phrase = args.phrase.trim().slice(0, 200);
  if (!phrase) return null;
  const place = args.name === 'point' ? places.find(item => item.id === args.placeId
    && Number.isFinite(item.worldX) && Number.isFinite(item.worldZ)) : null;
  if (args.name === 'point' && !place) return null;
  return { name: args.name, phrase, ...(place ? { place } : {}) };
}
