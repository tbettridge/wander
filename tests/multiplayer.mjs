import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  createLocalIdentity,
  migrateLegacyPlayerReferences,
  regionDescriptor,
  regionIdFor,
} from '../src/multiplayeridentity.mjs';
import {
  applyStateDelta,
  createEnvelope,
  createStateDelta,
  createStateSnapshot,
  decodeEnvelope,
  encodeEnvelope,
  quantizePose,
} from '../src/multiplayerprotocol.mjs';
import {
  chooseArrivalStation,
  createTicket,
  transitionTicket,
} from '../src/interregionalticket.mjs';
import { DepartureDirectoryClient, InMemoryDepartureDirectory } from '../src/multiplayerdirectory.mjs';
import { DIRECT_ICE_SERVERS, isDirectIceConfiguration } from '../src/multiplayerpeer.mjs';
import { HostWorldAuthority } from '../src/multiplayerauthority.mjs';
import { MAX_SHARED_MARKERS, placeSharedMarker } from '../src/multiplayermarkers.mjs';
import { MultiplayerSession } from '../src/multiplayer.mjs';

test('identity is stable and region descriptors do not expose a seed on the board', () => {
  const storage = new Map();
  const adapter = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  const first = createLocalIdentity({ storage: adapter, displayName: '  Ada   Lovelace  ' });
  const second = createLocalIdentity({ storage: adapter });
  assert.equal(second.playerId, first.playerId);
  assert.equal(second.displayName, 'Ada Lovelace');
  const descriptor = regionDescriptor({ identity: first, seed: 20260612 });
  assert.equal(descriptor.regionId, regionIdFor({ ownerId: first.playerId, seed: 20260612 }));
  assert.equal(typeof descriptor.regionCode, 'string');
  assert.equal(descriptor.regionName.length > 0, true);
  const publicFields = JSON.stringify({ ...descriptor, seed: undefined });
  assert.equal(publicFields.includes('20260612'), false);
});

test('legacy player references migrate recursively without mutating state', () => {
  const source = { a: 'player:local', nested: [{ owner: 'player:local' }], untouched: 2 };
  const migrated = migrateLegacyPlayerReferences(source, 'player:abc');
  assert.equal(source.a, 'player:local');
  assert.equal(migrated.a, 'player:abc');
  assert.equal(migrated.nested[0].owner, 'player:abc');
  assert.equal(migrated.untouched, 2);
});

test('protocol envelopes, quantized motion, snapshots and deltas round-trip', () => {
  const envelope = createEnvelope('motion', { pose: quantizePose({ x: 1.234, y: 2, z: -3.456, yaw: 0.1234 }) }, { from: 'player:a', sequence: 3 });
  assert.deepEqual(decodeEnvelope(encodeEnvelope(envelope)), envelope);
  const snapshot = createStateSnapshot({ things: { a: 1 } }, { revision: 4, worldSeed: 9 });
  const delta = createStateDelta([{ op: 'set', path: 'things.b', value: 2 }, { op: 'delete', path: 'things.a' }], { baseRevision: snapshot.revision, revision: 5 });
  const applied = applyStateDelta(snapshot.state, delta, { expectedRevision: 4 });
  assert.deepEqual(applied.state, { things: { b: 2 } });
  assert.equal(applied.revision, 5);
});

test('state deltas reject prototype-polluting paths', () => {
  assert.throws(() => createStateDelta([
    { op: 'set', path: '__proto__.polluted', value: true },
  ]), /Invalid state operation path/);
  assert.throws(() => applyStateDelta({}, {
    schemaVersion: 1,
    baseRevision: 0,
    revision: 1,
    operations: [{ op: 'set', path: 'constructor.prototype.polluted', value: true }],
  }, { expectedRevision: 0 }), /Invalid state operation path/);
  assert.equal({}.polluted, undefined);
});

