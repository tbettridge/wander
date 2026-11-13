import test from 'node:test';
import assert from 'node:assert/strict';
import { COURIER_MAP_CELL, createCourierMap, normalizeCourierMap, revealCourierMap, courierMapSeen, addCourierMark,
  removeCourierMarkNear, courierMapProjection, courierMapView, courierMapPlaceAt, courierScaleBar, revealCourierPlace } from '../src/couriermap.mjs';

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
  assert.deepEqual(normalizeCourierMap({ seen: ['1,2', 'bad', 7], marks: [{ x: 'no' }, null] }), { seen: ['1,2'], marks: [], place: null, arrived: [] });
  assert.equal(removeCourierMarkNear(map, 500, 500, 20), null);
  assert.equal(removeCourierMarkNear(map, 14, -38, 20).id, house.id);
  assert.equal(map.marks.length, 1);
});

test('map clicks turn back into places in the world, with north at the top', () => {
  const projection = courierMapProjection([{ x: -100, z: -50 }, { x: 300, z: 250 }], 1000, 600);
  const north = projection.project({ x: 0, z: 200 }), south = projection.project({ x: 0, z: 0 });
  const east = projection.project({ x: -200, z: 0 });
  assert.ok(north.y < south.y, '+Z is north, drawn upward');
  assert.ok(east.x > south.x, 'east (-X) is drawn to the right, as the land looks facing north');
  const back = projection.unproject(projection.project({ x: 123, z: -45 }));
  assert.ok(Math.abs(back.x - 123) < 1e-6 && Math.abs(back.z + 45) < 1e-6);
  assert.deepEqual(courierScaleBar(0.5, 1000).label, '500 m');
});

test('the near view frames the village the courier last knew they were in, never their live position', () => {
  const places = [{ key: 'A', name: 'Ash', x: 0, z: 0, buildings: [{ x: -40, z: 20, width: 8, depth: 6 }, { x: 60, z: -30, width: 8, depth: 6 }] },
    { key: 'B', name: 'Bell', x: 2000, z: 0, buildings: [] }];
  const map = createCourierMap();
  assert.equal(courierMapPlaceAt({ player: { x: 50, z: 50 }, places }).name, 'Ash');
  assert.equal(courierMapPlaceAt({ player: { x: 900, z: 0 }, places }), null);
  // Without a known village the near view is the whole uncovered map.
  assert.equal(courierMapView({ player: { x: 50, z: 50 }, places }, map, 'near', 1000, 600).title, 'Everywhere you have been');
  map.place = 'A';
  const a = courierMapView({ player: { x: 1990, z: 0 }, places }, map, 'near', 1000, 600);
  const b = courierMapView({ player: { x: 900, z: 40 }, places }, map, 'near', 1000, 600);
  assert.equal(a.title, 'Ash', 'standing in Bell without reading its sign, the map still shows Ash');
  assert.deepEqual(a.projection.project({ x: 0, z: 0 }), b.projection.project({ x: 0, z: 0 }), 'the frame never follows the courier');
  assert.equal(courierMapView({ player: { x: 0, z: 0 }, places }, map, 'round', 1000, 600).title, 'Everywhere you have been');
  map.arrived = ['A'];
  assert.deepEqual(normalizeCourierMap(JSON.parse(JSON.stringify(map))).place, 'A');
  assert.deepEqual(normalizeCourierMap(JSON.parse(JSON.stringify(map))).arrived, ['A']);
});

test('a home village is uncovered whole, and nowhere else is', () => {
  const map = createCourierMap();
  const home = { key: 'A', x: 0, z: 0, buildings: [{ x: 120, z: 0 }], well: { x: 5, z: 5 } };
  assert.ok(revealCourierPlace(map, home) > 0);
  assert.ok(courierMapSeen(map, 0, 0) && courierMapSeen(map, 120, 0));
  assert.ok(!courierMapSeen(map, 2000, 0));
});

