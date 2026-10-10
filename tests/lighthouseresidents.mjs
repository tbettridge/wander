import test from 'node:test';
import assert from 'node:assert/strict';
import { createLighthousePlan, lighthouseWalkableClaims, lighthouseCollisionSegments } from '../src/lighthouseplan.mjs';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import { StructureCollisionIndex } from '../src/structurecollision.mjs';
import { lighthouseResidentPlan } from '../src/lighthouseresidents.mjs';
import { createLivingWorldState } from '../src/livingworldstate.mjs';
import { activateSettlementResidents } from '../src/npcresidenceregistry.mjs';
import { createSettlementResidentIdentity } from '../src/npcresidentidentity.mjs';
import { buildNpcCommunityContext } from '../src/npccommunitycontext.mjs';
import { NpcMemoryStore } from '../src/npcmemory.mjs';
import { NpcLiveEncounterBridge } from '../src/npcliveencounter.mjs';

const planFor = seed => lighthouseResidentPlan(createLighthousePlan({ key: `lighthouse:${seed}`,
  seed, x: 120, y: 5, z: -240, yaw: .8 }, () => 0));
const stateFor = () => createLivingWorldState({ worldSeed: 23, playerId: 'player:one' });

test('lighthouses deterministically include lone keepers, spouses and one or two children', () => {
  const counts = new Set();
  for (let seed = 1; seed <= 150; seed++) {
    const plan = planFor(seed), state = stateFor(), population = activateSettlementResidents(plan, state);
    assert.deepEqual(planFor(seed), plan);
    assert.equal(population.householdCount, 1);
    const household = state.households[plan.buildings[0].ownerHouseholdId];
    counts.add(household.memberIds.length);
    household.memberIds.forEach((id, index) => {
      const identity = createSettlementResidentIdentity({ entity: state.entities[id], state });
      assert.equal(identity.id, id);
      assert.equal(identity.age, index >= 2 ? 'child' : 'adult');
      assert.equal(identity.interactive, true);
      assert.equal(state.entities[id].residence.homeBuildingId, plan.buildings[0].id);
      assert.equal(state.entities[id].residence.residenceSettlementId, plan.site.id);
      assert.equal(identity.role, index === 0 ? 'lighthouse keeper' : index === 1 ? 'keeper’s spouse' : 'keeper’s child');
    });
    if (household.memberIds.length > 1) {
      const [keeper, spouse, child, sibling] = household.memberIds;
      assert.ok(state.relationships[`${keeper}->${spouse}`].tags.includes('spouse'));
      if (child) {
        assert.deepEqual(state.relationships[`${keeper}->${child}`].tags, ['family', 'child']);
        assert.deepEqual(state.relationships[`${child}->${spouse}`].tags, ['family', 'parent']);
      }
      if (sibling) assert.deepEqual(state.relationships[`${child}->${sibling}`].tags, ['family', 'sibling']);
    }
  }
  assert.deepEqual([...counts].sort(), [1, 2, 3, 4]);
});

test('keeper conversation context names their actual spouse, children and shared house', () => {
  const plan = Array.from({ length: 30 }, (_, i) => planFor(i + 1)).find(p => p.buildings[0].householdTemplate.count === 4);
  const state = stateFor(), population = activateSettlementResidents(plan, state);
  const keeper = population.residentIds.find(id => state.entities[id].role === 'lighthouse keeper');
  const context = buildNpcCommunityContext({ state, speakerId: keeper, settlementPlans: [plan], speakerPosition: plan.site });
  assert.equal(context.homeCommunity.name, plan.site.name);
  assert.equal(context.homeCommunity.residentCount, 4);
  for (const resident of context.homeCommunity.residents) {
    assert.equal(resident.home.id, plan.buildings[0].id);
    assert.deepEqual(resident.family.memberIds, [...population.residentIds].sort());
  }
});

test('family outdoor pauses remain on the entrance ramp above steep coastal ground', () => {
  for (const yaw of [0, .8, 2.4]) {
    const lighthouse = createLighthousePlan({ key: `lighthouse:slope:${yaw}`, seed: 8,
      x: 120, y: 10, z: -240, yaw }, (x, z) => x * .12 + z * .05);
    const plan = lighthouseResidentPlan(lighthouse);
    const surface = new WalkableSurface({ height: () => -100, seed: 8 }, { trailsAround: () => [] });
    const collision = new StructureCollisionIndex();
    surface.registerClaims(lighthouseWalkableClaims(lighthouse));
    collision.registerSemanticPlan({ id: lighthouse.id, buildings: lighthouse.buildings,
      collisionRecipes: lighthouseCollisionSegments(lighthouse) });
    for (const spot of plan.residentOutdoorSpots) {
      assert.ok(Math.abs(surface.heightAt(spot.x, spot.z, spot.y) - spot.y) < 1e-8);
      assert.equal(collision.collides(spot.x, spot.z, spot.y), null);
    }
  }
});

