// Shared quadruped locomotion.  Species recipes tune scale and cadence; the
// phase relationships and secondary motion remain common across every animal.

import { LEG_ORDER } from './animaldata.mjs';

const TAU = Math.PI * 2;
// Fractional swing-duration difference between hind and fore limbs (see the
// per-leg duty split in quadrupedPose).
const DUTY_SPLIT = 0.06;
// Lateral-sequence mammal walk. In cyclic order the right hind lifts, then
// right fore, left hind and left fore; trot converges to diagonal pairs.
const WALK_PHASE = [0.25, 0.75, 0.50, 0.00];
const TROT_PHASE = [0.00, 0.50, 0.50, 0.00];
// Rotary gallop: the hind pair lands, then the fore pair in the OPPOSITE
// left/right order, so the footfalls travel around the body in one rotational
// direction (RH, LH, LF, RF). Fast canids and felids use this at speed; the
// previous values ran the fore pair in the same order as the hinds, which is a
// transverse gallop — a horse's high-speed gait, not a fox's.
const CANID_GALLOP_PHASE = [0.46, 0.52, 0.06, 0.00];

const GAIT_PROFILES = Object.freeze({
  ungulate: Object.freeze({
    id: 'ungulate',
    runPhase: TROT_PHASE,
    runSwing: 0.505,
    runReach: 0.70,
    swingDurationBoost: 0.06,
    stepLiftBoost: 0.40,
    crouch: 0.045,
    rootFlight: 3.15,
    retargetBoost: 8,
    suspensionThreshold: 0.84,
    spineFlex: 0.014,
    // A trot keeps two diagonal support phases per stride, so the body rises
    // and falls twice per cycle. Nothing to blend toward.
    bobSingleBeat: 0,
  }),
  canid: Object.freeze({
    id: 'canid',
    runPhase: CANID_GALLOP_PHASE,
    runSwing: 0.55,
    runReach: 0.88,
    swingDurationBoost: 0.12,
    stepLiftBoost: 0.22,
    crouch: 0.072,
    rootFlight: 3.65,
    retargetBoost: 11,
    suspensionThreshold: 0.66,
    spineFlex: 0.060,
    // A gallop has one gathering/extension cycle per stride, so the centre of
    // mass rises and falls ONCE — not twice as in a walk or trot.
    bobSingleBeat: 1,
  }),
});

export function quadrupedGaitProfile(recipe) {
  return GAIT_PROFILES[recipe?.gait?.class] || GAIT_PROFILES.ungulate;
}

function clamp01(value) { return Math.max(0, Math.min(1, value)); }
function mix(a, b, t) { return a + (b - a) * t; }
function smooth01(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}
function periodicPhase(a, b, t) {
  let delta = b - a;
  if (delta > 0.5) delta -= 1;
  if (delta < -0.5) delta += 1;
  return (a + delta * t + 1) % 1;
}

function normalizeAngle(value) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

export function forwardKinematics2D(lengths, angles) {
  let forward = 0;
  let down = 0;
  let angle = 0;
  const joints = [{ forward: 0, down: 0 }];
  for (let i = 0; i < lengths.length; i++) {
    angle += angles[i];
    forward += Math.sin(angle) * lengths[i];
    down += Math.cos(angle) * lengths[i];
    joints.push({ forward, down });
  }
  return { forward, down, angle, joints };
}

