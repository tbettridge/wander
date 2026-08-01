// Standing on the things that stand above the ground.
//
// Bridge decks and railway spans are invisible to world.height(): the terrain
// beneath them is left natural on purpose. Without a surface layer a walker
// crosses a river by strolling through the deck and into the water, and crosses
// a viaduct by falling into the valley.
//
// The player's feet and an NPC's gait both resolve against this one provider,
// so what these assert holds for both.

import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { trailsAround, clearTrailCache } from '../src/trails.js';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import {
  deckHeightAt, DECK_HALF_WIDTH, DECK_STEP_UP, solveCrossing,
} from '../src/trailcrossings.mjs';
import { trailFrameAtArc } from '../src/trails.js';
import { planRegionalRailway } from '../src/railwayplanner.mjs';
import { serializeRailwayTerrainPlan, setWorldRailwayTerrain } from '../src/railwayterrain.mjs';

const world = new World(20260612);
clearTrailCache();

// --- find a real bridge to walk ----------------------------------------------
const edges = [];
trailsAround(world, 0, 0, world.seed, 5000, edges);
let bridge = null;
let bridgeEdge = null;
for (const edge of edges) {
  for (const ford of edge.fords || []) {
    const fx = ford.centerX ?? ford.x, fz = ford.centerZ ?? ford.z;
    if (!world.riverAt(fx, fz).wet) continue;
    const solved = solveCrossing(world, edge, ford);
    if (solved && solved.kind === 'bridge' && solved.span > 25) {
      bridge = solved; bridgeEdge = edge; break;
    }
  }
  if (bridge) break;
}
assert.ok(bridge, 'the sample region must contain a real bridge to test');
void bridgeEdge;

// --- walking across it stays dry ---------------------------------------------
{
  const surface = new WalkableSurface(world, { seed: world.seed, trailsAround });
  const steps = 60;
  let onDeck = 0;
  let lowest = Infinity;
  const frame = {};
  for (let i = 0; i <= steps; i++) {
    // Follow the TRAIL across, the way a walker does — not a straight chord
    // between the banks, which is where the deck used to be tested and is how
    // a walker came to step off the side of their own bridge.
    trailFrameAtArc(bridgeEdge, bridge.arcStart + bridge.deckLength * (i / steps), frame);
    const y = surface.groundAt(frame.x, frame.z, bridge.surfaceY);
    lowest = Math.min(lowest, y);
    if (Math.abs(y - bridge.surfaceY) < 0.01) onDeck++;
  }
  assert.equal(onDeck, steps + 1,
    `every step across the bridge must land on the deck, ${onDeck}/${steps + 1} did`);
  assert.ok(lowest > bridge.waterY,
    `a walker crossing must never drop below the water (lowest ${lowest.toFixed(2)} vs water ${bridge.waterY.toFixed(2)})`);
}

// --- but you can still wade underneath ---------------------------------------
{
  const surface = new WalkableSurface(world, { seed: world.seed, trailsAround });
  // Someone down at water level, beneath the middle of the span.
  const x = bridge.x, z = bridge.z;
  const under = surface.heightAt(x, z, bridge.waterY);
  assert.equal(under, null,
    'a walker at water level must not be lifted onto the deck above them');
  // And the same point IS a deck once they are up at its level.
  const above = surface.heightAt(x, z, bridge.surfaceY);
  assert.ok(above !== null && Math.abs(above - bridge.surfaceY) < 0.01,
    'the same point is solid underfoot once the walker is at deck level');
}

// --- the deck ends where the deck ends ---------------------------------------
{
  // Off the side: stepping sideways off a bridge should drop you.
  const edgeMap = new Map([[bridgeEdge.id, bridgeEdge]]);
  const offX = bridge.x + -bridge.tangentZ * (DECK_HALF_WIDTH + 2.5);
  const offZ = bridge.z + bridge.tangentX * (DECK_HALF_WIDTH + 2.5);
  assert.equal(deckHeightAt([bridge], edgeMap, offX, offZ, bridge.surfaceY), null,
    'there is no deck beyond the edge of the deck');

  // Past the far abutment, further along the trail.
  const past = trailFrameAtArc(bridgeEdge, bridge.arcEnd + 10, {});
  assert.equal(deckHeightAt([bridge], edgeMap, past.x, past.z, bridge.surfaceY), null,
    'the deck stops at its abutment');
}

