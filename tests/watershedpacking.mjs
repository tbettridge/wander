import test from 'node:test';
import assert from 'node:assert/strict';
import { planWaterRegionCandidates } from '../src/hydrologyregions.mjs';
import { descriptorHash } from '../src/hydrologyformat.mjs';
import { watershedDescriptorFromWaterPlan } from '../src/watersheddescriptor.mjs';
import {
  deserializeWatershedDescriptor,
  serializeWatershedDescriptor,
  watershedDescriptorPackStats,
} from '../src/watershedpacking.mjs';

const accepted = planWaterRegionCandidates(4242, 1, 0);
const descriptor = watershedDescriptorFromWaterPlan(accepted);
const packed = serializeWatershedDescriptor(descriptor);
const stats = watershedDescriptorPackStats(descriptor);

test('packs the requested regional descriptor with an exact geographic roundtrip', () => {
  const restored = deserializeWatershedDescriptor(packed);
  assert.deepStrictEqual(restored, descriptor);
  assert.equal(restored.hash, descriptor.hash);
  assert.deepStrictEqual(restored.region, descriptor.region);
  assert.deepStrictEqual(restored.basins, descriptor.basins);
  assert.deepStrictEqual(restored.components, descriptor.components);
  assert.deepStrictEqual(restored.rivers, descriptor.rivers);
  assert.deepStrictEqual(restored.boundaryContracts, descriptor.boundaryContracts);
  assert.ok(Object.isFrozen(restored));
  assert.ok(Object.isFrozen(restored.basins[0]));
  assert.ok(stats.dictionaryEntries > 0);
  assert.ok(stats.references > 0);
  assert.ok(stats.packedBytes < stats.sourceBytes, `${stats.packedBytes} < ${stats.sourceBytes}`);
  console.log(`watershedpacking benchmark · source ${stats.sourceBytes} B · packed ${stats.packedBytes} B · ${stats.dictionaryEntries} dictionary entries · ${stats.references} references`);
});

test('keeps full floating-point values, including negative zero', () => {
  const changed = structuredClone(descriptor);
  changed.basins[0].spill = Number.MIN_VALUE;
  changed.basins[0].area = Number.MAX_VALUE;
  changed.basins[0].length = -0;
  const { hash, ...payload } = changed;
  changed.hash = descriptorHash(payload);
  const restored = deserializeWatershedDescriptor(serializeWatershedDescriptor(changed));
  assert.deepStrictEqual(restored, changed);
  assert.ok(Object.is(restored.basins[0].length, -0));
  assert.equal(restored.basins[0].spill, Number.MIN_VALUE);
  assert.equal(restored.basins[0].area, Number.MAX_VALUE);
});

test('rejects bad dictionary references and descriptor checksums', () => {
  const invalidReference = JSON.parse(packed);
  invalidReference.dictionary[0] = { '\u0000r': invalidReference.dictionary.length + 1 };
  assert.throws(
    () => deserializeWatershedDescriptor(JSON.stringify(invalidReference)),
    /dictionary reference/i,
  );

  const cyclicReference = JSON.parse(packed);
  cyclicReference.dictionary[0] = { '\u0000r': 0 };
  assert.throws(
    () => deserializeWatershedDescriptor(JSON.stringify(cyclicReference)),
    /cyclic dictionary reference/i,
  );

  const changed = JSON.parse(packed);
  changed.root.extra = true;
  assert.throws(
    () => deserializeWatershedDescriptor(JSON.stringify(changed)),
    /checksum/i,
  );
});

test('enforces reference, expansion, node and input budgets', () => {
  assert.throws(
    () => serializeWatershedDescriptor(descriptor, { maxReferences: 1 }),
    /maxReferences/i,
  );
  assert.throws(
    () => deserializeWatershedDescriptor(packed, { maxReferences: 1 }),
    /maxReferences/i,
  );
  assert.throws(
    () => deserializeWatershedDescriptor(packed, { maxExpandedBytes: 1024 }),
    /maxExpandedBytes/i,
  );
  assert.throws(
    () => deserializeWatershedDescriptor(packed, { maxNodes: 10 }),
    /maxNodes/i,
  );
  assert.throws(
    () => deserializeWatershedDescriptor(packed, { maxInputBytes: 32 }),
    /maxInputBytes/i,
  );
});

test('does not accept an invalid immutable descriptor for packing', () => {
  const invalid = { ...descriptor, hash: 'tampered' };
  assert.throws(() => serializeWatershedDescriptor(invalid), /descriptor validation failed|checksum/i);
});
