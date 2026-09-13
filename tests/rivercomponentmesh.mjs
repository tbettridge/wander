import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { fitRiverComponent } from '../src/rivercomponent.mjs';
import { bakeRiverComponent, RiverComponentMeshField } from '../src/rivercomponentmesh.mjs';
import { buildTerrainArrays, buildRiver, sampleRenderedTerrainTriangle } from '../src/chunkgen.js';

function fixture() {
  const world = new World(1, { generationVersion: 3 });
  world._naturalHeight = (x, z, out) => { if (out) out.h = 5; return 5; };
  const join = { id: 'join', x: 0, z: 0, waterY: 3 };
  const route = (id, a, b) => ({ id, status: 'candidate', sourceClosure: false, oceanMouth: false, points: [a, b] });
  const input = { status: 'candidate', reaches: [
    route('a', { id: 'a', x: -50, z: -100, waterY: 3 }, join),
    route('b', { id: 'b', x: 50, z: -100, waterY: 3 }, join),
    route('out', join, { id: 'out', x: 0, z: 100, waterY: 3 }),
  ], junctions: [{ id: 'junction:join', nodeId: 'join' }] };
  return { world, component: fitRiverComponent(world, input, { junctionLength: 64, maxFill: 0 }) };
}

test('joined channel grid has continuous wet approaches and one level through the confluence', () => {
  const { world, component } = fixture();
  const mesh = bakeRiverComponent(world, component);
  assert.equal(mesh.status, 'baked');
  assert.equal(mesh.activationReady, false);
  const reversed = bakeRiverComponent(world, { ...component, reaches: [...component.reaches].reverse() });
  assert.equal(reversed.hash, mesh.hash);
  world.waterField = new RiverComponentMeshField(JSON.parse(JSON.stringify(mesh)));
  const head = component.junctions[0].waterY;
  for (const reach of component.reaches) for (const p of reach.points) {
    if (Math.hypot(p.x, p.z) > 48) continue;
    const water = world.riverAt(p.x, p.z);
    assert.equal(water.wet, true);
    assert.ok(Math.abs(water.y - head) < 1e-8);
  }
  for (let z = -2; z <= 2; z += 0.25) for (let x = -2; x <= 2; x += 0.25) {
    assert.equal(world.riverAt(x, z).wet, true, 'no dry wall across the tributary mouths');
  }
});

test('production terrain/water builders mesh the junction with matching shoreline triangles and chunk edges', () => {
  const { world, component } = fixture();
  const mesh = bakeRiverComponent(world, component);
  assert.equal(mesh.status, 'baked');
  world.waterField = new RiverComponentMeshField(mesh);
  let contacts = 0;
  const chunks = new Map();
  for (const cx of [-1, 0]) for (const cz of [-1, 0]) {
    const terrain = buildTerrainArrays(world, cx, cz, 8, 40);
    assert.equal(terrain.res, 20);
    assert.deepEqual(buildTerrainArrays(world, cx, cz, 64, 40).river, terrain.river);
    const river = buildRiver(cx, cz, 8, 40, terrain.river);
    assert.ok(river?.positions.length > 0);
    for (let i = 0; i < river.wet.length; i++) {
      if (river.wet[i] > 1e-6) continue;
      const [x, y, z] = river.positions.slice(i * 3, i * 3 + 3);
      const ground = sampleRenderedTerrainTriangle(terrain.positions, terrain.res, 40, cx * 40, cz * 40, x, z).y;
      assert.ok(Math.abs(y - ground) < 0.002);
      contacts++;
    }
    chunks.set(`${cx},${cz}`, terrain);
  }
  assert.ok(contacts > 20);
  for (const cz of [-1, 0]) {
    const left = chunks.get(`-1,${cz}`), right = chunks.get(`0,${cz}`);
    for (let row = 0; row <= 20; row++) {
      const a = (row * 21 + 20) * 3, b = row * 21 * 3;
      assert.deepEqual(left.positions.slice(a, a + 3), right.positions.slice(b, b + 3));
    }
  }
});

test('component mesh rejects excess size, unsupported fill and corrupt serialized grids', () => {
  const { world, component } = fixture();
  assert.equal(bakeRiverComponent(world, component, { maxCells: 10 }).reason, 'component-mesh-budget');
  const low = { seed: 1, _naturalHeight: () => 1 };
  assert.equal(bakeRiverComponent(low, component).reason, 'junction-bank-fill');
  const mesh = bakeRiverComponent(world, component);
  mesh.grid.floor[0] += 1;
  assert.throws(() => new RiverComponentMeshField(mesh), /identity/);
});
