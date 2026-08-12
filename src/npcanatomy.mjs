// Human bind-pose anatomy for NPCs.
//
// The animals derive every limb length from one species recipe so the renderer,
// the gait solver and the comparison lab can never disagree about where a joint
// is. NPCs get the same treatment, with the segment table replaced by real
// human anthropometry instead of a quadruped recipe.
//
// Fractions are of stature, following the standard Drillis & Contini / Winter
// segment table. Using published ratios rather than eyeballed numbers is what
// makes a bipedal walk read as human: knee height, the thigh/shin near-parity
// and the shoulder/hip width ratio are all things the eye checks without being
// asked, and a stride solved on wrong bones looks wrong no matter how good the
// gait maths is.
//
// THREE-free, like animalgait.mjs, so the same numbers can be asserted in tests
// and reused by any renderer.

import { npcHipHeight } from './npcpopulation.mjs';

// Segment lengths as a fraction of stature.
export const HUMAN_SEGMENTS = Object.freeze({
  hipHeight: 0.530,      // hip joint centre above the ground
  shoulderHeight: 0.818, // acromion above the ground
  thigh: 0.245,          // hip joint -> knee
  shin: 0.246,           // knee -> ankle
  ankleHeight: 0.039,    // ankle joint above the sole
  footLength: 0.152,
  upperArm: 0.186,       // shoulder -> elbow
  forearm: 0.146,        // elbow -> wrist
  hand: 0.108,
  shoulderWidth: 0.259,  // biacromial: the BREADTH of the body at the shoulders
  hipWidth: 0.191,       // bi-iliac: the BREADTH of the body at the hips
  // Joint separations, which are much narrower than the breadths above and are
  // what the skeleton is actually built from. Femoral heads sit close to the
  // midline; the pelvis is wide because of the ilia around them, not because
  // the legs hang from its outer edge. Building bones on the breadths gave a
  // resident a stance a third of a metre wide and a pelvis twice its proper
  // width.
  hipJointWidth: 0.100,      // femoral head to femoral head
  shoulderJointWidth: 0.200, // glenohumeral, inset from the acromion
  headHeight: 0.130,
  neck: 0.052,
});

// Limb thickness as a fraction of stature. These set the volume of the
// overlapping capsules the skin is built over, not the skin itself.
export const HUMAN_GIRTH = Object.freeze({
  thigh: 0.058,
  knee: 0.050,
  calf: 0.048,
  ankle: 0.034,
  upperArm: 0.040,
  elbow: 0.036,
  forearm: 0.033,
  wrist: 0.026,
  pelvis: 0.088,
  waist: 0.078,
  chest: 0.098,
  neck: 0.038,
});

/**
 * Human joint ranges for the sagittal-plane IK, in the same convention as
 * quadrupedLegLimits: [min, max] per link, relative to the parent.
 *
 * The knee is the one that matters. A human knee flexes in exactly one
 * direction — the shin may swing backward from the thigh and must never pass
 * in front of it. Allowing a symmetric range is what makes a solved biped look
 * broken: the IK will happily bend the knee forwards on the swing leg, and it
 * reads instantly as a snapped joint rather than a stride.
 */
export function humanLegLimits() {
  // Positive is forward (angle 0 points straight down), so the hip's generous
  // range belongs on the POSITIVE side: a hip flexes ~120 degrees forward but
  // extends only ~30 behind. Getting that round the wrong way leaves the solver
  // clamped at the hip and unable to raise a knee in swing at all.
  return [
    [-0.55, 2.10],   // hip: 120 deg flexion forward, 30 deg extension behind
    [-2.45, -0.02],  // knee: flexes backward ONLY, never locks past straight
    [-0.75, 0.65],   // ankle: plantar/dorsiflexion
  ];
}

/** The elbow is the knee's mirror: the forearm folds forward, never back. */
export function humanArmLimits() {
  return [
    [-1.20, 2.60],   // shoulder: swings well forward, less far behind
    [0.02, 2.55],    // elbow: 145 deg flexion forward ONLY
    [-0.55, 0.55],   // wrist
  ];
}

/**
 * Bind dimensions in metres for one NPC identity's proportions.
 *
 * Stature is derived from the EXISTING hip height rather than invented, so an
 * NPC keeps standing exactly where the world already places it. Everything else
 * hangs off that stature through the segment table.
 */
