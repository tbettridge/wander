import test from 'node:test';
import assert from 'node:assert/strict';
import { fitRiverComponent } from '../src/rivercomponent.mjs';
import { RiverReachField } from '../src/riverterrain.mjs';
import { prepareRiverJunctions } from '../src/riverjunctions.mjs';

const world = { seed: 1, _naturalHeight: () => 5 };
const point = (id, x, z, waterY) => ({ id, x, z, waterY });
function fixture() {
  const join = point('join', 0, 0, 10);
  const route = (id, a, b) => ({ id, status: 'candidate', source: a.id, outlet: b.id,
    sourceClosure: false, oceanMouth: false, points: [a, b] });
  return { status: 'candidate', reaches: [
    route('a', point('a', -50, -100, 3), join),
    route('b', point('b', 50, -100, 10), join),
    route('downstream', join, point('end', 0, 100, 10)),
  ], junctions: [{ id: 'junction:join', nodeId: 'join', waterY: 10 }] };
}

test('component heads are selected from fitted bank intervals, not frozen coarse preferences', () => {
  const segmented = fixture(), original = structuredClone(segmented);
  const result = fitRiverComponent(world, segmented);
  assert.equal(result.status, 'fitted');
  assert.deepEqual(segmented, original);
  const heads = result.reaches.map(reach => reach.id === 'downstream' ? reach.points[0].waterY : reach.points.at(-1).waterY);
  assert.ok(heads.every(head => head === heads[0] && head <= 4.8));
  assert.equal(result.junctions[0].waterY, heads[0]);
  for (const reach of result.reaches) {
    assert.doesNotThrow(() => new RiverReachField(reach));
    assert.ok(reach.points.every(p => p.waterY <= p.maxY + 1e-9 && p.waterY >= p.minY - 1e-9));
  }
  const reversed = fitRiverComponent(world, { ...segmented, reaches: [...segmented.reaches].reverse() });
  assert.deepEqual([...reversed.reaches].sort((a, b) => a.id.localeCompare(b.id)),
    [...result.reaches].sort((a, b) => a.id.localeCompare(b.id)));
});

test('a low fixed crossing constrains the other tributary and the entire downstream reach', () => {
  const result = fitRiverComponent(world, fixture(), { fixedLevels: [
    { id: 'preserved', nodeId: 'b', x: 50, z: -100, minY: 1, maxY: 1 },
  ] });
  assert.equal(result.status, 'fitted');
  assert.equal(result.reaches.find(r => r.id === 'b').points[0].waterY, 1);
  assert.ok(result.reaches.find(r => r.id === 'downstream').points.every(p => p.waterY <= 1 + 1e-9));
  assert.ok(result.junctions[0].waterY <= 1);
});

test('incompatible tributary crossings reject the whole terrain solve without partial reaches', () => {
  const result = fitRiverComponent(world, fixture(), { fixedLevels: [
    { id: 'high', nodeId: 'a', x: -50, z: -100, minY: 4.8, maxY: 4.8 },
    { id: 'low', nodeId: 'b', x: 50, z: -100, minY: 0, maxY: 0 },
  ] });
  assert.equal(result.status, 'retain-legacy');
  assert.equal(result.reason, 'incompatible-junction-levels');
  assert.equal(result.reaches, undefined);
});

test('a finite confluence collar shares one head across both tributaries and the downstream channel', () => {
  const input = fixture();
  const result = fitRiverComponent(world, input, { junctionLength: 48 });
  assert.equal(result.status, 'fitted');
  const head = result.junctions[0].waterY;
  for (const reach of result.reaches) {
    for (const p of reach.points) {
      const distance = reach.id === 'downstream' ? p.arc : reach.points.at(-1).arc - p.arc;
      if (distance <= 48) assert.ok(Math.abs(p.waterY - head) < 1e-9);
      assert.ok(p.waterY >= p.minY - 1e-9 && p.waterY <= p.maxY + 1e-9);
    }
  }
  const reversed = fitRiverComponent(world, { ...input, reaches: [...input.reaches].reverse() }, { junctionLength: 48 });
  assert.deepEqual([...result.reaches].sort((a, b) => a.id.localeCompare(b.id)),
    [...reversed.reaches].sort((a, b) => a.id.localeCompare(b.id)));
});

test('level confluences reject terrain that only a sloping overlap could satisfy', () => {
  const sloped = { seed: 1, _naturalHeight: (x, z) => 5 - z * 0.02 };
  const route = { status: 'candidate', reaches: [{ id: 'out', status: 'candidate', source: 'join',
    sourceClosure: false, oceanMouth: false, points: [point('join', 0, 0, 4), point('end', 0, 100, 2)] }],
  junctions: [{ id: 'j', nodeId: 'join' }] };
  const options = { maxCut: 1.5, maxFill: 0.2 };
  assert.equal(fitRiverComponent(sloped, route, options).status, 'fitted');
  const result = fitRiverComponent(sloped, route, { ...options, junctionLength: 100 });
  assert.equal(result.status, 'retain-legacy');
  assert.equal(result.reaches, undefined);
});

test('confluence ownership covers complete overlapping bank envelopes independently of reach order', () => {
  const fitted = fitRiverComponent(world, fixture(), { junctionLength: 64 });
  const result = prepareRiverJunctions(fitted);
  assert.equal(result.status, 'prepared');
  assert.equal(result.activationReady, false, 'region preparation alone does not publish junction meshes');
  assert.deepEqual(result.junctions[0].reachIds, ['a', 'b', 'downstream']);
  assert.ok(result.junctions[0].bounds.minX < 0 && result.junctions[0].bounds.maxX > 0);
  assert.deepEqual(prepareRiverJunctions({ ...fitted, reaches: [...fitted.reaches].reverse() }), result);
  const unowned = structuredClone(fitted);
  unowned.junctions = [];
  assert.equal(prepareRiverJunctions(unowned).reason, 'unowned-reach-overlap');
});

test('equal endpoint heads alone do not authorize banks that overlap different upstream heads', () => {
  const input = fixture();
  input.reaches[0].points[0].waterY = 4.8;
  input.reaches[1].points[0].waterY = 4.8;
  input.reaches[2].points[1].waterY = 3;
  const fitted = fitRiverComponent(world, input, { fixedLevels: [{ nodeId: 'join', x: 0, z: 0, minY: 3, maxY: 3 }] });
  assert.equal(fitted.status, 'fitted');
  assert.equal(prepareRiverJunctions(fitted).reason, 'junction-collar-too-short');
});
