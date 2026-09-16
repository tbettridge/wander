import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_PROFILE_LIMITS,
  channelProfileAt,
  normalizeChannelProfile,
} from '../src/rivercharacter.mjs';
import { fitRiverComponent } from '../src/rivercomponent.mjs';
import { bakeSparseRiverComponent } from '../src/riversparsemesh.mjs';
import { fitRiverReach, RiverReachField, riverSectionFloor } from '../src/riverterrain.mjs';

function flatRoute(length = 480, spacing = 60) {
  const count = Math.round(length / spacing);
  return {
    status: 'candidate',
    source: 'character-fixture',
    points: Array.from({ length: count + 1 }, (_, i) => ({
      x: 0, z: i * spacing, waterY: 3 - i * 0.002,
    })),
  };
}

function flatWorld(natural = 8) {
  return { seed: 9191, _naturalHeight: () => natural };
}

test('channel character is deterministic, seeded, smooth at lattice boundaries, and globally anchored', () => {
  const profile = normalizeChannelProfile({ id: 'trunk', halfWidth: 6, depth: 2,
    startHalfWidth: 4, endHalfWidth: 9, arcOffset: 240, variationSeed: 17,
    trendStartArc: 200, trendEndArc: 920 });
  const samples = [0, 25, 96, 192, 384, 640].map(arc => channelProfileAt(profile, arc, 480));
  assert.deepEqual(samples, [0, 25, 96, 192, 384, 640].map(arc => channelProfileAt(profile, arc, 480)));
  assert.notDeepEqual(samples, [0, 25, 96, 192, 384, 640].map(arc =>
    channelProfileAt({ ...profile, variationSeed: 18 }, arc, 480)));
  assert.ok(samples.every(sample => sample.halfWidth > 0 && sample.depth > 0));
  // Check both incommensurate lattice scales at exact global boundaries.
  for (const globalArc of [37 * 7, 96 * 3, 37 * 10, 96 * 5]) {
    const arc = globalArc - profile.arcOffset;
    const left = channelProfileAt(profile, arc - 1e-5, 480);
    const right = channelProfileAt(profile, arc + 1e-5, 480);
    assert.ok(Math.abs(left.halfWidth - right.halfWidth) < 1e-6, `width boundary ${arc}`);
    assert.ok(Math.abs(left.depth - right.depth) < 1e-6, `depth boundary ${arc}`);
  }

  // Re-segmenting a reach keeps its global trend bounds, so the mid-reach
  // character is the same even though each subreach has a local arc origin.
  const secondProfile = normalizeChannelProfile({ ...profile, arcOffset: profile.arcOffset + 200 });
  const second = channelProfileAt(secondProfile, 160, 240);
  const expected = channelProfileAt(profile, 360, 480);
  assert.deepEqual(second, expected, 'split profile must carry its global arc offset and trend bounds');
  assert.equal(CHANNEL_PROFILE_LIMITS.maxHalfWidth, 22.5);
  assert.throws(() => normalizeChannelProfile({ id: 'too-wide', halfWidth: 22.5001, depth: 1 }),
    /Invalid river channel profile/);
  assert.throws(() => normalizeChannelProfile({ id: 'bad-trend', halfWidth: 4, depth: 1,
    trendStartArc: 3 }), /Invalid river channel profile/);
});

test('profile split with shared global trend bounds preserves its midtrend value', () => {
  const profile = normalizeChannelProfile({ id: 'split', halfWidth: 4, depth: 1.4,
    startHalfWidth: 2.5, endHalfWidth: 8, arcOffset: 1000, variationSeed: 91,
    trendStartArc: 1000, trendEndArc: 1480 });
  const whole = channelProfileAt(profile, 240, 480);
  const subreach = channelProfileAt(profile, 0, 240);
  const atSplit = channelProfileAt(profile, 140, 240);
  assert.equal(subreach.globalArc, 1000);
  assert.equal(atSplit.globalArc, 1140);
  assert.deepEqual(channelProfileAt(profile, 140, 240), atSplit);
  assert.notEqual(whole.halfWidth, atSplit.halfWidth);
  void whole;
});

