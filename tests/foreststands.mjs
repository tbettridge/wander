// Forests come in stands: old growth, pinewood, light woodland and the
// ordinary mixed forest, in patches with soft edges.

import assert from 'node:assert/strict';
import test from 'node:test';
import { World } from '../src/world.js';
import { FOREST_STANDS, RECIPES, UNDERSTORY_SCALE, VARIANT_COUNTS, forestStandAt, forestGrassFactor } from '../src/vegdata.js';

function sampleForest(world, step = 410) {
  const out = [];
  for (let x = -24000; x < 24000; x += step) for (let z = -24000; z < 24000; z += step + 37) {
    const b = world.biomeAt(x, z);
    if (b.id === 'forest') out.push({ x, z, b });
  }
  return out;
}

test('each stand covers about a fifth of the forest, on every seed', () => {
  for (const seed of [20260612, 777, 4242]) {
    const world = new World(seed);
    const pts = sampleForest(world);
    assert.ok(pts.length > 2000, `only ${pts.length} forest samples`);
    const sum = { ancient: 0, pine: 0, light: 0, mixed: 0 };
    for (const { x, z, b } of pts) {
      const w = world.forestStand(x, z, b.m, b.t, b.h);
      for (const key of Object.keys(sum)) {
        assert.ok(w[key] >= 0 && w[key] <= 1, `${key} weight ${w[key]}`);
        sum[key] += w[key];
      }
      assert.ok(Math.abs(w.ancient + w.pine + w.light + w.mixed - 1) < 1e-9, 'weights partition the forest');
    }
    const share = (key) => sum[key] / pts.length;
    assert.ok(share('ancient') > 0.14 && share('ancient') < 0.26, `seed ${seed}: ancient ${share('ancient').toFixed(3)}`);
    assert.ok(share('pine') > 0.14 && share('pine') < 0.28, `seed ${seed}: pine ${share('pine').toFixed(3)}`);
    assert.ok(share('light') > 0.14 && share('light') < 0.28, `seed ${seed}: light ${share('light').toFixed(3)}`);
    assert.ok(share('mixed') > 0.28, `seed ${seed}: mixed ${share('mixed').toFixed(3)}`);
  }
});

test('stands are deterministic and only grow on forest ground', () => {
  const a = new World(99), b = new World(99);
  for (let i = 0; i < 400; i++) {
    const x = (i * 7919) % 30000 - 15000, z = (i * 104729) % 30000 - 15000;
    const ba = a.biomeAt(x, z);
    assert.deepEqual(a.forestStand(x, z, ba.m, ba.t, ba.h), b.forestStand(x, z, ba.m, ba.t, ba.h));
    if (ba.id !== 'forest') {
      assert.equal(forestStandAt(a, ba, x, z, 0), null, 'a stand outside the forest');
      assert.equal(forestGrassFactor(a, ba, x, z), 1);
    }
  }
});

test('old growth is wetter ground in kilometre-wide patches with soft edges', () => {
  const world = new World(20260612);
  let ancientM = 0, ancientN = 0, otherM = 0, otherN = 0;
  for (const { x, z, b } of sampleForest(world)) {
    const w = world.forestStand(x, z, b.m, b.t, b.h);
    if (w.ancient > 0.9) { ancientM += b.m; ancientN++; } else if (w.ancient < 0.1) { otherM += b.m; otherN++; }
  }
  assert.ok(ancientM / ancientN > otherM / otherN + 0.04, 'ancient forest should favour the wettest ground');

  // Walk rows and measure the run lengths of solid old growth and of the
  // edges between it and other stands.
  const runs = [], edges = [];
  const s = {};
  for (let z = -16000; z < 16000; z += 1499) {
    let run = 0, edgeStart = null;
    for (let x = -16000; x < 16000; x += 8) {
      const h = world.height(x, z), c = world.climate(x, z, h);
      if (world.classify(h, 0, c.t, c.m) !== 'forest') { if (run) runs.push(run); run = 0; edgeStart = null; continue; }
      world.forestStand(x, z, c.m, c.t, h, s);
      if (s.ancient > 0.5) run += 8; else if (run) { runs.push(run); run = 0; }
      if (s.ancient <= 0.1) edgeStart = x;
      if (s.ancient >= 0.9 && edgeStart !== null) { edges.push(x - edgeStart); edgeStart = null; }
    }
  }
  runs.sort((p, q) => p - q);
  edges.sort((p, q) => p - q);
  const longest = runs[runs.length - 1];
  assert.ok(longest > 1000, `the biggest patch is only ${longest} m across`);
  const medianEdge = edges[edges.length >> 1];
  assert.ok(medianEdge > 60, `stand edges are hard lines (${medianEdge} m)`);
});

test('every stand recipe is a valid tree mix', () => {
  for (const [name, stand] of Object.entries(FOREST_STANDS)) {
    const total = stand.mix.reduce((sum, [, w]) => sum + w, 0);
    assert.ok(Math.abs(total - 1) < 1e-6, `${name} mix sums to ${total}`);
    for (const [type] of stand.mix) assert.ok(VARIANT_COUNTS[type] > 0, `${name}: no ${type} variants`);
    for (const key of ['density', 'open', 'clumpFloor', 'clumpGain', 'scale', 'grass', 'shrubs', 'flowers']) {
      assert.ok(Number.isFinite(stand[key]), `${name}.${key}`);
    }
    const clutter = stand.clutter.mix.reduce((sum, [, w]) => sum + w, 0);
    assert.ok(Math.abs(clutter - 1) < 1e-6, `${name} clutter mix sums to ${clutter}`);
    for (const [type] of stand.clutter.mix) assert.ok(VARIANT_COUNTS[type] > 0, `${name}: no ${type} clutter`);
    const under = stand.understory.mix.reduce((sum, [, w]) => sum + w, 0);
    assert.ok(Math.abs(under - 1) < 1e-6, `${name} understory mix sums to ${under}`);
    for (const [cell] of stand.understory.mix) assert.ok(UNDERSTORY_SCALE[cell], `${name}: no understory cell ${cell}`);
  }
  assert.equal(UNDERSTORY_SCALE.length, 16, 'one scale per atlas cell');
  const ferns = FOREST_STANDS.ancient.understory.mix.filter(([cell]) => cell === 12 || cell === 13 || cell === 14)
    .reduce((sum, [, w]) => sum + w, 0);
  assert.ok(ferns > 0.6, 'the old-growth floor is ferns and moss');
  assert.ok(FOREST_STANDS.ancient.grass < 0.5, 'old growth is floored with moss, not grass');
  const giants = FOREST_STANDS.ancient.mix.filter(([type]) => type.startsWith('ancient'))
    .reduce((sum, [, w]) => sum + w, 0);
  assert.ok(giants > 0.5, 'old growth is mostly giants');
  assert.ok(FOREST_STANDS.light.density < RECIPES.forest.density, 'light woodland is sparser');
});