test('ticket phases enforce the station-to-train journey', () => {
  const destination = { regionId: 'region-b', regionCode: 'ABC123', regionName: 'Silver Vale', ownerName: 'Host' };
  let ticket = createTicket({ passengerId: 'player:a', originRegionId: 'region-a', destination });
  for (const phase of ['keeper-confirmed', 'admission-requested', 'host-approved', 'preflight', 'issued', 'summoned', 'boarded', 'departing', 'transition', 'arriving', 'visit-active']) {
    ticket = transitionTicket(ticket, phase);
  }
  assert.equal(ticket.phase, 'visit-active');
  assert.throws(() => transitionTicket(ticket, 'departing'), /Cannot move/);
  const station = chooseArrivalStation([
    { id: 'far', x: 100, z: 100 },
    { id: 'near', x: 2, z: -1 },
  ], { x: 0, z: 0 });
  assert.equal(station.id, 'near');
});

test('in-memory departures expire and direct ICE remains TURN-free', () => {
  let now = 1000;
  const directory = new InMemoryDepartureDirectory({ clock: () => now, ttlMs: 100 });
  directory.register({ protocolVersion: 1, regionId: 'region-a', regionCode: 'AAAAAA', regionName: 'Amber Vale', ownerName: 'Host', population: 1, capacity: 3 });
  assert.equal(directory.list().length, 1);
  now += 101;
  assert.equal(directory.list().length, 0);
  assert.equal(isDirectIceConfiguration({ iceServers: DIRECT_ICE_SERVERS, iceTransportPolicy: 'all' }), true);
  assert.equal(isDirectIceConfiguration({ iceServers: [{ urls: 'turn:paid.example' }], iceTransportPolicy: 'all' }), false);
});

test('admission signaling waits for the WebSocket open event', async () => {
  const sent = [];
  let socket;
  const directory = {
    openSignalSocket(options) {
      socket = {
        readyState: 0,
        send(value) { sent.push(JSON.parse(value)); },
        close() { this.readyState = 3; },
      };
      socket.onopen = options.onOpen;
      return socket;
    },
  };
  const identity = createLocalIdentity({ storage: new Map(), displayName: 'Guest' });
  const session = new MultiplayerSession({
    seed: 12,
    identity,
    directory,
    logger: { warn() {} },
  });
  session.selectDeparture({
    protocolVersion: 1, regionId: 'region-host', regionCode: 'HOST01', regionName: 'Host Vale',
    ownerName: 'Host', population: 1, capacity: 3,
  });
  await session.requestVisit({ message: 'hello' });
  assert.equal(sent.length, 0);
  assert.equal(session.pendingSignals.length, 1);
  socket.readyState = 1;
  socket.onopen();
  assert.equal(sent[0].kind, 'admission-request');
  assert.equal(sent[0].request.playerId, identity.playerId);
});

test('host approval returns a legal ticket with its private seed and arrival region', async () => {
  const hostIdentity = createLocalIdentity({ displayName: 'Host' });
  const host = new MultiplayerSession({
    seed: 0xabcdef,
    identity: hostIdentity,
    logger: { warn() {} },
  });
  host.region = regionDescriptor({ identity: hostIdentity, seed: 0xabcdef });
  host.role = 'host';
  const request = {
    ticketId: 'ticket-approval',
    playerId: 'player:guest-approval',
    playerName: 'Guest',
    regionId: host.region.regionId,
    originRegionId: 'region-home',
  };
  host.hostRequests.set(request.playerId, request);
  let started = false;
  host._ensurePeer = () => ({ startHost: async () => { started = true; } });
  await host.decideAdmission(request, true);
  const response = host.pendingSignals[0];
  assert.equal(response.kind, 'admission-response');
  assert.equal(response.to, request.playerId);
  assert.equal(response.ticket.phase, 'host-approved');
  assert.equal(response.ticket.destination.regionId, host.region.regionId);
  assert.equal(response.ticket.destination.seed, 0xabcdef);
  assert.equal(response.ticket.originRegionId, 'region-home');
  assert.equal(started, true);
});

