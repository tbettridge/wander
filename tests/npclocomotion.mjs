import assert from 'node:assert/strict';
import { npcBindDimensions } from '../src/npcanatomy.mjs';
import {
  advanceNpcLocomotion, createNpcLocomotionState, locomotionLod,
} from '../src/npclocomotion.mjs';
import { advanceNpcSteering, createNpcSteeringState } from '../src/npcsteering.mjs';

const dims = npcBindDimensions({ legScale: 1, build: 1, headScale: 1 });
const slope = (x, z) => {
  const y = x * 0.16 + z * 0.04;
  const normal = [-0.16, 1, -0.04];
  const length = Math.hypot(...normal);
  return { y, normal: normal.map((value) => value / length), supportId: 'hill', surfaceKind: 'terrain', walkable: true };
};

// Frame-rate changes must not meaningfully change the filtered walk speed.
for (const hz of [20, 30, 60, 90]) {
  const state = createNpcLocomotionState(0);
  let x = 0, pose = null;
  for (let frame = 0; frame < hz * 4; frame++) {
    x += 1.2 / hz;
    pose = advanceNpcLocomotion(state, {
      dims, dt: 1 / hz, position: [x, slope(x, 0).y, 0], heading: Math.PI / 2,
      surfaceQuery: slope,
    });
  }
  assert.ok(Math.abs(pose.locomotion.speed - 1.2) < 0.035, `${hz}Hz speed ${pose.locomotion.speed}`);
  assert.ok(pose.terrain.grade > 0.12, 'the gait sees the uphill grade');
  for (const leg of pose.legs) assert.ok(Number.isFinite(leg.roll) && leg.surface?.supportId === 'hill');
}

// Arrival braking plants the actor instead of snapping from a full stride.
{
  const state = createNpcLocomotionState(0.3);
  let x = 0, pose;
  for (let frame = 0; frame < 180; frame++) {
    const remaining = Math.max(0, 2 - x);
    x += Math.min(remaining, 1.25 / 60);
    pose = advanceNpcLocomotion(state, {
      dims, dt: 1 / 60, position: [x, 0, 0], heading: Math.PI / 2,
      surfaceQuery: () => ({ y: 0, normal: [0, 1, 0], supportId: 'floor', surfaceKind: 'floor', walkable: true }),
      arrivalDistance: remaining,
    });
  }
  for (let frame = 0; frame < 60; frame++) pose = advanceNpcLocomotion(state, {
    dims, dt: 1 / 60, position: [2, 0, 0], heading: Math.PI / 2, held: true,
  });
  assert.equal(pose.locomotion.speed, 0);
  assert.ok(pose.legs.every((leg) => leg.planted), 'both feet settle after arrival');
}

// Teleports reset contact state rather than producing one giant stride.
{
  const state = createNpcLocomotionState();
  advanceNpcLocomotion(state, { dims, position: [0, 0, 0] });
  const pose = advanceNpcLocomotion(state, { dims, position: [20, 0, 0] });
  assert.equal(pose.locomotion.teleported, true);
  assert.ok(pose.legs.every((leg) => leg.planted));
}

// Steering rounds corners, brakes, and keeps two walkers from occupying one point.
{
  const a = { x: 0, y: 0, z: 0 }, b = { x: 0.3, y: 0, z: 0 };
  const sa = createNpcSteeringState(), sb = createNpcSteeringState();
  for (let frame = 0; frame < 150; frame++) {
    advanceNpcSteering(sa, { position: a, target: { x: 3, z: 0 }, nextTarget: { x: 3, z: 3 }, dt: 1 / 60, neighbours: [b] });
    advanceNpcSteering(sb, { position: b, target: { x: 3, z: 0.6 }, nextTarget: { x: 3, z: 3 }, dt: 1 / 60, neighbours: [a] });
  }
  assert.ok(a.z > 0.05 && b.z > 0.05, 'look-ahead bends both paths before the corner');
  for (let frame = 0; frame < 240; frame++) {
    advanceNpcSteering(sa, { position: a, target: { x: 3, z: 3 }, dt: 1 / 60, neighbours: [b] });
    advanceNpcSteering(sb, { position: b, target: { x: 3.6, z: 3 }, dt: 1 / 60, neighbours: [a] });
  }
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 0.35, 'personal space survives a shared route');
  assert.ok(sa.speed < 0.2 && sb.speed < 0.2, 'both walkers brake at their arrival');
}

// Waypoint consumption uses the position accepted by collision resolution.
// A blocked actor inside the corner look-ahead radius must keep targeting that
// corner instead of advancing into the obstacle behind it.
{
  const position = { x: 0.7, y: 0, z: 0 };
  const state = createNpcSteeringState(-Math.PI / 2);
  const movement = advanceNpcSteering(state, {
    position,
    target: { x: 0, z: 0 },
    nextTarget: { x: -2, z: 0 },
    dt: 1 / 60,
    resolveMovement: (candidate, previous) => {
      candidate.x = previous.x;
      candidate.z = previous.z;
      return { acceptedDistance: 0, blocked: true };
    },
  });
  assert.equal(movement.blocked, true);
  assert.equal(movement.arrived, false, 'a blocked intermediate waypoint was consumed');
  assert.equal(movement.distance, 0.7, 'distance must describe the collision-resolved position');
}

