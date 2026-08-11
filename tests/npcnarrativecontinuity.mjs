import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitNpcConversationNarrative,
  createNpcNarrativeConversation,
  retrieveNpcConversationNarrative,
} from '../src/npcnarrativecontinuity.mjs';

function fixture() {
  const residents = [
    {
      id: 'npc:ada', name: 'Ada Reed', role: 'baker',
      family: { surname: 'Reed' }, workplace: { name: 'The Bakery' },
      home: { direction: 'north', distancePhrase: 'just over there' },
    },
    {
      id: 'npc:bea', name: 'Beatrice Bell', role: 'miller',
      family: { surname: 'Bell' }, workplace: { name: 'The Mill' },
      home: { direction: 'east', distancePhrase: 'about two hundred metres' },
    },
  ];
  return {
    state: {
      revision: 3, relationships: {}, memories: {}, commitments: {},
      narrativeFacts: {}, narrativeFactReceipts: {},
      metrics: { narrativeFactsAccepted: 0, narrativeFactsRejected: 0 },
    },
    context: {
      npc: { id: 'npc:ada', name: 'Ada Reed' },
      homeCommunity: { id: 'settlement:one', name: 'Bellwater', residents },
    },
  };
}

test('conversation retrieval rebuilds on revision and resolves community people', () => {
  const { state, context } = fixture();
  const session = createNpcNarrativeConversation({ state, context });
  const first = retrieveNpcConversationNarrative(session, {
    state, context, text: 'What does Beatrice do?', conversationId: 'conversation:1',
  });
  assert.deepEqual(first.query.entityIds, ['npc:bea']);
  assert.ok(first.speakable.some((fact) => fact.entityIds.includes('npc:bea')));
  const cached = retrieveNpcConversationNarrative(session, {
    state, context, text: 'What does Beatrice do?', conversationId: 'conversation:1',
  });
  assert.equal(cached.cacheHit, true);
  state.revision++;
  const revised = retrieveNpcConversationNarrative(session, {
    state, context, text: 'What does Beatrice do?', conversationId: 'conversation:1',
  });
  assert.equal(revised.cacheHit, false);
  assert.equal(revised.worldRevision, '4');
});

test('public facts outside the speaker community do not leak into topic retrieval', () => {
  const { state, context } = fixture();
  state.narrativeFacts['fact:outsider'] = {
    id: 'fact:outsider', subjectId: 'npc:outsider', factKey: 'craft',
    statement: 'Corin Faraway carves ivory combs', knownBy: ['npc:outsider'],
    visibility: 'public', status: 'confirmed', provenance: 'observed',
  };
  const session = createNpcNarrativeConversation({ state, context });
  const packet = retrieveNpcConversationNarrative(session, {
    state, context, text: 'Who carves ivory combs?', conversationId: 'conversation:scope',
  });
  assert.equal([...packet.speakable, ...packet.consistencyOnly]
    .some((fact) => fact.id === 'fact:outsider'), false);
});

test('validated cross-NPC facts persist exactly once and enter subject memory', () => {
  const { state, context } = fixture();
  const memories = new Map([
    ['npc:bea', { npcId: 'npc:bea', meetingCount: 5, npcFacts: ['Beatrice likes the river.'] }],
  ]);
  const memoryStore = {
    load: (id) => structuredClone(memories.get(id) || { npcId: id, meetingCount: 0, npcFacts: [] }),
    save: (id, value) => { memories.set(id, structuredClone(value)); return value; },
  };
  const transcript = [
    { role: 'user', speakerId: 'player:local', content: 'What is Beatrice repairing?' },
    { role: 'assistant', speakerId: 'npc:ada', content: 'Beatrice Bell repairs the old mill wheel.' },
  ];
  const synthesis = {
    narrativeClaims: {
      version: 1,
      thirdPartyClaims: [{
        subjectId: 'npc:bea', factKey: 'craft.mill-repair', value: 'repairs the old mill wheel',
        statement: 'Beatrice Bell repairs the old mill wheel.', classification: 'asserted-fact',
        evidence: { messageIndex: 1, quote: 'Beatrice Bell repairs the old mill wheel.' },
        visibility: 'shared',
      }],
    },
  };
  const first = commitNpcConversationNarrative({
    state, context, transcript, synthesis, memoryStore,
  });
  assert.equal(first.applied.length, 1);
  assert.equal(Object.keys(state.narrativeFacts).length, 1);
  assert.equal(Object.keys(state.narrativeFactReceipts).length, 1);
  assert.equal(state.metrics.narrativeFactsAccepted, 1);
  assert.equal(memories.get('npc:bea').meetingCount, 5);
  assert.equal(memories.get('npc:bea').npcFacts[0], 'Beatrice Bell repairs the old mill wheel.');

  const retry = commitNpcConversationNarrative({
    state, context, transcript, synthesis, memoryStore,
  });
  assert.equal(retry.applied.length, 0);
  assert.equal(Object.keys(state.narrativeFactReceipts).length, 1);
});

