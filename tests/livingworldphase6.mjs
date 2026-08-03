import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  createLivingWorldState,
  LivingWorldStateStore,
  normalizeLivingWorldState,
  registerLivingWorldEntity,
  setLivingWorldFeatures,
} from '../src/livingworldstate.mjs';
import {
  createCommitment,
  initializeCommitmentProjection,
} from '../src/npccommitment.mjs';
import { advanceRepairJobs, resolveCommitmentArrival } from '../src/npcoutcomes.mjs';
import {
  auditLivingWorldState,
  LIVING_WORLD_SIMULATION_P95_BUDGET_MS,
  LIVING_WORLD_BASELINE_SNAPSHOT_BUDGET_BYTES,
  LIVING_WORLD_SNAPSHOT_BUDGET_BYTES,
  percentile,
} from '../src/livingworldquality.mjs';
import {
  beginNpcConversation,
  beginPlayerConversation,
  exchangeRumors,
  recordPlayerConversationOutcome,
} from '../src/npcrumor.mjs';
import { relationshipBetween } from '../src/npcsocialmemory.mjs';
import { fallbackChatReply } from '../src/livingworld.mjs';

function commitmentFor(state, index) {
  const actorId = `npc:${index}`;
  const targetNpcId = `npc:${(index + 1) % 64}`;
  const kind = ['delivery', 'trade', 'visit', 'repair'][index % 4];
  const destinationKey = `place:${(index + 1) % 8}`;
  const target = kind === 'delivery' || kind === 'visit'
    ? { kind: 'npc', id: targetNpcId }
    : kind === 'trade'
      ? { kind: 'station', id: `station:${index % 8}` }
      : { kind: 'asset', id: `asset:${index}` };
  const payload = kind === 'delivery'
    ? { kind: 'letter', id: `letter:${index}`, senderId: actorId, recipientId: targetNpcId }
    : kind === 'trade'
      ? { kind: 'goods', itemKey: ['grain', 'tea', 'cloth', 'tools'][index % 4], quantity: 2 }
      : kind === 'repair' ? { kind: 'repair', durationHours: 0.5 } : {};
  const commitment = createCommitment({
    id: `commitment:soak:${index}`, actorId, kind, target,
    destination: { kind: 'landmark', key: destinationKey },
    createdAtHour: index, deadlineHour: index + 20, payload,
  });
  commitment.state = 'active';
  commitment.journeyId = `journey:${commitment.id}`;
  state.commitments[commitment.id] = commitment;
  initializeCommitmentProjection(state, commitment);
  return commitment;
}

function soakFixture() {
  const state = createLivingWorldState({ worldSeed: 6006 });
  for (let i = 0; i < 64; i++) {
    registerLivingWorldEntity(state, {
      id: `npc:${i}`, kind: 'npc', name: `Resident ${i}`,
      role: ['porter', 'trader', 'visitor', 'worker'][i % 4],
      locationKey: `place:${i % 8}`, homeKey: `place:${i % 8}`, inTransit: false,
    });
  }
  for (let i = 0; i < 64; i++) {
    const commitment = commitmentFor(state, i);
    if (commitment.target.kind === 'npc') {
      state.entities[commitment.target.id].locationKey = commitment.destination.key;
    }
    const transition = {
      id: `transition:${i}`, type: 'journey.arrived', commitmentId: commitment.id,
      destinationKey: commitment.destination.key, atHour: i + 1,
    };
    resolveCommitmentArrival(state, transition, { nowHour: i + 1 });
    resolveCommitmentArrival(state, transition, { nowHour: i + 1 });
  }
  advanceRepairJobs(state, 1000);
  state.clock.worldHours = 1000;
  for (let i = 0; i < 96; i++) {
    const a = `npc:${i % 64}`;
    const b = `npc:${(i + 1) % 64}`;
    exchangeRumors(state, beginNpcConversation(state, [a, b], { nowHour: 100 + i * 9 }), {
      nowHour: 100 + i * 9,
    });
  }
  return state;
}

test('nested default-on flags roll back consumers without deleting persisted state', () => {
  const state = soakFixture();
  const before = JSON.stringify({ commitments: state.commitments, memories: state.memories });
  const disabled = setLivingWorldFeatures(state, {
    commitmentsEnabled: false,
    socialMemoryEnabled: false,
  });
  assert.equal(disabled.commitmentsEnabled, false);
  assert.equal(disabled.consequencesEnabled, false);
  assert.equal(disabled.socialMemoryEnabled, false);
  assert.equal(disabled.rumorExchangeEnabled, false);
  assert.equal(JSON.stringify({ commitments: state.commitments, memories: state.memories }), before);
  const enabled = setLivingWorldFeatures(state, {
    commitmentsEnabled: true, consequencesEnabled: true,
    socialMemoryEnabled: true, rumorExchangeEnabled: true,
  });
  assert.ok(Object.values(enabled).every(Boolean));
});

test('v1 snapshots migrate in place while preserving legacy readers and data', () => {
  const migrated = normalizeLivingWorldState({
    version: 1, worldSeed: 8,
    entities: { 'npc:one': { id: 'npc:one', kind: 'npc' } },
    commitments: { old: { id: 'old', actorId: 'npc:one', state: 'resolved' } },
    memories: { 'npc:one': [{ id: 'legacy-memory', lineageId: 'legacy:one' }] },
  });
  assert.equal(migrated.version, 4);
  assert.ok(migrated.entities['npc:one']);
  assert.ok(migrated.commitments.old);
  assert.equal(migrated.memories['npc:one'][0].id, 'legacy-memory');
  assert.ok(Object.values(migrated.features).every(Boolean));
});