// --- stepping stones are footholds, not a floor ------------------------------
{
  let stones = null;
  for (const edge of edges) {
    for (const ford of edge.fords || []) {
      const fx = ford.centerX ?? ford.x, fz = ford.centerZ ?? ford.z;
      if (!world.riverAt(fx, fz).wet) continue;
      const solved = solveCrossing(world, edge, ford);
      if (solved && solved.kind === 'stepping-stones') { stones = solved; break; }
    }
    if (stones) break;
  }
  if (stones) {
    assert.equal(stones.walkable, false,
      'a line of boulders must not become a continuous invisible floor');
    assert.equal(deckHeightAt([stones], new Map(), stones.x, stones.z, stones.surfaceY), null,
      'stepping stones offer no deck to glide across');
  }
}

// --- the step-up rule is what keeps both of those true ------------------------
{
  const justBelow = bridge.surfaceY - DECK_STEP_UP - 0.05;
  const justAbove = bridge.surfaceY - DECK_STEP_UP + 0.05;
  const stepMap = new Map([[bridgeEdge.id, bridgeEdge]]);
  assert.equal(deckHeightAt([bridge], stepMap, bridge.x, bridge.z, justBelow), null,
    'below the step-up threshold there is no deck underfoot');
  assert.ok(deckHeightAt([bridge], stepMap, bridge.x, bridge.z, justAbove) !== null,
    'within the step-up threshold the deck is underfoot');
}

// --- the railway's own spans carry a walker too -------------------------------
// Embankments and cuttings are already folded into world.height(), but a bridge
// or viaduct deliberately leaves the ground beneath it natural — so without a
// deck the line crosses a valley that a walker simply falls into.
{
  const railWorld = new World(20260612);
  const plan = planRegionalRailway(railWorld, {
    center: { x: 0, z: 0 }, seed: railWorld.seed ^ 0x5241494c,
    stationCount: 5, radius: 2600, searchRadius: 5200, exclusions: [],
  });
  const index = setWorldRailwayTerrain(railWorld, serializeRailwayTerrainPlan(plan));
  const BRIDGE_KIND = 3;

  let spans = 0, decked = 0, raised = 0, offSideRejected = 0;
  for (let i = 0; i < index.kinds.length; i++) {
    if (index.kinds[i] !== BRIDGE_KIND) continue;
    const o = i * 6;
    const x = (index.segments[o] + index.segments[o + 3]) / 2;
    const z = (index.segments[o + 1] + index.segments[o + 4]) / 2;
    const formation = (index.segments[o + 2] + index.segments[o + 5]) / 2;
    const ground = railWorld.height(x, z);
    spans++;

    const deck = index.deckAt(ground, x, z, formation + 1);
    if (deck !== null) {
      decked++;
      if (deck > ground + 0.3) raised++;
    }

    // Step off the side of a viaduct and there must be nothing under you.
    const dx = index.segments[o + 3] - index.segments[o];
    const dz = index.segments[o + 4] - index.segments[o + 1];
    const length = Math.hypot(dx, dz) || 1;
    if (index.deckAt(ground, x + (-dz / length) * 6, z + (dx / length) * 6, formation + 1) === null) {
      offSideRejected++;
    }
  }

  assert.ok(spans > 10, `the plan must contain bridge spans to test, found ${spans}`);
  assert.equal(decked, spans, `every span must carry a deck, ${decked}/${spans} did`);
  assert.ok(raised > spans * 0.4,
    `spans should mostly stand clear of the ground, ${raised}/${spans} did`);
  assert.equal(offSideRejected, spans,
    'stepping off the side of a span must find nothing to stand on');
}

console.log('walkablesurface PASS · a bridge carries a walker the whole way across · '
  + 'you can still wade beneath it · the deck ends at its edges · '
  + 'stepping stones stay footholds · railway spans carry a walker and drop them off the side');
