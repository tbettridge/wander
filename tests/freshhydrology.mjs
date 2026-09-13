import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { prepareFreshRegion } from '../src/hydrologyworker.js';
import { trailsAround, clearTrailCache, analyzeTerrainRoute, trailFrameAtArc } from '../src/trails.js';
import { solveCrossing, deckHeightAt } from '../src/trailcrossings.mjs';
import { buildScatter } from '../src/chunkgen.js';
import { buildCrossingRecipe } from '../src/crossinggeometry.mjs';
import { waterPreviewSpawn } from '../src/hydrologypreview.mjs';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import { descriptorHash } from '../src/hydrologyformat.mjs';

test('fresh geography installs new rivers and basins without legacy carving or frozen crossings', () => {
  const { plan } = prepareFreshRegion({ seed: 20260612, regionX: 0, regionZ: 0 });
  assert.equal(plan.generationVersion, 3);
  assert.ok(plan.reaches.length > 0 && plan.basins.length > 0);
  assert.ok(plan.reaches.some(reach => reach.points.at(-1).arc > 600), 'include inland river extent');
  assert.equal(prepareFreshRegion({ seed: plan.seed, regionX: 0, regionZ: 0 }).plan.hash, plan.hash);
  const world = new World(plan.seed, { waterPlans: [plan] });
  assert.equal(world.generationVersion, 3);
  assert.equal(world.layoutWorld, undefined);
  assert.equal(world.preservedCrossings.size, 0);
  assert.equal(world.preservedRoutes.size, 0);
  const legacy = new World(plan.seed);
  let removed = 0;
  for (let z = -1000; z < -500; z += 25) for (let x = -1000; x < -500; x += 25) {
    const natural = world._naturalHeight(x, z), sample = {};
    if (world.waterField.sample(x, z, natural, sample)) continue;
    assert.equal(world.height(x, z), natural);
    assert.equal(world.riverAt(x, z).wet, false);
    if (Math.abs(legacy.height(x, z) - natural) > 0.25) removed++;
  }
  assert.ok(removed > 0);
  assert.throws(() => legacy.installWaterPlans([plan]), /generation mismatch/);
  assert.equal(legacy.waterField, undefined);
  const river = plan.reaches[0], p = river.points[Math.floor(river.points.length / 2)];
  const sample = {};
  world.height(p.x, p.z, sample);
  assert.equal(sample.bodyId, river.id);
  assert.ok(sample.signedDepth > 0);
});

test('fresh trail analysis detects a narrow channel between the old eight-metre probes', () => {
  const world = { generationVersion: 3, height: () => 3,
    riverAt: x => ({ wet: x > 2 && x < 5, depth: x > 2 && x < 5 ? 1 : 0 }) };
  const result = analyzeTerrainRoute(world, [0, 0, 16, 0]);
  assert.equal(result.fords.length, 1);
  assert.equal(result.fords[0].maxDepth, 1);
  assert.ok(result.fords[0].arcStart >= 2 && result.fords[0].arcEnd <= 5);
});

test('separate fresh channels do not turn intervening dry land into one bridge span', () => {
  const world = { generationVersion: 3, height: () => 3,
    riverAt: x => ({ wet: (x > 2 && x < 6) || (x > 22 && x < 26), depth: 1 }) };
  const result = analyzeTerrainRoute(world, [0, 0, 32, 0]);
  assert.equal(result.fords.length, 2);
  assert.ok(result.fords.every(ford => ford.arcEnd - ford.arcStart < 5));
});

