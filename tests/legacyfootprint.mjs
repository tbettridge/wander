import test from 'node:test';
import assert from 'node:assert/strict';
import { Noise2D } from '../src/noise.js';
import { World } from '../src/world.js';
import { surveyLegacyFootprint } from '../src/legacyfootprint.mjs';

test('noise rectangle bounds include interior values across lattice boundaries', () => {
  for (const seed of [1, 4242, 20260612]) {
    const noise = new Noise2D(seed);
    for (const [x, z, size] of [[-1.03, 0.95, 0.12], [-120.4, 79.99, 0.02], [0, 0, 2]]) {
      const [low, high] = noise.fbmBounds(x, z, x + size, z + size, 3);
      for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) {
        const value = noise.fbm(x + size * i / 20, z + size * j / 20, 3);
        assert.ok(value >= low && value <= high);
      }
    }
  }
});

test('legacy support exclusion includes domain warp and never excludes sampled carving', () => {
  let excluded = 0, influenced = 0;
  for (const seed of [1, 4242, 20260612]) {
    const world = new World(seed);
    for (let i = -20; i <= 20; i++) {
      const x = i * 71.7, z = i * i * 13.1 - 3000;
      const possible = world._legacyRiverMayInfluence({ minX: x, minZ: z, maxX: x + 2, maxZ: z + 2 });
      if (!possible) excluded++;
      for (let dx = 0; dx <= 2; dx += 0.5) for (let dz = 0; dz <= 2; dz += 0.5) {
        const signal = world._riverSignalAt(x + dx, z + dz);
        if (Math.abs(signal) < 0.08) { influenced++; assert.equal(possible, true); }
      }
    }
  }
  assert.ok(excluded > 0 && influenced > 0);
});

function boxWorld(boxes) {
  return { seed: 1, generationVersion: 2, _legacyRiverMayInfluence: b => boxes.some(a =>
    a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ) };
}

