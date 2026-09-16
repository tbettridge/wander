import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRiverNetwork } from '../src/rivernetwork.mjs';
import { bakeSparseRiverComponent, SparseRiverComponentField } from '../src/riversparsemesh.mjs';
import { prepareNetworkPreview } from '../src/hydrologyworker.js';
import { descriptorHash } from '../src/hydrologyformat.mjs';
import { waterPreviewSpawn } from '../src/hydrologypreview.mjs';
import { buildTerrainArrays, buildRiver, sampleRenderedTerrainTriangle } from '../src/chunkgen.js';

const request = { seed: 20260612, regionX: 0, regionZ: 0 };
const preview = prepareNetworkPreview(request), mesh = preview.plan.components[0];
const world = new World(request.seed, { waterPlans: [JSON.parse(JSON.stringify(preview.plan))] });
const sources = [
  { x: 2958.222222222222, z: 2958.222222222222 },
  { x: 2958.222222222222, z: 3413.3333333333335 },
  { x: 3413.3333333333335, z: 3413.3333333333335 },
];
const natural = new World(request.seed, { generationVersion: 3 });
const component = planRiverNetwork(natural, sources, { mouthLength: 64 }).components[0];
const rehash = m => { const { status, activationReady, hash, ...p } = m; m.hash = descriptorHash(p); return m; };

test('sparse network fits its budget, preserves both joins and hands its mouth to the sea', () => {
  assert.equal(mesh.version, 3);
  assert.equal(mesh.oceanHandoff, true);
  assert.ok(mesh.grid.coords.length < 30000);
  const b = mesh.bounds;
  assert.ok((b.maxX - b.minX) * (b.maxZ - b.minZ) / 4 > 65536);
  assert.equal(bakeSparseRiverComponent(natural, { ...component, reaches: [...component.reaches].reverse() }).hash, mesh.hash);
  for (const j of component.junctions) {
    assert.ok(world.riverAt(j.x, j.z).wet);
    assert.ok(Math.abs(world.riverAt(j.x, j.z).y - j.waterY) < 1e-8);
  }
  for (const r of component.reaches) for (const p of r.points) {
    if (p.depth > 0.3 && p.arc > 8 && p.arc < r.points.at(-1).arc - 8) {
      const water = {};
      world.height(p.x, p.z, water);
      assert.ok(water.signedDepth > 0, 'channel continues into ocean-owned water');
    }
  }
  const mouth = component.reaches.find(r => r.oceanMouth).points.at(-1), out = {};
  world.height(mouth.x, mouth.z, out);
  assert.ok(Math.abs(out.waterY) < 1e-9);
  assert.ok(out.estuary > 0.99);
  assert.ok(Math.abs(world.height(mouth.x, mouth.z) - natural.height(mouth.x, mouth.z)) < 0.002);
  for (let i = 0; i < mesh.grid.floor.length; i++) {
    assert.ok(mesh.grid.floor[i] <= mesh.grid.natural[i] + 1e-7);
    assert.ok(mesh.grid.natural[i] - mesh.grid.floor[i] <= 6 + 1e-7);
  }
  const spawn = waterPreviewSpawn(world, '?waterPreview=network');
  assert.ok(spawn && !world.riverAt(spawn.x, spawn.z).wet);
});

test('sparse production geometry retains exact shores and low/high LOD agreement through the worker', async () => {
  const cx = Math.floor(preview.target.x / 140), cz = Math.floor(preview.target.z / 140);
  const terrain = buildTerrainArrays(world, cx, cz, 16, 140);
  const river = buildRiver(cx, cz, 16, 140, terrain.river);
  const high = buildTerrainArrays(world, cx, cz, 96, 140);
  assert.deepEqual(high.positions, terrain.positions);
  assert.deepEqual(buildRiver(cx, cz, 96, 140, high.river), river);
  let contacts = 0;
  for (let i = 0; i < river.wet.length; i++) {
    if (river.wet[i] > 1e-6) continue;
    const [x, y, z] = river.positions.slice(i * 3, i * 3 + 3);
    const ground = sampleRenderedTerrainTriangle(terrain.positions, terrain.res, 140, cx * 140, cz * 140, x, z).y;
    assert.ok(Math.abs(y - ground) < 0.002); contacts++;
  }
  assert.ok(contacts > 20);
  const previousSelf = globalThis.self, messages = [];
  try {
    globalThis.self = { postMessage(m, transfer = []) { messages.push(structuredClone(m, { transfer })); } };
    await import('../src/worker.js?sparse-network-test');
    self.onmessage({ data: { type: 'init', seed: world.seed, waterPlans: [preview.plan] } });
    assert.equal(messages.at(-1).type, 'ready');
    self.onmessage({ data: { type: 'build', id: 5, cx, cz, res: 16, chunkSize: 140, doTerrain: true, waterPlanHash: world.waterPlanHash } });
    assert.equal(messages.at(-1).type, 'built');
    assert.deepEqual(messages.at(-1).river, river);
    assert.deepEqual(messages.at(-1).terrain.positions, terrain.positions);
  } finally { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; }
});

test('sparse validation rejects broken shores, duplicate coordinates and excess budgets', () => {
  assert.throws(() => planRiverNetwork(natural, [], { mouthLength: -1 }), /budget/);
  assert.equal(bakeSparseRiverComponent(natural, component, { maxCells: 100 }).reason, 'component-mesh-budget');
  const duplicate = structuredClone(mesh);
  duplicate.grid.coords[1] = duplicate.grid.coords[0];
  assert.throws(() => new SparseRiverComponentField(rehash(duplicate)), /Duplicate/);
  const broken = structuredClone(mesh), g = broken.grid;
  const hole = g.coords.findIndex(([x, z]) => x * 2 === preview.target.x && z * 2 === preview.target.z);
  assert.ok(hole >= 0);
  for (const values of Object.values(g)) if (Array.isArray(values)) values.splice(hole, 1);
  assert.throws(() => new SparseRiverComponentField(rehash(broken)), /collar/);
  const field = new SparseRiverComponentField(mesh), sample = {};
  assert.equal(field.sample(mesh.bounds.maxX - 10, mesh.bounds.minZ + 10, 5, sample), false);
  assert.equal(field.gridStep(mesh.bounds.maxX - 10, mesh.bounds.minZ, mesh.bounds.maxX, mesh.bounds.minZ + 10), null);
});