test('the posted village plan says you are here at the board and faces the reader', async () => {
  const { postedMapLayout } = await import('../src/couriermap.mjs');
  const place = { key: 'A', name: 'Ash', x: 0, z: 0, board: { x: 0, z: 0 }, well: { x: 5, z: 5 },
    buildings: [{ x: 0, z: 40, width: 8, depth: 6 }, { x: 30, z: -20, width: 8, depth: 6 }, { x: -35, z: 10, width: 8, depth: 6 }] };
  const roads = [{ name: 'Bell', walk: 'a morning', points: [{ x: 2, z: 0 }, { x: 300, z: 0 }, { x: 600, z: 0 }] },
    { name: 'Hazel', walk: 'two hours', points: [{ x: 0, z: -2 }, { x: 0, z: -300 }] }];
  // A reader at a north-facing board faces south: north is down the page.
  const south = postedMapLayout(place, roads, Math.PI, 900, 600);
  assert.deepEqual(south.here, south.project(place.board));
  assert.ok(south.project({ x: 0, z: 40 }).y > south.here.y, 'north of the board is lower on a south-up plan');
  // The plan must agree with the view: facing south, east (-X) is on the reader's left.
  assert.ok(south.project({ x: -30, z: 0 }).x < south.here.x, 'east is on the left of a reader facing south');
  assert.ok(Math.abs(south.north.x) < 1e-9 && south.north.y > 0.99, 'the north arrow points down the page');
  assert.equal(south.exits.length, 2);
  assert.deepEqual(south.exits.flatMap(exit => exit.names.map(entry => entry.name)).sort(), ['Bell', 'Hazel']);
  for (const exit of south.exits) assert.ok(exit.x > 0 && exit.x < 900 && exit.y > 0 && exit.y < 600, exit.names[0].name + ' is written on the paper');
  assert.ok(south.exits.find(exit => exit.names[0].name === 'Bell').x > south.here.x, 'the road west (+X) leaves on the right');
  assert.ok(south.exits.find(exit => exit.names[0].name === 'Hazel').y < south.here.y, 'the road south leaves at the top');
  const shared = postedMapLayout(place, [...roads, { name: 'Elm', walk: 'an hour', points: [{ x: 2, z: 0 }, { x: 300, z: 4 }] }], Math.PI, 900, 600);
  assert.deepEqual(shared.exits.map(exit => exit.names.map(entry => entry.name)), [['Bell', 'Elm'], ['Hazel']], 'roads leaving by one lane share an arrow');
  const north = postedMapLayout(place, roads, 0, 900, 600);
  assert.ok(north.project({ x: 0, z: 40 }).y < north.here.y);
  assert.ok(north.project({ x: -30, z: 0 }).x > north.here.x, 'facing north, east is on the reader’s right');
});

test('the posted plan’s page transform agrees with its projection', async () => {
  const { postedMapLayout } = await import('../src/couriermap.mjs');
  const place = { board: { x: 0, z: 0 }, buildings: [{ x: 10, z: 20 }] };
  for (const heading of [0, Math.PI / 3, Math.PI, 4]) {
    const layout = postedMapLayout(place, [], heading, 900, 600);
    const [a, b, c, d] = layout.matrix, at = layout.project({ x: 13, z: 25 }), base = layout.project({ x: 10, z: 20 });
    // On the north-up page (east, -X, to the right) that offset is (-3, -5); the matrix carries it onto the plan.
    const X = -3 * layout.scale, Y = -5 * layout.scale;
    assert.ok(Math.abs(base.x + a * X + c * Y - at.x) < 1e-6 && Math.abs(base.y + b * X + d * Y - at.y) < 1e-6, String(heading));
  }
});

test('a map remembers reaching any settlement across a reload, not only the tutorial villages', async () => {
  const { normalizeCourierMap } = await import('../src/couriermap.mjs');
  const map = normalizeCourierMap({ place: 'station-settlement:3', arrived: ['A', 'station-settlement:3', 'settlement:-12:40', '<script>', 'x'.repeat(80)] });
  assert.equal(map.place, 'station-settlement:3');
  assert.deepEqual(map.arrived, ['A', 'station-settlement:3', 'settlement:-12:40']);
});
