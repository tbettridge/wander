import test from 'node:test';
import assert from 'node:assert/strict';
import {
  combineNpcMemory,
  emptyNpcMemory,
  fallbackMemorySynthesis,
  mergeNpcMemory,
  normalizeNpcMemory,
  NpcMemoryStore,
} from '../src/npcmemory.mjs';

const npcId = 'npc:harrow:porter';
const context = {
  npc: { id: npcId, name: 'Maren Bell', role: 'railway porter' },
  station: { id: 'harrow', name: 'Harrow Mill' },
  targets: [
    { id: 'harrow', name: 'Harrow Mill', kind: 'station' },
    { id: 'ring', name: 'the old stone ring', kind: 'ring' },
  ],
};

test('NPC memory normalization is bounded, deduplicated, and versioned', () => {
  const memory = normalizeNpcMemory({
    meetingCount: 2.8,
    playerFacts: [' Rowan is a walker. ', 'rowan is a walker.', '', ...Array(20).fill('extra')],
    lastConversationSummary: '  A short memory.  ',
  }, npcId);
  assert.equal(memory.version, 1);
  assert.equal(memory.npcId, npcId);
  assert.equal(memory.meetingCount, 2);
  assert.equal(memory.playerFacts[0], 'Rowan is a walker.');
  assert.ok(memory.playerFacts.length <= 14);
  assert.equal(memory.lastConversationSummary, 'A short memory.');
});

test('memory synthesis accumulates player, NPC, quest, and landmark facts', () => {
  const previous = {
    ...emptyNpcMemory(npcId),
    meetingCount: 1,
    npcFacts: ['Maren works the dawn platform.'],
  };
  const memory = fallbackMemorySynthesis(previous, context, [
    { role: 'user', content: 'My name is Rowan. I am looking for the old stone ring.' },
    { role: 'assistant', content: 'My grandmother showed me the ring path when I was young.' },
  ]);

  assert.equal(memory.meetingCount, 2);
  assert.ok(memory.playerFacts.some((fact) => /name is Rowan/.test(fact)));
  assert.ok(memory.npcFacts.some((fact) => /dawn platform/.test(fact)));
  assert.ok(memory.npcFacts.some((fact) => /grandmother/.test(fact)));
  assert.ok(memory.quests.some((fact) => /looking for the old stone ring/.test(fact)));
  assert.deepEqual(memory.landmarks, ['the old stone ring']);
  assert.match(memory.lastConversationSummary, /traveller discussed/i);
  assert.match(memory.lastConversationSummary, /Maren Bell responded/i);
});

test('refined model memory combines with the provisional memory without another meeting', () => {
  const provisional = mergeNpcMemory(emptyNpcMemory(npcId), {
    playerFacts: ["The traveller's name is Rowan."],
    lastConversationSummary: 'A provisional summary.',
  }, npcId);
  const refined = combineNpcMemory(provisional, {
    meetingCount: 1,
    npcFacts: ['Maren once worked the northern line.'],
    lastConversationSummary: 'Rowan introduced themself. Maren recalled the northern line.',
  }, npcId);
  assert.equal(refined.meetingCount, 1);
  assert.ok(refined.playerFacts.some((fact) => /Rowan/.test(fact)));
  assert.ok(refined.npcFacts.some((fact) => /northern line/.test(fact)));
  assert.match(refined.lastConversationSummary, /northern line/);
});

test('NPC memory store persists each resident independently', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const store = new NpcMemoryStore({ storage });
  store.save(npcId, {
    meetingCount: 3,
    playerFacts: ['Rowan prefers the coast path.'],
    lastConversationSummary: 'They spoke about the coast.',
  });

  assert.equal(store.load(npcId).meetingCount, 3);
  assert.match(store.load(npcId).playerFacts[0], /coast path/);
  assert.equal(store.load('npc:other').meetingCount, 0);
});