test('all lighthouse household members use normal persistent conversation memory on returning', async () => {
  const plan = Array.from({ length: 30 }, (_, i) => planFor(i + 1)).find(p => p.buildings[0].householdTemplate.count === 4);
  let state = stateFor();
  const populationIds = activateSettlementResidents(plan, state).residentIds;
  const records = new Map(), storage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) };
  const memoryStore = new NpcMemoryStore({ storage, worldSeed: 23, playerId: 'player:one' });
  memoryStore.getWorldState = () => state;
  const holds = new Set();
  const population = { get worldState() { return state; }, playerId: 'player:one', memoryStore,
    get features() { return state.features; }, livingWorldStore: { save() {} },
    isTalkingTo: id => holds.has(id), reserveRemoteDialogue: id => { holds.add(id); return true; },
    releaseRemoteDialogue: id => holds.delete(id), readEncounterCount: () => 0, storageKey: actor => actor.identity.id,
    contextForActor: actor => ({ npc: actor.identity, station: { name: plan.site.name }, player: { id: 'player:one' },
      memory: memoryStore.load(actor.identity.id), ...buildNpcCommunityContext({ state,
        speakerId: actor.identity.id, settlementPlans: [plan], speakerPosition: plan.site }) }),
  };
  const bridge = new NpcLiveEncounterBridge(population);
  for (const id of populationIds) {
    const actor = { identity: createSettlementResidentIdentity({ entity: state.entities[id], state }) };
    const reservation = await bridge.open(actor, `lighthouse-talk:${id}`);
    const encounter = { actor, reservation, transcript: [
      { role: 'user', content: 'My name is Rowan. I collect seashells.' },
      { role: 'assistant', content: 'Welcome, Rowan. We live here by the lighthouse.' },
    ] };
    bridge.checkpoint(encounter); await bridge.close(encounter);
    assert.match(JSON.stringify(memoryStore.load(id).playerFacts), /Rowan/);
    assert.equal(memoryStore.load(id).meetingCount, 1);
  }
  const household = state.households[plan.buildings[0].ownerHouseholdId];
  const edge = state.relationships[`${household.memberIds[0]}->${household.memberIds[1]}`];
  edge.trust = .93; edge.memories = ['A shared winter watch.'];
  state = JSON.parse(JSON.stringify(state)); // Saved world, with the rendered site gone.
  assert.deepEqual(activateSettlementResidents(planFor(plan.site.seed), state).residentIds, populationIds);
  assert.equal(state.relationships[`${household.memberIds[0]}->${household.memberIds[1]}`].trust, .93);
  for (const id of populationIds) {
    const actor = { identity: createSettlementResidentIdentity({ entity: state.entities[id], state }) };
    const returning = await bridge.open(actor, `return:${id}`);
    assert.match(JSON.stringify(returning.context.memory), /Rowan/);
    await bridge.close({ actor, reservation: returning, transcript: [] });
    assert.equal(memoryStore.load(id).meetingCount, 1);
  }
  assert.equal(memoryStore.load(populationIds[0], 'player:two').meetingCount, 0);
});

test('reactivating a lighthouse preserves an away resident instead of creating a second person', () => {
  const plan = planFor(1), state = stateFor(), first = activateSettlementResidents(plan, state);
  const keeper = state.entities[first.residentIds.find(id => state.entities[id].role === 'lighthouse keeper')];
  keeper.location = { kind: 'building', nodeId: null, settlementId: 'other-village', buildingId: 'other-home' };
  keeper.itineraryId = 'keeper-visit';
  const identity = createSettlementResidentIdentity({ entity: keeper, state });
  const second = activateSettlementResidents(planFor(1), state);
  assert.deepEqual(second.residentIds, first.residentIds);
  assert.equal(keeper.itineraryId, 'keeper-visit');
  assert.equal(keeper.location.settlementId, 'other-village');
  assert.deepEqual(createSettlementResidentIdentity({ entity: keeper, state }), identity);
});
