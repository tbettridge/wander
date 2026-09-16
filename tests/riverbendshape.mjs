import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRiverBendShape,
  RIVER_MORPHOLOGY_CURVATURE_SMOOTHING_METERS,
  RIVER_MORPHOLOGY_MAX_SIDE_BEND_MULTIPLIER,
  RIVER_MORPHOLOGY_MAX_WIDTH_MULTIPLIER,
} from '../src/riverbendshape.mjs';
import {
  channelProfileHalfWidthBound,
  normalizeChannelProfile,
} from '../src/rivercharacter.mjs';
import { fitRiverReach } from '../src/riverterrain.mjs';

const bendRoute = (radius = 110, count = 8, step = 40) => ({
  status: 'candidate', source: 'morphology-test',
  points: Array.from({ length: count + 1 }, (_, i) => {
    const angle = i * step / radius * 0.999;
    return { x: radius * (1 - Math.cos(angle)), z: radius * Math.sin(angle), waterY: 3 };
  }),
});

const flatWorld = { seed: 12, _naturalHeight: () => 8 };

test('morphology is explicitly validated and leaves absent profiles byte-shaped', () => {
  const legacy = normalizeChannelProfile({ id: 'legacy', halfWidth: 4, depth: 1 });
  assert.equal(Object.hasOwn(legacy, 'morphology'), false);
  assert.equal(normalizeChannelProfile({ id: 'off', halfWidth: 4, depth: 1, morphology: false }).morphology, false);
  assert.equal(normalizeChannelProfile({ id: 'on', halfWidth: 4, depth: 1, morphology: true }).morphology, true);
  assert.throws(() => normalizeChannelProfile({ id: 'bad', halfWidth: 4, depth: 1, morphology: 1 }),
    /Invalid river channel profile/);
});

test('broad bends receive a bounded total-width bulge and asymmetric point bar', () => {
  const profile = { id: 'broad', halfWidth: 6, depth: 1.5, variationSeed: 2, morphology: true };
  const morphed = fitRiverReach(flatWorld, bendRoute(), { channelProfile: profile,
    sourceClosure: false, oceanMouth: false });
  const legacy = fitRiverReach(flatWorld, bendRoute(), { channelProfile: { ...profile, morphology: false },
    sourceClosure: false, oceanMouth: false });
  assert.equal(morphed.status, 'fitted');
  assert.equal(legacy.status, 'fitted');
  const bulge = Math.max(...morphed.points.map(point => point.bendWidening));
  assert.ok(bulge > 1.1, `expected visible bend bulge, got ${bulge}`);
  const totalRatios = morphed.points.map((point, i) =>
    (point.leftWidth + point.rightWidth) / (legacy.points[i].leftWidth + legacy.points[i].rightWidth));
  assert.ok(Math.max(...totalRatios) > 1.1);
  assert.ok(Math.max(...totalRatios) <= RIVER_MORPHOLOGY_MAX_WIDTH_MULTIPLIER * 1.02);
  assert.ok(morphed.points.some(point => Math.abs(point.leftWidth - point.rightWidth) > 0.5));
  assert.ok(morphed.points.every(point => point.leftWidth <= 22.5 && point.rightWidth <= 22.5));
  assert.ok(morphed.points.every(point => Number.isFinite(point.smoothedCurvature)
    && Number.isFinite(point.bendWidening)));
  assert.ok(channelProfileHalfWidthBound(profile)
    >= Math.max(...morphed.points.map(point => Math.max(point.leftWidth, point.rightWidth))));
});

test('curvature smoothing crosses an inflection continuously without a lattice scallop', () => {
  const points = Array.from({ length: 241 }, (_, i) => ({
    x: 90 * Math.sin((i - 120) * 4 / 140), z: i * 4,
  }));
  const shape = buildRiverBendShape(points, { profile: { id: 's', variationSeed: 7, morphology: true },
    world: flatWorld });
  const signs = shape.map(value => Math.sign(value.smoothedCurvature));
  assert.ok(signs.includes(-1) && signs.includes(1));
  const inflection = shape.findIndex((value, i) => i > 2 && i < shape.length - 2
    && value.smoothedCurvature * shape[i - 1].smoothedCurvature <= 0);
  assert.ok(inflection > 0);
  assert.ok(Math.abs(shape[inflection].smoothedCurvature) < 0.003);
  for (let i = 1; i < shape.length; i++) {
    assert.ok(Math.abs(shape[i].bendWidening - shape[i - 1].bendWidening) < 0.04);
  }
  assert.equal(RIVER_MORPHOLOGY_CURVATURE_SMOOTHING_METERS, 32);
});

test('steep cross-valley terrain suppresses bend widening while retaining finite shape', () => {
  const steep = { seed: 2, _naturalHeight: (x, z) => 8 + x * x * 0.05 };
  const points = bendRoute().points;
  const flatShape = buildRiverBendShape(points, {
    profile: { id: 'steep', halfWidth: 6, variationSeed: 2, morphology: true }, world: flatWorld,
  });
  const shape = buildRiverBendShape(points, {
    profile: { id: 'steep', halfWidth: 6, variationSeed: 2, morphology: true }, world: steep,
  });
  const interior = values => values.slice(1, -1);
  const flatStrength = Math.max(...interior(flatShape).map(value => value.curvatureStrength));
  const steepStrength = Math.max(...interior(shape).map(value => value.curvatureStrength));
  assert.ok(steepStrength < flatStrength * 0.1,
    `steep terrain should suppress interior bend strength (${steepStrength} vs ${flatStrength})`);
  const flatWidth = Math.max(...interior(flatShape).map(value => value.bendWidening));
  const steepWidth = Math.max(...interior(shape).map(value => value.bendWidening));
  assert.ok(steepWidth < flatWidth - 0.1,
    `steep terrain should suppress interior widening (${steepWidth} vs ${flatWidth})`);
  assert.ok(shape.every(value => value.leftMultiplier <= RIVER_MORPHOLOGY_MAX_SIDE_BEND_MULTIPLIER
    && value.rightMultiplier <= RIVER_MORPHOLOGY_MAX_SIDE_BEND_MULTIPLIER));
});
