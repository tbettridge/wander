import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createServiceRunId,
  ORDINARY_NPC_SEATS_PER_CARRIAGE,
  PASSENGER_CARRIAGE_COUNT,
  PASSENGER_SEATS_PER_CARRIAGE,
  PASSENGER_STATUS,
  PLAYER_PREFERRED_SEAT,
  RailPassengerManifest,
} from '../src/railpassengers.mjs';

function manifest() {
  return new RailPassengerManifest({
    runId: createServiceRunId({ serviceId: 'regional', serviceDay: 12, sequence: 4 }),
  });
}

function reserveNpc(target, number, extra = {}) {
  return target.reserve({
    personId: `npc-${number}`,
    originStationId: 'station-a',
    destinationStationId: 'station-b',
    ...extra,
  });
}

test('service run IDs and default capacity are stable', () => {
  const first = createServiceRunId({ serviceId: 'regional east', serviceDay: 12, sequence: 4 });
  const second = createServiceRunId({ serviceId: 'regional east', serviceDay: 12, sequence: 4 });
  assert.equal(first, second);
  assert.notEqual(first, createServiceRunId({ serviceId: 'regional east', serviceDay: 12, sequence: 5 }));
  const target = manifest();
  assert.equal(target.physicalCapacity, PASSENGER_CARRIAGE_COUNT * PASSENGER_SEATS_PER_CARRIAGE);
  assert.equal(target.ordinaryNpcCapacity, PASSENGER_CARRIAGE_COUNT * ORDINARY_NPC_SEATS_PER_CARRIAGE);
});

test('ordinary allocation keeps each carriage between one and three NPCs', () => {
  const target = manifest();
  for (let i = 0; i < 6; i++) reserveNpc(target, i);
  const active = target.reservations({ includeAlighted: false });
  for (let carriageIndex = 0; carriageIndex < PASSENGER_CARRIAGE_COUNT; carriageIndex++) {
    const occupants = active.filter((entry) => entry.carriageIndex === carriageIndex);
    assert.ok(occupants.length >= 1 && occupants.length <= 3);
    assert.ok(occupants.every((entry) => entry.seatIndex < ORDINARY_NPC_SEATS_PER_CARRIAGE));
  }
  assert.throws(() => reserveNpc(target, 6), /No npc passenger seat/);
});

test('duplicate people and seats are prevented while identical reservations are idempotent', () => {
  const target = manifest();
  const first = reserveNpc(target, 1, { carriageIndex: 0, seatIndex: 0 });
  assert.deepEqual(reserveNpc(target, 1, { carriageIndex: 0, seatIndex: 0 }), first);
  assert.throws(() => reserveNpc(target, 1, { destinationStationId: 'station-c' }), /already has/);
  assert.throws(() => reserveNpc(target, 2, { carriageIndex: 0, seatIndex: 0 }), /occupied/);
  assert.throws(() => reserveNpc(target, 3, {
    carriageIndex: 0, seatIndex: PLAYER_PREFERRED_SEAT,
  }), /ordinary NPC capacity/);
});

test('ordinary reservations preserve a player-available seat in each carriage', () => {
  const target = manifest();
  for (let i = 0; i < 6; i++) reserveNpc(target, i);
  assert.deepEqual(target.playerAvailableSeat(0), {
    carriageIndex: 0, seatIndex: PLAYER_PREFERRED_SEAT,
  });
  const player = target.reserve({
    personId: 'player', kind: 'player', originStationId: 'station-a',
    destinationStationId: 'station-b', carriageIndex: 0, seatIndex: PLAYER_PREFERRED_SEAT,
  });
  assert.equal(player.kind, 'player');
  assert.deepEqual(target.playerAvailableSeat(0), {
    carriageIndex: 1, seatIndex: PLAYER_PREFERRED_SEAT,
  });
});

test('boarding and alighting update stop and carriage queries exactly once', () => {
  const target = manifest();
  const passenger = reserveNpc(target, 1);
  assert.deepEqual(target.occupantsAtStop('station-a').boarding.map((entry) => entry.personId), ['npc-1']);
  assert.throws(() => target.board(passenger.reservationId, 'station-c'), /cannot board/);

  const boarded = target.board(passenger.reservationId, 'station-a', { serviceTick: 120 });
  assert.equal(boarded.applied, true);
  assert.equal(target.reservationForPerson('npc-1').status, PASSENGER_STATUS.boarded);
  assert.deepEqual(target.occupantsInCarriage(passenger.carriageIndex).map((entry) => entry.personId), ['npc-1']);
  assert.deepEqual(target.occupantsAtStop('station-b').alighting.map((entry) => entry.personId), ['npc-1']);

  const boardedAgain = target.board('npc-1', 'station-a', { serviceTick: 999 });
  assert.equal(boardedAgain.applied, false);
  assert.deepEqual(boardedAgain.receipt, boarded.receipt, 'duplicate board returns the original receipt');
  assert.throws(() => target.alight('npc-1', 'station-c'), /cannot alight/);

  const alighted = target.alight('npc-1', 'station-b', { serviceTick: 240 });
  assert.equal(alighted.applied, true);
  assert.equal(target.reservationForPerson('npc-1').status, PASSENGER_STATUS.alighted);
  assert.deepEqual(target.occupantsInCarriage(passenger.carriageIndex), []);
  const alightedAgain = target.alight('npc-1', 'station-b', { serviceTick: 777 });
  assert.equal(alightedAgain.applied, false);
  assert.deepEqual(alightedAgain.receipt, alighted.receipt, 'duplicate alight returns the original receipt');
});

test('alighting before boarding is rejected', () => {
  const target = manifest();
  reserveNpc(target, 1);
  assert.throws(() => target.alight('npc-1', 'station-b'), /has not boarded/);
});

test('JSON snapshot round trip preserves allocation and exact-once receipts', () => {
  const target = manifest();
  reserveNpc(target, 1);
  reserveNpc(target, 2);
  const boarded = target.board('npc-1', 'station-a', { serviceTick: 120 });
  const encoded = JSON.stringify(target.snapshot());
  const restored = RailPassengerManifest.restore(JSON.parse(encoded));
  assert.deepEqual(restored.snapshot(), target.snapshot());
  assert.deepEqual(restored.occupantsInCarriage(0), target.occupantsInCarriage(0));
  const duplicate = restored.board('npc-1', 'station-a');
  assert.equal(duplicate.applied, false);
  assert.deepEqual(duplicate.receipt, boarded.receipt);
});
