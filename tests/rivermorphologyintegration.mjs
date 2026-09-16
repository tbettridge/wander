import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { planRiverNetwork } from '../src/rivernetwork.mjs';
import { validatedMeanderMesh } from '../src/rivermeanderfit.mjs';
import { bakeSparseRiverComponent } from '../src/riversparsemesh.mjs';
import { channelProfileAt } from '../src/rivercharacter.mjs';
import { riverChannelInspection } from '../src/riverchannelreport.mjs';
import { BASIN_PLAN_VERSION, descriptorHash } from '../src/hydrologyformat.mjs';
import { buildTerrainArrays, buildRiver, sampleRenderedTerrainTriangle } from '../src/chunkgen.js';

const sources = [
  { x: 2958.222222222222, z: 2958.222222222222 },
  { x: 2958.222222222222, z: 3413.3333333333335 },
  { x: 3413.3333333333335, z: 3413.3333333333335 },
];

const baselineOptions = Object.freeze({
  riverCharacter: true,
  riverMeanders: true,
  riverMorphology: false,
  mouthLength: 64,
});

const morphologyOptions = Object.freeze({
  ...baselineOptions,
  riverMorphology: true,
});

const widthAt = point => point.leftWidth + point.rightWidth;

function plan(options, sourceList = sources) {
  const world = new World(20260612, { generationVersion: 3 });
  return { world, network: planRiverNetwork(world, sourceList, options) };
}

function fullComponent(network) {
  return network.components.find(component => component.sources?.length === sources.length
    && component.junctions?.length === 2);
}

function endpointSignature(component) {
  return component.reaches.map(reach => {
    const start = reach.points[0], end = reach.points.at(-1);
    return {
      id: reach.id,
      start: start.nodeId ?? start.id,
      end: end.nodeId ?? end.id,
      startX: start.x,
      startZ: start.z,
      endX: end.x,
      endZ: end.z,
    };
  });
}

function interiorPoints(reach) {
  const total = reach.points.at(-1).arc;
  const start = reach.sourceClosure ? 32 : 16;
  const end = total - (reach.oceanMouth ? 64 : 16);
  return reach.points.filter(point => point.arc >= start && point.arc <= end);
}

function canonicalProfileLength(reach, profile) {
  for (const length of [
    reach.profileArcLength,
    profile?.canonicalArcLength,
    profile?.canonicalLength,
    profile?.samples?.at(-1)?.arc,
  ]) {
    if (Number.isFinite(length) && length > 0) return length;
  }
  return reach.points.slice(1).reduce((sum, point, index) =>
    sum + Math.hypot(point.x - reach.points[index].x, point.z - reach.points[index].z), 0);
}

function componentProfile(component, reach) {
  return component.hierarchy?.channelProfiles?.[reach.id] ?? reach.channelProfile;
}

function meanWidth(points) {
  return points.length ? points.reduce((sum, point) => sum + widthAt(point), 0) / points.length : 0;
}

function confluenceGrowth(component, junction) {
  const incoming = component.reaches
    .filter(reach => reach.points.at(-1).nodeId === junction.nodeId)
    .map(reach => meanWidth(interiorPoints(reach)));
  const outgoing = component.reaches
    .filter(reach => reach.points[0].nodeId === junction.nodeId)
    .map(reach => meanWidth(interiorPoints(reach)));
  return { incoming: Math.max(...incoming), outgoing: Math.max(...outgoing) };
}

