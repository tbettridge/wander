// Brooks in the folds of the forest hills, and the ponds they end in.

import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../src/world.js';
import { BROOK_CELL, brooksForCell, brooksInRect, nearestBrook } from '../src/forestbrooks.mjs';
import { buildBrooks, buildScatter, buildWetPools } from '../src/chunkgen.js';

const world = new World(20260612);

function allBrooks(range = 10) {
  const out = [];
  for (let cj = -range; cj < range; cj++) for (let ci = -range; ci < range; ci++) out.push(...brooksForCell(world, ci, cj));
  return out;
}

test('brooks rise in the forest and only ever run downhill, clear of real water', () => {
  const brooks = allBrooks();
  assert.ok(brooks.length > 15, `only ${brooks.length} brooks in ${(BROOK_CELL * 20 / 1000).toFixed(1)} km square`);
  const other = new World(20260612);
  for (const brook of brooks.slice(0, 6)) {
    const [ci, cj] = brook.id.split(':').slice(1, 3).map(Number);
    assert.deepEqual(brooksForCell(other, ci, cj).find((b) => b.id === brook.id).pts, brook.pts, 'deterministic');
  }
  for (const brook of brooks) {
    const p = brook.pts;
    assert.equal(world.biomeAt(p[0], p[2]).id, 'forest', `${brook.id} rises outside the forest`);
    assert.ok(brook.length >= 50, `${brook.id} is ${brook.length.toFixed(0)} m`);
    for (let i = 1; i < brook.count; i++) {
      assert.ok(p[i * 4 + 1] <= p[i * 4 - 3] + 1e-6, `${brook.id} runs uphill at ${i}`);
      assert.ok(p[i * 4 + 3] > 0 && p[i * 4 + 3] < 2, `${brook.id} width`);
    }
    for (let i = 0; i < brook.count; i += 4) {
      assert.ok(!world.riverAt(p[i * 4], p[i * 4 + 2]).wet || i > brook.count - 6, `${brook.id} runs over real water`);
    }
    if (brook.pond) assert.ok(!world.riverAt(brook.pond.x, brook.pond.z).wet, `${brook.id} pond on real water`);
    assert.ok(brook.cascades.length <= Math.ceil(brook.length / 10) + 1, `${brook.id} has too many cascades`);
  }
});

test('a chunk draws the brooks it owns, keeps trees out of them, and fills their ponds', () => {
  const brooks = allBrooks().filter((b) => b.pond);
  assert.ok(brooks.length, 'no brook ending in a pond');
  const brook = brooks[0];
  const p = brook.pts;
  const mid = Math.floor(brook.count / 2);
  const cx = Math.floor(p[mid * 4] / 140), cz = Math.floor(p[mid * 4 + 2] / 140);
  const built = buildBrooks(world, cx, cz, 140);
  assert.ok(built?.ribbon, 'the chunk on the brook has no ribbon');
  const r = built.ribbon;
  assert.equal(r.positions.length / 3, r.brook.length / 3);
  assert.equal(r.positions.length / 3, r.flow.length / 2);
  for (const index of r.indices) assert.ok(index < r.positions.length / 3);
  // the bed spreads beyond the water on both sides and follows the bank up
  const bed = built.bed;
  assert.ok(bed, 'no bed under the brook');
  assert.equal(bed.positions.length / 3, bed.brook.length / 3);
  for (const index of bed.indices) assert.ok(index < bed.positions.length / 3);
  let widest = 0;
  for (let i = 0; i < bed.brook.length; i += 3) widest = Math.max(widest, Math.abs(bed.brook[i]));
  let waterWidest = 0;
  for (let i = 0; i < r.brook.length; i += 3) waterWidest = Math.max(waterWidest, Math.abs(r.brook[i]));
  assert.ok(widest > waterWidest + 1.5, 'the bed is no wider than the water');
  const nearby = brooksInRect(world, cx * 140, cz * 140, (cx + 1) * 140, (cz + 1) * 140);
  const near = {};
  for (const bucket of buildScatter(world, cx, cz, 140, { mode: 'full', res: 64, treeDensityScale: 1 })) {
    if (['plank', 'trailPost', 'trailRoot', 'trailMud', 'crossingLog', 'reed', 'rock', 'boulder', 'pebble'].includes(bucket.type)) continue;
    for (let i = 0; i < bucket.matrices.length; i += 16) {
      nearestBrook(nearby, bucket.matrices[i + 12], bucket.matrices[i + 14], near);
      assert.ok(near.distance >= near.halfWidth, `a ${bucket.type} stands in a brook`);
    }
  }
  const pond = brook.pond;
  const pools = buildWetPools(world, Math.floor(pond.x / 140), Math.floor(pond.z / 140), 140);
  assert.ok(pools, 'the pond chunk has no pools');
  let found = false;
  for (let i = 0; i < pools.length; i += 6) if (Math.abs(pools[i] - pond.x) < 1e-3 && Math.abs(pools[i + 2] - pond.z) < 1e-3) found = true;
  assert.ok(found, 'the brook pond is not drawn');
});
