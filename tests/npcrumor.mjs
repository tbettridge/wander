import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivingWorldState, registerLivingWorldEntity } from '../src/livingworldstate.mjs';
import { rememberSocialMemory } from '../src/npcsocialmemory.mjs';
import {
  beginNpcConversation,
  exchangeRumors,
  RUMOR_MAX_HOPS,
  rumorInspector,
  sourcedRumorPhrase,
} from '../src/npcrumor.mjs';

function fixture(seed = 17) {
  const state = createLivingWorldState({ worldSeed: seed });
  for (const [id, name] of [['npc:a', 'Ada'], ['npc:b', 'Bram'], ['npc:c', 'Cora']]) {
    registerLivingWorldEntity(state, { id, kind: 'npc', name });
  }
  rememberSocialMemory(state, 'npc:a', {
    id: 'memory:npc:a:delivery', ownerId: 'npc:a',
    subject: { kind: 'commitment', id: 'commitment:delivery' },
    predicate: 'commitment.outcome', object: { status: 'delivered' },
    summary: 'Bram received the blue letter.',
    source: { kind: 'world-event', id: 'event:delivery' },
    sourceChain: [{ kind: 'world-event', id: 'event:delivery' }],
    provenance: 'observed', originEventId: 'event:delivery',
    lineageId: 'claim:event:delivery', confidence: 1, salience: 1,
    privacy: 'public', hopCount: 0, createdAtHour: 2,
  }, { nowHour: 2 });
  return state;
}

test('conversation IDs are stable, pair ordered, and monotonic', () => {
  const state = fixture();
  const one = beginNpcConversation(state, ['npc:b', 'npc:a'], { nowHour: 3 });
  const two = beginNpcConversation(state, ['npc:a', 'npc:b'], { nowHour: 4 });
  assert.equal(one.id, 'conversation:npc:a|npc:b:1');
  assert.equal(two.id, 'conversation:npc:a|npc:b:2');
  assert.deepEqual(one.participantIds, ['npc:a', 'npc:b']);
});

test('one conversation transfers each lineage at most once and replay is harmless', () => {
  const state = fixture();
  const conversation = beginNpcConversation(state, ['npc:a', 'npc:b'], { nowHour: 3 });
  const first = exchangeRumors(state, conversation, { nowHour: 3 });
  const replay = exchangeRumors(state, conversation, { nowHour: 3 });
  assert.equal(first.transfers.length, 1);
  assert.equal(replay.duplicate, true);
  assert.equal(state.memories['npc:b'].filter((entry) => entry.lineageId === 'claim:event:delivery').length, 1);
  assert.equal(state.metrics.rumorExchanges, 1);
});

test('private, over-hop, and negative claims never transfer', () => {
  const state = fixture();
  state.memories['npc:a'][0].privacy = 'private';
  const privateResult = exchangeRumors(state,
    beginNpcConversation(state, ['npc:a', 'npc:b']), { nowHour: 3 });
  assert.equal(privateResult.transfers.length, 0);
  assert.ok(privateResult.rejections.some((entry) => entry.reason === 'private'));

  state.memories['npc:a'][0].privacy = 'public';
  state.memories['npc:a'][0].hopCount = RUMOR_MAX_HOPS;
  const hopResult = exchangeRumors(state,
    beginNpcConversation(state, ['npc:a', 'npc:c']), { nowHour: 4 });
  assert.equal(hopResult.transfers.length, 0);
  assert.ok(hopResult.rejections.some((entry) => entry.reason === 'hop-limit'));

  state.memories['npc:a'][0].hopCount = 0;
  state.memories['npc:a'][0].object.sentiment = 'negative';
  const toneResult = exchangeRumors(state,
    beginNpcConversation(state, ['npc:a', 'npc:b']), { nowHour: 20 });
  assert.equal(toneResult.transfers.length, 0);
  assert.ok(toneResult.rejections.some((entry) => entry.reason === 'tone-policy'));
});

