import test from 'node:test';
import assert from 'node:assert/strict';
import { ROAD_CONFIRM_AFTER, ROAD_POST_SPACING, addRoadArm, largestPostGap, placeRoadPosts, routePolyline } from '../src/courierroads.mjs';
import { buildNavGraph, findRoute } from '../src/npcnavgraph.mjs';

// A road due east along z = 0, in legs of the given lengths; the traveller's left is +z.
function road(lengths) {
  let x0 = 0;
  const legs = lengths.map(length => { const leg = { x0, edge: { arcLength: length } }; x0 += length; return leg; });
  const route = { legs, keys: lengths.map((_, i) => 'n' + i).concat('end') };
  return routePolyline(route, (leg, d) => ({ x: leg.x0 + d, z: 0, perpX: 0, perpZ: 1 }));
}

test('a post at every fork, one just past it, and never more than ~300 m without one', () => {
  for (const lengths of [[5600], [700, 800, 1300], [60, 2400, 35, 900], [12000]]) {
    const line = road(lengths), posts = placeRoadPosts(line);
    assert.equal(largestPostGap(posts, line.length) <= ROAD_POST_SPACING, true, lengths + ': gap ' + largestPostGap(posts, line.length));
    for (const junction of line.junctions) {
      assert.ok(posts.some(post => post.kind === 'fork' && Math.abs(post.arc - junction.arc) < 1), 'fork post at ' + junction.arc);
      if (junction.arc + ROAD_CONFIRM_AFTER <= line.length - 40)
        assert.ok(posts.some(post => post.kind === 'confirm' && Math.abs(post.arc - junction.arc - ROAD_CONFIRM_AFTER) < 1), 'confirming post past ' + junction.arc);
    }
    // Every arm points on along the road, the way the traveller is going.
    for (const post of posts) assert.equal(post.toward.x > post.x, true);
    assert.deepEqual(placeRoadPosts(line), posts, 'the same road gets the same posts');
  }
});
test('a post stands beside the road, not in it, on the traveller’s left first', () => {
  const posts = placeRoadPosts(road([1000]));
  for (const post of posts) assert.equal(post.z, 2.4);
});
test('a post the ground will not take is moved, not dropped', () => {
  const line = road([3000]);
  // Wet or low ground from 800 m to 2200 m; dry but rough everywhere.
  const posts = placeRoadPosts(line, { isGood: spot => spot.x < 800 || spot.x > 2200, isPossible: () => true });
  assert.equal(largestPostGap(posts, line.length) <= ROAD_POST_SPACING, true);
  // Only one side of the road is good ground: posts go to that side.
  const right = placeRoadPosts(line, { isGood: spot => spot.z < 0 });
  assert.equal(right.length > 10, true); assert.equal(right.every(post => post.z < 0), true);
  // A narrow wet strip: the post slides along the road to the bank.
  const slid = placeRoadPosts(line, { isGood: spot => Math.abs(spot.x - 1000) > 25 && Math.abs(spot.x - 1100) > 25 });
  assert.equal(largestPostGap(slid, line.length) <= ROAD_POST_SPACING, true);
  assert.equal(slid.every(post => Math.abs(post.x - 1000) > 25), true);
});
test('a fork post stands where the road in arrives, so roads parting there share it', () => {
  // Two roads come in along the same leg and leave a wide clearing by branches 80 m apart.
  const make = turn => routePolyline({ keys: ['a', 'junction', 'end'], legs: [{ id: 'in', edge: { arcLength: 1000 } }, { id: 'out', edge: { arcLength: 1000 } }] },
    (leg, d) => leg.id === 'in' ? { x: d, z: 0, perpX: 0, perpZ: 1 } : { x: 1040, z: turn * (40 + d), perpX: -turn, perpZ: 0 });
  const north = placeRoadPosts(make(1)).find(post => post.kind === 'fork' && post.leg === 1);
  const south = placeRoadPosts(make(-1)).find(post => post.kind === 'fork' && post.leg === 1);
  assert.deepEqual([north.x, north.z], [south.x, south.z], 'one spot for both');
  assert.equal(north.x, 1000);
  assert.equal(north.toward.z > 0, true); assert.equal(south.toward.z < 0, true, 'each arm points down its own branch');
});
test('a fork post goes only where the road actually forks, besides the first', () => {
  const line = road([700, 800, 1300]);
  const posts = placeRoadPosts(line, { isFork: key => key === 'n2' });
  assert.deepEqual(posts.filter(post => post.kind === 'fork').map(post => post.arc), [0, 1500]);
  assert.equal(posts.filter(post => post.kind === 'confirm').length, 3, 'the branch is still confirmed at every junction');
});
test('roads that pass the same spot share one post with an arm each', () => {
  const posts = [];
  assert.equal(addRoadArm(posts, { x: 0, z: 0, destination: 'Holtwick', toward: { x: 10, z: 0 } }).created, true);
  assert.equal(addRoadArm(posts, { x: 4, z: 3, destination: 'Oakgate', toward: { x: 0, z: 10 } }).added, true);
  assert.equal(addRoadArm(posts, { x: 2, z: 0, destination: 'Holtwick', toward: { x: 10, z: 0 } }).added, false, 'one arm per destination');
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].arms.map(arm => arm.destination), ['Holtwick', 'Oakgate']);
  assert.equal(addRoadArm(posts, { x: 40, z: 0, destination: 'Oakgate', toward: { x: 50, z: 0 } }).created, true, 'further away is another post');
  for (const name of ['A', 'B', 'C']) addRoadArm(posts, { x: 0, z: 1, destination: name, toward: { x: 1, z: 1 } });
  assert.equal(posts[0].arms.length, 4); assert.equal(posts.length, 3, 'a fifth destination gets a post of its own');
  // Where two roads part, each branch starts at its own edge of the clearing: one fork post names both.
  const fork = [];
  addRoadArm(fork, { x: 0, z: 0, destination: 'Holtwick', toward: { x: 60, z: 0 }, fork: true });
  addRoadArm(fork, { x: 0, z: 30, destination: 'Oakgate', toward: { x: 0, z: 90 }, fork: true });
  addRoadArm(fork, { x: 0, z: 30, destination: 'Mere', toward: { x: -60, z: 30 } });
  assert.deepEqual(fork.map(post => post.arms.map(arm => arm.destination)), [['Holtwick', 'Oakgate'], ['Mere']], 'only fork posts join from that far');
});
test('a route can be steered off edges the caller wants to avoid', () => {
  const edge = (id, fromKey, toKey, arcLength) => ({ id, fromKey, toKey, arcLength, meanGrade: 0, curve: { startX: 0, startZ: 0, endX: 0, endZ: 0 },
    segments: { count: 1, arc: [0], len: [arcLength], ax: [0], az: [0], dx: [arcLength], dz: [0] } });
  const graph = buildNavGraph([edge('sea', 'a', 'b', 1000), edge('north', 'a', 'c', 800), edge('east', 'c', 'b', 800)]);
  assert.deepEqual(findRoute(graph, 'a', 'b').keys, ['a', 'b']);
  const around = findRoute(graph, 'a', 'b', { weights: { edgePenalty: item => item.id === 'sea' ? 60000 : 0 } });
  assert.deepEqual(around.keys, ['a', 'c', 'b']);
});
