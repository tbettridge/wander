import {
  buildNpcNarrativeGraph,
  createNarrativeRetrievalCache,
  retrieveNpcNarrative,
} from './npcnarrativegraph.mjs';
import {
  applyNpcNarrativeFacts,
  confirmNpcNarrativeFacts,
  normalizeNarrativeClaimSynthesis,
  PLAYER_NARRATIVE_SUBJECT_ID,
  planNpcNarrativeFacts,
  projectNarrativeFactsToMemory,
} from './npcnarrativefacts.mjs';

// Second-person forms count as naming the traveller, because that is how a
// character addresses them. Without these the evidence check could never pass
// for a claim about the player: nobody says "the traveller" to their face.
const PLAYER_ALIASES = Object.freeze(['you', 'your', "you're", 'traveller', 'the traveller']);

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
    // The traveller is always a seed, so what this speaker may know about the
    // person in front of them is always a candidate. It still has to outscore
    // everything else to be selected, so an unrelated question does not drag
    // the player's business into the answer.
    entityIds: [PLAYER_NARRATIVE_SUBJECT_ID],
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
  const allowedSubjects = [
    ...residents.map((entry) => person(entry, entry)),
    playerPerson(context),
  ];
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
      const subjectIds = [...new Set(next.applied.map((receipt) => receipt.subjectId))]
        // The traveller is a subject the village holds facts about, not a
        // resident with a memory of their own. Their facts live in the graph
        // and reach other people through retrieval.
        .filter((subjectId) => subjectId !== PLAYER_NARRATIVE_SUBJECT_ID)
        .sort();
      for (const subjectId of subjectIds) {
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
      // Everything the village believes about the traveller enters every
      // speaker's graph. Whether THIS speaker may repeat it is not decided
      // here: narrativeFactAccess already answers that from visibility and
      // who trusts whom, which is exactly how a rumour travels.
      || fact?.subjectId === PLAYER_NARRATIVE_SUBJECT_ID
      || fact?.knownBy?.includes(speakerId)));
  return buildNpcNarrativeGraph({
    revision: state.revision,
    communityRecords: [...residents, playerRecord(context)],
    relationships: state.relationships || {},
    socialMemories: state.memories || {},
    commitments: state.commitments || {},
    narrativeFacts,
  });
}

/**
 * The traveller as the graph sees them.
 *
 * A named entity so a two-hop walk from the player seed reaches everything
 * said about them, and so a resident who has learned their name can be asked
 * about them by it.
 */
function playerRecord(context) {
  return {
    id: PLAYER_NARRATIVE_SUBJECT_ID,
    name: playerName(context),
    role: 'traveller',
    // Deliberately not 'you': it appears in almost every line an NPC speaks,
    // and aliasing it here would resolve the player as a mentioned entity on
    // nearly every turn.
    aliases: ['traveller'],
  };
}

function playerPerson(context) {
  const name = playerName(context);
  return {
    id: PLAYER_NARRATIVE_SUBJECT_ID,
    name,
    aliases: [...new Set([...PLAYER_ALIASES, name.toLowerCase()])]
      .filter((alias) => alias !== name),
  };
}

/** Whatever this speaker has learned the traveller is called, else the role. */
function playerName(context) {
  for (const fact of context?.memory?.playerFacts || []) {
    const match = /traveller'?s name is\s+([^.!?]+)/i.exec(String(fact || ''));
    const name = match?.[1]?.trim();
    if (name) return name.slice(0, 120);
  }
  return 'the traveller';
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