// Constrained CCD in the leg's sagittal plane. Positive forward matches a
// positive rotation around a Three.js bone's local X axis when the child bone
// extends down local -Y. Keeping this solver data-only makes the same IK useful
// in the game, the comparison lab and deterministic tests.
export function solveThreeLinkIK(lengths, targetForward, targetDown, initialAngles, limits, iterations = 24) {
  const angles = initialAngles.slice(0, 3);
  const constraints = limits || lengths.map(() => [-Math.PI * 0.85, Math.PI * 0.85]);
  const maxReach = lengths.reduce((sum, length) => sum + length, 0) * 0.998;
  const targetLength = Math.hypot(targetForward, targetDown);
  if (targetLength > maxReach) {
    const scale = maxReach / targetLength;
    targetForward *= scale;
    targetDown *= scale;
  }

  let endForward = 0;
  let endDown = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let joint = 2; joint >= 0; joint--) {
      const angle0 = angles[0];
      const angle1 = angle0 + angles[1];
      const angle2 = angle1 + angles[2];
      const joint1Forward = Math.sin(angle0) * lengths[0];
      const joint1Down = Math.cos(angle0) * lengths[0];
      const joint2Forward = joint1Forward + Math.sin(angle1) * lengths[1];
      const joint2Down = joint1Down + Math.cos(angle1) * lengths[1];
      endForward = joint2Forward + Math.sin(angle2) * lengths[2];
      endDown = joint2Down + Math.cos(angle2) * lengths[2];
      const originForward = joint === 0 ? 0 : joint === 1 ? joint1Forward : joint2Forward;
      const originDown = joint === 0 ? 0 : joint === 1 ? joint1Down : joint2Down;
      const currentForward = endForward - originForward;
      const currentDown = endDown - originDown;
      const desiredForward = targetForward - originForward;
      const desiredDown = targetDown - originDown;
      const delta = normalizeAngle(
        Math.atan2(desiredForward, desiredDown) - Math.atan2(currentForward, currentDown),
      );
      const range = constraints[joint] || [-Math.PI, Math.PI];
      angles[joint] = Math.max(range[0], Math.min(range[1], angles[joint] + delta));
    }
    const angle0 = angles[0];
    const angle1 = angle0 + angles[1];
    const angle2 = angle1 + angles[2];
    endForward = Math.sin(angle0) * lengths[0]
      + Math.sin(angle1) * lengths[1] + Math.sin(angle2) * lengths[2];
    endDown = Math.cos(angle0) * lengths[0]
      + Math.cos(angle1) * lengths[1] + Math.cos(angle2) * lengths[2];
    if (Math.hypot(endForward - targetForward, endDown - targetDown) < 0.0015) break;
  }

  return {
    angles,
    forward: endForward,
    down: endDown,
    error: Math.hypot(endForward - targetForward, endDown - targetDown),
  };
}

export function quadrupedLegLimits(isFront) {
  // Front elbows flex rearward (negative relative angle); hind hocks flex
  // forward (positive relative angle). Keeping those hinge signs distinct
  // prevents the lower limb from snapping through into an impossible pose.
  // The third link (cannon/pastern) may trail behind freely but only kicks a
  // little forward of its parent — a fetlock folding far forward relative to
  // the tibia/radius reads as a dislocation, not a stride.
  return isFront
    ? [[-1.38, 1.38], [-1.72, 0.12], [-0.62, 0.58]]
    : [[-1.48, 1.26], [0.06, 2.02], [-0.70, 0.32]];
}

export function predictiveFootholdDistance(
  speed,
  swingDuration,
  stanceDuration,
  legLength,
  running = 0,
  runReach = 0.72,
) {
  // Account for torso travel before touchdown as well as the following stance.
  // The previous stance-only look-ahead caused fast hooves to land behind the
  // hip. Running also unlocks more of the upper limb's anatomical reach.
  const horizon = swingDuration * mix(0.74, 0.92, running) + stanceDuration * 0.50;
  const reach = legLength * mix(0.54, runReach, running);
  return Math.min(Math.max(0, speed) * horizon, reach);
}

export function createReactiveFootState(phase = 0) {
  return {
    position: [0, 0, 0],
    start: [0, 0, 0],
    goal: [0, 0, 0],
    initialized: false,
    swinging: false,
    armed: phase >= 0.34,
    progress: 0,
    lastPhase: phase,
  };
}

