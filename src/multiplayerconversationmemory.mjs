import { fallbackMemorySynthesis } from './npcmemory.mjs';
import { commitNpcConversationNarrative } from './npcnarrativecontinuity.mjs';
import { recordPlayerConversationOutcome } from './npcrumor.mjs';
import { rememberSocialMemory } from './npcsocialmemory.mjs';
import { registerLivingWorldEntity } from './livingworldstate.mjs';

/**
 * Project one participant's accepted part of a group NPC conversation into the
 * host world. The room journal may contain every speaker, but a participant's
 * personal memory branch receives only their own human utterances and the NPC
 * replies that were accepted for the room.
 */
export function commitGroupConversationMemory({
  state, memoryStore, save, roomId, npcId, playerId, room, events, context, synthesis,
  joinedSeq: suppliedJoinedSeq = null,
} = {}) {
  if (!state || !memoryStore || !npcId || !playerId) return false;
  const id = String(playerId);
  const roomKey = String(roomId || 'room');
  const baseReceiptKey = `conversation-participant:${roomKey}:${id}`;
  const joinedSeq = Number(room?.members?.find?.((member) => member.playerId === id)?.joinedSeq)
    || Number(suppliedJoinedSeq) || 0;
  const receiptKey = `${baseReceiptKey}:${joinedSeq}`;
  const priorReceipt = state.conversationReceipts?.[receiptKey];
  if (priorReceipt?.durable) return state.conversationMemories?.[JSON.stringify([npcId, id])]
    || memoryStore.load(npcId, id);
  // Stage all canonical effects in one world snapshot. The world's single
  // storage write commits the memory, relationship changes and receipt together.
  const canonicalState = state;
  state = structuredClone(state);
  const visible = Array.isArray(room?.events) ? room.events : (Array.isArray(events) ? events : []);
  const transcript = visible
    .filter((event) => event?.kind === 'message'
      && (!Array.isArray(event.audience) || event.audience.includes(id))
      && (event.speakerKind === 'npc' || event.speakerId === id))
    .map((event) => ({
      role: event.speakerKind === 'npc' ? 'assistant' : 'user',
      speakerId: event.speakerId,
      content: String(event.content || '').slice(0, 320),
      source: event.speakerKind === 'npc' ? 'host-accepted' : 'player',
    }))
    .filter((message) => message.content);
  if (!transcript.length) return false;

  const memoryKey = JSON.stringify([npcId, id]);
  const previous = state.conversationMemories?.[memoryKey] || memoryStore.load(npcId, id);
  const memory = fallbackMemorySynthesis(previous, context || { npc: { id: npcId } }, transcript);
  const ownPlans = transcript.filter((message) => message.role === 'user'
    && /\b(?:I|I'm|I've)\s+(?:promis|will|am|have|need|must|want|plan|am going|was looking|was searching)/i.test(message.content));
  // A report that somebody else promised something is evidence of a report,
  // not a new quest or obligation for the reporting traveller.
  memory.quests = [...new Set([
    ...fallbackMemorySynthesis(emptyMemory(npcId), context || { npc: { id: npcId } }, ownPlans).quests,
    ...(previous.quests || []),
  ])].slice(0, 8);
  const counted = Object.values(state.conversationReceipts || {}).some((receipt) =>
    receipt.roomId === roomKey && receipt.playerId === id && receipt.durable);
  if (counted) memory.meetingCount = previous.meetingCount;
  const saved = memory;
  state.conversationMemories ||= {};
  state.conversationMemories[memoryKey] = saved;
  const nowHour = Number(state.clock?.worldHours) || 0;
  state.conversationEvidence ||= {};
  for (const event of visible) {
    if (event.kind !== 'message' || event.speakerId !== id || !event.eventId) continue;
    if (state.conversationEvidence[event.eventId]) continue;
    const witnesses = [...new Set(event.audience || [id])];
    const text = String(event.content || '').slice(0, 320);
    const direct = /^\s*(?:I\b|I'm\b|I've\b|my\b)/i.test(text);
    const namedSubjects = (room?.members || []).filter((member) => {
      const known = state.conversationMemories[JSON.stringify([npcId, member.playerId])];
      const spoken = visible.filter((entry) => entry.kind === 'message' && entry.speakerId === member.playerId)
        .map((entry) => /\b(?:my name is|call me)\s+([^.!?]+)/i.exec(entry.content)?.[1]?.trim()).find(Boolean);
      const name = spoken || learnedPlayerName(known);
      return name && text.toLowerCase().includes(name.toLowerCase());
    });
    const subjectId = direct ? id : namedSubjects.length === 1 ? namedSubjects[0].playerId : null;
    const evidence = {
      eventId: event.eventId, roomId: roomKey, npcId, speakerId: id,
      subjectId, witnessIds: witnesses, addressedTo: event.addressedTo || [],
      statement: text, kind: direct ? 'self-report' : 'report',
      atHour: nowHour,
    };
    state.conversationEvidence[event.eventId] = evidence;
    rememberSocialMemory(state, npcId, {
      id: `memory:${event.eventId}`, ownerId: npcId,
      subject: { kind: 'player', id: subjectId || id }, predicate: 'visitor.reported',
      object: { text, speakerId: id, subjectId, witnessIds: witnesses, evidenceId: event.eventId },
      summary: `A traveller reported: “${text}”`,
      source: { kind: 'player', id }, sourceChain: [{ kind: 'player', id }],
      provenance: 'player-claim', originEventId: event.eventId, lineageId: event.eventId,
      confidence: 0.7, salience: 0.7, privacy: 'personal', hopCount: 0,
      createdAtHour: nowHour, lastRecalledHour: nowHour, expiresAtHour: null,
    }, { nowHour });
  }
  const conversation = {
    id: `group:${roomKey}:${id}`,
    participantIds: [String(npcId), id],
  };
  if (transcript.some((message) => message.role === 'user')) recordPlayerConversationOutcome(state, conversation, {
    npcId, playerId: id,
    playerTurns: transcript.filter((message) => message.role === 'user').length,
    nowHour,
  });

  const member = room?.members?.find?.((entry) => entry.playerId === id) || null;
  const originLabel = context?.player?.originLabel || 'traveller';
  const learnedName = learnedPlayerName(saved);
  const subject = learnedName ? `${learnedName}, a ${originLabel}` : `a ${originLabel}`;
  const summary = `${subject} visited and spoke with ${context?.npc?.name || 'the resident'}.`;
  rememberSocialMemory(state, npcId, {
    id: `memory:${npcId}:group-visit:${roomKey}:${id}`,
    ownerId: npcId,
    subject: { kind: 'player', id },
    predicate: 'visitor.met',
    object: { roomId: roomKey, playerId: id, text: summary },
    summary,
    source: { kind: 'player', id },
    sourceChain: [{ kind: 'player', id }],
    provenance: 'observed',
    originEventId: `event:${roomKey}:${id}:player-conversation`,
    lineageId: `group-visit:${roomKey}:${id}`,
    confidence: 1,
    salience: 0.86,
    privacy: 'public',
    hopCount: 0,
    createdAtHour: nowHour,
    lastRecalledHour: nowHour,
    expiresAtHour: null,
  }, { nowHour });
  registerLivingWorldEntity(state, {
    id,
    kind: 'player',
    // A profile display name is a human-facing label. The NPC learns a name
    // only from the attributable transcript above.
    name: 'Traveller',
    role: 'traveller',
    homeOrigin: member?.homeOrigin || null,
  });
  state.revision = (Number(state.revision) || 0) + 1;
  if (synthesis && state.features?.npcNarrativeFactPropagationEnabled && context?.homeCommunity) {
    try {
      commitNpcConversationNarrative({
        state, context, transcript, synthesis: {
          ...synthesis,
          narrativeClaims: { ...synthesis.narrativeClaims, thirdPartyClaims:
            (synthesis.narrativeClaims?.thirdPartyClaims || []).filter((claim) =>
              !String(claim.subjectId || '').startsWith('player:')) },
        }, memoryStore: null,
      });
    } catch (error) {
      console.warn?.('[wander conversation] narrative projection rejected', error);
    }
  }
  state.conversationReceipts ||= {};
  state.conversationReceipts[receiptKey] = {
    roomId: roomKey, npcId: String(npcId), playerId: id, joinedSeq,
    committedAt: Date.now(), durable: true,
  };
  const changedKeys = ['conversationMemories', 'conversationReceipts', 'conversationEvidence', 'relationships',
    'memories', 'entities', 'revision', 'events', 'effectReceipts', 'metrics',
    'narrativeFacts', 'narrativeFactReceipts'];
  const before = Object.fromEntries(changedKeys.map((key) => [key, canonicalState[key]]));
  for (const key of changedKeys) canonicalState[key] = state[key];
  let persisted = false;
  try { persisted = save?.() !== false; } catch { persisted = false; }
  if (!persisted) {
    for (const key of changedKeys) {
      if (before[key] === undefined) delete canonicalState[key];
      else canonicalState[key] = before[key];
    }
  }
  return persisted ? saved : false;
}

function learnedPlayerName(memory) {
  for (const fact of memory?.playerFacts || []) {
    const match = /traveller'?s name is\s+([^.!?]+)/i.exec(fact);
    if (match) return match[1].trim().slice(0, 120);
  }
  return null;
}

function emptyMemory(npcId) {
  return { npcId, meetingCount: 0, playerFacts: [], npcFacts: [], quests: [], landmarks: [], worldFacts: [] };
}
