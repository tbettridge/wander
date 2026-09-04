// Whether the village generator makes places, or variations on one place.
//
// These are distribution tests. Each one runs over a cohort of villages built
// from fixed world seeds, and asserts on its tails rather than its averages:
// the nearest pair of look-alike households, the closest pair of villages, the
// distance between how a trading family dresses its home and how a farming one
// does. A mean stays comfortable while two places out of thirty are twins, and
// the twins are what a player walking between them sees.
//
// Two assertions here record a gap rather than guard a guarantee, and say so.
// A suite that is red by default stops being read, so a known shortfall is
// pinned at its measured value: the number cannot drift in either direction
// without a test failing and someone deciding which way it went.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cohortIntegrity, distinctCohort, generateSettlementCohort,
} from '../src/settlementcohort.mjs';
import {
  AUTHORED_CHANNEL_SIZES, PROFILE_CHANNELS, SETTLEMENT_DESIGN_BUDGETS,
  SETTLEMENT_DESIGN_TARGETS, measureCohortIdentity, measureHouseholdRepetition,
  measureOccupationCoupling, measureSignatureCollapse, normalizedEntropy,
  totalVariation, validateSettlementDesignGates,
} from '../src/settlementdesign.mjs';

// One cohort for the file. Six worlds is about two and a half seconds, which is
// affordable once and not thirty times.
const cohort = generateSettlementCohort();
const distinct = distinctCohort(cohort);
const verdict = validateSettlementDesignGates(cohort);

// --- the statistics themselves ------------------------------------------------

test('total variation separates identical distributions from disjoint ones', () => {
  assert.equal(totalVariation(['a', 'b'], ['a', 'b']), 0);
  assert.equal(totalVariation(['a', 'a'], ['b', 'b']), 1);
  // Half the population moved, so half the mass has to travel.
  assert.equal(totalVariation(['a', 'b'], ['a', 'a']), 0.5);
});

test('normalized entropy scores against the smaller of catalog and sample', () => {
  assert.equal(normalizedEntropy(['a', 'a', 'a'], 4), 0);
  // Four households using four options evenly is full use of the catalog.
  assert.equal(normalizedEntropy(['a', 'b', 'c', 'd'], 4), 1);
  // Two households cannot use four options evenly, and are not marked down for
  // it: the ceiling is the sample, not the catalog.
  assert.equal(normalizedEntropy(['a', 'b'], 4), 1);
});

// --- the cohort is a fair sample ----------------------------------------------

test('the cohort spans several worlds and every village carries a plan', () => {
  const integrity = cohortIntegrity(cohort);
  assert.equal(integrity.worlds, 6);
  assert.ok(cohort.length >= 25, `thin cohort: ${cohort.length}`);
  for (const plan of cohort) {
    assert.ok(plan.buildings.length > 0, `empty plan ${plan.id}`);
    assert.ok(plan.familyFrontageProfiles.length > 0, `no households in ${plan.id}`);
  }
});

// A GAP, pinned rather than guarded.
//
// A settlement's seed comes from the railway index signature's string LENGTH
// rather than its content, so every world whose signature is the same number of
// characters gets the same five villages. Across twenty-four surveyed worlds the
// length takes two values, which is why thirty villages here carry thirteen
// identities between them. Hashing the signature instead would fix it, and would
// also change every village in every existing world, so the change belongs to
// whoever owns the save format rather than to this test.
test('KNOWN GAP: settlement seeds collide across worlds', () => {
  const integrity = cohortIntegrity(cohort);
  assert.equal(integrity.villages, 30);
  assert.equal(integrity.distinctIdentities, 13);
  assert.ok(!verdict.sample.valid, 'the sample gate should be reporting this');
  // Whichever way this moves, someone should look.
  assert.ok(
    integrity.distinctIdentities < SETTLEMENT_DESIGN_BUDGETS.minDistinctShare * integrity.villages,
    'seed collisions have changed — re-measure and re-pin',
  );
});

test.todo('settlement seeds hash the railway signature rather than its length');

// --- station 1: look-alike households do not stand together --------------------

test('look-alike households keep the frontage planner nearby radius apart', () => {
  for (const plan of distinct) {
    const entry = measureHouseholdRepetition(plan);
    if (entry.households < 2 || !Number.isFinite(entry.nearestTwinDistance)) continue;
    assert.ok(
      entry.nearestTwinDistance >= SETTLEMENT_DESIGN_BUDGETS.minTwinSeparationM,
      `${entry.settlementId}: twins ${entry.nearestTwinDistance.toFixed(1)}m apart`,
    );
  }
});

test('household channels come out more varied than chance, not less', () => {
  for (const plan of distinct) {
    const entry = measureHouseholdRepetition(plan);
    if (entry.households < 2) continue;
    // The nearby-repetition avoidance is supposed to push households apart in
    // channel space. If agreement ever rises to chance it has stopped working,
    // and the villages are back to being hashed rather than arranged.
    assert.ok(
      entry.excessAgreement <= SETTLEMENT_DESIGN_BUDGETS.maxExcessAgreement,
      `${entry.settlementId}: agreement ${entry.excessAgreement.toFixed(3)} over chance`,
    );
  }
});

