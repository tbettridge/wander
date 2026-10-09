import test from 'node:test';
import assert from 'node:assert/strict';
import { createNpcLocomotionState, advanceNpcLocomotion, carryNpcLocomotion } from '../src/npclocomotion.mjs';
import { npcBindDimensions } from '../src/npcanatomy.mjs';
import { npcRailSeatJointPose, npcRailCarriageLocalPose, createNpcRailTransfer } from '../src/npcrailtransfer.mjs';
import { RAIL_CARRIAGE } from '../src/railcarriage.mjs';
import { createServiceRunId } from '../src/railpassengers.mjs';
import { railPublicPassengerManifest } from '../src/npcmobility.mjs';

const dims = npcBindDimensions({ legScale: 1, build: 1, headScale: 1 });
const translation = (x, y, z) => [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];
const surface = (y) => () => ({ y, normal: [0,1,0], supportId: 'train', surfaceKind: 'train', walkable: true });

test('a standing passenger rides a translating floor without walking or dragging planted feet', () => {
  const state = createNpcLocomotionState(0.2);
  advanceNpcLocomotion(state, { dims, dt: 1/60, position: [0,0,0], held: true, surfaceQuery: surface(0) });
  const original = state.gait.feet.map((foot) => [...foot.position]);
  for (let frame=1; frame<=120; frame++) {
    carryNpcLocomotion(state, translation(0.25,0.002,0));
    const pose = advanceNpcLocomotion(state, { dims, dt: 1/60,
      position: [frame*0.25,frame*0.002,0], held: true, surfaceQuery: surface(frame*0.002) });
    assert.ok(pose.locomotion.measuredSpeed < 1e-7);
    assert.equal(pose.locomotion.speed, 0);
    for (let i=0; i<2; i++) {
      assert.ok(Math.abs(state.gait.feet[i].position[0] - frame*0.25 - original[i][0]) < 1e-6);
      assert.ok(Math.abs(state.gait.feet[i].position[1] - frame*0.002 - original[i][1]) < 1e-6);
    }
  }
});

test('a passenger walking inside a moving carriage keeps their own walking pace', () => {
  const state = createNpcLocomotionState(0.2);
  advanceNpcLocomotion(state, { dims, dt: 1/60, position: [0,0,0], surfaceQuery: surface(0) });
  for (let frame=1; frame<=120; frame++) {
    carryNpcLocomotion(state, translation(0.25,0,0));
    const pose = advanceNpcLocomotion(state, { dims, dt: 1/60,
      position: [frame*0.25,0,frame*1.25/60], surfaceQuery: surface(0) });
    assert.ok(Math.abs(pose.locomotion.measuredSpeed - 1.25) < 1e-6);
  }
  assert.ok(state.gait.feet.some((foot) => foot.liftOffs > 0));
});

test('sitting fits the authored cushion, keeps adult feet level and lets shorter legs dangle', () => {
  for (const scale of [0.65, 0.85, 1, 1.15]) {
    const pose = npcRailSeatJointPose({ scale, lowerLegLength: 0.4, ankleY: 0.05 });
    assert.ok(Math.abs((pose.hipY - 0.13)*scale - (RAIL_CARRIAGE.seatSurfaceY - RAIL_CARRIAGE.floorY)) < 1e-9);
    const ankle = pose.hipY - 0.4*Math.cos(pose.thighAngle + pose.shinAngle);
    assert.ok(ankle >= 0.05 - 1e-9);
    if (scale >= 1) assert.ok(Math.abs(ankle - 0.05) < 1e-9);
    assert.ok(Math.abs(pose.thighAngle + pose.shinAngle + pose.footAngle) < 1e-9);
  }
  for (let seatIndex=0; seatIndex<4; seatIndex++) {
    const pose = npcRailCarriageLocalPose(createNpcRailTransfer({ runId: 'run:1', stationId: 'a',
      reservationId: 'r', carriageIndex: 0, seatIndex, platformId: 'a:main', phase: 'seated' }));
    assert.ok(Math.sin(pose.yaw)*pose.x < 0, 'NPCs face the aisle, not the wall');
  }
});

test('guest seat checks use host occupancy across circuits, including standing passengers', () => {
  const oldRun = createServiceRunId({ serviceEpoch: 'route:guest', sequence: 0 });
  const newRun = createServiceRunId({ serviceEpoch: 'route:guest', sequence: 1 });
  const entities = {
    seated: { id: 'seated', kind: 'npc', publicState: {
      location: { kind: 'train-seat', runId: oldRun, carriageId: 'carriage:0', seatId: 'seat:0' } } },
    standing: { id: 'standing', kind: 'npc', publicState: {
      location: { kind: 'train-carriage', runId: oldRun, carriageId: 'carriage:0', zoneId: 'standing:0', seatId: null } } },
  };
  const before = JSON.stringify(entities);
  const manifest = railPublicPassengerManifest(entities, newRun);
  assert.equal(manifest.occupantsInCarriage(0).length, 2);
  assert.equal(manifest.reservationForPerson('standing').seatIndex, null);
  assert.equal(manifest.playerAvailableSeat(0).seatIndex, 3);
  assert.equal(JSON.stringify(entities), before);
});
