import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planBasins } from '../src/basinplanner.mjs';
import { planLakeSystem } from '../src/basininlets.mjs';
import { prepareBasinDrainagePreview } from '../src/hydrologyworker.js';
import { SparseRiverComponentField } from '../src/riversparsemesh.mjs';
import { buildTerrainArrays, buildRiver } from '../src/chunkgen.js';

test('outlet alternatives cover multiple seeds and a neighbouring forest-lake region within bounded work', () => {
  const accepted = [], kinds = new Set();
  for (const [seed, x, z] of [[42, 0, 0], [4242, 0, 0], [4242, 1, 0], [1, 0, 0], [3, 0, 0]]) {
    const world = new World(seed, { generationVersion: 3 });
    for (const basin of planBasins(world, x, z).basins) {
      const result = planLakeSystem(world, basin);
      assert.ok((result.visited || 0) <= 8192);
      assert.ok((result.inletDiagnostics?.visited || 0) <= 8192);
      if (result.status !== 'baked') {
        assert.equal(result.mesh, undefined);
        assert.equal(result.activationReady, false);
        continue;
      }
      assert.ok(result.attempts <= 12);
      assert.ok(result.mesh.grid.coords.length <= 65536);
      assert.doesNotThrow(() => new SparseRiverComponentField(JSON.parse(JSON.stringify(result.mesh))));
      accepted.push(result); kinds.add(basin.kind);
    }
  }
  assert.ok(accepted.length >= 5);
  assert.deepEqual([...kinds].sort(), ['lake', 'pond']);
  assert.ok(accepted.filter(r => r.inletCount > 0).length >= 2);
});

test('forest lake inlet and outlet render across a region edge without LOD shoreline changes', () => {
  const preview = prepareBasinDrainagePreview({ seed: 4242, regionX: 1, regionZ: 0, basinId: 'basin:4242:5408:48' });
  assert.equal(preview.basinKind, 'lake');
  assert.ok(preview.inletCount > 0);
  const world = new World(4242, { waterPlans: [preview.plan] });
  const cx = Math.floor(preview.target.x / 140);
  // The lake sits beside z=0: both sides of the region boundary use the
  // same globally anchored terrain and water grid from one serialized plan.
  for (const cz of [-1, 0]) {
    const low = buildTerrainArrays(world, cx, cz, 16, 140), high = buildTerrainArrays(world, cx, cz, 96, 140);
    assert.deepEqual(low.positions, high.positions);
    assert.deepEqual(buildRiver(cx, cz, 16, 140, low.river), buildRiver(cx, cz, 96, 140, high.river));
  }
});

test('distant forest and negative-coordinate stream-fed basins retain continuous supported water', () => {
  for (const [seed, rx, rz, id, minInlets] of [
    [987654, 2, -3, 'basin:987654:8704:-10240', 0],
    [1, -8, -5, 'basin:1:-32720:-18256', 2],
  ]) {
    const world = new World(seed, { generationVersion: 3 });
    const basin = planBasins(world, rx, rz).basins.find(b => b.id === id);
    assert.ok(basin);
    const system = planLakeSystem(world, basin);
    assert.equal(system.status, 'baked');
    assert.ok(system.inletCount >= minInlets);
    assert.ok(system.visited <= 8192 && system.inletDiagnostics.visited <= 8192);
    const field = new SparseRiverComponentField(JSON.parse(JSON.stringify(system.mesh)));
    for (const reach of system.component.reaches) for (let i = 1; i < reach.points.length; i++) {
      const a = reach.points[i - 1], b = reach.points[i];
      assert.ok(b.waterY <= a.waterY + 1e-9);
      if (a.depth < 0.2 || a.arc < 10) continue;
      for (const t of [0, 0.5]) {
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, sample = {};
        assert.ok(field.sample(x, z, world.height(x, z), sample));
        assert.ok(sample.signedDepth > 0, 'channel must not contain a dry break');
      }
    }
  }
});

test('unsuitable taiga, savanna and grassland outlets leave valid closed basins', async () => {
  const { descriptorHash } = await import('../src/hydrologyformat.mjs');
  for (const [seed, rx, rz, id] of [
    [1, -3, -2, 'basin:1:-9592:-5512'],
    [42, 1, 0, 'basin:42:6152:1040'],
    [6, 0, 0, 'basin:6:1504:3464'],
  ]) {
    const natural = new World(seed, { generationVersion: 3 });
    const basin = planBasins(natural, rx, rz).basins.find(b => b.id === id);
    assert.ok(basin);
    assert.notEqual(planLakeSystem(natural, basin, { inland: false }).status, 'baked');
    const payload = { version: 1, generationVersion: 3, preview: true, seed,
      regionX: rx, regionZ: rz, basins: [basin], components: [] };
    const world = new World(seed, { waterPlans: [{ ...payload, hash: descriptorHash(payload) }] });
    const g = basin.grid;
    let deepest = 0;
    for (let i = 1; i < g.signed.length; i++) if (g.signed[i] > g.signed[deepest]) deepest = i;
    const x = g.x0 + deepest % g.cols * g.step, z = g.z0 + Math.floor(deepest / g.cols) * g.step;
    assert.ok(world.riverAt(x, z).wet, 'rejected drainage must not discard the contained lake');
    assert.ok(world.height(x, z) < basin.level);
  }
});

test('bank-aware outlet routing recovers a forest stream-fed pond without weakening fit budgets', () => {
  const natural = new World(7, { generationVersion: 3 });
  const basin = planBasins(natural, -2, 3).basins.find(b => b.id === 'basin:7:-5768:12848');
  const previous = planLakeSystem(natural, basin, { outlet: { hydraulicRouting: false }, inland: false });
  const current = planLakeSystem(natural, basin);
  assert.notEqual(previous.status, 'baked');
  assert.equal(current.status, 'baked');
  assert.ok(current.inletCount >= 1);
  assert.ok(current.visited <= 8192 && current.inletDiagnostics.visited <= 8192);
  assert.equal(current.mesh.hash, planLakeSystem(natural, basin).mesh.hash);
  assert.doesNotThrow(() => new SparseRiverComponentField(JSON.parse(JSON.stringify(current.mesh))));
  for (const reach of current.component.reaches) {
    assert.equal(reach.maxFill, 2); assert.equal(reach.maxCut, 6); assert.equal(reach.maxGrade, 0.025);
    for (let i = 1; i < reach.points.length; i++) assert.ok(reach.points[i].waterY <= reach.points[i - 1].waterY + 1e-9);
  }
});
