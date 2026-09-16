import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { prepareBasinDrainagePreview } from '../src/hydrologyworker.js';
import { riparianPlacements } from '../src/riparian.mjs';

const preview = prepareBasinDrainagePreview({ seed: 42, regionX: 0, regionZ: 0 });
const world = new World(42, { waterPlans: [preview.plan] });

test('shoreline dressing forms repeatable, grounded patches without blocking reserved approaches', () => {
  const cx = Math.floor(preview.target.x / 140), cz = Math.floor(preview.target.z / 140);
  const all = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const x = cx + dx, z = cz + dz, placements = riparianPlacements(world, x, z, 140);
    assert.deepEqual(placements, riparianPlacements(world, x, z, 140));
    assert.deepEqual(riparianPlacements(world, x, z, 140, () => true), []);
    for (const p of placements) {
      assert.ok(p.x >= x * 140 && p.x < (x + 1) * 140 && p.z >= z * 140 && p.z < (z + 1) * 140);
      const r = world.riverAt(p.x, p.z);
      assert.ok(p.y <= r.floor && p.y > r.floor - 0.25);
      if (p.type === 'reed') assert.ok(r.wet && r.depth > 0 && r.depth < 0.6);
    }
    all.push(...placements);
  }
  assert.ok(all.filter(p => p.type === 'reed').length > 10);
  assert.ok(all.filter(p => p.type === 'rock').length > 0);
  assert.equal(new Set(all.map(p => `${p.x},${p.z}`)).size, all.length, 'neighbouring chunks do not duplicate plants');
  assert.deepEqual(riparianPlacements(new World(42), cx, cz, 140), [], 'legacy scatter is unaffected');
});
