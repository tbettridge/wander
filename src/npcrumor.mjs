import {
  applyRelationshipDelta,
  memoriesFor,
  relationshipBetween,
  rememberSocialMemory,
} from './npcsocialmemory.mjs';
import { applyLivingWorldEventOnce, LIVING_WORLD_RUMOR_LOG_LIMIT } from './livingworldstate.mjs';

export const RUMOR_MAX_PER_SIDE = 2;
export const RUMOR_MAX_HOPS = 3;
export const RUMOR_COOLDOWN_HOURS = 12;

/** Allocate a stable, monotonic conversation ID for a deterministic NPC pair. */
export function beginNpcConversation(state, participantIds, { nowHour = 0 } = {}) {
  const ids = normalizedParticipants(participantIds);
  if (ids.length !== 2) throw new TypeError('NPC conversations require two distinct participant IDs.');
  const pairKey = ids.join('|');
  const sequence = Math.max(0, Math.floor(Number(state.conversationSequences?.[pairKey]) || 0)) + 1;
  state.conversationSequences ||= {};
  state.conversationSequences[pairKey] = sequence;
  const id = `conversation:${pairKey}:${sequence}`;
  state.revision++;
  return { id, participantIds: ids, pairKey, sequence, startedAtHour: finite(nowHour) };
}

export function beginPlayerConversation(state, npcId, { nowHour = 0, playerId = 'player:local' } = {}) {
  return beginNpcConversation(state, [npcId, playerId], { nowHour });
}

export function recordPlayerConversationOutcome(state, conversation, {
  npcId,
  playerId = 'player:local',
  playerTurns = 0,
  nowHour = state?.clock?.worldHours ?? 0,
} = {}) {
  if (!conversation?.id || !npcId) return { applied: false, reason: 'conversation-missing' };
  const event = {
    id: `event:${conversation.id}:player-conversation`,
    type: 'relationship.player-conversation',
    conversationId: conversation.id,
    actorId: String(npcId),
    targetId: String(playerId),
    playerTurns: integer(playerTurns),
    atHour: finite(nowHour),
  };
  return applyLivingWorldEventOnce(state, event, (draft, incoming) => {
    const depth = Math.min(0.06, 0.02 + incoming.playerTurns * 0.01);
    applyRelationshipDelta(draft, incoming.actorId, incoming.targetId, {
      familiarity: depth,
      affinity: incoming.playerTurns > 0 ? 0.01 : 0,
    }, incoming);
    return { code: 'player-conversation', familiarity: depth };
  });
}

/**
 * Resolve the single semantic beat owned by an NPC conversation.
 *
 * Selection and rejection are deterministic. The returned result is persisted
 * by conversation ID, so replaying a visual beat or reloading cannot repeat a
 * transfer or relationship delta.
 */
export function exchangeRumors(state, conversation, {
  nowHour = state?.clock?.worldHours ?? 0,
  maxPerSide = RUMOR_MAX_PER_SIDE,
} = {}) {
  if (!conversation?.id) throw new TypeError('Rumor exchange requires a stable conversation ID.');
  state.rumorExchanges ||= {};
  if (state.rumorExchanges[conversation.id]) {
    return { ...structuredClone(state.rumorExchanges[conversation.id]), duplicate: true };
  }
  const participantIds = normalizedParticipants(conversation.participantIds);
  if (participantIds.length !== 2) throw new TypeError('Rumor exchange requires two distinct participants.');
  const limit = Math.max(0, Math.min(RUMOR_MAX_PER_SIDE, Math.floor(Number(maxPerSide) || 0)));
  const result = {
    conversationId: String(conversation.id),
    participantIds,
    atHour: finite(nowHour),
    transfers: [],
    rejections: [],
    duplicate: false,
  };

  for (const [speakerId, listenerId] of [participantIds, [...participantIds].reverse()]) {
    transferDirection(state, result, speakerId, listenerId, limit, nowHour);
  }

  const relationshipEvent = { id: `event:${conversation.id}:socialized`, atHour: finite(nowHour) };
  applyRelationshipDelta(state, participantIds[0], participantIds[1], { familiarity: 0.015 }, relationshipEvent);
  applyRelationshipDelta(state, participantIds[1], participantIds[0], { familiarity: 0.015 }, relationshipEvent);
  const persisted = compactExchange(result);
  state.rumorExchanges[conversation.id] = {
    conversationId: persisted.conversationId,
    atHour: persisted.atHour,
    transferCount: persisted.transfers.length,
    rejectionCounts: persisted.rejectionCounts,
  };
  state.metrics ||= {};
  state.metrics.rumorExchanges = integer(state.metrics.rumorExchanges) + 1;
  state.metrics.rumorTransfers = integer(state.metrics.rumorTransfers) + result.transfers.length;
  pushRumorLog(state, {
    id: `rumor-log:${conversation.id}`,
    ...persisted,
  });
  state.revision++;
  return result;
}

export function rumorInspector(state, { limit = 20 } = {}) {
  return (Array.isArray(state?.rumorLog) ? state.rumorLog : [])
    .slice(-Math.max(0, Math.floor(limit))).reverse().map((entry) => structuredClone(entry));
}

export function sourcedRumorPhrase(memory, entities = {}) {
  if (!memory) return '';
  const sourceName = entities[memory.source?.id]?.name || memory.source?.id || 'someone';
  const claim = memory.summary || memory.object?.text || memory.predicate;
  return memory.provenance === 'told' ? `${sourceName} told me ${lowerFirst(claim)}` : claim;
}

