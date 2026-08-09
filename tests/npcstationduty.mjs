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
  applyStationDutyRoster,
  planStationDutyRoster,
  STATION_DUTY_SLOTS,
} from '../src/npcstationduty.mjs';
import { createSettlementResidentIdentity } from '../src/npcresidentidentity.mjs';

const SETTLEMENT_ID = 'settlement:willow';
const STATION_ID = 'station:willow';

function stateWithResidents(count = 8, { enabled = true } = {}) {
  const state = createLivingWorldState({ worldSeed: 208 });
  if (enabled) setLivingWorldFeatures(state, { unifiedNpcMobilityEnabled: true });
  const ids = [];
  for (let index = 0; index < count; index++) {
    const id = `npc:willow:${index}`;
    const householdId = `household:willow:${Math.floor(index / 2)}`;
    const homeBuildingId = `building:willow:${Math.floor(index / 2)}`;
    registerLivingWorldEntity(state, {
      id, kind: 'npc', name: `Resident ${index}`, role: index % 2 ? 'baker' : 'weaver',
      householdId, workplaceId: `workplace:willow:${index % 3}`,
    });
    attachNpcSpatialState(state, id, {
      residence: {
        originSettlementId: SETTLEMENT_ID,
        residenceSettlementId: SETTLEMENT_ID,
        householdId,
        homeBuildingId,
      },
      location: { kind: 'building', settlementId: SETTLEMENT_ID, buildingId: homeBuildingId },
    });
    ids.push(id);
  }
  return { state, ids };
}

function plan(state, residents, options = {}) {
  return planStationDutyRoster({
    state,
    stationId: STATION_ID,
    settlementId: SETTLEMENT_ID,
    residents,
    worldSeed: state.worldSeed,
    dayIndex: 4,
    hour: 12,
    ...options,
  });
}

test('daytime roster assigns two to four unique real residents to semantic non-traveller slots', () => {
  const { state, ids } = stateWithResidents();
  const beforeIds = Object.keys(state.entities).sort();
  const roster = plan(state, ids);
  assert.ok(roster.target >= 2 && roster.target <= 4);
  assert.equal(roster.assignments.length, roster.target);
  assert.equal(new Set(roster.assignments.map((assignment) => assignment.personId)).size,
    roster.assignments.length);
  assert.deepEqual(roster.assignments.map((assignment) => assignment.slotKey),
    STATION_DUTY_SLOTS.slice(0, roster.target).map((slot) => slot.slotKey));
  assert.ok(roster.assignments.every((assignment) => ids.includes(assignment.personId)));
  assert.ok(roster.assignments.every((assignment) => assignment.slotKey !== 'traveller'));
  assert.deepEqual(Object.keys(state.entities).sort(), beforeIds, 'planning must never create IDs');
});

test('selection is stable under shuffled and duplicated resident input', () => {
  const { state, ids } = stateWithResidents();
  const forward = plan(state, ids);
  const shuffled = plan(state, [ids[4], ids[1], ids[7], ids[0], ids[4], ...ids.slice(2, 7).reverse()]);
  assert.deepEqual(shuffled, forward);
});

test('a resident shortage stays a shortage and away or committed residents are not pulled home', () => {
  const { state, ids } = stateWithResidents(4);
  state.entities[ids[1]].itineraryId = 'itinerary:active';
  attachNpcSpatialState(state, ids[2], {
    residence: state.entities[ids[2]].residence,
    location: {
      kind: 'regional-edge', edgeId: 'edge:1', fromKey: 'a', toKey: 'b', progress: 0.4,
    },
  });
  state.commitments['commitment:active'] = {
    id: 'commitment:active', actorId: ids[3], state: 'active',
  };
  const roster = plan(state, ids);
  assert.equal(roster.assignments.length, 1);
  assert.equal(roster.shortage, Math.max(0, roster.target - 1));
  assert.equal(roster.assignments[0].personId, ids[0]);
});

test('night demand is allowed to fall to zero or one resident', () => {
  const { state, ids } = stateWithResidents();
  const roster = plan(state, ids, { hour: 2 });
  assert.ok(roster.target >= 0 && roster.target <= 1);
  assert.equal(roster.assignments.length, roster.target);
});

test('application publishes canonical platform duty without changing residence or occupation', () => {
  const { state, ids } = stateWithResidents();
  const roster = plan(state, ids);
  const before = Object.fromEntries(roster.assignments.map(({ personId }) => {
    const entity = state.entities[personId];
    return [personId, {
      residence: structuredClone(entity.residence),
      householdId: entity.householdId,
      workplaceId: entity.workplaceId,
      role: entity.role,
    }];
  }));
  const result = applyStationDutyRoster(state, roster);
  assert.equal(result.applied, true);
  assert.deepEqual(result.releasedIds, []);
  assert.deepEqual(result.conflictedIds, []);
  assert.deepEqual([...result.changedIds].sort(), roster.assignments.map((entry) => entry.personId).sort());
  for (const assignment of roster.assignments) {
    const entity = state.entities[assignment.personId];
    assert.deepEqual(entity.activity, {
      kind: 'station-duty', stationId: STATION_ID,
      slotKey: assignment.slotKey, role: assignment.role,
    });
    assert.deepEqual(entity.location, {
      kind: 'station-platform', stationId: STATION_ID,
      platformId: `${STATION_ID}:platform:main`,
      waitAnchorId: `${STATION_ID}:wait:${assignment.slotKey}`,
    });
    assert.deepEqual(entity.residence, before[entity.id].residence);
    assert.equal(entity.householdId, before[entity.id].householdId);
    assert.equal(entity.workplaceId, before[entity.id].workplaceId);
    assert.equal(entity.role, before[entity.id].role);
  }
});

