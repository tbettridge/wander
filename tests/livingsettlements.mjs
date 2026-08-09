import test from 'node:test';
import assert from 'node:assert/strict';
import { settlementForCell, settlementsAround, nearestSettlement } from '../src/settlementplacement.mjs';
import { createSettlementPlan } from '../src/settlementplan.mjs';
import { validateBuildingPlan } from '../src/buildingplan.mjs';
import { buildSettlementLocationGraph, compressRoutePlan, routeLocations } from '../src/locationgraph.mjs';
import { advancePortals, crossPortal, ensurePortalState, requestPortal } from '../src/portalstate.mjs';
import { canEnterHouseholdRoom, deriveResidentIdentityContext, generateHouseholds } from '../src/npchousehold.mjs';
import { advanceWorkRoutines, assignWorkplacesAndRoutines } from '../src/npcroutine.mjs';
import { createLivingWorldState, normalizeLivingWorldState, parseLivingWorldState, serializeLivingWorldState } from '../src/livingworldstate.mjs';
import { advanceSettlementEvolution, recordSettlementPressure } from '../src/settlementevolution.mjs';
import { validateSettlementExitGates } from '../src/settlementquality.mjs';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import { buildingDisplayName, surnamePoolForRegion, SURNAME_REGION_SIZE } from '../src/settlementnames.mjs';
import { buildStationDialogueContext } from '../src/livingworldcontext.mjs';

const world = {
  seed: 77,
  height(x, z) { return 18 + Math.sin(x * 0.0003) + Math.cos(z * 0.0002); },
  biomeAt(x, z) { return { h: this.height(x, z), slope: 0.04, m: 0.58, id: 'grassland' }; },
  riverAt() { return { wet: false }; },
};

function firstSite() {
  for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
    const site = settlementForCell(world, i, j, world.seed); if (site) return site;
  }
  throw new Error('test corpus produced no settlement');
}

test('phase 1 placement is stable, bounded, queryable, and exposes a trail entrance', () => {
  const site = firstSite();
  assert.deepEqual(settlementForCell(world, ...site.id.split(':').slice(1).map(Number), world.seed), site);
  assert.ok(['farmstead', 'hamlet', 'village', 'town'].includes(site.kind));
  assert.ok(site.regionalEntrance.key.endsWith(':entrance'));
  assert.ok(settlementsAround(world, site.x, site.z, world.seed, 100, []).some((entry) => entry.id === site.id));
  assert.equal(nearestSettlement(world, site.x, site.z, world.seed).id, site.id);
});

test('phases 2-3 generate varied valid buildings, functional portals, floors, and layered routes', () => {
  const site = firstSite(), plan = createSettlementPlan(site, { heightAt: world.height.bind(world) });
  assert.ok(plan.buildings.length >= 2);
  for (const building of plan.buildings) assert.equal(validateBuildingPlan(building).valid, true);
  const graph = buildSettlementLocationGraph(plan), building = plan.buildings[0];
  const route = routeLocations(graph, site.regionalEntrance.key, building.rooms[0].id);
  assert.ok(route?.steps.some((step) => step.kind === 'portal'));
  assert.equal(compressRoutePlan(route).portalCount >= 1, true);
  const state = createLivingWorldState(), portal = building.portals[0];
  ensurePortalState(state, portal); assert.equal(requestPortal(state, portal, 'npc:a').accepted, true);
  advancePortals(state, 1); assert.equal(state.portals[portal.id].open, true);
  assert.equal(crossPortal(state, portal.id, 'npc:a', `${building.id}:outside`, portal.to.key).crossed, true);
  const surface = new WalkableSurface(world); plan.claims.forEach((claim) => surface.registerClaim(claim));
  assert.ok(surface.heightAt(building.x, building.z, building.y + 1) > building.y);
});

test('phases 4-5 create canonical households, privacy, commutes, and exact-once work outcomes', () => {
  const site = firstSite(), plan = createSettlementPlan(site), state = createLivingWorldState();
  const households = generateHouseholds(plan, state);
  assert.ok(households.length > 0);
  const household = households[0], privateRoom = household.privateRoomIds[0];
  if (privateRoom) {
    assert.equal(canEnterHouseholdRoom(state, household.memberIds[0], privateRoom), true);
    assert.equal(canEnterHouseholdRoom(state, 'player', privateRoom), false);
  }
  const routines = assignWorkplacesAndRoutines(plan, state);
  assert.ok(routines.length > 0);
  advanceWorkRoutines(state, 10);
  const outcomeHour = 24 + 20;
  advanceWorkRoutines(state, outcomeHour); advanceWorkRoutines(state, outcomeHour);
  assert.equal(state.metrics.routineOutcomes, routines.length);
  assert.equal(Object.values(state.workplaces).reduce((n, w) => n + (w.completedShifts || 0), 0), routines.length);
});

