import assert from 'node:assert/strict';
import { ANIMAL_RECIPES, animalBindDimensions, LEG_ORDER } from '../src/animaldata.mjs';
import { quadrupedPose } from '../src/animalgait.mjs';

// --- absolute scale against real animals -------------------------------------
// Shoulder height, torso length and tail length in metres. Ranges are the
// published spans for adult animals, so a recipe drifting out of them is a real
// proportion error rather than a style choice.
const REAL = {
  whitetail: { shoulder: [0.80, 1.06], torsoRatio: [1.10, 1.40], tail: [0.20, 0.35] },
  fox: { shoulder: [0.35, 0.52], torsoRatio: [1.20, 1.55], tail: [0.30, 0.56] },
  moose: { shoulder: [1.40, 2.10], torsoRatio: [1.15, 1.50], tail: [0.05, 0.25] },
  // A riding horse stands 14–17 hands (1.42–1.73 m) and is famously "square":
  // its body is about as long as it is tall. The tail range is the visible
  // fall of hair, not the dock, which is why it dwarfs the moose's stub.
  horse: { shoulder: [1.35, 1.78], torsoRatio: [1.10, 1.40], tail: [0.60, 1.20] },
};

for (const recipe of Object.values(ANIMAL_RECIPES)) {
  const spec = REAL[recipe.id];
  assert.ok(spec, `no reference range for ${recipe.id}`);
  const dims = animalBindDimensions(recipe);
  const [sLo, sHi] = spec.shoulder;
  assert.ok(dims.shoulderY >= sLo && dims.shoulderY <= sHi,
    `${recipe.id} shoulder height ${dims.shoulderY.toFixed(2)}m outside ${sLo}-${sHi}m`);
  const ratio = recipe.body[2] / dims.shoulderY;
  const [rLo, rHi] = spec.torsoRatio;
  assert.ok(ratio >= rLo && ratio <= rHi,
    `${recipe.id} torso/shoulder ${ratio.toFixed(2)} outside ${rLo}-${rHi} (too leggy or too long)`);
  const [tLo, tHi] = spec.tail;
  assert.ok(recipe.tail.length >= tLo && recipe.tail.length <= tHi,
    `${recipe.id} tail ${recipe.tail.length.toFixed(2)}m outside ${tLo}-${tHi}m`);
  // No animal's tail is as thick as its own body.
  assert.ok(recipe.tail.radius < recipe.body[0] * 0.75,
    `${recipe.id} tail radius ${recipe.tail.radius.toFixed(3)} is too thick for a ${recipe.body[0].toFixed(3)} body`);
  // Hind limbs are the drive train and run longer than the forelimbs.
  const front = recipe.leg.front.lengths.reduce((a, b) => a + b, 0);
  const hind = recipe.leg.hind.lengths.reduce((a, b) => a + b, 0);
  assert.ok(hind > front, `${recipe.id} hind limb should exceed the fore limb`);
}

// --- fox head ------------------------------------------------------------------
// The skull is small and fine-boned, the muzzle a tapering wedge rather than a
// tube. Nose position is authored in the renderer (see the fox branch of the
// head build), so the literal is mirrored here to guard the overall length.
{
  const fox = ANIMAL_RECIPES.fox;
  const dims = animalBindDimensions(fox);
  const s = fox.scale ?? 1;
  const FOX_NOSE_Z = 0.297;      // renderer literal, in pre-scale units
  const FOX_NOSE_R = 0.042;
  const craniumBack = (0.05 - (fox.head[2] / s) * 0.50) * s;
  const headLength = (FOX_NOSE_Z + FOX_NOSE_R) * s - craniumBack;
  const ratio = headLength / dims.shoulderY;
  assert.ok(ratio > 0.38 && ratio < 0.54,
    `fox head is ${ratio.toFixed(2)}x shoulder height; the sheet shows ~0.45`);
  const heightRatio = (fox.head[1] * 2) / dims.shoulderY;
  assert.ok(heightRatio > 0.22 && heightRatio < 0.36,
    `fox head height ${heightRatio.toFixed(2)}x shoulder height is out of range`);
  // The skull must stay clearly narrower than the chest.
  assert.ok(fox.head[0] * 2 < fox.body[0] * 2 * 0.75,
    'fox head should be much narrower than its body');
  // A visible neck: longer than the skull is wide, and not as thick as it.
  const neckLength = fox.neck.lengths[0] + fox.neck.lengths[1];
  assert.ok(neckLength > fox.head[0] * 2,
    'fox neck is too short to read as a neck');
  assert.ok(fox.neck.radii[0] < fox.head[0],
    'fox neck should be slimmer than the skull is wide');
}

