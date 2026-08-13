import assert from 'node:assert/strict';
import {
  RAIL_CARRIAGE,
  carriageAisleStandForSeat,
  carriageDoorIsPassable,
  carriageThresholdCrossing,
  nearestCarriageSeat,
  resolveCarriageMovementLocal,
} from '../src/railcarriage.mjs';

const move = (previous, target, doorFactor, includeBenches = true) => {
  const position = { ...target };
  const result = resolveCarriageMovementLocal(position, previous, {
    doorFactor, includeBenches,
  });
  return { position, result };
};

assert.equal(carriageDoorIsPassable(0), false,
  'a closed panel must seal the physical threshold');
assert.equal(carriageDoorIsPassable(1), true,
  'a fully retracted panel must leave a capsule-wide opening');
assert.equal(carriageThresholdCrossing(
  { x: 1.6, z: 0 }, { x: 1.0, z: 0 }, { doorFactor: 0, direction: 'enter' },
), null, 'closed doors must never produce boarding');
assert.deepEqual(
  carriageThresholdCrossing(
    { x: 1.6, z: 0 }, { x: 1.0, z: 0 }, { doorFactor: 1, direction: 'enter' },
  )?.entering,
  true,
  'walking across an open doorway must produce boarding',
);
assert.equal(carriageThresholdCrossing(
  { x: 1.6, z: 0 }, { x: -0.2, z: 0 }, { doorFactor: 1, direction: 'enter' },
), null, 'large teleports must not masquerade as walking aboard');

const sealed = move({ x: 1.7, z: 0 }, { x: 0.8, z: 0 }, 0, false);
assert.equal(sealed.result.blocked, true);
assert.ok(sealed.position.x > RAIL_CARRIAGE.wallX,
  'the closed door must keep an outside capsule outside');
const open = move({ x: 1.7, z: 0 }, { x: 0.8, z: 0 }, 1);
assert.equal(open.result.blocked, false,
  'the open threshold must admit an ordinary walking step');

const wall = move({ x: 0.7, z: 1.2 }, { x: 1.4, z: 1.2 }, 1);
assert.equal(wall.result.blocked, true);
assert.ok(wall.position.x <= RAIL_CARRIAGE.wallX - RAIL_CARRIAGE.playerRadius + 0.01,
  'carriage walls must keep a standing passenger inside while moving');
const end = move({ x: 0, z: 2.8 }, { x: 0, z: 3.8 }, 1);
assert.equal(end.result.blocked, true,
  'end walls must prevent leaving the passenger car between vehicles');

const throughGangway = { x: 0, z: 3.82 };
const gangwayResult = resolveCarriageMovementLocal(
  throughGangway, { x: 0, z: 3.1 }, { doorFactor: 1, interCarEnd: 1 },
);
assert.equal(gangwayResult.blocked, false,
  'the coupled end doorway must admit an ordinary walking step onto the gangway');
const besideGangway = { x: 0.9, z: 3.82 };
const besideResult = resolveCarriageMovementLocal(
  besideGangway, { x: 0.9, z: 3.1 }, { doorFactor: 1, interCarEnd: 1 },
);
assert.equal(besideResult.blocked, true,
  'the end wall must remain solid beside the centred inter-car doorway');
const gangwayGuard = { x: 0.8, z: 4.15 };
const guardResult = resolveCarriageMovementLocal(
  gangwayGuard, { x: 0, z: 4.0 }, { doorFactor: 1, interCarEnd: 1 },
);
assert.equal(guardResult.blocked, true,
  'gangway guards must keep a passenger on the narrow bridge between cars');

assert.equal(nearestCarriageSeat(0, 1.5)?.index, 0,
  'a passenger standing in the aisle can select the adjacent seat');
assert.equal(nearestCarriageSeat(0, 1.5, (index) => index === 0)?.index, 1,
  'an occupied seat is skipped for the opposite available bench');
assert.deepEqual(carriageAisleStandForSeat(0), {
  x: -RAIL_CARRIAGE.aisleStandX,
  y: RAIL_CARRIAGE.floorY,
  z: 1.5,
  yaw: -Math.PI * 0.5,
});

assert.ok(RAIL_CARRIAGE.ceilingY - RAIL_CARRIAGE.floorY >= 2.3,
  'the authored interior must clear a standing first-person camera');
assert.equal(RAIL_CARRIAGE.sideHeaderBottomY
  + (RAIL_CARRIAGE.ceilingY - RAIL_CARRIAGE.sideHeaderBottomY), RAIL_CARRIAGE.ceilingY,
  'the raised side header must close directly against the ceiling');
assert.ok(RAIL_CARRIAGE.sideHeaderBottomY - RAIL_CARRIAGE.floorY >= 2.0,
  'the raised doorway lintel must preserve standing head clearance');
assert.ok(RAIL_CARRIAGE.sideHeaderBottomY - RAIL_CARRIAGE.windowTrimThickness
  - (RAIL_CARRIAGE.sideSillTopY + RAIL_CARRIAGE.windowTrimThickness) >= 1.3,
  'the rebuilt surround must retain tall panoramic side windows');

console.log('railcarriage PASS · physical threshold · moving interior · optional seating · head clearance');