// A foot is a world-space constraint, not an angle curve. It remains planted
// through stance and only moves when its scheduled gait window opens (or body
// drift becomes excessive). The swing follows a smooth, raised trajectory and
// lands on the terrain height captured at step start.
export function advanceReactiveFoot(state, desired, phase, dt, options = {}) {
  const swingWindow = options.swingWindow ?? 0.34;
  const stepDuration = Math.max(0.08, options.stepDuration ?? 0.34);
  const stepHeight = options.stepHeight ?? 0.12;
  const triggerDistance = options.triggerDistance ?? 0.12;
  const emergencyDistance = options.emergencyDistance ?? triggerDistance * 2.25;
  const criticalDistance = options.criticalDistance ?? emergencyDistance * 1.22;
  if (!state.initialized) {
    state.position = desired.slice(0, 3);
    state.start = desired.slice(0, 3);
    state.goal = desired.slice(0, 3);
    state.initialized = true;
    state.armed = options.armOnInitialize ?? (phase >= swingWindow);
    state.lastPhase = phase;
    return state;
  }

  const planarDrift = Math.hypot(
    desired[0] - state.position[0],
    desired[2] - state.position[2],
  );
  if (phase >= swingWindow) state.armed = true;
  const enteredSwingWindow = phase < swingWindow
    && (state.lastPhase >= swingWindow || phase < state.lastPhase);
  const scheduledWindow = phase < swingWindow && planarDrift > triggerDistance;
  const overdueWindow = phase < Math.min(0.68, swingWindow + 0.28)
    && planarDrift > emergencyDistance;
  const criticallyOverdue = planarDrift > criticalDistance;
  const shouldStep = options.allowStep !== false && state.armed && !state.swinging && (
    scheduledWindow || overdueWindow || criticallyOverdue
    || (enteredSwingWindow && planarDrift > triggerDistance * 0.72)
  );
  if (shouldStep) {
    state.swinging = true;
    state.armed = false;
    state.progress = 0;
    state.start = state.position.slice(0, 3);
    state.goal = desired.slice(0, 3);
    state.clearanceBoost = Math.max(0, state.goal[1] - state.start[1]) * 0.42;
    if (options.terrainHeight) {
      for (const sample of [0.25, 0.50, 0.75]) {
        const sampleX = mix(state.start[0], state.goal[0], sample);
        const sampleZ = mix(state.start[2], state.goal[2], sample);
        const linearY = mix(state.start[1], state.goal[1], sample);
        state.clearanceBoost = Math.max(
          state.clearanceBoost,
          options.terrainHeight(sampleX, sampleZ) - linearY,
        );
      }
    }
  }

  if (state.swinging) {
    // During early swing, keep the landing solution responsive to a fast body
    // or changing escape heading. Late swing remains committed for a firm,
    // non-sliding contact.
    if (state.progress < 0.48 && options.retargetStrength > 0) {
      const retarget = Math.min(1, Math.max(0, dt) * options.retargetStrength);
      state.goal[0] = mix(state.goal[0], desired[0], retarget);
      state.goal[2] = mix(state.goal[2], desired[2], retarget);
      state.goal[1] = mix(state.goal[1], desired[1], retarget);
    }
    state.progress = Math.min(1, state.progress + Math.max(0, dt) / stepDuration);
    const smooth = smooth01(state.progress);
    // Ungulates flex first, then protract the limb. Holding horizontal travel
    // for the first 8% creates toe-off instead of scraping the hoof forward.
    const advance = smooth01((smooth - 0.08) / 0.86);
    const lift = Math.sin(Math.PI * Math.pow(smooth, 0.88));
    state.position[0] = mix(state.start[0], state.goal[0], advance);
    state.position[2] = mix(state.start[2], state.goal[2], advance);
    const arcY = mix(state.start[1], state.goal[1], advance)
      + lift * (stepHeight + (state.clearanceBoost || 0));
    if (options.terrainHeight) {
      const terrainY = options.terrainHeight(state.position[0], state.position[2]);
      state.position[1] = Math.max(arcY, terrainY + lift * stepHeight * 0.32);
      state.terrainMargin = state.position[1] - terrainY;
    } else {
      state.position[1] = arcY;
      state.terrainMargin = 0;
    }
    if (state.progress >= 1) {
      state.swinging = false;
      state.position = state.goal.slice(0, 3);
      state.terrainMargin = 0;
    }
  }
  state.lastPhase = phase;
  return state;
}

export function quadrupedTiming(recipe, speed01 = 0) {
  const profile = quadrupedGaitProfile(recipe);
  const locomotion = clamp01(speed01);
  const running = clamp01((locomotion - 0.46) / 0.42);
  const cadence = mix(recipe.gait.walkHz, recipe.gait.runHz, running)
    * (0.72 + locomotion * 0.72);
  const walkSwing = 1 - (recipe.gait.dutyFactor ?? 0.67);
  const swingPortion = mix(walkSwing, profile.runSwing, running);
  return { locomotion, running, cadence, swingPortion, dutyFactor: 1 - swingPortion, profile };
}

