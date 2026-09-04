// Whether a cohort of villages is various, or only randomised.
//
// Every station here measures a DISTRIBUTION, never a village. "Does this place
// feel unique" is not a question one sample can answer — uniqueness is a
// between-sample property, and a village is only same-ish relative to the
// others the same generator produced. So the unit of measurement is a cohort of
// seeds, and the numbers that matter are its TAILS: the closest pair of
// villages, the nearest pair of identical households. Averages stay comfortable
// while two places out of thirty are twins, and the twins are what a player
// walking between them actually notices.
//
// The second rule is that variety must be CAUSED. Any spread metric is
// satisfiable with noise, and an optimiser handed a spread target will find
// that immediately — but noise reads as chaos, not character. So every spread
// measure here is paired with a coupling measure asking whether the variation
// traces back to something the world already knows: which household, which
// trade it works, which program the building runs. A cohort scoring well on
// spread and zero on coupling is randomised, not lived in, and the pair of
// numbers says so where either alone would not.
//
// Renderer-independent. This reads plan data only, so the Node suite audits it
// directly and a lab page could show the same figures live.

import { FAMILY_FRONTAGE_VISUAL_OPTIONS } from './settlementfrontagecatalog.mjs';
import { FAMILY_OWNED_PROGRAMS } from './familyfrontage.mjs';
import { mulberry32 } from './noise.js';

/**
 * What makes two villages the same village.
 *
 * A plan is a pure function of the site seed and the settlement kind, so a pair
 * sharing both is one village generated twice however far apart the two stand.
 * Settlement IDs are per-world and collide across worlds, which is why they are
 * no use as an identity here.
 */
export function settlementIdentity(plan) {
  return `${plan.site?.seed ?? 'none'}:${plan.site?.kind ?? 'none'}`;
}

/** A label that stays unique across a cohort, unlike the per-world plan ID. */
export function cohortLabel(plan) {
  return `${plan.site?.worldSeed ?? '?'}/${plan.site?.id ?? plan.id ?? 'unknown'}`;
}

/**
 * The household-identity channels, paired with the profile field each is
 * stored in. Deliberately only the seven profile channels: the per-building
 * application channels are chosen from the building's program rather than from
 * the family, so they belong to the coupling station, not the spread one.
 */
export const PROFILE_CHANNELS = Object.freeze([
  Object.freeze({ channel: 'palette', field: 'paletteId' }),
  Object.freeze({ channel: 'mark', field: 'markId' }),
  Object.freeze({ channel: 'mark-treatment', field: 'markTreatmentId' }),
  Object.freeze({ channel: 'yard-habit', field: 'yardHabitId' }),
  Object.freeze({ channel: 'boundary-habit', field: 'boundaryHabitId' }),
  Object.freeze({ channel: 'garden-habit', field: 'gardenHabitId' }),
  Object.freeze({ channel: 'material-habit', field: 'materialHabitId' }),
]);

/** How many options the catalog authors for each channel. */
export const AUTHORED_CHANNEL_SIZES = Object.freeze({
  palette: (FAMILY_FRONTAGE_VISUAL_OPTIONS.paletteIds || []).length,
  mark: (FAMILY_FRONTAGE_VISUAL_OPTIONS.markIds || []).length,
  'mark-treatment': (FAMILY_FRONTAGE_VISUAL_OPTIONS.markTreatmentIds || []).length,
  'yard-habit': Object.keys(FAMILY_FRONTAGE_VISUAL_OPTIONS.yardHabits || {}).length,
  'boundary-habit': Object.keys(FAMILY_FRONTAGE_VISUAL_OPTIONS.boundaryHabits || {}).length,
  'garden-habit': Object.keys(FAMILY_FRONTAGE_VISUAL_OPTIONS.gardenHabits || {}).length,
  'material-habit': Object.keys(FAMILY_FRONTAGE_VISUAL_OPTIONS.materialHabits || {}).length,
});

/** A household counts as working a trade when it owns anything but its home. */
const TRADE_PROGRAMS = Object.freeze(FAMILY_OWNED_PROGRAMS.filter((p) => p !== 'dwelling'));

// --- small statistics --------------------------------------------------------

