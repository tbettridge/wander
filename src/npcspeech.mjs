import { VOICE_ACCENTS, voiceHash, npcVoiceDemographics, npcVoiceBackground, npcPresetVoice } from './npcvoiceidentity.mjs';
export const NPC_TTS_MODEL = 'google/gemini-3.8-flash-tts';
export const NPC_PREBUILT_VOICES = Object.freeze([
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
]);

const CHARACTERS = [
  ['warm, quietly amused', 'kind and observant, with gentle dry humour', 'unhurried, conversational, lightly playful', 'warm and rounded'],
  ['grounded and matter-of-fact', 'practical, dependable and blunt without being unkind', 'crisp, economical phrases with deliberate pauses', 'slightly gravelly and clear'],
  ['soft and guarded', 'private and thoughtful, slow to trust but sincere', 'quiet, hesitant at first, then candid', 'soft and breathy'],
  ['bright and curious', 'inquisitive, inventive and easily caught by a new idea', 'lively conversational rhythm with small thoughtful hesitations', 'light and agile'],
  ['calm and reflective', 'patient, perceptive and fond of carefully chosen words', 'measured, thoughtful, with room between phrases', 'resonant and mellow'],
  ['open and enthusiastic', 'sociable, generous and eager to share a good story', 'animated, friendly, with an easy chuckle', 'bright and full'],
];
const clean = (value, max = 180) => typeof value === 'string' ? value.replace(/[\r\n]/g, ' ').trim().slice(0, max) : '';

// Independent of the appearance RNG: adding speech must not redraw a resident.
// Legacy, remote and authored NPCs receive the same profile from their stable ID.
export function npcSpeechProfile(npc = {}) {
  const id = npc.id || npc.name || 'resident';
  const seed = voiceHash(id);
  const [tone, personality, speakingStyle, timbre] = CHARACTERS[seed % CHARACTERS.length];
  const supplied = npc.speech || {};
  const { gender, ageBand } = npcVoiceDemographics(npc);
  const background = npcVoiceBackground(npc);
  const variant = voiceHash(`${id}:voice-texture`) % 2;
  const age = ageBand === 'elder' ? 'older adult' : ageBand === 'youth' ? 'child around eleven years old' : 'adult';
  const profile = {
    version: 2, gender, ageBand, background,
    voiceKey: `${background.accentId}:${gender}:${ageBand}:${variant}`,
    tone: clean(supplied.tone) || tone,
    personality: clean(supplied.personality) || personality,
    accent: (supplied.version !== 1 && clean(supplied.accent)) || VOICE_ACCENTS[background.accentId].accent,
    speakingStyle: clean(supplied.speakingStyle) || speakingStyle,
    voice: supplied.version !== 1 && NPC_PREBUILT_VOICES.includes(supplied.voice)
      ? supplied.voice : npcPresetVoice(gender, ageBand, id),
    baselineStyle: clean(supplied.baselineStyle, 120) || clean(supplied.tone, 120) || tone,
  };
  profile.description = `${age}, ${gender} voice. ${profile.personality}. Background: ${background.story} Tone: ${profile.tone}. Accent: ${profile.accent}. Speaking style: ${profile.speakingStyle}.`;
  profile.voiceDesignPrompt = (supplied.version !== 1 && clean(supplied.voiceDesignPrompt, 400))
    || `A ${timbre} ${gender} voice for a ${age} character, with ${profile.accent}. Delivery is ${profile.tone}; ${profile.speakingStyle}.`;
  return Object.freeze(profile);
}

const VOCAL_TAGS = new Set(['argh', 'breath', 'heavy breath', 'exhales', 'cackle', 'cheer',
  'chuckle', 'chuckles', 'cough', 'cry', 'gasp', 'giggle', 'groan', 'growl', 'grunt',
  'grr', 'hiss', 'laugh', 'laughter', 'moan', 'pant', 'pff', 'phew', 'scream', 'shout',
  'shriek', 'sigh', 'sighs', 'sneeze', 'snicker', 'snort', 'sob', 'throat-clearing',
  'tsk', 'whimper', 'whispers', 'whispering', 'yawn', 'short pause', 'long pause']);
