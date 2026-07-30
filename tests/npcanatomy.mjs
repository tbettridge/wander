import assert from 'node:assert/strict';
import {
  HUMAN_GIRTH, HUMAN_SEGMENTS, humanArmLimits, humanLegLimits, npcBindDimensions,
} from '../src/npcanatomy.mjs';
import { npcHipHeight } from '../src/npcpopulation.mjs';
import { forwardKinematics2D, solveThreeLinkIK } from '../src/animalgait.mjs';
import { seedTwoLinkAngles } from '../src/npcgait.mjs';

// --- the segment table must stay real anthropometry --------------------------
// These are published Drillis & Contini / Winter fractions of stature. Drifting
// from them is a proportion error, not a style choice: the eye checks knee
// height and thigh/shin parity without being asked.
assert.ok(Math.abs(HUMAN_SEGMENTS.thigh - HUMAN_SEGMENTS.shin) < 0.01,
  'human thigh and shin are near-equal; a long thigh over a short shin reads as a bird');
assert.ok(HUMAN_SEGMENTS.upperArm > HUMAN_SEGMENTS.forearm,
  'the upper arm is longer than the forearm');
assert.ok(HUMAN_SEGMENTS.shoulderWidth > HUMAN_SEGMENTS.hipWidth,
  'shoulders are broader than hips');
assert.ok(HUMAN_SEGMENTS.hipHeight > 0.5 && HUMAN_SEGMENTS.hipHeight < 0.56,
  'the hip joint sits just above half of stature');

// --- bind dimensions over the real identity range ----------------------------
// npcpopulation generates legScale 0.90-1.08, build 0.86-1.14, headScale 0.91-1.10.
for (const legScale of [0.90, 1.0, 1.08]) {
  for (const build of [0.86, 1.0, 1.14]) {
    const dims = npcBindDimensions({ legScale, build, headScale: 1 });
    const label = `legScale ${legScale} build ${build}`;

    // Stature must land in a plausible human range for a stylised world.
    assert.ok(dims.stature > 1.30 && dims.stature < 1.75,
      `${label}: stature ${dims.stature.toFixed(2)}m implausible`);

    // THE load-bearing invariant: the leg chain must exactly reach the ground
    // from the hip. If thigh + shin + ankle != hip height the NPC floats or
    // sinks into the terrain, and no amount of gait tuning will hide it.
    assert.ok(Math.abs(dims.legLength - dims.hipHeight) < 1e-9,
      `${label}: leg chain ${dims.legLength.toFixed(4)} != hip height ${dims.hipHeight.toFixed(4)}`);

    // Hip height must still match what the world already uses to place NPCs,
    // or every NPC shifts vertically the moment this module is adopted.
    assert.ok(Math.abs(dims.hipHeight - npcHipHeight(legScale)) < 1e-9,
      `${label}: hip height diverged from npcHipHeight`);

    assert.ok(dims.shoulderHeight > dims.hipHeight,
      `${label}: shoulders must sit above the hips`);
    assert.ok(dims.torsoLength > 0.30 && dims.torsoLength < 0.60,
      `${label}: torso ${dims.torsoLength.toFixed(2)}m implausible`);
    assert.ok(dims.shoulderWidth > dims.hipWidth,
      `${label}: shoulders must be broader than hips`);
    // Build widens without lengthening — a heavier NPC is not a taller one.
    const lean = npcBindDimensions({ legScale, build: 0.86, headScale: 1 });
    const heavy = npcBindDimensions({ legScale, build: 1.14, headScale: 1 });
    assert.ok(Math.abs(lean.thigh - heavy.thigh) < 1e-9,
      `${label}: build must not change bone length`);
    assert.ok(heavy.girth.chest > lean.girth.chest,
      `${label}: build must widen the frame`);

    // Limbs must be thinner than the body they hang off, or the silhouette
    // reads as a balloon animal.
    assert.ok(dims.girth.thigh < dims.girth.pelvis, `${label}: thigh thicker than pelvis`);
    assert.ok(dims.girth.upperArm < dims.girth.chest, `${label}: arm thicker than chest`);
    assert.ok(dims.girth.wrist < dims.girth.forearm, `${label}: wrist thicker than forearm`);
    assert.ok(dims.girth.ankle < dims.girth.calf, `${label}: ankle thicker than calf`);
    // Joints bulge slightly relative to the segment below, which is what lets
    // the skin stay full through a bend instead of pinching.
    assert.ok(HUMAN_GIRTH.knee > HUMAN_GIRTH.ankle, 'the knee is wider than the ankle');
    assert.ok(HUMAN_GIRTH.elbow > HUMAN_GIRTH.wrist, 'the elbow is wider than the wrist');
  }
}

// --- joint limits must be anatomically one-directional -----------------------
// The knee and elbow are hinges. Allowing either to pass through straight is
// what makes a solved biped look snapped rather than striding.
const [, knee] = humanLegLimits();
assert.ok(knee[1] <= 0, `the knee must never extend past straight (max ${knee[1]})`);
assert.ok(knee[0] < -1.5, 'the knee must flex far enough to clear the ground in swing');

const [, elbow] = humanArmLimits();
assert.ok(elbow[0] >= 0, `the elbow must never extend past straight (min ${elbow[0]})`);
assert.ok(elbow[1] > 2.0, 'the elbow must fold far enough to bring the hand to the shoulder');

// --- the IK actually reaches, within the human limits ------------------------
// A limit set that cannot reach the ground would silently leave every foot
// hovering, which is exactly the failure the old sine puppet had.
const dims = npcBindDimensions({ legScale: 1, build: 1, headScale: 1 });
const lengths = [dims.thigh, dims.shin, dims.ankleHeight];
for (const [fwd, down, label] of [
  [0, dims.hipHeight * 0.99, 'straight below the hip'],
  [dims.hipHeight * 0.35, dims.hipHeight * 0.90, 'forward heel strike'],
  [-dims.hipHeight * 0.30, dims.hipHeight * 0.88, 'behind at toe-off'],
  [dims.hipHeight * 0.20, dims.hipHeight * 0.55, 'knee raised in swing'],
]) {
  // Seeded the way the gait seeds it. A near-straight seed pins CCD against the
  // knee's "never past straight" limit and stalls with ~0.32m of error — see
  // seedTwoLinkAngles.
  const seed = seedTwoLinkAngles(lengths[0], lengths[1], fwd, down, -1);
  const solved = solveThreeLinkIK(lengths, fwd, down, [seed[0], seed[1], 0], humanLegLimits());
  assert.ok(solved.error < 0.045,
    `leg IK could not reach ${label}: error ${solved.error.toFixed(3)}m`);
  // and the solution must respect the hinge
  assert.ok(solved.angles[1] <= 0.001,
    `leg IK bent the knee forwards for ${label} (${solved.angles[1].toFixed(3)})`);
}

// forward kinematics must agree with the solver it was solved against
const checkSeed = seedTwoLinkAngles(lengths[0], lengths[1], 0.2, dims.hipHeight * 0.9, -1);
const check = solveThreeLinkIK(lengths, 0.2, dims.hipHeight * 0.9,
  [checkSeed[0], checkSeed[1], 0], humanLegLimits());
const fk = forwardKinematics2D(lengths, check.angles);
assert.ok(Math.hypot(fk.forward - check.forward, fk.down - check.down) < 1e-6,
  'forward kinematics must agree with the IK solution');

console.log('npcanatomy PASS · real segment fractions · leg chain reaches the ground · '
  + 'one-directional knee and elbow · IK solves inside human limits');