test('surname pools are stable within a region and distinct across regions', () => {
  const first = surnamePoolForRegion(world.seed, 120, 900);
  assert.deepEqual(surnamePoolForRegion(world.seed, 120, 900), first);
  assert.deepEqual(surnamePoolForRegion(world.seed, SURNAME_REGION_SIZE - 1, 900), first);
  assert.notDeepEqual(surnamePoolForRegion(world.seed, SURNAME_REGION_SIZE + 1, 900), first);
});

test('family-owned buildings agree with household surnames, workers, and display names', () => {
  let plan = null;
  for (let j = -8; j <= 8 && !plan; j++) for (let i = -8; i <= 8 && !plan; i++) {
    const site = settlementForCell(world, i, j, world.seed); if (!site) continue;
    const candidate = createSettlementPlan(site);
    if (candidate.buildings.some((building) => building.ownerHouseholdId && building.program !== 'dwelling')) plan = candidate;
  }
  assert.ok(plan, 'test corpus produced no family business');
  const state = createLivingWorldState(); generateHouseholds(plan, state);
  assignWorkplacesAndRoutines(plan, state);
  for (const building of plan.buildings.filter((entry) => entry.ownerHouseholdId)) {
    const household = state.households[building.ownerHouseholdId];
    assert.equal(household.surname, building.ownerSurname);
    assert.equal(building.displayName, `${building.ownerSurname}\u2019s`);
    assert.equal(buildingDisplayName(building), building.displayName);
    if (building.program !== 'dwelling') {
      const workers = household.memberIds.map((id) => state.entities[id])
        .filter((actor) => actor.workplaceId === building.id);
      assert.ok(workers.length > 0, `${building.displayName} has no worker from its owning household`);
      if (building.program === 'smithy') assert.ok(workers.some((actor) => actor.role === 'smith'));
    }
  }
  const civic = plan.buildings.find((entry) => !entry.ownerHouseholdId);
  if (civic) assert.equal(civic.displayName, buildingDisplayName(civic));
});

test('phases 6-7 migrate v3, persist only mutable state, evolve exactly once, and pass automated gates', () => {
  const site = firstSite(), plan = createSettlementPlan(site), state = normalizeLivingWorldState({ version: 3, worldSeed: 9, entities: {} });
  assert.equal(state.version, 5); assert.equal(state.features.largeSettlementsEnabled, true);
  recordSettlementPressure(state, site.id, { prosperity: 3 });
  advanceSettlementEvolution(state, 24 * 31); advanceSettlementEvolution(state, 24 * 31);
  assert.equal(state.settlementDeltas[site.id].addedBuildings.length, 1);
  const serialized = serializeLivingWorldState(state), restored = parseLivingWorldState(serialized);
  assert.ok(serialized.includes('compact-v5')); assert.equal(restored.settlementDeltas[site.id].addedBuildings.length, 1);
  assert.equal(serialized.includes(plan.buildings[0].materials.wall), false);
  const gates = validateSettlementExitGates({ summaries: [site], plans: [plan], state: restored, simulationSamples: [0.1, 0.2] });
  assert.equal(gates.passed, true, gates.failures.join(', '));
});

test('household and workplace identity survives compact saves while untouched portals do not', () => {
  const site = firstSite(), plan = createSettlementPlan(site), state = createLivingWorldState();
  generateHouseholds(plan, state); assignWorkplacesAndRoutines(plan, state);
  const actor = Object.values(state.entities).find((entity) => entity.householdId);
  const portal = plan.buildings[0].portals[0]; ensurePortalState(state, portal);
  const serialized = serializeLivingWorldState(state), restored = parseLivingWorldState(serialized);
  assert.equal(restored.entities[actor.id].householdId, actor.householdId);
  assert.equal(restored.entities[actor.id].workplaceId, actor.workplaceId);
  assert.equal(restored.portals[portal.id], undefined);
});