test('speculation and invented subjects fail closed without state changes', () => {
  const { state, context } = fixture();
  const before = structuredClone(state);
  const transcript = [{
    role: 'assistant', speakerId: 'npc:ada', content: 'Perhaps Beatrice Bell owns a silver crown.',
  }];
  const result = commitNpcConversationNarrative({
    state, context, transcript,
    synthesis: { narrativeClaims: { version: 1, thirdPartyClaims: [{
      subjectId: 'npc:missing', factKey: 'possessions.crown', value: 'silver crown',
      statement: transcript[0].content, classification: 'asserted-fact',
      evidence: { messageIndex: 0, quote: transcript[0].content }, visibility: 'public',
    }] } },
  });
  assert.equal(result.applied.length, 0);
  assert.equal(result.plan.rejected[0].reason, 'invalid-subject');
  assert.deepEqual(state.narrativeFacts, before.narrativeFacts);
  assert.deepEqual(state.narrativeFactReceipts, before.narrativeFactReceipts);
  assert.equal(state.metrics.narrativeFactsRejected, 1);
});

test('a subject can explicitly confirm an asserted fact about their own life', () => {
  const { state, context } = fixture();
  const statement = 'Ada Reed learned baking from her aunt.';
  state.narrativeFacts['fact:ada:aunt'] = {
    version: 1, id: 'fact:ada:aunt', subjectId: 'npc:ada', factKey: 'history.baking-teacher',
    value: 'her aunt', statement, classification: 'asserted-fact', status: 'asserted',
    confidence: 0.7, visibility: 'shared', knownBy: ['npc:bea'], contradicts: [],
    provenance: { speakerId: 'npc:bea', speakerName: 'Beatrice Bell' },
  };
  const session = createNpcNarrativeConversation({ state, context });
  const packet = retrieveNpcConversationNarrative(session, {
    state, context, text: 'Who taught you baking?', conversationId: 'conversation:confirm',
  });
  assert.equal(packet.consistencyOnly.some((fact) => fact.id === 'fact:ada:aunt'), true);
  const transcript = [{ role: 'assistant', speakerId: 'npc:ada', content: statement }];
  const result = commitNpcConversationNarrative({
    state, context, transcript,
    synthesis: {
      narrativeClaims: { version: 1, thirdPartyClaims: [] },
      narrativeConfirmations: [{
        factId: 'fact:ada:aunt', evidence: { messageIndex: 0, quote: statement },
      }],
    },
  });
  assert.equal(result.confirmationsApplied.length, 1);
  assert.equal(state.narrativeFacts['fact:ada:aunt'].status, 'confirmed');
  assert.deepEqual(state.narrativeFacts['fact:ada:aunt'].knownBy, ['npc:ada', 'npc:bea']);
});

// --- the village talks about the traveller -----------------------------------

/** The shape a validated claim about the player has to take. */
function travellerClaim(quote, {
  factKey = 'traveller.destination', value = 'the lighthouse', visibility = 'shared',
} = {}) {
  return {
    version: 1,
    thirdPartyClaims: [{
      subjectId: 'player:local',
      factKey,
      value,
      statement: quote,
      classification: 'asserted-fact',
      evidence: { messageIndex: 1, quote },
      visibility,
    }],
  };
}

function travellerTranscript(quote) {
  return [
    { role: 'user', content: 'I am walking out to the lighthouse.', speakerId: 'player:local' },
    { role: 'assistant', content: quote, speakerId: 'npc:ada', source: 'edge' },
  ];
}

