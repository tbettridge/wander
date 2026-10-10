import test from 'node:test';
import assert from 'node:assert/strict';
import { waterPlanningTerrain } from '../src/waterplanningterrain.mjs';

test('fractional planning queries retain exact coordinates without rounding neighbouring positions', () => {
  let calls = 0;
  const world = { _naturalHeight(x, z) { calls++; return x * 0.37 + z * 0.61; } };
  const planning = waterPlanningTerrain(world);
  const x = 10.125, z = -2.75;
  assert.equal(planning._naturalHeight(x, z), x * 0.37 + z * 0.61);
  assert.equal(planning._naturalHeight(x, z), x * 0.37 + z * 0.61);
  assert.equal(calls, 2);
  const adjacent = x + 1e-9;
  assert.equal(planning._naturalHeight(adjacent, z), adjacent * 0.37 + z * 0.61);
  assert.equal(calls, 3);
});

test('rich natural queries always populate fresh metadata through the original world', () => {
  let calls = 0;
  const world = { marker: 'original', _naturalHeight(x, z, out) {
    assert.equal(this, world);
    calls++;
    if (out) Object.assign(out, { h: x + z, marker: this.marker, visit: calls });
    return x + z;
  } };
  const planning = waterPlanningTerrain(world);
  planning._naturalHeight(2, 4);
  const first = {}, second = {};
  assert.equal(planning._naturalHeight(2, 4, first), 6);
  assert.equal(planning._naturalHeight(2, 4, second), 6);
  assert.deepEqual(first, { h: 6, marker: 'original', visit: 2 });
  assert.deepEqual(second, { h: 6, marker: 'original', visit: 3 });
  planning._naturalHeight(2, 4);
  assert.equal(calls, 3);
  assert.equal(waterPlanningTerrain(planning), planning);
});

test('planning cache stays bounded and keeps existing entries when exact-key capacity is exhausted', () => {
  let calls = 0;
  const world = { _naturalHeight(x, z) { calls++; return x + z; } };
  const planning = waterPlanningTerrain(world);
  for (let i = 0; i < 131072; i++) planning._naturalHeight(i * 2, 2);
  assert.equal(calls, 131072);
  planning._naturalHeight(0, 2);
  assert.equal(calls, 131072, 'the first cached coordinate remains available');
  planning._naturalHeight(131072 * 2, 2);
  planning._naturalHeight(131072 * 2, 2);
  assert.equal(calls, 131074, 'new overflow coordinates are computed without growing the cache');
});

test('a cached undefined result remains distinguishable from an absent coordinate', () => {
  let calls = 0;
  const planning = waterPlanningTerrain({ _naturalHeight() { calls++; return undefined; } });
  assert.equal(planning._naturalHeight(2, 4), undefined);
  assert.equal(planning._naturalHeight(2, 4), undefined);
  assert.equal(calls, 1);
  assert.equal(planning._naturalHeight(4, 4), undefined);
  assert.equal(calls, 2);
});
