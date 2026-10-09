import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILDING_PROGRAMS, createBuildingPlan } from '../src/buildingplan.mjs';
import { interiorLocal, interiorWorld, interiorWalkableClaims, interiorBaseY } from '../src/interiorarchitecture.mjs';
import { planInterior, placementBounds, routeInterior } from '../src/interiorplan.mjs';
import { prepareInteriorRoom } from '../src/interiorgeometry.mjs';
import { desiredInteriorRooms, interiorInterest, INTERIOR_STREAM_POLICY } from '../src/interiorvisibility.mjs';
import { applyInteriorFurniturePose } from '../src/interiornpcpose.mjs';
import { planVenues } from '../src/npcvenues.mjs';
import { StructureCollisionIndex } from '../src/structurecollision.mjs';
import { WalkableSurface } from '../src/walkablesurface.mjs';
import { createNpcSteeringState, advanceNpcSteering } from '../src/npcsteering.mjs';

function building(program, seed) { return createBuildingPlan({ id: `interior:${program}:${seed}`, program, seed, x: 19, y: 8, z: -13, yaw: seed * 0.17 }); }
function environment(b) {
  const state = { portals: Object.fromEntries(b.portals.map(p => [p.id, { progress: 1 }])), features: { interiorsEnabled: true } };
  const collision = new StructureCollisionIndex(() => state);
  collision.registerPlan({ id: b.id, buildings: [b], props: [] });
  const surface = new WalkableSurface({ seed: 1, height: () => interiorBaseY(b), });
  surface.registerClaim({ id: `${b.id}:ground`, y: interiorBaseY(b) + 0.16, contains(x, z) {
    const p = interiorLocal(b, { x, z }); return Math.abs(p.x) <= b.width / 2 && Math.abs(p.z) <= b.depth / 2;
  } });
  surface.registerClaims(interiorWalkableClaims(b));
  return { collision, surface, state };
}

test('1,400 contextual layouts preserve required furnishings, clearance, and determinism', () => {
  let lofts = 0, upper = 0;
  for (const program of BUILDING_PROGRAMS) for (let seed = 1; seed <= 100; seed++) {
    const b = building(program, seed), plan = planInterior(b), { collision } = environment(b);
    assert.deepEqual(plan, planInterior(structuredClone(b)));
    assert.equal(plan.diagnostics.requiredOmissions, 0, b.id);
    lofts += plan.diagnostics.lofts; upper += plan.diagnostics.floors - 1;
    for (const p of plan.placements.filter(p => p.collision)) {
      const box = placementBounds(p), room = plan.rooms.find(r => r.id === p.roomId);
      assert.ok(box.minX >= room.bounds.minX && box.maxX <= room.bounds.maxX && box.minZ >= room.bounds.minZ && box.maxZ <= room.bounds.maxZ, p.id);
      for (const lane of room.reserved) assert.ok(box.maxX <= lane.minX || box.minX >= lane.maxX || box.maxZ <= lane.minZ || box.minZ >= lane.maxZ, `${p.id} blocks circulation`);
    }
    for (const anchor of plan.anchors) {
      const p = interiorWorld(b, anchor);
      assert.equal(collision.collides(p.x, p.z, p.y, 0.29), null, `${anchor.id} blocked`);
    }
    for (const room of plan.rooms.filter(r=>r.purpose==='sleeping'))
      assert.ok(plan.anchors.some(a=>a.roomId===room.id&&a.kind==='sleep'), `${room.id} has no usable bed`);
    for (const level of b.interior.levels.slice(1)) {
      assert.ok(b.floorCount * b.floorHeight - level.y >= 1.9, `${b.id} insufficient headroom`);
      if(level.kind==='loft')for(const part of b.interior.partitions.filter(p=>p.floor===0))
        assert.ok(part.height<level.y-.12, `${b.id} partition closes the loft void`);
      for (const rect of level.rectangles) {
        const s = b.interior.stairs.find(s => s.toFloor === level.index);
        assert.ok(rect.maxX <= s.bounds.minX || rect.minX >= s.bounds.maxX || rect.maxZ <= s.bounds.minZ || rect.minZ >= s.bounds.maxZ, `${b.id} sealed stair hole`);
      }
    }
  }
  assert.ok(lofts > 50 && upper > 500);
});

