// NPCs stand on what the player stands on.
//
// This is asserted against the real WalkableSurface and a real bridge, because
// the whole point is that the two systems agree. A test with its own stub ground
// function would prove the plumbing and nothing about whether an NPC and the
// player resolve the same river the same way — which is the bug it exists to
// prevent.

import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { trailsAround, clearTrailCache, trailFrameAtArc } from '../src/trails.js';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import { solveCrossing } from '../src/trailcrossings.mjs';
import {
  beginGroundingFrame, createGrounding, groundHeightFor, groundingStats,
  releaseGrounding,
} from '../src/npcgrounding.mjs';

const world = new World(20260612);
clearTrailCache();
const edges = [];
trailsAround(world, 0, 0, world.seed, 5000, edges);

let bridge = null;
let bridgeEdge = null;
for (const edge of edges) {
  for (const ford of edge.fords || []) {
    const solved = solveCrossing(world, edge, ford);
    if (solved && solved.kind === 'bridge' && solved.span > 25) {
      bridge = solved; bridgeEdge = edge; break;
    }
  }
  if (bridge) break;
}
assert.ok(bridge, 'the sample region must contain a bridge to stand an NPC on');

const surface = new WalkableSurface(world, { seed: world.seed, trailsAround });

// --- an NPC on a bridge stands on the bridge ----------------------------------
// The failure this prevents: the player walks the deck while an NPC beside them
// wades the river, because each asked a different system where the ground was.
{
  const grounding = createGrounding({
    groundAt: surface.groundProvider(), samplesPerFrame: 32,
  });
  const frame = {};
  let carried = 0;
  let steps = 0;
  for (let i = 0; i <= 20; i++) {
    beginGroundingFrame(grounding);
    trailFrameAtArc(bridgeEdge, bridge.arcStart + bridge.deckLength * (i / 20), frame);
    const y = groundHeightFor(grounding, 'walker', frame.x, frame.z, {
      fallback: world.height(frame.x, frame.z),
    });
    steps++;
    if (y >= bridge.surfaceY - 0.01) carried++;
  }
  assert.equal(carried, steps,
    `an NPC crossing must be carried by the deck at every step, ${carried}/${steps} were`);
}

// --- and it agrees with the player, exactly -----------------------------------
{
  const grounding = createGrounding({
    groundAt: surface.groundProvider(), samplesPerFrame: 32,
  });
  const frame = {};
  for (let i = 0; i <= 10; i++) {
    beginGroundingFrame(grounding);
    trailFrameAtArc(bridgeEdge, bridge.arcStart + bridge.deckLength * (i / 10), frame);
    const npc = groundHeightFor(grounding, `npc-${i}`, frame.x, frame.z, { fallback: 0 });
    const player = surface.groundAt(frame.x, frame.z);
    assert.ok(Math.abs(npc - player) < 1e-9,
      `NPC ground ${npc.toFixed(3)} and player ground ${player.toFixed(3)} must be the same number`);
  }
}

// --- a platform resident costs nothing and never leaves its platform ----------
{
  const grounding = createGrounding({
    groundAt: surface.groundProvider(), samplesPerFrame: 4,
  });
  beginGroundingFrame(grounding);
  const platformY = 41.75;
  for (let i = 0; i < 20; i++) {
    const y = groundHeightFor(grounding, `resident-${i}`, 1000 + i, 2000, {
      fixedY: platformY, fallback: 0,
    });
    assert.equal(y, platformY,
      'a station resident stands on its authored platform, not on the terrain under it');
  }
  assert.equal(groundingStats(grounding).sampled, 0,
    'and a stationful of residents spends none of the budget travellers need');
}

// --- the ceiling holds with a crowd on a bridge -------------------------------
{
  const grounding = createGrounding({
    groundAt: surface.groundProvider(), samplesPerFrame: 6,
  });
  const frame = {};
  const keys = Array.from({ length: 30 }, (_, i) => `crowd-${i}`);
  // First frame seeds everyone; after that the ceiling binds.
  for (let pass = 0; pass < 2; pass++) {
    beginGroundingFrame(grounding);
    for (let i = 0; i < keys.length; i++) {
      trailFrameAtArc(bridgeEdge, bridge.arcStart + bridge.deckLength * (i / keys.length), frame);
      groundHeightFor(grounding, keys[i], frame.x, frame.z, { fallback: 0 });
    }
  }
  const stats = groundingStats(grounding);
  assert.equal(stats.sampled, 6, `the ceiling must hold, ${stats.sampled} samples were taken`);
  assert.equal(stats.deferred, 24, 'and the rest keep the height they had');
  assert.equal(stats.tracked, 30, 'while everybody still has a height');
}

// --- no surface wired means hold position, not fall to the origin -------------
{
  const grounding = createGrounding({ groundAt: null });
  beginGroundingFrame(grounding);
  assert.equal(groundHeightFor(grounding, 'a', 0, 0, { fallback: 17.5 }), 17.5,
    'with no walkable surface an NPC keeps the height it was given');
}

// --- departed NPCs stop being tracked -----------------------------------------
{
  const grounding = createGrounding({ groundAt: surface.groundProvider() });
  beginGroundingFrame(grounding);
  groundHeightFor(grounding, 'gone', bridge.x, bridge.z, { fallback: 0 });
  assert.equal(groundingStats(grounding).tracked, 1, 'tracked while present');
  releaseGrounding(grounding, 'gone');
  assert.equal(groundingStats(grounding).tracked, 0, 'and released when it leaves');
}

console.log('npcgrounding PASS · an NPC is carried by the same bridge the player walks · '
  + 'both resolve to the identical height · platform residents cost nothing · '
  + 'the per-frame ceiling holds under a crowd · a missing surface holds position');
