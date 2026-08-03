import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCommitment,
  initializeCommitmentProjection,
} from '../src/npccommitment.mjs';
import { resolveCommitmentArrival } from '../src/npcoutcomes.mjs';
import {
  createLivingWorldState,
  LivingWorldStateStore,
  registerLivingWorldEntity,
} from '../src/livingworldstate.mjs';

function deliveryFixture() {
  const state = createLivingWorldState({ worldSeed: 7 });
  registerLivingWorldEntity(state, {
    id: 'npc:wren:porter', kind: 'npc', name: 'Maren Bell', locationKey: 'wren', homeKey: 'wren',
  });
  registerLivingWorldEntity(state, {
    id: 'npc:ash:keeper', kind: 'npc', name: 'Alder Reed', locationKey: 'ash', homeKey: 'ash',
  });
  const commitment = createCommitment({
    id: 'commitment:7:npc:wren:porter:1',
    actorId: 'npc:wren:porter',
    kind: 'delivery',
    target: { kind: 'npc', id: 'npc:ash:keeper' },
    destination: { kind: 'landmark', key: 'ash' },
    createdAtHour: 2,
    deadlineHour: 8,
    purposeKey: 'deliver-personal-letter',
    payload: {
      kind: 'letter', id: 'letter:one',
      senderId: 'npc:wren:porter', recipientId: 'npc:ash:keeper',
    },
  });
  commitment.state = 'active';
  state.commitments[commitment.id] = commitment;
  initializeCommitmentProjection(state, commitment);
  const transition = {
    id: 'transition:journey:one:arrived', type: 'journey.arrived',
    commitmentId: commitment.id, destinationKey: 'ash', atHour: 5,
  };
  return { state, commitment, transition };
}

test('courier arrival transfers a concrete letter and resolves exactly once', () => {
  const { state, commitment, transition } = deliveryFixture();
  const first = resolveCommitmentArrival(state, transition);
  const duplicate = resolveCommitmentArrival(state, transition);
  assert.equal(first.applied, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(state.projections.letters['letter:one'].ownerId, 'npc:ash:keeper');
  const resolved = state.commitments[commitment.id];
  assert.equal(resolved.state, 'resolved');
  assert.equal(resolved.outcome.code, 'delivered');
  assert.equal(resolved.outcome.effectEventIds.length, 1);
  assert.equal(state.events.length, 1);
});

test('courier and recipient retain distinct sourced memories', () => {
  const { state, transition } = deliveryFixture();
  resolveCommitmentArrival(state, transition);
  assert.match(state.memories['npc:wren:porter'][0].summary, /delivered/);
  assert.match(state.memories['npc:ash:keeper'][0].summary, /received/);
  assert.equal(state.memories['npc:ash:keeper'][0].provenance, 'observed');
  assert.equal(state.memories['npc:ash:keeper'][0].originEventId, state.events[0].id);
});

test('delivery and its receipt remain idempotent after save and reload', () => {
  const { state, transition } = deliveryFixture();
  resolveCommitmentArrival(state, transition);
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const store = new LivingWorldStateStore({ worldSeed: 7, storage });
  store.save(state);
  const restored = store.load();
  const duplicate = resolveCommitmentArrival(restored, transition);
  assert.equal(duplicate.duplicate, true);
  assert.equal(restored.projections.letters['letter:one'].ownerId, 'npc:ash:keeper');
  assert.equal(restored.events.length, 1);
});

test('an absent recipient blocks delivery without moving the letter', () => {
  const { state, commitment, transition } = deliveryFixture();
  state.entities['npc:ash:keeper'].locationKey = 'somewhere-else';
  const result = resolveCommitmentArrival(state, transition);
  assert.equal(result.reason, 'target-absent');
  assert.equal(state.commitments[commitment.id].state, 'blocked');
  assert.equal(state.projections.letters['letter:one'].ownerId, 'npc:wren:porter');
});

test('a recipient currently travelling is absent even if its last landmark matches', () => {
  const { state, commitment, transition } = deliveryFixture();
  state.entities['npc:ash:keeper'].inTransit = true;
  const result = resolveCommitmentArrival(state, transition);
  assert.equal(result.reason, 'target-absent');
  assert.equal(state.commitments[commitment.id].state, 'blocked');
  assert.equal(state.projections.letters['letter:one'].ownerId, 'npc:wren:porter');
});