function assertReachHydraulics(component) {
  for (const reach of component.reaches) {
    assert.ok(reach.points.length >= 2);
    for (let i = 0; i < reach.points.length; i++) {
      const point = reach.points[i];
      assert.ok(Number.isFinite(point.waterY));
      assert.ok(Number.isFinite(point.depth) && point.depth >= 0);
      assert.ok(Number.isFinite(point.leftWidth) && Number.isFinite(point.rightWidth));
      assert.ok(point.leftWidth > 0 && point.rightWidth > 0);
      assert.ok(point.leftWidth <= 22.5 + 1e-7 && point.rightWidth <= 22.5 + 1e-7);
      if (!i) continue;
      const prior = reach.points[i - 1];
      const distance = Math.hypot(point.x - prior.x, point.z - prior.z);
      assert.ok(point.waterY <= prior.waterY + 1e-9, 'river levels must not rise downstream');
      assert.ok(prior.waterY - point.waterY <= distance * reach.maxGrade + 1e-7,
        'fitted river grade must stay within the reach budget');
      const priorWidth = widthAt(prior), currentWidth = widthAt(point);
      assert.ok(Math.abs(currentWidth - priorWidth) / Math.max(priorWidth, currentWidth) < 0.36,
        'organic width must not jump into an isolated balloon');
    }
    for (let i = 1; i + 1 < reach.points.length; i++) {
      const before = widthAt(reach.points[i - 1]), current = widthAt(reach.points[i]);
      const after = widthAt(reach.points[i + 1]), localMean = (before + after) / 2;
      assert.ok(current / localMean < 1.5 && localMean / current < 1.5,
        'organic width must not contain a one-section balloon');
    }
  }
}

