import assert from 'node:assert/strict';
import { ANIMAL_RECIPES, LEG_ORDER, animalBindDimensions, validateAnimalRecipe } from '../src/animaldata.mjs';
import {
  advanceReactiveFoot,
  createReactiveFootState,
  forwardKinematics2D,
  predictiveFootholdDistance,
  quadrupedGaitProfile,
  quadrupedPose,
  quadrupedLegLimits,
  quadrupedTiming,
  solveThreeLinkIK,
  springStep,
} from '../src/animalgait.mjs';

assert.deepEqual(Object.keys(ANIMAL_RECIPES).sort(), ['fox', 'moose', 'whitetail']);
assert.equal(quadrupedGaitProfile(ANIMAL_RECIPES.fox).id, 'canid');
assert.equal(quadrupedGaitProfile(ANIMAL_RECIPES.whitetail).id, 'ungulate');
assert.equal(quadrupedGaitProfile(ANIMAL_RECIPES.moose).id, 'ungulate');
for (const recipe of Object.values(ANIMAL_RECIPES)) {
  assert.deepEqual(validateAnimalRecipe(recipe), [], `${recipe.id} recipe is incomplete`);
  const bind = animalBindDimensions(recipe);
  assert.ok(bind.bodyY > bind.legHeight, `${recipe.id} body is below its legs`);
  assert.ok(bind.headY > bind.bodyY, `${recipe.id} head is not above its body`);
  // Leg height includes the femur/scapula portion buried inside the torso
  // (bodyLift < 1 sinks the roots into the body), so the envelope runs higher
  // than a visible-leg measurement would suggest.
  const legBodyRatio = bind.legHeight / recipe.body[1];
  assert.ok(legBodyRatio >= 2.2 && legBodyRatio <= 4.6,
    `${recipe.id} leg/body ratio is outside its anatomical envelope`);
  const rootBury = bind.legHeight - (bind.bodyY - recipe.body[1]);
  assert.ok(rootBury > 0,
    `${recipe.id} leg roots sit below the belly line instead of inside the torso`);
  for (const end of ['front', 'hind']) {
    const chain = recipe.leg[end];
    assert.equal(chain.lengths.length, 3, `${recipe.id} ${end} leg lacks articulation`);
    assert.ok(chain.lengths[2] >= chain.lengths[1] * 0.70,
      `${recipe.id} ${end} distal leg has regressed to a stubby proportion`);
    assert.ok(Math.abs(chain.bind.reduce((sum, angle) => sum + angle, 0)) < 0.08,
      `${recipe.id} ${end} pastern does not return toward vertical`);
  }
  assert.ok(recipe.gait.walkHz <= 1.1 && recipe.gait.runHz <= 2.05,
    `${recipe.id} cadence is too frantic`);
  assert.ok(recipe.gait.dutyFactor >= 0.65 && recipe.gait.dutyFactor <= 0.72,
    `${recipe.id} walk lacks a stable mammalian stance duty factor`);
  assert.ok(Number.isFinite(recipe.headPitch) && Number.isFinite(recipe.earAngle)
    && Number.isFinite(recipe.torsoY), `${recipe.id} lacks authored orthographic offsets`);
  assert.ok(recipe.leg.front.stagger >= 0 && recipe.leg.hind.stagger >= 0,
    `${recipe.id} lacks a stable planted stance`);

  for (const speed of [0, 0.2, 0.55, 1]) {
    const pose = quadrupedPose(recipe, 12.345, speed, { seedPhase: 0.3 });
    assert.ok(Number.isFinite(pose.rootBob) && Number.isFinite(pose.bodyPitch));
    assert.deepEqual(Object.keys(pose.legs), LEG_ORDER);
    for (const leg of Object.values(pose.legs)) {
      assert.ok(Object.values(leg).every(Number.isFinite), `${recipe.id} emitted a non-finite gait pose`);
      assert.ok('pasternX' in leg, `${recipe.id} gait omitted pastern articulation`);
    }
  }

  const period = 1 / recipe.gait.walkHz;
  const a = quadrupedPose(recipe, 1.7, 1 / 3);
  const b = quadrupedPose(recipe, 1.7 + period / (0.72 + (1 / 3) * 0.72), 1 / 3);
  assert.ok(Math.abs(a.legs.frontLeft.upperX - b.legs.frontLeft.upperX) < 1e-9,
    `${recipe.id} walk cycle does not loop cleanly`);
  const timing = quadrupedTiming(recipe, 0.42);
  assert.ok(Math.abs(timing.dutyFactor - recipe.gait.dutyFactor) < 1e-9,
    `${recipe.id} walk timing ignored authored duty factor`);
}

const lateralSequence = [
  [0.00, 'hindRight'],
  [0.25, 'frontRight'],
  [0.50, 'hindLeft'],
  [0.75, 'frontLeft'],
];
for (const [phase, expected] of lateralSequence) {
  const pose = quadrupedPose(ANIMAL_RECIPES.whitetail, 0, 0.42, { phaseOverride: phase });
  const liftOff = LEG_ORDER.reduce((best, name) => (
    pose.legs[name].phase < pose.legs[best].phase ? name : best
  ), LEG_ORDER[0]);
  assert.equal(liftOff, expected, `walk phase ${phase} broke lateral-sequence footfalls`);
}