// Conversely, crossing the look-ahead threshold during this frame should
// consume the corner immediately rather than one frame late.
{
  const position = { x: 0.79, y: 0, z: 0 };
  const state = createNpcSteeringState(-Math.PI / 2);
  state.speed = 1;
  state.vx = -1;
  const movement = advanceNpcSteering(state, {
    position,
    target: { x: 0, z: 0 },
    nextTarget: { x: -2, z: 0 },
    dt: 0.02,
  });
  assert.ok(movement.distance < 0.78, `resolved distance remained ${movement.distance}`);
  assert.equal(movement.arrived, true, 'post-movement corner arrival was delayed');
}

assert.equal(locomotionLod(20).tier, 'near');
assert.equal(locomotionLod(90).tier, 'medium');
assert.equal(locomotionLod(150).tier, 'far');
assert.equal(locomotionLod(500).tier, 'culled');

// Visible LOD tiers may simplify terrain sampling but may never freeze a pose
// while its root moves. That was the settlement-only leg dragging bug.
for (const distance of [70, 140]) {
  const state = createNpcLocomotionState(0.1);
  let x = 0, previousPhase = null, advancedFrames = 0;
  for (let frame = 0; frame < 120; frame++) {
    x += 1.05 / 60;
    const pose = advanceNpcLocomotion(state, {
      dims, dt: 1 / 60, position: [x, 0, 0], heading: Math.PI / 2, distance,
      surfaceQuery: () => ({ y: 0, normal: [0, 1, 0], supportId: 'yard', surfaceKind: 'terrain', walkable: true }),
    });
    if (previousPhase !== null && pose.phase !== previousPhase) advancedFrames++;
    previousPhase = pose.phase;
  }
  assert.ok(advancedFrames > 115,
    `${locomotionLod(distance).tier} gait froze on ${120 - advancedFrames} moving frames`);
}

// Behaviour pauses and locomotion must agree about whether the root moved.
// Settlement greetings previously marked a resident held while commute
// steering translated the root, leaving stopped feet to drag several metres.
// The adapter now treats measured displacement as authoritative even if a
// caller briefly supplies contradictory held state.
for (const distance of [0, 500]) {
  const state = createNpcLocomotionState(0.23);
  let x = 0, pose = null, movingFrames = 0, worstReach = 0;
  for (let frame = 0; frame < 180; frame++) {
    x += 1.35 / 60;
    pose = advanceNpcLocomotion(state, {
      dims, dt: 1 / 60, position: [x, 0, 0], heading: Math.PI / 2, held: true,
      distance,
      surfaceQuery: () => ({ y: 0, normal: [0, 1, 0], supportId: 'lane', surfaceKind: 'path', walkable: true }),
    });
    if (pose.locomotion.speed > 1) movingFrames++;
    for (const leg of pose.legs) worstReach = Math.max(worstReach, leg.reachError);
  }
  assert.ok(movingFrames > 170, `${locomotionLod(distance).tier} translating held root rendered as a stopped pose`);
  assert.ok(worstReach < 0.1,
    `${locomotionLod(distance).tier} contradictory held movement dragged a leg ${worstReach.toFixed(3)}m out of reach`);
}

// A loiter dwell can stop the root on one frame. Filtered behaviour velocity
// may decay for UI purposes, but it must not keep generating forward footholds
// underneath a stationary body; resume should start without a recovery storm.
{
  const state = createNpcLocomotionState(0.35);
  let x = 0, pose = null;
  const previousFeet = [null, null];
  let worstStoppedFootDelta = 0, worstResumeReach = 0;
  for (let frame = 0; frame < 180; frame++) {
    x += 1.08 / 60;
    pose = advanceNpcLocomotion(state, { dims, dt: 1 / 60, position: [x, 0, 0], heading: Math.PI / 2 });
  }
  for (let frame = 0; frame < 90; frame++) {
    pose = advanceNpcLocomotion(state, { dims, dt: 1 / 60, position: [x, 0, 0], heading: Math.PI / 2 });
    assert.equal(pose.locomotion.speed, 0, 'stationary root retained walking gait speed');
    for (let side = 0; side < 2; side++) {
      if (previousFeet[side]) worstStoppedFootDelta = Math.max(worstStoppedFootDelta,
        Math.hypot(pose.legs[side].foot[0] - previousFeet[side][0], pose.legs[side].foot[2] - previousFeet[side][2]));
      previousFeet[side] = pose.legs[side].foot.slice(0, 3);
    }
  }
  assert.ok(pose.legs.every((leg) => leg.planted), 'feet did not settle during loiter dwell');
  assert.ok(worstStoppedFootDelta < 0.1, `dwell snapped a foot ${worstStoppedFootDelta.toFixed(3)}m`);
  for (let frame = 0; frame < 180; frame++) {
    x += 1.08 / 60;
    pose = advanceNpcLocomotion(state, { dims, dt: 1 / 60, position: [x, 0, 0], heading: Math.PI / 2 });
    for (const leg of pose.legs) worstResumeReach = Math.max(worstResumeReach, leg.reachError);
  }
  assert.ok(worstResumeReach < 0.1, `dwell resume left ${worstResumeReach.toFixed(3)}m of reach error`);
}

