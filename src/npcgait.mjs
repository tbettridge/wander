// Bipedal locomotion for NPCs.
//
// This shares the animals' constrained sagittal IK, but deliberately does not
// share their recovery-step scheduler. A quadruped can safely let any overdue
// foot catch up; a biped doing that takes two steps with the same leg or lifts
// both supports and immediately looks weightless. The single most important
// idea carried over is this one, from
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
  forwardKinematics2D,
} from './animalgait.mjs';
import { humanArmLimits, humanLegLimits } from './npcanatomy.mjs';

const TAU = Math.PI * 2;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth01 = (value) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

// Left foot leads; the right is exactly half a stride behind. Everything else
// about a walk — arm swing, pelvic sway, the double-support windows — is phased
// off this one relationship.
export const FOOT_PHASE = Object.freeze([0, 0.5]);

export const BIPED_GAIT = Object.freeze({
  // Strides per second. These slightly shorter procedural residents look more
  // grounded around brisk-walk speed with a ~1.14 stride/s baseline (about 137
  // steps per minute at full pace); a jog sits near 1.4. The slightly quicker
  // cadence keeps these short procedural bodies from over-striding.
  walkHz: 1.14,
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
  bobWalk: 0.009,
  bobRun: 0.035,
  // Lateral pelvic shift toward the stance foot, once per stride.
  swayWalk: 0.026,
  swayRun: 0.014,
  leanWalk: 0.018,
  leanRun: 0.14,
  armSwingWalk: 0.32,
  armSwingRun: 0.76,
  elbowBendWalk: 0.22,
  elbowBendRun: 0.92,
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
    feet: FOOT_PHASE.map((offset) => ({
      position: [0, 0, 0], start: [0, 0, 0], goal: [0, 0, 0],
      initialized: false, swinging: false, progress: 0,
      swingDuration: 0,
      lastPhase: (phase + offset) % 1, liftOffs: 0, touchdowns: 0,
    })),
    // Pelvis is kept in world space because the contacts are world-space too.
    // rootY lets us translate that cache with the actor's support instead of
    // accidentally leaving it behind when a floor or an uphill path raises the
    // rendered root.
    pelvisY: null,
    rootY: null,
    pelvisSway: 0,
    lastLiftedFoot: null,
  };
}

/**
 * Strictly scheduled human foot contact.
 *
 * At a walk only the foot whose antiphase window has opened may lift, and it
 * may not lift while the other foot is already swinging. There are no
 * phase-bypassing "catch up" steps: those are useful for four-legged animals
 * but are the source of double steps and floating in a biped.
 */
