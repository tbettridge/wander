import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCommitment,
  retryBlockedCommitment,
} from '../src/npccommitment.mjs';
import {
  advanceRepairJobs,
  resolveCommitmentArrival,
} from '../src/npcoutcomes.mjs';
import {
  createLivingWorldState,
  registerLivingWorldEntity,
} from '../src/livingworldstate.mjs';

function stateWithPeople() {
  const state = createLivingWorldState({ worldSeed: 5 });
  registerLivingWorldEntity(state, {
    id: 'npc:wren:porter', kind: 'npc', locationKey: 'wren', homeKey: 'wren',
  });
  registerLivingWorldEntity(state, {
    id: 'npc:ash:keeper', kind: 'npc', locationKey: 'ash', homeKey: 'ash',
  });
  return state;
}

function addCommitment(state, {
  id, kind, target, payload, deadlineHour = 20,
}) {
  const commitment = createCommitment({
    id,
    actorId: 'npc:wren:porter',
    kind,
    target,
    destination: { kind: 'landmark', key: 'ash' },
    createdAtHour: 1,
    deadlineHour,
    payload,
  });
  commitment.state = 'active';
  state.commitments[id] = commitment;
  return commitment;
}

function arrival(commitment, atHour = 4) {
  return {
    id: `transition:${commitment.id}:arrived`,
    type: 'journey.arrived',
    commitmentId: commitment.id,
    destinationKey: 'ash',
    atHour,
  };
}

test('trade arrival changes bounded station stock exactly once', () => {
  const state = stateWithPeople();
  const commitment = addCommitment(state, {
    id: 'commitment:trade',
    kind: 'trade',
    target: { kind: 'station', id: 'station:ash' },
    payload: { kind: 'goods', itemKey: 'tea', quantity: 3 },
  });
  resolveCommitmentArrival(state, arrival(commitment));
  resolveCommitmentArrival(state, arrival(commitment));
  assert.equal(state.projections.stationInventory['station:ash'].tea, 3);
  assert.equal(state.commitments[commitment.id].outcome.code, 'restocked');
});

test('a visit records co-location and directed familiarity for both people', () => {
  const state = stateWithPeople();
  const commitment = addCommitment(state, {
    id: 'commitment:visit',
    kind: 'visit',
    target: { kind: 'npc', id: 'npc:ash:keeper' },
    payload: { kind: 'visit' },
  });
  resolveCommitmentArrival(state, arrival(commitment));
  const pair = ['npc:wren:porter', 'npc:ash:keeper'].sort().join('|');
  assert.equal(state.projections.meetings[pair].count, 1);
  assert.ok(state.relationships['npc:wren:porter|npc:ash:keeper'].familiarity > 0);
  assert.ok(state.relationships['npc:ash:keeper|npc:wren:porter'].familiarity > 0);
});

test('an absent visit target blocks and can be replanned once to its new location', () => {
  const state = stateWithPeople();
  state.entities['npc:ash:keeper'].locationKey = 'oak';
  const commitment = addCommitment(state, {
    id: 'commitment:blocked-visit',
    kind: 'visit',
    target: { kind: 'npc', id: 'npc:ash:keeper' },
    payload: { kind: 'visit' },
  });
  const blocked = resolveCommitmentArrival(state, arrival(commitment), { nowHour: 4 });
  assert.equal(blocked.reason, 'target-absent');
  assert.equal(state.commitments[commitment.id].state, 'blocked');
  assert.equal(retryBlockedCommitment(state.commitments[commitment.id], {
    nowHour: 5,
    targetLocationKey: 'oak',
  }), true);
  assert.equal(state.commitments[commitment.id].state, 'planned');
  assert.equal(state.commitments[commitment.id].destination.key, 'oak');
  state.commitments[commitment.id].state = 'blocked';
  state.commitments[commitment.id].blocked = { code: 'target-absent', sinceHour: 6, attempts: 1 };
  assert.equal(retryBlockedCommitment(state.commitments[commitment.id], {
    nowHour: 7,
    targetLocationKey: 'pine',
  }), false, 'a moving target can only trigger one chase replan');
});

test('repair arrival starts visible work and completion resolves later', () => {
  const state = stateWithPeople();
  const commitment = addCommitment(state, {
    id: 'commitment:repair',
    kind: 'repair',
    target: { kind: 'asset', id: 'asset:bridge:ash' },
    payload: { kind: 'tools', durationHours: 1.5 },
  });
  const started = resolveCommitmentArrival(state, arrival(commitment, 4));
  assert.equal(started.applied, true);
  assert.equal(state.commitments[commitment.id].state, 'active');
  assert.equal(state.projections.assets['asset:bridge:ash'].condition, 'under-repair');
  assert.equal(advanceRepairJobs(state, 5).length, 0);
  assert.equal(state.commitments[commitment.id].state, 'active');
  assert.equal(advanceRepairJobs(state, 5.6).length, 1);
  assert.equal(state.projections.assets['asset:bridge:ash'].condition, 'repaired');
  assert.equal(state.commitments[commitment.id].outcome.code, 'repaired');
});

test('late trade is still physical but records a late outcome', () => {
  const state = stateWithPeople();
  const commitment = addCommitment(state, {
    id: 'commitment:late-trade',
    kind: 'trade',
    target: { kind: 'station', id: 'station:ash' },
    payload: { kind: 'goods', itemKey: 'cloth', quantity: 2 },
    deadlineHour: 3,
  });
  resolveCommitmentArrival(state, arrival(commitment, 4));
  assert.equal(state.projections.stationInventory['station:ash'].cloth, 2);
  assert.equal(state.commitments[commitment.id].outcome.code, 'restocked-late');
});
