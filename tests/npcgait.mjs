import assert from 'node:assert/strict';
import { npcBindDimensions } from '../src/npcanatomy.mjs';
import {
  BIPED_GAIT, FOOT_PHASE, advanceBipedGait, bipedTiming, createBipedState,
  runningFactor, seedTwoLinkAngles,
} from '../src/npcgait.mjs';

const dims = npcBindDimensions({ legScale: 1, build: 1, headScale: 1 });

// --- walk and run are distinguished by the duty factor, not by speed alone ---
// Above 0.5 both feet overlap on the ground; below it neither is down and the
// NPC is airborne. That crossing IS the walk/run boundary.
const walk = bipedTiming(1.0);
const run = bipedTiming(3.2);
assert.ok(walk.dutyFactor > 0.5, `a walk must keep double support (${walk.dutyFactor})`);
assert.ok(run.dutyFactor < 0.5, `a run must have a flight phase (${run.dutyFactor})`);
assert.equal(walk.flight, 0, 'a walk is never airborne');
assert.ok(run.flight > 0, 'a run is airborne for part of the stride');
assert.ok(run.cadence > walk.cadence, 'running takes more strides per second');
assert.ok(run.stepHeight > walk.stepHeight, 'running lifts the foot higher');
assert.equal(runningFactor(0), 0);
assert.equal(runningFactor(99), 1);

// feet are exactly antiphase — everything else is phased off this
assert.deepEqual([...FOOT_PHASE], [0, 0.5]);

// --- the seed must land on the correct side of each hinge --------------------
const kneeSeed = seedTwoLinkAngles(dims.thigh, dims.shin, 0.15, 0.45, -1);
assert.ok(kneeSeed[1] < 0, 'a knee seed must bend backward');
const elbowSeed = seedTwoLinkAngles(dims.upperArm, dims.forearm, 0.12, 0.20, 1);
assert.ok(elbowSeed[1] > 0, 'an elbow seed must bend forward');
// degenerate target must not produce NaN
const degenerate = seedTwoLinkAngles(dims.thigh, dims.shin, 0, 0, -1);
assert.ok(degenerate.every(Number.isFinite), 'a zero-length target must stay finite');

// --- THE anti-skating property ----------------------------------------------
// This is the entire reason the gait exists. The old NPC drove
// `leftLeg = -sin(step)`, so its feet slid across the ground continuously. A
// planted foot must stay exactly where it was put while the body travels over
// it, and only move during its own swing window.
{
  const state = createBipedState(0);
  const ground = () => 0;
  const speed = 1.2;
  const dt = 1 / 60;
  let x = 0;
  let plantedFrames = 0;
  let maxPlantedDrift = 0;
  const previous = [null, null];

  for (let frame = 0; frame < 600; frame++) {
    x += speed * dt;
    const pose = advanceBipedGait(state, {
      dims, dt, speed, position: [x, 0, 0], forward: [1, 0, 0], terrainHeight: ground,
    });
    for (let i = 0; i < 2; i++) {
      const leg = pose.legs[i];
      if (leg.planted && previous[i]) {
        plantedFrames++;
        maxPlantedDrift = Math.max(maxPlantedDrift,
          Math.hypot(leg.foot[0] - previous[i][0], leg.foot[2] - previous[i][2]));
      }
      previous[i] = leg.planted ? leg.foot.slice(0, 3) : null;
    }
  }
  assert.ok(plantedFrames > 300, `expected sustained stance, got ${plantedFrames} planted frames`);
  assert.ok(maxPlantedDrift < 1e-9,
    `a planted foot slid ${maxPlantedDrift.toFixed(6)}m — this is the skating bug`);
}

// --- feet must land ON the terrain, including uphill -------------------------
{
  const state = createBipedState(0);
  // a slope the NPC walks up
  const ground = (gx) => gx * 0.18;
  const dt = 1 / 60;
  let x = 0;
  let worstContact = 0;
  for (let frame = 0; frame < 600; frame++) {
    x += 1.1 * dt;
    const pose = advanceBipedGait(state, {
      dims, dt, speed: 1.1, position: [x, ground(x), 0], forward: [1, 0, 0], terrainHeight: ground,
    });
    for (const leg of pose.legs) {
      if (!leg.planted) continue;
      // a planted foot must sit on the ground, not above or below it
      worstContact = Math.max(worstContact, Math.abs(leg.foot[1] - ground(leg.foot[0])));
    }
    // the pelvis must stay within the leg's reach of the ground it walks on
    const clearance = pose.pelvis.y - ground(x);
    assert.ok(clearance > dims.hipHeight * 0.72 && clearance < dims.hipHeight * 1.12,
      `pelvis height ${clearance.toFixed(3)} left leg reach at frame ${frame}`);
  }
  assert.ok(worstContact < 1e-9,
    `a planted foot floated/sank by ${worstContact.toFixed(4)}m on a slope`);
}

