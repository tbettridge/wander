// Village crowds: nobody walks through anybody, and attention is earned.

import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceNpcSteering, createNpcSteeringState, MIN_SEPARATION } from '../src/npcsteering.mjs';
import { ATTENTION, knowsPlayer, playerAttention } from '../src/npcattention.mjs';
import { advanceEncounter, createEncounterState } from '../src/npcencounter.mjs';
import { advanceGaze, createGazeState } from '../src/npcgaze.mjs';
import { mulberry32 } from '../src/noise.js';

test('forty walkers crossing a square never stay inside each other', () => {
  const rng = mulberry32(42);
  const agents = Array.from({ length: 40 }, () => {
    const angle = rng() * Math.PI * 2;
    return {
      position: { x: Math.cos(angle) * 12, y: 0, z: Math.sin(angle) * 12 },
      target: { x: -Math.cos(angle) * 12 + (rng() - 0.5) * 3, z: -Math.sin(angle) * 12 + (rng() - 0.5) * 3 },
      steering: createNpcSteeringState(angle + Math.PI),
    };
  });
  const records = agents.map((agent) => ({ pos: agent.position, vx: 0, vz: 0, speed: 0 }));
  const overlapping = new Map();
  let worst = 0, closest = Infinity;
  for (let frame = 0; frame < 60 * 25; frame++) {
    agents.forEach((agent, index) => {
      records[index].vx = agent.steering.vx; records[index].vz = agent.steering.vz; records[index].speed = agent.steering.speed;
    });
    for (const agent of agents) {
      advanceNpcSteering(agent.steering, {
        position: agent.position, target: agent.target, dt: 1 / 60, maxSpeed: 1.3, neighbours: records,
      });
    }
    for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
      const d = Math.hypot(agents[i].position.x - agents[j].position.x, agents[i].position.z - agents[j].position.z);
      const key = i * 64 + j;
      closest = Math.min(closest, d);
      if (d < 0.5) {
        const run = (overlapping.get(key) || 0) + 1;
        overlapping.set(key, run);
        worst = Math.max(worst, run);
      } else overlapping.delete(key);
    }
  }
  // Overlap is eased out over a few frames rather than popped, so a crush
  // may brush for an instant; it must never become a body inside a body.
  assert.ok(worst <= 6, `two walkers stayed overlapped for ${worst} frames`);
  assert.ok(closest >= 0.35, `two walkers came within ${closest.toFixed(2)} m`);
  // And they still get where they were going.
  const arrived = agents.filter((agent) => Math.hypot(agent.position.x - agent.target.x, agent.position.z - agent.target.z) < 1.5).length;
  assert.ok(arrived >= 34, `only ${arrived} of 40 crossed the square`);
  assert.ok(MIN_SEPARATION >= 0.5);
});

test('two people walking straight at each other pass rather than collide', () => {
  const a = { position: { x: 0, y: 0, z: -8 }, steering: createNpcSteeringState(0) };
  const b = { position: { x: 0.05, y: 0, z: 8 }, steering: createNpcSteeringState(Math.PI) };
  const ra = { pos: a.position, vx: 0, vz: 0, speed: 0 }, rb = { pos: b.position, vx: 0, vz: 0, speed: 0 };
  let closest = Infinity;
  for (let frame = 0; frame < 60 * 16; frame++) {
    ra.vx = a.steering.vx; ra.vz = a.steering.vz; rb.vx = b.steering.vx; rb.vz = b.steering.vz;
    advanceNpcSteering(a.steering, { position: a.position, target: { x: 0, z: 8 }, dt: 1 / 60, neighbours: [rb] });
    advanceNpcSteering(b.steering, { position: b.position, target: { x: 0, z: -8 }, dt: 1 / 60, neighbours: [ra] });
    closest = Math.min(closest, Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z));
  }
  assert.ok(closest >= 0.6, `they came within ${closest.toFixed(2)} m`);
  assert.ok(a.position.z > 6 && b.position.z < -6, 'both got past');
});

