import test from 'node:test';
import assert from 'node:assert/strict';
import { findLakeShoreSpawn, prepareLakeShoreSpawn, validateLakeShoreSpawn } from '../src/lakeshorespawn.mjs';

function denseGrid({ size = 5, lake = true } = {}) {
  const signed = Array(size * size).fill(-1);
  if (lake) for (let z = 1; z < size - 1; z++) {
    for (let x = 1; x < size - 1; x++) signed[z * size + x] = 1;
  }
  return { x0: 0, z0: 0, step: 4, cols: size, rows: size, signed };
}

function standaloneBody(id, centerX, centerZ, level = 2) {
  return {
    id, kind: 'lake', centerX, centerZ, level,
    bounds: { minX: 0, maxX: 16, minZ: 0, maxZ: 16 },
    grid: denseGrid(),
  };
}

function fakeWorld(plans, wetAt, siteAt = () => ({ h: 2.5, slope: 0.1 })) {
  return {
    generationVersion: 3,
    waterField: { plans },
    riverAt: wetAt,
    biomeAt: siteAt,
  };
}

test('finds a dry shore owned by the accepted center-region lake', () => {
  const body = standaloneBody('lake:center', 8, 8);
  const world = fakeWorld([
    { regional: 1, regionX: 0, regionZ: 0, basins: [body], components: [] },
  ], (x, z) => {
    const wet = x >= 4 && x <= 12 && z >= 4 && z <= 12;
    return { wet, bodyId: wet ? body.id : null, kind: wet ? 'lake' : null };
  }, (x, z) => {
    // The first dry ring is either too low or too steep. The helper must keep
    // walking the same bounded ray until it finds a genuinely safe bank.
    const distance = Math.hypot(x - 4, z - 4);
    return distance < 16 ? { h: 2.1, slope: 0.3 } : { h: 2.5, slope: 0.1 };
  });
  const spawn = findLakeShoreSpawn(world, { regionX: 0, regionZ: 0 });
  assert.ok(spawn);
  assert.equal(spawn.lakeId, body.id);
  assert.equal(spawn.bodyId, body.id);
  assert.ok(spawn.distance >= 16 && spawn.distance <= 32);
  assert.ok(spawn.tangentX ** 2 + spawn.tangentZ ** 2 > 0.99);
  assert.ok(spawn.x > 0 || spawn.z > 0);
});

test('uses connected component lake ownership through a pond shoreline blend', () => {
  const size = 5, coords = [], lakeKind = [], signed = [], head = [];
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    coords.push([x, z]);
    const wet = x >= 1 && x <= 3 && z >= 1 && z <= 3;
    lakeKind.push(wet ? 2 : 0); signed.push(wet ? 1 : -1); head.push(2);
  }
  const mesh = {
    hash: 'component-lake', basinIds: ['lake:component'],
    grid: { step: 4, coords, lakeKind, signed, head },
  };
  let sawPondBlend = false;
  const world = fakeWorld([
    { regional: 1, regionX: 0, regionZ: 0, basins: [], components: [mesh] },
  ], (x, z) => {
    const lake = x >= 4 && x <= 12 && z >= 4 && z <= 12;
    const pond = x >= 12 && x < 16 && z >= 4 && z <= 12;
    if (pond) {
      sawPondBlend = true;
      return {
        wet: true, bodyId: 'component:component-lake', kind: 'pond',
        waterKind: 1, waterY: 2,
      };
    }
    if (lake) return {
      wet: true, bodyId: 'component:component-lake', kind: 'lake',
      waterKind: 2, waterY: 2,
    };
    // A different-owner river lies beyond the blend. The ray must stop there
    // instead of claiming a dry bank on the far side for this lake.
    const river = x >= 20 && x <= 24 && z >= 4 && z <= 12;
    return river ? { wet: true, bodyId: 'river:other', kind: 'river' } : { wet: false };
  }, (x) => {
    // Make the pond transition necessary: only the dry bank beyond it is safe.
    return x >= 16 ? { h: 2.5, slope: 0.1 } : { h: 2.5, slope: 0.4 };
  });
  const spawn = findLakeShoreSpawn(world, { regionX: 0, regionZ: 0 });
  assert.ok(spawn);
  assert.equal(spawn.bodyId, 'component:component-lake');
  assert.equal(spawn.lakeId, 'lake:component');
  assert.ok(sawPondBlend);
  assert.ok(spawn.x >= 16 && spawn.x < 20);
  assert.ok(spawn.distance <= 32);
});

