import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureRailwayLayout,
  normalizeRailwayLayout,
} from '../src/regionlayout.mjs';
import { createTicket, transitionTicket } from '../src/interregionalticket.mjs';
import { MultiplayerSession } from '../src/multiplayer.mjs';
import { createLocalIdentity } from '../src/multiplayeridentity.mjs';

const railway = {
  requestedCenter: { x: 6832.6220703125, z: -6574.302734375 },
  radius: 1500,
  searchRadius: 1200,
  debug: { stationCount: 5, terrainEnabled: true, trackEnabled: true },
};

test('a ticket preserves the host generation inputs throughout the visit', () => {
  const layout = captureRailwayLayout(railway);
  let ticket = createTicket({
    passengerId: 'player:guest',
    destination: {
      regionId: 'region-host',
      regionCode: 'HOST',
      regionName: 'Host region',
      seed: 20260612,
      railway: layout,
      arrivalStationX: 7308,
      arrivalStationZ: -7813,
      arrivalYaw: 1.2,
    },
  });
  for (const phase of [
    'keeper-confirmed',
    'admission-requested',
    'host-approved',
    'preflight',
    'issued',
    'summoned',
    'boarded',
    'departing',
    'transition',
    'arriving',
    'visit-active',
  ]) {
    ticket = transitionTicket(JSON.parse(JSON.stringify(ticket)), phase);
    assert.deepEqual(ticket.destination.railway, layout);
    assert.equal(ticket.destination.arrivalYaw, 1.2);
  }
  assert.notEqual(
    ticket.destination.railway.center.x,
    ticket.destination.arrivalStationX,
  );
  assert.notEqual(
    ticket.destination.railway.center.z,
    ticket.destination.arrivalStationZ,
  );
  layout.center.x = 99;
  assert.equal(ticket.destination.railway.center.x, railway.requestedCenter.x);
});

test('malformed generation inputs cannot trigger unbounded railway planning', () => {
  const layout = captureRailwayLayout(railway);
  for (const invalid of [
    null,
    {},
    { ...layout, version: 2 },
    { ...layout, radius: Infinity },
    { ...layout, radius: 1e9 },
    { ...layout, searchRadius: -1 },
    { ...layout, stationCount: 999 },
    { ...layout, center: { x: null, z: 0 } },
  ])
    assert.equal(normalizeRailwayLayout(invalid), null);
});

test('host admission sends the original layout independently of the moving host', async () => {
  const host = new MultiplayerSession({
    seed: 20260612,
    identity: createLocalIdentity({ storage: null }),
    directArrival: true,
  });
  host.role = 'host';
  host.configureTravel({
    hostPositionProvider: () => ({
      x: 7308,
      y: 21,
      z: -7813,
      yaw: Math.PI / 2,
    }),
    railwayLayoutProvider: () => captureRailwayLayout(railway),
  });
  const request = {
    playerId: 'player:guest',
    ticketId: 'ticket:test',
    regionId: host.region.regionId,
  };
  host.hostRequests.set(request.playerId, request);
  host._ensurePeer = () => ({ startHost: async () => {} });
  await host.decideAdmission(request, true);
  const approval = host.pendingSignals.find(
    (s) => s.kind === 'admission-response',
  );
  assert.deepEqual(
    approval.ticket.destination.railway,
    captureRailwayLayout(railway),
  );
  assert.equal(approval.ticket.destination.arrivalStationX, 7305);
  assert.equal(approval.ticket.destination.arrivalStationZ, -7813);
});
