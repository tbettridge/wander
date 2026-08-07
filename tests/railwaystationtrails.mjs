// Walking to the train.
//
// A station is placed for the railway's convenience — a gentle grade, a low
// relief, well clear of a landmark's halo — which is exactly the set of
// preferences that can leave it standing on an empty plain with no path to it.
// Joining it to the trail network is therefore not just "add a node": the
// assertion that matters is that a traveller can route from a station to the
// rest of the world and back, not that an edge exists.
//
// The railway plan is real here rather than a fixture. Station placement is the
// half of this that can put a node somewhere awkward, so a hand-placed station
// would test the graph code and nothing about the world it has to survive.

import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { trailsAround, clearTrailCache } from '../src/trails.js';
import { buildNavGraph, findRoute } from '../src/npcnavgraph.mjs';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import { describeLandmark } from '../src/npcjourneycontext.mjs';
import { landmarksAround } from '../src/landmarks.js';
import {
  railwayStationSites, serializeRailwayTerrainPlan, setWorldRailwayTerrain,
} from '../src/railwayterrain.mjs';

// The travel-scale gather the nav graph itself uses. A smaller radius omits the
// links to landmarks just outside it and the network looks fragmented, which
// would make the connectivity assertions below meaningless.
const TRAVEL_RADIUS = 20000;

const world = new World(20260612);
const plan = planRegionalRailway(world, {
  center: { x: 0, z: 0 }, seed: world.seed ^ 0x5241494c,
  stationCount: 5, radius: 2600, searchRadius: 5200, exclusions: [],
});
const index = setWorldRailwayTerrain(world, serializeRailwayTerrainPlan(plan));
const stations = railwayStationSites(index);
assert.ok(stations.length >= 4, `the region must hold real stations, had ${stations.length}`);

clearTrailCache();
const edges = [];
trailsAround(world, 0, 0, world.seed, TRAVEL_RADIUS, edges);
const graph = buildNavGraph(edges);

// --- every station is on the graph -------------------------------------------
const stationKeys = stations.map((site) => 'R' + site.index);
for (const key of stationKeys) {
  assert.ok(graph.nodes.has(key), `station ${key} never reached the trail network`);
}

// --- and none of them is an island -------------------------------------------
// The point of the connectivity-aware anchor. A station tied to an unconnected
// landmark yields a tidy two-node component that satisfies "has an edge" and
// strands anyone who walks it, so the assertion is the size of the component
// the station lands in, not its degree.
function componentOf(startKey) {
  const seen = new Set([startKey]);
  const queue = [startKey];
  while (queue.length) {
    const node = graph.nodes.get(queue.pop());
    for (const link of node.links) {
      if (seen.has(link.to)) continue;
      seen.add(link.to);
      queue.push(link.to);
    }
  }
  return seen;
}

for (const key of stationKeys) {
  const reachable = componentOf(key);
  assert.ok(reachable.size > 20,
    `station ${key} sits in a ${reachable.size}-node pocket, not the network`);
}

// --- the anchor landmark is itself connected ----------------------------------
// Stated directly rather than inferred from the component size: a station's one
// spur must land on a landmark that has trails of its own, which is what makes
// the station a waypoint instead of a terminus.
for (const key of stationKeys) {
  const links = graph.nodes.get(key).links;
  assert.equal(links.length, 1, `a station joins by a single spur, ${key} had ${links.length}`);
  const anchor = graph.nodes.get(links[0].to);
  assert.ok(anchor.links.length > 1,
    `station ${key} hangs off a dead end (anchor ${anchor.key} has ${anchor.links.length} link)`);
}

// --- a traveller can actually route station → world → station -----------------
// Two stations on the same loop should be walkable one to the other. This is
// the whole feature in one assertion: it fails if the spur exists but the
// anchor is stranded, and it fails if the graph knows the node but cannot cost
// a way through it.
{
  let routed = 0, attempted = 0;
  for (let i = 0; i < stationKeys.length; i++) {
    for (let j = i + 1; j < stationKeys.length; j++) {
      attempted++;
      const route = findRoute(graph, stationKeys[i], stationKeys[j]);
      if (route && route.legs.length) routed++;
    }
  }
  assert.ok(routed > 0,
    `no station pair was walkable (0 of ${attempted}); the spurs are islands`);
}

// --- and to somewhere that is not a station -----------------------------------
{
  const landmarkKeys = [...graph.nodes.keys()].filter((key) => !key.startsWith('R'));
  let reached = 0;
  for (const key of stationKeys) {
    const component = componentOf(key);
    if (landmarkKeys.some((lm) => component.has(lm))) reached++;
  }
  assert.equal(reached, stationKeys.length,
    'every station must reach the landmark network it was joined to');
}

// --- a traveller bound for a station says so ----------------------------------
// describeLandmark resolves a nav-graph key against the landmark layer and, on
// a miss, settles for the nearest landmark within 900 m. A station's spur can be
// shorter than that: on this seed one station stands 505 m from a great tree, so
// before stations were named the traveller heading for the platform announced
// they were walking to the tree. That is worse than a vague answer, because it
// is confidently wrong and the model repeats it.
{
  let checked = 0;
  for (const site of stations) {
    const key = 'R' + site.index;
    const node = graph.nodes.get(key);
    const described = describeLandmark(world, world.seed, key, node.x, node.z);
    assert.equal(described.kind, 'railway-station',
      `station ${key} was described as ${described.kind} ("${described.name}")`);
    // The trap only exists where a landmark is close enough to be borrowed.
    const near = landmarksAround(world, site.x, site.z, world.seed, 900, []);
    if (near.length) checked++;
  }
  assert.ok(checked > 0,
    'no station had a landmark inside the fallback radius, so this asserts nothing');
}

// --- a landmark is still named as itself --------------------------------------
{
  const landmark = [...graph.nodes.values()].find((node) => !node.key.startsWith('R'));
  const described = describeLandmark(world, world.seed, landmark.key, landmark.x, landmark.z);
  assert.notEqual(described.kind, 'railway-station',
    'naming stations must not capture ordinary landmarks');
}

// --- the same world, gathered twice, gives the same spurs ---------------------
// Both threads run this: the worker builds chunk geometry from trailsAround and
// the main thread builds the nav graph from it. A station spur that differed
// between them would draw a path the graph does not have.
{
  clearTrailCache();
  const again = [];
  trailsAround(world, 0, 0, world.seed, TRAVEL_RADIUS, again);
  const spurIds = (list) => list
    .filter((edge) => edge.fromKey.startsWith('R') || edge.toKey.startsWith('R'))
    .map((edge) => `${edge.id}@${Math.round(edge.arcLength)}`)
    .sort();
  assert.deepEqual(spurIds(again), spurIds(edges),
    'station spurs must be identical between gathers');
}

// --- a world with no railway is untouched -------------------------------------
// Stations arrive with the plan, so before it lands the network must be exactly
// what it always was rather than short a few edges or holding empty nodes.
{
  const bare = new World(20260612);
  clearTrailCache();
  const bareEdges = [];
  trailsAround(bare, 0, 0, bare.seed, 5000, bareEdges);
  assert.ok(bareEdges.length > 0, 'a railway-free world still has trails');
  assert.equal(
    bareEdges.filter((edge) => edge.fromKey.startsWith('R') || edge.toKey.startsWith('R')).length,
    0, 'a world with no railway plan must produce no station spurs');
}

console.log('railway station trails ok');