test('routes clear furniture and partitions and use the same supported floors in both directions', () => {
  for (const program of BUILDING_PROGRAMS) for (let seed = 1; seed <= 8; seed++) {
    const b = building(program, seed), { collision, surface } = environment(b);
    const door = b.portals.find(p => p.kind === 'exterior-door');
    const entrance = interiorWorld(b, { x: door.x, z: b.depth / 2 - 0.55, y: 0.16 });
    for (const anchor of planInterior(b).anchors) {
      const destination = interiorWorld(b, anchor);
      for (const [from, to] of [[entrance, destination], [destination, entrance]]) {
        let previous = from;
        for (const point of routeInterior(b, from, to)) {
          const length = Math.hypot(point.x - previous.x, point.z - previous.z), n = Math.max(1, Math.ceil(length / 0.15));
          for (let i = 1; i <= n; i++) {
            const t = i / n, p = { x: previous.x + (point.x - previous.x) * t, z: previous.z + (point.z - previous.z) * t, y: previous.y + (point.y - previous.y) * t };
            assert.equal(collision.collides(p.x, p.z, p.y, 0.29), null, `${anchor.id}: route blocked at ${JSON.stringify(interiorLocal(b,p))}`);
            const ground = surface.structureAt(p.x, p.z, p.y);
            assert.ok(ground && Math.abs(ground.y - p.y) < 0.22, `${anchor.id}: support disagrees at ${JSON.stringify(interiorLocal(b,p))}`);
          }
          previous = point;
        }
      }
    }
  }
});

test('live NPC steering climbs and descends the top floor without a teleport', () => {
  for (const program of ['infill-house', 'row-house', 'inn', 'barn']) {
    const b = building(program, 2), { collision, surface } = environment(b);
    if (!b.interior.stairs.length) continue;
    const door = b.portals.find(p => p.kind === 'exterior-door'), from = interiorWorld(b, { x: door.x, z: b.depth / 2 - 0.55, y: 0.16 });
    const highest = planInterior(b).anchors.filter(a => a.kind === 'inside').at(-1), to = interiorWorld(b, highest);
    const position = { ...from }, steering = createNpcSteeringState();
    for (const destination of [to, from]) {
      const points = routeInterior(b, position, destination); let index = 0;
      for (let frame = 0; frame < 20000 && index < points.length; frame++) {
        const move = advanceNpcSteering(steering, { position, target: points[index], dt: 1/60, maxSpeed: 1.2,
          arrivalRadius: 0.12, stopRadius: 0.04, resolveMovement: (next, previous) => collision.resolveMovement(next, previous, 0.29) });
        const ground = surface.structureAt(position.x, position.z, position.y + 0.8);
        assert.ok(ground, `${program}: lost support`); position.y = ground.y;
        if (move.arrived) index++;
      }
      assert.equal(index, points.length, `${program}: route stalled`);
      assert.ok(Math.hypot(position.x - destination.x, position.z - destination.z) < 0.3 && Math.abs(position.y - destination.y) < 0.2, `${program}: arrived on wrong floor`);
    }
  }
});

test('worker geometry has finite bounded buffers and survives a serialized building descriptor', () => {
  for (const program of BUILDING_PROGRAMS) {
    const b = building(program, 4);
    for (const room of b.interior.rooms) {
      const data = prepareInteriorRoom(structuredClone(b), room.id);
      let bytes = 0;
      for (const tier of [data.major, data.decoration]) {
        assert.equal(tier.position.length, tier.normal.length); assert.equal(tier.color.length, tier.position.length);
        assert.equal(tier.position.length % 9, 0);
        for (const array of Object.values(tier)) { assert.ok(array.every(Number.isFinite)); bytes += array.byteLength; }
      }
      assert.ok(bytes < 500000, `${room.id}: room exceeds upload ceiling`);
      assert.ok(data.fixtures.length <= 2);
    }
  }
});

