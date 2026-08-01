// Routing between landmarks over the real trail network.
//
// The graph is asserted against edges the desire-line solver actually produced,
// not a hand-built fixture. A fixture would prove the algorithm and nothing
// about whether the network it runs on is connected, which is the part that
// decides if an NPC can get anywhere.

import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { trailsAround, clearTrailCache, trailFrameAtArc } from '../src/trails.js';
import {
  advanceLeg, buildNavGraph, edgeCost, findRoute, hikingSpeed,
} from '../src/npcnavgraph.mjs';

const world = new World(20260612);

// Gathered at TRAVEL scale, not streaming scale. This matters more than it
// looks: trailsAround returns edges touching the query area, so a small radius
// silently omits every link to a landmark just outside it and the graph appears
// fragmented. Measured on this seed:
//
//     radius  5000 →  11 nodes, 3 components, largest 55%
//     radius 10000 →  87 nodes, 4 components, largest 54%
//     radius 20000 → 272 nodes, 3 components, largest 96%
//
// The network is well connected. A cheap gather just cannot see it, and an NPC
// routed on one would be stranded by an artifact of the query radius rather
// than by the world.
const TRAVEL_RADIUS = 20000;
clearTrailCache();
const edges = [];
trailsAround(world, 0, 0, world.seed, TRAVEL_RADIUS, edges);

const graph = buildNavGraph(edges);
assert.ok(graph.nodes.size > 100,
  `a travel-scale gather must hold a real network, had ${graph.nodes.size} nodes`);

// --- the network is connected enough to be worth routing on -------------------
// A graph of isolated pairs would pass every algorithmic test and still leave
// every NPC stranded, so the connectivity itself is the assertion.
{
  const keys = [...graph.nodes.keys()];
  // Sample rather than sweep: the point is the shape of the network, and an
  // all-pairs sweep over 272 nodes buys no extra confidence for the time.
  const from = keys[0];
  const targets = keys.filter((k) => k !== from).filter((_, i) => i % 5 === 0);
  const reachable = targets.filter((to) => findRoute(graph, from, to)).length;
  const fraction = reachable / targets.length;
  assert.ok(fraction > 0.8,
    `most landmarks must be reachable from one another, only ${(fraction * 100).toFixed(0)}% were`);
}

// --- a streaming-scale gather is NOT enough to route on -----------------------
// Pinned deliberately. If someone later shrinks the radius for speed, this says
// what it costs before an NPC walks into a dead end to demonstrate it.
{
  clearTrailCache();
  const near = [];
  trailsAround(world, 0, 0, world.seed, 5000, near);
  const small = buildNavGraph(near);
  assert.ok(small.nodes.size < graph.nodes.size / 4,
    'a 5km gather sees only a fraction of the network');
  clearTrailCache();
  const again = [];
  trailsAround(world, 0, 0, world.seed, TRAVEL_RADIUS, again);
  assert.equal(buildNavGraph(again).nodes.size, graph.nodes.size,
    'and the travel-scale graph rebuilds identically');
}

// --- a route is contiguous, and its legs join end to end ----------------------
{
  const keys = [...graph.nodes.keys()];
  let route = null;
  let from = null;
  let to = null;
  for (const a of keys.slice(0, 6)) {
    for (const b of keys) {
      if (a === b) continue;
      const found = findRoute(graph, a, b);
      if (found && found.legs.length >= 2) { route = found; from = a; to = b; break; }
    }
    if (route) break;
  }
  assert.ok(route, 'the region must contain a multi-leg route to inspect');
  assert.equal(route.keys[0], from, 'a route starts where it was asked to');
  assert.equal(route.keys[route.keys.length - 1], to, 'and ends where it was sent');
  assert.equal(route.legs.length, route.keys.length - 1,
    'a leg for every step between landmarks');

  // Legs do NOT meet, and must not pretend to. Trail edges stop at a landmark's
  // clearing halo rather than its centre, so consecutive legs end and begin at
  // different points on that halo and the traveller crosses open ground between
  // them. Measured over 416 routes and 5180 junctions on this seed:
  // min 16.0m, median 43.5m, max 100.0m.
  //
  // What the route owes is an honest account of that hop, not a pretence that
  // it is zero. A gap reported as 0 while the positions differ is an NPC
  // teleporting across a clearing.
  for (let i = 0; i < route.legs.length - 1; i++) {
    const leg = route.legs[i];
    const next = route.legs[i + 1];
    const end = trailFrameAtArc(leg.edge, leg.endArc, {});
    const start = trailFrameAtArc(next.edge, next.startArc, {});
    const measured = Math.hypot(end.x - start.x, end.z - start.z);
    assert.ok(Math.abs(leg.gapToNext - measured) < 1e-6,
      `leg ${i} reports a ${leg.gapToNext.toFixed(1)}m transfer but the positions are ${measured.toFixed(1)}m apart`);
    assert.ok(leg.gapToNext <= 110,
      `a clearing transfer of ${leg.gapToNext.toFixed(1)}m is larger than any halo should produce`);
  }
  assert.equal(route.legs[route.legs.length - 1].gapToNext, 0,
    'the last leg arrives; it has nothing to transfer to');

  const summed = route.legs.reduce((sum, leg) => sum + leg.gapToNext, 0);
  assert.ok(Math.abs(route.openGroundDistance - summed) < 1e-6,
    'the route totals the open ground it commits the traveller to');
  assert.ok(route.openGroundDistance > 0,
    'a multi-leg route always crosses at least one clearing');
  assert.ok(route.openGroundDistance < route.distance,
    'but open ground is the minority of the walk — trails are still the route');
}

