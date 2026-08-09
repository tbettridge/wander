import test from 'node:test';
import assert from 'node:assert/strict';
import { planMultimodalRoute } from '../src/npcmultimodalroute.mjs';

const railway = {
  stations: ['station:a', 'station:b', 'station:c'],
  connections: [
    { fromStationId: 'station:a', toStationId: 'station:b', serviceId: 'service:main', duration: 300 },
    { fromStationId: 'station:b', toStationId: 'station:c', serviceId: 'service:main', duration: 300 },
    { fromStationId: 'station:c', toStationId: 'station:b', serviceId: 'service:return', duration: 300 },
    { fromStationId: 'station:b', toStationId: 'station:a', serviceId: 'service:return', duration: 300 },
  ],
};

function base(overrides = {}) {
  return {
    origin: { key: 'settlement:home' },
    destination: { key: 'settlement:destination' },
    directWalk: { duration: 2400 },
    originAccess: [{ stationId: 'station:a', duration: 120 }],
    destinationEgress: [{ stationId: 'station:c', duration: 180 }],
    railway,
    departureWaitEstimates: {
      'station:a|service:main': 120,
      'station:b|service:main': 420,
      'station:c|service:return': 90,
    },
    ...overrides,
  };
}

test('a station-village uses its zero-cost platform access without inventing a walk', () => {
  const route = planMultimodalRoute(base({
    originAccess: [{ stationId: 'station:a', duration: 0 }],
  }));
  assert.equal(route.ok, true);
  assert.equal(route.outbound.mode, 'rail');
  assert.equal(route.outboundLegs[0].kind, 'station-wait');
  assert.equal(route.outboundLegs.some((leg) => (
    leg.kind.endsWith('walk') && leg.data?.role === 'access'
  )), false);
});

test('a non-station settlement deterministically chooses the best access station', () => {
  const route = planMultimodalRoute(base({
    originAccess: [
      { stationId: 'station:b', duration: 250 },
      { stationId: 'station:a', duration: 250 },
    ],
  }));
  assert.equal(route.ok, true);
  assert.equal(route.outbound.mode, 'rail');
  assert.equal(route.outbound.stationIds[0], 'station:a',
    'equal-cost candidates use stable station/service lexical ordering');
  assert.equal(route.outboundLegs[0].kind, 'regional-walk');
  assert.equal(route.outboundLegs[0].data.stationId, 'station:a');
});

test('a quest route is rejected when even the fastest arrival misses its deadline', () => {
  const route = planMultimodalRoute(base({
    purposeKind: 'quest',
    departAt: 1000,
    deadlineAt: 1500,
  }));
  assert.deepEqual(route, {
    version: 1,
    ok: false,
    reason: 'quest-deadline-unreachable',
    fastestOutboundDuration: 1020,
    arrivalAt: 2020,
    deadlineAt: 1500,
  });
});

test('walking wins when rail is slower and remains the fallback when rail is unavailable', () => {
  const slower = planMultimodalRoute(base({ directWalk: { duration: 900 } }));
  assert.equal(slower.outbound.mode, 'walk');

  const unavailable = planMultimodalRoute(base({
    railway: { stations: ['station:a', 'station:c'], connections: [] },
  }));
  assert.equal(unavailable.ok, true);
  assert.equal(unavailable.outbound.mode, 'walk');
  assert.equal(unavailable.returning.mode, 'walk');
});

test('route output contains compatible outward legs and a default return-home route', () => {
  const route = planMultimodalRoute(base());
  assert.equal(route.ok, true);
  assert.equal(route.returnRequired, true);
  assert.equal(route.outbound.mode, 'rail');
  assert.equal(route.returning.mode, 'rail');
  assert.deepEqual(route.outboundLegs.map((leg) => leg.kind), [
    'regional-walk', 'station-wait', 'board-train', 'train-ride', 'alight-train', 'regional-walk',
  ]);
  assert.deepEqual(route.returnLegs.map((leg) => leg.kind), [
    'regional-walk', 'station-wait', 'board-train', 'train-ride', 'alight-train', 'regional-walk',
  ]);
  assert.ok(route.outboundLegs.every((leg) => leg.id.startsWith('outbound:')));
  assert.ok(route.returnLegs.every((leg) => leg.id.startsWith('return:')));
});