test('fitted character profiles vary width/depth while retaining bend and bank containment', () => {
  const route = flatRoute();
  const profile = { id: 'showcase-trunk', halfWidth: 6, depth: 1.8,
    startHalfWidth: 3.5, endHalfWidth: 8, arcOffset: 1200, variationSeed: 2026,
    trendStartArc: 1200, trendEndArc: 1680 };
  const reach = fitRiverReach(flatWorld(), route, {
    channelProfile: profile, sourceClosure: false, oceanMouth: false,
  });
  assert.equal(reach.status, 'fitted');
  assert.deepEqual(reach.channelProfile, normalizeChannelProfile(profile));
  const widths = reach.points.map(point => point.leftWidth);
  assert.ok(Math.max(...widths) - Math.min(...widths) > 1.2, 'character should vary across the reach');
  assert.ok(widths.every(width => width >= 1 && width <= CHANNEL_PROFILE_LIMITS.maxHalfWidth));
  assert.ok(reach.points.every(point => point.depth > 0));
  const envelope = point => Math.max(
    point.leftWidth + point.leftBankWidth + point.leftBlendWidth,
    point.rightWidth + point.rightBankWidth + point.rightBlendWidth,
  );
  assert.equal(reach.bounds.minX, Math.min(...reach.points.map(point => point.x - envelope(point))));
  assert.equal(reach.bounds.maxX, Math.max(...reach.points.map(point => point.x + envelope(point))));

  const field = new RiverReachField(reach), sample = {};
  const middle = reach.points[Math.floor(reach.points.length / 2)];
  const lateral = Math.min(middle.leftWidth * 0.7, 2.5);
  assert.equal(field.sample(middle.x - middle.tz * lateral, middle.z + middle.tx * lateral,
    8, sample), true);
  assert.ok(sample.signedDepth > 0);
  assert.ok(sample.floor <= sample.waterY);
  for (const side of ['left', 'right']) {
    const sign = side === 'left' ? -1 : 1;
    const bankOffset = reach.points[20][`${side}Width`] + reach.points[20][`${side}BankWidth`];
    assert.ok(reach.points[20][`${side}BankY`] >= reach.points[20].waterY + 0.199);
    const floor = riverSectionFloor(reach.points[20], sign * bankOffset, 8);
    assert.ok(floor >= reach.points[20].waterY - 1e-9);
  }
});

test('profiled depth still obeys the existing earthwork rejection constraints', () => {
  const reach = fitRiverReach(flatWorld(10), flatRoute(120, 60), {
    channelProfile: { id: 'deep', halfWidth: 5, depth: 2.4, variationSeed: 1 },
    sourceClosure: false, oceanMouth: false, maxCut: 1,
  });
  assert.equal(reach.status, 'retain-legacy');
  assert.equal(reach.reason, 'incompatible-water-intervals');
});

test('centreline smoothing retains the canonical character phase at the downstream join', () => {
  const route = flatRoute();
  route.points.forEach(p => { p.x = Math.sin(p.z / 150) * 35; });
  const length = route.points.slice(1).reduce((n, p, i) => n + Math.hypot(
    p.x - route.points[i].x, p.z - route.points[i].z), 0);
  const profile = { id: 'continuous-mainstem', halfWidth: 3, depth: 1.2,
    arcOffset: 300, variationSeed: 44, trendStartArc: 300, trendEndArc: 300 + length };
  const reach = fitRiverReach(flatWorld(), route, {
    channelProfile: profile, sourceClosure: false, oceanMouth: false,
  });
  assert.equal(reach.status, 'fitted');
  const end = reach.points.at(-1);
  assert.ok(Math.abs(end.arc - length) > 0.001, 'fixture must actually change length during smoothing');
  const expected = channelProfileAt(profile, length, length);
  assert.ok(Math.abs(end.leftWidth - expected.halfWidth * 1.02) < 1e-9);
  assert.ok(Math.abs(end.depth - expected.depth) < 1e-9);
});