test('morphology keeps the real three-source network complete and grows a marked mainstem', () => {
  const baseline = plan(baselineOptions);
  const shaped = plan(morphologyOptions);
  const before = fullComponent(baseline.network);
  const after = fullComponent(shaped.network);
  assert.ok(before, 'flag-false baseline must retain all three sources and two joins');
  assert.ok(after, 'morphology must retain all three sources and two joins');
  assert.equal(after.reaches.length, 5);
  assert.equal(after.junctions.length, 2);
  assert.equal(after.reaches.filter(reach => reach.oceanMouth).length, 1);
  assert.ok(after.hierarchy);
  assert.equal(after.hierarchy.catchment.crossRegionComplete, false);
  assert.ok(after.reaches.every(reach => reach.points.at(-1).waterY <= reach.points[0].waterY + 1e-9));
  const mouth = after.reaches.find(reach => reach.oceanMouth).points.at(-1);
  assert.ok(Math.abs(mouth.waterY) < 1e-9);
  assert.ok(shaped.world._naturalHeight(mouth.x, mouth.z) < -0.25);

  assert.deepEqual(shaped.network, plan(morphologyOptions).network,
    'repeating the same morphology plan must be deterministic');
  assert.deepEqual(shaped.network,
    plan(morphologyOptions, [...sources].reverse()).network,
    'source order must not perturb morphology determinism');
  assert.deepEqual(after.graph, before.graph, 'morphology must preserve the routing graph');
  assert.deepEqual(after.routes, before.routes, 'morphology must preserve canonical route references');
  assert.deepEqual(endpointSignature(after), endpointSignature(before));

  assert.equal(after.meanders?.status, 'accepted',
    'the complete showcase component must accept its bounded meander fit');
  assert.equal(after.meanders.strength, 1,
    'bend widening must not force the showcase meanders into a weaker fallback');
  assert.ok(after.meanders.maxExcursion >= before.meanders.maxExcursion * 0.95,
    'richer banks must preserve the existing winding path');
  const inspection = riverChannelInspection(after);
  assert.ok(inspection);
  assert.ok(inspection.growthRatio >= 2,
    `mainstem average width should be at least twice the narrowest headwater (${inspection.growthRatio})`);
  assert.ok(inspection.growthRatio > riverChannelInspection(before).growthRatio,
    'morphology must make downstream growth more legible than the flag-false profile');
  let phasePairs = 0;
  for (const junction of after.junctions) {
    const growth = confluenceGrowth(after, junction);
    const baselineGrowth = confluenceGrowth(before, junction);
    assert.ok(growth.incoming > 0 && growth.outgoing > 0);
    assert.ok(growth.outgoing > growth.incoming * 1.05,
      `mainstem should widen after tributaries join at ${junction.nodeId}`);
    assert.ok(growth.outgoing / growth.incoming > baselineGrowth.outgoing / baselineGrowth.incoming + 0.1,
      `morphology should mark the post-join growth at ${junction.nodeId}`);
  }

  const allPoints = after.reaches.flatMap(reach => reach.points);
  const variableReaches = after.reaches.map(reach => interiorPoints(reach)).filter(points => points.length >= 3);
  assert.ok(variableReaches.some(points => {
    const widths = points.map(widthAt);
    return Math.max(...widths) - Math.min(...widths) > 0.55
      && Math.max(...widths) / Math.min(...widths) > 1.16;
  }), 'at least one walkable reach must show visible organic width variation');
  assertReachHydraulics(after);

  const bendPoints = allPoints.filter(point => Number.isFinite(point.bendWidening));
  assert.ok(bendPoints.length > 0, 'morphology points should expose bend metadata');
  assert.ok(bendPoints.every(point => Number.isFinite(point.smoothedCurvature)
    && Number.isFinite(point.bendWidening) && point.bendWidening >= 0.86
    && point.bendWidening <= 1.3 + 1e-7));
  assert.ok(Math.max(...bendPoints.map(point => point.bendWidening)) > 1.05,
    'a valid bend should produce an observable widening');
  assert.equal(before.reaches.flatMap(reach => reach.points)
    .filter(point => point.bendWidening !== undefined).length, 0,
  'flag-false baseline must retain the legacy cross-section metadata');

  const profiles = after.reaches.map(reach => componentProfile(after, reach));
  assert.ok(profiles.every(profile => profile?.morphology === true));
  const shortTransitions = profiles.filter(profile => {
    const canonical = profile?.samples?.at(-1)?.arc;
    const transition = profile?.trendEndArc - profile?.trendStartArc;
    return Number.isFinite(canonical) && Number.isFinite(transition) && canonical > transition + 16;
  });
  assert.ok(shortTransitions.length > 0,
    'the fixture must exercise a growth transition shorter than its canonical profile span');

  for (const junction of after.junctions) {
    const entering = after.reaches.filter(reach => reach.points.at(-1).nodeId === junction.nodeId);
    const leaving = after.reaches.filter(reach => reach.points[0].nodeId === junction.nodeId);
    for (const inReach of entering) for (const outReach of leaving) {
      const inProfile = componentProfile(after, inReach), outProfile = componentProfile(after, outReach);
      if (!inProfile || !outProfile || inProfile.id !== outProfile.id) continue;
      const inLength = canonicalProfileLength(inReach, inProfile);
      const outLength = canonicalProfileLength(outReach, outProfile);
      const atEnd = channelProfileAt(inProfile, inLength, inLength);
      const atStart = channelProfileAt(outProfile, 0, outLength);
      assert.equal(atStart.globalArc, atEnd.globalArc,
        `canonical character phase must meet at ${junction.nodeId}`);
      assert.equal(atStart.widthVariation, atEnd.widthVariation,
        `width noise phase must meet at ${junction.nodeId}`);
      assert.equal(atStart.depthVariation, atEnd.depthVariation,
        `depth noise phase must meet at ${junction.nodeId}`);
      assert.ok(Math.abs(inReach.points.at(-1).depth - atEnd.depth) < 1e-8,
        'incoming fitted depth must use canonical route distance');
      assert.ok(Math.abs(outReach.points[0].depth - atStart.depth) < 1e-8,
        'outgoing fitted depth must use canonical route distance');
      phasePairs++;
    }
  }
  assert.ok(phasePairs >= 2, 'the two joins must preserve at least two continuous profile identities');
});

