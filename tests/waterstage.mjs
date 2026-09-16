import test from 'node:test';
import assert from 'node:assert/strict';
import { waterStagePayloadBytes } from '../src/waterstage.mjs';

test('staging memory counts transferred geometry, props and shared views once', () => {
  const terrain = new Float32Array(100), indices = new Uint32Array(50);
  const matrices = new Float32Array(160), shared = terrain.subarray(0, 10);
  assert.equal(waterStagePayloadBytes({ terrain: { positions: terrain, alias: shared, indices },
    scatter: [{ matrices }], id: 1, text: 'metadata', unused: null }), 1240);
});

test('worker encoding reuses immutable field plans and preserves exact numeric values', async () => {
  const { waterWorkerPlans, decodeWaterWorkerPlans } = await import('../src/waterstage.mjs');
  const values = [{ floor: [0, 1.2345678901234567, -999.125], hash: '12345678' }];
  let reads = 0;
  const field = { get plans() { reads++; return values; } };
  const encoded = waterWorkerPlans(field);
  assert.equal(waterWorkerPlans(field), encoded);
  assert.equal(reads, 1, 'replacement workers must not serialize the field again');
  assert.deepEqual(decodeWaterWorkerPlans({ waterPlansJSON: encoded }), values);
  assert.deepEqual(decodeWaterWorkerPlans({ waterPlans: values }), values, 'older worker callers remain supported');
  assert.equal(waterWorkerPlans(null), null);
  assert.equal(decodeWaterWorkerPlans({ waterPlansJSON: null }), null);
  const replacement = { plans: [{ floor: [9] }] };
  assert.notEqual(waterWorkerPlans(replacement), encoded, 'new fields must not reuse old landscape data');
});

test('worker decoder rejects malformed or oversized encoded plans', async () => {
  const { decodeWaterWorkerPlans } = await import('../src/waterstage.mjs');
  for (const waterPlansJSON of [42, '{}', 'null', '[', ' '.repeat(32 * 1024 * 1024 + 1)]) {
    assert.throws(() => decodeWaterWorkerPlans({ waterPlansJSON }));
  }
});
