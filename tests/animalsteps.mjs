// Contact-quality harness for the reactive gait. Simulates the same foot
// scheduling the game runs (updateReactiveLegs' options, ordering and IK) on
// flat ground at steady speed, then asserts each foot touches down exactly
// once per gait cycle — the "tap-tap" bug is a foot re-stepping mid-stance —
// with no mid-swing terrain grazes and no forward pastern hyperextension.
//
// Run with DIAG=1 for per-config diagnostics instead of a silent pass.

import assert from 'node:assert/strict';
import { ANIMAL_RECIPES, LEG_ORDER, animalBindDimensions } from '../src/animaldata.mjs';
import {
  advanceReactiveFoot,
  createReactiveFootState,
  forwardKinematics2D,
  predictiveFootholdDistance,
  quadrupedLegLimits,
  quadrupedPose,
  quadrupedTiming,
  solveThreeLinkIK,
} from '../src/animalgait.mjs';

const WALK_PHASE = [0.25, 0.75, 0.50, 0.00];
const DIAG = !!process.env.DIAG;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * Math.min(dt, 0.1)));
}

// Mirrors AnimalAgent.normalisedGaitSpeed.
function normalisedGaitSpeed(recipe, speed) {
  const cruise = recipe.motion.cruise;
  return speed <= cruise
    ? clamp(speed / Math.max(cruise, 0.01), 0, 1) * 0.42
    : 0.42 + clamp(
      (speed - cruise) / Math.max(recipe.motion.run - cruise, 0.01), 0, 1,
    ) * 0.58;
}

function simulateGait(recipe, speed, seconds = 10) {
  const dt = 1 / 120;
  const speed01 = normalisedGaitSpeed(recipe, speed);
  const hoofClearance = recipe.leg.hoof[1] * 1.38;
  const dims = animalBindDimensions(recipe);
  const terrainFootHeight = () => hoofClearance;

  const legs = LEG_ORDER.map((name, index) => {
    const isFront = name.startsWith('front');
    const chain = isFront ? recipe.leg.front : recipe.leg.hind;
    const neutral = forwardKinematics2D(chain.lengths, chain.bind);
    return {
      name,
      chain,
      isFront,
      total: chain.lengths[0] + chain.lengths[1] + chain.lengths[2],
      neutral,
      hipY: isFront ? dims.shoulderY : dims.hipY,
      hipZ: isFront ? recipe.shoulderZ : recipe.hipZ,
      limits: quadrupedLegLimits(isFront),
      angles: chain.bind.slice(),
      state: createReactiveFootState(WALK_PHASE[index]),
      lastLegPhase: null,
      cycles: 0,
      stepsThisCycle: 0,
      stepsByCycle: [],
      taps: 0,
      grazes: 0,
      grazedThisSwing: false,
      minPasternAbs: Infinity,
      minPasternRel: Infinity,
      maxIkError: 0,
    };
  });

  const supportLegLength = Math.max(...legs.map((leg) => leg.total));
  const WARMUP_CYCLES = 2;
  let bodyZ = 0;
  let gaitClock = 0;
  let time = 0;

  for (let i = 0; i < Math.round(seconds / dt); i++) {
    time += dt;
    bodyZ += speed * dt;
    const timing = quadrupedTiming(recipe, speed01);
    gaitClock += dt * timing.cadence;
    const pose = quadrupedPose(recipe, time, speed01, { phaseOverride: gaitClock });
    const strideDuration = pose.swingPortion / Math.max(0.18, pose.cadence)
      * (1 + pose.running * pose.swingDurationBoost);
    const stanceDuration = pose.dutyFactor / Math.max(0.18, pose.cadence);
    const crouch = supportLegLength
      * (pose.locomotion * 0.018 + pose.running * pose.locomotionCrouch);
    const rootY = pose.rootBob;

    let activeSteps = legs.filter((leg) => leg.state.swinging).length;
    const suspensionEnabled = pose.running > pose.suspensionThreshold;
    const maxConcurrentSteps = suspensionEnabled ? 4 : 2;
    const order = [...legs].sort(
      (a, b) => pose.legs[a.name].phase - pose.legs[b.name].phase,
    );

    for (const leg of order) {
      const legPhase = pose.legs[leg.name].phase;
      if (leg.lastLegPhase !== null && legPhase < leg.lastLegPhase) {
        leg.cycles++;
        leg.stepsThisCycle = 0;
      }
      leg.lastLegPhase = legPhase;

      const hipZ = bodyZ + leg.hipZ;
      const hipYNow = leg.hipY - crouch + rootY;
      // Same construction as updateReactiveLegs: neutral foothold under the
      // bind pose (offset -neutral.forward is in solver space, i.e. -z is
      // forward), pushed ahead by the predictive foothold distance.
      const neutralFootZ = hipZ - (-leg.neutral.forward);
      const rawPrediction = predictiveFootholdDistance(
        speed, strideDuration, stanceDuration, leg.total, pose.running, pose.runReach,
      );
      // Mirrors the game's diagonal reach cap.
      const reachDown = leg.neutral.down * 0.90;
      const diagonalForward = Math.sqrt(Math.max(
        0.001, (leg.total * 0.99) ** 2 - reachDown ** 2,
      ));
      const prediction = Math.min(
        rawPrediction, Math.max(diagonalForward, leg.total * 0.30),
      );
      const desired = [0, hoofClearance, neutralFootZ + prediction];

      if (!leg.state.initialized) {
        advanceReactiveFoot(leg.state, [0, hoofClearance, neutralFootZ], legPhase, 0, {
          swingWindow: pose.swingPortion, armOnInitialize: true,
        });
      }

      const wasSwinging = leg.state.swinging;
      advanceReactiveFoot(leg.state, desired, legPhase, dt, {
        swingWindow: pose.swingPortion,
        stepDuration: strideDuration,
        stepHeight: Math.max(hoofClearance * 1.10, leg.total * 0.095)
          * (0.72 + speed01 * 0.55)
          * (1 + pose.running * pose.stepLiftBoost),
        triggerDistance: Math.max(0.055, leg.total * (0.090 - pose.running * 0.025)),
        emergencyDistance: Math.max(
          0.18,
          leg.total * (0.42 - pose.running * 0.08),
          speed * stanceDuration * 1.20,
        ),
        criticalDistance: Math.max(
          0.24,
          leg.total * 0.52,
          speed * stanceDuration * 1.45,
        ),
        retargetStrength: 4 + pose.running * pose.retargetBoost,
        allowStep: wasSwinging || activeSteps < 2
          || (suspensionEnabled && activeSteps < maxConcurrentSteps
            && legPhase < pose.swingPortion),
        terrainHeight: terrainFootHeight,
      });

      if (!wasSwinging && leg.state.swinging) {
        activeSteps++;
        leg.stepsThisCycle++;
        if (leg.cycles >= WARMUP_CYCLES) {
          leg.stepsByCycle[leg.cycles - WARMUP_CYCLES] =
            (leg.stepsByCycle[leg.cycles - WARMUP_CYCLES] || 0) + 1;
          if (leg.stepsThisCycle > 1) leg.taps++;
        }
      }
      if (leg.state.swinging) {
        // A swing that dips back to planted ride height mid-flight is a
        // visible extra ground contact.
        if (leg.state.progress > 0.12 && leg.state.progress < 0.88
          && leg.state.position[1] <= hoofClearance + 0.004
          && !leg.grazedThisSwing && leg.cycles >= WARMUP_CYCLES) {
          leg.grazes++;
          leg.grazedThisSwing = true;
        }
      } else {
        leg.grazedThisSwing = false;
      }

      // IK exactly as the game applies it, including response damping.
      const targetForward = -(leg.state.position[2] - hipZ);
      const targetDown = hipYNow - leg.state.position[1];
      const result = solveThreeLinkIK(
        leg.chain.lengths, targetForward, targetDown, leg.angles, leg.limits,
      );
      const response = leg.state.swinging ? 34 : 46;
      for (let joint = 0; joint < 3; joint++) {
        leg.angles[joint] = damp(leg.angles[joint], result.angles[joint], response, dt);
      }
      if (leg.cycles >= WARMUP_CYCLES) {
        // Solver-space: positive = backward, so a strongly negative pastern
        // angle is the cannon kicking forward — the reported hyperextension.
        const pasternAbs = leg.angles[0] + leg.angles[1] + leg.angles[2];
        leg.minPasternAbs = Math.min(leg.minPasternAbs, pasternAbs);
        leg.minPasternRel = Math.min(leg.minPasternRel, leg.angles[2]);
        leg.maxIkError = Math.max(leg.maxIkError, result.error);
      }
    }
  }

  return legs.map((leg) => {
    // Only complete cycles are scored — the final in-progress cycle would
    // otherwise inflate the count by its already-taken step.
    const completed = leg.stepsByCycle.slice(0, Math.max(0, leg.cycles - WARMUP_CYCLES));
    const steps = completed.reduce((sum, count) => sum + (count || 0), 0);
    return {
      leg: leg.name,
      cycles: completed.length,
      steps,
      stepsPerCycle: steps / Math.max(1, completed.length),
      taps: leg.taps,
      grazes: leg.grazes,
      minPasternAbs: leg.minPasternAbs,
      minPasternRel: leg.minPasternRel,
      maxIkError: leg.maxIkError,
    };
  });
}

