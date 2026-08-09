import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  attachNpcSpatialState,
  createLivingWorldState,
  registerLivingWorldEntity,
  setLivingWorldFeatures,
} from '../src/livingworldstate.mjs';
import {
  refreshStationDutyRosters,
  restoreStationDutyRefreshSnapshot,
  STATION_DUTY_REFRESH_SNAPSHOT_VERSION,
} from '../src/npcstationdutyrefresh.mjs';

function fixture({ enabled = true, stations = 1, residentsPerStation = 8 } = {}) {
  const state = createLivingWorldState({ worldSeed: 811 });
  if (enabled) setLivingWorldFeatures(state, { unifiedNpcMobilityEnabled: true });
  const contexts = [];
  for (let stationIndex = 0; stationIndex < stations; stationIndex++) {
    const settlementId = `settlement:${stationIndex}`;
    const stationId = `station:${stationIndex}`;
    const residentIds = [];
    for (let index = 0; index < residentsPerStation; index++) {
      const id = `npc:${stationIndex}:${index}`;
      const homeBuildingId = `building:${stationIndex}:${Math.floor(index / 2)}`;
      const householdId = `household:${stationIndex}:${Math.floor(index / 2)}`;
      registerLivingWorldEntity(state, {
        id, kind: 'npc', name: `Resident ${stationIndex}-${index}`, householdId,
      });
      attachNpcSpatialState(state, id, {
        residence: {
          originSettlementId: settlementId,
          residenceSettlementId: settlementId,
          householdId,
          homeBuildingId,
        },
        location: { kind: 'building', settlementId, buildingId: homeBuildingId },
      });
      residentIds.push(id);
    }
    contexts.push({ stationId, settlementId, residentIds });
  }
  return { state, contexts };
}

function at(state, worldHours, contexts, snapshot = null) {
  state.clock.worldHours = worldHours;
  return refreshStationDutyRosters({ state, contexts, snapshot });
}

test('refresh crosses 07:00 and 20:00 demand boundaries with daytime 2-4 and night 0-1', () => {
  const { state, contexts } = fixture();
  const beforeDay = at(state, 6.99, contexts);
  const nightBefore = beforeDay.rosters['station:0'];
  assert.equal(beforeDay.refreshed, true);
  assert.ok(nightBefore.target >= 0 && nightBefore.target <= 1);

  const day = at(state, 7, contexts, beforeDay.snapshot);
  const daytime = day.rosters['station:0'];
  assert.equal(day.refreshed, true);
  assert.equal(day.hourBucket, 14);
  assert.ok(daytime.target >= 2 && daytime.target <= 4);
  assert.equal(daytime.assignments.length, daytime.target);

  const beforeNight = at(state, 19.99, contexts, day.snapshot);
  assert.equal(beforeNight.rosters['station:0'].daytime, true);
  const night = at(state, 20, contexts, beforeNight.snapshot);
  assert.equal(night.refreshed, true);
  assert.equal(night.hourBucket, 40);
  assert.ok(night.rosters['station:0'].target <= 1);
  assert.equal(night.rosters['station:0'].daytime, false);
});

test('same bucket and canonical contexts are an exact-once no-op', () => {
  const { state, contexts } = fixture();
  const first = at(state, 10.05, contexts);
  const revision = state.revision;
  const locations = structuredClone(state.entities);
  const second = at(state, 10.49, [{
    ...contexts[0],
    residentIds: [...contexts[0].residentIds].reverse(),
  }], first.snapshot);
  assert.equal(second.refreshed, false);
  assert.equal(second.applied, false);
  assert.deepEqual(second.changedIds, []);
  assert.deepEqual(second.releasedIds, []);
  assert.equal(state.revision, revision);
  assert.deepEqual(state.entities, locations);
  assert.deepEqual(second.rosters, first.rosters);
});

test('midnight changes the day key and replans even across bucket 47 to 0', () => {
  const { state, contexts } = fixture();
  const late = at(state, 23.99, contexts);
  assert.equal(late.dayIndex, 0);
  assert.equal(late.hourBucket, 47);
  const tomorrow = at(state, 24, contexts, late.snapshot);
  assert.equal(tomorrow.refreshed, true);
  assert.equal(tomorrow.dayIndex, 1);
  assert.equal(tomorrow.hourBucket, 0);
  assert.equal(tomorrow.rosters['station:0'].dayIndex, 1);
});