// A pair with independent phases crossing the same authored corner must not
// fail together because of the geometry. The old reach clamp drove a 0.795m
// pelvis down to 0.15m here and saturated all three joints.
{
  const positions = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  const steering = positions.map(() => createNpcSteeringState());
  const locomotion = [createNpcLocomotionState(0.09), createNpcLocomotionState(0.61)];
  const points = [{ x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }, { x: 0, z: 0 }];
  const indices = [0, 0];
  const minimumPelvis = [Infinity, Infinity], worstReach = [0, 0];
  for (let frame = 0; frame < 1400; frame++) for (let actor = 0; actor < 2; actor++) {
    const index = indices[actor];
    const movement = advanceNpcSteering(steering[actor], {
      position: positions[actor], target: points[index], nextTarget: points[(index + 1) % points.length],
      dt: 1 / 60, maxSpeed: 1.08, arrivalRadius: 0.62, stopRadius: 0.1,
    });
    if (movement.arrived) indices[actor] = (index + 1) % points.length;
    const pose = advanceNpcLocomotion(locomotion[actor], {
      dims, dt: 1 / 60, position: [positions[actor].x, 0, positions[actor].z], heading: movement.heading,
      surfaceQuery: () => ({ y: 0, normal: [0, 1, 0], supportId: 'yard', surfaceKind: 'terrain', walkable: true }),
    });
    minimumPelvis[actor] = Math.min(minimumPelvis[actor], pose.pelvis.y);
    for (const leg of pose.legs) {
      worstReach[actor] = Math.max(worstReach[actor], leg.reachError);
      assert.ok(leg.knee >= -1.68 && leg.knee <= 0, 'corner traversal hyperflexed or reversed a knee');
      assert.ok(leg.ankle >= -0.75 && leg.ankle <= 0.65, 'corner traversal exceeded the ankle hinge');
    }
  }
  for (let actor = 0; actor < 2; actor++) {
    assert.ok(minimumPelvis[actor] > dims.hipHeight * 0.84,
      `phase-offset actor ${actor} collapsed to ${minimumPelvis[actor].toFixed(3)}m at a corner`);
    assert.ok(worstReach[actor] < 0.075,
      `phase-offset actor ${actor} left ${worstReach[actor].toFixed(3)}m of corner reach error`);
  }
}

// World-space contacts must be rebased when the root hands off between terrain
// and a structure floor. Exercise both directions and two phases because the
// bug used to bury every companion at the same doorway regardless of phase.
for (const phase of [0.13, 0.67]) {
  const state = createNpcLocomotionState(phase);
  const surface = (x) => x >= 0
    ? { y: 0.12, normal: [0, 1, 0], supportId: 'house:floor', surfaceKind: 'floor', walkable: true }
    : { y: 0, normal: [0, 1, 0], supportId: 'yard', surfaceKind: 'terrain', walkable: true };
  const samples = [];
  for (let frame = 0; frame <= 240; frame++) samples.push(-1 + frame / 120);
  for (let frame = 1; frame <= 240; frame++) samples.push(1 - frame / 120);
  let minimumLocalPelvis = Infinity, supportRebases = 0, previousSupport = null;
  for (const x of samples) {
    const rootY = surface(x).y;
    const pose = advanceNpcLocomotion(state, {
      dims, dt: 1 / 60, position: [x, rootY, 0], heading: x < 1 ? Math.PI / 2 : -Math.PI / 2,
      surfaceQuery: (qx) => surface(qx),
    });
    minimumLocalPelvis = Math.min(minimumLocalPelvis, pose.pelvis.y - rootY);
    const support = pose.locomotion.surface?.supportId;
    if (previousSupport && support !== previousSupport) supportRebases++;
    previousSupport = support;
    for (const leg of pose.legs) if (leg.planted) {
      assert.ok(Math.abs(leg.foot[1] - surface(leg.foot[0]).y) < 1e-9,
        'a planted contact remained on the previous side of a support handoff');
    }
  }
  assert.ok(supportRebases >= 2, 'the test must cross onto and back off the floor');
  assert.ok(minimumLocalPelvis > dims.hipHeight * 0.84,
    `support handoff buried the pelvis at ${minimumLocalPelvis.toFixed(3)}m`);
}

console.log('npclocomotion PASS · frame-rate stable · slope-aware feet · planted arrivals · '
  + 'paired corners · support rebasing · teleport recovery · corner and crowd steering · LOD');