const CONFIGS = [];
for (const recipe of Object.values(ANIMAL_RECIPES)) {
  CONFIGS.push({ recipe, label: `${recipe.id} walk`, speed: recipe.motion.cruise });
  CONFIGS.push({ recipe, label: `${recipe.id} run`, speed: recipe.motion.run });
}

let failures = 0;
for (const { recipe, label, speed } of CONFIGS) {
  const report = simulateGait(recipe, speed);
  if (DIAG) {
    console.log(`\n--- ${label} (${speed.toFixed(2)} m/s) ---`);
    console.table(report.map((row) => ({
      leg: row.leg,
      cycles: row.cycles,
      'steps/cycle': row.stepsPerCycle.toFixed(2),
      taps: row.taps,
      grazes: row.grazes,
      'pastern abs min': row.minPasternAbs.toFixed(2),
      'pastern rel min': row.minPasternRel.toFixed(2),
      'ik err max': row.maxIkError.toFixed(3),
    })));
  }
  for (const row of report) {
    const id = `${label} ${row.leg}`;
    try {
      assert.equal(row.taps, 0,
        `${id}: ${row.taps} extra touchdowns (tap-tap) across ${row.cycles} cycles`);
      assert.equal(row.grazes, 0,
        `${id}: swing arc grazed the ground ${row.grazes} times`);
      assert.ok(row.stepsPerCycle > 0.82 && row.stepsPerCycle < 1.18,
        `${id}: ${row.stepsPerCycle.toFixed(2)} steps/cycle — gait is not one confident step per stride`);
      assert.ok(row.minPasternAbs > -0.90,
        `${id}: cannon/pastern swings ${(-row.minPasternAbs).toFixed(2)}rad forward of vertical (hyperextension)`);
    } catch (error) {
      failures++;
      console.error(String(error.message));
    }
  }
}

if (failures) {
  console.error(`\nanimalsteps FAIL · ${failures} contact-quality violations`);
  process.exit(1);
}
console.log('animalsteps PASS · one touchdown per stride · no swing grazes · no pastern hyperextension');
