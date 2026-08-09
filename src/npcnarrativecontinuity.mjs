import {
  buildNpcNarrativeGraph,
  createNarrativeRetrievalCache,
  retrieveNpcNarrative,
} from './npcnarrativegraph.mjs';
import {
  applyNpcNarrativeFacts,
  confirmNpcNarrativeFacts,
  normalizeNarrativeClaimSynthesis,
  planNpcNarrativeFacts,
  projectNarrativeFactsToMemory,
} from './npcnarrativefacts.mjs';

/** Build disposable, conversation-owned retrieval state from canonical records. */
export function createNpcNarrativeConversation({ state, context } = {}) {
  return {
    graph: graphFor(state, context),
    cache: createNarrativeRetrievalCache(),
  };
}

/** Retrieve a bounded packet, rebuilding the disposable graph after state changes. */
export function retrieveNpcConversationNarrative(session, {
  state, context, speakerId = context?.npc?.id, text = '', conversationId = 'default',
} = {}) {
  if (!session || typeof session !== 'object') {
    throw new TypeError('Narrative conversation state is required.');
  }
  if (session.graph?.worldRevision !== String(state?.revision ?? 0)) {
    session.graph = graphFor(state, context);
  }
  return retrieveNpcNarrative(session.graph, {
    speakerId, text, conversationId, maxHops: 2, maxFacts: 8,
  }, session.cache);
}

/**
 * Validate untrusted synthesis, apply exact-once facts, and project accepted
 * statements into the subject's fallible personal memory without a new meeting.
 */
export function commitNpcConversationNarrative({
  state, context, transcript, synthesis, memoryStore = null,
} = {}) {
  if (!state || typeof state !== 'object' || !context?.npc?.id) {
    throw new TypeError('Canonical state and speaker context are required.');
  }
  const facts = recordValues(state.narrativeFacts);
  const receipts = recordValues(state.narrativeFactReceipts);
  const residents = context.homeCommunity?.residents || [];
  const speaker = person(context.npc, residents.find((entry) => entry.id === context.npc.id));
  const allowedSubjects = residents.map((entry) => person(entry, entry));
  const normalized = normalizeNarrativeClaimSynthesis(synthesis?.narrativeClaims ?? synthesis);
  const plan = planNpcNarrativeFacts({
    synthesis: normalized,
    transcript: Array.isArray(transcript) ? transcript : [],
    speaker,
    allowedSubjects,
    narrativeFacts: facts,
  });
  const next = applyNpcNarrativeFacts({ narrativeFacts: facts, receipts }, plan);
  const confirmationIds = validatedConfirmationIds(
    synthesis?.narrativeConfirmations,
    transcript,
    speaker.id,
    next.narrativeFacts,
  );
  const confirmed = confirmNpcNarrativeFacts({
    narrativeFacts: next.narrativeFacts,
    receipts: next.receipts,
  }, { subjectId: speaker.id, factIds: confirmationIds });

  state.metrics ||= {};
  state.metrics.narrativeFactsAccepted = finiteCount(state.metrics.narrativeFactsAccepted)
    + next.applied.length;
  state.metrics.narrativeFactsRejected = finiteCount(state.metrics.narrativeFactsRejected)
    + plan.rejected.length;
  if (next.applied.length || confirmed.applied.length) {
    state.narrativeFacts = keyed(confirmed.narrativeFacts);
    state.narrativeFactReceipts = keyed(confirmed.receipts);
    state.revision = finiteCount(state.revision) + 1;
    if (memoryStore?.load && memoryStore?.save) {
      for (const subjectId of [...new Set(next.applied.map((receipt) => receipt.subjectId))].sort()) {
        const current = memoryStore.load(subjectId);
        memoryStore.save(subjectId, projectNarrativeFactsToMemory(current, confirmed.narrativeFacts, {
          targetNpcId: subjectId,
        }));
      }
    }
  }
  return {
    plan,
    ...next,
    narrativeFacts: confirmed.narrativeFacts,
    receipts: confirmed.receipts,
    confirmationsApplied: confirmed.applied,
  };
}

function validatedConfirmationIds(values, transcript, speakerId, facts) {
  if (!Array.isArray(values) || !Array.isArray(transcript)) return [];
  const byId = new Map(facts.map((fact) => [fact?.id, fact]));
  const accepted = [];
  for (const value of values.slice(0, 8)) {
    const fact = byId.get(value?.factId);
    const index = value?.evidence?.messageIndex;
    const quote = value?.evidence?.quote;
    const message = transcript[index];
    if (!fact || fact.subjectId !== speakerId || fact.status === 'retracted'
      || !Number.isInteger(index) || index < 0 || typeof quote !== 'string'
      || message?.role !== 'assistant'
      || (message.speakerId !== undefined && message.speakerId !== speakerId)
      || message.content !== quote || fact.statement !== quote) continue;
    accepted.push(fact.id);
  }
  return [...new Set(accepted)].sort();
}

function graphFor(state, context) {
  if (!state || typeof state !== 'object') throw new TypeError('Canonical state is required.');
  const residents = context?.homeCommunity?.residents || [];
  const residentIds = new Set(residents.map((resident) => resident?.id).filter(Boolean));
  const speakerId = context?.npc?.id;
  const narrativeFacts = Object.fromEntries(Object.entries(state.narrativeFacts || {})
    .filter(([, fact]) => residentIds.has(fact?.subjectId)
      || fact?.knownBy?.includes(speakerId)));
  return buildNpcNarrativeGraph({
    revision: state.revision,
    communityRecords: residents,
    relationships: state.relationships || {},
    socialMemories: state.memories || {},
    commitments: state.commitments || {},
    narrativeFacts,
  });
}

function person(primary, resident) {
  const name = String(primary?.name || resident?.name || '').trim();
  const id = String(primary?.id || resident?.id || '').trim();
  const surname = String(resident?.family?.surname || resident?.household?.surname || '').trim();
  return { id, name, aliases: surname && surname !== name ? [surname] : [] };
}

function recordValues(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.values(value) : [];
}

function keyed(values) {
  return Object.fromEntries(values.map((value) => [value.id, value]));
}

function finiteCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}
