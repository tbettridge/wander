import test from 'node:test';
import assert from 'node:assert/strict';
import { NPC_JOURNEY_LANTERN as P, createJourneyLanternPool, stepJourneyLanternPool, journeyLanternBeaconLevel, outsideLanternVillages, walkingLanternTraveller, interSettlementWalkingEntity } from '../src/npcjourneylantern.mjs';
const viewer = { x: 0, y: 0, z: 0 };
const lights = Array.from({ length: 40 }, (_, i) => ({ id: `walker:${i}`, x: i + 1, y: 1, z: 1 }));
const converge = (pool, sources, opts = {}) => { for (let i = 0; i < 120; i++) stepJourneyLanternPool(pool, sources, viewer, 1, 1 / 60, opts); };
test('moving lights follow their travellers without fading or teleporting between owners', () => {
  const pool = createJourneyLanternPool(); converge(pool, lights);
  assert.equal(pool.filter(s => s.level > .99).length, 3);
  const moved = lights.map(p => ({ ...p, x: p.x + .1 }));
  stepJourneyLanternPool(pool, moved, viewer, 1, 1 / 60);
  assert.ok(pool.every(s => s.level > .99));
  assert.equal(pool[0].source.x, moved.find(p => p.id === pool[0].id).x);
  const next = [{ id: 'new', x: 1, y: 1, z: 1 }, ...moved.slice(20)];
  stepJourneyLanternPool(pool, next, viewer, 1, .1);
  assert.ok(pool.every(s => s.level === 0), 'removed travellers immediately release their old light');
  converge(pool, next); assert.ok(pool.some(s => s.id === 'new' && s.level > .99));
});
test('density, VR, daytime and culling stay within fixed light budgets', () => {
  const pool = createJourneyLanternPool(); converge(pool, lights);
  assert.equal(pool.length, P.desktopLights);
  converge(pool, lights, { xr: true }); assert.equal(pool.filter(s => s.level > .01).length, 1);
  for (let i = 0; i < 120; i++) stepJourneyLanternPool(pool, lights, viewer, 0, .1);
  assert.ok(pool.every(s => s.level === 0));
  converge(pool, lights.map(p => ({ ...p, x: 1000 }))); assert.ok(pool.every(s => s.level === 0));
  converge(pool, lights, { enabled: false }); assert.ok(pool.every(s => s.level === 0));
});
test('far beacons fade beyond avatar range and stop at 800 metres', () => {
  assert.equal(journeyLanternBeaconLevel(500), 1);
  assert.ok(journeyLanternBeaconLevel(650) > .5);
  assert.equal(journeyLanternBeaconLevel(800), 0);
  assert.equal(journeyLanternBeaconLevel(1500), 0);
});
test('only outdoor walking journeys carry lanterns, excluding villages and trains', () => {
  assert.equal(walkingLanternTraveller({ roaming: true, journey: { phase: 'travel' } }), true);
  assert.equal(walkingLanternTraveller({ roaming: true, journey: { phase: 'transfer' } }), true);
  assert.equal(walkingLanternTraveller({ roaming: true, journey: { phase: 'loiter' } }), false);
  assert.equal(walkingLanternTraveller({ mobilityPose: { mode: 'walk' } }, { location: { kind: 'regional-edge' } }), true);
  assert.equal(walkingLanternTraveller({ mobilityPose: { mode: 'walk', railPhase: 'boarding' } }), false);
  assert.equal(walkingLanternTraveller({ mobilityPose: { mode: 'walk', seated: true } }), false);
  assert.equal(walkingLanternTraveller({ mobilityPose: { mode: 'idle' } }), false);
  assert.equal(outsideLanternVillages({ x: 20, z: 20 }, [{ x: 0, z: 0, radius: 200 }]), false);
  assert.equal(outsideLanternVillages({ x: 300, z: 0 }, [{ x: 0, z: 0, radius: 200 }]), true);
});


test('local village strolls and platform pacing are not inter-settlement journeys', () => {
  const stroll = { location: { kind: 'settlement-node', settlementId: 'a' }, activity: { executor: { fromLocation: { settlementId: 'a' }, toLocation: { settlementId: 'a' } } } };
  assert.equal(interSettlementWalkingEntity(stroll), false);
  assert.equal(walkingLanternTraveller({ mobilityPose: { mode: 'walk' } }, stroll), false);
  assert.equal(interSettlementWalkingEntity({ location: { kind: 'station-platform' } }), false);
  assert.equal(interSettlementWalkingEntity({ activity: { executor: { fromLocation: { settlementId: 'a' }, toLocation: { settlementId: 'b' } } } }), true);
});