// With no TURN relay a direct connection failing is an ordinary outcome, not an
// edge case, so a dead peer must not keep the seat it was holding: `peers` is
// what both the visitor cap and the advertised population are counted from.
test('a failed connection releases its seat instead of sealing the region', () => {
  const identity = createLocalIdentity({ displayName: 'Host' });
  const host = new MultiplayerSession({ seed: 0xabcdef, identity, logger: { warn() {} } });
  host.region = regionDescriptor({ identity, seed: 0xabcdef });
  host.role = 'host';

  const askToVisit = (playerId) => {
    host._handleSignal({
      kind: 'admission-request',
      from: playerId,
      request: { ticketId: `t:${playerId}`, playerId, playerName: 'Guest', regionId: host.region.regionId },
    });
    return host.hostRequests.has(playerId);
  };

  // Three travellers are approved and then their connections fail. The peers are
  // built through the session's own _ensurePeer so the real onStateChange
  // wiring is what is under test; startHost is never reached, so no RTC stack
  // is required here.
  for (let i = 0; i < 3; i += 1) {
    const playerId = `player:guest-${i}`;
    assert.equal(askToVisit(playerId), true, `visitor ${i} should reach the host`);
    host.approvedVisitors.add(playerId);
    const peer = host._ensurePeer(playerId, 'host');
    peer.onStateChange({ state: 'failed' });
  }

  assert.equal(host.peers.size, 0, 'failed peers must not be retained');
  assert.equal(host.connectedPeers.size, 0);
  assert.equal(1 + host.peers.size, 1, 'an empty region must not advertise itself as full');

  host.hostRequests.clear();
  assert.equal(askToVisit('player:guest-late'), true,
    'a fourth traveller must still reach a region nobody is connected to');
});

test('a transient disconnect keeps the visit that is about to recover', () => {
  const identity = createLocalIdentity({ displayName: 'Host' });
  const host = new MultiplayerSession({ seed: 0xabcdef, identity, logger: { warn() {} } });
  host.region = regionDescriptor({ identity, seed: 0xabcdef });
  host.role = 'host';
  const peer = host._ensurePeer('player:guest', 'host');
  assert.equal(host.peers.size, 1);
  // 'disconnected' is a transient ICE state that regularly recovers on its own;
  // the browser moves it to 'failed' when it does not.
  peer.onStateChange({ state: 'disconnected' });
  assert.equal(host.peers.size, 1, 'a transient disconnect must not tear the peer down');
  peer.onStateChange({ state: 'closed' });
  assert.equal(host.peers.size, 0, 'a closed peer releases its seat');
});

// createStateSnapshot throws above its 512 KiB budget and this is reached from
// update(), which the render loop calls before it streams terrain or draws
// anything — so an unbounded projection could stop the game, not just sharing.
test('an oversized public projection cannot take the render loop down', () => {
  const identity = createLocalIdentity({ displayName: 'Host' });
  const host = new MultiplayerSession({ seed: 1, identity, logger: { warn() {} } });
  host.role = 'host';
  const statuses = [];
  host.onStatus = (status) => statuses.push(status.state);
  let sent = 0;
  host.peers.set('player:guest', {
    state: 'connected', sendState: () => { sent += 1; }, close() {}, diagnostics: {},
  });
  host.authority = {
    snapshotFor() { throw new Error('State snapshot exceeds the 512 KiB budget'); },
  };

  assert.doesNotThrow(() => host.update(Date.now() + 10_000, null, {}));
  assert.equal(sent, 0, 'nothing is sent when the snapshot is refused');
  assert.ok(statuses.includes('snapshot-too-large'), 'the refusal is surfaced rather than swallowed');
});

