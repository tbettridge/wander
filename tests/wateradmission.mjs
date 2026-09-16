import { WATER_CACHE_REVISION } from '../src/hydrologyformat.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiplayerSession } from '../src/multiplayer.mjs';
import { createLocalIdentity } from '../src/multiplayeridentity.mjs';
import { createTicket, createAdmissionRequest, transitionTicket } from '../src/interregionalticket.mjs';
import { createWaterAgreement, WATER_AGREEMENT_SUPPORT } from '../src/wateragreement.mjs';
import { descriptorHash } from '../src/hydrologyformat.mjs';
import { assertSharedWorldGeneration } from '../src/worldgeneration.mjs';
const generation = { terrain: 3, hydrology: WATER_CACHE_REVISION, layout: 'regional' };
function setup() {
  const plans = [];
  for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) {
    const p = { version: 1, generationVersion: 3, regional: 1, preview: true, seed: 42, regionX: x, regionZ: z, basins: [], components: [] };
    plans.push({ ...p, hash: descriptorHash(p) });
  }
  const agreement = createWaterAgreement(42, 0, 0, plans), signals = [];
  let started = 0;
  const host = new MultiplayerSession({ seed: 42, identity: createLocalIdentity({ storage: null }),
    getWorldGeneration: () => generation, prepareLandscape: async () => {}, regionalNetworking: true });
  host.role = 'host'; host._sendSignal = packet => signals.push(JSON.parse(JSON.stringify(packet)));
  host._ensurePeer = () => ({ async startHost() { started++; } });
  host.configureTravel({ destinationStationsProvider: () => [{ id: 'arrival', name: 'Arrival', x: 140, y: 3, z: 140 }], landscapeProvider: () => agreement });
  const identity = createLocalIdentity({ storage: null });
  let ticket = createTicket({ passengerId: identity.playerId, destination: host.region });
  for (const phase of ['keeper-confirmed', 'admission-requested']) ticket = transitionTicket(ticket, phase);
  const request = support => {
    const value = createAdmissionRequest({ ticket, identity, landscapeSupport: support });
    host.hostRequests.set(identity.playerId, value); return value;
  };
  return { host, identity, ticket, request, signals, agreement, plans, started: () => started };
}

test('old or mismatched clients are denied before peer setup and never receive a landscape manifest', async () => {
  for (const support of [null, {}, { ...WATER_AGREEMENT_SUPPORT, hydrology: 1 }, { ...WATER_AGREEMENT_SUPPORT, hydrology: WATER_CACHE_REVISION - 1 }, { ...WATER_AGREEMENT_SUPPORT, hydrology: 99 }]) {
    const f = setup(); const decision = await f.host.decideAdmission(f.request(support), true);
    assert.equal(decision.approved, false); assert.match(decision.reason, /Reload/);
    assert.equal(f.started(), 0); assert.equal(f.host.approvedVisitors.size, 0);
    assert.equal(f.signals[0].ticket, undefined);
  }
});

test('approved compatible arrivals retain exact region hashes through signaling and wait for guest verification', async () => {
  const f = setup(); await f.host.decideAdmission(f.request(WATER_AGREEMENT_SUPPORT), true);
  assert.equal(f.started(), 1);
  assert.deepEqual(f.signals[0].ticket.destination.landscape, f.agreement);
  let finish; const travel = [];
  const guest = new MultiplayerSession({ seed: 7, identity: f.identity,
    prepareLandscape: async agreement => { assert.deepEqual(agreement, f.agreement); return new Promise(resolve => { finish = resolve; }); },
    onTravel: value => travel.push(value) });
  guest.role = 'guest'; guest.ticket = f.ticket; guest.selectedDeparture = f.host.region;
  guest.peers.set(f.host.identity.playerId, { state: 'connected', sendControl() {}, close() {} });
  guest._handleSignal(f.signals[0]);
  assert.equal(guest.ticket.phase, 'preflight'); assert.equal(travel.length, 0);
  finish({ waterPlans: f.plans }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(guest.ticket.phase, 'summoned'); assert.equal(travel.length, 1);
  assert.equal(guest.takePreparedLandscape(f.ticket.ticketId).waterPlans, f.plans);
  guest._finishVisitSession();
});

test('unready host regions decline cleanly rather than issuing an unrelated arrival manifest', async () => {
  const f = setup();
  f.host.travel.destinationStationsProvider = () => [{ id: 'other', x: 5000, z: 0 }];
  const decision = await f.host.decideAdmission(f.request(WATER_AGREEMENT_SUPPORT), true);
  assert.equal(decision.approved, false); assert.match(decision.reason, /outside/);
  assert.equal(f.started(), 0);
  const g = setup(); g.host.travel.landscapeProvider = () => { throw new Error('Host is preparing the valley; retry shortly.'); };
  assert.match((await g.host.decideAdmission(g.request(WATER_AGREEMENT_SUPPORT), true)).reason, /retry/);
  assert.equal(g.started(), 0);
});

test('regional networking requires explicit enablement and fixed previews remain isolated', () => {
  assert.throws(() => assertSharedWorldGeneration(generation), /single-player/);
  assert.doesNotThrow(() => assertSharedWorldGeneration(generation, true));
  assert.throws(() => assertSharedWorldGeneration({ ...generation, layout: 'preview:12345678' }, true), /single-player/);
  assert.throws(() => assertSharedWorldGeneration({ ...generation, hydrology: WATER_CACHE_REVISION + 1 }, true), /single-player/);
});
