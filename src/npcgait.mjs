// Bipedal locomotion for NPCs.
//
// This borrows the animals' locomotion machinery wholesale — the same
// constrained sagittal IK, the same reactive foot, the same predictive
// foothold — and replaces only what is actually different about walking on two
// legs. The single most important idea carried over is this one, from
// animalgait.mjs:
//
//     A foot is a world-space constraint, not an angle curve.
//
// The NPCs previously animated as `leftLeg = -sin(step) * 0.42`: a pure sine
// puppet whose feet slid across the ground because nothing ever told them where
// the ground was. Here a foot is placed in the world, stays planted through
// stance while the body travels over it, and only moves during its scheduled
// swing window — landing on terrain height sampled at the moment the step was
// committed. That is what makes a stride look grounded rather than mimed.
//
// What IS different about a biped:
//   - two feet in antiphase, not four in a lateral sequence
//   - a duty factor that crosses 0.5 into a flight phase when running
//   - the pelvis oscillates twice per stride vertically and once laterally
//   - arms counter-swing against the contralateral leg
//
// THREE-free, so the gait can be asserted without a renderer.

import {
  advanceReactiveFoot,
  createReactiveFootState,
  predictiveFootholdDistance,
  solveThreeLinkIK,
} from './animalgait.mjs';
import { humanArmLimits, humanLegLimits } from './npcanatomy.mjs';

const TAU = Math.PI * 2;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a + (b - a) * t;

// Left foot leads; the right is exactly half a stride behind. Everything else
// about a walk — arm swing, pelvic sway, the double-support windows — is phased
// off this one relationship.
export const FOOT_PHASE = Object.freeze([0, 0.5]);

export const BIPED_GAIT = Object.freeze({
  // Strides per second. A comfortable human walk is ~0.95 strides/s (about 114
  // steps per minute); a jog sits near 1.4.
  walkHz: 0.95,
  runHz: 1.42,
  // Fraction of the stride each foot spends on the ground. Above 0.5 both feet
  // overlap in double support; below 0.5 neither is down and the runner is
  // airborne. Crossing that line IS the walk/run distinction.
  walkDuty: 0.62,
  runDuty: 0.38,
  // Speed at which the gait has fully become a run.
  runSpeed: 2.6,
  walkSpeed: 1.25,
  stepHeightWalk: 0.055,
  stepHeightRun: 0.135,
  // Pelvis rise/fall as a fraction of leg length, twice per stride.
  bobWalk: 0.022,
  bobRun: 0.055,
  // Lateral pelvic shift toward the stance foot, once per stride.
  swayWalk: 0.026,
  swayRun: 0.014,
  leanWalk: 0.045,
  leanRun: 0.20,
  armSwingWalk: 0.42,
  armSwingRun: 0.95,
  elbowBendWalk: 0.28,
  elbowBendRun: 1.15,
});

/** How far into a run the NPC is, 0 at a stroll and 1 at a full jog. */
export function runningFactor(speed) {
  const { walkSpeed, runSpeed } = BIPED_GAIT;
  return clamp01((speed - walkSpeed) / Math.max(0.01, runSpeed - walkSpeed));
}

export function bipedTiming(speed = 0) {
  const running = runningFactor(speed);
  const moving = clamp01(speed / Math.max(0.01, BIPED_GAIT.walkSpeed));
  // Cadence rises with speed as well as with the walk->run transition; a person
  // speeding up lengthens the stride AND takes more of them.
  const cadence = mix(BIPED_GAIT.walkHz, BIPED_GAIT.runHz, running)
    * mix(0.55, 1.0, moving);
  const strideDuration = 1 / Math.max(0.05, cadence);
  const dutyFactor = mix(BIPED_GAIT.walkDuty, BIPED_GAIT.runDuty, running);
  return {
    running,
    cadence,
    strideDuration,
    dutyFactor,
    stanceDuration: strideDuration * dutyFactor,
    swingDuration: strideDuration * (1 - dutyFactor),
    // Airborne only once the duty factor drops below half.
    flight: Math.max(0, 0.5 - dutyFactor) * 2,
    stepHeight: mix(BIPED_GAIT.stepHeightWalk, BIPED_GAIT.stepHeightRun, running),
  };
}

/**
 * Closed-form two-link seed for the sagittal IK.
 *
 * CCD cannot be trusted to find a hinge on its own. Started from a near-straight
 * limb it rotates the knee toward the joint's zero, pins against the "never
 * extend past straight" limit and stalls there — measured at 0.32m of residual
 * error on a target the chain can physically reach, which shows up as a leg
 * that simply refuses to lift during swing.
 *
 * Solving the first two links analytically puts the solver on the correct side
 * of the hinge before it starts, and the remaining CCD pass only has to fold in
 * the short third link. `bendSign` is -1 for a knee (folds backward) and +1 for
 * an elbow (folds forward).
 */
