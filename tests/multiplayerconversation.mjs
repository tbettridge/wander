import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnvelope, decodeEnvelope, encodeEnvelope } from '../src/multiplayerprotocol.mjs';
import {
  ConversationRoomService,
  MAX_CONVERSATION_HUMANS,
} from '../src/multiplayerconversation.mjs';
import { MultiplayerConversationClient } from '../src/multiplayerconversationui.mjs';
import { commitGroupConversationMemory } from '../src/multiplayerconversationmemory.mjs';
import { createLivingWorldState } from '../src/livingworldstate.mjs';
import { emptyNpcMemory } from '../src/npcmemory.mjs';
import { MultiplayerSession } from '../src/multiplayer.mjs';

function fixture({ hostInRoom = true, generateNpcReply = null } = {}) {
  const profiles = new Map([
    ['player:host', { displayName: 'Host' }],
    ['player:a', { displayName: 'Ada' }],
    ['player:b', { displayName: 'Bex' }],
    ['player:c', { displayName: 'Cy' }],
    ['player:d', { displayName: 'Dee' }],
  ]);
  const positions = new Map([...profiles.keys()].map((id, index) => [id, { x: index, y: 0, z: 0 }]));
  const events = [];
  const state = {};
  const service = new ConversationRoomService({
    hostPlayerId: 'player:host', worldId: 'region:test', sessionEpoch: 'epoch:test', state,
    getPlayerPosition: (id) => positions.get(id),
    getPlayerProfile: (id) => profiles.get(id),
    getNpcContext: () => ({ npc: { id: 'npc:mara', name: 'Mara', role: 'keeper' }, memory: { meetingCount: 0 } }),
    generateNpcReply, save: () => true, onEvent: (event) => events.push(event),
  });
  let room = null;
  if (hostInRoom) room = service.openNpc('player:host', { npcId: 'npc:mara', anchor: { x: 0, z: 0 } });
  return { service, profiles, positions, events, state, room };
}

test('conversation message types survive the real envelope boundary', () => {
  for (const type of [
    'profile-update', 'conversation-request', 'conversation-response',
    'conversation-command', 'conversation-event', 'conversation-snapshot',
    'conversation-invite', 'conversation-generation', 'conversation-error',
    'conversation-capabilities',
  ]) {
    const envelope = createEnvelope(type, { roomId: 'room:test', content: 'hello' });
    assert.deepEqual(decodeEnvelope(encodeEnvelope(envelope)), envelope);
  }
});

test('rooms order attributed human messages, deduplicate retries, and filter late history', () => {
  const { service, room } = fixture();
  const guestSnapshot = service.openNpc('player:a', { npcId: 'npc:mara', anchor: { x: 0, z: 0 } });
  const old = service.say('player:host', { roomId: room.roomId, content: 'before B arrives', commandId: 'm1' });
  const duplicate = service.say('player:host', { roomId: room.roomId, content: 'before B arrives', commandId: 'm1' });
  assert.equal(duplicate.event.eventId, old.event.eventId);
  assert.equal(duplicate.event.content, 'before B arrives');
  const late = service.openNpc('player:b', { npcId: 'npc:mara', anchor: { x: 0, z: 0 } });
  assert.ok(late.events.every((event) => event.content !== 'before B arrives'));
  const current = service.say('player:a', { roomId: room.roomId, content: 'I am Ada', commandId: 'm2' });
  assert.equal(current.event.speakerId, 'player:a');
  assert.equal(current.event.speakerKind, 'human');
  assert.equal(service.rooms.get(room.roomId).members.size, 3);
  assert.equal(guestSnapshot.roomId, room.roomId);
});

