import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { prepareBasinDrainagePreview } from '../src/hydrologyworker.js';
import { lakeReflectionTargets, nearestLakeReflection } from '../src/waterreflectiontargets.mjs';

test('reflection selection uses the lake plane and stops below water or beyond the local bank', () => {
  const preview = prepareBasinDrainagePreview({ seed: 4242, regionX: 1, regionZ: 0 });
  const world = new World(4242, { waterPlans: [preview.plan] });
  const targets = lakeReflectionTargets(world);
  assert.equal(targets.length, 1);
  const target = targets[0], position = { ...preview.target, y: target.level + 1.7 };
  assert.equal(nearestLakeReflection(targets, position), target);
  assert.equal(nearestLakeReflection(targets, { ...position, y: target.level - 0.1 }), null);
  assert.equal(nearestLakeReflection(targets, { ...position, x: target.maxX + 200 }), null);
  assert.equal(nearestLakeReflection(targets, { ...position, y: target.level + 500 }), null);
  assert.deepEqual(lakeReflectionTargets(new World(4242)), []);
  assert.ok(target.minX < preview.target.x && target.maxX > preview.target.x);
});