test('player conversations produce a directed, exactly-once relationship event', () => {
  const state = createLivingWorldState();
  registerLivingWorldEntity(state, { id: 'npc:one', kind: 'npc', name: 'One' });
  registerLivingWorldEntity(state, { id: 'player:local', kind: 'player', name: 'Traveller' });
  const conversation = beginPlayerConversation(state, 'npc:one', { nowHour: 2 });
  const first = recordPlayerConversationOutcome(state, conversation, {
    npcId: 'npc:one', playerTurns: 3, nowHour: 3,
  });
  const duplicate = recordPlayerConversationOutcome(state, conversation, {
    npcId: 'npc:one', playerTurns: 3, nowHour: 3,
  });
  assert.equal(first.applied, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(relationshipBetween(state, 'npc:one', 'player:local').familiarity, 0.05);
  assert.equal(relationshipBetween(state, 'player:local', 'npc:one'), null);
});

test('64-NPC, 1,000-hour soak is finite, bounded, sourced, and below snapshot budget', (t) => {
  const state = soakFixture();
  const audit = auditLivingWorldState(state);
  assert.deepEqual(audit.errors, []);
  assert.equal(audit.metrics.entities, 64);
  assert.equal(audit.metrics.openCommitments, 0);
  assert.equal(audit.metrics.resolvedCommitments, 64);
  assert.ok(audit.metrics.effectDedupes >= 64);
  assert.ok(audit.metrics.rumorExchanges > 0);
  assert.ok(audit.metrics.snapshotBytes <= LIVING_WORLD_SNAPSHOT_BUDGET_BYTES,
    `${audit.metrics.snapshotBytes} exceeds ${LIVING_WORLD_SNAPSHOT_BUDGET_BYTES}`);
  assert.ok(audit.metrics.snapshotBytes <= LIVING_WORLD_BASELINE_SNAPSHOT_BUDGET_BYTES,
    `${audit.metrics.snapshotBytes} exceeds baseline gate ${LIVING_WORLD_BASELINE_SNAPSHOT_BUDGET_BYTES}`);
  const persisted = new Map();
  const store = new LivingWorldStateStore({
    worldSeed: state.worldSeed,
    storage: {
      getItem: (key) => persisted.get(key) ?? null,
      setItem: (key, value) => persisted.set(key, value),
    },
  });
  assert.equal(store.save(state), true);
  const restored = store.load();
  assert.equal(auditLivingWorldState(restored).ok, true);
  assert.equal(restored.metrics.rumorTransfers, state.metrics.rumorTransfers);
  assert.equal(Object.values(restored.memories).flat().length, audit.metrics.memories);
  t.diagnostic(`compact snapshot ${audit.metrics.snapshotBytes} bytes; ${audit.metrics.memories} memories; ${audit.metrics.rumorTransfers} rumor transfers`);
});

test('state-only off-screen simulation remains within the p95 frame budget', (t) => {
  const state = soakFixture();
  const samples = [];
  for (let i = 0; i < 500; i++) {
    const start = performance.now();
    advanceRepairJobs(state, 1000 + i);
    samples.push(performance.now() - start);
  }
  assert.equal(auditLivingWorldState(state).ok, true, 'diagnostic audit still passes after simulation');
  const p95 = percentile(samples);
  assert.ok(p95 <= LIVING_WORLD_SIMULATION_P95_BUDGET_MS,
    `p95 ${p95.toFixed(3)}ms exceeds ${LIVING_WORLD_SIMULATION_P95_BUDGET_MS}ms`);
  t.diagnostic(`state-only simulation p95 ${p95.toFixed(3)}ms`);
});

test('snapshot bytes and save failures are observable', () => {
  const state = createLivingWorldState({ worldSeed: 19 });
  const values = new Map();
  const store = new LivingWorldStateStore({
    worldSeed: 19,
    storage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
  });
  assert.equal(store.save(state), true);
  assert.ok(state.metrics.snapshotBytes > 0);
  const failing = new LivingWorldStateStore({
    worldSeed: 19,
    storage: { getItem: () => null, setItem: () => { throw new Error('quota'); } },
  });
  assert.equal(failing.save(state), false);
  assert.equal(state.metrics.saveFailures, 1);
});

test('authored fallback states every outcome kind and sourced rumor without a model', () => {
  const base = {
    npc: { id: 'npc:one', name: 'One', role: 'porter' },
    station: { id: 'home', name: 'Home' },
    targets: [{ id: 'home', name: 'Home', kind: 'station' }],
  };
  for (const [kind, code, expected] of [
    ['delivery', 'delivered', /letter/i],
    ['trade', 'restocked', /goods/i],
    ['visit', 'visited', /meeting/i],
    ['repair', 'repaired', /repair/i],
  ]) {
    const reply = fallbackChatReply({ ...base, social: {
      activeCommitment: null,
      recentOutcomes: [{ kind, targetName: 'Ash', outcome: { status: 'succeeded', code } }],
      memories: [],
    } }, 'Any news?');
    assert.match(reply.text, expected);
  }
  const rumor = fallbackChatReply({ ...base, social: {
    activeCommitment: null, recentOutcomes: [],
    memories: [{ statement: 'A letter reached Ash.', provenance: 'told', sourceName: 'Bram' }],
  } }, 'Any news?');
  assert.match(rumor.text, /Bram told me a letter reached Ash/i);
});
