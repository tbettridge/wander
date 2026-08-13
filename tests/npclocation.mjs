import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNpcLocation,
  createNpcResidence,
  createNpcSpatialState,
  isNpcLocation,
  normalizeNpcLocation,
  normalizeNpcSpatialState,
  npcSpatialSnapshot,
  NPC_LOCATION_KIND,
  sameNpcLocation,
  withNpcLocation,
} from '../src/npclocation.mjs';

const residence = createNpcResidence({
  originSettlementId: 'settlement:old-wren',
  residenceSettlementId: 'settlement:barrow-cross',
  householdId: 'household:barrow:7',
  homeBuildingId: 'building:barrow:12',
});

test('all current-location kinds normalize to immutable, defensive data', () => {
  const cases = [
    createNpcLocation(NPC_LOCATION_KIND.building, {
      settlementId: 'settlement:barrow-cross', buildingId: 'building:barrow:12', nodeId: 'room:kitchen',
    }),
    createNpcLocation(NPC_LOCATION_KIND.settlementNode, {
      settlementId: 'settlement:barrow-cross', nodeId: 'street:market',
    }),
    createNpcLocation(NPC_LOCATION_KIND.regionalEdge, {
      edgeId: 'trail:19', fromKey: 'R1', toKey: 'L44', progress: 0.375,
    }),
    createNpcLocation(NPC_LOCATION_KIND.stationPlatform, {
      stationId: 'station:1', platformId: 'platform:1:a', waitAnchorId: 'wait:1:a:2',
    }),
    createNpcLocation(NPC_LOCATION_KIND.trainSeat, {
      runId: 'run:rail:0042', carriageId: 'carriage:1', seatId: 'seat:3',
    }),
    createNpcLocation(NPC_LOCATION_KIND.trainCarriage, {
      runId: 'run:rail:0042', carriageId: 'carriage:1', zoneId: 'aisle', seatId: 'seat:3',
    }),
    createNpcLocation(NPC_LOCATION_KIND.worldSite, {
      siteId: 'site:standing-stone', nodeId: 'site:standing-stone:approach',
    }),
  ];
  assert.equal(cases.length, Object.keys(NPC_LOCATION_KIND).length);
  for (const location of cases) {
    assert.equal(isNpcLocation(location), true);
    assert.equal(Object.isFrozen(location), true);
  }
  const input = { kind: 'world-site', siteId: 'site:oak' };
  const normalized = normalizeNpcLocation(input);
  input.siteId = 'site:changed';
  assert.equal(normalized.siteId, 'site:oak', 'normalization must not retain a mutable input object');
});

test('ordinary movement changes location without changing origin or residence', () => {
  const atHome = createNpcSpatialState({
    residence,
    location: createNpcLocation('building', {
      settlementId: residence.residenceSettlementId,
      buildingId: residence.homeBuildingId,
      nodeId: 'room:front',
    }),
  });
  const onTrail = withNpcLocation(atHome, createNpcLocation('regional-edge', {
    edgeId: 'trail:22', fromKey: 'R1', toKey: 'R2', progress: 0.6,
  }));
  const onTrain = withNpcLocation(onTrail, createNpcLocation('train-seat', {
    runId: 'run:rail:0042', carriageId: 'carriage:0', seatId: 'seat:2',
  }));
  assert.strictEqual(onTrail.residence, atHome.residence);
  assert.strictEqual(onTrain.residence, atHome.residence);
  assert.equal(onTrain.residence.originSettlementId, 'settlement:old-wren');
  assert.equal(onTrain.residence.residenceSettlementId, 'settlement:barrow-cross');
  assert.equal(onTrain.location.kind, 'train-seat');
});

test('a train seat carries the run, carriage, and seat uniqueness tuple', () => {
  const seat = createNpcLocation('train-seat', {
    runId: 'run:rail:0099', carriageId: 'carriage:1', seatId: 'seat:3',
  });
  assert.deepEqual(seat, {
    kind: 'train-seat', runId: 'run:rail:0099', carriageId: 'carriage:1', seatId: 'seat:3',
  });
  assert.equal(sameNpcLocation(seat, { ...seat }), true);
  assert.equal(sameNpcLocation(seat, { ...seat, runId: 'run:rail:0100' }), false);
  assert.equal(sameNpcLocation(seat, { ...seat, carriageId: 'carriage:0' }), false);
  assert.equal(sameNpcLocation(seat, { ...seat, seatId: 'seat:2' }), false);
});

test('snapshots survive JSON serialization and restore canonically', () => {
  const state = createNpcSpatialState({
    residence,
    location: createNpcLocation('station-platform', {
      stationId: 'station:2', platformId: 'platform:2:a', waitAnchorId: 'wait:2:a:1',
    }),
  });
  const serialized = JSON.stringify(npcSpatialSnapshot(state));
  const restored = normalizeNpcSpatialState(JSON.parse(serialized));
  assert.deepEqual(restored, state);
  assert.equal(Object.isFrozen(restored), true);
  assert.equal(Object.isFrozen(restored.residence), true);
  assert.equal(Object.isFrozen(restored.location), true);
});

test('malformed and ambiguous values are safely rejected', () => {
  for (const value of [
    null,
    [],
    {},
    { kind: 'unknown', siteId: 'site:x' },
    { kind: 'world-site', siteId: '' },
    { kind: 'world-site', siteId: ' site:x' },
    { kind: 'settlement-node', settlementId: 'settlement:x' },
    { kind: 'regional-edge', edgeId: 'edge:x', fromKey: 'a', toKey: 'b', progress: -0.01 },
    { kind: 'regional-edge', edgeId: 'edge:x', fromKey: 'a', toKey: 'b', progress: 1.01 },
    { kind: 'regional-edge', edgeId: 'edge:x', fromKey: 'a', toKey: 'b', progress: NaN },
    { kind: 'train-seat', runId: 'run:1', carriageId: 'carriage:0' },
    { kind: 'train-seat', runId: 'run:1', carriageId: 'carriage:0', seatId: 'seat:0', passengerId: 'npc:x' },
  ]) assert.equal(normalizeNpcLocation(value), null);

  assert.throws(() => createNpcLocation('regional-edge', {
    edgeId: 'edge:x', fromKey: 'a', toKey: 'b', progress: Infinity,
  }), TypeError);
  assert.throws(() => createNpcResidence({
    originSettlementId: 'settlement:a', residenceSettlementId: '',
  }), TypeError);
});