test('NPC generation is single-assignment and persists accepted evidence', async () => {
  let generated = 0;
  const { service, room, state } = fixture({ generateNpcReply: async ({ messages }) => {
    generated += 1;
    return { text: `Heard ${messages.length} traveller message.` };
  } });
  service.openNpc('player:a', { npcId: 'npc:mara', anchor: { x: 0, z: 0 } });
  service.say('player:a', { roomId: room.roomId, content: 'Please remember this.', commandId: 'm3' });
  await new Promise((resolve) => setTimeout(resolve, 900));
  const events = service.rooms.get(room.roomId).events;
  assert.equal(generated, 1);
  assert.equal(events.filter((event) => event.speakerKind === 'npc').length, 1);
  assert.ok(state.conversationJournal[room.roomId].events.some((event) => event.speakerId === 'player:a'));
  assert.ok(Object.values(state.conversationReceipts).some((receipt) => receipt.eventId));
  assert.throws(() => service.submitNpcReply('player:b', {
    roomId: room.roomId, generationId: 'forged', content: 'I am Mara',
  }), /no longer assigned/);
});

test('human invitations join an existing room and enforce capacity and distance', () => {
  const { service, positions } = fixture({ hostInRoom: false });
  const invite = service.invite('player:host', 'player:a', { anchor: { x: 0, z: 0 } });
  assert.equal(invite.target, 'player:a');
  const roomId = invite.roomId;
  assert.equal(service.acceptInvite('player:a', invite.inviteId).roomId, roomId);
  // A player outside the room chooses Join when they press T on a member.
  assert.equal(service.invite('player:b', 'player:a', { anchor: { x: 0, z: 0 } }).roomId, roomId);
  positions.set('player:c', { x: 100, z: 100 });
  assert.throws(() => service.invite('player:c', 'player:a', { anchor: { x: 0, z: 0 } }), /closer/);
  positions.set('player:c', { x: 0, z: 0 });
  service.invite('player:c', 'player:a', { anchor: { x: 0, z: 0 } });
  positions.set('player:d', { x: 0, z: 0 });
  assert.throws(() => service.invite('player:d', 'player:a', { anchor: { x: 0, z: 0 } }), /full/);
  assert.equal(service.rooms.get(roomId).members.size, MAX_CONVERSATION_HUMANS);
});

test('membership checks use the host position rather than a forged client anchor', () => {
  const { service, positions } = fixture({ hostInRoom: false });
  const invite = service.invite('player:host', 'player:a', { anchor: { x: 0, z: 0 } });
  positions.set('player:b', { x: 100, z: 100 });
  assert.throws(() => service.invite('player:b', 'player:a', {
    // A guest cannot move the room anchor by claiming that this is their own
    // position in a command payload.
    anchor: { x: 100, z: 100 },
  }), /closer/);
  assert.equal(service.rooms.get(invite.roomId).members.size, 1);
});

test('a failed host save rejects the event and leaves its sequence retryable', () => {
  const { service, room, state } = fixture({ hostInRoom: true });
  service.save = () => false;
  assert.throws(() => service.say('player:host', {
    roomId: room.roomId, content: 'This must not be broadcast.', commandId: 'save-failure',
  }), /could not be saved/);
  const live = service.rooms.get(room.roomId);
  assert.equal(live.seq, 0);
  assert.equal(live.events.length, 0);
  assert.equal(state.conversationJournal[room.roomId], undefined);
});

test('command retries are idempotent but cannot change accepted text', () => {
  const { service, room } = fixture({ hostInRoom: true });
  const first = service.say('player:host', {
    roomId: room.roomId, content: 'Keep this exact line.', commandId: 'same-command',
  });
  const retry = service.say('player:host', {
    roomId: room.roomId, content: 'Keep this exact line.', commandId: 'same-command',
  });
  assert.equal(retry.event.eventId, first.event.eventId);
  assert.throws(() => service.say('player:host', {
    roomId: room.roomId, content: 'Changed on retry.', commandId: 'same-command',
  }), /different text/);
});

test('profile updates change room labels while stable IDs and transcript speakers remain intact', () => {
  const { service, room, events } = fixture();
  service.openNpc('player:a', { npcId: 'npc:mara', anchor: { x: 0, z: 0 } });
  const before = service.snapshotFor('player:a', { roomId: room.roomId });
  assert.equal(service.updateProfile('player:a', { displayName: 'Rowan', homeOrigin: { stationName: 'Rivermore' } }), 1);
  const after = service.snapshotFor('player:a', { roomId: room.roomId });
  assert.equal(after.members.find((member) => member.playerId === 'player:a').displayName, 'Rowan');
  assert.equal(after.members.find((member) => member.playerId === 'player:a').playerId, 'player:a');
  assert.ok(events.some((event) => event.kind === 'profile-updated'));
  assert.equal(before.roomId, after.roomId);
});