const tidy = (text) => text.replace(/[ \t]+/g, ' ').replace(/ +([,.!?;:])/g, '$1').trim();

// Preserve the original transcript for memory/evidence. Only NPC presentation
// uses displayText; user messages are never passed through this parser.
export function parseNpcDelivery(raw = '') {
  const supplied = typeof raw === 'object' && raw !== null ? raw.speechSegments : null;
  const text = typeof raw === 'object' && raw !== null ? String(raw.text || '') : String(raw || '');
  const parts = normalizeNpcSpeechSegments(supplied, text) || [{ text, style: '' }];
  const segments = parts.map((part) => ({
    input: tidy(part.text.replace(/<([^>\r\n]*)(>|$)/g, (match, tag, end) =>
      end && VOCAL_TAGS.has(tag.toLowerCase()) ? `<${tag.toLowerCase()}>` : ' ')),
    style: part.style,
  })).filter((part) => part.input);
  return { displayText: tidy(text.replace(/<[^>\r\n]*(?:>|$)/g, ' ')), segments };
}

export const npcDialogueText = (raw) => parseNpcDelivery(raw).displayText;

export const NPC_DELIVERY_INSTRUCTIONS = [
  'Write natural spoken dialogue in this NPC\'s stable personality and speaking style. Do not exaggerate accents with phonetic spelling.',
  'Return only a JSON object with segments: an array of one to four objects, each with text (the exact spoken transcript) and style (a short delivery instruction, or an empty string for natural delivery). No labels, analysis, narration, or system commentary.',
  'Use at most three native inline vocal tags per reply, only when the moment warrants them. Examples: <chuckle>, <sigh>, <gasp>, <short pause>. Never use square-bracket cues, invented tags, non-vocal sound effects or physical actions.',
  'Put sustained emotion and delivery ONLY in the separate style field, never inline: e.g. "scared, trembling, speaking through clenched teeth". For a mid-reply change, use another segment with its own style.',
  'Keep permanent age, gender, names and accent out of style; those belong to the configured voice, not situational delivery.',
  'For a small laugh, use <chuckle> at its exact position. For a longing sigh, use <sigh> with style "wistful, longing" in that segment. Directions and tags are not spoken words or world facts.',
].join('\n');

export const NPC_DIALOGUE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['segments'], properties: {
    segments: { type: 'array', minItems: 1, maxItems: 4, items: {
      type: 'object', additionalProperties: false, required: ['text', 'style'], properties: {
        text: { type: 'string', minLength: 1, maxLength: 1200 },
        style: { type: 'string', maxLength: 160 },
      },
    } },
  },
};

// Optional metadata never gets to speak a different transcript. A host may
// shorten a room reply, in which case carry only its accepted prefix.
export function normalizeNpcSpeechSegments(value, text) {
  if (!Array.isArray(value) || !value.length || value.length > 4 || value.some((part) =>
    typeof part?.text !== 'string' || !part.text.trim() || part.text.length > 1200
    || typeof part.style !== 'string' || part.style.length > 160)) return null;
  const parts = value.map((part) => ({ text: part.text.trim(), style: part.style.trim() }));
  const combined = parts.map((part) => part.text).join(' ');
  if (!text || !combined.startsWith(text)) return null;
  let remaining = text.length;
  return parts.flatMap((part) => {
    if (remaining <= 0) return [];
    const accepted = { ...part, text: part.text.slice(0, remaining) };
    remaining -= part.text.length + 1;
    return accepted.text.trim() ? [accepted] : [];
  });
}

export function decodeNpcDialogue(response) {
  const raw = String(response || '').trim();
  // Accept legacy plain replies from older/local adapters, never display broken JSON.
  if (!raw.startsWith('{') && !raw.startsWith('[')) return { text: raw };
  const result = JSON.parse(raw);
  const text = Array.isArray(result.segments) ? result.segments.map((part) => part?.text?.trim()).join(' ') : '';
  const speechSegments = normalizeNpcSpeechSegments(result.segments, text);
  if (!speechSegments || !npcDialogueText(text)) throw new Error('Invalid NPC dialogue performance');
  return { text, speechSegments };
}