test('does not treat an unrelated river as a lake anchor', () => {
  const body = standaloneBody('lake:missing', 8, 8);
  const world = fakeWorld([
    { regional: 1, regionX: 0, regionZ: 0, basins: [body], components: [] },
  ], () => ({ wet: true, bodyId: 'river:other', kind: 'river' }));
  assert.equal(findLakeShoreSpawn(world, { regionX: 0, regionZ: 0 }), null);
});

test('prefers the accepted center lake and respects the prepared-window callback', () => {
  const center = standaloneBody('lake:center', 8, 8);
  const neighbour = standaloneBody('lake:neighbour', 1008, 8);
  const world = fakeWorld([
    { regional: 1, regionX: 0, regionZ: 0, basins: [center], components: [] },
    { regional: 1, regionX: 1, regionZ: 0, basins: [neighbour], components: [] },
  ], (x, z) => {
    const centerWet = x >= 4 && x <= 12 && z >= 4 && z <= 12;
    const neighbourWet = x >= 1004 && x <= 1012 && z >= 4 && z <= 12;
    return centerWet
      ? { wet: true, bodyId: center.id, kind: 'lake' }
      : neighbourWet ? { wet: true, bodyId: neighbour.id, kind: 'lake' } : { wet: false };
  });
  const spawn = findLakeShoreSpawn(world, {
    regionX: 0, regionZ: 0,
    contains: (x) => x < 1000,
  });
  assert.ok(spawn);
  assert.equal(spawn.lakeId, center.id);
  assert.ok(spawn.x < 1000);
});

function streamedLake({ initiallyEmpty = false } = {}) {
  const body = standaloneBody('lake:neighbour', 4112, 24);
  body.grid.x0 = 4104;
  body.grid.z0 = 16;
  const plans = [{ regional: 1, regionX: 1, regionZ: 0, basins: [body], components: [] }];
  const world = fakeWorld(initiallyEmpty ? [] : plans, (x, z) => {
    const wet = x >= 4108 && x <= 4116 && z >= 20 && z <= 28;
    return { wet, bodyId: wet ? body.id : null, kind: wet ? 'lake' : null, y: 2 };
  });
  const events = [];
  world.installWaterField = field => { events.push('install'); world.waterField = field; };
  const stream = {
    active: { regionX: 0, regionZ: 0 }, onProgress: null,
    contains: () => true,
    async initialize(regionX, regionZ) {
      events.push(`initialize:${regionX}:${regionZ}`);
      return { regionX, regionZ, preparedField: { plans } };
    },
    commit(window) { events.push('commit'); this.active = window; },
  };
  return { world, stream, events };
}

test('preloads and commits the shore coordinate region before returning the same validated bank', async () => {
  const { world, stream, events } = streamedLake();
  const initial = findLakeShoreSpawn(world);
  const spawn = await prepareLakeShoreSpawn(world, stream);
  assert.deepEqual(spawn, initial);
  assert.deepEqual(events, ['initialize:1:0', 'commit', 'install']);
  assert.equal(stream.active.regionX, Math.floor(spawn.x / 4096));
  assert.ok(validateLakeShoreSpawn(world, spawn));
  assert.equal(stream.onProgress, null);
  world.biomeAt = () => ({ h: NaN, slope: NaN });
  assert.equal(validateLakeShoreSpawn(world, spawn), false);
});

test('searches a neighbouring window when the initial accepted window has no safe lake', async () => {
  const { world, stream, events } = streamedLake({ initiallyEmpty: true });
  const messages = [];
  const spawn = await prepareLakeShoreSpawn(world, stream, { onProgress: m => messages.push(m) });
  assert.equal(spawn.lakeId, 'lake:neighbour');
  assert.deepEqual(events, ['initialize:1:0', 'commit', 'install']);
  assert.ok(messages.length > 0);
});

test('does not silently replace a missing lake shore with an arbitrary dry spawn', async () => {
  const world = fakeWorld([], () => ({ wet: false }));
  await assert.rejects(prepareLakeShoreSpawn(world, null), /No safe lake shore/);
});