// --- whitetail head, ears and torso masses ------------------------------------
{
  const deer = ANIMAL_RECIPES.whitetail;
  const dims = animalBindDimensions(deer);
  const s = deer.scale ?? 1;
  const NOSE_Z = 0.337, NOSE_R = 0.034;   // renderer literals, pre-scale units
  const craniumBack = (0.05 - (deer.head[2] / s) * 0.50) * s;
  const headLength = (NOSE_Z + NOSE_R) * s - craniumBack;
  // Art-directed larger than the sheet's ~0.33 so the head reads at distance;
  // this is a guard against it drifting back to a nub or to the old
  // near-double-length snout, not a match to the reference.
  const ratio = headLength / dims.shoulderY;
  assert.ok(ratio > 0.26 && ratio < 0.46,
    `whitetail head is ${ratio.toFixed(2)}x shoulder height, well outside the workable band`);
  // The skull is a long wedge, not a tall egg.
  assert.ok(deer.head[2] * 0.5 > deer.head[1],
    'whitetail cranium should be longer than it is tall');
  // Skull mass is art-directed deliberately larger than life so the head reads
  // at distance, so this is a sanity bound rather than an anatomical range:
  // big enough not to be a nub, never wider than the animal's own body.
  assert.ok(deer.head[0] * 2 > 0.12, 'whitetail skull has shrunk to a nub');
  assert.ok(deer.head[0] < deer.body[0],
    'whitetail skull should not be wider than its body');
  assert.ok(deer.ear[1] > 0.13 && deer.ear[1] < 0.19,
    `whitetail ear ${deer.ear[1].toFixed(3)}m is unrealistic`);
  assert.ok(deer.neck.radii[0] * 2 < 0.24,
    'whitetail throat is ballooned');
}

// Chest and rump are masses WITHIN the torso, not spheres bulging out of it.
// A little rise is right — a fox's shoulder ruff, and a moose's pronounced
// withers hump — but a chest standing far proud of the back reads as a balloon.
for (const recipe of Object.values(ANIMAL_RECIPES)) {
  assert.ok(recipe.chest[1] <= recipe.body[1] * 1.35,
    `${recipe.id} chest (${recipe.chest[1]}) balloons above its torso (${recipe.body[1]})`);
  assert.ok(recipe.rump[1] <= recipe.body[1] * 1.15,
    `${recipe.id} rump (${recipe.rump[1]}) balloons above its torso (${recipe.body[1]})`);
  // The haunch is the widest point of a quadruped, ahead of the chest.
  assert.ok(recipe.rump[0] >= recipe.chest[0],
    `${recipe.id} rump should be at least as wide as the chest`);
}
// The whitetail's barrel is level-backed: this is the balloon that was fixed.
assert.ok(ANIMAL_RECIPES.whitetail.chest[1] <= ANIMAL_RECIPES.whitetail.body[1],
  'whitetail chest must not stand above the back line');

// Species must remain correctly sized RELATIVE to each other: a fox is roughly
// a quarter of a moose at the shoulder, a whitetail about half.
const shoulder = Object.fromEntries(Object.values(ANIMAL_RECIPES)
  .map((r) => [r.id, animalBindDimensions(r).shoulderY]));
assert.ok(shoulder.fox < shoulder.whitetail * 0.62,
  `fox (${shoulder.fox.toFixed(2)}m) is too large next to the whitetail`);
assert.ok(shoulder.whitetail < shoulder.moose * 0.66,
  `whitetail (${shoulder.whitetail.toFixed(2)}m) is too large next to the moose`);

// --- footfall sequences -------------------------------------------------------
const ABBR = { frontLeft: 'LF', frontRight: 'RF', hindLeft: 'LH', hindRight: 'RH' };

