// Whether a building reads as the thing it is.
//
// The companion to settlementdesign, which asks whether villages differ from
// each other. This asks the question one step down: inside a village, can you
// tell a barn from a school without being told? A settlement whose buildings
// are all the same box at different sizes is various in its statistics and
// monotonous to walk through, and only a measure taken per PROGRAM rather than
// per village can tell the two apart.
//
// Three things are measured, and they fail in different ways.
//
// LEGIBILITY is whether programs are distinguishable at all: if a granary and a
// dwelling have the same proportions, the same roof and the same openings, the
// player has no way to read the village, however much each is varied.
//
// COHESION is the opposite failure. A place where every building is drawn
// independently from the same urn is a speckle, not a settlement. Real fabric
// commits: one quarry, one roofing trade, one century. This measures how far a
// village commits to its own palette instead of sampling all of them.
//
// EMBODIMENT is whether the geometry does what the plan says. A mass can be
// present in the data, carry the right role, and still be invisible because it
// sits inside the wall it was supposed to hold up. That gap does not show in
// any count of features, only in a measure of whether the feature can be seen.
//
// Renderer-independent: plan data only, like everything else in the suite.

import { createBuildingPlan, BUILDING_PROGRAMS } from './buildingplan.mjs';
import { OPENING_KIND, planOpenings } from './buildingopenings.mjs';
import { totalVariation } from './settlementdesign.mjs';
import { mulberry32 } from './noise.js';

/** Buildings the village builds for itself rather than for a family. */
export const CIVIC_PROGRAMS = Object.freeze([
  'church', 'hall', 'school', 'market-hall', 'station-house',
]);

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

// --- embodiment: can the geometry be seen? -----------------------------------

/**
 * Is this mass entirely swallowed by the core it is attached to?
 *
 * A buried mass is the specific failure that no feature count catches. The
 * granary's staddle stones are the case that prompted this: four stumps are
 * planned at the corners to raise the store clear of the damp, they are present
 * in the plan, they carry the right role — and the core they are meant to lift
 * is left standing on the ground, so all four sit inside it. The building is a
 * shed on the earth wearing the data of a granary on stilts.
 */
export function massIsBuried(item, core) {
  if (item.role === 'core') return false;
  const inside = (centre, half, coreCentre, coreHalf) =>
    centre - half >= coreCentre - coreHalf - 1e-6 && centre + half <= coreCentre + coreHalf + 1e-6;
  return inside(item.dx, item.width / 2, 0, core.width / 2)
    && inside(item.dz, item.depth / 2, 0, core.depth / 2)
    // Read the core's own base rather than assuming the ground: a lifted core
    // leaves the space beneath it outside itself, which is exactly where a
    // staddle stone is supposed to be.
    && inside(
      item.baseY + item.height / 2, item.height / 2,
      core.baseY + core.height / 2, core.height / 2,
    );
}

/**
 * A mass held in the air with nothing under it.
 *
 * A canopy or a market roof is supposed to be carried on posts. Planned as a
 * slab at head height with no mass beneath it, it renders as a plate floating
 * behind the building. Counted separately from burial because the fix differs:
 * one needs the core lifting, the other needs supports adding.
 */
export function massIsUnsupported(item, masses) {
  if (item.role === 'core' || item.baseY < 1.6) return false;
  if (item.role === 'spire') return false;                 // sits on its tower by design
  return !masses.some((other) => {
    if (other === item || other.role === 'spire') return false;
    const reaches = other.baseY + other.height >= item.baseY - 0.35;
    if (!reaches || other.baseY > item.baseY - 0.35) return false;
    const overlapX = Math.abs(other.dx - item.dx) < (other.width + item.width) / 2 - 0.2;
    const overlapZ = Math.abs(other.dz - item.dz) < (other.depth + item.depth) / 2 - 0.2;
    return overlapX && overlapZ;
  });
}

// --- legibility: can programs be told apart? ---------------------------------

/**
 * What a program looks like on average, as the handful of numbers a player
 * actually reads at fifty metres: how big, how tall, how long against how
 * wide, how steep the roof, and what is stuck to it.
 */
