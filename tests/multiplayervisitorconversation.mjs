import assert from 'node:assert/strict';
import test from 'node:test';
import { createLivingWorldState } from '../src/livingworldstate.mjs';
import { NpcMemoryStore } from '../src/npcmemory.mjs';
import { HostVisitorConversationService } from '../src/multiplayervisitorconversation.mjs';

function storageAdapter() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

test('visitor synthesis is committed only to the host graph and the matching player memory branch', () => {
  const storage = storageAdapter();
  const state = createLivingWorldState({ worldSeed: 17, playerId: 'player:host', playerName: 'Host' });
  state.features.npcNarrativeFactPropagationEnabled = false;
  const memoryStore = new NpcMemoryStore({ storage, worldSeed: 17, playerId: 'player:host' });
  const actor = {
    identity: { id: 'npc:mara', name: 'Mara', role: 'miller' },
    avatar: { root: { position: { x: 4, y: 0, z: 3 } } },
  };
  const population = {
    worldState: state,
    features: state.features,
    memoryStore,
    livingWorldStore: { save() {} },
    actorById: (id) => id === actor.identity.id ? actor : null,
    contextForActor: (_actor, { playerId, homeOrigin, encounterCount }) => ({
      npc: actor.identity,
      player: { id: playerId, originLabel: `traveller from ${homeOrigin.stationName}` },
      memory: memoryStore.load(actor.identity.id, playerId),
      social: { relationshipToPlayer: 'stranger', memories: [] },
      playerHistory: encounterCount ? 'You have met before.' : 'This is your first meeting.',
    }),
  };
  const authority = { visitors: new Map([['player:guest', {
    playerId: 'player:guest', pose: { x: 3, y: 0, z: 3 },
    homeOrigin: { regionId: 'region:guest', stationId: 'station:0', stationName: 'Rivermore' },
  }]]) };
  const service = new HostVisitorConversationService({ population, authority });
  const opened = service.open('player:guest', { npcId: 'npc:mara' });
  assert.equal(opened.context.player.id, 'player:guest');
  assert.equal(opened.context.player.originLabel, 'traveller from Rivermore');
  assert.equal(opened.context.player.displayName, undefined, 'the UI name must not be disclosed to the NPC');

  const transcript = [
    { role: 'assistant', content: 'Good evening, traveller.', speakerId: 'npc:mara', source: 'edge' },
    { role: 'user', content: 'My name is Ada.', speakerId: 'player:guest' },
    { role: 'assistant', content: 'Welcome, Ada.', speakerId: 'npc:mara', source: 'edge' },
  ];
  service.checkpoint('player:guest', { conversationId: opened.conversationId, transcript });
  const committed = service.commit('player:guest', {
    conversationId: opened.conversationId,
    transcript,
    synthesis: {
      npcId: 'npc:mara', meetingCount: 1,
      playerFacts: ["The traveller's name is Ada."],
      lastConversationSummary: 'Ada introduced herself to Mara.',
    },
  });
  assert.equal(committed.rememberedName, 'Ada');
  assert.equal(memoryStore.load('npc:mara', 'player:guest').playerFacts[0], "The traveller's name is Ada.");
  assert.equal(memoryStore.load('npc:mara', 'player:host').meetingCount, 0, 'the host player has a separate memory branch');
  assert.equal(state.relationships['npc:mara|player:guest'].familiarity > 0, true);
  assert.equal(state.memories['npc:mara'][0].subject.id, 'player:guest');
  assert.match(state.memories['npc:mara'][0].summary, /Ada.*Rivermore/);
});

test('the host rejects a forged transcript identity and a distant NPC interaction', () => {
  const state = createLivingWorldState({ worldSeed: 3 });
  const actor = { identity: { id: 'npc:one', name: 'One' }, avatar: { root: { position: { x: 50, z: 0 } } } };
  const population = { worldState: state, actorById: () => actor, memoryStore: new NpcMemoryStore({ storage: storageAdapter(), worldSeed: 3 }), contextForActor() { return {}; } };
  const authority = { visitors: new Map([['player:guest', { pose: { x: 0, z: 0 } }]]) };
  const service = new HostVisitorConversationService({ population, authority });
  assert.throws(() => service.open('player:guest', { npcId: 'npc:one' }), /closer/);
});