test('station adoption retains the resident visual identity used at home', () => {
  const { state, ids } = stateWithResidents();
  const roster = plan(state, ids);
  const actorId = roster.assignments[0].personId;
  const entity = state.entities[actorId];
  const household = state.households?.[entity.householdId];
  // The fixture creates canonical entity links directly, so supply the same
  // deterministic member index both renderers use even without full plans.
  const identityInput = {
    entity,
    state,
    worldSeed: state.worldSeed,
    homeBuildingId: entity.residence.homeBuildingId,
    householdIndex: Math.max(0, household?.memberIds?.indexOf(actorId) ?? Number(actorId.split(':').at(-1)) % 2),
  };
  const atHome = createSettlementResidentIdentity(identityInput);
  applyStationDutyRoster(state, roster);
  const atStation = createSettlementResidentIdentity(identityInput);
  for (const field of ['id', 'seed', 'name', 'family', 'palette', 'proportions', 'appearance']) {
    assert.deepEqual(atStation[field], atHome[field], `${field} must survive presentation handoff`);
  }
});

test('application is exact-once and requires only the unified mobility gate', () => {
  const { state, ids } = stateWithResidents();
  assert.equal(state.features.npcRailTravelEnabled, false);
  assert.equal(state.features.npcLeisureTravelEnabled, false);
  const roster = plan(state, ids);
  applyStationDutyRoster(state, roster);
  const revision = state.revision;
  const second = applyStationDutyRoster(state, roster);
  assert.equal(second.applied, false);
  assert.deepEqual(second.changedIds, []);
  assert.deepEqual([...second.unchangedIds].sort(), roster.assignments.map((entry) => entry.personId).sort());
  assert.equal(state.revision, revision);

  const disabled = stateWithResidents(5, { enabled: false });
  const disabledRoster = plan(disabled.state, disabled.ids);
  const before = structuredClone(disabled.state);
  assert.throws(() => applyStationDutyRoster(disabled.state, disabledRoster), /mobility is disabled/);
  assert.deepEqual(disabled.state, before);
});

test('replanning a smaller roster releases prior duty residents to their own homes', () => {
  const { state, ids } = stateWithResidents();
  const daytime = plan(state, ids, { hour: 12 });
  applyStationDutyRoster(state, daytime);
  const night = plan(state, ids, { hour: 2 });
  const selected = new Set(night.assignments.map((assignment) => assignment.personId));
  const result = applyStationDutyRoster(state, night);
  const expectedReleased = daytime.assignments
    .map((assignment) => assignment.personId)
    .filter((id) => !selected.has(id))
    .sort();
  assert.deepEqual([...result.releasedIds].sort(), expectedReleased);
  for (const id of expectedReleased) {
    const entity = state.entities[id];
    assert.deepEqual(entity.location, {
      kind: 'building',
      settlementId: SETTLEMENT_ID,
      buildingId: entity.residence.homeBuildingId,
      nodeId: null,
    });
    assert.equal(entity.activity, null);
  }
});

test('stale duty activity never teleports a newer canonical traveller home', () => {
  const { state, ids } = stateWithResidents();
  const daytime = plan(state, ids, { hour: 12 });
  applyStationDutyRoster(state, daytime);
  const awayId = daytime.assignments[0].personId;
  const away = state.entities[awayId];
  attachNpcSpatialState(state, awayId, {
    residence: away.residence,
    location: {
      kind: 'regional-edge', edgeId: 'edge:willow:station-road',
      fromKey: STATION_ID, toKey: 'trail:willow:1', progress: 0.35,
    },
  });
  away.inTransit = true;
  away.itineraryId = 'itinerary:willow:active';
  const beforeLocation = structuredClone(away.location);
  const result = applyStationDutyRoster(state, {
    stationId: STATION_ID,
    settlementId: SETTLEMENT_ID,
    assignments: [],
  });
  assert.deepEqual(result.conflictedIds, [awayId]);
  assert.ok(!result.releasedIds.includes(awayId));
  assert.deepEqual(away.location, beforeLocation);
  assert.equal(away.itineraryId, 'itinerary:willow:active');
  assert.equal(away.activity.kind, 'station-duty',
    'the stale projection is left for the authoritative itinerary transition to replace');
});

test('malformed or synthetic assignments fail atomically', () => {
  const { state, ids } = stateWithResidents();
  const roster = plan(state, ids);
  const corrupt = structuredClone(roster);
  corrupt.assignments[0].personId = 'npc:synthetic';
  const before = structuredClone(state);
  assert.throws(() => applyStationDutyRoster(state, corrupt), /not an eligible canonical resident/);
  assert.deepEqual(state, before);
});

test('station duty module stays pure of renderer and nondeterministic dependencies', async () => {
  const source = await readFile(new URL('../src/npcstationduty.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]three|import\s+\*\s+as\s+THREE/);
  assert.doesNotMatch(source, /Math\.random\s*\(/);
  assert.doesNotMatch(source, /registerLivingWorldEntity/);
});