test('removing a station context releases its prior duty residents safely', () => {
  const { state, contexts } = fixture();
  const first = at(state, 12, contexts);
  const assigned = first.rosters['station:0'].assignments.map(({ personId }) => personId);
  const removed = at(state, 12.1, [], first.snapshot);
  assert.equal(removed.refreshed, true);
  assert.deepEqual(removed.removedStationIds, ['station:0']);
  assert.deepEqual(removed.releasedIds, [...assigned].sort());
  assert.deepEqual(removed.rosters, {});
  for (const id of assigned) {
    assert.equal(state.entities[id].location.kind, 'building');
    assert.equal(state.entities[id].activity, null);
  }
});

test('plan removal reports conflicts and preserves a newer itinerary location', () => {
  const { state, contexts } = fixture();
  const first = at(state, 12, contexts);
  const awayId = first.rosters['station:0'].assignments[0].personId;
  const away = state.entities[awayId];
  attachNpcSpatialState(state, awayId, {
    residence: away.residence,
    location: {
      kind: 'regional-edge', edgeId: 'edge:0:1', fromKey: 'station:0',
      toKey: 'settlement:1', progress: 0.4,
    },
  });
  away.itineraryId = 'itinerary:newer';
  away.inTransit = true;
  const location = structuredClone(away.location);

  const removed = at(state, 12.1, [], first.snapshot);
  assert.ok(removed.conflictedIds.includes(awayId));
  assert.ok(!removed.releasedIds.includes(awayId));
  assert.deepEqual(away.location, location);
  assert.equal(away.itineraryId, 'itinerary:newer');
});

test('station and resident context order cannot affect deterministic output', () => {
  const left = fixture({ stations: 2 });
  const right = fixture({ stations: 2 });
  const forward = at(left.state, 13.2, left.contexts);
  const reversedContexts = [...right.contexts].reverse().map((context) => ({
    ...context,
    residentIds: [...context.residentIds].reverse(),
  }));
  const reversed = at(right.state, 13.2, reversedContexts);
  assert.deepEqual(reversed.rosters, forward.rosters);
  assert.deepEqual(reversed.changedIds, forward.changedIds);
  assert.deepEqual(reversed.snapshot, forward.snapshot);
  assert.deepEqual(right.state.entities, left.state.entities);
});

test('snapshot is immutable, JSON-safe, and restores without roster churn', () => {
  const { state, contexts } = fixture();
  const first = at(state, 15.25, contexts);
  assert.equal(first.snapshot.version, STATION_DUTY_REFRESH_SNAPSHOT_VERSION);
  assert.equal(Object.isFrozen(first.snapshot), true);
  assert.equal(Object.isFrozen(first.snapshot.contexts), true);
  assert.equal(Object.isFrozen(first.snapshot.rosters[0].assignments), true);
  const restored = restoreStationDutyRefreshSnapshot(
    JSON.parse(JSON.stringify(first.snapshot)),
  );
  assert.deepEqual(restored, first.snapshot);
  const revision = state.revision;
  const second = at(state, 15.4, contexts, restored);
  assert.equal(second.refreshed, false);
  assert.equal(state.revision, revision);

  const tampered = JSON.parse(JSON.stringify(first.snapshot));
  tampered.rosters[0].assignments[0].location.stationId = 'station:other';
  const rejected = restoreStationDutyRefreshSnapshot(tampered);
  assert.equal(rejected.dayIndex, null);
  assert.deepEqual(rejected.rosters, []);
});

test('disabled feature is a fail-closed no-op and publishes no rosters', () => {
  const { state, contexts } = fixture({ enabled: false });
  state.clock.worldHours = 12;
  const before = structuredClone(state);
  const result = refreshStationDutyRosters({ state, contexts });
  assert.equal(result.enabled, false);
  assert.equal(result.refreshed, false);
  assert.equal(result.applied, false);
  assert.deepEqual(result.rosters, {});
  assert.deepEqual(result.changedIds, []);
  assert.deepEqual(state, before);
});

test('context changes replan inside a bucket while preserving genuine shortages', () => {
  const { state, contexts } = fixture();
  const first = at(state, 11.1, contexts);
  const restricted = [{ ...contexts[0], residentIds: [contexts[0].residentIds[0]] }];
  const second = at(state, 11.2, restricted, first.snapshot);
  assert.equal(second.refreshed, true);
  const roster = second.rosters['station:0'];
  assert.equal(roster.assignments.length, 1);
  assert.equal(roster.shortage, roster.target - 1);
});

test('refresh coordinator stays independent of rendering and nondeterminism', async () => {
  const source = await readFile(new URL('../src/npcstationdutyrefresh.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]three|import\s+\*\s+as\s+THREE/);
  assert.doesNotMatch(source, /Math\.random\s*\(/);
  assert.doesNotMatch(source, /requestAnimationFrame|setInterval|setTimeout/);
});