/** Legs in the order they begin their swing over one stride. */
function footfallOrder(recipe, speed01) {
  const pose = quadrupedPose(recipe, 0, speed01, { phaseOverride: 0 });
  return LEG_ORDER
    .map((name) => ({ name, at: (1 - pose.legs[name].phase) % 1 }))
    .sort((a, b) => a.at - b.at)
    .map((entry) => ABBR[entry.name]);
}

/** Rotate a cycle so it starts at `first`. */
function rotateTo(order, first) {
  const i = order.indexOf(first);
  return order.slice(i).concat(order.slice(0, i));
}

for (const recipe of Object.values(ANIMAL_RECIPES)) {
  // Lateral-sequence walk: each fore follows the hind on the SAME side.
  const walk = rotateTo(footfallOrder(recipe, 0.42), 'RH');
  assert.deepEqual(walk, ['RH', 'RF', 'LH', 'LF'],
    `${recipe.id} walk is not a lateral-sequence footfall: ${walk.join(' ')}`);
}

// Ungulates trot: diagonal pairs move together.
const trot = quadrupedPose(ANIMAL_RECIPES.whitetail, 0, 1, { phaseOverride: 0 });
assert.ok(Math.abs(trot.legs.frontLeft.phase - trot.legs.hindRight.phase) < 0.02,
  'trot lost the FL/HR diagonal pair');
assert.ok(Math.abs(trot.legs.frontRight.phase - trot.legs.hindLeft.phase) < 0.02,
  'trot lost the FR/HL diagonal pair');

// Canids gallop ROTARY: hinds land as a pair, then the fores in the opposite
// left/right order, so the footfalls sweep around the body one way.
const gallop = rotateTo(footfallOrder(ANIMAL_RECIPES.fox, 1), 'LH');
assert.deepEqual(gallop, ['LH', 'RH', 'RF', 'LF'],
  `fox gallop is not rotary: ${gallop.join(' ')}`);

// --- vertical rhythm ----------------------------------------------------------
// Sample the body bob across a stride; a trot peaks twice, a gallop once.
function bobPeaks(recipe, speed01) {
  const at = (p) => quadrupedPose(recipe, 0, speed01, { phaseOverride: p }).rootBob;
  const peak = Math.max(at(0), at(0.5));
  if (peak <= 1e-9) return 0;
  return at(0.5) / peak > 0.85 ? 2 : 1;
}
assert.equal(bobPeaks(ANIMAL_RECIPES.whitetail, 1), 2,
  'a trot must lift the body twice per stride (one per diagonal support)');
assert.equal(bobPeaks(ANIMAL_RECIPES.fox, 1), 1,
  'a gallop must lift the body once per stride, over its single suspension');
assert.equal(bobPeaks(ANIMAL_RECIPES.fox, 0.42), 2,
  'a walking fox still has a two-beat vertical rhythm');

// --- fore/hind duty split -----------------------------------------------------
// Forelimbs carry the greater share of weight and stay planted longer.
for (const recipe of Object.values(ANIMAL_RECIPES)) {
  const pose = quadrupedPose(recipe, 0, 0.42, { phaseOverride: 0 });
  const foreDuty = 1 - pose.legs.frontLeft.swingPortion;
  const hindDuty = 1 - pose.legs.hindLeft.swingPortion;
  assert.ok(foreDuty > hindDuty,
    `${recipe.id} forelimb duty ${foreDuty.toFixed(3)} should exceed hind ${hindDuty.toFixed(3)}`);
  // The split is a nuance, not a limp.
  assert.ok(foreDuty - hindDuty < 0.12, `${recipe.id} fore/hind duty split is exaggerated`);
  // Left and right of the same pair stay symmetrical.
  assert.equal(pose.legs.frontLeft.swingPortion, pose.legs.frontRight.swingPortion);
  assert.equal(pose.legs.hindLeft.swingPortion, pose.legs.hindRight.swingPortion);
}

const foxDims = animalBindDimensions(ANIMAL_RECIPES.fox);
const deerDims = animalBindDimensions(ANIMAL_RECIPES.whitetail);
const mooseDims = animalBindDimensions(ANIMAL_RECIPES.moose);
console.log(`animalanatomy PASS · shoulder fox ${foxDims.shoulderY.toFixed(2)}m · deer ${deerDims.shoulderY.toFixed(2)}m · moose ${mooseDims.shoulderY.toFixed(2)}m · rotary gallop · 1-beat gallop bob`);
