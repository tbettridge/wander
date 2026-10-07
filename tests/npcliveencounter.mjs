import test from 'node:test';
import assert from 'node:assert/strict';
import { NpcLiveEncounterBridge } from '../src/npcliveencounter.mjs';
import { createLivingWorldState } from '../src/livingworldstate.mjs';
import { emptyNpcMemory } from '../src/npcmemory.mjs';

test('voice encounters hold one NPC, save immediate recall, and keep Qwen refinement off the movement release', async () => {
  const holds = new Map(), memories = new Map(); let finishSynthesis;
  const npc = { identity: { id: 'npc:maren', name: 'Maren', role: 'keeper' } };
  const store = { load: id => structuredClone(memories.get(id) || emptyNpcMemory(id)), save: (id, memory) => { memories.set(id, structuredClone(memory)); return memory; } };
  const population = { worldState: createLivingWorldState({ worldSeed: 23 }), memoryStore: store, playerId: 'player:one',
    features: { socialMemoryEnabled: false, npcNarrativeFactPropagationEnabled: false },
    isTalkingTo: id => holds.has(id), reserveRemoteDialogue: (id, key) => { holds.set(id, key); return true; },
    releaseRemoteDialogue: id => holds.delete(id), readEncounterCount: () => 0, storageKey: () => 'test',
    contextForActor: actor => ({ npc: actor.identity, station: { name: 'Millbrook' }, player: { id: 'player:one' }, memory: store.load(actor.identity.id) }),
  };
  const bridge = new NpcLiveEncounterBridge(population, { synthesize: () => new Promise(resolve => { finishSynthesis = resolve; }) });
  const reservation = await bridge.open(npc, 'live:one');
  assert.equal(holds.has(npc.identity.id), true); assert.equal(await bridge.open(npc, 'live:two'), null);
  const encounter = { actor: npc, reservation, transcript: [
    { role: 'user', content: 'My name is Ewan. I came from Scotland.' },
    { role: 'assistant', content: 'Pleased to meet you, Ewan.' },
  ] };
  bridge.checkpoint(encounter); bridge.checkpoint(encounter);
  assert.match(JSON.stringify(reservation.context.memory), /Ewan/, 'renewed Live sessions receive the saved recall');
  assert.equal(store.load(npc.identity.id).meetingCount, 0, 'heartbeats and completed turns are part of one meeting');
  const closing = bridge.close(encounter);
  assert.equal(holds.has(npc.identity.id), false, 'the NPC can resume before Qwen finishes');
  assert.match(JSON.stringify(store.load(npc.identity.id).playerFacts), /Ewan/);
  assert.equal(store.load(npc.identity.id).meetingCount, 1);
  finishSynthesis({ ...store.load(npc.identity.id), lastConversationSummary: 'Ewan introduced himself and said he came from Scotland.' });
  await closing;
  const returning = await bridge.open(npc, 'live:return');
  assert.match(JSON.stringify(returning.context.memory), /Ewan/);
  await bridge.close({ actor: npc, reservation: returning, transcript: [] });
});