export function programSignature(program, { samples = 120, styleSeed = 0x5eed } = {}) {
  const rng = mulberry32(styleSeed);
  const heights = [], ratios = [], areas = [], pitches = [], hips = [], stone = [], slate = [], reach = [];
  const openingAreas = [], glazed = [], openingDensity = [];
  const openingKinds = new Map();
  const roleShare = new Map();
  for (let index = 0; index < samples; index++) {
    // A fresh village taste every few buildings, so a signature describes the
    // program across the world rather than inside one settlement.
    const style = index % 8 ? undefined : {
      massingComplexity: rng(), roofBias: rng(), hipBias: rng() * 0.5,
      wallBias: rng(), timberBias: rng(), trimHue: rng(),
    };
    const plan = createBuildingPlan({
      id: `signature:${program}:${index}`, program, seed: 40503 + index * 7919, style,
    });
    heights.push(plan.floorCount * plan.floorHeight);
    ratios.push(plan.width / plan.depth);
    areas.push(plan.width * plan.depth);
    pitches.push(plan.roof.pitch);
    hips.push(plan.roof.kind === 'hip' ? 1 : 0);
    stone.push(plan.materials.wall === 'stone' ? 1 : 0);
    slate.push(plan.materials.roof === 'slate' ? 1 : 0);
    // Which way the building reaches. A portico throws mass out over the way
    // in; a platform canopy throws it out behind. Counting only that both have
    // "a wing and some posts" makes a village hall and a station house the same
    // building, which anyone standing in front of either can see they are not.
    // How far the massing oversails the core FRONT and BACK, and the difference
    // between them. Both terms measure overhang beyond the core's own face, so
    // a plain box scores zero rather than minus its own depth.
    const frontOversail = Math.max(0, plan.footprint.maxZ - plan.depth / 2);
    const rearOversail = Math.max(0, -plan.depth / 2 - plan.footprint.minZ);
    reach.push(frontOversail - rearOversail);
    // What the wall says. A wall is read before anything inside it and holds
    // its meaning at any distance a village is seen from, so the shape of the
    // holes in it belongs in any measure of whether programs are legible.
    const openings = planOpenings(plan, plan.width);
    const wallArea = plan.width * plan.floorCount * plan.floorHeight;
    const openingArea = openings.reduce((sum, item) => sum + item.width * item.height, 0);
    openingAreas.push(openings.length ? openingArea / openings.length : 0);
    glazed.push(openings.length ? openings.filter((item) => item.glazed).length / openings.length : 0);
    openingDensity.push(wallArea ? openingArea / wallArea : 0);
    for (const kind of new Set(openings.map((item) => item.kind))) {
      openingKinds.set(kind, (openingKinds.get(kind) || 0) + 1);
    }
    for (const role of new Set(plan.masses.map((item) => item.role))) {
      if (role === 'core') continue;
      roleShare.set(role, (roleShare.get(role) || 0) + 1);
    }
  }
  const roles = {};
  for (const [role, count] of roleShare) roles[role] = count / samples;
  return {
    program,
    height: mean(heights), ratio: mean(ratios), area: mean(areas),
    pitch: mean(pitches), hipShare: mean(hips),
    stoneShare: mean(stone), slateShare: mean(slate), reach: mean(reach),
    openingArea: mean(openingAreas), glazedShare: mean(glazed),
    openingDensity: mean(openingDensity),
    openingKind: [...openingKinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || OPENING_KIND.none,
    roles,
  };
}

const ROLE_KEYS = Object.freeze(['wing', 'tower', 'spire', 'apse', 'lean-to', 'stair']);

/**
 * How far apart two programs sit, in the terms a player reads them by.
 *
 * Mass roles are weighted as heavily as the whole of proportion together,
 * because a tower is what makes a church a church. Two programs that differ
 * only in being ten per cent larger are the same building to anyone walking
 * past, and this is meant to say so.
 */
export function programDistance(left, right) {
  const scalar = (a, b, scale) => Math.min(1, Math.abs(a - b) / scale);
  const proportion = mean([
    scalar(left.height, right.height, 6),
    scalar(left.ratio, right.ratio, 1.2),
    scalar(left.area, right.area, 140),
    scalar(left.pitch, right.pitch, 0.35),
    scalar(left.hipShare, right.hipShare, 1),
    scalar(left.reach, right.reach, 4),
  ]);
  const roles = mean(ROLE_KEYS.map((role) => Math.abs((left.roles[role] || 0) - (right.roles[role] || 0))));
  // Fabric counts alongside form, because it is among the first things read at
  // any distance and the last thing still legible at the furthest. It is scored
  // as its own third rather than folded into proportion so a pair that differs
  // only in what it is built of cannot pass as a pair that differs in shape.
  const fabric = mean([
    Math.abs(left.stoneShare - right.stoneShare),
    Math.abs(left.slateShare - right.slateShare),
  ]);
  // Openings score as their own quarter. A vent slit and a sash are not a
  // difference of degree, so a shared vocabulary counts for nothing and a
  // different one counts for a lot.
  const openings = mean([
    left.openingKind === right.openingKind ? 0 : 1,
    Math.abs(left.glazedShare - right.glazedShare),
    scalar(left.openingArea, right.openingArea, 2.6),
    scalar(left.openingDensity, right.openingDensity, 0.16),
  ]);
  return {
    distance: (proportion + roles + fabric + openings) / 4,
    proportion, roles, fabric, openings,
  };
}

/** Every program against every other, worst pair first. */
export function measureProgramLegibility({ samples = 120 } = {}) {
  const signatures = BUILDING_PROGRAMS.map((program) => programSignature(program, { samples }));
  const pairs = [];
  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      const { distance, proportion, roles, fabric, openings } = programDistance(signatures[i], signatures[j]);
      pairs.push({
        left: signatures[i].program, right: signatures[j].program,
        distance, proportion, roles, fabric, openings,
      });
    }
  }
  pairs.sort((a, b) => a.distance - b.distance);
  const bare = signatures.filter((signature) => Object.keys(signature.roles).length === 0);
  return {
    signatures, pairs,
    closestPair: pairs[0] || null,
    meanDistance: mean(pairs.map((pair) => pair.distance)),
    programsWithNoMassing: bare.map((signature) => signature.program),
  };
}