test('all four regenerated crossing kinds build against new water and expose matching walking heights', () => {
  const seen = new Set();
  for (const seed of [1, 3, 4, 7]) {
    const { plan } = prepareFreshRegion({ seed, regionX: 0, regionZ: 0 });
    const world = new World(plan.seed, { waterPlans: [plan] });
    clearTrailCache();
    const edges = trailsAround(world, 2048, 2048, plan.seed, 5000, []);
    const crossings = edges.flatMap(edge => (edge.fords || []).map(ford => ({ edge, solved: solveCrossing(world, edge, ford) })))
      .filter(entry => entry.solved);
    assert.ok(crossings.length > 0, 'find crossings through runtime route generation, without frozen fixtures');
    for (const { edge, solved } of crossings) {
      seen.add(solved.kind);
      assert.ok(solved.surfaceY > solved.waterY);
      for (const arc of [solved.arcStart, solved.arcEnd]) {
        const p = trailFrameAtArc(edge, arc, {});
        assert.equal(world.riverAt(p.x, p.z).wet, false);
      }
      const scatter = buildScatter(world, Math.floor(solved.x / 140), Math.floor(solved.z / 140), 140,
        { mode: 'full', res: 64, audit: true });
      const record = scatter.trailRecords.find(record => record.edgeId === edge.id && record.kind === solved.kind);
      assert.ok(record, 'actual chunk construction must build the solved crossing');
      assert.equal(record.surfaceY, solved.surfaceY);
      if (!solved.walkable) {
        if (solved.kind === 'log') {
          const ford = edge.fords.find(ford => solveCrossing(world, edge, ford)?.kind === 'log');
          const recipe = buildCrossingRecipe(world, edge, ford, record.id, solved);
          const log = recipe.instances.find(instance => instance.type === 'crossingLog');
          assert.ok(log);
          assert.ok(scatter.some(batch => batch.type === 'crossingLog' && batch.matrices.length > 0));
          // The model's local X endpoints are +/-1.35. Use its actual
          // construction transform, not independently reconstructed positions.
          for (const sign of [-1, 1]) {
            const x = log.matrix[12] + sign * 1.35 * log.matrix[0];
            const z = log.matrix[14] + sign * 1.35 * log.matrix[2];
            assert.equal(world.riverAt(x, z).wet, false);
            assert.ok(Math.abs(world.height(x, z) - solved.surfaceY) <= 0.42);
          }
          const surface = new WalkableSurface(world, { seed, trailsAround });
          for (let along = -solved.span / 2; along <= solved.span / 2; along += 0.25) {
            const x = solved.x + along * solved.tangentX, z = solved.z + along * solved.tangentZ;
            const y = surface.heightAt(x, z);
            assert.ok(y > solved.surfaceY && y < solved.surfaceY + 0.25, 'walk on the trunk top');
          }
          assert.equal(deckHeightAt([solved], new Map(), solved.x - solved.tangentZ * 0.3,
            solved.z + solved.tangentX * 0.3), null, 'the log does not become a trail-wide deck');
          continue;
        }
        assert.equal(deckHeightAt([solved], new Map([[edge.id, edge]]), solved.x, solved.z), null,
          'individual stones must not create an invisible continuous deck');
        const stones = scatter.trailRecords.filter(record => record.edgeId === edge.id && record.kind === 'stepping-stone');
        assert.ok(stones.length >= 3);
        for (const stone of stones) assert.ok(stone.surfaceY >= stone.waterY);
        assert.ok(scatter.some(batch => batch.type === 'boulder' && batch.matrices.length > 0));
        continue;
      }
      assert.ok(scatter.some(batch => batch.type === 'plank' && batch.matrices.length > 0));
      const edgeMap = new Map([[edge.id, edge]]);
      for (let arc = solved.arcStart; arc <= solved.arcEnd; arc += 0.25) {
        const p = trailFrameAtArc(edge, arc, {});
        assert.equal(deckHeightAt([solved], edgeMap, p.x, p.z), record.surfaceY);
      }
    }
    const spawn = waterPreviewSpawn(world, '?waterPreviewTarget=crossing');
    assert.ok(spawn?.crossingId, 'the review entry must find a regenerated crossing');
    assert.equal(world.riverAt(spawn.x, spawn.z).wet, false);
  }
  assert.deepEqual([...seen].sort(), ['bridge', 'log', 'plank-bridge', 'stepping-stones']);
});

test('fresh trail routing does not reuse the same seeds legacy caches', () => {
  const { plan } = prepareFreshRegion({ seed: 20260612, regionX: 0, regionZ: 0 });
  const fresh = new World(plan.seed, { waterPlans: [plan] });
  clearTrailCache();
  trailsAround(new World(plan.seed), 2048, 2048, plan.seed, 2048, []);
  const warmed = trailsAround(fresh, 2048, 2048, plan.seed, 2048, []);
  clearTrailCache();
  const cold = trailsAround(fresh, 2048, 2048, plan.seed, 2048, []);
  assert.ok(cold.length > 0);
  assert.equal(descriptorHash(warmed), descriptorHash(cold));
});