test('personal claims require trust and cooldown survives memory eviction', () => {
  const state = fixture();
  state.memories['npc:a'][0].privacy = 'personal';
  const untrusted = exchangeRumors(state,
    beginNpcConversation(state, ['npc:a', 'npc:b']), { nowHour: 3 });
  assert.equal(untrusted.transfers.length, 0);
  assert.ok(untrusted.rejections.some((entry) => entry.reason === 'insufficient-trust'));

  state.relationships['npc:b|npc:a'] = {
    ownerId: 'npc:b', subjectId: 'npc:a', familiarity: 0.5, trust: 0.7,
    affinity: 0, obligation: 0, tags: [], lastInteractionHour: 3,
  };
  const trusted = exchangeRumors(state,
    beginNpcConversation(state, ['npc:a', 'npc:b']), { nowHour: 4 });
  assert.equal(trusted.transfers.length, 1);
  state.memories['npc:b'] = [];
  const coolingDown = exchangeRumors(state,
    beginNpcConversation(state, ['npc:a', 'npc:b']), { nowHour: 5 });
  assert.equal(coolingDown.transfers.length, 0);
  assert.ok(coolingDown.rejections.some((entry) => entry.reason === 'cooldown'));
});

test('a delivery fact travels through two NPCs with origin and source chain intact', () => {
  const state = fixture();
  exchangeRumors(state, beginNpcConversation(state, ['npc:a', 'npc:b']), { nowHour: 3 });
  const second = exchangeRumors(state,
    beginNpcConversation(state, ['npc:b', 'npc:c']), { nowHour: 4 });
  assert.equal(second.transfers.length, 1);
  const memory = state.memories['npc:c'][0];
  assert.equal(memory.originEventId, 'event:delivery');
  assert.equal(memory.lineageId, 'claim:event:delivery');
  assert.equal(memory.hopCount, 2);
  assert.deepEqual(memory.sourceChain.map((entry) => entry.id), ['event:delivery', 'npc:a', 'npc:b']);
  assert.match(sourcedRumorPhrase(memory, state.entities), /^Bram told me/);
});

test('selection and rumor inspection are deterministic for the same seed and state', () => {
  const run = () => {
    const state = fixture(91);
    for (let i = 0; i < 4; i++) {
      rememberSocialMemory(state, 'npc:a', {
        id: `memory:npc:a:${i}`, ownerId: 'npc:a',
        subject: { kind: 'npc', id: `npc:${i}` }, predicate: 'npc.seen',
        object: { i }, summary: `Ada saw visitor ${i}.`,
        source: { kind: 'world-event', id: `event:${i}` }, provenance: 'observed',
        originEventId: `event:${i}`, lineageId: `claim:${i}`,
        confidence: 0.8, salience: 0.5 + i * 0.05, privacy: 'public',
        hopCount: 0, createdAtHour: 1,
      }, { nowHour: 1 });
    }
    const result = exchangeRumors(state,
      beginNpcConversation(state, ['npc:a', 'npc:b']), { nowHour: 5 });
    return { transfers: result.transfers, inspector: rumorInspector(state) };
  };
  assert.deepEqual(run(), run());
  assert.equal(run().transfers.filter((entry) => entry.speakerId === 'npc:a').length, 2);
});

test('bounded cycles never exceed the memory cap or hop cap', () => {
  const state = fixture();
  const ids = ['npc:a', 'npc:b', 'npc:c'];
  for (let hour = 3; hour < 100; hour += 13) {
    const left = ids[hour % ids.length];
    const right = ids[(hour + 1) % ids.length];
    exchangeRumors(state, beginNpcConversation(state, [left, right]), { nowHour: hour });
  }
  for (const list of Object.values(state.memories)) {
    assert.ok(list.length <= 32);
    assert.ok(list.every((memory) => memory.hopCount <= RUMOR_MAX_HOPS));
    assert.equal(new Set(list.map((memory) => memory.lineageId)).size, list.length);
  }
});