test('morphology sparse terrain has bounded excavation and exact water at low and high detail near a bend and confluence', () => {
  const { world, network } = plan(morphologyOptions);
  const component = fullComponent(network);
  assert.ok(component);
  const mesh = validatedMeanderMesh(component) || bakeSparseRiverComponent(world, component);
  assert.equal(mesh.status, 'baked', JSON.stringify(mesh));
  assert.equal(mesh.oceanHandoff, true);
  const { coords, floor, natural, head, signed } = mesh.grid;
  assert.equal(coords.length, floor.length);
  assert.equal(coords.length, natural.length);
  assert.equal(coords.length, head.length);
  assert.equal(coords.length, signed.length);
  for (let i = 0; i < coords.length; i++) {
    assert.ok(Number.isFinite(floor[i]) && Number.isFinite(natural[i])
      && Number.isFinite(head[i]) && Number.isFinite(signed[i]));
    assert.ok(floor[i] <= natural[i] + 1e-7, 'river cuts must not float above natural terrain');
    assert.ok(natural[i] - floor[i] <= 6 + 1e-7, 'river excavation must stay within the cut budget');
    assert.ok(Math.abs(signed[i] - (head[i] - floor[i])) <= 1e-7);
    if (signed[i] > 1e-7) assert.ok(head[i] > floor[i]);
  }

  const bend = component.reaches.flatMap(reach => reach.points)
    .filter(point => point.bendWidening > 1.05)
    .sort((a, b) => b.bendWidening - a.bendWidening)[0]
    || component.meanders?.target;
  assert.ok(bend, 'the morphology fixture must provide a bend render target');
  const targets = [
    ['bend', bend],
    ['confluence', component.junctions[component.junctions.length - 1]],
  ];
  const payload = { version: BASIN_PLAN_VERSION, generationVersion: 3, seed: world.seed,
    regionX: 0, regionZ: 0, preview: true, basins: [], components: [mesh] };
  const installed = new World(world.seed, { waterPlans: [{ ...payload, hash: descriptorHash(payload) }] });
  for (const [label, target] of targets) {
    const cx = Math.floor(target.x / 140), cz = Math.floor(target.z / 140);
    const low = buildTerrainArrays(installed, cx, cz, 16, 140);
    const lowWater = buildRiver(cx, cz, 16, 140, low.river);
    assert.ok(lowWater?.indices.length > 0, `${label} must render water`);
    const high = buildTerrainArrays(installed, cx, cz, 96, 140);
    const highWater = buildRiver(cx, cz, 96, 140, high.river);
    assert.deepEqual(high.positions, low.positions, `${label} terrain must be LOD exact`);
    assert.deepEqual(highWater, lowWater, `${label} water must be LOD exact`);

    let wet = 0, shore = 0;
    for (let i = 0; i < lowWater.wet.length; i++) {
      const [x, y, z] = lowWater.positions.slice(i * 3, i * 3 + 3);
      const ground = sampleRenderedTerrainTriangle(low.positions, low.res, 140,
        cx * 140, cz * 140, x, z).y;
      if (lowWater.wet[i] > 1e-6) {
        assert.ok(y >= ground - 0.002, `${label} water must not fall below rendered terrain`);
        wet++;
      } else {
        assert.ok(Math.abs(y - ground) < 0.002,
          `${label} clipped shoreline must meet rendered terrain`);
        shore++;
      }
    }
    assert.ok(wet > 0 && shore > 0, `${label} must contain wet water and a real shore`);
  }
});

test('an unsafe morphology contribution is rejected or retained through an explicit safe baseline', () => {
  const unsafeSources = sources.map((source, index) => index === 0
    ? { ...source, drainageContribution: 1e10 }
    : source);
  const { network } = plan(morphologyOptions, unsafeSources);
  const complete = fullComponent(network);
  if (complete) {
    assert.ok(!complete.hierarchy
      || Object.values(complete.hierarchy.channelProfiles || {}).every(profile => profile.morphology !== true),
    'a full fallback component must not claim the unsafe morphology profile was fitted');
    return;
  }
  assert.ok(network.diagnostics.rejected.some(item => item.reason === 'current-fit-half-width-cap'),
    'an unsafe full component must report its bounded width rejection');
  assert.ok(network.components.every(component => component.sources.length < sources.length),
    'an unsafe morphology source must not publish a misleading complete component');
});