test('every channel catalog is used, and none of them is deep', () => {
  for (const plan of distinct) {
    const entry = measureHouseholdRepetition(plan);
    if (entry.households < 4) continue;
    assert.ok(
      entry.meanChannelEntropy >= SETTLEMENT_DESIGN_BUDGETS.minChannelEntropy,
      `${entry.settlementId}: entropy ${entry.meanChannelEntropy.toFixed(3)}`,
    );
  }
  // The companion fact, and the reason high entropy is not the same as high
  // variety: a village of twenty-six households draws its yards from three
  // options, so nine families share each. Even use of a small catalog still
  // reads as nine identical yards.
  for (const { channel } of PROFILE_CHANNELS) {
    assert.ok(AUTHORED_CHANNEL_SIZES[channel] > 0, `no catalog for ${channel}`);
  }
  assert.ok(
    Math.min(...Object.values(AUTHORED_CHANNEL_SIZES)) <= 3,
    'catalogs have grown — the entropy floor is now worth raising',
  );
});

// --- station 2: villages differ from each other --------------------------------

test('the closest pair of distinct villages stays apart', () => {
  const identity = measureCohortIdentity(distinct);
  assert.ok(
    identity.minPairDistance >= SETTLEMENT_DESIGN_BUDGETS.minVillagePairDistance,
    `${identity.closestPair?.left} and ${identity.closestPair?.right} `
    + `differ by ${identity.minPairDistance.toFixed(3)}`,
  );
  // A failure has to be able to name its cause, or nobody can act on it.
  assert.ok(identity.closestPair.components.programMix >= 0);
  assert.ok(identity.closestPair.components.channelMix >= 0);
  assert.ok(identity.closestPair.components.style >= 0);
  assert.ok(identity.closestPair.components.form >= 0);
});

test.todo(`closest village pair reaches ${SETTLEMENT_DESIGN_TARGETS.minVillagePairDistance}`);

// --- which axes of a village never move ----------------------------------------

// A GAP, pinned rather than guarded.
//
// Three of the five style flags hold one value across every village in the
// cohort: each has a porch, each has a chimney, none has an extension. They are
// authored as choices and generated as constants, so they cost a branch and buy
// nothing. Pinned rather than gated because whether an extension SHOULD ever
// appear is a design call, not this file's.
test('KNOWN GAP: three style axes never vary across the cohort', () => {
  const collapse = measureSignatureCollapse(distinct);
  assert.deepEqual(collapse.dead.sort(), ['style.chimney', 'style.extension', 'style.porch']);
  // The axes that do move, so a regression that flattens one is visible.
  assert.ok(collapse.axes['style.foundation'].distinct >= 2);
  assert.ok(collapse.axes['style.timberFrame'].distinct >= 2);
  assert.ok(collapse.axes.programRoster.distinct >= 4, 'village rosters have collapsed');
});

test.todo('porch, chimney and extension either vary by village or stop being style fields');

// --- station 3: does the dressing know what the family does? -------------------

test('trade buildings all carry their program service cue', () => {
  const coupling = measureOccupationCoupling(distinct);
  assert.ok(coupling.tradeBuildings > 0, 'no trade buildings in the cohort');
  assert.equal(coupling.serviceCueCoverage, SETTLEMENT_DESIGN_BUDGETS.minServiceCueCoverage);
});

// A GAP, pinned rather than guarded.
//
// A household's palette, yard, boundary, garden and materials are drawn from a
// hash of its ID with no reference to the trade it works, so a smith's family
// dresses its home from the same distribution as a farmer's. The raw distance
// between the two groups is not zero — no two finite samples are identical —
// which is exactly why the shuffled baseline is here. Where observed and
// shuffled agree, the visible difference is sample noise and nothing else.
test('KNOWN GAP: household dressing carries no information about trade', () => {
  const coupling = measureOccupationCoupling(distinct);
  assert.ok(coupling.tradeHouseholds > 30, `thin trade sample: ${coupling.tradeHouseholds}`);
  assert.ok(
    Math.abs(coupling.couplingExcess) < 0.02,
    `coupling has moved: observed ${coupling.householdCoupling.toFixed(3)}, `
    + `chance ${coupling.chanceCoupling.toFixed(3)}`,
  );
  assert.ok(
    coupling.householdCoupling > 0.05,
    'the raw figure should be visibly non-zero — that is the point of the baseline',
  );
});

test.todo(`household channels reach ${SETTLEMENT_DESIGN_TARGETS.minCouplingExcess} coupling excess over chance`);

// --- the gate as a whole --------------------------------------------------------

test('the design gate passes and reports what it measured', () => {
  assert.ok(verdict.passed, `design failures: ${verdict.failures.join('; ')}`);
  assert.equal(verdict.metrics.repetition.length, distinct.length);
  assert.ok(Number.isFinite(verdict.metrics.worstTwinSeparation));
  assert.ok(Number.isFinite(verdict.metrics.identity.minPairDistance));
  assert.ok(verdict.metrics.integrity.duplicateGroups.length > 0);
});

test('a cohort too small to compare is refused rather than scored', () => {
  const thin = validateSettlementDesignGates([distinct[0]]);
  assert.equal(thin.passed, false);
  assert.equal(thin.metrics, null);
});