for (const recipe of Object.values(ANIMAL_RECIPES)) {
  for (const end of ['front', 'hind']) {
    const chain = recipe.leg[end];
    const target = forwardKinematics2D(chain.lengths, chain.bind);
    const solved = solveThreeLinkIK(
      chain.lengths,
      target.forward,
      target.down,
      chain.bind.map((angle, index) => angle + (index === 0 ? 0.08 : -0.04)),
      quadrupedLegLimits(end === 'front'),
    );
    // Convergence tolerance scales with chain reach: CCD needs a few more
    // iterations per metre, and a 0.5% miss is invisible at any leg length.
    const reach = chain.lengths.reduce((sum, length) => sum + length, 0);
    assert.ok(solved.error < Math.max(0.007, reach * 0.005),
      `${recipe.id} ${end} IK missed by ${solved.error}m`);
  }
}

const frontLimits = quadrupedLegLimits(true);
const hindLimits = quadrupedLegLimits(false);
assert.ok(frontLimits[1][1] <= 0.12, 'front elbow can hyperextend into a forward bend');
assert.ok(hindLimits[1][0] >= 0, 'hind hock can hyperextend into a backward bend');
assert.ok(frontLimits[0][1] >= 1.3 && hindLimits[0][1] >= 1.2,
  'upper limbs cannot protract far enough for a long stride');

const walkPrediction = predictiveFootholdDistance(0.8, 0.28, 0.62, 1.2, 0);
const fleePrediction = predictiveFootholdDistance(3.0, 0.19, 0.25, 1.2, 1);
assert.ok(fleePrediction > walkPrediction * 1.35,
  'fleeing foothold did not unlock a substantially longer stride');
assert.ok(fleePrediction <= 1.2 * 0.72 + 1e-9, 'foothold exceeded anatomical reach cap');

const walkPeak = quadrupedPose(ANIMAL_RECIPES.whitetail, 0, 0.42, { phaseOverride: 0 }).rootBob;
const fleePose = quadrupedPose(ANIMAL_RECIPES.whitetail, 0, 1, { phaseOverride: 0 });
const fleePeak = fleePose.rootBob;
assert.ok(fleePeak > walkPeak * 2.4, 'fleeing trot lacks an aerial root pulse');
assert.ok(fleePose.swingPortion > 0.5, 'fleeing trot has no diagonal suspension interval');
assert.equal(Object.values(fleePose.legs).filter((leg) => leg.phase < fleePose.swingPortion).length, 4,
  'aerial transition does not release both diagonal pairs');

const foxGallop = quadrupedPose(ANIMAL_RECIPES.fox, 0, 1, { phaseOverride: 0.25 });
const deerTrot = quadrupedPose(ANIMAL_RECIPES.whitetail, 0, 1, { phaseOverride: 0.25 });
assert.equal(foxGallop.gaitClass, 'canid');
assert.equal(deerTrot.gaitClass, 'ungulate');
assert.ok(Math.abs(foxGallop.legs.hindLeft.phase - foxGallop.legs.hindRight.phase) > 0.04,
  'canid gallop lost its hind lead-lag sequence');
assert.ok(Math.abs(foxGallop.spineFlex) > Math.abs(deerTrot.spineFlex) * 3,
  'fox gait did not receive class-specific spinal flexion');
assert.ok(foxGallop.runReach > deerTrot.runReach,
  'canid gait did not receive its longer running reach');

const foot = createReactiveFootState(0.8);
advanceReactiveFoot(foot, [0, 0, 0], 0.8, 0);
advanceReactiveFoot(foot, [0.24, 0, 0], 0.05, 0.05, {
  stepDuration: 0.25, stepHeight: 0.12, triggerDistance: 0.08,
});
assert.equal(foot.swinging, true, 'reactive foot did not begin a needed step');
assert.ok(foot.position[1] > 0, 'reactive foot swing has no clearance arc');
for (let i = 0; i < 5; i++) {
  advanceReactiveFoot(foot, [0.30, 0, 0], 0.18, 0.05, {
    stepDuration: 0.25, stepHeight: 0.12, triggerDistance: 0.08,
  });
}
assert.equal(foot.swinging, false, 'reactive foot never planted');
const planted = foot.position.slice();
advanceReactiveFoot(foot, [0.42, 0, 0], 0.75, 0.05, {
  stepDuration: 0.25, stepHeight: 0.12, triggerDistance: 0.08,
});
assert.deepEqual(foot.position, planted, 'stance foot slid instead of staying planted');

const trailingFoot = createReactiveFootState(0.8);
advanceReactiveFoot(trailingFoot, [0, 0, 0], 0.8, 0);
advanceReactiveFoot(trailingFoot, [0.75, 0, 0], 0.82, 0.02, {
  swingWindow: 0.31,
  triggerDistance: 0.08,
  emergencyDistance: 0.24,
  criticalDistance: 0.42,
});
assert.equal(trailingFoot.swinging, true,
  'critically trailing hoof waited for the next gait window and dragged');

const uphillFoot = createReactiveFootState(0.8);
const uphillTerrain = (_x, z) => z * 0.45;
advanceReactiveFoot(uphillFoot, [0, 0, 0], 0.8, 0, {
  swingWindow: 0.31, terrainHeight: uphillTerrain,
});
for (let i = 0; i < 10; i++) {
  advanceReactiveFoot(uphillFoot, [0, 0.45, 1], 0.05, 0.04, {
    swingWindow: 0.31,
    stepDuration: 0.4,
    stepHeight: 0.10,
    triggerDistance: 0.05,
    terrainHeight: uphillTerrain,
  });
  assert.ok(uphillFoot.position[1] + 1e-9 >= uphillTerrain(0, uphillFoot.position[2]),
    'uphill hoof path intersected the terrain envelope');
}

const spring = { value: 0, velocity: 0 };
for (let i = 0; i < 180; i++) springStep(spring, 1, 1 / 60);
assert.ok(Math.abs(spring.value - 1) < 0.01, 'secondary-motion spring did not converge');

console.log('animals PASS · 3 recipes · planted-foot IK gait · SDF rope-ready secondary motion');