test('synthetic headwater, tributary, and broad trunk profiles fit a bounded component mesh', () => {
  // This is an analytic valley fixture: it exercises hierarchy-sized channels
  // and the real component/junction/mesh contracts without a full-world load.
  const world = { seed: 31337, _naturalHeight: (x, z) => 7 - z * 0.004 + x * x * 0.00002 };
  const point = (id, x, z, waterY) => ({ id, x, z, waterY });
  const join = point('join', 0, 0, 4.6);
  const segmented = {
    status: 'candidate',
    reaches: [
      { id: 'head', status: 'candidate', source: 'head', sourceClosure: false, oceanMouth: false,
        points: [point('head', -36, -160, 5.1), join] },
      { id: 'medium', status: 'candidate', source: 'medium', sourceClosure: false, oceanMouth: false,
        points: [point('medium', 36, -160, 5), join] },
      { id: 'trunk', status: 'candidate', source: 'join', sourceClosure: false, oceanMouth: false,
        points: [join, point('end', 0, 260, 3.9)] },
    ],
    junctions: [{ id: 'junction:join', nodeId: 'join', waterY: 4.6 }],
  };
  const channelProfiles = {
    head: { id: 'head', halfWidth: 1.1, depth: 1, variationSeed: 1 },
    medium: { id: 'medium', halfWidth: 5, depth: 1.2, variationSeed: 2 },
    trunk: { id: 'trunk', halfWidth: 18, depth: 1.6, startHalfWidth: 15, endHalfWidth: 18,
      arcOffset: 0, variationSeed: 3 },
  };
  const fitted = fitRiverComponent(world, segmented, {
    channelProfiles, junctionLength: 128,
    protectedApproaches: [
      { x: 25, z: 120, floor: world._naturalHeight(25, 120), wet: false },
      { x: 25, z: 180, floor: world._naturalHeight(25, 180), wet: false },
    ],
  });
  assert.equal(fitted.status, 'fitted');
  const widths = fitted.reaches.map(reach => Math.max(...reach.points.map(point => point.leftWidth)));
  assert.ok(widths[0] < widths[1] && widths[1] < widths[2], 'three channel size classes');
  assert.ok(widths[0] * 2 < 3, 'headwater class');
  assert.ok(widths[1] * 2 >= 8 && widths[1] * 2 < 20, 'medium tributary class');
  assert.ok(widths[2] * 2 >= 35 && widths[2] * 2 <= 40, 'broad trunk remains within current cap');
  assert.ok(widths[2] / widths[0] > 5, 'trunk is several times wider than headwater');
  for (const reach of fitted.reaches) {
    assert.ok(reach.points.every(point => point.leftWidth <= 22.5 && point.rightWidth <= 22.5));
    assert.ok(reach.points.every(point => point.leftBankY >= point.waterY + 0.199
      && point.rightBankY >= point.waterY + 0.199));
  }

  const mesh = bakeSparseRiverComponent(world, { ...fitted, basins: [] });
  assert.equal(mesh.status, 'baked', mesh.reason);
  assert.equal(mesh.activationReady, false, 'mesh remains pending activation until caller publishes it');
  assert.ok(mesh.grid.coords.length > 1000 && mesh.grid.coords.length < 20000);
  for (let i = 0; i < mesh.grid.head.length; i++) {
    if (mesh.grid.head[i] === null) continue;
    assert.ok(mesh.grid.floor[i] - mesh.grid.natural[i] <= 2 + 1e-6, 'fill budget');
    assert.ok(mesh.grid.natural[i] - mesh.grid.floor[i] <= 6 + 1e-6, 'cut budget');
  }
});
