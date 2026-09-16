import assert from 'node:assert/strict';
import test from 'node:test';
import { HydrologyStream } from '../src/hydrologystream.mjs';
import { WaterRegionPlanner, resolveWaterRegion, changedWaterBounds } from '../src/hydrologyregions.mjs';
import { descriptorHash } from '../src/hydrologyformat.mjs';
import { WaterField } from '../src/waterfield.mjs';
import { waterWorkerPlans } from '../src/waterstage.mjs';

function empty(seed, regionX, regionZ) {
  const p = { version: 1, generationVersion: 3, regional: 1, preview: true, seed, regionX, regionZ, basins: [], components: [] };
  return { ...p, hash: descriptorHash(p) };
}
function response(request) {
  const plans = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) plans.push(empty(request.seed, request.regionX + dx, request.regionZ + dz));
  return { ...request, type: 'water-window-planned', plans };
}
function wireResponse(request) {
  const { plans, ...message } = response(request);
  return { ...message, plansJSON: plans.map(plan => JSON.stringify(plan)) };
}

test('blocking lakeshore preparation uses startup workers without changing walking budgets', async () => {
  const sent = [], worker = { postMessage(m) { sent.push(m); }, terminate() {} };
  const stream = new HydrologyStream(42, worker);
  const first = stream.initialize(0, 0);
  stream.receive(response(sent.at(-1))); stream.commit(await first);
  const shore = stream.initialize(1, 0);
  assert.equal(sent.at(-1).startup, true);
  stream.receive(response(sent.at(-1))); stream.commit(await shore);
  stream.update(8300, 100);
  assert.equal(sent.at(-1).startup, false);
  stream.dispose();
});

test('stream coalesces travel, ignores stale responses and never publishes an incomplete window', async () => {
  const sent = [], worker = { postMessage(m) { sent.push(m); }, terminate() {} };
  const stream = new HydrologyStream(42, worker);
  const initial = stream.initialize(0, 0);
  assert.equal(sent[0].startup, true, 'extra candidate workers are allowed before first publication');
  stream.receive(response(sent[0])); stream.commit(await initial);
  assert.ok(stream.contains(-3000, 100));
  assert.ok(!stream.contains(-3100, 100));
  stream.update(4200, 100); stream.update(8400, 100); stream.update(12500, 100);
  assert.equal(sent.length, 2, 'only one job may be in flight');
  assert.equal(sent[1].startup, false, 'walking retains the smaller generation CPU budget');
  stream.receive(response(sent[1]));
  assert.equal(stream.ready, null);
  assert.equal(sent.length, 3); assert.equal(sent[2].regionX, 3);
  stream.receive(response(sent[1])); assert.equal(stream.pending.id, sent[2].id);
  stream.receive(response(sent[2]));
  const latest = stream.ready; stream.commit(latest);
  assert.equal(stream.active.regionX, 3);
  assert.throws(() => stream.commit(latest), /Stale/);
  stream.update(17000, 100);
  const bad = response(sent.at(-1)); bad.plans.pop(); stream.receive(bad);
  assert.equal(stream.active.regionX, 3); assert.match(stream.error, /Incomplete/);
  stream.dispose();
});

test('region ownership is independent of request order and cache eviction', () => {
  const make = (seed, x, z) => {
    const p = empty(seed, x, z);
    p.basins = [{ id: `${x},${z}`, bounds: { minX: x * 4096 - 100, maxX: x * 4096 + 4200, minZ: z * 4096, maxZ: z * 4096 + 4000 } }];
    return p;
  };
  const planner = new WaterRegionPlanner(42, { maxEntries: 9, createCandidates: make });
  const a = planner.region(0, 0), b = planner.region(1, 0);
  assert.ok(a.basins.length + b.basins.length <= 1, 'competing cross-border bodies cannot both win');
  for (let i = -4; i <= 4; i++) planner.region(i, 3);
  assert.equal(planner.cache.size, 9);
  assert.deepEqual(planner.region(0, 0), a);
  assert.deepEqual(planner.region(1, 0), b);
  const neighbours = [make(42, -1, 0), make(42, 1, 0)];
  assert.deepEqual(resolveWaterRegion(make(42, 0, 0), neighbours), resolveWaterRegion(make(42, 0, 0), neighbours.reverse()));
  assert.deepEqual(changedWaterBounds([a, b], [b, a]), []);
  const original = make(42, 0, 0), edited = structuredClone(original);
  edited.basins[0].level = 12;
  assert.equal(changedWaterBounds([original], [edited]).length, 2, 'same basin ID cannot hide a changed water level');
});

test('generation progress is real, bounded and leaves the generated window unchanged', () => {
  let generated = 0;
  const planner = new WaterRegionPlanner(42, { createCandidates: (...args) => { generated++; return empty(...args); } });
  const progress = [];
  const first = planner.window(0, 0, p => progress.push(p));
  assert.equal(generated, 25);
  assert.deepEqual(progress.map(p => p.completed), Array.from({ length: 26 }, (_, i) => i));
  assert.deepEqual(progress.at(-1), { completed: 25, total: 25, reused: 0 });
  const warm = [];
  assert.deepEqual(planner.window(0, 0, p => warm.push(p)), first);
  assert.equal(generated, 25);
  assert.equal(warm.at(-1).reused, 25);
  const adjacent = [];
  planner.window(1, 0, p => adjacent.push(p));
  assert.equal(generated, 30);
  assert.equal(adjacent.at(-1).reused, 20);
});

