import { normalizeSocialMemory, SOCIAL_MEMORY_LIMIT } from './npcsocialmemory.mjs';

export const NPC_MEMORY_VERSION = 2;

export const NPC_MEMORY_LIMITS = Object.freeze({
  playerFacts: 14,
  npcFacts: 14,
  quests: 8,
  landmarks: 12,
  worldFacts: 12,
  factChars: 220,
  summaryChars: 420,
});

const MEMORY_FIELDS = Object.freeze([
  'playerFacts',
  'npcFacts',
  'quests',
  'landmarks',
  'worldFacts',
]);

function cleanText(value, maxChars = NPC_MEMORY_LIMITS.factChars) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maxChars).trim()
    : '';
}

function cleanList(values, field) {
  const limit = NPC_MEMORY_LIMITS[field] || 8;
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = cleanText(value);
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

export function emptyNpcMemory(npcId = '') {
  return {
    version: NPC_MEMORY_VERSION,
    npcId: String(npcId || ''),
    meetingCount: 0,
    playerFacts: [],
    npcFacts: [],
    quests: [],
    landmarks: [],
    worldFacts: [],
    socialMemories: [],
    lastConversationSummary: '',
  };
}

export function normalizeNpcMemory(value, npcId = value?.npcId || '') {
  const normalized = emptyNpcMemory(npcId);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
  normalized.meetingCount = Math.max(0, Math.floor(Number(value.meetingCount) || 0));
  for (const field of MEMORY_FIELDS) normalized[field] = cleanList(value[field], field);
  normalized.socialMemories = cleanSocialMemories(value.socialMemories, npcId);
  normalized.lastConversationSummary = cleanText(
    value.lastConversationSummary,
    NPC_MEMORY_LIMITS.summaryChars,
  );
  return normalized;
}

export function combineNpcMemory(previous, update, npcId = previous?.npcId || update?.npcId || '') {
  const before = normalizeNpcMemory(previous, npcId);
  const incoming = normalizeNpcMemory(update, npcId);
  const merged = emptyNpcMemory(npcId);
  merged.meetingCount = Math.max(before.meetingCount, incoming.meetingCount);
  for (const field of MEMORY_FIELDS) {
    // New recollections take priority when the bounded memory is full, while
    // older unique facts remain available behind them.
    merged[field] = cleanList([...incoming[field], ...before[field]], field);
  }
  merged.socialMemories = cleanSocialMemories([
    ...incoming.socialMemories,
    ...before.socialMemories,
  ], npcId);
  merged.lastConversationSummary = incoming.lastConversationSummary
    || before.lastConversationSummary;
  return merged;
}

function cleanSocialMemories(values, npcId) {
  if (!Array.isArray(values)) return [];
  const byLineage = new Map();
  for (const value of values) {
    const memory = normalizeSocialMemory(value, npcId);
    if (!memory || byLineage.has(memory.lineageId)) continue;
    byLineage.set(memory.lineageId, memory);
    if (byLineage.size >= SOCIAL_MEMORY_LIMIT) break;
  }
  return [...byLineage.values()];
}

export function mergeNpcMemory(previous, update, npcId = previous?.npcId || update?.npcId || '') {
  const before = normalizeNpcMemory(previous, npcId);
  const incoming = normalizeNpcMemory(update, npcId);
  incoming.meetingCount = Math.max(before.meetingCount + 1, incoming.meetingCount);
  return combineNpcMemory(before, incoming, npcId);
}

function sentences(text) {
  return cleanText(text, 1200).split(/(?<=[.!?])\s+/).map((part) => cleanText(part)).filter(Boolean);
}

function clause(text, maxChars = 145) {
  return cleanText(text, maxChars).replace(/[.!?]+$/, '');
}

function explicitPlayerName(messages) {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const match = message.content.match(
      /\b(?:my name is|call me|i am|i'm)\s+([\p{Lu}][\p{L}'’-]*(?:\s+[\p{Lu}][\p{L}'’-]*){0,2})\b/iu,
    );
    if (match) return cleanText(`The traveller's name is ${match[1]}.`);
  }
  return '';
}

export function fallbackMemorySynthesis(previous, context, transcript) {
  const npcId = context?.npc?.id || previous?.npcId || '';
  const messages = Array.isArray(transcript)
    ? transcript.flatMap((message) => {
      const role = message?.role;
      const content = cleanText(message?.content, 1000);
      return (role === 'user' || role === 'assistant') && content ? [{ role, content }] : [];
    })
    : [];
  const userMessages = messages.filter((message) => message.role === 'user');
  const npcMessages = messages.filter((message) => message.role === 'assistant');
  const joined = messages.map((message) => message.content).join(' ').toLocaleLowerCase();

  const playerFacts = [];
  const nameFact = explicitPlayerName(messages);
  if (nameFact) playerFacts.push(nameFact);
  for (const message of userMessages) {
    for (const sentence of sentences(message.content)) {
      if (/\b(?:i am|i'm|i have|i live|i came|i want|i need|i like|i dislike|i remember|my)\b/i.test(sentence)) {
        playerFacts.push(`The traveller said: ${sentence}`);
      }
    }
  }

  const npcFacts = [];
  for (const message of npcMessages) {
    for (const sentence of sentences(message.content)) {
      if (/\b(?:i|i'm|i've|my|we|our)\b/i.test(sentence)) npcFacts.push(sentence);
    }
  }

  const quests = userMessages.flatMap((message) => sentences(message.content))
    .filter((sentence) => /\b(?:quest|looking for|searching for|trying to|need to|promised|going to|must find|return to)\b/i.test(sentence));
  const landmarks = (context?.targets || [])
    .filter((target) => target?.name
      && joined.includes(String(target.name).toLocaleLowerCase()))
    .map((target) => target.name);
  const worldFacts = landmarks.map((name) => `The conversation discussed ${name}.`);

  const lastUser = userMessages.at(-1)?.content || '';
  const lastNpc = npcMessages.at(-1)?.content || '';
  const npcName = context?.npc?.name || 'The resident';
  let lastConversationSummary = '';
  if (lastUser && lastNpc) {
    lastConversationSummary = `The traveller discussed ${clause(lastUser)}. ${npcName} responded with ${clause(lastNpc)}.`;
  } else if (lastUser) {
    lastConversationSummary = `The traveller last spoke about ${clause(lastUser)}.`;
  } else {
    lastConversationSummary = `The traveller and ${npcName} shared a brief greeting.`;
  }

  return mergeNpcMemory(previous, {
    npcId,
    playerFacts,
    npcFacts,
    quests,
    landmarks,
    worldFacts,
    lastConversationSummary,
  }, npcId);
}

export class NpcMemoryStore {
  constructor({
    storage = typeof localStorage === 'undefined' ? null : localStorage,
    prefix = 'wander.livingWorld.memory.v2.',
    legacyPrefix = 'wander.livingWorld.memory.v1.',
    worldSeed = null,
    playerId = null,
    migrateLegacy = false,
  } = {}) {
    this.storage = storage;
    this.prefix = prefix;
    this.legacyPrefix = legacyPrefix;
    this.worldSeed = normalizeMemoryWorldSeed(worldSeed);
    this.playerId = playerId ? String(playerId) : null;
    // Unscoped v1/v2 records predate deterministic per-world persistence. They
    // are only eligible for a one-time migration when the caller has proved
    // this is the legacy home world. A newly selected seed must never inherit
    // another world's memories by accident.
    this.migrateLegacy = !!migrateLegacy;
  }

  setWorldSeed(worldSeed, { migrateLegacy = false } = {}) {
    this.worldSeed = normalizeMemoryWorldSeed(worldSeed);
    this.migrateLegacy = !!migrateLegacy;
    return this;
  }

  unscopedKey(npcId) {
    return `${this.prefix}${String(npcId || '')}`;
  }

  unscopedLegacyKey(npcId) {
    return `${this.legacyPrefix}${String(npcId || '')}`;
  }

  key(npcId, playerId = this.playerId) {
    const id = String(npcId || '');
    const participant = playerId ? `.${encodeURIComponent(String(playerId))}` : '';
    return this.worldSeed == null
      ? `${this.unscopedKey(id)}${participant}`
      : `${this.prefix}${this.worldSeed}.${id}${participant}`;
  }

  legacyKey(npcId) {
    const id = String(npcId || '');
    return this.worldSeed == null
      ? this.unscopedLegacyKey(id)
      : `${this.legacyPrefix}${this.worldSeed}.${id}`;
  }

  previousScopedKey(npcId) {
    const id = String(npcId || '');
    return this.worldSeed == null ? this.unscopedKey(id) : `${this.prefix}${this.worldSeed}.${id}`;
  }

  load(npcId, playerId = this.playerId) {
    if (!this.storage) return emptyNpcMemory(npcId);
    try {
      const raw = this.storage.getItem(this.key(npcId, playerId))
        ?? (playerId === this.playerId ? this.storage.getItem(this.previousScopedKey(npcId)) : null)
        ?? (playerId === this.playerId ? this.storage.getItem(this.legacyKey(npcId)) : null);
      if (raw) return normalizeNpcMemory(JSON.parse(raw), npcId);

      // Migrate old unscoped records only for an explicitly approved legacy
      // home world. Without that opt-in, a new seed starts with clean memory.
      if (this.worldSeed != null && this.migrateLegacy) {
        const legacyRaw = this.storage.getItem(this.unscopedKey(npcId))
          ?? this.storage.getItem(this.unscopedLegacyKey(npcId));
        if (legacyRaw) {
          const migrated = normalizeNpcMemory(JSON.parse(legacyRaw), npcId);
          this.save(npcId, migrated, playerId);
          return migrated;
        }
      }
      return emptyNpcMemory(npcId);
    } catch (error) {
      return emptyNpcMemory(npcId);
    }
  }

  save(npcId, memory, playerId = this.playerId) {
    const normalized = normalizeNpcMemory(memory, npcId);
    try {
      this.storage?.setItem(this.key(npcId, playerId), JSON.stringify(normalized));
    } catch (error) { /* persistence is optional */ }
    return normalized;
  }
}

function normalizeMemoryWorldSeed(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? (Math.trunc(numeric) >>> 0) : null;
}