test('residents step round the player instead of through them', () => {
  const walker = { position: { x: 0, y: 0, z: -6 }, steering: createNpcSteeringState(0) };
  const player = { x: 0.02, z: 0, vx: 0, vz: 0, speed: 0, radius: 0.38, minSeparation: 0.75, heavy: true };
  let closest = Infinity;
  for (let frame = 0; frame < 60 * 12; frame++) {
    advanceNpcSteering(walker.steering, { position: walker.position, target: { x: 0, z: 6 }, dt: 1 / 60, neighbours: [player] });
    closest = Math.min(closest, Math.hypot(walker.position.x - player.x, walker.position.z - player.z));
  }
  assert.ok(closest >= 0.74, `walked within ${closest.toFixed(2)} m of the player`);
  assert.ok(walker.position.z > 4, 'and carried on past');
});

function stateWith(edge) {
  const state = { playerId: 'player:me', relationships: {} };
  if (edge) state.relationships[`npc:a|player:me`] = { ownerId: 'npc:a', subjectId: 'player:me', ...edge };
  return state;
}

test('only people who know the player greet them', () => {
  assert.equal(knowsPlayer(stateWith(null), 'npc:a'), false, 'a stranger');
  assert.equal(knowsPlayer(stateWith({ familiarity: 0.05, affinity: 0.1, trust: 0.1, obligation: 0 }), 'npc:a'), false, 'one passing word');
  assert.equal(knowsPlayer(stateWith({ familiarity: 0.3, affinity: 0.2, trust: 0.2, obligation: 0 }), 'npc:a'), true, 'a familiar face');
  assert.equal(knowsPlayer(stateWith({ familiarity: 0.6, affinity: -0.5, trust: 0.1, obligation: 0 }), 'npc:a'), false, 'known, but wary');

  const stranger = playerAttention({ knows: false, distance: 5 });
  assert.equal(stranger.look, false, 'a stranger five metres off does not look');
  assert.equal(stranger.greet, false);
  const passing = playerAttention({ knows: false, distance: 2 });
  assert.equal(passing.look, true, 'but may glance as you pass close');
  assert.ok(passing.holdMax <= 1, 'and only glance');
  const friend = playerAttention({ knows: true, distance: 6 });
  assert.equal(friend.greet, true, 'a friend greets from across the lane');
  const child = playerAttention({ knows: false, child: true, distance: 5 });
  assert.equal(child.look, true, 'children watch you go by');
  assert.equal(child.greet, false, 'but do not stop for you');
});

test('a stranger glances, never stares', () => {
  const gaze = createGazeState(7, 0);
  let lockedFor = 0, longest = 0;
  for (let frame = 0; frame < 60 * 60; frame++) {
    advanceGaze(gaze, 1 / 60, {
      player: { yaw: 0.2, pitch: 0 }, vista: { yaw: 0, pitch: 0 },
      playerInterest: ATTENTION.strangerInterest, playerHoldMax: ATTENTION.strangerHoldMax,
    });
    if (gaze.focus === 'player') { lockedFor += 1 / 60; longest = Math.max(longest, lockedFor); } else lockedFor = 0;
  }
  assert.ok(longest <= ATTENTION.strangerHoldMax + 0.05, `held on the player for ${longest.toFixed(2)} s`);
});

test('travellers only stop on the road for someone they know', () => {
  let stoppedForStranger = 0, stoppedForFriend = 0;
  for (let seed = 1; seed <= 200; seed++) {
    for (const known of [false, true]) {
      const encounter = createEncounterState(seed, 0.9);
      let paused = false;
      for (let frame = 0; frame < 120; frame++) {
        const reaction = advanceEncounter(encounter, 1 / 30, { distance: 4, travelling: true, known });
        paused ||= reaction.pausing;
      }
      if (paused && known) stoppedForFriend++;
      if (paused && !known) stoppedForStranger++;
    }
  }
  assert.equal(stoppedForStranger, 0, 'a stranger made a traveller stop');
  assert.ok(stoppedForFriend > 20, `friends were stopped for only ${stoppedForFriend} times in 200`);
});