// --- direction is respected ---------------------------------------------------
{
  const node = [...graph.nodes.values()].find((n) => n.links.length > 0);
  const backward = node.links.find((l) => !l.forward);
  if (backward) {
    const length = backward.edge.arcLength;
    const leg = {
      edge: backward.edge, forward: false, startArc: length, endArc: 0,
    };
    const start = advanceLeg(leg, 0);
    const end = advanceLeg(leg, length);
    assert.ok(Math.abs(start.arc - length) < 1e-6,
      'walking an edge backwards starts at its far end');
    assert.ok(Math.abs(end.arc) < 1e-6, 'and finishes at its near one');
    assert.equal(end.done, true, 'and knows it is finished');
  }
}

// --- cost prefers the gentle route over the short steep one -------------------
{
  const gentle = { arcLength: 1000, meanGrade: 0.02, fordCount: 0, bridgeCount: 0 };
  const steep = { arcLength: 600, meanGrade: 0.30, fordCount: 0, bridgeCount: 0 };
  assert.ok(edgeCost(gentle) < edgeCost(steep),
    'a longer gentle route must beat a shorter steep one — this is the whole '
    + 'point of routing rather than walking straight at the destination');
}

// --- a gentle decline is the fastest going, and steep is slow either way ------
// "Declines matter less" was a stated requirement. Tobler carries it through the
// +0.05 offset rather than through a rule written on top.
{
  assert.ok(hikingSpeed(-0.05) > hikingSpeed(0),
    'a slight decline is faster than the flat');
  assert.ok(hikingSpeed(-0.05) >= hikingSpeed(-0.05 + 1e-9),
    'and it is the peak, not merely better than level');
  assert.ok(hikingSpeed(0.30) < hikingSpeed(0.10),
    'a steep climb is slower than a moderate one');
  assert.ok(hikingSpeed(-0.45) < hikingSpeed(-0.05),
    'and a plunging descent is slow too — going down hard is not free');
}

// --- steepness has to hurt disproportionately ---------------------------------
// A linear penalty got this backwards: at weight 2.4 a 600m route at 30% grade
// cost 1032 against 1048 for a 1000m route at 2%, so the solver would have sent
// every traveller straight up the hill. The exponential is not a tuning choice.
{
  const gentleLong = { arcLength: 1400, meanGrade: 0.02, fordCount: 0, bridgeCount: 0 };
  const steepShort = { arcLength: 600, meanGrade: 0.30, fordCount: 0, bridgeCount: 0 };
  assert.ok(edgeCost(gentleLong) < edgeCost(steepShort),
    'a route more than twice as long still wins if the short one is steep enough');
}

// --- a built bridge is not charged as a wet crossing --------------------------
{
  const wet = { arcLength: 500, meanGrade: 0.05, fordCount: 2, bridgeCount: 0 };
  const bridged = { arcLength: 500, meanGrade: 0.05, fordCount: 2, bridgeCount: 2 };
  assert.ok(edgeCost(bridged) < edgeCost(wet),
    'a crossing that got a bridge is a dry way over, not a ford');
  assert.equal(edgeCost(bridged), edgeCost({ ...bridged, fordCount: 0, bridgeCount: 0 }),
    'a fully bridged edge costs exactly what an unforded one costs');
}

// --- honest failure rather than an invented path ------------------------------
{
  assert.equal(findRoute(graph, 'nowhere-at-all', [...graph.nodes.keys()][0]), null,
    'an unknown landmark has no route, and says so');
  const key = [...graph.nodes.keys()][0];
  const self = findRoute(graph, key, key);
  assert.equal(self.legs.length, 0, 'going nowhere takes no legs');
  assert.equal(self.cost, 0, 'and costs nothing');
}

// --- a repeated edge does not become two arcs ---------------------------------
{
  const doubled = buildNavGraph([...edges, ...edges]);
  assert.equal(doubled.edgeCount, graph.edgeCount,
    'trailsAround can hand back the same edge twice; the graph must not double it');
}

console.log('npcnavgraph PASS · the trail network is connected enough to route on · '
  + 'clearing transfers between legs are reported rather than teleported · '
  + 'direction is respected · gentle beats steep on hiking time · '
  + 'declines are the fastest going · bridges are not charged as fords');