export function npcBindDimensions(proportions = {}) {
  const legScale = proportions.legScale ?? 1;
  const build = proportions.build ?? 1;
  const headScale = proportions.headScale ?? 1;
  // Build alone widens shoulders and hips by the same multiplier, which made
  // the shoulder-to-hip ratio a constant for everybody. These let it vary
  // without touching bone lengths. They default to 1, so a caller that does
  // not supply them gets exactly the previous frame.
  const shoulderScale = proportions.shoulderScale ?? 1;
  const hipScale = proportions.hipScale ?? 1;
  const waistScale = proportions.waistScale ?? 1;
  // npcHipHeight is in the root's local space; the root then scales by height.
  const hipHeight = npcHipHeight(legScale);
  const stature = hipHeight / HUMAN_SEGMENTS.hipHeight;
  const s = (fraction) => stature * fraction;

  // The leg chain has to reach the ground from the hip: thigh + shin + ankle
  // height must equal hip height, or the NPC floats or sinks. legScale stretches
  // the long bones and leaves the ankle alone, since a longer leg is femur and
  // tibia, not a taller ankle.
  const ankleHeight = s(HUMAN_SEGMENTS.ankleHeight);
  const legSpan = hipHeight - ankleHeight;
  const thighShare = HUMAN_SEGMENTS.thigh / (HUMAN_SEGMENTS.thigh + HUMAN_SEGMENTS.shin);
  const thigh = legSpan * thighShare;
  const shin = legSpan * (1 - thighShare);

  return Object.freeze({
    stature,
    hipHeight,
    ankleHeight,
    shoulderHeight: s(HUMAN_SEGMENTS.shoulderHeight),
    // torso is measured from the hip joint up to the shoulder
    torsoLength: s(HUMAN_SEGMENTS.shoulderHeight) - hipHeight,
    thigh,
    shin,
    footLength: s(HUMAN_SEGMENTS.footLength),
    upperArm: s(HUMAN_SEGMENTS.upperArm),
    forearm: s(HUMAN_SEGMENTS.forearm),
    hand: s(HUMAN_SEGMENTS.hand),
    neck: s(HUMAN_SEGMENTS.neck),
    headHeight: s(HUMAN_SEGMENTS.headHeight) * headScale,
    // Build widens the frame without lengthening any bone; the frame scalars
    // then bias it one way or the other. Shoulders stay broader than hips at
    // every value in their permitted range, which the invariants below rely on.
    shoulderWidth: s(HUMAN_SEGMENTS.shoulderWidth) * build * shoulderScale,
    hipWidth: s(HUMAN_SEGMENTS.hipWidth) * build * hipScale,
    // Joints do not widen with build the way flesh does, but they widen a
    // little: a heavier frame is a broader skeleton, not only a thicker one.
    hipJointWidth: s(HUMAN_SEGMENTS.hipJointWidth) * (1 + (build - 1) * 0.5),
    shoulderJointWidth: s(HUMAN_SEGMENTS.shoulderJointWidth) * (1 + (build - 1) * 0.5),
    girth: Object.freeze(Object.fromEntries(
      Object.entries(HUMAN_GIRTH).map(([key, fraction]) => [
        key, s(fraction) * build * (key === 'waist' ? waistScale : 1),
      ]),
    )),
    legLength: thigh + shin + ankleHeight,
    armLength: s(HUMAN_SEGMENTS.upperArm) + s(HUMAN_SEGMENTS.forearm),
  });
}

/**
 * The same dimensions in world metres.
 *
 * npcBindDimensions works in the root's local space and the root then scales it.
 * A gait cannot: its feet are planted at world coordinates while the body
 * travels over them, so its limb lengths have to be world lengths too, or the
 * IK solves against a leg that is the wrong size and the stride never quite
 * reaches the ground.
 *
 * The root scale is uniform (see createNpcAvatar — a non-uniform one would not
 * commute with the bone rotations), so this is a single factor applied to every
 * length the gait measures with. `build` is already inside dims and must not be
 * applied again. Girths and the segments used to author bind geometry stay
 * local, because that is the space the skeleton and garments are built in.
 */
export function npcWorldDimensions(dims, proportions = {}) {
  const scale = proportions.height ?? 1;
  return Object.freeze({
    ...dims,
    hipHeight: dims.hipHeight * scale,
    ankleHeight: dims.ankleHeight * scale,
    thigh: dims.thigh * scale,
    shin: dims.shin * scale,
    legLength: dims.legLength * scale,
    hipWidth: dims.hipWidth * scale,
    hipJointWidth: dims.hipJointWidth * scale,
  });
}