// The marker collection is the one thing a visitor can write and nothing else
// expires it, so the ceiling is what keeps a snapshot inside its budget.
test('visitor markers are bounded and evictions are replicated', () => {
  const state = {};
  const seen = [];
  for (let i = 0; i < MAX_SHARED_MARKERS + 50; i += 1) {
    const result = placeSharedMarker(state, { intentId: `i${i}`, kind: 'place-marker', x: i, z: i }, 'player:guest');
    assert.ok(result, 'a well-formed marker intent is applied');
    seen.push(result);
  }
  const changes = state.publicProjections.worldChanges;
  assert.equal(Object.keys(changes).length, MAX_SHARED_MARKERS, 'the collection stays at its ceiling');
  const keyOf = (result) => result.operations.find((op) => op.op === 'set').path.split('.').pop();
  assert.ok(!changes[keyOf(seen[0])], 'the oldest marker is forgotten');
  assert.ok(changes[keyOf(seen[seen.length - 1])], 'the newest marker is kept');

  // A guest that keeps a marker the host has forgotten is a divergent world.
  const evictions = seen.flatMap((r) => r.operations).filter((op) => op.op === 'delete');
  assert.equal(evictions.length, 50, 'every eviction is replicated to guests');

  // Replaying the operation stream onto a guest must land on the same keys.
  let guest = { publicProjections: { worldChanges: {} } };
  for (const [index, result] of seen.entries()) {
    guest = applyStateDelta(guest, {
      schemaVersion: 1, baseRevision: index, revision: index + 1, operations: result.operations,
    }, { expectedRevision: index }).state;
  }
  assert.deepEqual(
    Object.keys(guest.publicProjections.worldChanges).sort(),
    Object.keys(changes).sort(),
    'host and guest agree on which markers exist',
  );
});

test('any intent id a guest supplies still yields one safe path segment', () => {
  const state = {};
  // `.` is the delta path separator and 80 is the per-segment ceiling, so a key
  // built by pasting ids together would either split or be refused outright.
  // What a guest sends must not be able to decide that.
  const hostile = [
    'a.b.c',
    'x'.repeat(200),
    // What sendIntent actually produces: the player id is already inside it.
    'player:9cb8f2d1-6ad1-4c7a-9664-fce4c86b14f7:1786985920374:k3f9a2',
  ];
  for (const intentId of hostile) {
    const result = placeSharedMarker(state, { intentId, kind: 'place-marker', x: 1, z: 2 },
      'player:9cb8f2d1-6ad1-4c7a-9664-fce4c86b14f7');
    assert.ok(result, `a marker must survive intentId ${intentId.slice(0, 24)}`);
    const [operation] = result.operations;
    const parts = operation.path.split('.');
    assert.equal(parts.length, 3, 'the path stays exactly three segments deep');
    for (const part of parts) assert.ok(part.length <= 80, 'every segment fits the protocol ceiling');
  }

  // And the host's own keys must match what the guest is told to write.
  const host = {};
  const guest = { publicProjections: { worldChanges: {} } };
  let revision = 0;
  for (const intentId of hostile) {
    const result = placeSharedMarker(host, { intentId, kind: 'place-marker', x: 1, z: 2 }, 'player:owner');
    const applied = applyStateDelta(guest, {
      schemaVersion: 1, baseRevision: revision, revision: revision + 1, operations: result.operations,
    }, { expectedRevision: revision });
    Object.assign(guest, applied.state);
    revision += 1;
  }
  assert.deepEqual(
    Object.keys(guest.publicProjections.worldChanges).sort(),
    Object.keys(host.publicProjections.worldChanges).sort(),
    'host and guest agree on every key',
  );
});

test('a replayed intent resolves to the same marker rather than a duplicate', () => {
  const state = {};
  const first = placeSharedMarker(state, { intentId: 'abc', kind: 'place-marker', x: 1, z: 2 }, 'player:owner');
  const again = placeSharedMarker(state, { intentId: 'abc', kind: 'place-marker', x: 9, z: 9 }, 'player:owner');
  assert.equal(first.operations[0].path, again.operations[0].path);
  assert.equal(Object.keys(state.publicProjections.worldChanges).length, 1);
});

// A full collection has to leave real headroom under the 512 KiB snapshot cap.
test('a full marker collection still fits inside a state snapshot', () => {
  const authority = new HostWorldAuthority({ regionId: 'r', worldSeed: 1, state: {} });
  authority.admit('player:guest');
  const state = authority.state;
  for (let i = 0; i < MAX_SHARED_MARKERS; i += 1) {
    placeSharedMarker(state, { intentId: `i${i}`, kind: 'place-marker', x: i, z: i }, 'player:guest');
  }
  assert.doesNotThrow(() => authority.snapshotFor('player:guest'));
});