/**
 * Whether the geometry a program plans can actually be seen.
 *
 * Run over freshly planned buildings rather than over a settlement, because a
 * program that buries its own massing does so everywhere and a village-sized
 * sample only makes the same finding more slowly.
 */
export function measureMassEmbodiment({ samples = 120 } = {}) {
  const byProgram = {};
  let total = 0, buried = 0, unsupported = 0;
  for (const program of BUILDING_PROGRAMS) {
    let programMasses = 0, programBuried = 0, programUnsupported = 0;
    for (let index = 0; index < samples; index++) {
      const plan = createBuildingPlan({ id: `embodiment:${program}:${index}`, program, seed: 91 + index * 7919 });
      const core = plan.masses.find((item) => item.role === 'core');
      for (const item of plan.masses) {
        if (item.role === 'core') continue;
        programMasses++;
        if (massIsBuried(item, core)) programBuried++;
        else if (massIsUnsupported(item, plan.masses)) programUnsupported++;
      }
    }
    byProgram[program] = {
      masses: programMasses,
      buriedShare: programMasses ? programBuried / programMasses : 0,
      unsupportedShare: programMasses ? programUnsupported / programMasses : 0,
    };
    total += programMasses; buried += programBuried; unsupported += programUnsupported;
  }
  return {
    byProgram,
    buriedShare: total ? buried / total : 0,
    unsupportedShare: total ? unsupported / total : 0,
    worstBuried: Object.entries(byProgram).sort((a, b) => b[1].buriedShare - a[1].buriedShare)[0],
  };
}

// --- cohesion: does a village commit to a fabric? ----------------------------

/**
 * How far a village commits to one palette instead of sampling every option.
 *
 * Zero is an even scatter of every material the catalog holds, which is what a
 * per-building coin flip produces and what reads as a speckle. One is a place
 * built entirely of one thing. Real settlements sit high: the quarry, the
 * roofing trade and the century are shared, so the fabric is shared.
 *
 * MEASURED ON HOMES ONLY, and that is the whole subtlety. A village whose
 * church is stone among plaster cottages is not less coherent than one built
 * of a single material — it is more legible, because the exception is what
 * makes the rule visible. Counting civic and working buildings here would score
 * that hierarchy as incoherence and push the generator back toward the flat
 * scatter this measure exists to catch.
 */
const DOMESTIC_PROGRAMS = Object.freeze(['dwelling', 'inn']);

export function measureFabricCohesion(plans) {
  const villages = plans.map((plan) => {
    const buildings = (plan.buildings || []).filter(
      (building) => DOMESTIC_PROGRAMS.includes(building.program),
    );
    if (!buildings.length) return null;
    const plaster = buildings.filter((b) => b.materials.wall === 'plaster').length / buildings.length;
    const slate = buildings.filter((b) => b.materials.roof === 'slate').length / buildings.length;
    // Distance from an even split, doubled so a fully committed village scores 1.
    return {
      settlementId: `${plan.site?.worldSeed}/${plan.site?.id}`,
      buildings: buildings.length,
      plasterShare: plaster, slateShare: slate,
      commitment: (Math.abs(plaster - 0.5) + Math.abs(slate - 0.5)),
    };
  }).filter(Boolean);
  return {
    villages,
    meanCommitment: mean(villages.map((village) => village.commitment)),
    weakest: villages.slice().sort((a, b) => a.commitment - b.commitment)[0] || null,
  };
}

/**
 * Whether material says anything about what a building is FOR.
 *
 * Compared against a shuffled baseline for the same reason the household
 * coupling station is: two groups drawn from one urn still differ, and the raw
 * distance alone cannot tell you whether a church being stone means anything.
 */
