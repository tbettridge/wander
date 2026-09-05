import assert from 'node:assert/strict';
import test from 'node:test';
import { WanderPeerConnection } from '../src/multiplayerpeer.mjs';
import { MultiplayerSession } from '../src/multiplayer.mjs';
import { HostWorldAuthority } from '../src/multiplayerauthority.mjs';
import { createLocalIdentity } from '../src/multiplayeridentity.mjs';
import { CHANNELS, byteLength, createStateSnapshot } from '../src/multiplayerprotocol.mjs';
import { DepartureDirectoryClient } from '../src/multiplayerdirectory.mjs';
import { DepartureDirectory } from '../services/departures-worker/src/index.js';

const logger = { warn() {} };

test('disconnect preserves approval, avatar, authority and signaling for recovery', async () => {
  const host = new MultiplayerSession({ seed: 1, identity: createLocalIdentity({ storage: null }), logger });
  host.role = 'host';
  host.authority = new HostWorldAuthority({ regionId: host.region.regionId, worldSeed: 1 });
  const id = 'player:guest';
  const peer = host._ensurePeer(id, 'host');
  host.approvedVisitors.add(id);
  host.approvedVisitorNames.set(id, 'Guest');
  host.connectedPeers.add(id);
  host.authority.admit(id);
  let removed = 0;
  host.avatarManager = { remove() { removed++; } };
  peer.onStateChange({ state: 'disconnected' });
  assert.equal(host.approvedVisitors.has(id), true);
  assert.equal(host.authority.visitors.has(id), true);
  assert.equal(host.connectedPeers.has(id), true);
  assert.equal(removed, 0);
  let answers = 0;
  peer.acceptAnswer = async () => { answers++; };
  host._handleSignal({ kind: 'peer-signal', from: id, signal: { kind: 'answer', description: {} } });
  assert.equal(answers, 1);
  peer.close();
  assert.equal(host.peers.size, 0);
  assert.equal(host.approvedVisitors.has(id), false);
});

test('relay fallback restarts ICE on the same peer and preserves negotiated channels', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = globalThis.WANDER_TURN_SERVERS;
  globalThis.WANDER_TURN_SERVERS = [{ urls: 'turn:example.test', username: 'test', credential: 'test' }];
  t.after(() => { if (previous === undefined) delete globalThis.WANDER_TURN_SERVERS; else globalThis.WANDER_TURN_SERVERS = previous; });
  let closed = 0;
  let restarted = 0;
  const pc = {
    setConfiguration(config) { this.config = config; },
    restartIce() { restarted++; },
    async createOffer(options) { assert.equal(options.iceRestart, true); return { type: 'offer', sdp: 'same-dtls-identity' }; },
    async setLocalDescription(description) { this.localDescription = description; },
    iceGatheringState: 'complete',
    close() { closed++; },
  };
  const signals = [];
  const peer = new WanderPeerConnection({ role: 'host', onSignal: (s) => signals.push(s), logger });
  peer.pc = pc;
  const stateChannel = { close() {} };
  peer.channels.set('state', stateChannel);
  peer.admissionApproved = true;
  peer.attempts = 1;
  peer._recoverFromFailure();
  t.mock.timers.tick(700);
  await new Promise(setImmediate);
  assert.equal(closed, 0);
  assert.equal(peer.pc, pc);
  assert.equal(peer.channels.get('state'), stateChannel);
  assert.equal(pc.config.iceTransportPolicy, 'relay');
  assert.equal(restarted, 1);
  assert.equal(signals[0].iceRestart, true);
  peer.close();
});

test('closing a peer cancels its scheduled recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const peer = new WanderPeerConnection({ role: 'host', logger });
  peer.pc = { close() {} };
  let restarted = 0;
  peer.restartIce = async () => { restarted++; };
  peer._recoverFromFailure();
  peer.close();
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  assert.equal(restarted, 0);
  assert.equal(peer.state, 'closed');
});

test('ICE renegotiation restores usable peer state even when DTLS stays connected', async () => {
  const peer = new WanderPeerConnection({ logger });
  peer.state = 'reconnecting';
  peer.pc = {
    connectionState: 'connected', iceConnectionState: 'completed',
    iceGatheringState: 'complete',
    async setRemoteDescription(description) { this.remoteDescription = description; },
    async createAnswer() { return { type: 'answer', sdp: 'answer' }; },
    async setLocalDescription(description) { this.localDescription = description; },
    close() {},
  };
  await peer.acceptAnswer({ type: 'answer', sdp: 'answer' });
  assert.equal(peer.state, 'connected');
  await peer.acceptOffer({ type: 'offer', sdp: 'restart' }, { admissionApproved: true });
  assert.equal(peer.state, 'connected');
  peer.close();
});

