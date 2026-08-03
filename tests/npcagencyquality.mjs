import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createLivingWorldState, parseLivingWorldState, registerLivingWorldEntity, serializeLivingWorldState } from '../src/livingworldstate.mjs';
import { percentile, LIVING_WORLD_SIMULATION_P95_BUDGET_MS } from '../src/livingworldquality.mjs';
import { interactionCandidateFor } from '../src/npcinteraction.mjs';
import { registerActionAnchor } from '../src/npcactionanchors.mjs';
import { advanceSituatedAction, planSituatedAction, situatedActionCandidatesFor } from '../src/npcsituatedaction.mjs';
import { createTravelGroup, removeGroupMember, setGroupEpisode } from '../src/npcgroup.mjs';

function populatedState() {
  const state = createLivingWorldState({ worldSeed: 71 });
  registerLivingWorldEntity(state, { id: 'player:local', kind: 'player' });
  for (let i = 0; i < 64; i++) registerLivingWorldEntity(state, { id: `npc:${i}`, kind: 'npc' });
  return state;
}

test('active agency candidate planning stays inside the simulation p95 budget', () => {
  const state = populatedState();
  const actors = Array.from({ length: 64 }, (_, i) => ({ id: `npc:${i}` }));
  const samples = [];
  for (let tick = 0; tick < 500; tick++) {
    const start = performance.now();
    for (const actor of actors) {
      interactionCandidateFor(state, actor, { destinationKey: 'place:north' });
      situatedActionCandidatesFor(state, actor, { hasTrailMarker: true, trainDue: tick % 5 === 0 }, ['map']);
    }
    samples.push(performance.now() - start);
  }
  const p95 = percentile(samples);
  assert.ok(p95 <= LIVING_WORLD_SIMULATION_P95_BUDGET_MS,
    `agency candidate p95 ${p95.toFixed(3)}ms exceeds ${LIVING_WORLD_SIMULATION_P95_BUDGET_MS}ms`);
});

test('action capacity, departure, dialogue interruption, and reload matrix is safe', () => {
  const state = populatedState();
  registerActionAnchor(state, { id: 'shelter:one', kind: 'shelter', x: 0, z: 0, capacity: 1 });
  const first = planSituatedAction(state, { actorId: 'npc:0', kind: 'shelter-rain', facts: { raining: true }, position: { x: 0, z: 0 } });
  assert.ok(first);
  assert.equal(planSituatedAction(state, { actorId: 'npc:1', kind: 'shelter-rain', facts: { raining: true }, position: { x: 0, z: 0 } }), null);
  const restored = parseLivingWorldState(serializeLivingWorldState(state));
  assert.equal(restored.actions[first.id].state, 'acting');
  advanceSituatedAction(restored, first.id, { interruptedBy: 'dialogue', nowHour: 0.01 });
  assert.equal(restored.actions[first.id].state, 'interrupted');
  const second = planSituatedAction(restored, { actorId: 'npc:1', kind: 'shelter-rain', facts: { raining: true }, position: { x: 0, z: 0 } }, { nowHour: 1 });
  restored.actionAnchors['shelter:one'].enabled = false;
  advanceSituatedAction(restored, second.id, { facts: { raining: true, anchorEnabled: false }, nowHour: 1.01 });
  assert.equal(restored.actions[second.id].interruptedBy, 'anchor-departed');
});

test('member loss cannot deadlock any group lifecycle state', () => {
  for (const [index, lifecycle] of ['forming', 'together', 'paused', 'splitting'].entries()) {
    const state = populatedState();
    const group = createTravelGroup(state, { memberIds: ['npc:0', 'npc:1', 'npc:2'], leaderId: 'npc:0' });
    if (lifecycle === 'together') setGroupEpisode(state, group.id, 'walk');
    if (lifecycle === 'paused') setGroupEpisode(state, group.id, 'argue', { paused: true });
    if (lifecycle === 'splitting') { group.state = 'splitting'; group.episode = 'split'; }
    assert.equal(removeGroupMember(state, group.id, 'npc:0', { nowHour: index }), true);
    assert.notEqual(group.leaderId, 'npc:0');
    assert.ok(['splitting', 'dissolved'].includes(group.state));
  }
});