test('legacy households reconcile derived identity and routine links without resetting mutable state', () => {
  const site = firstSite(), plan = createSettlementPlan(site), state = createLivingWorldState();
  generateHouseholds(plan, state); assignWorkplacesAndRoutines(plan, state);
  const actor = Object.values(state.entities).find((entity) => entity.householdId);
  const household = state.households[actor.householdId];
  const routine = state.routines[`routine:${actor.id}:work`];
  const workplace = state.workplaces[routine.workplaceId];
  const access = { public: true, guests: 'trusted', members: ['visitor:trusted'] };
  household.surname = 'Oldname'; household.homeBuildingId = 'legacy:home'; household.access = access;
  actor.name = 'Ada Oldname'; delete actor.surname; actor.homeKey = 'legacy:home'; actor.workplaceId = 'legacy:work'; delete actor.workplaceName;
  workplace.ownerHouseholdId = 'legacy:owner'; workplace.displayName = 'Old Shop';
  workplace.inventory.repairs = 41; workplace.completedShifts = 9;
  routine.homeKey = 'legacy:home'; routine.workplaceId = 'legacy:work'; routine.destinationKey = 'legacy:room';
  routine.lastOccurrenceKey = 'legacy:day:4'; routine.state = 'working';
  state.memories[actor.id] = [{ id: 'memory:legacy', ownerId: actor.id, summary: 'A retained memory.' }];
  state.relationships['legacy:relationship'] = { ownerId: actor.id, subjectId: 'npc:other', familiarity: 0.91 };

  const serialized = serializeLivingWorldState(state);
  const compact = JSON.parse(serialized);
  const entityTuple = compact.entities[actor.id];
  assert.equal(entityTuple.some((value) => typeof value === 'string' && value.includes('Oldname')), true, 'the full name may retain the old surname before reconciliation');
  assert.equal(Object.hasOwn(entityTuple, 'surname'), false);
  assert.equal(Object.hasOwn(entityTuple, 'workplaceName'), false);

  const restored = parseLivingWorldState(serialized);
  generateHouseholds(plan, restored); assignWorkplacesAndRoutines(plan, restored);
  const reconciled = restored.entities[actor.id];
  const reconciledHousehold = restored.households[actor.householdId];
  const reconciledRoutine = restored.routines[`routine:${actor.id}:work`];
  const reconciledWorkplace = restored.workplaces[reconciledRoutine.workplaceId];
  assert.equal(reconciledHousehold.surname, plan.buildings.find((building) => building.id === reconciledHousehold.homeBuildingId).ownerSurname);
  assert.equal(reconciled.homeKey, reconciledHousehold.homeBuildingId);
  assert.equal(reconciled.householdId, reconciledHousehold.id);
  assert.equal(reconciled.surname, reconciledHousehold.surname);
  assert.match(reconciled.name, new RegExp(`${reconciledHousehold.surname}$`));
  assert.deepEqual(reconciledHousehold.access, access);
  assert.equal(restored.memories[actor.id][0].id, 'memory:legacy');
  assert.equal(restored.relationships['legacy:relationship'].familiarity, 0.91);
  assert.equal(reconciledWorkplace.inventory.repairs, 41);
  assert.equal(reconciledWorkplace.completedShifts, 9);
  assert.equal(reconciledRoutine.lastOccurrenceKey, 'legacy:day:4');
  assert.equal(reconciledRoutine.state, 'working');
  assert.equal(reconciledRoutine.homeKey, reconciled.homeKey);
  assert.equal(reconciledRoutine.destinationKey, plan.buildings.find((building) => building.id === reconciledRoutine.workplaceId).rooms[0].id);
  assert.equal(reconciled.workplaceId, reconciledWorkplace.id);
  assert.equal(reconciled.workplaceName, reconciledWorkplace.displayName);

  const identityContext = deriveResidentIdentityContext(reconciled, restored);
  assert.equal(identityContext.surname, reconciledHousehold.surname);
  assert.equal(identityContext.workplaceName, reconciledWorkplace.displayName);
  const dialogueContext = buildStationDialogueContext({
    world, station: { id: 'fixture-station', index: 0, name: 'Fixture Halt', x: 0, z: 0, biome: 'grassland' },
    player: { x: 0, z: 0 }, sky: { time: 0.3 }, weather: { current: { archetype: 'clear', solarPhase: 'morning' } },
    npc: { id: reconciled.id, name: reconciled.name, role: reconciled.role, family: 'storybook', ...identityContext },
  });
  assert.equal(dialogueContext.npc.surname, reconciledHousehold.surname);
  assert.equal(dialogueContext.npc.workplace, reconciledWorkplace.displayName);
});

test('settlement feature dependency flags provide clean rollback', () => {
  const state = normalizeLivingWorldState({ features: { settlementsEnabled: false } });
  for (const key of ['enterableBuildingsEnabled', 'householdsEnabled', 'workRoutinesEnabled', 'largeSettlementsEnabled', 'settlementEvolutionEnabled']) assert.equal(state.features[key], false);
});