test('NPC furniture, window, and doorway venues remain reachable after furnishing', () => {
  for(const program of BUILDING_PROGRAMS)for(let seed=1;seed<=30;seed++){
    const b=building(program,seed),{collision}=environment(b);
    const venues=planVenues({site:{id:b.id},buildings:[b],props:[],localGraph:{nodes:[]}}).buildings[b.id];
    for(const spot of [...venues.inside,...venues.window,...venues.doorway])
      assert.equal(collision.collides(spot.x,spot.z,spot.y,0.29),null,`${spot.id} blocked`);
  }
});

test('entrance momentum prewarms, dense streets are bounded, and current floors win admission', () => {
  const b = building('infill-house', 7), door = b.portals.find(p => p.kind === 'exterior-door');
  const outside = interiorWorld(b, { x: door.x, z: b.depth / 2 + 13, y: 0.16 });
  const inward = { x: -Math.sin(b.yaw) * 2, z: -Math.cos(b.yaw) * 2 };
  assert.equal(interiorInterest(b, outside, inward).approaching, true);
  assert.equal(interiorInterest(b, outside, { x: -inward.x, z: -inward.z }).approaching, false);
  const neighbours = Array.from({ length: 30 }, (_, i) => ({ ...building('inn', i+1), x: b.x + 9 + i * 0.5, z: b.z + 8 }));
  const inside = interiorWorld(b, { x: 0, z: 0, y: b.interior.levels.at(-1).y });
  const wanted = desiredInteriorRooms([...neighbours, b], inside, { x: 0, z: 0 });
  assert.equal(wanted.length, INTERIOR_STREAM_POLICY.maxWarmRooms);
  assert.equal(wanted.filter(r => r.building.id === b.id).length, b.interior.rooms.length);
  assert.ok(wanted.filter(r => r.building.id === b.id && r.room.floor === 2).every(r => r.full));
  assert.equal(desiredInteriorRooms([b], { x: 1000, z: 1000, y: 0 }, { x: 0, z: 0 }).length, 0);
});

test('rollback removes invisible furniture collisions and furniture poses leave actor roots alone', () => {
  const b = building('dwelling', 1), { collision, state } = environment(b);
  const p = planInterior(b).placements.find(p => p.collision), box = placementBounds(p);
  const point = interiorWorld(b, { x: box.minX, z: (box.minZ+box.maxZ)/2, y: p.y });
  assert.ok(collision.collides(point.x, point.z, point.y, 0.29)?.furnishing);
  state.features.interiorsEnabled = false;
  assert.equal(collision.collides(point.x, point.z, point.y, 0.29), null);
  const bone = () => ({ position: { x:0,y:0,z:0 }, rotation: { set(x,y,z) { Object.assign(this,{x,y,z}); } } });
  const bones = Object.fromEntries(['hips','spine','chest',...['left','right'].flatMap(s => ['Thigh','Shin','Foot','UpperArm','Forearm'].map(part => s+part))].map(k => [k,bone()]));
  applyInteriorFurniturePose(bones, { kind:'sit', height:0.55, offsetX:0.4, offsetZ:-0.7 }, 0.8);
  assert.equal(bones.hips.position.y, 0.55/0.8); assert.equal(bones.leftThigh.rotation.x, -Math.PI/2);
  applyInteriorFurniturePose(bones, { kind:'sleep', height:0.66 }, 1);
  assert.equal(bones.hips.rotation.x, -Math.PI/2); assert.equal(bones.leftThigh.rotation.x, 0);
});
