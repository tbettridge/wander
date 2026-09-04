// Whether a building reads as the thing it is.
//
// The distribution tests in settlementdesign ask whether villages differ from
// each other. These ask whether the buildings inside one differ from each
// other, and whether the differences mean anything: a barn that is a cottage
// with a bigger footprint is variety a player cannot use.
//
// Findings that record a gap are pinned at their measured value rather than
// left failing, on the same reasoning as the design suite. Whichever way a
// pinned number moves, a test fails and somebody decides which way it went.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILDING_PROGRAMS, createBuildingPlan } from '../src/buildingplan.mjs';
import {
  FRAME_POST_HALF_WIDTH, OPENING_KIND, openingSpecFor, planFramePosts, planOpenings,
} from '../src/buildingopenings.mjs';
import { distinctCohort, generateSettlementCohort } from '../src/settlementcohort.mjs';
import {
  ARCHITECTURE_BUDGETS, ARCHITECTURE_TARGETS, massIsBuried, massIsUnsupported,
  measureFabricCohesion, measureMassEmbodiment, measureMaterialLegibility,
  measureProgramLegibility, programSignature, validateArchitectureGates,
} from '../src/settlementarchitecture.mjs';

const plans = distinctCohort(generateSettlementCohort());
const legibility = measureProgramLegibility();
const embodiment = measureMassEmbodiment();

// --- the burial test itself ----------------------------------------------------

test('a mass inside its core is buried, and one beside it is not', () => {
  const core = { role: 'core', dx: 0, dz: 0, width: 10, depth: 8, height: 6, baseY: 0 };
  const inside = { role: 'stair', dx: 2, dz: 2, width: 1, depth: 1, height: 1, baseY: 0 };
  const beside = { role: 'wing', dx: 7, dz: 0, width: 4, depth: 4, height: 3, baseY: 0 };
  const above = { role: 'tower', dx: 0, dz: 0, width: 3, depth: 3, height: 9, baseY: 0 };
  assert.equal(massIsBuried(inside, core), true);
  assert.equal(massIsBuried(beside, core), false);
  // Taller than the core, so the part that shows is the part that matters.
  assert.equal(massIsBuried(above, core), false);
});

test('a slab at head height with nothing under it is unsupported', () => {
  const core = { role: 'core', dx: 0, dz: 0, width: 10, depth: 8, height: 3, baseY: 0 };
  const floating = { role: 'wing', dx: 0, dz: -9, width: 8, depth: 4, height: 0.3, baseY: 2.2 };
  const carried = { role: 'wing', dx: 0, dz: 0, width: 12, depth: 10, height: 0.3, baseY: 2.6 };
  assert.equal(massIsUnsupported(floating, [core, floating]), true);
  assert.equal(massIsUnsupported(carried, [core, carried]), false);
  // A spire is carried by its tower by design and is never counted.
  const spire = { role: 'spire', dx: 0, dz: 0, width: 2, depth: 2, height: 4, baseY: 9 };
  assert.equal(massIsUnsupported(spire, [core, spire]), false);
});

// --- embodiment ------------------------------------------------------------------

// A granary is the one building here that does not stand on the ground, and
// the gap of daylight under its floor is the whole silhouette. The stones were
// planned and the core was never lifted, so all four stood inside the building.
test('a granary stands on its staddle stones', () => {
  assert.equal(embodiment.byProgram.granary.buriedShare, 0);
  const plan = createBuildingPlan({ id: 'granary:lifted', program: 'granary', seed: 40503 });
  const core = plan.masses.find((item) => item.role === 'core');
  assert.ok(core.baseY > 0.5, 'the core is back on the ground');
  const stones = plan.masses.filter((item) => item.role === 'stair');
  // Six stones and a step up to the door, which is now a stride off the earth.
  assert.ok(stones.length >= 6, `only ${stones.length} supports`);
  for (const stone of stones.slice(0, 6)) {
    assert.ok(Math.abs(stone.height - core.baseY) < 0.2, 'a stone that does not reach the floor');
  }
});

test('nothing a program plans is invisible or held up by nothing', () => {
  for (const [program, entry] of Object.entries(embodiment.byProgram)) {
    assert.equal(entry.buriedShare, 0, `${program} buries masses inside its own core`);
    assert.equal(entry.unsupportedShare, 0, `${program} floats masses on nothing`);
  }
  assert.equal(embodiment.buriedShare, 0);
  assert.equal(embodiment.unsupportedShare, 0);
});

test('the shelters stand on something', () => {
  for (const program of ['station-house', 'market-hall', 'hall']) {
    const plan = createBuildingPlan({ id: `posts:${program}`, program, seed: 40503 });
    const plates = plan.masses.filter((item) => item.role === 'wing' && item.baseY > 1.6);
    if (!plates.length) continue;
    for (const plate of plates) {
      assert.equal(massIsUnsupported(plate, plan.masses), false, `${program} plate floats`);
    }
  }
});

// --- legibility --------------------------------------------------------------------