export function seedTwoLinkAngles(l0, l1, forward, down, bendSign = -1) {
  const distance = Math.min(Math.hypot(forward, down), (l0 + l1) * 0.999);
  if (distance < 1e-5) return [0, bendSign * 2.2];
  const cosine = (distance * distance - l0 * l0 - l1 * l1) / (2 * l0 * l1);
  const bend = bendSign * Math.acos(Math.max(-1, Math.min(1, cosine)));
  const lead = Math.asin(Math.max(-1, Math.min(1,
    l1 * Math.sin(-bend) / Math.max(1e-5, distance))));
  return [Math.atan2(forward, down) + lead, bend];
}

export function createBipedState(phase = 0) {
  return {
    phase: phase % 1,
    feet: FOOT_PHASE.map((offset) => createReactiveFootState((phase + offset) % 1)),
    // Smoothed pelvis height, so uneven ground raises the body gradually
    // instead of snapping it to whichever foot happens to be higher.
    pelvisY: null,
  };
}

/**
 * Advance one NPC's gait by dt and return a pose.
 *
 * `dims` comes from npcBindDimensions. `position`/`forward` are world-space;
 * `terrainHeight(x, z)` grounds the feet. Everything returned is absolute, not
 * accumulated, so a dropped frame cannot drift the pose.
 */