function advanceHumanFoot(state, desired, phase, dt, {
  swingWindow, stepDuration, stepHeight, moving, otherSwinging,
  allowFlight = false, terrainHeight = null, initial = desired,
  forceLift = false, suppressLift = false, retargetStrength = 0,
} = {}) {
  if (!state.initialized) {
    // Start under the hip, not at the future landing target. Initialising both
    // feet at the look-ahead point pitched both legs forward while the root
    // glided up to them—the most obvious settlement "floating" pose.
    state.position = initial.slice(0, 3);
    state.start = initial.slice(0, 3);
    state.goal = initial.slice(0, 3);
    state.initialized = true;
    state.lastPhase = phase;
    return { ...state, justLanded: false, justLifted: false };
  }
  const drift = Math.hypot(desired[0] - state.position[0], desired[2] - state.position[2]);
  const enteredWindow = phase < swingWindow
    && (state.lastPhase >= swingWindow || phase < state.lastPhase);
  // A controller can begin translating at any point in the gait clock. The
  // foot whose swing window is already open must be allowed to leave once,
  // even near the end of that window; otherwise it stays at its initial rear
  // contact and turns ordinary startup into an emergency recovery cycle. Its
  // progress still begins at zero, so a late start never skips through space.
  const startFromRest = phase < swingWindow && drift > 0.075;
  const mayLift = moving && !suppressLift && !state.swinging && (allowFlight || !otherSwinging)
    && (forceLift || enteredWindow || startFromRest);
  let justLifted = false;
  let justLanded = false;
  if (mayLift) {
    state.swinging = true;
    // Always leave the ground from the current contact. Initialising progress
    // part-way through the curve—or compressing a late startup into the tiny
    // remainder of its phase window—moved the ankle tens of centimetres per
    // frame. Strict alternation lets every swing keep its ordinary duration;
    // the next foot simply waits and the clock naturally re-synchronises.
    state.progress = 0;
    state.swingDuration = Math.max(0.16, stepDuration);
    state.start = state.position.slice(0, 3);
    state.goal = desired.slice(0, 3);
    state.liftOffs++;
    justLifted = true;
    state.clearance = 0;
    if (terrainHeight) for (const sample of [0.25, 0.5, 0.75]) {
      const x = mix(state.start[0], state.goal[0], sample);
      const z = mix(state.start[2], state.goal[2], sample);
      const linearY = mix(state.start[1], state.goal[1], sample);
      state.clearance = Math.max(state.clearance, terrainHeight(x, z) - linearY);
    }
  }
  if (state.swinging) {
    // Recompute the predicted touchdown from the *remaining* swing time. On a
    // straight path this is the same world point committed at toe-off; through
    // a rounded corner it turns gradually with the actual travel direction.
    // Using remaining time is crucial: targeting a fresh full horizon every
    // frame would chase the translating root and lengthen the step forever.
    if (retargetStrength > 0) {
      const blend = 1 - Math.exp(-retargetStrength * Math.max(0, dt));
      state.goal[0] = mix(state.goal[0], desired[0], blend);
      state.goal[1] = mix(state.goal[1], desired[1], blend);
      state.goal[2] = mix(state.goal[2], desired[2], blend);
    }
    state.progress = Math.min(1, state.progress + Math.max(0, dt)
      / Math.max(0.12, state.swingDuration || stepDuration));
    const p = smooth01(state.progress);
    // Advance immediately after toe-off. Delaying horizontal travel while the
    // body kept moving left the ankle half a metre behind the hip before the
    // swing had visibly begun.
    const travel = p;
    state.position[0] = mix(state.start[0], state.goal[0], travel);
    state.position[2] = mix(state.start[2], state.goal[2], travel);
    state.position[1] = mix(state.start[1], state.goal[1], p)
      + Math.sin(p * Math.PI) * (stepHeight + Math.max(0, state.clearance));
    // A committed target may cross onto a different support after lift-off.
    // Never let the interpolated boot travel through the newly sampled floor.
    if (terrainHeight) {
      const underFoot = terrainHeight(state.position[0], state.position[2]);
      const swingClearance = Math.sin(p * Math.PI) * Math.min(0.018, stepHeight * 0.22);
      state.position[1] = Math.max(state.position[1], underFoot + swingClearance);
    }
    if (state.progress >= 1) {
      state.position = state.goal.slice(0, 3);
      state.swinging = false;
      state.touchdowns++;
      justLanded = true;
    }
  }
  state.lastPhase = phase;
  return { ...state, justLanded, justLifted };
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
  surfaceQuery = null,
  talking = false,
  gesturePhase = 0,
  acceleration = 0,
  turnRate = 0,
} = {}) {
  const timing = bipedTiming(speed);
  const moving = clamp01(speed / 0.35);
  state.phase = (state.phase + dt / timing.strideDuration) % 1;

  // The actor root is already resolved to the authoritative walkable surface.
  // Preserve the pelvis' root-local height when that support climbs, descends,
  // or hands off between terrain and an authored floor. Previously the root
  // moved but this world-space cache did not, so applyPose subtracted the new
  // root Y and buried the hips below the floor.
  if (state.rootY === null) state.rootY = position[1];
  else {
    const rootDeltaY = position[1] - state.rootY;
    if (state.pelvisY !== null) state.pelvisY += rootDeltaY;
    state.rootY = position[1];
  }

  const legLength = dims.legLength;
  const legBones = dims.thigh + dims.shin;
  const recoveryLimit = legBones * 0.58;
  // Lateral offset of each foot from the body centreline. Humans walk on a
  // narrow base — the feet track close to the midline, not under the hips — and
  // it narrows further at speed.
  const trackWidth = (dims.hipJointWidth ?? dims.hipWidth) * mix(0.42, 0.26, timing.running);
  // This is a WORLD-SPACE landing goal chosen at lift-off. It must include the
  // distance the root will cover during swing, then lead the pelvis by half a
  // stance. Cap only that body-relative lead, never the root travel during the
  // swing. Capping the entire world-space horizon shortened brisk-walk
  // landings, so every otherwise normal stance overran the recovery threshold.
  const maximumLead = Math.max(0.08,
    Math.sqrt(Math.max(0, recoveryLimit ** 2 - trackWidth ** 2)) - legLength * 0.012);
  const touchdownLead = Math.min(speed * timing.stanceDuration * 0.5, maximumLead);
  const right = [forward[2], 0, -forward[0]];
  const centreSurface = surfaceQuery ? surfaceQuery(position[0], position[2], position[1]) : null;
  const centreNormal = centreSurface?.normal || [0, 1, 0];
  const normalY = Math.max(0.2, centreNormal[1] || 1);
  const grade = -(centreNormal[0] * forward[0] + centreNormal[2] * forward[2]) / normalY;
  const crossSlope = -(centreNormal[0] * right[0] + centreNormal[2] * right[2]) / normalY;

  // Corners and collision slides can carry the root sideways while a strict
  // phase scheduler waits to lift an old support. Choose at most one overdue
  // contact for a controlled recovery step, while the other foot remains
  // planted. This is the biped-safe equivalent of recovery stepping: it never
  // permits two simultaneous lifts and it measures true horizontal reach,
  // rather than only the old heading's sagittal projection.
  const plannedTrail = Math.max(0, speed * timing.stanceDuration - touchdownLead);
  const plannedContactReach = Math.hypot(Math.max(touchdownLead, plannedTrail), trackWidth);
  // The planned toe-off is allowed to use the normal walking envelope. The
  // recovery path is reserved for a corner/collision that carries a contact
  // beyond that envelope, rather than becoming the cadence generator.
  const recoveryTrigger = Math.max(recoveryLimit, plannedContactReach + legLength * 0.035);
  const recoveryScores = state.feet.map((foot, i) => {
    if (!foot.initialized || foot.swinging) return 0;
    const side = i === 0 ? -1 : 1;
    const jointWidth = dims.hipJointWidth ?? dims.hipWidth;
    const hipX = position[0] + right[0] * side * jointWidth * 0.5;
    const hipZ = position[2] + right[2] * side * jointWidth * 0.5;
    return Math.hypot(foot.position[0] - hipX, foot.position[2] - hipZ);
  });
  let recoveryFoot = -1;
  const overdueFoot = recoveryScores[1] > recoveryScores[0] ? 1 : 0;
  // Never force the other foot out of the air to service an overdue contact.
  // That discontinuity was the visible "limp legs, then jump" cycle on brisk
  // inter-building walks. Wait for its ordinary touchdown, then release the
  // trailing support from the exact point where it was planted.
  if (!state.feet.some((foot) => foot.swinging)) {
    if (recoveryScores[overdueFoot] > recoveryTrigger
      && state.lastLiftedFoot !== overdueFoot) recoveryFoot = overdueFoot;
  }

  const legs = [];
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const footPhase = (state.phase + FOOT_PHASE[i]) % 1;
    const lateral = side * trackWidth;
    const remainingSwing = state.feet[i].swinging
      ? (state.feet[i].swingDuration || timing.swingDuration) * (1 - state.feet[i].progress)
      : timing.swingDuration;
    const landingHorizon = speed * remainingSwing + touchdownLead;
    const desiredX = position[0] + forward[0] * landingHorizon + right[0] * lateral;
    const desiredZ = position[2] + forward[2] * landingHorizon + right[2] * lateral;
    const desiredSurface = surfaceQuery ? surfaceQuery(desiredX, desiredZ, position[1]) : null;
    const desiredY = desiredSurface?.y ?? (terrainHeight ? terrainHeight(desiredX, desiredZ) : position[1]);
    const swingWindow = 1 - timing.dutyFactor;
    const initialStanceProgress = footPhase >= swingWindow
      ? (footPhase - swingWindow) / Math.max(0.01, timing.dutyFactor) : 0;
    const initialForeAft = footPhase >= swingWindow
      ? speed * timing.stanceDuration * (0.5 - initialStanceProgress)
      : -speed * timing.stanceDuration * 0.5;
    const initialX = position[0] + forward[0] * initialForeAft + right[0] * lateral;
    const initialZ = position[2] + forward[2] * initialForeAft + right[2] * lateral;
    const initialY = terrainHeight ? terrainHeight(initialX, initialZ) : position[1];
    const alternatingLock = state.lastLiftedFoot === i;
    const foot = advanceHumanFoot(state.feet[i], [desiredX, desiredY, desiredZ], footPhase, dt, {
      swingWindow,
      stepDuration: timing.swingDuration,
      stepHeight: timing.stepHeight * mix(0.35, 1, moving)
        + Math.min(0.09, Math.abs(grade) * legLength * 0.12),
      moving: moving > 0.02,
      otherSwinging: state.feet[1 - i].swinging,
      allowFlight: timing.dutyFactor < 0.5,
      terrainHeight,
      initial: [initialX, initialY, initialZ],
      forceLift: recoveryFoot === i,
      suppressLift: alternatingLock || (recoveryFoot >= 0 && recoveryFoot !== i),
      retargetStrength: 11,
    });
    if (foot.justLifted) state.lastLiftedFoot = i;
    if (!foot.swinging && foot.justLanded) {
      // Validate against the hip at the actual touchdown frame. A committed
      // goal chosen before a turn can otherwise land half a metre sideways
      // from the newly oriented body and immediately saturate the leg.
      const jointWidth = dims.hipJointWidth ?? dims.hipWidth;
      const hipX = position[0] + right[0] * side * jointWidth * 0.5;
      const hipZ = position[2] + right[2] * side * jointWidth * 0.5;
      const dx = foot.position[0] - hipX, dz = foot.position[2] - hipZ;
      const distance = Math.hypot(dx, dz);
      // A symmetric brisk-walk landing naturally sits close to the ordinary
      // contact limit. Only clamp a true corner/collision emergency; the old
      // 0.82 factor moved every normal boot backward on touchdown.
      const landingReach = recoveryLimit * 0.985;
      if (distance > landingReach) {
        foot.position[0] = hipX + dx / distance * landingReach;
        foot.position[2] = hipZ + dz / distance * landingReach;
        foot.position[1] = terrainHeight
          ? terrainHeight(foot.position[0], foot.position[2]) : position[1];
        state.feet[i].goal = foot.position.slice(0, 3);
      }
    }
    const footSurface = surfaceQuery
      ? surfaceQuery(foot.position[0], foot.position[2], foot.position[1] + 0.3)
      : desiredSurface;
    legs.push({ side, phase: footPhase, foot, footSurface, justLanded: foot.justLanded });
  }

  // The root's walkable support is authoritative for body height. Contacts
  // guide the legs; an impossible stale contact may request a recovery step but
  // may never pull the body down to satisfy itself. The previous reach clamp
  // collapsed a normal 0.795m pelvis to 0.15m at repeatable structure corners.
  const crouch = legLength * mix(0.012, 0.055, timing.running);
  // Two rises per stride: the body vaults over each stance leg in turn.
  const bob = Math.cos(state.phase * TAU * 2) * legLength
    * mix(BIPED_GAIT.bobWalk, BIPED_GAIT.bobRun, timing.running) * moving;
  const nominalPelvisY = position[1] + dims.hipHeight - crouch + bob;
  // A reachable planted foot can gently lower the hip through the long part of
  // stance. Invalid contacts are deliberately excluded: they request the
  // controlled recovery step above and never become a reason to collapse the
  // body. Use full horizontal distance so a 90-degree turn cannot hide a stale
  // lateral contact by projecting it onto the new forward axis.
  let contactPelvisCeiling = Infinity;
  for (const { foot, side } of legs) {
    const jointWidth = dims.hipJointWidth ?? dims.hipWidth;
    const hipX = position[0] + right[0] * side * jointWidth * 0.5;
    const hipZ = position[2] + right[2] * side * jointWidth * 0.5;
    const horizontal = Math.hypot(foot.position[0] - hipX, foot.position[2] - hipZ);
    if (horizontal > legBones * 0.72) continue;
    const vertical = Math.sqrt(Math.max(0, (legBones * 0.997) ** 2 - horizontal ** 2));
    const legCeiling = foot.position[1] + dims.ankleHeight + vertical + legLength * 0.002;
    if (!foot.swinging) contactPelvisCeiling = Math.min(contactPelvisCeiling, legCeiling);
    else {
      // The pelvis begins accepting the approaching swing leg before heel
      // strike and keeps accepting the departing leg just after toe-off. This
      // preserves reach continuously instead of leaving a straight, dangling
      // leg until the contact flag changes on one frame.
      // Begin the transfer before the last instant of the swing. The square
      // root broadens the smooth edge-weight without introducing a hard
      // threshold, so the pelvis settles gradually for heel strike instead of
      // dropping after the ankle has already reached full extension.
      const transfer = Math.sqrt(smooth01(Math.abs((foot.progress || 0) - 0.5) * 2));
      contactPelvisCeiling = Math.min(contactPelvisCeiling,
        mix(nominalPelvisY, legCeiling, transfer));
    }
  }
  const targetPelvisY = Math.min(nominalPelvisY, contactPelvisCeiling);
  state.pelvisY = state.pelvisY === null ? targetPelvisY
    : mix(state.pelvisY, targetPelvisY, clamp01(dt * 9));
  const minimumLocalPelvis = dims.hipHeight - legLength * mix(0.15, 0.20, timing.running);
  const maximumLocalPelvis = dims.hipHeight + legLength * 0.035;
  state.pelvisY = Math.max(
    position[1] + minimumLocalPelvis,
    Math.min(position[1] + maximumLocalPelvis, state.pelvisY),
  );

  // One lateral shift per stride, toward whichever foot is bearing weight.
  const support = legs.map(({ foot, phase }) => foot.swinging ? 0
    : 0.25 + 0.75 * Math.sin(clamp01((phase - (1 - timing.dutyFactor)) / Math.max(0.01, timing.dutyFactor)) * Math.PI));
  const supportBalance = (support[1] - support[0]) / Math.max(0.25, support[0] + support[1]);
  const targetSway = supportBalance * dims.hipWidth * mix(0.055, 0.025, timing.running) * moving;
  state.pelvisSway = mix(state.pelvisSway, targetSway, clamp01(dt * 10));
  const sway = state.pelvisSway;
  const lean = mix(BIPED_GAIT.leanWalk, BIPED_GAIT.leanRun, timing.running) * moving
    + clamp01(Math.abs(acceleration) / 5) * Math.sign(acceleration) * 0.055
    + (talking ? -0.03 : 0);
  // Pelvis and shoulders counter-rotate; that opposition is most of what makes
  // a walk read as a walk rather than a shuffle.
  const pelvisTwist = Math.sin(state.phase * TAU) * 0.06 * moving;

  const legLimits = humanLegLimits();
  const armLimits = humanArmLimits();
  const legLengths = [dims.thigh, dims.shin];

  const solvedLegs = legs.map(({ foot, phase, side, footSurface, justLanded }) => {
    // Resolve the world-space foot into the leg's own sagittal plane: how far
    // ahead of the hip it sits, and how far below.
    // The leg swings from the joint, not from the outer edge of the pelvis.
    const jointWidth = dims.hipJointWidth ?? dims.hipWidth;
    const hipX = position[0] + right[0] * side * jointWidth * 0.5;
    const hipZ = position[2] + right[2] * side * jointWidth * 0.5;
    const dx = foot.position[0] - hipX;
    const dz = foot.position[2] - hipZ;
    const targetForward = dx * forward[0] + dz * forward[2];
    // Aim the anatomical ankle above the ground contact. The visible boot is
    // parented at that ankle; treating it as a third skeleton link made the IK
    // solve for a bone that does not exist in the rendered rig.
    const targetDown = state.pelvisY - (foot.position[1] + dims.ankleHeight);
    // Seed on the correct side of the knee hinge before CCD refines it.
    const safeTargetDown = Math.max(dims.ankleHeight * 0.35, targetDown);
    const seed = seedTwoLinkAngles(legLengths[0], legLengths[1], targetForward, safeTargetDown, -1);
    // The closed-form seed is the exact two-bone solution. Running CCD after
    // it introduced branch/limit churn despite the rendered skeleton ending at
    // the ankle. Operational walking flex is narrower than the full anatomical
    // range retained by humanLegLimits for seated and situated actions.
    const hip = Math.max(legLimits[0][0], Math.min(legLimits[0][1], seed[0]));
    const knee = Math.max(-1.68, Math.min(legLimits[1][1], seed[1]));
    const solvedFk = forwardKinematics2D([dims.thigh, dims.shin], [hip, knee]);
    // Heel strike into toe-off: the ankle rolls forward through stance.
    const stance = phase >= (1 - timing.dutyFactor);
    const stanceProgress = stance
      ? (phase - (1 - timing.dutyFactor)) / Math.max(0.01, timing.dutyFactor) : 0;
    const surfaceNormal = footSurface?.normal || centreNormal;
    const footGrade = -(surfaceNormal[0] * forward[0] + surfaceNormal[2] * forward[2])
      / Math.max(0.2, surfaceNormal[1] || 1);
    const footCrossSlope = -(surfaceNormal[0] * right[0] + surfaceNormal[2] * right[2])
      / Math.max(0.2, surfaceNormal[1] || 1);
    const requestedFootPitch = (stance
      ? mix(-0.05, 0.08, stanceProgress) * moving
      : mix(0.07, -0.05, phase / Math.max(0.01, 1 - timing.dutyFactor)) * moving)
      - Math.atan(footGrade) * (foot.swinging ? 0.35 : 0.9);
    const ankle = Math.max(legLimits[2][0], Math.min(legLimits[2][1],
      requestedFootPitch - hip - knee));
    const actualFootPitch = hip + knee + ankle;
    const contact = foot.swinging ? 'swing'
      : justLanded ? 'heel-strike'
        : stanceProgress > 0.82 && moving > 0.1 ? 'toe-off' : 'stance';
    return {
      side,
      phase,
      hip,
      knee,
      // Foot pitch is WORLD-relative. The rendered foot bone is parented under
      // both thigh and shin, so its local ankle rotation must cancel their
      // accumulated rotation first. Without this counter-rotation the boot
      // follows the shin like a dangling marionette paddle.
      ankle,
      footPitch: actualFootPitch,
      requestedFootPitch,
      roll: Math.atan(footCrossSlope) * (foot.swinging ? 0.25 : 0.8),
      planted: !foot.swinging,
      contact,
      supportWeight: foot.swinging ? 0 : clamp01(Math.sin(Math.max(0.02, stanceProgress) * Math.PI) * 1.4),
      foot: foot.position.slice(0, 3),
      surface: footSurface || null,
      reachError: Math.hypot(solvedFk.forward - targetForward, solvedFk.down - safeTargetDown),
      horizontalReach: Math.hypot(dx, dz),
      recovery: recoveryFoot === (side < 0 ? 0 : 1),
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
    terrain: { normal: centreNormal.slice(0, 3), grade, crossSlope },
    turn: { rate: turnRate, lean: clamp01(Math.abs(turnRate) / 3) * Math.sign(turnRate) * 0.035 },
    legs: solvedLegs,
    arms,
    grounded: solvedLegs.some((leg) => leg.planted),
    doubleSupport: solvedLegs.every((leg) => leg.planted),
    limits: { leg: legLimits, arm: armLimits },
  };
}