function histogram(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

/**
 * Total variation distance between two categorical distributions: half the L1
 * distance between their normalised histograms. 0 is identical, 1 is disjoint.
 * Normalising first is what makes channels with different catalog sizes
 * comparable, which a raw L1 over counts is not.
 */
export function totalVariation(left, right) {
  if (!left.length || !right.length) return 0;
  const a = histogram(left), b = histogram(right);
  let sum = 0;
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    sum += Math.abs((a.get(key) || 0) / left.length - (b.get(key) || 0) / right.length);
  }
  return sum / 2;
}

/**
 * Shannon entropy normalised to [0, 1]. The ceiling is min(catalog, sample)
 * rather than the catalog alone: eight households cannot use twelve options
 * evenly, and scoring them against twelve would report a shortfall that is
 * arithmetic rather than design.
 */
export function normalizedEntropy(values, catalogSize = 0) {
  if (values.length < 2) return 0;
  const counts = histogram(values);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / values.length;
    entropy -= p * Math.log2(p);
  }
  const ceiling = Math.log2(Math.min(catalogSize || counts.size, values.length));
  return ceiling > 0 ? Math.min(1, entropy / ceiling) : 0;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/**
 * Whether a cohort is a sample worth measuring.
 *
 * A cohort holding the same village six times is not thirty samples, and every
 * distribution computed over it is quietly weighted toward whichever village
 * repeated. This is checked before the design stations run, and separately
 * from them: a duplicate here says something about the GENERATOR's seeding, not
 * about how various its villages look.
 */
export function cohortIntegrity(plans) {
  const byIdentity = new Map();
  for (const plan of plans) {
    const identity = settlementIdentity(plan);
    const group = byIdentity.get(identity) || [];
    group.push(cohortLabel(plan));
    byIdentity.set(identity, group);
  }
  const duplicateGroups = [...byIdentity.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([identity, labels]) => ({ identity, count: labels.length, labels }))
    .sort((a, b) => b.count - a.count);
  return {
    villages: plans.length,
    distinctIdentities: byIdentity.size,
    worlds: new Set(plans.map((plan) => plan.site?.worldSeed)).size,
    duplicateGroups,
    duplicatedVillages: duplicateGroups.reduce((sum, group) => sum + group.count - 1, 0),
  };
}

/**
 * One plan per distinct village, keeping the first occurrence. The design
 * stations run on this rather than on the raw cohort so their numbers describe
 * the generator's range instead of how often it repeated itself.
 */
export function distinctCohort(plans) {
  const seen = new Set(), out = [];
  for (const plan of plans) {
    const identity = settlementIdentity(plan);
    if (seen.has(identity)) continue;
    seen.add(identity); out.push(plan);
  }
  return out;
}

// --- station 1: household repetition inside one village ----------------------

/**
 * How near the nearest pair of look-alike households stands.
 *
 * Agreement is the share of the seven identity channels two households share,
 * so 1 is a visual duplicate and 0 is a household with nothing in common. The
 * gate is the DISTANCE between the closest such pair rather than their count:
 * two identical families at opposite ends of a village is how a real place
 * looks, and the same two across a lane is the tell that a generator is
 * hashing rather than deciding.
 *
 * `chanceAgreement` is the agreement uniform-random selection would produce
 * given the catalog sizes actually in play. It is the null model, and the
 * number worth reading is the excess over it — an absolute agreement of 0.2
 * means nothing until you know whether chance alone yields 0.2 or 0.05.
 */
export function measureHouseholdRepetition(plan, { twinAgreement = 0.7 } = {}) {
  const profiles = plan.familyFrontageProfiles || [];
  const homeById = new Map((plan.buildings || []).map((building) => [building.id, building]));
  const placed = profiles.filter((profile) => homeById.has(profile.homeBuildingId));

  const agreements = [];
  let nearestTwinDistance = Infinity, twinPairs = 0, nearestTwinPair = null;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const left = placed[i], right = placed[j];
      const shared = PROFILE_CHANNELS.filter(({ field }) => left[field] === right[field]).length;
      const agreement = shared / PROFILE_CHANNELS.length;
      agreements.push(agreement);
      if (agreement < twinAgreement) continue;
      twinPairs++;
      const a = homeById.get(left.homeBuildingId), b = homeById.get(right.homeBuildingId);
      const distance = Math.hypot(a.x - b.x, a.z - b.z);
      if (distance < nearestTwinDistance) {
        nearestTwinDistance = distance;
        nearestTwinPair = { left: left.householdId, right: right.householdId, agreement, distance };
      }
    }
  }

  const channelEntropy = {};
  let chanceAgreement = 0;
  for (const { channel, field } of PROFILE_CHANNELS) {
    const values = placed.map((profile) => profile[field]);
    channelEntropy[channel] = normalizedEntropy(values, AUTHORED_CHANNEL_SIZES[channel]);
    // Two independent uniform draws from n options collide with probability
    // 1/n, so the per-channel chance of agreement is the reciprocal of the
    // catalog the generator is drawing from.
    const size = AUTHORED_CHANNEL_SIZES[channel] || new Set(values).size || 1;
    chanceAgreement += 1 / size;
  }
  chanceAgreement /= PROFILE_CHANNELS.length;

  return {
    settlementId: cohortLabel(plan),
    households: placed.length,
    twinPairs,
    nearestTwinDistance,
    nearestTwinPair,
    meanAgreement: mean(agreements),
    chanceAgreement,
    excessAgreement: mean(agreements) - chanceAgreement,
    meanChannelEntropy: mean(Object.values(channelEntropy)),
    channelEntropy,
  };
}