test('the browser adapter keeps human invitations pending and owns KeyT while open', async () => {
  const snapshot = {
    version: 1, roomId: 'room:host:human', npc: null, members: [], events: [],
  };
  const commands = [];
  const client = new MultiplayerConversationClient({
    session: {
      role: 'host',
      executeConversationCommand: async (_playerId, command) => {
        commands.push(command);
        return { ...command, room: snapshot, roomId: snapshot.roomId, inviteId: 'invite:test', expiresAt: Date.now() + 15_000 };
      },
    },
    identity: { playerId: 'player:host', displayName: 'Host' },
    getPlayerPosition: () => ({ x: 0, y: 0, z: 0 }),
  });
  await client.openTarget({ kind: 'human', playerId: 'player:guest', distance: 2 });
  assert.equal(client.active, false);
  assert.equal(client.pendingRooms.has(snapshot.roomId), true);
  assert.equal(commands[0].op, 'invite');

  client.openSnapshot({ ...snapshot, members: [{ playerId: 'player:host', displayName: 'Host' }] });
  let prevented = false;
  let stopped = false;
  assert.equal(client.interceptKey({
    code: 'KeyT', repeat: false,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  }), true);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test('group memory keeps each traveller branch attributed and commits once', () => {
  const state = createLivingWorldState({ worldSeed: 42, playerId: 'player:host' });
  const memories = new Map();
  const memoryStore = {
    load: (npcId, playerId) => memories.get(`${npcId}:${playerId}`) || emptyNpcMemory(npcId),
    save: (npcId, memory, playerId) => {
      memories.set(`${npcId}:${playerId}`, memory);
      return memory;
    },
  };
  const room = {
    events: [
      { kind: 'message', speakerKind: 'human', speakerId: 'player:a', content: 'My name is Rowan.' },
      { kind: 'message', speakerKind: 'human', speakerId: 'player:b', content: 'I promised to bring bread.' },
      { kind: 'message', speakerKind: 'npc', speakerId: 'npc:mara', content: 'I will remember what you told me.' },
    ],
    members: [
      { playerId: 'player:a', joinedSeq: 1, homeOrigin: { stationName: 'Rivermore' } },
      { playerId: 'player:b', joinedSeq: 1, homeOrigin: { stationName: 'Hillcross' } },
    ],
  };
  const context = { npc: { id: 'npc:mara', name: 'Mara' }, player: { originLabel: 'traveller from Rivermore' } };
  assert.ok(commitGroupConversationMemory({
    state, memoryStore, roomId: 'room:memory', npcId: 'npc:mara', playerId: 'player:a', room, context,
  }));
  assert.ok(commitGroupConversationMemory({
    state, memoryStore, roomId: 'room:memory', npcId: 'npc:mara', playerId: 'player:b', room,
    context: { ...context, player: { originLabel: 'traveller from Hillcross' } },
  }));
  const a = state.conversationMemories[JSON.stringify(['npc:mara', 'player:a'])];
  const b = state.conversationMemories[JSON.stringify(['npc:mara', 'player:b'])];
  assert.ok(a.playerFacts.some((fact) => /Rowan/.test(fact)));
  assert.ok(!a.playerFacts.some((fact) => /bread/.test(fact)));
  assert.ok(b.quests.some((fact) => /bread/.test(fact)));
  assert.ok(!b.playerFacts.some((fact) => /Rowan/.test(fact)));
  const before = a.meetingCount;
  const duplicate = commitGroupConversationMemory({
    state, memoryStore, roomId: 'room:memory', npcId: 'npc:mara', playerId: 'player:a', room, context,
  });
  assert.equal(duplicate.meetingCount, before);
  assert.ok(state.conversationReceipts['conversation-participant:room:memory:player:a:1']);
});

test('a reloaded service replays accepted journal evidence without reopening the room', async () => {
  const first = fixture({ hostInRoom: true });
  const room = first.room;
  first.service.say('player:host', { roomId: room.roomId, content: 'My name is Rowan.' });
  first.service.leave('player:host', { roomId: room.roomId });
  const committed = [];
  const second = new ConversationRoomService({
    hostPlayerId: 'player:host', state: first.state,
    getPlayerProfile: (id) => first.profiles.get(id),
    getNpcContext: () => ({ npc: { id: 'npc:mara', name: 'Mara', role: 'keeper' } }),
    onMemoryCommit: (details) => { committed.push(details); return true; },
  });
  const result = await second.recover();
  assert.deepEqual(result, { attempted: 1, committed: 1 });
  assert.equal(committed[0].playerId, 'player:host');
  assert.equal(second.diagnostics.rooms.length, 0);
  assert.ok(first.state.conversationReceipts[`conversation-participant:${room.roomId}:player:host:1`]);
});

test('session relays group commands through encoded reliable conversation messages', async () => {
  const { service, room } = fixture({ hostInRoom: true });
  const sent = [];
  const session = new MultiplayerSession({
    identity: { playerId: 'player:host', displayName: 'Host', profileRevision: 0 },
    directory: { onRegistered: null }, logger: { warn() {} },
    onConversationEvent: (event) => sent.push({ local: true, event }),
  });
  session.role = 'host';
  session.approvedVisitors.add('player:a');
  session.setConversationService(service);
  session.peers.set('player:a', {
    state: 'connected',
    sendControl: (type, payload) => {
      const envelope = createEnvelope(type, payload, { from: 'player:host' });
      sent.push(decodeEnvelope(encodeEnvelope(envelope)));
      return true;
    },
  });
  session._handlePeerMessage('player:a', 'control', {
    protocolVersion: 1,
    type: 'conversation-command',
    payload: {
      commandId: 'wire-command', op: 'open-npc', npcId: 'npc:mara', anchor: { x: 1, z: 0 },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const wireTypes = sent.filter((entry) => entry.type).map((entry) => entry.type);
  assert.ok(wireTypes.includes('conversation-event'));
  assert.ok(wireTypes.includes('conversation-snapshot'));
  const response = sent.find((entry) => entry.type === 'conversation-response');
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.result.roomId, room.roomId);
  assert.ok(service.rooms.get(room.roomId).members.has('player:a'));
});

test('participant commits are attributed once and rooms release members after the grace period', () => {
  const commits = [];
  let now = 0;
  const { profiles, positions, state } = fixture({ hostInRoom: false });
  const service = new ConversationRoomService({
    hostPlayerId: 'player:host', worldId: 'region:test', state,
    getPlayerPosition: (id) => positions.get(id),
    getPlayerProfile: (id) => profiles.get(id),
    getNpcContext: () => ({ npc: { id: 'npc:mara', name: 'Mara', role: 'keeper' } }),
    onMemoryCommit: (details) => { commits.push(details); return true; },
    now: () => now,
    save: () => true,
  });
  const room = service.openNpc('player:host', { npcId: 'npc:mara', anchor: { x: 0, z: 0 } });
  service.openNpc('player:a', { npcId: 'npc:mara', anchor: { x: 0, z: 0 } });
  service.say('player:a', { roomId: room.roomId, content: 'My name is Ada.' });
  service.leave('player:a', { roomId: room.roomId, synthesis: { narrativeClaims: { thirdPartyClaims: [] } } });
  service.leave('player:a', { roomId: room.roomId });
  assert.equal(commits.length, 1);
  assert.equal(commits[0].playerId, 'player:a');
  assert.ok(commits[0].room.events.some((event) => event.speakerId === 'player:a'));
  assert.ok(state.conversationJournal[room.roomId]);

  positions.set('player:host', { x: 30, z: 0 });
  now = 0;
  service.tick(now);
  assert.equal(service.roomForPlayer('player:host')?.id, room.roomId);
  now = 5_000;
  service.tick(now);
  assert.equal(service.roomForPlayer('player:host'), null);
  assert.equal(service.rooms.get(room.roomId).members.get('player:host').active, false);
});

test('failed memory projection rolls back all canonical effects and retries once', () => {
  const state = createLivingWorldState({ worldSeed: 42, playerId: 'player:host' });
  const before = structuredClone(state);
  const memoryStore = { load: () => emptyNpcMemory('npc:mara'), save: () => { throw new Error('separate writes are forbidden'); } };
  const details = { state, memoryStore, roomId: 'room:atomic', npcId: 'npc:mara', playerId: 'player:a',
    joinedSeq: 1, events: [{ kind: 'message', speakerKind: 'human', speakerId: 'player:a', content: 'My name is Rowan.' }] };
  assert.equal(commitGroupConversationMemory({ ...details, save: () => false }), false);
  assert.deepEqual(state, before);
  const saved = commitGroupConversationMemory({ ...details, save: () => true });
  assert.equal(saved.meetingCount, 1);
  assert.equal(commitGroupConversationMemory(details).meetingCount, 1);
});

test('expired and declined invitations release the inviter for another conversation', () => {
  const { service } = fixture({ hostInRoom: false });
  const first = service.invite('player:host', 'player:a');
  service.declineInvite('player:a', first.inviteId);
  assert.equal(service.roomForPlayer('player:host'), null);
  const second = service.invite('player:host', 'player:a');
  service.tick(second.expiresAt);
  assert.equal(service.roomForPlayer('player:host'), null);
  assert.equal(service.invites.size, 0);
});

test('reported promises retain their source and witnesses without giving the reporter a quest', () => {
  const state = createLivingWorldState({ worldSeed: 42, playerId: 'player:host' });
  const memoryStore = { load: () => emptyNpcMemory('npc:mara') };
  const room = { members: [{ playerId: 'player:a' }, { playerId: 'player:b' }], events: [
    { eventId: 'e1', kind: 'message', speakerId: 'player:a', speakerKind: 'human', content: 'My name is Rowan.', audience: ['player:a', 'player:b'] },
    { eventId: 'e2', kind: 'message', speakerId: 'player:b', speakerKind: 'human', content: 'Rowan promised to bring bread.', audience: ['player:a', 'player:b'] },
  ] };
  const result = commitGroupConversationMemory({ state, memoryStore, room, roomId: 'group:reports', npcId: 'npc:mara', playerId: 'player:b' });
  assert.equal(result.quests.length, 0);
  assert.equal(state.conversationEvidence.e2.subjectId, 'player:a');
  assert.equal(state.conversationEvidence.e2.speakerId, 'player:b');
  assert.deepEqual(state.conversationEvidence.e2.witnessIds, ['player:a', 'player:b']);
  const report = state.memories['npc:mara'].find((memory) => memory.predicate === 'visitor.reported');
  assert.equal(report.source.id, 'player:b');
  assert.equal(report.provenance, 'player-claim');
});

test('out-of-range removal notifies the departing client as well as remaining members', () => {
  const { service, events, room } = fixture();
  service.openNpc('player:a', { npcId: 'npc:mara' });
  service.leave('player:a', { roomId: room.roomId, reason: 'out-of-range' });
  assert.ok(events.some((message) => message.payload?.event?.kind === 'member-left'
    && message.recipients.includes('player:a')));
});

test('new generation delegates receive no pre-join text or UI profile names', async () => {
  const { service, room, events } = fixture();
  service.say('player:host', { roomId: room.roomId, content: 'earlier secret' });
  service.openNpc('player:a', { npcId: 'npc:mara' });
  service.say('player:a', { roomId: room.roomId, content: 'hello group' });
  service.leave('player:host', { roomId: room.roomId });
  await service._runNpcTurn(service.rooms.get(room.roomId));
  const assignment = events.findLast((event) => event.kind === 'generation');
  assert.equal(assignment.payload.generation.assignedTo, 'player:a');
  assert.ok(!JSON.stringify(assignment.payload).includes('earlier secret'));
  assert.ok(!JSON.stringify(assignment.payload.context).includes('Ada'));
  service.closeAll();
});

console.log('multiplayerconversation PASS · room ordering · late-join filtering · attributed NPC lease · durable evidence');
