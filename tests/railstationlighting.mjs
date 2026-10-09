import test from 'node:test';
import assert from 'node:assert/strict';
import { STATION_LAYOUT, stationLampPositions, stationLightingPlan } from '../src/railstation.mjs';
import { createVillageLightField, createVillageLightPool, stepVillageLightPool } from '../src/villagelighting.mjs';

test('station lamps illuminate raised platforms and respect the rotated station building', () => {
  for (const yaw of [0, Math.PI / 4, Math.PI / 2]) {
    const station = { id: 'test', x: 110, z: -70, formationY: 20, tangentX: Math.sin(yaw), tangentZ: Math.cos(yaw) };
    const worldPoint = (x, y, z) => ({ x: station.x + Math.cos(yaw) * x + Math.sin(yaw) * z, y: 20 + y, z: station.z - Math.sin(yaw) * x + Math.cos(yaw) * z });
    const sources = stationLampPositions().map(s => worldPoint(s.x, s.y, s.z));
    const plan = stationLightingPlan(station), field = createVillageLightField(sources, plan.buildings);
    assert.equal(sources.length, 2);
    const local = stationLampPositions()[0];
    assert.ok(field.sample(worldPoint(local.x, STATION_LAYOUT.platformTop, local.z)) > 0.2);
    assert.equal(field.sample(worldPoint(STATION_LAYOUT.building.across, STATION_LAYOUT.platformTop + 1, 0)), 0);
    assert.ok(field.sample(worldPoint(local.x, STATION_LAYOUT.platformTop, 0)) === 0, 'finite light range leaves the central canopy dark');
    const pool = createVillageLightPool();
    const receiver = worldPoint(local.x, STATION_LAYOUT.platformTop + 1.2, local.z);
    for (let i = 0; i < 120; i++) stepVillageLightPool(pool, field.lights, [receiver], receiver, 1, 1 / 60);
    assert.equal(pool.filter(s => s.level > .99).length, 1);
    assert.equal(plan.site.id, 'railway-station:test');
  }
});