// --- station 2: identity between villages ------------------------------------

function normalizedHistogram(values) {
  const counts = histogram(values), out = {};
  for (const [key, count] of counts) out[key] = count / (values.length || 1);
  return out;
}

function histogramDistance(left, right) {
  let sum = 0;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    sum += Math.abs((left[key] || 0) - (right[key] || 0));
  }
  return sum / 2;
}

function scalarDistance(left, right, scale) {
  return Math.min(1, Math.abs(left - right) / (scale || 1));
}

/**
 * The four things that make one village recognisably not another, kept apart
 * so a failure can name its cause. A pair of villages that collides on `form`
 * but not on `programMix` is a different bug from the reverse, and a single
 * blended distance would hide which one you have.
 */
export function villageSignature(plan) {
  const buildings = plan.buildings || [];
  const profiles = plan.familyFrontageProfiles || [];
  const style = buildings[0]?.style || {};

  const spacings = buildings.map((building) => {
    let nearest = Infinity;
    for (const other of buildings) {
      if (other === building) continue;
      nearest = Math.min(nearest, Math.hypot(other.x - building.x, other.z - building.z));
    }
    return Number.isFinite(nearest) ? nearest : 0;
  });
  const footprints = buildings.map((building) => building.width * building.depth);

  const channelMix = {};
  for (const { channel, field } of PROFILE_CHANNELS) {
    channelMix[channel] = normalizedHistogram(profiles.map((profile) => profile[field]));
  }

  return {
    settlementId: cohortLabel(plan),
    kind: plan.site?.kind || 'unknown',
    programMix: normalizedHistogram(buildings.map((building) => building.program)),
    channelMix,
    style: {
      foundation: style.foundation || 'none',
      timberFrame: Boolean(style.timberFrame),
      porch: Boolean(style.porch),
      chimney: Boolean(style.chimney),
      extension: Boolean(style.extension),
      windowRhythm: Number(style.windowRhythm) || 0,
      weathering: Number(style.weathering) || 0,
    },
    form: {
      buildings: buildings.length,
      meanSpacing: mean(spacings),
      meanFootprint: mean(footprints),
      squareRadius: plan.square?.radius || 0,
      streets: (plan.streets || []).length,
    },
  };
}

/**
 * Distance in [0, 1] between two village signatures, as the mean of four
 * component distances. Equal weight is a deliberate choice rather than a tuned
 * one: weighting the components is a way of deciding in advance which kind of
 * sameness matters, and that is the judgement this is meant to surface, not
 * bury.
 */
export function signatureDistance(left, right) {
  const styleFlags = ['timberFrame', 'porch', 'chimney', 'extension'];
  const flagDistance = mean(styleFlags.map((flag) => (left.style[flag] === right.style[flag] ? 0 : 1)));
  const components = {
    programMix: histogramDistance(left.programMix, right.programMix),
    channelMix: mean(PROFILE_CHANNELS.map(({ channel }) => (
      histogramDistance(left.channelMix[channel] || {}, right.channelMix[channel] || {})
    ))),
    style: mean([
      left.style.foundation === right.style.foundation ? 0 : 1,
      flagDistance,
      // Window rhythm spans roughly a metre of spacing and weathering is
      // already a unit interval, so both are scaled to make a full-range
      // difference read as 1.
      scalarDistance(left.style.windowRhythm, right.style.windowRhythm, 1),
      scalarDistance(left.style.weathering, right.style.weathering, 1),
    ]),
    form: mean([
      scalarDistance(left.form.buildings, right.form.buildings, 20),
      scalarDistance(left.form.meanSpacing, right.form.meanSpacing, 12),
      scalarDistance(left.form.meanFootprint, right.form.meanFootprint, 90),
      scalarDistance(left.form.squareRadius, right.form.squareRadius, 20),
      scalarDistance(left.form.streets, right.form.streets, 5),
    ]),
  };
  return { distance: mean(Object.values(components)), components };
}