// --- standing still must not step -------------------------------------------
{
  const state = createBipedState(0.2);
  const ground = () => 0;
  let firstFeet = null;
  for (let frame = 0; frame < 240; frame++) {
    const pose = advanceBipedGait(state, {
      dims, dt: 1 / 60, speed: 0, position: [0, 0, 0], forward: [1, 0, 0], terrainHeight: ground,
    });
    if (!firstFeet) firstFeet = pose.legs.map((l) => l.foot.slice(0, 3));
    else {
      for (let i = 0; i < 2; i++) {
        const drift = Math.hypot(
          pose.legs[i].foot[0] - firstFeet[i][0], pose.legs[i].foot[2] - firstFeet[i][2],
        );
        assert.ok(drift < 1e-9, `a standing NPC marched in place (${drift.toFixed(4)}m)`);
      }
    }
  }
}

// --- arms counter-swing against the contralateral leg ------------------------
// Left arm forward with the RIGHT leg. Without this a walk reads as a shamble.
{
  const state = createBipedState(0);
  const ground = () => 0;
  let checked = 0;
  let x = 0;
  for (let frame = 0; frame < 400; frame++) {
    x += 1.3 / 60;
    const pose = advanceBipedGait(state, {
      dims, dt: 1 / 60, speed: 1.3, position: [x, 0, 0], forward: [1, 0, 0], terrainHeight: ground,
    });
    // the arms always oppose each other
    assert.ok(pose.arms[0].shoulder * pose.arms[1].shoulder <= 1e-6,
      'both arms swung the same way');
    // elbows never hyperextend
    for (const arm of pose.arms) {
      assert.ok(arm.elbow >= 0, `elbow hyperextended to ${arm.elbow.toFixed(3)}`);
    }
    // knees never hyperextend
    for (const leg of pose.legs) {
      assert.ok(leg.knee <= 0.001, `knee hyperextended to ${leg.knee.toFixed(3)}`);
    }
    checked++;
  }
  assert.ok(checked === 400);
}

// --- the IK must actually be solving, not silently failing -------------------
{
  const state = createBipedState(0);
  const ground = () => 0;
  let worstReach = 0;
  let x = 0;
  for (let frame = 0; frame < 400; frame++) {
    x += 1.4 / 60;
    const pose = advanceBipedGait(state, {
      dims, dt: 1 / 60, speed: 1.4, position: [x, 0, 0], forward: [1, 0, 0], terrainHeight: ground,
    });
    for (const leg of pose.legs) worstReach = Math.max(worstReach, leg.reachError);
  }
  assert.ok(worstReach < 0.05,
    `leg IK left ${worstReach.toFixed(3)}m of residual error — the foot is not where it is drawn`);
}

// --- pelvis motion has the right rhythm --------------------------------------
// Vertical twice per stride, lateral once. Getting these the same frequency is
// the classic tell of a hand-animated walk.
{
  const state = createBipedState(0);
  const ground = () => 0;
  const bob = [];
  const sway = [];
  let x = 0;
  const strideFrames = Math.round(bipedTiming(1.2).strideDuration * 60);
  for (let frame = 0; frame < strideFrames * 2; frame++) {
    x += 1.2 / 60;
    const pose = advanceBipedGait(state, {
      dims, dt: 1 / 60, speed: 1.2, position: [x, 0, 0], forward: [1, 0, 0], terrainHeight: ground,
    });
    bob.push(pose.pelvis.bob);
    sway.push(pose.pelvis.sway);
  }
  const zeroCrossings = (series) => {
    let n = 0;
    for (let i = 1; i < series.length; i++) if (series[i - 1] < 0 !== series[i] < 0) n++;
    return n;
  };
  const bobCrossings = zeroCrossings(bob);
  const swayCrossings = zeroCrossings(sway);
  assert.ok(bobCrossings >= swayCrossings * 2 - 1,
    `pelvis bob (${bobCrossings}) must cycle about twice per sway (${swayCrossings})`);
  assert.ok(swayCrossings >= 2, 'the pelvis must sway at least once per stride');
}

assert.ok(BIPED_GAIT.walkDuty > 0.5 && BIPED_GAIT.runDuty < 0.5);

console.log('npcgait PASS · planted feet never slide · feet land on terrain · '
  + 'no stepping at rest · contralateral arms · hinges never hyperextend · '
  + 'bob twice per sway');
