import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceNpcRailTransfer,
  createNpcRailTransfer,
  NPC_RAIL_PHASE,
  npcRailCarriageLocalPose,
  npcRailDoorPassable,
} from '../src/npcrailtransfer.mjs';

function transfer(changes = {}) {
  return createNpcRailTransfer({
    runId: 'run:1', stationId: 'station:a', reservationId: 'reservation:1',
    carriageIndex: 0, seatIndex: 2, platformId: 'station:a:platform:main',
    side: 1, queueIndex: 2, ...changes,
  });
}

test('door threshold remains closed until the authored opening is passable', () => {
  assert.equal(npcRailDoorPassable(0.93), false);
  assert.equal(npcRailDoorPassable(0.94), true);
  const waiting = npcRailCarriageLocalPose(transfer({ phase: NPC_RAIL_PHASE.waitingForDoor }));
  const inside = npcRailCarriageLocalPose(transfer({ phase: NPC_RAIL_PHASE.interiorQueue }));
  assert.ok(waiting.x > inside.x, 'a closed door keeps the boarding passenger outside');
});

test('transfer phase progress survives persistence and consumes exact time', () => {
  const first = advanceNpcRailTransfer(transfer(), 0.3, 0.8);
  assert.equal(first.consumed, 0.3);
  assert.ok(Math.abs(first.transfer.progress - 0.375) < 1e-9);
  const restored = createNpcRailTransfer(JSON.parse(JSON.stringify(first.transfer)));
  const second = advanceNpcRailTransfer(restored, 1, 0.8, NPC_RAIL_PHASE.waitingForDoor);
  assert.ok(Math.abs(second.consumed - 0.5) < 1e-9);
  assert.equal(second.transfer.phase, NPC_RAIL_PHASE.waitingForDoor);
  assert.equal(second.transfer.progress, 0);
});

test('boarding and alighting poses cross opposite sides of the same doorway', () => {
  const outside = npcRailCarriageLocalPose(transfer({
    phase: NPC_RAIL_PHASE.crossingIn, progress: 0,
  }));
  const inside = npcRailCarriageLocalPose(transfer({
    phase: NPC_RAIL_PHASE.crossingIn, progress: 1,
  }));
  assert.ok(outside.x > inside.x);
  const leaving = npcRailCarriageLocalPose(transfer({
    phase: NPC_RAIL_PHASE.crossingOut, progress: 1,
  }));
  assert.equal(leaving.x, outside.x);

  const opposite = npcRailCarriageLocalPose(transfer({
    side: -1, phase: NPC_RAIL_PHASE.crossingIn, progress: 0,
  }));
  assert.ok(opposite.x < 0);
});

test('a seated transfer resolves to the reserved seat and seated pose', () => {
  const pose = npcRailCarriageLocalPose(transfer({ phase: NPC_RAIL_PHASE.seated }));
  assert.equal(pose.mode, 'seated');
  assert.equal(pose.seated, true);
});