/**
 * The closest pair in the cohort, which is the pair that decides whether the
 * generator makes places or variations. Villages of different kinds are still
 * compared: a halt and a village SHOULD come out far apart, and if they do not,
 * that is the finding.
 */
export function measureCohortIdentity(plans) {
  const signatures = plans.map(villageSignature);
  let minPairDistance = Infinity, closestPair = null;
  const distances = [];
  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      const { distance, components } = signatureDistance(signatures[i], signatures[j]);
      distances.push(distance);
      if (distance < minPairDistance) {
        minPairDistance = distance;
        closestPair = {
          left: signatures[i].settlementId, right: signatures[j].settlementId,
          leftKind: signatures[i].kind, rightKind: signatures[j].kind,
          distance, components,
        };
      }
    }
  }
  return {
    villages: signatures.length,
    minPairDistance: Number.isFinite(minPairDistance) ? minPairDistance : 0,
    meanPairDistance: mean(distances),
    closestPair,
    signatures,
  };
}

// --- which axes of a village never move --------------------------------------

/**
 * Which axes of a village's signature never move.
 *
 * A dimension the generator authors but always fills the same way is not
 * variety the player can see — it is a constant wearing a variable's name. This
 * counts distinct values per axis across the cohort and reports the dead ones,
 * because they are the cheapest uniqueness available: an axis stuck at one
 * value costs nothing to measure and everything to ignore.
 *
 * Reported rather than gated. Whether `extension` SHOULD vary is a design
 * decision, and a gate would be this module making it.
 */
export function measureSignatureCollapse(plans) {
  const signatures = plans.map(villageSignature);
  const axes = {};
  const record = (name, values) => {
    const distinct = new Set(values);
    axes[name] = { distinct: distinct.size, values: [...distinct].slice(0, 6) };
  };
  for (const flag of ['foundation', 'timberFrame', 'porch', 'chimney', 'extension']) {
    record(`style.${flag}`, signatures.map((signature) => signature.style[flag]));
  }
  // A village's roster, as the SET of programs it runs rather than their
  // proportions: two places both holding a church and a smithy are the same
  // kind of place whether or not one has a cottage more.
  record('programRoster', signatures.map((signature) => Object.keys(signature.programMix).sort().join(',')));
  record('kind', signatures.map((signature) => signature.kind));
  const dead = Object.entries(axes).filter(([, axis]) => axis.distinct <= 1).map(([name]) => name);
  return { villages: signatures.length, axes, dead };
}

// --- station 3: does the dressing know what the family does? -----------------

/**
 * Whether a household's visible identity is predictable from its trade.
 *
 * Pooled across the whole cohort on purpose. A single village holds a handful
 * of trade households, and the distance between two handfuls is mostly noise;
 * pooling is what makes the number mean the generator rather than the seed.
 *
 * Two figures come back and they measure different seams. `householdCoupling`
 * asks whether the FAMILY's own channels — its palette, its yard, what it
 * stacks against the wall — differ between families that work a trade and
 * families that do not. `serviceCueCoverage` asks the far weaker question of
 * whether trade buildings carry the program-derived cue at all. A world can
 * score 1 on the second and 0 on the first, and that world is one where every
 * workshop wears a sign and no smith's yard looks like a smith works there.
 */
