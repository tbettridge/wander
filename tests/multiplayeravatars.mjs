// A visitor is a person, not a placeholder.
//
// Remote players used to be a capsule with a sphere on top that leaned when a
// `moving` flag was set. Everyone else in this world walks: the gait solver
// plants feet, swings the arms against the hips and leans into turns. A visitor
// standing among villagers who all move properly was the one thing in the scene
// that read as unfinished.
//
// The gait is deliberately NOT driven from the `moving` boolean. Locomotion
// measures speed from how far the body actually travelled since the last frame,
// so the same interpolation that smooths a remote pose is what produces the walk
// — including slowing to a stop, which a boolean cannot express.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createNpcIdentity } from '../src/npcpopulation.mjs';
import { npcWorldDimensions } from '../src/npcanatomy.mjs';
import { advanceNpcLocomotion, createNpcLocomotionState } from '../src/npclocomotion.mjs';

const source = await readFile(new URL('../src/multiplayeravatars.js', import.meta.url), 'utf8');

// --- the visitor is built from the villagers' own parts ----------------------
{
  assert.match(source, /createNpcAvatar/, 'a visitor must be built by the NPC avatar factory');
  assert.match(source, /advanceNpcLocomotion/, 'and driven by the same gait solver');
  assert.doesNotMatch(source, /CapsuleGeometry/, 'the placeholder capsule body must be gone');
  assert.doesNotMatch(source, /SphereGeometry/, 'and the placeholder head with it');
  // The label is the one non-anatomical part worth keeping: it is how you know
  // which traveller you are looking at.
  assert.match(source, /createLabel/, 'the name label stays');
}

// --- the same player is recognisably the same person every visit -------------
{
  const identityFor = (playerId) => createNpcIdentity({
    worldSeed: 20260612,
    stationId: 'visitors',
    stationName: 'Visitors',
    slot: { key: `visitor:${playerId}`, role: 'traveller', family: 'storybook', activity: 'wait' },
  });
  const first = identityFor('player:abc');
  const again = identityFor('player:abc');
  const other = identityFor('player:xyz');
  assert.equal(first.seed, again.seed, 'a visitor keeps the same face between visits');
  assert.notEqual(first.seed, other.seed, 'and two visitors do not share one');
  assert.match(source, /slot: \{ key: `visitor:\$\{playerId\}`/,
    'the identity must be seeded from the player id, not from arrival order');
}

// --- walking is what moving actually produces --------------------------------
// Drive the solver the way the manager does: step the body along, and read the
// gait out of the displacement rather than out of a flag.
{
  const identity = createNpcIdentity({
    worldSeed: 1, stationId: 'visitors', stationName: 'Visitors',
    slot: { key: 'visitor:walker', role: 'traveller', family: 'storybook', activity: 'wait' },
  });
  const dims = npcWorldDimensions(
    { hip: 0.9, eye: 1.6, legLength: 0.9, girth: {} }, identity.proportions,
  );
  const state = createNpcLocomotionState(0);
  const walk = (steps, metresPerFrame) => {
    let x = 0;
    const feet = [];
    for (let i = 0; i < steps; i++) {
      x += metresPerFrame;
      const pose = advanceNpcLocomotion(state, {
        dims, dt: 1 / 60, position: [x, 0, 0], heading: Math.PI / 2, fixedY: 0,
      });
      if (pose) feet.push(pose.legs.map((leg) => leg.foot?.[1] ?? 0));
    }
    return feet;
  };

  const walking = walk(180, 1.3 / 60);
  const lift = walking.map((f) => Math.max(...f)).reduce((a, b) => Math.max(a, b), 0);
  assert.ok(lift > 0.01, `a walking visitor must pick its feet up, saw ${lift.toFixed(3)}m`);

  // Standing still must settle, or a stationary visitor marches on the spot.
  const still = createNpcLocomotionState(0);
  let last = null;
  for (let i = 0; i < 240; i++) {
    last = advanceNpcLocomotion(still, {
      dims, dt: 1 / 60, position: [0, 0, 0], heading: 0, fixedY: 0,
    });
  }
  assert.ok((last?.locomotion?.speed ?? 1) < 0.05,
    'a visitor who stopped sending movement must come to rest');
}

// --- the manager is wired to the world it stands in --------------------------
{
  const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /new MultiplayerAvatarManager\(scene, \{ maxAvatars: 3, worldSeed: world\.seed \}\)/,
    'visitor identities must be seeded from this world');
  assert.match(mainSource, /multiplayerAvatars\.setSurfaceQuery\(walkableSurface\.queryProvider\(\)\)/,
    'a visitor must be solved against the ground everyone else stands on');
  assert.match(mainSource, /multiplayerAvatars\.assets = settlementSystem\.npcAssets/,
    'and share the geometry cache rather than duplicating every part');
}

console.log('multiplayeravatars PASS · visitors wear the villagers\' bodies · one face per player · '
  + 'the walk comes from real displacement · rest settles · grounded and sharing the asset cache');