test('every program carries some massing of its own', () => {
  assert.deepEqual(legibility.programsWithNoMassing, []);
  for (const program of BUILDING_PROGRAMS) {
    const signature = programSignature(program, { samples: 40 });
    assert.ok(signature.height > 0 && signature.area > 0, `${program} has no measurable form`);
  }
});

// An inn and a hall used to be the same building at 0.048, separated only by
// one being reliably two storeys. A hall is now a single tall volume behind a
// portico, which is what a civic room actually is, and the pair sits at three
// times the distance. The closest pair is now two wide civic sheds, which is a
// fairer complaint and the next thing worth separating.
test('no two programs are near-indistinguishable', () => {
  const pair = legibility.closestPair;
  assert.ok(
    pair.distance >= ARCHITECTURE_BUDGETS.minProgramPairDistance,
    `${pair.left} and ${pair.right} have converged: ${pair.distance.toFixed(3)}`,
  );
  // The worst pair should be an outlier, not the norm.
  assert.ok(legibility.meanDistance > pair.distance * 2);
});

test('a dwelling and an inn are no longer the same building', () => {
  const pair = legibility.pairs.find(
    (entry) => [entry.left, entry.right].sort().join('/') === 'dwelling/inn',
  );
  // An inn was a cottage with a bigger footprint: same storey height, same
  // windows, the same optional wing at the same rate. It now has taller rooms
  // and always carries a stable range off the back.
  assert.ok(pair.distance > 0.13, `dwelling and inn at ${pair.distance.toFixed(3)}`);
  const inn = legibility.signatures.find((entry) => entry.program === 'inn');
  const dwelling = legibility.signatures.find((entry) => entry.program === 'dwelling');
  assert.ok(inn.height > dwelling.height + 1.5, 'an inn is not built taller than a house');
  assert.ok((inn.roles['lean-to'] || 0) > 0.9, 'an inn without its stable range');
});

test('an inn and a hall are no longer the same building', () => {
  const pair = legibility.pairs.find(
    (entry) => [entry.left, entry.right].sort().join('/') === 'hall/inn',
  );
  assert.ok(pair.distance > 0.12, `inn and hall at ${pair.distance.toFixed(3)}`);
  // A hall is one tall room built of better stuff; an inn is two domestic
  // storeys. Height alone would not do it, since an inn is the taller of the
  // two overall — it is height PER STOREY that reads as civic.
  const hall = legibility.signatures.find((entry) => entry.program === 'hall');
  const inn = legibility.signatures.find((entry) => entry.program === 'inn');
  assert.ok(hall.stoneShare > inn.stoneShare + 0.2, 'a hall is built of better stuff');
  assert.ok(hall.roles.wing > 0.9, 'a hall has its stair bay');
  // And they are lit differently: a civic room takes tall windows, an inn
  // domestic ones at a larger scale.
  assert.equal(hall.openingKind, OPENING_KIND.tall);
  assert.equal(inn.openingKind, OPENING_KIND.domestic);
});

test.todo(`the closest program pair reaches ${ARCHITECTURE_TARGETS.minProgramPairDistance}`);

test('the working buildings stay distinguishable from the civic ones', () => {
  // A church must not collapse into anything: it is the one building a village
  // is read by from outside it.
  const churchPairs = legibility.pairs.filter((pair) => pair.left === 'church' || pair.right === 'church');
  const nearest = churchPairs[0];
  assert.ok(nearest.distance > 0.2, `church is close to ${nearest.left}/${nearest.right}`);
});

// --- what a wall says ------------------------------------------------------------

// Found by looking at a render, not by any measure here: every timber-framed
// building had a post at x = 0 running the full height of its front wall, and
// the front door is at x = 0. A beam across the way in, on every framed
// building in every village, invisible to a suite that only counted things.
test('no frame post ever stands across a doorway', () => {
  for (const program of BUILDING_PROGRAMS) {
    for (let index = 0; index < 40; index++) {
      const plan = createBuildingPlan({ id: `post:${program}:${index}`, program, seed: 11 + index * 7919 });
      const door = plan.portals.find((portal) => portal.kind === 'exterior-door');
      for (const x of planFramePosts(plan, plan.width)) {
        const clearance = Math.abs(x - door.x) - FRAME_POST_HALF_WIDTH - door.width / 2;
        assert.ok(clearance > 0, `${program}: post ${x.toFixed(2)} crosses a door ${door.width}m wide`);
      }
    }
  }
});

test('a frame stands at the corners and at the jambs', () => {
  const plan = createBuildingPlan({ id: 'post:frame', program: 'dwelling', seed: 40503 });
  const posts = planFramePosts(plan, plan.width);
  assert.equal(posts.length, 4, 'two corners and two jambs');
  assert.ok(posts[0] < -plan.width / 2 + 0.2, 'no post at the left corner');
  assert.ok(posts[3] > plan.width / 2 - 0.2, 'no post at the right corner');
});