export function measureMaterialLegibility(plans, { permutations = 96 } = {}) {
  const rows = [];
  for (const plan of plans) {
    for (const building of plan.buildings || []) {
      rows.push({
        civic: CIVIC_PROGRAMS.includes(building.program),
        wall: building.materials.wall, roof: building.materials.roof,
      });
    }
  }
  const pick = (labels, field) => rows.filter((unused, index) => labels[index]).map((row) => row[field]);
  const reject = (labels, field) => rows.filter((unused, index) => !labels[index]).map((row) => row[field]);
  const observedLabels = rows.map((row) => row.civic);
  const observed = mean(['wall', 'roof'].map((field) => totalVariation(
    pick(observedLabels, field), reject(observedLabels, field),
  )));

  const rng = mulberry32(0xfab21c);
  const civicCount = observedLabels.filter(Boolean).length;
  let chanceTotal = 0;
  for (let round = 0; round < permutations; round++) {
    const labels = new Array(rows.length).fill(false);
    for (let assigned = 0; assigned < civicCount;) {
      const index = Math.floor(rng() * rows.length);
      if (labels[index]) continue;
      labels[index] = true; assigned++;
    }
    chanceTotal += mean(['wall', 'roof'].map((field) => totalVariation(
      pick(labels, field), reject(labels, field),
    )));
  }
  const chance = permutations ? chanceTotal / permutations : 0;
  return {
    buildings: rows.length, civicBuildings: civicCount,
    observed, chance, excess: observed - chance,
  };
}

// --- budgets and the gate ----------------------------------------------------

export const ARCHITECTURE_BUDGETS = Object.freeze({
  // Enforced, not pinned. Every mass a program plans is now visible and carried:
  // the granary stands on its stones, the station canopy on posts, the market
  // roof on an arcade. Zero is a real gate rather than an aspiration.
  maxBuriedShare: 0,
  maxUnsupportedShare: 0,
  // Ratchet on the most confusable pair, set under the measured 0.148. It has
  // been inn/hall (0.048), then dwelling/inn, and is now hall/school — two
  // civic rooms with tall windows, which is a far fairer complaint than the
  // ones it replaced. Note this figure is not comparable to the earliest one:
  // the measure has since grown a fabric term and an openings term.
  minProgramPairDistance: 0.13,
  maxProgramsWithNoMassing: 0,
  // Ratchet, set under the measured 0.503. Villages pick a fabric and a
  // strength rather than a uniform threshold, so most now commit to one.
  minFabricCommitment: 0.47,
  // Ratchet, set under the measured 0.166 with room to spare. Material follows
  // program, so a church is stone almost everywhere and a barn almost nowhere.
  // The margin is wide because this statistic moves several hundredths between
  // cohorts: it depends on how many civic buildings the seeds happened to
  // place, and a cohort of thirty villages holds only forty-odd of them.
  minMaterialExcess: 0.14,
});

/** Where the design should get to. Reported, never enforced. */
export const ARCHITECTURE_TARGETS = Object.freeze({
  minProgramPairDistance: 0.20,
  minFabricCommitment: 0.60,
});

/** Every architecture station at once, in the shape the other gates use. */
export function validateArchitectureGates(plans, budgets = ARCHITECTURE_BUDGETS) {
  const failures = [];
  const legibility = measureProgramLegibility();
  const embodiment = measureMassEmbodiment();
  const cohesion = measureFabricCohesion(plans);
  const material = measureMaterialLegibility(plans);

  if (embodiment.buriedShare > budgets.maxBuriedShare) {
    failures.push(`${(embodiment.buriedShare * 100).toFixed(1)}% of masses are buried inside their core`);
  }
  if (embodiment.unsupportedShare > budgets.maxUnsupportedShare) {
    failures.push(`${(embodiment.unsupportedShare * 100).toFixed(1)}% of masses float unsupported`);
  }
  if (legibility.closestPair && legibility.closestPair.distance < budgets.minProgramPairDistance) {
    const pair = legibility.closestPair;
    failures.push(`${pair.left} and ${pair.right} differ by only ${pair.distance.toFixed(3)}`);
  }
  if (legibility.programsWithNoMassing.length > budgets.maxProgramsWithNoMassing) {
    failures.push(`no massing of their own: ${legibility.programsWithNoMassing.join(', ')}`);
  }
  if (cohesion.meanCommitment < budgets.minFabricCommitment) {
    failures.push(`village fabric commitment ${cohesion.meanCommitment.toFixed(3)}`);
  }
  if (material.excess < budgets.minMaterialExcess) {
    failures.push(`material says nothing about function (excess ${material.excess.toFixed(4)})`);
  }

  return {
    passed: failures.length === 0,
    failures,
    metrics: { legibility, embodiment, cohesion, material },
  };
}
