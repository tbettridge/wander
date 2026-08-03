import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLivingWorldEventOnce,
  createLivingWorldState,
  LivingWorldStateStore,
  registerLivingWorldEntity,
} from '../src/livingworldstate.mjs';

test('a stable world event applies exactly once', () => {
  const state = createLivingWorldState({ worldSeed: 17 });
  const event = { id: 'event:letter:delivered', type: 'delivery.completed', amount: 2 };
  const reduce = (draft, incoming) => {
    draft.projections.stationInventory.wren = {
      apples: (draft.projections.stationInventory.wren?.apples || 0) + incoming.amount,
    };
    return { stock: draft.projections.stationInventory.wren.apples };
  };
  const first = applyLivingWorldEventOnce(state, event, reduce);
  const duplicate = applyLivingWorldEventOnce(state, event, reduce);
  assert.equal(first.applied, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(state.projections.stationInventory.wren.apples, 2);
  assert.equal(state.events.length, 1);
});

test('a throwing reducer leaves the original state untouched', () => {
  const state = createLivingWorldState({ worldSeed: 9 });
  const before = structuredClone(state);
  assert.throws(() => applyLivingWorldEventOnce(
    state,
    { id: 'event:bad', type: 'bad' },
    (draft) => {
      draft.projections.letters.x = { ownerId: 'nobody' };
      throw new Error('reject');
    },
  ));
  assert.deepEqual(state, before);
});

test('state, entities, and effect receipts survive one atomic snapshot', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const store = new LivingWorldStateStore({ worldSeed: 41, storage });
  const state = store.load();
  registerLivingWorldEntity(state, { id: 'npc:wren:porter', kind: 'npc', homeKey: 'wren' });
  applyLivingWorldEventOnce(state, { id: 'event:one', type: 'test' }, (draft) => {
    draft.projections.assets.bridge = { condition: 'repaired' };
  });
  assert.equal(store.save(state), true);
  const restored = store.load();
  assert.equal(restored.entities['npc:wren:porter'].homeKey, 'wren');
  assert.equal(restored.projections.assets.bridge.condition, 'repaired');
  assert.ok(restored.effectReceipts['event:one']);
});
