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
import { trailsAround, clearTrailCache, nearestTrailPoint } from '../src/trails.js';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import {
  deckHeightAlong, deckHeightAt, DECK_HALF_WIDTH, DECK_STEP_UP, solveCrossing,
} from '../src/trailcrossings.mjs';
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
    const near = nearestTrailPoint([edge], fx, fz);
    const solved = solveCrossing(world, ford, near.tangentX, near.tangentZ);
    if (solved && solved.kind === 'bridge' && solved.span > 25) {
      bridge = solved; bridgeEdge = edge; break;
    }
  }
  if (bridge) break;
}
assert.ok(bridge, 'the sample region must contain a real bridge to test');
void bridgeEdge;

// --- the deck meets the ground at both ends ----------------------------------
// Held at one flat height a deck lands on neither bank: whichever is lower gets
// the whole difference as a step, measured as high as 5.9m. Since that is more
// than anyone can climb, EVERY bridge was impossible to walk onto — the deck
// existed but could not be reached.
{
  let unmountable = 0;
  let checked = 0;
  for (const edge of edges) {
    for (const ford of edge.fords || []) {
      const fx = ford.centerX ?? ford.x, fz = ford.centerZ ?? ford.z;
      if (!world.riverAt(fx, fz).wet) continue;
      const near = nearestTrailPoint([edge], fx, fz);
      const solved = solveCrossing(world, ford, near.tangentX, near.tangentZ);
      if (!solved || !solved.walkable) continue;
      checked++;
      for (const along of [solved.startAlong, solved.startAlong + solved.deckLength]) {
        const x = solved.x + solved.tangentX * along;
        const z = solved.z + solved.tangentZ * along;
        const step = Math.abs(deckHeightAlong(solved, along) - world.height(x, z));
        if (step > DECK_STEP_UP) unmountable++;
      }
    }
  }
  assert.ok(checked > 5, `need crossings to check, had ${checked}`);
  assert.equal(unmountable, 0,
    `every deck end must be reachable from the ground beside it, ${unmountable} were not`);
}

// --- walking across it stays dry ---------------------------------------------
{
  const surface = new WalkableSurface(world, { seed: world.seed, trailsAround, nearestTrailPoint });
  const steps = 60;
  let onDeck = 0;
  let dry = 0;
  let overWater = 0;
  let worstSubmersion = 0;
  for (let i = 0; i <= steps; i++) {
    const along = bridge.startAlong + bridge.deckLength * (i / steps);
    const x = bridge.x + bridge.tangentX * along;
    const z = bridge.z + bridge.tangentZ * along;
    const expected = deckHeightAlong(bridge, along);
    // A walker already at deck level, as they would be having stepped on.
    const y = surface.groundAt(x, z, expected);
    // The deck must always be underfoot — but where a bank rises above it near
    // an abutment, standing on the higher ground is right. So the rule is that
    // a walker is never BELOW the deck.
    if (y >= expected - 0.01) onDeck++;
    // And wherever there is water under them, they are above ITS surface. The
    // river falls along its length, so this has to be the local level, not the
    // one sampled at the middle of the crossing.
    const river = world.riverAt(x, z);
    if (!river.wet) continue;
    overWater++;
    if (y > river.y) dry++;
    else worstSubmersion = Math.max(worstSubmersion, river.y - y);
  }
  assert.equal(onDeck, steps + 1,
    `no step across may fall below the deck, ${onDeck}/${steps + 1} held`);
  assert.ok(overWater > 5, `the crossing must actually span water, ${overWater} steps did`);
  assert.equal(dry, overWater,
    `every step over water must stay above it, ${dry}/${overWater} did `
    + `(worst ${worstSubmersion.toFixed(2)}m under)`);
}

// --- but you can still wade underneath ---------------------------------------
{
  const surface = new WalkableSurface(world, { seed: world.seed, trailsAround, nearestTrailPoint });
  // Someone down at water level, beneath the middle of the span.
  const x = bridge.x, z = bridge.z;
  const under = surface.heightAt(x, z, bridge.waterY);
  assert.equal(under, null,
    'a walker at water level must not be lifted onto the deck above them');
  // And the same point IS a deck once they are up at its level.
  const centreDeck = deckHeightAlong(bridge, 0);
  const above = surface.heightAt(x, z, centreDeck);
  assert.ok(above !== null && Math.abs(above - centreDeck) < 0.01,
    'the same point is solid underfoot once the walker is at deck level');
}

// --- the deck ends where the deck ends ---------------------------------------
{
  // Off the side: stepping sideways off a bridge should drop you.
  const offX = bridge.x + -bridge.tangentZ * (DECK_HALF_WIDTH + 1.5);
  const offZ = bridge.z + bridge.tangentX * (DECK_HALF_WIDTH + 1.5);
  assert.equal(deckHeightAt([bridge], offX, offZ, bridge.surfaceY + 1), null,
    'there is no deck beyond the edge of the deck');

  // Past the far abutment, along the axis.
  const pastAlong = bridge.startAlong + bridge.deckLength + 8;
  const pastX = bridge.x + bridge.tangentX * pastAlong;
  const pastZ = bridge.z + bridge.tangentZ * pastAlong;
  assert.equal(deckHeightAt([bridge], pastX, pastZ, bridge.surfaceY + 1), null,
    'the deck stops at its abutment');
}

// --- stepping stones are footholds, not a floor ------------------------------
{
  let stones = null;
  for (const edge of edges) {
    for (const ford of edge.fords || []) {
      const fx = ford.centerX ?? ford.x, fz = ford.centerZ ?? ford.z;
      if (!world.riverAt(fx, fz).wet) continue;
      const near = nearestTrailPoint([edge], fx, fz);
      const solved = solveCrossing(world, ford, near.tangentX, near.tangentZ);
      if (solved && solved.kind === 'stepping-stones') { stones = solved; break; }
    }
    if (stones) break;
  }
  if (stones) {
    assert.equal(stones.walkable, false,
      'a line of boulders must not become a continuous invisible floor');
    assert.equal(deckHeightAt([stones], stones.x, stones.z, stones.surfaceY), null,
      'stepping stones offer no deck to glide across');
  }
}

// --- the step-up rule is what keeps both of those true ------------------------
{
  const centreDeck = deckHeightAlong(bridge, 0);
  const justBelow = centreDeck - DECK_STEP_UP - 0.05;
  const justAbove = centreDeck - DECK_STEP_UP + 0.05;
  assert.equal(deckHeightAt([bridge], bridge.x, bridge.z, justBelow), null,
    'below the step-up threshold there is no deck underfoot');
  assert.ok(deckHeightAt([bridge], bridge.x, bridge.z, justAbove) !== null,
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