test('a working building is not glazed like a house', () => {
  for (const program of ['barn', 'granary', 'smithy', 'market-hall']) {
    const plan = createBuildingPlan({ id: `wall:${program}`, program, seed: 40503 });
    const openings = planOpenings(plan, plan.width);
    assert.ok(openings.length > 0, `${program} has no openings at all`);
    for (const opening of openings) {
      assert.equal(opening.glazed, false, `${program} hangs a window frame in a ${opening.kind}`);
    }
  }
});

test('a granary is vented and a forge has a mouth', () => {
  const granary = createBuildingPlan({ id: 'wall:granary', program: 'granary', seed: 40503 });
  for (const opening of planOpenings(granary, granary.width)) {
    assert.equal(opening.kind, OPENING_KIND.slit);
    // Narrow enough to keep a rat out, high enough to keep damp off the grain.
    assert.ok(opening.width < 0.5, `slit ${opening.width.toFixed(2)}m wide`);
    assert.ok(opening.bottom > 1.2, `slit sill at ${opening.bottom.toFixed(2)}m`);
  }
  const smithy = createBuildingPlan({ id: 'wall:smithy', program: 'smithy', seed: 40503 });
  const forge = planOpenings(smithy, smithy.width);
  assert.ok(forge.length >= 1, 'a smithy with no forge mouth');
  assert.ok(forge[0].width > 2, `forge mouth only ${forge[0].width.toFixed(2)}m`);
  // Off-centre, or the doorway swallows it and every smithy comes out blank.
  assert.ok(Math.abs(forge[0].x) > 1, 'the forge mouth is on the doorway');
});

test('every program has its own opening vocabulary', () => {
  const kinds = new Map();
  for (const program of BUILDING_PROGRAMS) {
    const plan = createBuildingPlan({ id: `vocab:${program}`, program, seed: 7919 });
    const openings = planOpenings(plan, plan.width);
    const kind = openings[0]?.kind || OPENING_KIND.none;
    kinds.set(kind, [...(kinds.get(kind) || []), program]);
  }
  // Five distinct vocabularies across eleven programs. Not one each — a
  // dwelling and a station house SHOULD be lit the same way — but enough that
  // a wall is evidence rather than decoration.
  assert.ok(kinds.size >= 5, `only ${kinds.size} vocabularies: ${[...kinds.keys()].join(', ')}`);
  assert.ok(!kinds.has(OPENING_KIND.none), 'a program with no openings at all');
  // A workshop differs from itself between floors: a working mouth at street
  // level, ordinary windows over it where somebody lives.
  assert.notEqual(
    openingSpecFor('workshop', 0).kind,
    openingSpecFor('workshop', 1).kind,
  );
});

// --- cohesion ------------------------------------------------------------------------

test('a village commits to its own fabric more than a coin flip would', () => {
  const cohesion = measureFabricCohesion(plans);
  assert.ok(
    cohesion.meanCommitment >= ARCHITECTURE_BUDGETS.minFabricCommitment,
    `fabric commitment ${cohesion.meanCommitment.toFixed(3)}`,
  );
  // And the weakest village is the one worth watching, not the average.
  assert.ok(cohesion.weakest.commitment >= 0.1, `${cohesion.weakest.settlementId} is an even scatter`);
});

// Wall and roof used to be drawn per building from one village bias whatever
// the building was for, so a church was as likely to be plaster and thatch as a
// cottage and material told the player nothing. Programs now shift that bias,
// and the shuffled baseline is what proves the difference is real rather than
// two finite samples differing the way finite samples do.
test('material says what a building is for', () => {
  const material = measureMaterialLegibility(plans);
  assert.ok(material.civicBuildings > 20, `thin civic sample: ${material.civicBuildings}`);
  assert.ok(
    material.excess >= ARCHITECTURE_BUDGETS.minMaterialExcess,
    `material legibility ${material.excess.toFixed(4)}: observed ${material.observed.toFixed(4)}, `
    + `chance ${material.chance.toFixed(4)}`,
  );
});

test('a church is stone and a barn is not, wherever it stands', () => {
  const stoneShare = (program) => {
    const signature = legibility.signatures.find((entry) => entry.program === program);
    return signature.stoneShare;
  };
  assert.ok(stoneShare('church') > 0.85, 'churches are not reliably stone');
  assert.ok(stoneShare('barn') < 0.3, 'barns are too grand');
  assert.ok(stoneShare('hall') > stoneShare('dwelling') + 0.2);
});

// --- the gate as a whole ----------------------------------------------------------------

test('the architecture gate reports every station it ran', () => {
  const verdict = validateArchitectureGates(plans);
  assert.ok(verdict.metrics.legibility.pairs.length > 40);
  assert.ok(verdict.metrics.embodiment.byProgram.granary);
  assert.ok(verdict.metrics.cohesion.villages.length === plans.length);
  assert.ok(Number.isFinite(verdict.metrics.material.excess));
  assert.equal(verdict.passed, true, `architecture failures: ${verdict.failures.join('; ')}`);
});