test('only valid advancing progress refreshes the stall timer and never publishes terrain', async () => {
  const sent = [], updates = [];
  const stream = new HydrologyStream(42, { postMessage(m) { sent.push(m); }, terminate() {} }, { onProgress: p => updates.push(p) });
  const initial = stream.initialize(0, 0);
  const progress = { ...sent[0], type: 'water-window-progress', completed: 1, total: 25, reused: 0 };
  const firstTimer = stream.timeout;
  stream.receive(progress);
  assert.notEqual(stream.timeout, firstTimer);
  assert.equal(stream.pending.id, sent[0].id);
  assert.equal(stream.ready, null);
  const timer = stream.timeout;
  for (const edit of [{}, { completed: 0 }, { completed: 26 }, { seed: 9 }, { id: 200 }, { reused: 2 }, { total: 100 }]) {
    stream.receive({ ...progress, ...edit });
    assert.equal(stream.timeout, timer);
  }
  assert.equal(updates.length, 1);
  stream.receive(response(sent[0])); stream.commit(await initial);
  stream.update(4200, 0); stream.update(8400, 0);
  stream.receive({ ...sent[1], type: 'water-window-progress', completed: 2, total: 25, reused: 1 });
  assert.equal(updates.length, 1, 'old destination progress cannot replace the current message');
  stream.receive(response(sent[1]));
  assert.equal(stream.progress, null, 'new destination starts with fresh progress');
  stream.dispose();
});

test('wire responses prepare one validated field cooperatively and retain their payload', async () => {
  const sent = [], worker = { postMessage(m) { sent.push(m); }, terminate() {} };
  let yields = 0;
  const stream = new HydrologyStream(42, worker, { yieldTask: async () => { yields++; } });
  const initial = stream.initialize(0, 0);
  const wire = wireResponse(sent[0]);
  stream.receive(wire);
  assert.equal(stream.ready, null, 'wire preparation must not publish synchronously');
  const result = await initial;
  assert.ok(result.preparedField instanceof WaterField);
  assert.equal(result.plans, result.preparedField.plans);
  assert.ok(Object.isFrozen(result.plans));
  assert.ok(result.preparedField.prepared);
  assert.equal(waterWorkerPlans(result.preparedField), `[${wire.plansJSON.join(',')}]`);
  assert.ok(yields >= 2, 'preparation must cross host turns');
  stream.commit(result);
  stream.dispose();
});

test('wire preparation rejects corrupt payloads without publishing a field', async () => {
  const sent = [], worker = { postMessage(m) { sent.push(m); }, terminate() {} };
  const stream = new HydrologyStream(42, worker, { yieldTask: async () => {} });
  const initial = stream.initialize(0, 0);
  const wire = wireResponse(sent[0]);
  wire.plansJSON[4] = '[';
  stream.receive(wire);
  await assert.rejects(initial, /Invalid worker water plan payload/);
  assert.equal(stream.ready, null);
  assert.match(stream.error, /Invalid worker water plan payload/);
  stream.dispose();
});

test('wire preparation rejects valid JSON whose descriptor checksum changed', async () => {
  const sent = [], worker = { postMessage(m) { sent.push(m); }, terminate() {} };
  const stream = new HydrologyStream(42, worker, { yieldTask: async () => {} });
  const initial = stream.initialize(0, 0);
  const wire = wireResponse(sent[0]);
  const changed = JSON.parse(wire.plansJSON[4]);
  changed.preview = !changed.preview;
  wire.plansJSON[4] = JSON.stringify(changed);
  stream.receive(wire);
  await assert.rejects(initial, /Water plan identity\/checksum mismatch/);
  assert.equal(stream.ready, null);
  assert.match(stream.error, /Water plan identity\/checksum mismatch/);
  stream.dispose();
});

test('disposing during wire preparation rejects initialize and cancels the pending task', async () => {
  const sent = [], gates = [], worker = { postMessage(m) { sent.push(m); }, terminate() {} };
  const stream = new HydrologyStream(42, worker, { yieldTask: () => new Promise(resolve => gates.push(resolve)) });
  const initial = stream.initialize(0, 0);
  stream.receive(wireResponse(sent[0]));
  await Promise.resolve();
  assert.equal(gates.length, 1);
  const rejected = assert.rejects(initial, /Water stream disposed/);
  stream.dispose();
  gates.shift()();
  await rejected;
  assert.equal(stream.preparing, null);
  assert.equal(stream.disposed, true);
});

test('stale wire preparation is cancelled before it can publish', async () => {
  const sent = [], gates = [], worker = { postMessage(m) { sent.push(m); }, terminate() {} };
  const yieldTask = () => new Promise(resolve => gates.push(resolve));
  const stream = new HydrologyStream(42, worker, { yieldTask });
  const initial = stream.initialize(0, 0);
  stream.receive(wireResponse(sent[0]));
  await Promise.resolve();
  assert.equal(gates.length, 1, 'first wire plan should be waiting at a yield boundary');
  stream.update(4200, 0);
  assert.equal(sent.length, 2);
  gates.shift()();
  await Promise.resolve();
  assert.equal(stream.ready, null);

  stream.yieldTask = async () => {};
  stream.receive(wireResponse(sent[1]));
  const result = await initial;
  assert.equal(result.regionX, 1);
  assert.equal(stream.ready, result);
  stream.commit(result);
  stream.dispose();
});
