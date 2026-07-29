import assert from 'node:assert/strict';
import { cloudLayerDrawBudget, packedCloudCardOrder } from '../src/cloudbatch.mjs';

const cards = [
  { id: 'near', visible: true, position: { x: 5, y: 0, z: 0 }, material: { opacity: 0.8 } },
  { id: 'far', visible: true, position: { x: 10, y: 0, z: 0 }, material: { opacity: 0.5 } },
  { id: 'hidden', visible: false, position: { x: 15, y: 0, z: 0 }, material: { opacity: 1 } },
  { id: 'clear', visible: true, position: { x: 20, y: 0, z: 0 }, material: { opacity: 0.001 } },
];
assert.deepEqual(
  packedCloudCardOrder(cards, { x: 0, y: 0, z: 0 }).map((card) => card.id),
  ['far', 'near'],
  'visible transparent instances should be compacted and sorted back-to-front',
);
assert.equal(cloudLayerDrawBudget([34, 12, 16]), 3,
  '62 cloud cards should collapse to three atlas-layer submissions');
assert.equal(cloudLayerDrawBudget([0, 12, 0]), 1);
assert.equal(cloudLayerDrawBudget([0, 0, 0]), 0);

console.log('cloudbatch PASS · 62 cards → 3 instanced draws · visibility compacted · depth sorted');
