import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNpcNarrativeGraph,
  createNarrativeRetrievalCache,
  narrativeFactAccess,
  resolveNarrativeEntities,
  retrieveNpcNarrative,
} from '../src/npcnarrativegraph.mjs';

function fixture(revision = 7) {
  return {
    revision,
    entities: {
      'npc:alder': { id: 'npc:alder', name: 'Alder Reed', role: 'keeper', workplace: 'Ash Gate' },
      'npc:mira': { id: 'npc:mira', name: 'Mira Reed', role: 'baker', workplace: 'Mill' },
      'npc:other-reed': { id: 'npc:other-reed', name: 'Oren Reed', role: 'smith', workplace: 'Forge' },
      'npc:wren': { id: 'npc:wren', name: 'Wren Bell', role: 'courier', workplace: 'Ash Gate' },
    },
    relationships: {
      a: { ownerId: 'npc:alder', subjectId: 'npc:mira', trust: 0.8, tags: ['family'] },
      b: { ownerId: 'npc:alder', subjectId: 'npc:wren', trust: 0.1 },
    },
    memories: {
      'npc:alder': [{
        id: 'memory:letter', ownerId: 'npc:alder', subject: { id: 'npc:wren' },
        summary: 'Wren delivered the blue letter', predicate: 'letter.delivered',
        knownBy: ['npc:alder'], provenance: 'observed', privacy: 'private',
        source: { id: 'event:letter' }, confidence: 1, salience: 1,
      }],
    },
    narrativeFacts: [
      { id: 'fact:festival', statement: 'The harvest festival begins at Ash Gate', subjectId: 'npc:wren', topics: ['festival'], visibility: 'public' },
      { id: 'fact:mira-debt', statement: 'Mira owes the miller three crowns', subjectId: 'npc:mira', topics: ['debt'], knownBy: ['npc:alder'], visibility: 'private', privacy: 'personal', provenance: 'observed' },
      { id: 'fact:secret', statement: 'The bell hides a key', subjectId: 'npc:mira', topics: ['key'], knownBy: ['npc:mira'], visibility: 'secret', privacy: 'private' },
      { id: 'fact:guess', statement: 'Mira may leave after winter', subjectId: 'npc:mira', topics: ['winter'], knownBy: ['npc:alder'], visibility: 'private', provenance: 'inferred' },
    ],
  };
}

test('access preserves privacy and does not make an NPC omniscient', () => {
  const graph = buildNpcNarrativeGraph(fixture());
  assert.equal(narrativeFactAccess(graph, 'fact:mira-debt', 'npc:alder'), 'speakable');
  assert.equal(narrativeFactAccess(graph, 'fact:secret', 'npc:alder'), 'inaccessible');
  assert.equal(narrativeFactAccess(graph, 'fact:guess', 'npc:alder'), 'consistency-only');
  const packet = retrieveNpcNarrative(graph, { speakerId: 'npc:alder', text: 'What key does Mira have?' });
  assert.equal(packet.facts.some((fact) => fact.id === 'fact:secret'), false);
  assert.doesNotMatch(JSON.stringify(packet), /hides a key/);
});

test('private owner memory constrains but cannot be disclosed to unrelated subjects', () => {
  const graph = buildNpcNarrativeGraph(fixture());
  const ownerPacket = retrieveNpcNarrative(graph, { speakerId: 'npc:alder', text: 'blue letter Wren' });
  const subjectPacket = retrieveNpcNarrative(graph, { speakerId: 'npc:wren', text: 'blue letter' });
  assert.equal(ownerPacket.speakable.some((fact) => fact.id === 'memory:letter'), true);
  assert.equal(subjectPacket.facts.some((fact) => fact.id === 'memory:letter'), false);
});