export function measureOccupationCoupling(plans, { permutations = 64 } = {}) {
  const households = [];
  let tradeBuildings = 0, tradeBuildingsWithCue = 0;

  for (const plan of plans) {
    const ownedPrograms = new Map();
    for (const building of plan.buildings || []) {
      if (!building.ownerHouseholdId) continue;
      const programs = ownedPrograms.get(building.ownerHouseholdId) || [];
      programs.push(building.program);
      ownedPrograms.set(building.ownerHouseholdId, programs);
    }
    for (const frontage of plan.familyFrontages || []) {
      if (frontage.program === 'dwelling') continue;
      tradeBuildings++;
      if (frontage.application?.serviceCueId) tradeBuildingsWithCue++;
    }
    for (const profile of plan.familyFrontageProfiles || []) {
      const programs = ownedPrograms.get(profile.householdId) || [];
      households.push({
        trade: programs.some((program) => TRADE_PROGRAMS.includes(program)),
        values: PROFILE_CHANNELS.map(({ field }) => profile[field]),
      });
    }
  }

  const couplingFor = (labels) => {
    const perChannel = PROFILE_CHANNELS.map((_, index) => totalVariation(
      households.filter((_, i) => labels[i]).map((household) => household.values[index]),
      households.filter((_, i) => !labels[i]).map((household) => household.values[index]),
    ));
    return perChannel;
  };

  const observedLabels = households.map((household) => household.trade);
  const observed = couplingFor(observedLabels);
  const channelCoupling = {};
  PROFILE_CHANNELS.forEach(({ channel }, index) => { channelCoupling[channel] = observed[index]; });

  // The null model, and the reason any of this means anything.
  //
  // Two groups drawn from ONE distribution still differ, and they differ more
  // the smaller they are. Reporting a raw distance of 0.11 therefore says
  // nothing until you know what shuffling the trade labels over the same
  // households produces. Where observed and shuffled agree, the dressing is
  // independent of the trade however large the raw figure looks.
  const rng = mulberry32(0xc0c0a1e);
  const tradeCount = observedLabels.filter(Boolean).length;
  let chanceTotal = 0;
  for (let round = 0; round < permutations; round++) {
    const labels = new Array(households.length).fill(false);
    for (let assigned = 0; assigned < tradeCount;) {
      const index = Math.floor(rng() * households.length);
      if (labels[index]) continue;
      labels[index] = true; assigned++;
    }
    chanceTotal += mean(couplingFor(labels));
  }
  const chanceCoupling = permutations ? chanceTotal / permutations : 0;
  const householdCoupling = mean(observed);

  return {
    tradeHouseholds: tradeCount,
    domesticHouseholds: households.length - tradeCount,
    householdCoupling,
    chanceCoupling,
    couplingExcess: householdCoupling - chanceCoupling,
    channelCoupling,
    serviceCueCoverage: tradeBuildings ? tradeBuildingsWithCue / tradeBuildings : 0,
    tradeBuildings,
  };
}

// --- budgets and the gate ----------------------------------------------------

/**
 * Two kinds of number live here and the difference matters.
 *
 * A RATCHET is set at what the generator measures today. It has no claim to
 * being right; it exists so the figure cannot quietly get worse, and it is
 * meant to be tightened by hand whenever a change earns it.
 *
 * A TARGET is a figure the design should meet and does not yet. Those are held
 * in SETTLEMENT_DESIGN_TARGETS and deliberately not enforced, because a suite
 * that is red by default stops being read.
 */
export const SETTLEMENT_DESIGN_BUDGETS = Object.freeze({
  // Ratchet. What share of a cohort must be distinct villages rather than the
  // same village regenerated. Held below 1 because two worlds MAY legitimately
  // site the same kind of halt; held high because a cohort that is mostly
  // repeats is not a cohort.
  minDistinctShare: 0.9,
  // Ratchet, and currently the binding one. The frontage planner avoids
  // repeating channels within 42 m, so look-alike neighbours closer than that
  // mean the avoidance stopped holding.
  minTwinSeparationM: 42,
  twinAgreement: 0.7,
  // Ratchet. Measured excess sits between -0.10 and -0.016: the nearby
  // avoidance makes households MORE different than chance, which is the whole
  // point of it. Zero is therefore a real ceiling rather than a formality.
  maxExcessAgreement: 0,
  // Ratchet. Entropy is high because the catalogs are small, not because the
  // villages are various — six palettes and three yard habits can be used
  // evenly without looking like six different families. Read it beside
  // `authoredChannelSizes`, never alone.
  minChannelEntropy: 0.85,
  // Ratchet on the closest pair of DISTINCT villages, set just under the
  // measured 0.074. Deliberately not set at the target: while most worlds draw
  // their villages from one small pool of seeds, the distinct ones that remain
  // are a biased sample, and tightening this before that is fixed would be
  // gating on an artefact.
  minVillagePairDistance: 0.06,
  // Ratchet, and the honest one. Household channels are drawn from a hash of
  // the household ID with no reference to the trade the family works, so the
  // observed distance sits at whatever splitting the same population at random
  // would give. A BAND, not a floor: a quantity whose true value is zero lands
  // either side of zero from one cohort to the next, and gating at exactly zero
  // turns that jitter into a failing suite. The band is tight enough that real
  // coupling in either direction still trips it.
  minCouplingExcess: -0.02,
  // Target met. Program-derived service cues are wired, and may not regress.
  minServiceCueCoverage: 1,
});

