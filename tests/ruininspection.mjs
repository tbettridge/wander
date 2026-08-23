import assert from 'node:assert/strict';
import test from 'node:test';
import { createFortifiedOutpostPlan } from '../src/fortifiedoutpost.mjs';
import { createFortifiedDungeonPlan } from '../src/fortifieddungeon.mjs';
import {
  inspectFortifiedDungeonTraversal,
  inspectFortifiedOutpostTraversal,
} from '../src/ruininspection.mjs';

test('renderer-free outpost traversal inspection catches and clears proxy route defects', () => {
  for (const seed of [0, 1, 7, 41, 93, 1001, 9999]) {
    const report = inspectFortifiedOutpostTraversal(createFortifiedOutpostPlan(seed));
    assert.equal(report.valid, true, `seed ${seed}: ${report.errors.join(', ')}`);
    assert.equal(report.route.clear, true, `seed ${seed} route proxy intersection`);
    assert.equal(report.route.continuous, true, `seed ${seed} route continuity`);
    assert.equal(report.ramp.monotonic, true, `seed ${seed} ramp monotonicity`);
    assert.ok(report.ramp.grade <= 0.34, `seed ${seed} ramp grade ${report.ramp.grade}`);
    assert.equal(report.lookoutPreserved, true, `seed ${seed} lookout preservation`);
  }
});

test('renderer-free dungeon inspection covers every protected spine edge', () => {
  for (const seed of Array.from({ length: 256 }, (_, index) => index)) {
    const plan = createFortifiedDungeonPlan(seed);
    const report = inspectFortifiedDungeonTraversal(plan, {
      runtime: { snapshot: () => [plan.id] },
      terrainAt: () => plan.entrance.surface.y,
    });
    assert.equal(report.valid, true, `seed ${seed}: ${report.errors.join(', ')}`);
    assert.equal(report.route.continuous, true, `seed ${seed} route continuity`);
    assert.deepEqual(report.claims.unclaimedMainPathNodes, [], `seed ${seed} claim coverage`);
    assert.equal(report.runtimeReady, true);
    assert.equal(report.runtimeActive, 1);
    assert.equal(report.entropy.eventCount, 1);
  }
});

console.log('ruininspection PASS · deterministic outpost/dungeon route/collision/ramp probes');