function transferDirection(state, result, speakerId, listenerId, limit, nowHour) {
  const listenerLineages = new Set(memoriesFor(state, listenerId, { nowHour, limit: 32 })
    .map((memory) => memory.lineageId));
  const relationship = relationshipBetween(state, listenerId, speakerId);
  const trust = relationship?.trust || 0;
  const familiarity = relationship?.familiarity || 0;
  const candidates = memoriesFor(state, speakerId, { nowHour, limit: 32 })
    .map((memory) => ({ memory, rejection: rejectionReason(state, memory, speakerId, listenerId, listenerLineages, trust, nowHour) }))
    .sort((a, b) => rumorScore(b.memory, nowHour, trust, familiarity)
      - rumorScore(a.memory, nowHour, trust, familiarity)
      || stableTie(result.conversationId, speakerId, listenerId, a.memory.lineageId)
      - stableTie(result.conversationId, speakerId, listenerId, b.memory.lineageId)
      || a.memory.id.localeCompare(b.memory.id));

  let transferred = 0;
  for (const candidate of candidates) {
    const memory = candidate.memory;
    if (candidate.rejection) {
      result.rejections.push(rejection(memory, speakerId, listenerId, candidate.rejection));
      continue;
    }
    if (rumorScore(memory, nowHour, trust, familiarity) < 0.58) {
      result.rejections.push(rejection(memory, speakerId, listenerId, 'low-relevance'));
      continue;
    }
    if (transferred >= limit) {
      result.rejections.push(rejection(memory, speakerId, listenerId, 'transfer-limit'));
      continue;
    }
    const nextHop = memory.hopCount + 1;
    const transferredMemory = rememberSocialMemory(state, listenerId, {
      ...memory,
      id: `memory:${listenerId}:${memory.lineageId}`,
      ownerId: listenerId,
      source: { kind: 'npc', id: speakerId },
      sourceChain: [...(memory.sourceChain || [memory.source]), { kind: 'npc', id: speakerId }].slice(-4),
      provenance: 'told',
      confidence: Math.max(0.05, memory.confidence * 0.82),
      salience: Math.max(0.05, memory.salience * 0.94),
      privacy: memory.privacy,
      hopCount: nextHop,
      createdAtHour: finite(nowHour),
      lastRecalledHour: finite(nowHour),
    }, { nowHour });
    if (!transferredMemory) continue;
    listenerLineages.add(memory.lineageId);
    state.rumorCooldowns[cooldownKey(speakerId, listenerId, memory.lineageId)] = finite(nowHour);
    result.transfers.push({
      lineageId: memory.lineageId,
      originEventId: memory.originEventId,
      speakerId,
      listenerId,
      hopCount: nextHop,
      sourceChain: transferredMemory.sourceChain,
    });
    transferred++;
  }
}

function rejectionReason(state, memory, speakerId, listenerId, listenerLineages, trust, nowHour) {
  if (memory.privacy === 'private') return 'private';
  if (memory.privacy === 'personal' && trust < 0.25) return 'insufficient-trust';
  if (memory.hopCount >= RUMOR_MAX_HOPS) return 'hop-limit';
  if (listenerLineages.has(memory.lineageId)) return 'duplicate-lineage';
  if (isNegative(memory)) return 'tone-policy';
  const last = state.rumorCooldowns?.[cooldownKey(speakerId, listenerId, memory.lineageId)];
  if (Number.isFinite(last) && finite(nowHour) - last < RUMOR_COOLDOWN_HOURS) return 'cooldown';
  return null;
}

function rumorScore(memory, nowHour, trust, familiarity) {
  const age = Math.max(0, finite(nowHour) - finite(memory.lastRecalledHour));
  const recency = 1 / (1 + age / 24);
  return memory.salience * 0.38 + memory.confidence * 0.28 + recency * 0.18
    + Math.max(0, trust) * 0.1 + familiarity * 0.06 - memory.hopCount * 0.08;
}

function rejection(memory, speakerId, listenerId, reason) {
  return { lineageId: memory.lineageId, speakerId, listenerId, reason };
}

function pushRumorLog(state, entry) {
  state.rumorLog ||= [];
  state.rumorLog.push(entry);
  if (state.rumorLog.length > LIVING_WORLD_RUMOR_LOG_LIMIT) {
    state.rumorLog.splice(0, state.rumorLog.length - LIVING_WORLD_RUMOR_LOG_LIMIT);
  }
}

function compactExchange(result) {
  const rejectionCounts = {};
  for (const rejection of result.rejections) {
    rejectionCounts[rejection.reason] = (rejectionCounts[rejection.reason] || 0) + 1;
  }
  return {
    conversationId: result.conversationId,
    participantIds: [...result.participantIds],
    atHour: result.atHour,
    transfers: structuredClone(result.transfers),
    rejectionCounts,
    // Enough examples for the inspector without making every ineligible memory
    // a permanent second copy of the memory store.
    rejections: structuredClone(result.rejections.slice(0, 6)),
    duplicate: false,
  };
}

function normalizedParticipants(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))].sort().slice(0, 2);
}

function cooldownKey(speakerId, listenerId, lineageId) {
  return `${speakerId}|${listenerId}|${lineageId}`;
}

function isNegative(memory) {
  return memory.object?.sentiment === 'negative'
    || /(?:distrust|accusation|hostile|crime|betray)/i.test(memory.predicate || '');
}

function stableTie(...parts) {
  let hash = 2166136261;
  for (const char of parts.join('|')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function integer(value) {
  return Math.max(0, Math.floor(finite(value)));
}

function lowerFirst(value) {
  const text = String(value || '').trim();
  return text ? `${text[0].toLowerCase()}${text.slice(1)}` : '';
}