/** Where the design should get to. Reported, never enforced. */
export const SETTLEMENT_DESIGN_TARGETS = Object.freeze({
  minCouplingExcess: 0.15,
  minVillagePairDistance: 0.30,
  minDistinctShare: 1,
});

/**
 * Run every station over a cohort and return one verdict, in the shape
 * settlementquality.mjs already uses for the simulation gates.
 */
export function validateSettlementDesignGates(plans, budgets = SETTLEMENT_DESIGN_BUDGETS) {
  const failures = [];
  if (!Array.isArray(plans) || plans.length < 2) {
    return { passed: false, failures: ['a cohort needs at least two villages'], metrics: null };
  }

  // Integrity first, and on the raw cohort. Every station below runs on the
  // distinct villages instead, because a distribution over a cohort holding one
  // village six times describes the repetition rather than the generator.
  const integrity = cohortIntegrity(plans);
  const distinct = distinctCohort(plans);
  const sampleFailures = [];
  if (integrity.distinctIdentities < budgets.minDistinctShare * integrity.villages) {
    sampleFailures.push(
      `${integrity.villages} villages across ${integrity.worlds} worlds share only `
      + `${integrity.distinctIdentities} identities`,
    );
  }

  const repetition = distinct.map((plan) => measureHouseholdRepetition(plan, { twinAgreement: budgets.twinAgreement }));
  for (const entry of repetition) {
    if (entry.households < 2) continue;
    if (entry.nearestTwinDistance < budgets.minTwinSeparationM) {
      failures.push(`${entry.settlementId}: look-alike households ${entry.nearestTwinDistance.toFixed(1)}m apart`);
    }
    if (entry.excessAgreement > budgets.maxExcessAgreement) {
      failures.push(`${entry.settlementId}: channel agreement ${entry.excessAgreement.toFixed(3)} over chance`);
    }
    if (entry.meanChannelEntropy < budgets.minChannelEntropy) {
      failures.push(`${entry.settlementId}: channel entropy ${entry.meanChannelEntropy.toFixed(3)}`);
    }
  }

  const identity = measureCohortIdentity(distinct);
  if (identity.minPairDistance < budgets.minVillagePairDistance) {
    const pair = identity.closestPair;
    failures.push(`${pair.left} and ${pair.right} differ by only ${pair.distance.toFixed(3)}`);
  }

  const collapse = measureSignatureCollapse(distinct);

  const coupling = measureOccupationCoupling(distinct);
  if (coupling.couplingExcess < budgets.minCouplingExcess) {
    failures.push(
      `household dressing ignores trade (${coupling.householdCoupling.toFixed(3)} `
      + `against ${coupling.chanceCoupling.toFixed(3)} by chance)`,
    );
  }
  if (coupling.serviceCueCoverage < budgets.minServiceCueCoverage) {
    failures.push(`service cues on ${(coupling.serviceCueCoverage * 100).toFixed(0)}% of trade buildings`);
  }

  const finite = repetition.map((entry) => entry.nearestTwinDistance).filter(Number.isFinite);
  return {
    // `passed` covers the design ratchets only. Whether the cohort was a fair
    // sample in the first place is a separate verdict, because a failure there
    // is a fact about the generator's seeding rather than about how various it
    // manages to make one village look.
    passed: failures.length === 0,
    failures,
    sample: { valid: sampleFailures.length === 0, failures: sampleFailures },
    metrics: {
      integrity,
      authoredChannelSizes: AUTHORED_CHANNEL_SIZES,
      repetition,
      identity: {
        villages: identity.villages,
        minPairDistance: identity.minPairDistance,
        meanPairDistance: identity.meanPairDistance,
        closestPair: identity.closestPair,
      },
      collapse,
      coupling,
      worstTwinSeparation: finite.length ? Math.min(...finite) : Infinity,
      worstChannelEntropy: Math.min(...repetition.map((entry) => entry.meanChannelEntropy)),
    },
  };
}