test('footprint follows wide side branches and groups connected crossing anchors independently of input order', () => {
  const boxes = [
    { minX: 1, minZ: 1, maxX: 7, maxZ: 350 },
    { minX: 1, minZ: 200, maxX: 480, maxZ: 220 },
    { minX: 400, minZ: 160, maxX: 560, maxZ: 280 },
    { minX: -230, minZ: -230, maxX: -190, maxZ: -190 },
  ];
  const world = boxWorld(boxes), anchors = [{ id: 'a', x: 4, z: 10 },
    { id: 'b', x: 520, z: 210 }, { id: 'c', x: -210, z: -210 }];
  const result = surveyLegacyFootprint(world, anchors, { cellSize: 16, refinement: 1 });
  assert.equal(result.containment, 'closed');
  assert.equal(result.activationReady, false);
  assert.equal(result.components.length, 2);
  assert.ok(result.components.some(c => c.anchorIds.join(',') === 'a,b'));
  assert.ok(result.cells.some(c => c.x * 16 >= 544), 'wide lobe extends beyond a centreline buffer');
  assert.deepEqual(surveyLegacyFootprint(world, [...anchors].reverse(), { cellSize: 16, refinement: 1 }), result);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('corner-connected support is included and partial searches never claim containment', () => {
  const world = boxWorld([{ minX: 1, minZ: 1, maxX: 16, maxZ: 16 },
    { minX: 16, minZ: 16, maxX: 31, maxZ: 31 }]);
  const anchors = [{ id: 'a', x: 2, z: 2 }];
  const complete = surveyLegacyFootprint(world, anchors, { cellSize: 16 });
  assert.equal(complete.containment, 'closed');
  assert.ok(complete.cells.some(p => p.x === 1 && p.z === 1));
  for (const options of [{ maxCells: 1 }, { maxChecks: 1 }]) {
    const partial = surveyLegacyFootprint(world, anchors, { cellSize: 16, ...options });
    assert.equal(partial.containment, 'unresolved');
    assert.equal(partial.reason, 'legacy-footprint-budget');
    assert.equal(partial.activationReady, false);
  }
  const endless = { ...world, _legacyRiverMayInfluence: () => true };
  assert.equal(surveyLegacyFootprint(endless, anchors, { maxCells: 50 }).containment, 'unresolved');
  assert.throws(() => surveyLegacyFootprint(world, anchors, { maxChecks: Infinity }), /Invalid/);
});

test('interval bounds remain conservative and tighter in flat parts of the actual noise lattice', () => {
  const noise = new Noise2D(4242);
  let improved = 0;
  for (let k = 0; k < 100; k++) {
    const x = k * 0.173 - 8, z = k * 0.271 - 11, size = 0.03;
    const [lo, hi] = noise.fbmBounds(x, z, x + size, z + size, 3);
    const oldWidth = 2 * 1.42 * (1 + 3 * 1.875) * (3 / 1.75) * size;
    if (hi - lo < oldWidth / 2) improved++;
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
      const value = noise.fbm(x + i * size / 10, z + j * size / 10, 3);
      assert.ok(value >= lo && value <= hi);
    }
  }
  assert.ok(improved > 80);
  assert.deepEqual(noise.noiseBounds(-1000, -1000, 1000, 1000), [-2.84, 2.84]);
});

test('source closure checks the projected route grid and keeps uncertain budgets conservative', () => {
  const world = new World(1);
  const bounds = { minX: 0, minZ: 0, maxX: 16, maxZ: 16 };
  world._riverPlanSample = (x, z) => ({ centerX: x * 24 + 240, centerZ: z * 24, route: x >= 10 ? 1 : 0 });
  assert.equal(world._legacyRiverRouteMayInfluence(bounds), true,
    'dry local route samples do not exclude an active projected centre');
  world._riverPlanSample = (x, z) => ({ centerX: x * 24, centerZ: z * 24, route: 0 });
  assert.equal(world._legacyRiverRouteMayInfluence(bounds), false);
  const budget = { remaining: 1 };
  assert.equal(world._legacyRiverRouteMayInfluence(bounds, budget), true);
  assert.equal(budget.remaining, 0);
  world._legacyRiverMayInfluence = () => true;
  // A finite source gate closes an otherwise endless noise band.
  world._legacyRiverRouteMayInfluence = b => b.minX < 32 && b.maxX > -32 && b.minZ < 32 && b.maxZ > -32;
  const result = surveyLegacyFootprint(world, [{ id: 'source', x: 0, z: 0 }], { cellSize: 16 });
  assert.equal(result.containment, 'closed');
  assert.ok(result.diagnostics.sourceExcludedCells > 0);
});

test('source certificates never exclude actual legacy carving on real terrain', () => {
  let closures = 0;
  for (const seed of [1, 4242, 20260612]) {
    const world = new World(seed);
    for (let i = -30; i <= 30; i++) {
      const x = i * 139.3, z = i * i * 17.1 - 3000;
      const bounds = { minX: x, minZ: z, maxX: x + 16, maxZ: z + 16 };
      if (world._legacyRiverRouteMayInfluence(bounds)) continue;
      closures++;
      for (let dx = 0; dx <= 16; dx += 4) for (let dz = 0; dz <= 16; dz += 4) {
        const out = {};
        world.height(x + dx, z + dz, out);
        assert.equal(out.riverInfluence, false);
      }
    }
  }
  assert.ok(closures > 0, 'real suppressed headwaters are exercised');
});

test('a completed component remains identifiable when another component exhausts the search', () => {
  const world = boxWorld([{ minX: 1, minZ: 1, maxX: 2, maxZ: 2 },
    { minX: 1000, minZ: 1000, maxX: 10000, maxZ: 10000 }]);
  const result = surveyLegacyFootprint(world, [{ id: 'small', x: 1.5, z: 1.5 },
    { id: 'large', x: 1001, z: 1001 }], { cellSize: 64, maxCells: 20 });
  assert.equal(result.containment, 'unresolved');
  assert.equal(result.components.find(c => c.anchorIds.includes('small')).containment, 'closed');
  assert.equal(result.components.find(c => c.anchorIds.includes('large')).containment, 'unresolved');
  assert.equal(result.diagnostics.closedComponents, 1);
  assert.equal(result.activationReady, false);
});

test('deep ocean is an explicit terminal while uncertain coast remains searchable', () => {
  const world = boxWorld([{ minX: 1, minZ: 1, maxX: 200, maxZ: 15 }]);
  world._legacyRiverOceanOwns = bounds => bounds.minX >= 64;
  const result = surveyLegacyFootprint(world, [{ id: 'mouth', x: 2, z: 2 }], { cellSize: 16 });
  assert.equal(result.containment, 'closed');
  assert.equal(result.components[0].containment, 'closed');
  assert.ok(result.terminals.some(cell => cell.x === 4 && cell.z === 0 && cell.kind === 'ocean'));
  assert.ok(result.diagnostics.oceanTerminalCells > 0);
  assert.equal(result.activationReady, false);
});

test('real deep-ocean certificates include both centre projections and stay submerged', () => {
  let certified = 0;
  for (const seed of [1, 4242, 20260612]) {
    const world = new World(seed);
    for (let z = -24000; z <= 24000 && certified < 3; z += 2000) {
      for (let x = -24000; x <= 24000 && certified < 3; x += 2000) {
        const bounds = { minX: x, minZ: z, maxX: x + 64, maxZ: z + 64 };
        if (!world._legacyRiverOceanOwns(bounds)) continue;
        certified++;
        const margin = 272, baseBounds = world._legacyRiverBaseBounds({
          minX: x - margin, minZ: z - margin, maxX: x + 64 + margin, maxZ: z + 64 + margin,
        });
        assert.ok(baseBounds[1] <= -12);
        for (let dz = 0; dz <= 64; dz += 16) for (let dx = 0; dx <= 64; dx += 16) {
          assert.ok(world._naturalHeight(x + dx, z + dz) < 0);
          const river = {};
          world.height(x + dx, z + dz, river);
          assert.ok(river.waterY < 0);
        }
      }
    }
  }
  assert.equal(certified, 3);
});
