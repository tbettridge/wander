import assert from 'node:assert/strict';
import test from 'node:test';
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
import { InMemoryDepartureDirectory } from '../src/multiplayerdirectory.mjs';
import { DIRECT_ICE_SERVERS, isDirectIceConfiguration } from '../src/multiplayerpeer.mjs';

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

