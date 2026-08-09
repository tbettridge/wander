import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivingWorldState } from '../src/livingworldstate.mjs';
import {
  completeItineraryLeg,
  createItinerary,
  currentItineraryLeg,
  itinerarySnapshot,
  ITINERARY_LEG_KIND,
  startItineraryLeg,
} from '../src/npcitinerary.mjs';
import {
  applyNpcMigration,
  migrationCohortBucket,
  NPC_MIGRATION_RATE_DENOMINATOR,
  planNpcMigration,
} from '../src/npcmigration.mjs';

const ORIGIN = 'settlement:elm';
const DESTINATION = 'settlement:ash';

function actorInCohort(eligible) {
  for (let index = 0; index < 1000; index++) {
    const actorId = `npc:elm:${index}`;
    const itineraryId = `itinerary:${actorId}:ash`;
    if ((migrationCohortBucket({ worldSeed: 44, actorId, itineraryId }) === 0) === eligible) {
      return { actorId, itineraryId };
    }
  }
  throw new Error('Expected deterministic migration cohort was not found.');
}

function completedSnapshot(actorId, itineraryId, residence, purpose = 'visit') {
  const itinerary = createItinerary({
    id: itineraryId,
    actorId,
    residence,
    origin: { kind: 'building', key: residence.homeBuildingId },
    destination: { kind: 'settlement', key: DESTINATION },
    activity: { kind: purpose },
    outboundLegs: [{ id: 'out', kind: ITINERARY_LEG_KIND.regionalWalk }],
    returnLegs: [{ id: 'back', kind: ITINERARY_LEG_KIND.regionalWalk }],
  });
  while (currentItineraryLeg(itinerary)) {
    const leg = currentItineraryLeg(itinerary);
    startItineraryLeg(itinerary, leg.id);
    completeItineraryLeg(itinerary, leg.id);
  }
  return itinerarySnapshot(itinerary);
}

function scenario({ enabled = true, eligible = true, destinationCount = 0, capacity = 3 } = {}) {
  const { actorId, itineraryId } = actorInCohort(eligible);
  const state = createLivingWorldState({ worldSeed: 44 });
  state.features.unifiedNpcMobilityEnabled = true;
  state.features.npcMigrationEnabled = enabled;
  const sourceHouseholdId = 'household:elm';
  const residence = {
    originSettlementId: ORIGIN,
    residenceSettlementId: ORIGIN,
    householdId: sourceHouseholdId,
    homeBuildingId: 'building:elm:home',
  };
  state.entities[actorId] = {
    id: actorId,
    kind: 'npc',
    name: 'Ada Elm',
    householdId: sourceHouseholdId,
    homeKey: residence.homeBuildingId,
    residence: { ...residence },
    location: {
      kind: 'building', settlementId: ORIGIN, buildingId: residence.homeBuildingId,
    },
    itineraryId: null,
    inTransit: false,
  };
  state.households[sourceHouseholdId] = {
    id: sourceHouseholdId,
    homeBuildingId: residence.homeBuildingId,
    memberIds: [actorId],
    access: { members: [actorId] },
  };
  const destinationHouseholdId = 'household:ash:a';
  state.households[destinationHouseholdId] = {
    id: destinationHouseholdId,
    homeBuildingId: 'building:ash:a',
    memberIds: Array.from({ length: destinationCount }, (_, index) => `npc:ash:${index}`),
    access: { members: Array.from({ length: destinationCount }, (_, index) => `npc:ash:${index}`) },
  };
  state.itineraries[itineraryId] = completedSnapshot(actorId, itineraryId, residence);
  const candidate = {
    settlementId: DESTINATION,
    householdId: destinationHouseholdId,
    homeBuildingId: 'building:ash:a',
    capacity,
  };
  return { state, actorId, itineraryId, candidate, residence };
}

function plan(input) {
  return planNpcMigration({
    state: input.state,
    actorId: input.actorId,
    itineraryId: input.itineraryId,
    destinationCandidates: [input.candidate],
  });
}

test('migration is off by default and the rare cohort is bounded to one of 64 buckets', () => {
  const disabled = scenario({ enabled: false });
  assert.equal(plan(disabled).reason, 'feature-disabled');
  assert.equal(NPC_MIGRATION_RATE_DENOMINATOR, 64);

  const rare = scenario({ eligible: true });
  const common = scenario({ eligible: false });
  assert.equal(plan(rare).eligible, true);
  assert.equal(plan(rare).bucket, 0);
  assert.equal(plan(common).eligible, false);
  assert.equal(plan(common).reason, 'common-cohort');
});

test('only a successfully completed visit, quest, or leisure itinerary qualifies', () => {
  const input = scenario();
  const completed = input.state.itineraries[input.itineraryId];
  completed.s = 'active';
  completed.i = 0;
  completed.l[0][3] = 'active';
  assert.equal(plan(input).reason, 'travel-not-completed');

  delete input.state.itineraries[input.itineraryId];
  assert.equal(plan(input).reason, 'travel-not-completed');
});