test('a transport send error refuses the update and closes its incomplete stream', () => {
  const peer = new WanderPeerConnection({ logger });
  peer.channels.set('state', { readyState: 'open', bufferedAmount: 0, send() { throw new Error('closed transport'); }, close() {} });
  assert.equal(peer.sendState('state-snapshot', { state: {} }), false);
  assert.equal(peer.state, 'closed');
  assert.equal(peer._sendQueues.size, 0);
});

test('large snapshots resume after backpressure and precede later deltas', () => {
  const received = [];
  const guest = new WanderPeerConnection({ logger, onMessage: (channel, envelope) => received.push(envelope) });
  const incoming = { label: CHANNELS.state };
  guest._bindChannel(incoming);
  const channel = {
    label: CHANNELS.state, readyState: 'open', bufferedAmount: 0,
    send(message) {
      this.bufferedAmount += byteLength(message);
      incoming.onmessage({ data: message });
    },
    close() {},
  };
  const host = new WanderPeerConnection({ role: 'host', logger });
  host._bindChannel(channel);
  const snapshot = createStateSnapshot({ text: 'world '.repeat(70_000) }, { revision: 1 });
  assert.equal(host.sendState('state-snapshot', snapshot), true);
  assert.equal(received.length, 0, 'the browser has only accepted the start of the snapshot');
  assert.equal(host.sendState('state-delta', { revision: 2 }), true);
  for (let i = 0; i < 10 && received.length < 2; i++) {
    channel.bufferedAmount = 0;
    channel.onbufferedamountlow();
  }
  assert.deepEqual(received.map((e) => e.type), ['state-snapshot', 'state-delta']);
  assert.deepEqual(received[0].payload, snapshot);
  assert.equal(guest._chunks.size, 0);
  host.close();
});

test('reliable queue refuses a full transfer without sending its first chunk', () => {
  let sends = 0;
  const peer = new WanderPeerConnection({ logger });
  const channel = { readyState: 'open', bufferedAmount: 300_000, send() { sends++; }, close() {} };
  peer.channels.set('state', channel);
  const payload = { text: 'x'.repeat(450_000) };
  let accepted = 0;
  while (peer.sendState('state-snapshot', payload)) accepted++;
  assert.ok(accepted > 0 && accepted < 6);
  const before = peer._sendQueues.get(channel).messages.length;
  assert.equal(peer.sendState('state-snapshot', payload), false);
  assert.equal(peer._sendQueues.get(channel).messages.length, before);
  assert.equal(sends, 0);
  peer.close();
  assert.equal(peer._sendQueues.size, 0);
});

test('a restored listing renews host signaling with the rotated token', async () => {
  let revision = 0;
  const directory = new DepartureDirectoryClient({ storage: null, logger, fetchImpl: async (url, options) => ({
    ok: true, json: async () => ({ departure: JSON.parse(options.body), hostToken: `token-${++revision}` }),
  }) });
  directory.startHeartbeat = () => {};
  const sockets = [];
  directory.openSignalSocket = (options) => {
    const socket = { options, closed: false, close() { this.closed = true; } };
    sockets.push(socket);
    return socket;
  };
  const host = new MultiplayerSession({ seed: 1, identity: createLocalIdentity({ storage: null }), directory, logger });
  host._startHostBroadcast = () => {};
  await host.openRegion();
  assert.equal(sockets.length, 1);
  await directory.register(host.region);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets[1].options.token, 'token-2');
  assert.equal(host.signalSocket, sockets[1]);
});

test('a signaling event after hibernation waits for stored listings', async () => {
  let restore;
  const messages = [];
  const regionId = 'region:test';
  const sender = { deserializeAttachment: () => ({ regionId, playerId: 'player:guest', isHost: false }) };
  const host = {
    deserializeAttachment: () => ({ regionId, playerId: 'player:host', isHost: true, token: 'host-token' }),
    send: (message) => messages.push(JSON.parse(message)),
  };
  const directory = new DepartureDirectory({
    storage: { get: () => new Promise((resolve) => { restore = resolve; }) },
    getWebSockets: () => [sender, host],
  }, {});
  const pending = directory.webSocketMessage(sender, JSON.stringify({
    protocolVersion: 1, kind: 'admission-request', request: { playerId: 'player:guest' },
  }));
  assert.equal(messages.length, 0);
  restore([{ regionId, _hostToken: 'host-token', _expiresAt: Date.now() + 60_000 }]);
  await pending;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].from, 'player:guest');
});

test('host frame and background broadcasts share a wall-clock interval', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const host = new MultiplayerSession({ seed: 1, identity: createLocalIdentity({ storage: null }), logger });
  host.role = 'host';
  host.authority = {};
  host.lastStateSnapshotAt = Date.now();
  let broadcasts = 0;
  host._broadcastStateSnapshots = () => { broadcasts++; };
  t.mock.timers.tick(5001);
  host.update(5500); // performance.now(), as supplied by main.js
  assert.equal(broadcasts, 1);
  assert.equal(host.lastStateSnapshotAt, Date.now());
});
