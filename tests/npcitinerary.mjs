import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockItineraryLeg,
  completeItineraryLeg,
  createItinerary,
  currentItineraryLeg,
  itinerarySnapshot,
  ITINERARY_LEG_KIND,
  ITINERARY_STATUS,
  restoreItinerarySnapshot,
  resumeItineraryLeg,
  startItineraryLeg,
} from '../src/npcitinerary.mjs';

function roundTrip() {
  return createItinerary({
    id: 'itinerary:npc:elm:1',
    actorId: 'npc:elm:rowan',
    residence: {
      originSettlementId: 'settlement:elm',
      residenceSettlementId: 'settlement:elm',
      householdId: 'household:elm:2',
      homeBuildingId: 'building:elm:3',
    },
    origin: { kind: 'building', key: 'building:elm:3' },
    destination: { kind: 'settlement', key: 'settlement:ash' },
    purpose: { commitmentId: 'commitment:rowan:1', kind: 'quest' },
    outboundLegs: [
      { id: 'leave-home', kind: ITINERARY_LEG_KIND.localWalk, data: { to: 'station:elm' } },
      { id: 'wait-elm', kind: ITINERARY_LEG_KIND.stationWait, data: { stationId: 'elm' } },
      { id: 'board-elm', kind: ITINERARY_LEG_KIND.boardTrain, data: { stationId: 'elm' } },
      { id: 'ride-ash', kind: ITINERARY_LEG_KIND.trainRide, data: { toStationId: 'ash' } },
      { id: 'alight-ash', kind: ITINERARY_LEG_KIND.alightTrain, data: { stationId: 'ash' } },
      { id: 'walk-destination', kind: ITINERARY_LEG_KIND.regionalWalk, data: { to: 'settlement:ash' } },
    ],
    activity: { id: 'do-quest', kind: 'quest', data: { targetId: 'mill:ash' } },
    returnLegs: [
      { id: 'walk-back-station', kind: ITINERARY_LEG_KIND.regionalWalk, data: { to: 'station:ash' } },
      { id: 'wait-ash', kind: ITINERARY_LEG_KIND.stationWait, data: { stationId: 'ash' } },
      { id: 'board-ash', kind: ITINERARY_LEG_KIND.boardTrain, data: { stationId: 'ash' } },
      { id: 'ride-elm', kind: ITINERARY_LEG_KIND.trainRide, data: { toStationId: 'elm' } },
      { id: 'alight-elm', kind: ITINERARY_LEG_KIND.alightTrain, data: { stationId: 'elm' } },
      { id: 'walk-home', kind: ITINERARY_LEG_KIND.localWalk, data: { to: 'building:elm:3' } },
    ],
  });
}

function finishCurrent(itinerary) {
  const leg = currentItineraryLeg(itinerary);
  startItineraryLeg(itinerary, leg.id);
  completeItineraryLeg(itinerary, leg.id);
}

test('one persistent resident completes an embodied round trip without changing residence', () => {
  const itinerary = roundTrip();
  const residenceBefore = JSON.stringify(itinerary.residence);
  const actorId = itinerary.actorId;
  assert.strictEqual(itinerary.returnPlan.home, itinerary.residence);
  let sawPassenger = false;
  let sawReturn = false;
  while (currentItineraryLeg(itinerary)) {
    const leg = currentItineraryLeg(itinerary);
    sawPassenger ||= leg.kind === ITINERARY_LEG_KIND.trainRide;
    sawReturn ||= leg.direction === 'return';
    finishCurrent(itinerary);
  }
  assert.equal(itinerary.status, ITINERARY_STATUS.completed);
  assert.equal(itinerary.returnPlan.status, ITINERARY_STATUS.completed);
  assert.equal(itinerary.actorId, actorId);
  assert.equal(JSON.stringify(itinerary.residence), residenceBefore);
  assert.equal(sawPassenger, true);
  assert.equal(sawReturn, true);
});

test('a blocked leg resumes in place without skipping or duplicating it', () => {
  const itinerary = roundTrip();
  const leg = currentItineraryLeg(itinerary);
  startItineraryLeg(itinerary, leg.id);
  const blocked = blockItineraryLeg(itinerary, leg.id, { code: 'path-obstructed' });
  assert.equal(itinerary.status, ITINERARY_STATUS.blocked);
  assert.equal(currentItineraryLeg(itinerary).id, leg.id);
  const resumed = resumeItineraryLeg(itinerary, leg.id, { reason: 'path-cleared' });
  assert.equal(itinerary.status, ITINERARY_STATUS.active);
  assert.equal(currentItineraryLeg(itinerary).id, leg.id);
  completeItineraryLeg(itinerary, leg.id);
  assert.equal(currentItineraryLeg(itinerary).id, 'wait-elm');
  assert.equal(blocked.type, 'leg.blocked');
  assert.equal(resumed.type, 'leg.resumed');
});

test('leg completion is exact-once and returns the original receipt on retry', () => {
  const itinerary = roundTrip();
  const leg = currentItineraryLeg(itinerary);
  startItineraryLeg(itinerary, leg.id);
  const first = completeItineraryLeg(itinerary, leg.id, { outcome: { arrived: true } });
  const sequence = itinerary.receiptSequence;
  const retried = completeItineraryLeg(itinerary, leg.id, { outcome: { arrived: true } });
  assert.strictEqual(retried, first);
  assert.equal(itinerary.receiptSequence, sequence);
  assert.equal(itinerary.receipts.filter((receipt) => (
    receipt.legId === leg.id && receipt.type === 'leg.completed'
  )).length, 1);
  assert.equal(currentItineraryLeg(itinerary).id, 'wait-elm');
});

test('restore rejects malformed or internally contradictory snapshots', () => {
  const snapshot = itinerarySnapshot(roundTrip());
  const badVersion = structuredClone(snapshot);
  badVersion.v = 99;
  assert.throws(() => restoreItinerarySnapshot(badVersion), /Malformed|Unsupported/);

  const missingReturn = structuredClone(snapshot);
  missingReturn.h[0] = false;
  assert.throws(() => restoreItinerarySnapshot(missingReturn), /return-home/);

  const impossibleProgress = structuredClone(snapshot);
  impossibleProgress.i = 2;
  assert.throws(() => restoreItinerarySnapshot(impossibleProgress), /before the current index/);
});

test('compact snapshots are deterministic and survive a JSON round trip', () => {
  const itinerary = roundTrip();
  finishCurrent(itinerary);
  const wait = currentItineraryLeg(itinerary);
  startItineraryLeg(itinerary, wait.id, { service: { run: 4, station: 'elm' } });
  blockItineraryLeg(itinerary, wait.id, { data: { platform: 1 }, code: 'train-delayed' });

  const first = JSON.stringify(itinerarySnapshot(itinerary));
  const restored = restoreItinerarySnapshot(JSON.parse(first));
  const second = JSON.stringify(itinerarySnapshot(restored));
  assert.equal(second, first);
  assert.equal(restored.actorId, itinerary.actorId);
  assert.deepEqual(restored.residence, itinerary.residence);
  assert.strictEqual(restored.returnPlan.home, restored.residence);
  assert.equal(currentItineraryLeg(restored).id, wait.id);
  assert.ok(first.length < 5000, `snapshot unexpectedly large: ${first.length} bytes`);
});
