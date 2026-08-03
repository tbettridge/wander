import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { clearTrailCache, trailsAround } from '../src/trails.js';
import { buildNavGraph } from '../src/npcnavgraph.mjs';
import {
  activateCommitment,
  COMMITMENT_STATE,
  expireCommitments,
  planCommitment,
  restoreCommitmentJourney,
  syncCommitmentProgress,
  transitionCommitment,
} from '../src/npccommitment.mjs';
import {
  advanceJourney,
  createJourneyState,
  drainJourneyTransitions,
} from '../src/npcjourney.mjs';
import {
  createLivingWorldState,
  LivingWorldStateStore,
  registerLivingWorldEntity,
} from '../src/livingworldstate.mjs';

const world = new World(20260612);
clearTrailCache();
const edges = [];
trailsAround(world, 0, 0, world.seed, 20000, edges);
const graph = buildNavGraph(edges);
const homeNode = [...graph.nodes.values()].find((node) => node.links.length);
const homeKey = homeNode.key;
const targetKey = homeNode.links[0].to;

function fixture() {
  const state = createLivingWorldState({ worldSeed: world.seed });
  const actor = {
    identity: { id: 'npc:wren:porter', seed: 17, role: 'railway porter' },
    journey: createJourneyState(17, homeKey, { loiterHours: 0 }),
  };
  registerLivingWorldEntity(state, {
    id: actor.identity.id, kind: 'npc', role: actor.identity.role,
    stationId: 'wren', homeKey, locationKey: homeKey,
  });
  registerLivingWorldEntity(state, {
    id: 'npc:ash:keeper', kind: 'npc', role: 'station keeper',
    stationId: 'ash', homeKey: targetKey, locationKey: targetKey,
  });
  return { state, actor };
}

test('a planned commitment has concrete intent and binds bidirectionally to a journey', () => {
  const { state, actor } = fixture();
  const commitment = planCommitment(state, actor, graph, { nowHour: 20 });
  assert.ok(commitment);
  assert.equal(commitment.actorId, actor.identity.id);
  assert.ok(commitment.target.id);
  assert.ok(commitment.destination.key);
  assert.ok(commitment.deadlineHour > commitment.createdAtHour);
  assert.equal(commitment.state, COMMITMENT_STATE.planned);
  assert.equal(activateCommitment(commitment, actor.journey, graph), true);
  assert.equal(commitment.state, COMMITMENT_STATE.active);
  assert.equal(actor.journey.commitmentId, commitment.id);
  assert.equal(actor.journey.journeyId, commitment.journeyId);
});

test('arrival emits the commitment transition before journey intent is cleared', () => {
  const { state, actor } = fixture();
  const commitment = planCommitment(state, actor, graph, { nowHour: 20 });
  activateCommitment(commitment, actor.journey, graph);
  let transitions = [];
  for (let i = 0; i < 10000 && !transitions.length; i++) {
    advanceJourney(actor.journey, { dt: 10, graph, worldHour: 21 });
    transitions = drainJourneyTransitions(actor.journey);
  }
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].type, 'journey.arrived');
  assert.equal(transitions[0].commitmentId, commitment.id);
  assert.equal(transitions[0].destinationKey, commitment.destination.key);
});

test('active route progress saves and restores against the current graph', () => {
  const { state, actor } = fixture();
  const commitment = planCommitment(state, actor, graph, { nowHour: 20 });
  activateCommitment(commitment, actor.journey, graph);
  advanceJourney(actor.journey, { dt: 3, graph, worldHour: 20.1 });
  syncCommitmentProgress(commitment, actor.journey);

  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const store = new LivingWorldStateStore({ worldSeed: world.seed, storage });
  store.save(state);
  const restoredState = store.load();
  const restoredCommitment = restoredState.commitments[commitment.id];
  const restoredJourney = createJourneyState(17, homeKey, { loiterHours: 0 });
  assert.equal(restoreCommitmentJourney(restoredCommitment, restoredJourney, graph), true);
  assert.equal(restoredJourney.commitmentId, commitment.id);
  assert.equal(restoredJourney.legIndex, actor.journey.legIndex);
  assert.ok(Math.abs(restoredJourney.travelled - actor.journey.travelled) < 1e-9);
});

test('invalid lifecycle transitions fail loudly and deadlines resolve with outcomes', () => {
  const { state, actor } = fixture();
  const commitment = planCommitment(state, actor, graph, { nowHour: 20 });
  assert.throws(() => transitionCommitment(commitment, COMMITMENT_STATE.blocked));
  const expired = expireCommitments(state, commitment.deadlineHour + 1);
  assert.equal(expired.length, 1);
  assert.equal(commitment.state, COMMITMENT_STATE.resolved);
  assert.equal(commitment.outcome.code, 'deadline-missed');
});
