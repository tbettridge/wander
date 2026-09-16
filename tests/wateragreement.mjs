import test from 'node:test';
import assert from 'node:assert/strict';
import { descriptorHash } from '../src/hydrologyformat.mjs';
import { createWaterAgreement, normalizeWaterAgreement, verifyWaterAgreement, prepareAgreedWaterLandscape } from '../src/wateragreement.mjs';
import { createTicket, transitionTicket } from '../src/interregionalticket.mjs';
import { MultiplayerSession } from '../src/multiplayer.mjs';
import { createLocalIdentity } from '../src/multiplayeridentity.mjs';

function plans() {
  const values = [];
  for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) {
    const p = { version: 1, generationVersion: 3, regional: 1, preview: true, seed: 42, regionX: x, regionZ: z, basins: [], components: [] };
    values.push({ ...p, hash: descriptorHash(p) });
  }
  return values;
}
function approved(agreement) {
  let ticket = createTicket({ passengerId: 'guest', destination: { regionId: 'host-region', regionCode: 'HOST', regionName: 'Host', seed: 42, arrivalStationX: 0, arrivalStationZ: 0, landscape: agreement } });
  for (const phase of ['keeper-confirmed', 'admission-requested', 'host-approved']) ticket = transitionTicket(ticket, phase);
  return ticket;
}
function guest(loader, agreement) {
  const travel = [], controls = [], statuses = [];
  const session = new MultiplayerSession({ seed: 7, identity: createLocalIdentity({ storage: null }), prepareLandscape: loader,
    onTravel: value => travel.push(value), onStatus: value => statuses.push(value) });
  session.role = 'guest'; session.hostId = 'host'; session.ticket = approved(agreement);
  session.peers.set('host', { sendControl: (...args) => controls.push(args), close() {} });
  return { session, travel, controls, statuses };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('agreement fits one small message and preserves canonical hashes through ticket serialization', () => {
  const p = plans(), a = createWaterAgreement(42, 0, 0, p);
  assert.ok(JSON.stringify(a).length < 2048);
  assert.deepEqual(createWaterAgreement(42, 0, 0, [...p].reverse()), a);
  assert.deepEqual(approved(JSON.parse(JSON.stringify(a))).destination.landscape, a);
  assert.deepEqual(verifyWaterAgreement(a, p), a);
  assert.throws(() => createTicket({ passengerId: 'guest', destination: { ...approved(a).destination, arrivalStationX: 4096 } }), /outside/);
  assert.throws(() => normalizeWaterAgreement(a, 9), /Invalid/);
  assert.throws(() => normalizeWaterAgreement({ ...a, regions: a.regions.slice(1) }), /Invalid/);
  assert.throws(() => normalizeWaterAgreement({ ...a, regions: a.regions.map(() => a.regions[0]) }), /Incomplete/);
  assert.throws(() => normalizeWaterAgreement({ ...a, hash: '00000000' }), /checksum/);
  assert.throws(() => normalizeWaterAgreement({ ...a, generation: { ...a.generation, hydrology: 999 } }), /different world generator/);
  const damaged = structuredClone(p); damaged[0].basins.push({ id: 'damage' });
  assert.throws(() => verifyWaterAgreement(a, damaged), /checksum/);
  const changed = structuredClone(p); changed[0].preview = false;
  const { hash, ...payload } = changed[0]; changed[0].hash = descriptorHash(payload);
  assert.throws(() => verifyWaterAgreement(a, changed), /does not match/);
});

test('guest cannot receive world state or board until local plans match the host', async () => {
  const p = plans(), a = createWaterAgreement(42, 0, 0, p);
  let finish, loads = 0;
  const { session, travel, controls } = guest(() => { loads++; return new Promise(resolve => { finish = resolve; }); }, a);
  session._peerConnected('host'); session._peerConnected('host');
  assert.equal(loads, 1); assert.equal(session.ticket.phase, 'preflight'); assert.equal(travel.length, 0);
  let applied = 0; session.guestProjection.applySnapshot = () => { applied++; };
  session._handlePeerMessage('host', 'state', { type: 'state-snapshot', payload: {} });
  assert.equal(applied, 0);
  finish({ waterPlans: p }); await flush();
  assert.equal(session.ticket.phase, 'summoned'); assert.equal(travel.length, 1);
  assert.ok(controls.some(([type]) => type === 'state-request'));
  assert.equal(travel[0].preparedLandscape.waterPlans, p);
  let disposed = 0;
  session.preparedLandscape.stream = { dispose() { disposed++; } };
  const transferred = session.takePreparedLandscape(session.ticket.ticketId);
  assert.equal(transferred.waterPlans, p);
  assert.throws(() => session.takePreparedLandscape(session.ticket.ticketId), /unavailable/);
  session._finishVisitSession();
  assert.equal(disposed, 0, 'session cleanup must not dispose a stream transferred to the world');
  transferred.stream.dispose();
});

test('cancelled and mismatched preparations dispose resources and never issue travel', async () => {
  const p = plans(), a = createWaterAgreement(42, 0, 0, p);
  let finish, disposed = 0;
  const first = guest(() => new Promise(resolve => { finish = resolve; }), a);
  first.session._peerConnected('host');
  first.session._handlePeerMessage('host', 'control', { type: 'close-session', payload: { reason: 'cancelled' } });
  finish({ waterPlans: p, stream: { dispose() { disposed++; } } }); await flush();
  assert.equal(disposed, 1); assert.equal(first.travel.length, 0);
  const bad = guest(async () => ({ waterPlans: [], stream: { dispose() { disposed++; } } }), a);
  bad.session._peerConnected('host'); await flush();
  assert.equal(bad.session.ticket.phase, 'cancelled'); assert.equal(bad.travel.length, 0); assert.equal(disposed, 2);
  const missing = guest(null, a); missing.session._peerConnected('host'); await flush();
  assert.equal(missing.session.ticket.phase, 'cancelled'); assert.equal(missing.travel.length, 0);
});

test('production preflight loader validates the worker result and aborts outstanding work', async () => {
  const p = plans(), a = createWaterAgreement(42, 0, 0, p);
  let stopped = 0;
  const worker = { terminate() { stopped++; }, postMessage(request) {
    queueMicrotask(() => worker.onmessage({ data: { ...request, type: 'water-window-planned', plans: p } }));
  } };
  const prepared = await prepareAgreedWaterLandscape(a, { workerFactory: () => worker });
  assert.equal(prepared.world.generationVersion, 3);
  assert.equal(prepared.stream.active.key, '0,0'); assert.equal(stopped, 0);
  prepared.stream.dispose(); assert.equal(stopped, 1);
  const controller = new AbortController(); let created;
  const ready = new Promise(resolve => { created = resolve; });
  const pending = prepareAgreedWaterLandscape(a, { signal: controller.signal,
    workerFactory: () => ({ terminate() { stopped++; }, postMessage() { created(); } }) });
  await ready; controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.ok(stopped >= 2);
});

for (const terminal of ['failed', 'closed', 'denied']) {
  test(`terminal ${terminal} aborts preflight and discards late landscape results`, async () => {
    const p = plans(), a = createWaterAgreement(42, 0, 0, p);
    let finish, signal, disposed = 0;
    const { session, travel } = guest((_, options) => {
      signal = options.signal;
      return new Promise(resolve => { finish = resolve; });
    }, a);
    session.peers.delete('host');
    const peer = session._ensurePeer('host');
    peer._setState('connected');
    peer._setState(terminal, 'connection ended');
    assert.equal(signal.aborted, true);
    assert.equal(session.ticket.phase, 'cancelled');
    assert.equal(session.ticket.cancelReason, 'connection ended');
    assert.equal(session.peers.has('host'), false);
    assert.equal(travel.filter(event => event.phase === 'visit-failed').length, 1);
    finish({ waterPlans: p, stream: { dispose() { disposed++; } } });
    await flush();
    assert.equal(disposed, 1);
    assert.equal(travel.some(event => event.phase === 'ticket-issued'), false);
    session._peerConnected('host');
    assert.equal(session.landscapePreflight, null, 'late connection cannot restart a cancelled ticket');
  });
}

test('temporary disconnect preserves preparation and reconnection cannot issue travel twice', async () => {
  const p = plans(), a = createWaterAgreement(42, 0, 0, p);
  let finish, signal, loads = 0, disposed = 0;
  const { session, travel } = guest((_, options) => {
    loads++; signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  }, a);
  session.peers.delete('host');
  const peer = session._ensurePeer('host');
  peer._setState('connected');
  peer._setState('disconnected');
  peer._setState('reconnecting');
  peer._setState('connected');
  assert.equal(loads, 1); assert.equal(signal.aborted, false);
  finish({ waterPlans: p, stream: { dispose() { disposed++; } } }); await flush();
  session.connectedPeers.delete('host');
  session._peerConnected('host');
  assert.equal(travel.filter(event => event.phase === 'ticket-issued').length, 1);
  peer._setState('closed');
  assert.equal(session.ticket.phase, 'cancelled');
  assert.equal(disposed, 1, 'unclaimed landscape is released if the host leaves before boarding');
});