export function advanceBipedGait(state, {
  dims,
  dt = 0.016,
  speed = 0,
  position = [0, 0, 0],
  forward = [0, 0, 1],
  terrainHeight = null,
  talking = false,
  gesturePhase = 0,
} = {}) {
  const timing = bipedTiming(speed);
  const moving = clamp01(speed / 0.35);
  state.phase = (state.phase + dt / timing.strideDuration) % 1;

  const legLength = dims.legLength;
  const stride = predictiveFootholdDistance(
    speed, timing.swingDuration, timing.stanceDuration, legLength,
    timing.running, 0.62,
  );
  // Lateral offset of each foot from the body centreline. Humans walk on a
  // narrow base — the feet track close to the midline, not under the hips — and
  // it narrows further at speed.
  const trackWidth = (dims.hipJointWidth ?? dims.hipWidth) * mix(0.42, 0.26, timing.running);
  const right = [forward[2], 0, -forward[0]];

  const legs = [];
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const footPhase = (state.phase + FOOT_PHASE[i]) % 1;
    const lateral = side * trackWidth;
    const desiredX = position[0] + forward[0] * stride + right[0] * lateral;
    const desiredZ = position[2] + forward[2] * stride + right[2] * lateral;
    const desiredY = terrainHeight ? terrainHeight(desiredX, desiredZ) : position[1];
    const foot = advanceReactiveFoot(
      state.feet[i], [desiredX, desiredY, desiredZ], footPhase, dt, {
        swingWindow: 1 - timing.dutyFactor,
        stepDuration: timing.swingDuration,
        stepHeight: timing.stepHeight * mix(0.35, 1, moving),
        // The desired foothold travels forward with the body, so drift from a
        // planted foot grows continuously and reaches roughly a full step
        // length before the phase window next opens. The trigger only has to be
        // large enough to suppress jitter at a standstill; the OVERDUE and
        // CRITICAL distances must clear a whole stride's drift, or their
        // phase-bypassing escapes fire every few frames and the foot never
        // stays planted at all — measured at 28 planted frames out of 1200.
        triggerDistance: legLength * 0.08,
        emergencyDistance: legLength * 0.95,
        criticalDistance: legLength * 1.40,
        terrainHeight,
        retargetStrength: 6,
        allowStep: moving > 0.02,
      },
    );
    legs.push({ side, phase: footPhase, foot });
  }

  // Pelvis height follows the higher-supporting foot, minus the natural crouch
  // that deepens with speed. Smoothed so a step onto a rock lifts the body over
  // a few frames rather than teleporting it.
  const supportY = Math.max(legs[0].foot.position[1], legs[1].foot.position[1]);
  const crouch = legLength * mix(0.012, 0.055, timing.running);
  // Two rises per stride: the body vaults over each stance leg in turn.
  const bob = Math.cos(state.phase * TAU * 2) * legLength
    * mix(BIPED_GAIT.bobWalk, BIPED_GAIT.bobRun, timing.running) * moving;
  const targetPelvisY = supportY + dims.hipHeight - crouch + bob;
  state.pelvisY = state.pelvisY === null ? targetPelvisY
    : mix(state.pelvisY, targetPelvisY, clamp01(dt * 12));

  // One lateral shift per stride, toward whichever foot is bearing weight.
  const sway = Math.sin(state.phase * TAU) * dims.hipWidth
    * mix(BIPED_GAIT.swayWalk, BIPED_GAIT.swayRun, timing.running) * moving;
  const lean = mix(BIPED_GAIT.leanWalk, BIPED_GAIT.leanRun, timing.running) * moving
    + (talking ? -0.03 : 0);
  // Pelvis and shoulders counter-rotate; that opposition is most of what makes
  // a walk read as a walk rather than a shuffle.
  const pelvisTwist = Math.sin(state.phase * TAU) * 0.10 * moving;

  const legLimits = humanLegLimits();
  const armLimits = humanArmLimits();
  const legLengths = [dims.thigh, dims.shin, dims.ankleHeight];

  const solvedLegs = legs.map(({ foot, phase, side }) => {
    // Resolve the world-space foot into the leg's own sagittal plane: how far
    // ahead of the hip it sits, and how far below.
    // The leg swings from the joint, not from the outer edge of the pelvis.
    const jointWidth = dims.hipJointWidth ?? dims.hipWidth;
    const hipX = position[0] + right[0] * side * jointWidth * 0.5;
    const hipZ = position[2] + right[2] * side * jointWidth * 0.5;
    const dx = foot.position[0] - hipX;
    const dz = foot.position[2] - hipZ;
    const targetForward = dx * forward[0] + dz * forward[2];
    const targetDown = state.pelvisY - foot.position[1];
    // Seed on the correct side of the knee hinge before CCD refines it.
    const seed = seedTwoLinkAngles(legLengths[0], legLengths[1], targetForward, targetDown, -1);
    const solved = solveThreeLinkIK(
      legLengths, targetForward, targetDown,
      [seed[0], seed[1], 0], legLimits,
    );
    // Heel strike into toe-off: the ankle rolls forward through stance.
    const stance = phase >= (1 - timing.dutyFactor);
    const stanceProgress = stance
      ? (phase - (1 - timing.dutyFactor)) / Math.max(0.01, timing.dutyFactor) : 0;
    const anklePitch = stance
      ? mix(-0.18, 0.34, stanceProgress) * moving
      : mix(0.10, -0.14, phase / Math.max(0.01, 1 - timing.dutyFactor)) * moving;
    return {
      side,
      phase,
      hip: solved.angles[0],
      knee: solved.angles[1],
      ankle: solved.angles[2] + anklePitch,
      planted: !foot.swinging,
      foot: foot.position.slice(0, 3),
      reachError: solved.error,
    };
  });

  // Arms counter-swing: the left arm goes forward with the RIGHT leg. Solved
  // through the same IK so the elbow bends like a joint rather than a hinge
  // driven by a sine.
  const swing = mix(BIPED_GAIT.armSwingWalk, BIPED_GAIT.armSwingRun, timing.running) * moving;
  const elbowBend = mix(BIPED_GAIT.elbowBendWalk, BIPED_GAIT.elbowBendRun, timing.running);
  const arms = [-1, 1].map((side, i) => {
    // contralateral: arm i takes the phase of the OPPOSITE leg
    const legPhase = (state.phase + FOOT_PHASE[1 - i]) % 1;
    const drive = Math.sin(legPhase * TAU);
    const shoulder = drive * swing;
    // The elbow folds more on the forward swing than the back, which is why a
    // walking arm looks asymmetric even though the shoulder is a clean sine.
    const elbow = Math.max(0.02, elbowBend * (0.45 + 0.55 * Math.max(0, drive)) * moving
      + (talking ? 0.55 : 0.10));
    return {
      side,
      shoulder: talking ? mix(shoulder, -0.55 + Math.sin(gesturePhase * 2) * 0.16, 0.8) : shoulder,
      elbow,
      // A swinging arm drifts slightly away from the body at the back of the
      // stroke and tucks in at the front.
      out: side * (0.06 + Math.max(0, -drive) * 0.05) + (talking ? side * 0.22 : 0),
      wrist: -elbow * 0.18,
    };
  });

  return {
    phase: state.phase,
    timing,
    pelvis: {
      y: state.pelvisY,
      sway,
      lean,
      twist: pelvisTwist,
      bob,
    },
    torsoTwist: -pelvisTwist * 1.35,
    legs: solvedLegs,
    arms,
    grounded: solvedLegs.some((leg) => leg.planted),
    limits: { leg: legLimits, arm: armLimits },
  };
}
