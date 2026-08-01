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
  deckHalfWidth, deckHeightAt, DECK_EDGE_MARGIN, DECK_STEP_UP, solveCrossing,
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
    // Never BELOW the deck. At an abutment the bank can stand a little proud of
    // it, and standing on the higher of the two is right.
    if (y >= bridge.surfaceY - 0.01) onDeck++;
  }
  assert.equal(onDeck, steps + 1,
    `no step across may fall below the deck, ${onDeck}/${steps + 1} held`);
  assert.ok(lowest > bridge.waterY,
    `a walker crossing must never drop below the water (lowest ${lowest.toFixed(2)} vs water ${bridge.waterY.toFixed(2)})`);
}

// --- you can get ON in the first place ---------------------------------------
// The failure that made every trail bridge unusable was not the deck's height
// over the water, it was its height over the BANK. Held at a level chosen
// without reference to where the trail arrives, the deck hung as much as 8m in
// the air: too high to climb, so it was never offered underfoot and a walker
// passed straight through it. Approaching along the trail is the only test that
// catches that, because standing on the deck already assumes the answer.
{
  const surface = new WalkableSurface(world, { seed: world.seed, trailsAround });
  const frame = {};
  let mounted = 0;
  let checked = 0;
  for (const edge of edges) {
    for (const ford of edge.fords || []) {
      const solved = solveCrossing(world, edge, ford);
      if (!solved || !solved.walkable) continue;
      checked++;
      // Walk in from dry land at ground height, as a walker actually arrives.
      let y = null;
      let carried = true;
      for (let arc = solved.arcStart - 12; arc <= solved.arcEnd + 12; arc += 0.4) {
        trailFrameAtArc(edge, arc, frame);
        const ground = world.height(frame.x, frame.z);
        if (y === null) y = ground;
        const deck = surface.heightAt(frame.x, frame.z, y);
        y = deck !== null && deck > ground ? deck : ground;
        // Over the bridge itself the deck must be what carries them. Anything
        // else means walking through it.
        if (arc >= solved.arcStart && arc <= solved.arcEnd && y < solved.surfaceY - 0.01) {
          carried = false;
        }
      }
      if (carried) mounted++;
    }
  }
  assert.ok(checked > 5, `need crossings to walk onto, had ${checked}`);
  assert.equal(mounted, checked,
    `a walker arriving on foot must be carried by every bridge: ${mounted}/${checked} were`);
}

// --- the deck is unconditional, and wading under it is given up ---------------
// There was a height test here: ignore the deck unless the walker is already
// near its level, so somebody in the river could pass beneath a footbridge. It
// is also the one gate that can silently refuse a deck to a walker standing on
// its planks. Walking OVER a bridge matters more than walking under one, so the
// deck now wins inside its footprint whatever height the walker is at.
{
  const surface = new WalkableSurface(world, { seed: world.seed, trailsAround });
  const x = bridge.x, z = bridge.z;
  const fromBelow = surface.heightAt(x, z, bridge.waterY);
  assert.ok(fromBelow !== null && Math.abs(fromBelow - bridge.surfaceY) < 0.01,
    'the deck carries a walker regardless of the height they approach it from');
  const fromDeck = surface.heightAt(x, z, bridge.surfaceY);
  assert.ok(fromDeck !== null && Math.abs(fromDeck - bridge.surfaceY) < 0.01,
    'and the same, standing on it');
}

// --- the deck ends where the deck ends ---------------------------------------
{
  // Off the side: stepping sideways off a bridge should drop you. Measured from
  // the reach this crossing actually uses — the deck is as wide as the trail it
  // carries, plus a deliberately generous footing margin, so a probe at a fixed
  // distance stops testing the edge the moment either changes.
  const edgeMap = new Map([[bridgeEdge.id, bridgeEdge]]);
  const beyond = deckHalfWidth(bridgeEdge) + DECK_EDGE_MARGIN + 2.5;
  const offX = bridge.x + -bridge.tangentZ * beyond;
  const offZ = bridge.z + bridge.tangentX * beyond;
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

// --- the footprint is now the only thing that decides ------------------------
{
  const stepMap = new Map([[bridgeEdge.id, bridgeEdge]]);
  for (const atY of [bridge.waterY - 5, bridge.waterY, bridge.surfaceY, bridge.surfaceY + 5]) {
    assert.ok(deckHeightAt([bridge], stepMap, bridge.x, bridge.z, atY) !== null,
      `the deck is underfoot on its own centreline, approached from ${atY.toFixed(1)}`);
  }
}

// --- one surface, two walkers ------------------------------------------------
// The player and every NPC share a single WalkableSurface. It used to hold one
// active set around one moving centre, so an NPC asking about its own footing
// somewhere else re-gathered the cache around ITSELF and evicted the crossing
// the player was standing on. The player fell through a bridge whose deck the
// surface had reported, correctly, one frame earlier.
//
// Every other test here has exactly one walker, which is why all of them passed
// while no bridge in the running game could be crossed.
{
  const surface = new WalkableSurface(world, { seed: world.seed, trailsAround });
  const frame = {};
  // Somewhere far enough away to have been a different gather entirely.
  const elsewhere = { x: bridge.x + 900, z: bridge.z - 700 };

  let held = 0;
  let steps = 0;
  for (let i = 0; i <= 40; i++) {
    trailFrameAtArc(bridgeEdge, bridge.arcStart + bridge.deckLength * (i / 40), frame);
    // An NPC elsewhere asks about its footing between the player's own queries.
    surface.groundAt(elsewhere.x, elsewhere.z);
    steps++;
    if (surface.heightAt(frame.x, frame.z, bridge.surfaceY) !== null) held++;
  }
  assert.equal(held, steps,
    `a distant walker must not evict the deck underfoot: ${held}/${steps} steps held`);
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