export function quadrupedPose(recipe, time, speed01 = 0, options = {}) {
  const timing = quadrupedTiming(recipe, speed01);
  const { locomotion, running, cadence, swingPortion, profile } = timing;
  const phaseSource = Number.isFinite(options.phaseOverride) ? options.phaseOverride : time * cadence;
  const phase = ((phaseSource % 1) + 1) % 1;
  const locomotionWeight = Math.sqrt(locomotion);
  const stride = recipe.gait.stride * locomotionWeight * mix(0.72, 1.12, running);
  const lift = recipe.gait.lift * locomotionWeight * mix(0.65, 1.12, running);
  const legs = {};

  for (let i = 0; i < LEG_ORDER.length; i++) {
    const name = LEG_ORDER[i];
    const legPhase = periodicPhase(WALK_PHASE[i], profile.runPhase[i], running);
    const cycle = (phase + legPhase) % 1;
    const hind = i >= 2;
    // Forelimbs carry roughly 60% of a quadruped's weight and hold contact
    // longer than the hindlimbs at the same speed. A small duty split gives the
    // forehand its heavier, more planted stance and lets the hindlimbs swing
    // through a touch quicker, which is what drives the animal forward.
    const legSwing = clamp01(swingPortion * (hind ? 1 + DUTY_SPLIT : 1 - DUTY_SPLIT));
    // A short, deliberate swing is followed by a long planted stance. This
    // reads as weight-bearing locomotion instead of four frantic pendulums.
    const inSwing = cycle < legSwing;
    const swingT = inSwing ? smooth01(cycle / legSwing) : 0;
    const stanceT = inSwing ? 0 : smooth01((cycle - legSwing) / (1 - legSwing));
    const upperX = inSwing ? mix(stride, -stride, swingT) : mix(-stride, stride, stanceT);
    const airborne = inSwing ? Math.sin(swingT * Math.PI) : 0;
    legs[name] = {
      swingPortion: legSwing,
      upperX: upperX * (hind ? 0.90 : 1),
      lowerX: -airborne * lift * (hind ? 0.82 : 1) - upperX * 0.10,
      pasternX: airborne * lift * (hind ? 0.26 : 0.18) + upperX * 0.05,
      hoofX: airborne * lift * 0.16 - upperX * 0.04,
      lift: airborne,
      phase: cycle,
    };
  }

  // Walk and trot lift the body twice per stride (one per support alternation);
  // a gallop lifts it once, over the single gathered/extended suspension.
  const twoBeat = 0.5 + 0.5 * Math.cos(phase * TAU * 2);
  const oneBeat = 0.5 + 0.5 * Math.cos(phase * TAU);
  const stepWave = mix(twoBeat, oneBeat, running * (profile.bobSingleBeat ?? 0));
  const idleBreath = Math.sin(time * 1.45 + (options.seedPhase || 0));
  return {
    phase,
    gaitClass: profile.id,
    locomotion,
    cadence,
    swingPortion,
    dutyFactor: timing.dutyFactor,
    running,
    legs,
    // At a trot/run, diagonal support alternates with a real aerial pulse.
    // This is still procedural root motion; planted feet remain world-space IK
    // constraints and extend naturally as the torso rises between contacts.
    rootBob: recipe.gait.bob * locomotion * stepWave * mix(1, profile.rootFlight, running),
    spineFlex: Math.sin(phase * TAU) * running * profile.spineFlex,
    runReach: profile.runReach,
    swingDurationBoost: profile.swingDurationBoost,
    stepLiftBoost: profile.stepLiftBoost,
    locomotionCrouch: profile.crouch,
    retargetBoost: profile.retargetBoost,
    suspensionThreshold: profile.suspensionThreshold,
    bodyPitch: Math.sin(phase * TAU) * locomotion * mix(0.012, 0.032, running),
    bodyRoll: Math.sin(phase * TAU + Math.PI * 0.5) * locomotion * 0.016,
    breath: idleBreath,
    tailWave: Math.sin(time * (1.8 + locomotion * 2.4) + (options.seedPhase || 0)),
    earFlick: Math.max(0, Math.sin(time * 0.77 + (options.seedPhase || 0) * 4) - 0.82) / 0.18,
  };
}

export function springStep(state, target, dt, frequency = 5.5, damping = 0.82) {
  const safeDt = Math.min(Math.max(dt, 0), 0.05);
  const stiffness = frequency * frequency;
  state.velocity += (target - state.value) * stiffness * safeDt;
  state.velocity *= Math.exp(-frequency * damping * safeDt);
  state.value += state.velocity * safeDt;
  return state.value;
}