// The ceiling only protects a host if the running reducer is the one that
// applies it, so guard the wiring as well as the behaviour.
test('the host reducer routes visitor intents through the bounded marker path', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ placeSharedMarker \} from '\.\/multiplayermarkers\.mjs'/);
  const reducer = source.slice(source.indexOf('intentReducer:'), source.indexOf('// The station keeper is'));
  assert.match(reducer, /placeSharedMarker\(state, intent, playerId\)/,
    'the intent reducer must delegate to the bounded marker path');
  assert.doesNotMatch(reducer, /worldChanges\[/,
    'the reducer must not write the marker collection directly again');
});

// --- a host reloading must reclaim its own listing ---------------------------
// The region id is derived from the browser's own identity, so a reload asks for
// the same one — but the board holds the listing for a minute after the page is
// gone, and the token that proved ownership went with it.
test('a reloaded host reclaims its listing instead of colliding with its ghost', async () => {
  const storage = new Map();
  const adapter = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  const board = new Map();
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const token = options.headers?.['x-wander-host-token'] ?? null;
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      const existing = board.get(body.regionId);
      seen.push({ regionId: body.regionId, presentedToken: token });
      if (existing && existing._hostToken !== token) {
        return { ok: false, status: 409, json: async () => ({ error: 'departure is already hosted' }) };
      }
      const hostToken = `token-${board.size + 1}`;
      board.set(body.regionId, { ...body, _hostToken: hostToken });
      return { ok: true, status: 200, json: async () => ({ departure: body, hostToken }) };
    }
    return { ok: true, status: 200, json: async () => ({ departures: [] }) };
  };

  const departure = {
    protocolVersion: 1, regionId: 'region-reload', regionCode: 'RLD',
    regionName: 'Reload', ownerName: 'Traveller', population: 1, capacity: 3, status: 'open',
  };

  const first = new DepartureDirectoryClient({ endpoint: 'https://relay.test', fetchImpl, storage: adapter, logger: { warn() {} } });
  await first.register(departure, { heartbeat: false });
  assert.ok(first.hostToken, 'the first host is issued a token');

  // The page goes away without unregistering: the listing outlives it.
  const reloaded = new DepartureDirectoryClient({ endpoint: 'https://relay.test', fetchImpl, storage: adapter, logger: { warn() {} } });
  await assert.doesNotReject(
    () => reloaded.register(departure, { heartbeat: false }),
    'a reload must not be refused as a second host of its own region',
  );
  assert.equal(seen[1].presentedToken, 'token-1', 'the reload presents the token it remembered');

  // A different browser, with no memory of that token, still cannot take it.
  const stranger = new DepartureDirectoryClient({ endpoint: 'https://relay.test', fetchImpl, storage: null, logger: { warn() {} } });
  await assert.rejects(() => stranger.register(departure, { heartbeat: false }), /already hosted/);
});

// --- a heartbeat that loses its listing must not beat forever ----------------
test('an expired listing is re-registered rather than 404ed every twenty seconds', async () => {
  const calls = [];
  let listingExists = false;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push(`${options.method || 'GET'} ${path}`);
    if (options.method === 'PATCH') {
      if (!listingExists) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
      return { ok: true, status: 200, json: async () => ({ departure: null }) };
    }
    if (options.method === 'POST') {
      listingExists = true;
      return { ok: true, status: 200, json: async () => ({ departure: JSON.parse(options.body), hostToken: 'fresh' }) };
    }
    return { ok: true, status: 200, json: async () => ({ departures: [] }) };
  };

  const client = new DepartureDirectoryClient({
    endpoint: 'https://relay.test', fetchImpl, storage: null, logger: { warn() {}, info() {} },
  });
  client.listing = {
    protocolVersion: 1, regionId: 'region-gone', regionCode: 'GON', regionName: 'Gone',
    ownerName: 'Traveller', population: 1, capacity: 3, status: 'open', updatedAt: Date.now(),
  };

  await client.heartbeat().catch((error) => client._heartbeatFailed(error, 20_000));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(calls.includes('POST /v1/departures'), 'the region is put back on the board');
  assert.equal(client.hostToken, 'fresh', 'and holds the token it was issued');
  client.stopHeartbeat();
});