test('a traveller fact is minted from what an NPC says back, not from what the player typed', () => {
  const { state, context } = fixture();
  const quote = 'So you are walking out to the lighthouse.';
  const result = commitNpcConversationNarrative({
    state, context,
    transcript: travellerTranscript(quote),
    synthesis: { narrativeClaims: travellerClaim(quote) },
  });
  assert.equal(result.plan.rejected.length, 0, JSON.stringify(result.plan.rejected));
  assert.equal(result.applied.length, 1);

  const [fact] = Object.values(state.narrativeFacts);
  assert.equal(fact.subjectId, 'player:local');
  assert.equal(fact.factKey, 'traveller.destination');
  assert.deepEqual(fact.knownBy, ['npc:ada'], 'only the person who said it starts out knowing');
  assert.equal(fact.provenance.speakerId, 'npc:ada');

  // The evidence must be the NPC's own line. A claim quoting the player's own
  // message is how the traveller would otherwise write directly into canon.
  const { state: other, context: otherContext } = fixture();
  const playerQuote = 'I am walking out to the lighthouse.';
  const injected = commitNpcConversationNarrative({
    state: other, context: otherContext,
    transcript: travellerTranscript(playerQuote),
    synthesis: {
      narrativeClaims: {
        version: 1,
        thirdPartyClaims: [{
          ...travellerClaim(playerQuote).thirdPartyClaims[0],
          evidence: { messageIndex: 0, quote: playerQuote },
        }],
      },
    },
  });
  assert.deepEqual(injected.plan.rejected, [{ index: 0, reason: 'non-npc-evidence' }]);
  assert.deepEqual(other.narrativeFacts, {});
});

test('a traveller claim must be namespaced and cannot be posted to the whole region', () => {
  const quote = 'So you are walking out to the lighthouse.';
  for (const [options, reason] of [
    [{ factKey: 'destination' }, 'player-fact-key-required'],
    [{ factKey: 'traveller.destination', visibility: 'public' }, 'player-visibility-too-broad'],
    // Namespacing does not buy an exemption: the reserved-field guard runs
    // first, so `traveller.home` and `traveller.location` stay blocked.
    [{ factKey: 'traveller.location' }, 'reserved-authoritative-field'],
    [{ factKey: 'traveller.home' }, 'reserved-authoritative-field'],
  ]) {
    const { state, context } = fixture();
    const result = commitNpcConversationNarrative({
      state, context,
      transcript: travellerTranscript(quote),
      synthesis: { narrativeClaims: travellerClaim(quote, options) },
    });
    assert.deepEqual(result.plan.rejected, [{ index: 0, reason }],
      `${JSON.stringify(options)} must be rejected as ${reason}`);
    assert.deepEqual(state.narrativeFacts, {});
  }
});

test('what one resident learns about the traveller reaches whoever trusts them', () => {
  const { state, context } = fixture();
  const quote = 'So you are walking out to the lighthouse.';
  commitNpcConversationNarrative({
    state, context,
    transcript: travellerTranscript(quote),
    synthesis: { narrativeClaims: travellerClaim(quote) },
  });

  // Beatrice was not there and does not yet trust Ada, so she has nothing.
  const beaContext = { ...context, npc: { id: 'npc:bea', name: 'Beatrice Bell' } };
  const stranger = retrieveNpcConversationNarrative(
    createNpcNarrativeConversation({ state, context: beaContext }),
    { state, context: beaContext, text: 'Have we met before?', conversationId: 'c:1' },
  );
  assert.equal(stranger.speakable.some((fact) => /lighthouse/.test(fact.statement)), false,
    'a shared fact does not reach someone with no path to the person holding it');

  // Give her a reason to have heard it, and the same retrieval finds it.
  state.relationships['npc:bea|npc:ada'] = {
    ownerId: 'npc:bea', subjectId: 'npc:ada', trust: 0.6, tags: ['trusted'],
  };
  state.revision++;
  const trusted = retrieveNpcConversationNarrative(
    createNpcNarrativeConversation({ state, context: beaContext }),
    { state, context: beaContext, text: 'Have we met before?', conversationId: 'c:2' },
  );
  assert.ok(trusted.speakable.some((fact) => /lighthouse/.test(fact.statement)),
    'a trusted path is what carries it — the traveller is always a retrieval seed');
});

test('the traveller is a subject, not a resident with a memory of their own', () => {
  const { state, context } = fixture();
  const quote = 'So you are walking out to the lighthouse.';
  const saved = [];
  commitNpcConversationNarrative({
    state, context,
    transcript: travellerTranscript(quote),
    synthesis: { narrativeClaims: travellerClaim(quote) },
    memoryStore: {
      load: (id) => ({ npcId: id, npcFacts: [] }),
      save: (id, memory) => { saved.push(id); return memory; },
    },
  });
  assert.deepEqual(saved, [], 'no memory record is invented for the player');
});
