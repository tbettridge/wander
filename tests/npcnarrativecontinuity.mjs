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
