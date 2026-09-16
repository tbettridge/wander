import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planBasins } from '../src/basinplanner.mjs';
import { planBasinDrainage } from '../src/basinoutlet.mjs';
import { wetBasinAt } from '../src/basinmembership.mjs';
import { RiverReachField } from '../src/riverterrain.mjs';
import { SparseRiverComponentField } from '../src/riversparsemesh.mjs';
import { descriptorHash } from '../src/hydrologyformat.mjs';
import { waterPreviewSpawn } from '../src/hydrologypreview.mjs';
import { prepareBasinDrainagePreview } from '../src/hydrologyworker.js';
import { buildTerrainArrays, buildRiver, sampleRenderedTerrainTriangle } from '../src/chunkgen.js';

const request = { seed: 4242, regionX: 0, regionZ: 0, basinId: 'basin:4242:288:3912' };
const natural = new World(request.seed, { generationVersion: 3 });
const basin = planBasins(natural, 0, 0).basins.find(b => b.id === 'basin:4242:288:3912');
const drainage = planBasinDrainage(natural, basin);
const preview = prepareBasinDrainagePreview(request);
const world = new World(request.seed, { waterPlans: [JSON.parse(JSON.stringify(preview.plan))] });

test('generated pond has one continuous, cut-only outlet ending in the actual sea', () => {
  assert.equal(drainage.status, 'baked');
  assert.equal(drainage.mesh.hash, planBasinDrainage(natural, basin).mesh.hash);
  assert.equal(drainage.mesh.hash, preview.plan.components[0].hash);
  assert.equal(drainage.activationReady, false);
  assert.equal(drainage.mesh.oceanHandoff, true);
  assert.ok(drainage.mesh.grid.coords.length < 16000);
  const reach = drainage.component.reaches[0], mouth = reach.points.at(-1), sample = {};
  assert.ok(mouth.arc > 500);
  assert.ok(natural._naturalHeight(mouth.x, mouth.z) < -0.25);
  const lake = world.riverAt(basin.centerX, basin.centerZ);
  assert.equal(lake.kind, 'pond');
  assert.ok(lake.wet);
  assert.ok(Math.abs(lake.y - basin.level) < 1e-9);
  assert.ok(Math.abs(world.height(basin.centerX, basin.centerZ) - natural.height(basin.centerX, basin.centerZ)) < 1e-6);
  for (let i = 1; i < reach.points.length; i++) {
    const a = reach.points[i - 1], b = reach.points[i];
    assert.ok(b.waterY <= a.waterY + 1e-9);
    for (let t = 0; t < 1; t += 0.25) {
      world.height(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, sample);
      assert.ok(sample.signedDepth > 0, 'no dry break between the pond and ocean');
    }
  }
  world.height(mouth.x, mouth.z, sample);
  assert.equal(sample.waterY, 0);
  assert.ok(sample.estuary > 0.99);
  const g = drainage.mesh.grid, field = new RiverReachField(reach);
  let contacts = 0, separateHollows = 0;
  for (let i = 0; i < g.coords.length; i++) {
    const [ix, iz] = g.coords[i], x = ix * 2, z = iz * 2;
    assert.ok(g.floor[i] <= g.natural[i] + 1e-7);
    assert.ok(g.natural[i] - g.floor[i] <= 6 + 1e-7);
    const connectedLake = wetBasinAt([drainage.basin], x, z);
    if (connectedLake && field.sample(x, z, g.natural[i], sample)) {
      assert.ok(Math.abs(sample.waterY - basin.level) < 1e-9, 'interpolated river head matches lake at every shared vertex');
      contacts++;
    }
    const b = basin.bounds;
    if (!connectedLake && g.natural[i] < basin.level && x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) {
      assert.equal(g.lakeKind[i], 0, 'separate low hollows do not acquire pond ownership');
      separateHollows++;
    }
  }
  assert.ok(contacts > 0, 'the route genuinely overlaps the connected pond');
  assert.ok(separateHollows > 10);
  const spawn = waterPreviewSpawn(world, '?waterPreview=drainage');
  assert.ok(spawn && !world.riverAt(spawn.x, spawn.z).wet, 'full-game preview starts on a dry pond bank');
});

test('lake drainage rejects unfinished routes and budgets without creating installable plans', () => {
  assert.equal(planBasinDrainage(natural, basin, { maxVisited: 1 }).stage, 'routing');
  assert.equal(planBasinDrainage(natural, basin, { maxCells: 100 }).reason, 'component-mesh-budget');
  assert.throws(() => planBasinDrainage(natural, basin, { maxVisited: 8193 }), /budget/);
  assert.throws(() => prepareBasinDrainagePreview({ ...request, seed: 6, basinId: 'basin:6:1504:3464' }), /No lake outlet passed/);
  assert.throws(() => prepareBasinDrainagePreview({ ...request, regionX: 0.5 }), /region/);
  const corrupt = structuredClone(drainage.mesh), g = corrupt.grid;
  const lakeVertex = g.lakeKind.findIndex(k => k > 0);
  g.head[lakeVertex] += 0.1; g.signed[lakeVertex] += 0.1;
  const { status, activationReady, hash, ...payload } = corrupt;
  corrupt.hash = descriptorHash(payload);
  assert.throws(() => new SparseRiverComponentField(corrupt), /lake shoreline head/);
});

test('pond outlet preview survives both workers and preserves production shore contact across LODs', async () => {
  const previousSelf = globalThis.self, messages = [];
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
  try {
    globalThis.self = { postMessage(m, transfer = []) { messages.push(structuredClone(m, { transfer })); } };
    await import('../src/hydrologyworker.js?lake-drainage-test');
    self.onmessage({ data: { type: 'plan-basin-drainage-preview', id: 1, ...request } });
    assert.equal(messages.at(-1).type, 'basin-drainage-planned');
    assert.deepEqual(messages.at(-1).plan, preview.plan);
    await import('../src/worker.js?lake-drainage-test');
    self.onmessage({ data: { type: 'init', seed: world.seed, waterPlans: [preview.plan] } });
    assert.equal(messages.at(-1).type, 'ready');
    self.onmessage({ data: { type: 'build', id: 2, cx, cz, res: 16, chunkSize: 140, doTerrain: true, waterPlanHash: world.waterPlanHash } });
    assert.equal(messages.at(-1).type, 'built');
    assert.deepEqual(messages.at(-1).river, river);
    assert.deepEqual(messages.at(-1).terrain.positions, terrain.positions);
  } finally { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; }
});