test('application atomically transfers household and residence while preserving origin', () => {
  const input = scenario();
  const proposal = plan(input);
  const result = applyNpcMigration(input.state, proposal);
  const entity = input.state.entities[input.actorId];

  assert.equal(result.applied, true);
  assert.equal(entity.residence.originSettlementId, ORIGIN);
  assert.equal(entity.residence.residenceSettlementId, DESTINATION);
  assert.equal(entity.residence.householdId, input.candidate.householdId);
  assert.equal(entity.householdId, input.candidate.householdId);
  assert.equal(entity.homeKey, input.candidate.homeBuildingId);
  assert.deepEqual(entity.location, {
    kind: 'building', settlementId: DESTINATION, buildingId: input.candidate.homeBuildingId,
    nodeId: null,
  });
  assert.deepEqual(input.state.households['household:elm'].memberIds, []);
  assert.deepEqual(input.state.households['household:elm'].access.members, []);
  assert.deepEqual(input.state.households[input.candidate.householdId].memberIds, [input.actorId]);
  assert.deepEqual(input.state.households[input.candidate.householdId].access.members, [input.actorId]);
  assert.equal(input.state.events.filter((event) => event.type === 'npc.migrated').length, 1);
});

test('the migration receipt makes retries exact-once', () => {
  const input = scenario();
  const proposal = plan(input);
  const first = applyNpcMigration(input.state, proposal);
  const revision = input.state.revision;
  const second = applyNpcMigration(input.state, proposal);

  assert.equal(first.applied, true);
  assert.deepEqual(second, { applied: false, exactOnce: true, receipt: first.receipt });
  assert.equal(input.state.revision, revision);
  assert.equal(input.state.events.length, 1);
  assert.equal(input.state.households[input.candidate.householdId].memberIds.length, 1);
});

test('invalid, full, same-settlement, or invented homes never become proposals', () => {
  const full = scenario({ destinationCount: 2, capacity: 2 });
  assert.equal(plan(full).reason, 'no-available-home');

  const invalid = scenario();
  invalid.candidate.homeBuildingId = 'building:invented';
  assert.equal(plan(invalid).reason, 'no-available-home');

  const same = scenario();
  same.candidate = {
    settlementId: ORIGIN,
    householdId: 'household:elm',
    homeBuildingId: 'building:elm:home',
    capacity: 3,
  };
  assert.equal(plan(same).reason, 'no-available-home');
});

test('a destination that fills after planning is rejected without partial mutation', () => {
  const input = scenario({ capacity: 1 });
  const proposal = plan(input);
  input.state.households[input.candidate.householdId].memberIds.push('npc:ash:late-arrival');
  const before = structuredClone(input.state);

  assert.throws(() => applyNpcMigration(input.state, proposal), /invalid or full/);
  assert.deepEqual(input.state, before);
});

test('active itinerary, transit, commitment, and away location block migration', () => {
  for (const mutate of [
    (input) => { input.state.entities[input.actorId].itineraryId = input.itineraryId; },
    (input) => { input.state.entities[input.actorId].inTransit = true; },
    (input) => { input.state.commitments.active = { actorId: input.actorId, state: 'active' }; },
  ]) {
    const input = scenario();
    mutate(input);
    assert.equal(plan(input).reason, 'actor-busy');
  }
  const away = scenario();
  away.state.entities[away.actorId].location = {
    kind: 'settlement-node', settlementId: ORIGIN, nodeId: 'street:market',
  };
  assert.equal(plan(away).reason, 'actor-away');
});

test('candidate selection is deterministic and independent of input order', () => {
  const input = scenario();
  input.state.households['household:ash:b'] = {
    id: 'household:ash:b', homeBuildingId: 'building:ash:b', memberIds: [],
  };
  const other = {
    settlementId: DESTINATION,
    householdId: 'household:ash:b',
    homeBuildingId: 'building:ash:b',
    capacity: 2,
  };
  const forward = planNpcMigration({
    state: input.state, actorId: input.actorId, itineraryId: input.itineraryId,
    destinationCandidates: [input.candidate, other],
  });
  const reverse = planNpcMigration({
    state: input.state, actorId: input.actorId, itineraryId: input.itineraryId,
    destinationCandidates: [other, input.candidate],
  });
  assert.deepEqual(reverse, forward);
});

test('plans and receipts are frozen JSON-roundtrippable snapshots', () => {
  const input = scenario();
  const proposal = plan(input);
  assert.equal(Object.isFrozen(proposal), true);
  assert.equal(Object.isFrozen(proposal.destination), true);
  assert.deepEqual(JSON.parse(JSON.stringify(proposal)), proposal);
  const result = applyNpcMigration(input.state, proposal);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
