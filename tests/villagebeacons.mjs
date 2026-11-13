import test from 'node:test';
import assert from 'node:assert/strict';
import { BELL_RANGE, bellHeard, bellStrikes, buildingPoint, chimneyTops, churchBells, smokingChimneys } from '../src/villagebeacons.mjs';

const house = (id, x, z, extra = {}) => ({ id, program: 'dwelling', x, y: 10, z, yaw: 0, width: 6, depth: 8, floorCount: 2, floorHeight: 2.7, style: { chimney: true }, masses: [], ...extra });
const plan = (id, buildings) => ({ site: { id, x: 0, z: 0, radius: 120 }, buildings });

test('a church bell hangs in its tower’s belfry, turned with the church', () => {
  const church = { id: 'c', program: 'church', x: 100, y: 5, z: 200, yaw: Math.PI / 2, width: 8, depth: 20, floorCount: 1, floorHeight: 5.4, style: {},
    masses: [{ role: 'tower', dx: 0, dz: -12, height: 10 }] };
  const [bell] = churchBells([plan('v', [church, house('h', 0, 0)])]);
  // Turned a quarter, the tower's -z offset lies along -x.
  assert.ok(Math.abs(bell.x - 88) < 1e-9); assert.ok(Math.abs(bell.z - 200) < 1e-9); assert.equal(bell.y, 5 + 8.6);
  assert.ok(bell.note);
  assert.equal(churchBells([plan('w', [house('h', 0, 0)])]).length, 0, 'no church, no bell');
  const notes = new Set(Array.from({ length: 30 }, (_, i) => churchBells([plan('v' + i, [church])])[0].note));
  assert.equal(notes.size > 2, true, 'villages ring different bells');
});
test('chimney tops sit where the houses are built with them', () => {
  const tops = chimneyTops(plan('v', [house('a', 0, 0), house('b', 50, 0, { style: { chimney: false } }),
    house('c', 0, 50, { yaw: Math.PI, masses: [{ role: 'core', baseY: 1 }] })]));
  assert.deepEqual(tops.map(top => top.buildingId), ['a', 'c']);
  assert.deepEqual(tops[0], { buildingId: 'a', ...buildingPoint(house('a', 0, 0), 1.44, 7.7, -0.96) });
  assert.ok(Math.abs(tops[1].x + 1.44) < 1e-9 && Math.abs(tops[1].z - 50.96) < 1e-9 && tops[1].y === 18.7, 'turned round and lifted');
  // A terrace: a stack at each open end and one on every other party wall.
  const row = (id, index, left, right) => house(id, index * 6, 0, { row: { index, rise: 1.2, left: { shared: left }, right: { shared: right } } });
  assert.equal(chimneyTops(plan('t', [row('r0', 0, false, true), row('r1', 1, true, true), row('r2', 2, true, false)])).length, 3);
});
test('two or three chimneys smoke in a place, the same for everyone, changing through the day', () => {
  const village = plan('v', Array.from({ length: 20 }, (_, i) => house('h' + i, i * 10, 0)));
  const counts = new Set();
  for (let hour = 0; hour < 24; hour += 2) {
    const lit = smokingChimneys(village, 7, hour);
    counts.add(lit.length);
    assert.deepEqual(smokingChimneys(village, 7, hour + 1.5), lit, 'steady within the shift');
    assert.equal(new Set(lit.map(top => top.buildingId)).size, lit.length, 'one stack per house');
  }
  assert.deepEqual([...counts].sort(), [2, 3]);
  assert.notDeepEqual(smokingChimneys(village, 7, 8), smokingChimneys(village, 7, 14), 'different fires later in the day');
  assert.equal(smokingChimneys(plan('f', [house('only', 0, 0)]), 7, 9).length, 1, 'a farmstead with one chimney smokes from it');
  assert.equal(smokingChimneys(plan('none', [house('cold', 0, 0, { style: {} })]), 7, 9).length, 0);
});
test('the bell counts the hour', () => {
  assert.deepEqual([0, 1, 9, 12, 13, 23].map(bellStrikes), [12, 1, 9, 12, 1, 11]);
});
test('a bell is heard from its side, quieter, duller and later the further off it is', () => {
  // +Z is north and +X is west. Facing north, a tower to the east (−X) is on the right.
  const north = { x: 0, z: 1 };
  const east = bellHeard({ x: -500, z: 0 }, { x: 0, z: 0 }, north);
  const west = bellHeard({ x: 500, z: 0 }, { x: 0, z: 0 }, north);
  assert.ok(east.pan > 0.95); assert.ok(west.pan < -0.95);
  const ahead = bellHeard({ x: 0, z: 800 }, { x: 0, z: 0 }, north), behind = bellHeard({ x: 0, z: -800 }, { x: 0, z: 0 }, north);
  assert.ok(Math.abs(ahead.pan) < 1e-9); assert.ok(behind.lowpass < ahead.lowpass);
  const near = bellHeard({ x: 0, z: 100 }, { x: 0, z: 0 }, north), far = bellHeard({ x: 0, z: 2000 }, { x: 0, z: 0 }, north);
  assert.ok(near.gain > far.gain && far.gain > 0); assert.ok(near.lowpass > far.lowpass); assert.ok(far.delay > 5);
  assert.equal(bellHeard({ x: 0, z: BELL_RANGE + 1 }, { x: 0, z: 0 }, north), null, 'out of earshot');
});

test('a church bell rings with a minor third and a hum, bright at the strike and settling low', async () => {
  const { churchBellSamples, toneStrength } = await import('../src/bellsound.mjs');
  const rate = 22050, prime = 293.66, bell = churchBellSamples(prime, { sampleRate: rate, seconds: 8, seed: 3 });
  assert.deepEqual(churchBellSamples(prime, { sampleRate: rate, seconds: 8, seed: 3 }), bell, 'the same tower rings the same bell');
  const early = [0, rate * 0.5], late = [rate * 5, rate * 6];
  const at = (f, [a, b]) => toneStrength(bell, f, rate, a, b);
  // The tierce is a minor third (6:5) above the prime, not a major third (5:4).
  assert.ok(at(prime * 1.19, early) > at(prime * 1.25, early) * 4);
  // The hum outlasts the bright nominal: late on, the low partial leads.
  assert.ok(at(prime * 2, early) > at(prime * 0.5, early) * 0.6);
  assert.ok(at(prime * 0.5, late) > at(prime * 2, late) * 2);
  let peak = 0; for (const v of bell) peak = Math.max(peak, Math.abs(v));
  assert.ok(Math.abs(peak - 0.9) < 1e-6);
});
