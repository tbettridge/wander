import assert from 'node:assert/strict';
import {
  planRailPassengerPresentations,
  railPassengerPresentationKey,
} from '../src/railpassengerpresentation.mjs';

const runId = 'rail-run:regional:0:0';
const boarded = (personId, carriageIndex, seatIndex, extra = {}) => ({
  runId,
  reservationId: `reservation:${personId}`,
  personId,
  kind: 'npc',
  status: 'boarded',
  carriageIndex,
  seatIndex,
  ...extra,
});

assert.equal(
  railPassengerPresentationKey(runId, 'reservation:alice'),
  `${runId}::reservation:alice`,
);

const initial = planRailPassengerPresentations([], {
  runId,
  reservations: [
    boarded('bob', 1, 2),
    boarded('alice', 0, 1),
    boarded('waiting', 0, 0, { status: 'reserved' }),
    boarded('player', 0, 3, { kind: 'player' }),
    boarded('gone', 1, 0, { status: 'alighted' }),
  ],
});
assert.deepEqual(initial.records.map((record) => record.personId), ['alice', 'bob']);
assert.deepEqual(initial.operations.map((operation) => operation.type), ['create', 'create']);

const stable = planRailPassengerPresentations(initial.records, {
  runId,
  reservations: [boarded('alice', 0, 1), boarded('bob', 1, 2)],
});
assert.deepEqual(stable.operations, [], 'stable manifests must not recreate passenger visuals');

const cleared = planRailPassengerPresentations(initial.records, {
  runId,
  reservations: [boarded('alice', 0, 1, { status: 'alighted' })],
});
assert.deepEqual(cleared.operations.map((operation) => operation.type), ['remove', 'remove'],
  'alighting removes an existing visual exactly once');
assert.deepEqual(planRailPassengerPresentations(cleared.records, {
  runId, reservations: [],
}).operations, [], 'a removed visual must stay removed on later frames');

const moved = planRailPassengerPresentations(initial.records, {
  runId,
  reservations: [boarded('alice', 1, 0)],
});
assert.deepEqual(moved.operations.map((operation) => operation.type), ['remove', 'update']);
assert.equal(moved.operations[1].record.carriageIndex, 1);
assert.equal(moved.operations[1].record.seatIndex, 0);

const nextRun = 'rail-run:regional:0:1';
const replaced = planRailPassengerPresentations(initial.records, {
  runId: nextRun,
  reservations: [{ ...boarded('alice', 0, 1), runId: nextRun }],
});
assert.deepEqual(replaced.operations.map((operation) => operation.type), ['remove', 'remove', 'create'],
  'a run change removes old visual identities before creating the new run');

assert.throws(() => planRailPassengerPresentations([], {
  runId,
  reservations: [boarded('alice', 0, 1), boarded('alice', 1, 1)],
}), /Duplicate boarded passenger/);
assert.throws(() => planRailPassengerPresentations([], {
  runId,
  reservations: [boarded('alice', 0, 1), boarded('bob', 0, 1)],
}), /Duplicate boarded passenger seat/);
assert.throws(() => planRailPassengerPresentations([], {
  runId,
  reservations: [{ ...boarded('alice', 0, 1), runId: 'other-run' }],
}), /another run/);

const immutableReservation = Object.freeze(boarded('immutable', 0, 2));
const before = JSON.stringify(immutableReservation);
planRailPassengerPresentations([], { runId, reservations: [immutableReservation] });
assert.equal(JSON.stringify(immutableReservation), before,
  'presentation reconciliation must never mutate manifest records');

console.log('railpassengerpresentation PASS · exact-once create/update/remove · corrupt views fail closed');
