import test from 'node:test';
import assert from 'node:assert/strict';
import { COURIER_MAP_CELL, createCourierMap, normalizeCourierMap, revealCourierMap, courierMapSeen, addCourierMark,
  removeCourierMarkNear, courierMapProjection, courierMapView, courierMapPlaceAt, courierScaleBar } from '../src/couriermap.mjs';

test('the map uncovers only ground the courier has been near', () => {
  const map = createCourierMap();
  assert.equal(courierMapSeen(map, 0, 0), false);
  const added = revealCourierMap(map, 10, 10, 55);
  assert.ok(added > 8);
  assert.equal(courierMapSeen(map, 10, 10), true);
  assert.equal(courierMapSeen(map, 40, -30), true);
  assert.equal(courierMapSeen(map, 200, 0), false, 'ground out of sight stays blank');
  assert.equal(revealCourierMap(map, 10, 10, 55), 0, 'standing still uncovers nothing new');
  assert.equal(new Set(map.seen).size, map.seen.length);
  assert.ok(revealCourierMap(map, 10 + COURIER_MAP_CELL * 4, 10, 55) > 0);
  assert.equal(revealCourierMap(map, NaN, 0), 0);
});

test('stamps and labels are the courier’s own and survive a save', () => {
  const map = createCourierMap();
  revealCourierMap(map, 0, 0);
  const house = addCourierMark(map, { kind: 'house', text: '  Hale’s door  ', x: 12, z: -40 });
  addCourierMark(map, { kind: 'nonsense', x: 300, z: 300 });
  assert.equal(house.text, 'Hale’s door');
  assert.equal(map.marks[1].kind, 'star');
  assert.equal(addCourierMark(map, { kind: 'house', x: NaN, z: 0 }), null);
  const restored = normalizeCourierMap(JSON.parse(JSON.stringify(map)));
  assert.deepEqual(restored, map);
  assert.deepEqual(normalizeCourierMap({ seen: ['1,2', 'bad', 7], marks: [{ x: 'no' }, null] }), { seen: ['1,2'], marks: [] });
  assert.equal(removeCourierMarkNear(map, 500, 500, 20), null);
  assert.equal(removeCourierMarkNear(map, 14, -38, 20).id, house.id);
  assert.equal(map.marks.length, 1);
});

test('map clicks turn back into places in the world, with north at the top', () => {
  const projection = courierMapProjection([{ x: -100, z: -50 }, { x: 300, z: 250 }], 1000, 600);
  const north = projection.project({ x: 0, z: 200 }), south = projection.project({ x: 0, z: 0 });
  const east = projection.project({ x: 200, z: 0 });
  assert.ok(north.y < south.y, '+Z is north, drawn upward');
  assert.ok(east.x > south.x, '+X is east, drawn to the right');
  const back = projection.unproject(projection.project({ x: 123, z: -45 }));
  assert.ok(Math.abs(back.x - 123) < 1e-6 && Math.abs(back.z + 45) < 1e-6);
  assert.deepEqual(courierScaleBar(0.5, 1000).label, '500 m');
});

test('the near view frames the village the courier is in, and never follows each step in open country', () => {
  const places = [{ key: 'A', name: 'Ash', x: 0, z: 0, buildings: [{ x: -40, z: 20, width: 8, depth: 6 }, { x: 60, z: -30, width: 8, depth: 6 }] }];
  const map = createCourierMap();
  assert.equal(courierMapPlaceAt({ player: { x: 50, z: 50 }, places }).name, 'Ash');
  assert.equal(courierMapPlaceAt({ player: { x: 900, z: 0 }, places }), null);
  assert.equal(courierMapView({ player: { x: 50, z: 50 }, places }, map, 'near', 1000, 600).title, 'Ash');
  const a = courierMapView({ player: { x: 900, z: 0 }, places }, map, 'near', 1000, 600);
  const b = courierMapView({ player: { x: 930, z: 20 }, places }, map, 'near', 1000, 600);
  assert.equal(a.title, 'Open country');
  assert.deepEqual(a.projection.project({ x: 900, z: 0 }), b.projection.project({ x: 900, z: 0 }));
  assert.equal(courierMapView({ player: { x: 0, z: 0 }, places }, map, 'round', 1000, 600).title, 'Everywhere you have been');
});
