// Wet woodland: alder carr with still pools in its hollows.

import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../src/world.js';
import { POOL_CELL, wetPoolAt, wetPoolForCell, wetPoolsInRect } from '../src/wetwoodland.mjs';
import { buildClutter, buildScatter, buildWetPools } from '../src/chunkgen.js';

const world = new World(20260612);

function findWetChunks(limit = 4) {
  const found = [];
  const s = {};
  for (let cz = -60; cz <= 60 && found.length < limit; cz += 3) {
    for (let cx = -60; cx <= 60 && found.length < limit; cx += 3) {
      const x = cx * 140 + 70, z = cz * 140 + 70;
      const b = world.biomeAt(x, z);
      if (b.id !== 'forest' || world.forestStand(x, z, b.m, b.t, b.h, s).wet < 0.9) continue;
      if (buildWetPools(world, cx, cz, 140)) found.push({ cx, cz });
    }
  }
  return found;
}

test('pools are deterministic and only lie in flat wet woodland, clear of real water', () => {
  const other = new World(20260612);
  let pools = 0;
  const s = {};
  for (let iz = -200; iz < 200; iz += 3) for (let ix = -200; ix < 200; ix += 3) {
    const pool = wetPoolForCell(world, ix, iz);
    assert.deepEqual(pool, wetPoolForCell(other, ix, iz));
    if (!pool) continue;
    pools++;
    assert.ok(pool.x >= ix * POOL_CELL && pool.x < (ix + 1) * POOL_CELL, 'a pool belongs to its own cell');
    const b = world.biomeAt(pool.x, pool.z);
    assert.equal(b.id, 'forest');
    assert.ok(world.forestStand(pool.x, pool.z, b.m, b.t, b.h, s).wet >= 0.6, `${pool.id} is not in wet woodland`);
    assert.ok(b.slope <= 0.09, `${pool.id} is on a slope`);
    assert.ok(!world.riverAt(pool.x, pool.z).wet, `${pool.id} sits on real water`);
    assert.ok(pool.y > b.h && pool.y < b.h + 0.35, `${pool.id} floats or sinks: ${(pool.y - b.h).toFixed(2)}`);
    assert.ok(pool.r >= 2.4 && pool.r <= 7.2);
  }
  assert.ok(pools > 20, `only ${pools} pools in a 30 km square`);
});

test('nothing grows in a pool, and lily pads only float on one', () => {
  const chunks = findWetChunks(3);
  assert.ok(chunks.length, 'no wet woodland with pools near the origin');
  let lilies = 0, checked = 0;
  for (const { cx, cz } of chunks) {
    const pools = wetPoolsInRect(world, cx * 140 - 10, cz * 140 - 10, (cx + 1) * 140 + 10, (cz + 1) * 140 + 10);
    const inPool = (x, z, margin) => pools.some((p) => Math.hypot(x - p.x, z - p.z) < p.r - margin);
    for (const bucket of buildScatter(world, cx, cz, 140, { mode: 'full', res: 64, treeDensityScale: 1 })) {
      if (['plank', 'trailPost', 'trailRoot', 'trailMud', 'crossingLog', 'reed', 'rock', 'boulder', 'pebble'].includes(bucket.type)) continue;
      for (let i = 0; i < bucket.matrices.length; i += 16) {
        checked++;
        assert.ok(!inPool(bucket.matrices[i + 12], bucket.matrices[i + 14], 0.2), `a ${bucket.type} stands in a pool`);
      }
    }
    for (const bucket of buildClutter(world, cx, cz, 140, { clutterDensityScale: 1 })) {
      for (let i = 0; i < bucket.matrices.length; i += 16) {
        const x = bucket.matrices[i + 12], z = bucket.matrices[i + 14];
        if (bucket.type === 'lilypad') {
          lilies++;
          assert.ok(wetPoolAt(world, x, z, 0), 'a lily pad on dry ground');
        } else if (bucket.type !== 'reed') {
          assert.ok(!inPool(x, z, 0.2), `a ${bucket.type} lies in a pool`);
        }
      }
    }
  }
  assert.ok(checked > 50);
  assert.ok(lilies > 0, 'no lily pads on any pool');
});