test('Live visitor close preserves recall, releases movement before refinement, and expires abandoned holds only', () => {
  const state = createLivingWorldState({ worldSeed: 19 });
  state.features.npcNarrativeFactPropagationEnabled = false;
  const memoryStore = new NpcMemoryStore({ storage: storageAdapter(), worldSeed: 19, playerId: 'player:host' });
  const held = new Map();
  const actors = ['npc:live', 'npc:text'].map(id => ({ identity: { id, name: id, role: 'keeper' }, avatar: { root: { position: { x: 1, y: 0, z: 0 } } } }));
  const population = { worldState: state, features: state.features, memoryStore, livingWorldStore: { save() {} },
    actorById: id => actors.find(actor => actor.identity.id === id), isTalkingTo: id => held.has(id),
    reserveRemoteDialogue: (id, key) => { held.set(id, key); return true; },
    releaseRemoteDialogue: (id, key) => { if (held.get(id) === key) held.delete(id); },
    contextForActor: (actor, { playerId }) => ({ npc: actor.identity, player: { id: playerId }, memory: memoryStore.load(actor.identity.id, playerId) }),
  };
  const authority = { visitors: new Map([['player:guest', { pose: { x: 0, y: 0, z: 0 } }]]) };
  const service = new HostVisitorConversationService({ population, authority });
  const opened = service.open('player:guest', { npcId: 'npc:live', live: true });
  const transcript = [{ role: 'user', content: 'My name is Ewan. I came from Scotland.', speakerId: 'player:guest' }];
  const packet = service.lookup('player:guest', { conversationId: opened.conversationId, query: 'work' });
  assert.equal(packet.speakerId, 'npc:live'); assert.equal(packet.limits.maxFacts, 8);
  assert.throws(() => service.lookup('player:other', { conversationId: opened.conversationId }), /no longer active/);
  service.close('player:guest', { conversationId: opened.conversationId, transcript });
  service.close('player:guest', { conversationId: opened.conversationId, transcript });
  assert.equal(held.has('npc:live'), false);
  assert.equal(memoryStore.load('npc:live', 'player:guest').meetingCount, 1);
  assert.match(JSON.stringify(memoryStore.load('npc:live', 'player:guest')), /Ewan/);
  service.commit('player:guest', { conversationId: opened.conversationId, transcript });
  assert.equal(memoryStore.load('npc:live', 'player:guest').meetingCount, 1, 'refinement completes the same encounter');
  assert.equal(memoryStore.load('npc:live', 'player:host').meetingCount, 0);
  const returning = service.open('player:guest', { npcId: 'npc:live', live: true });
  assert.match(JSON.stringify(returning.context.memory), /Ewan/);
  service.open('player:guest', { npcId: 'npc:text' });
  const lastActivity = service.sessions.get(returning.conversationId).lastActivityAt;
  service.expireIdle(lastActivity + 45000); assert.equal(held.has('npc:live'), true);
  service.expireIdle(lastActivity + 45001); assert.equal(held.has('npc:live'), false);
  assert.equal(held.has('npc:text'), true, 'normal typed conversations keep their own lifetime');
  service.closePlayer('player:guest'); assert.equal(held.size, 0);
  for (let i = 0; i < 65; i++) {
    actors.push({ identity: { id: `npc:capacity:${i}`, name: 'Resident', role: 'keeper' }, avatar: { root: { position: { x: 1, y: 0, z: 0 } } } });
    service.open('player:guest', { npcId: `npc:capacity:${i}`, live: true });
  }
  assert.equal(service.sessions.size, 64);
  assert.equal(held.size, 64, 'evicted sessions release their NPC rather than stranding its movement');
  assert.equal(held.has('npc:capacity:0'), false);
  service.closePlayer('player:guest'); assert.equal(held.size, 0);
});

console.log('multiplayervisitorconversation PASS · host-owned memory · stable visitor branch · origin identity · proximity validation');