test('public facts cross the community while shared facts require a trusted path', () => {
  const source = fixture();
  source.narrativeFacts.push({
    id: 'fact:public-craft', statement: 'Mira carves beechwood spoons',
    subjectId: 'npc:mira', knownBy: ['npc:alder'], visibility: 'public',
  }, {
    id: 'fact:shared-craft', statement: 'Mira is restoring a family cradle',
    subjectId: 'npc:mira', knownBy: ['npc:alder'], visibility: 'shared',
  });
  const graph = buildNpcNarrativeGraph(source);
  const stranger = retrieveNpcNarrative(graph, {
    speakerId: 'npc:wren', text: 'What does Mira carve or restore?', maxFacts: 20,
  });
  assert.equal(stranger.speakable.some((fact) => fact.id === 'fact:public-craft'), true);
  assert.equal(stranger.facts.some((fact) => fact.id === 'fact:shared-craft'), false);
  source.relationships.c = {
    ownerId: 'npc:wren', subjectId: 'npc:alder', trust: 0.7, tags: ['trusted'],
  };
  const trusted = retrieveNpcNarrative(buildNpcNarrativeGraph(source), {
    speakerId: 'npc:wren', text: 'What does Mira carve or restore?', maxFacts: 20,
  });
  assert.equal(trusted.speakable.some((fact) => fact.id === 'fact:shared-craft'), true);
});

test('text resolution reports ambiguous surnames and workplaces deterministically', () => {
  const graph = buildNpcNarrativeGraph(fixture());
  const result = resolveNarrativeEntities(graph, 'Ask Reed at Ash Gate, or npc:wren.');
  assert.deepEqual(result.entityIds, ['npc:wren']);
  assert.deepEqual(result.ambiguous, [
    { text: 'ash gate', candidateIds: ['npc:alder', 'npc:wren'] },
    { text: 'reed', candidateIds: ['npc:alder', 'npc:mira', 'npc:other-reed'] },
  ]);
});

test('graph construction and ranking are stable across insertion order', () => {
  const first = fixture();
  const second = fixture();
  second.entities = Object.fromEntries(Object.entries(second.entities).reverse());
  second.relationships = Object.fromEntries(Object.entries(second.relationships).reverse());
  second.narrativeFacts.reverse();
  const request = { speakerId: 'npc:alder', text: 'Tell me about Mira and the mill', maxFacts: 20 };
  assert.deepEqual(retrieveNpcNarrative(buildNpcNarrativeGraph(first), request),
    retrieveNpcNarrative(buildNpcNarrativeGraph(second), request));
});

test('retrieval enforces one or two hop and result bounds', () => {
  const graph = buildNpcNarrativeGraph(fixture());
  const oneHop = retrieveNpcNarrative(graph, {
    speakerId: 'npc:alder', text: '', entityIds: ['npc:alder'], maxHops: 1, maxFacts: 2,
  });
  const twoHop = retrieveNpcNarrative(graph, {
    speakerId: 'npc:alder', text: '', entityIds: ['npc:alder'], maxHops: 99, maxFacts: 99,
  });
  assert.ok(oneHop.facts.length <= 2);
  assert.ok(oneHop.facts.every((fact) => fact.hops <= 1));
  assert.equal(twoHop.limits.maxHops, 2);
  assert.ok(twoHop.facts.every((fact) => fact.hops <= 2));
  assert.doesNotThrow(() => JSON.stringify(twoHop));
});

test('conversation cache hits only at the same world revision', () => {
  const cache = createNarrativeRetrievalCache();
  const request = { speakerId: 'npc:alder', text: 'festival', conversationId: 'conversation:1' };
  const first = retrieveNpcNarrative(buildNpcNarrativeGraph(fixture(7)), request, cache);
  const hit = retrieveNpcNarrative(buildNpcNarrativeGraph(fixture(7)), request, cache);
  const revised = retrieveNpcNarrative(buildNpcNarrativeGraph(fixture(8)), request, cache);
  assert.equal(first.cacheHit, false);
  assert.equal(hit.cacheHit, true);
  assert.equal(revised.cacheHit, false);
  assert.equal(cache.worldRevision, '8');
});

test('building and retrieving never mutate canonical records', () => {
  const source = fixture();
  const before = structuredClone(source);
  const graph = buildNpcNarrativeGraph(source);
  retrieveNpcNarrative(graph, { speakerId: 'npc:alder', text: 'Mira debt' });
  assert.deepEqual(source, before);
  assert.equal(graph.authoritative, false);
});
