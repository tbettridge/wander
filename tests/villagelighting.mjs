import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VILLAGE_LIGHTING, createVillageLightField, createVillageLightPool, stepVillageLightPool,
  villageGroundBounds, villageNightLevel, villageLightShaderChunk, enableVillageActorLighting, villageDirectLightShaderChunk,
} from '../src/villagelighting.mjs';
const light = (id, x = 0, z = 0) => ({ id, x, y: 3, z });
const viewer = { x: 0, y: 0, z: 0 }, receiver = { x: 0, y: 1.2, z: 0, player: true };
const converge = (pool, lights, receivers = [receiver], opts = {}) => {
  for (let i = 0; i < 120; i++) stepVillageLightPool(pool, lights, receivers, viewer, 1, 1 / 60, opts);
};

test('lantern bake follows facing and finite falloff, independently of dynamic slots', () => {
  const field = createVillageLightField([light('a')]);
  const ground = { x: 0, y: 0, z: 0 };
  assert.ok(field.sample(ground) > 0.25);
  assert.equal(field.sample(ground, { x: 0, y: -1, z: 0 }), 0);
  assert.equal(field.sample({ x: VILLAGE_LIGHTING.range, y: 0, z: 0 }), 0);
  assert.ok(field.sample({ x: 6, y: 0, z: 0 }) < field.sample(ground));
  const before = field.sample(ground), pool = createVillageLightPool();
  converge(pool, field.lights);
  assert.ok(pool.some(s => s.level > .99));
  assert.equal(field.sample(ground), before);
});

test('bake blocks house interiors and opposite walls, including rotated buildings', () => {
  for (const yaw of [0, Math.PI / 4, Math.PI / 2]) {
    const rotate = (x, z) => ({ x: Math.cos(yaw) * x + Math.sin(yaw) * z, z: -Math.sin(yaw) * x + Math.cos(yaw) * z });
    const source = { id: 'a', ...rotate(0, 5), y: 2.5 };
    const field = createVillageLightField([source], [{ x: 0, y: 0, z: 0, yaw, width: 4, depth: 4, floorCount: 1, floorHeight: 4 }]);
    assert.equal(field.sample({ ...rotate(0, -4), y: 0 }), 0);
    assert.equal(field.sample({ x: 0, y: 0, z: 0 }), 0);
    assert.ok(field.sample({ ...rotate(0, 4), y: 0 }) > 0);
  }
});

test('ground atlas bounds contain every light and its falloff and cap texture memory', () => {
  assert.equal(villageGroundBounds([]), null);
  const bounds = villageGroundBounds([light('a', -100, -120), light('b', 100, 150)]);
  assert.ok(bounds.minX <= -100 - VILLAGE_LIGHTING.range);
  assert.ok(bounds.minZ + bounds.depth >= 150 + VILLAGE_LIGHTING.range);
  assert.ok(bounds.size <= 256);
  assert.ok(bounds.size ** 2 * 4 <= 256 * 1024);
});

test('crowds and lantern density never exceed the fixed desktop or XR pool', () => {
  const lights = Array.from({ length: 80 }, (_, i) => light(String(i), Math.sin(i) * 5, Math.cos(i) * 5));
  const receivers = Array.from({ length: 150 }, (_, i) => ({ x: Math.sin(i) * 4, y: 1, z: Math.cos(i) * 4 }));
  const pool = createVillageLightPool();
  converge(pool, lights, receivers);
  assert.equal(pool.length, 6); assert.equal(pool.filter(s => s.level > .01).length, 6);
  converge(pool, lights, receivers, { xr: true });
  assert.equal(pool.filter(s => s.level > .01).length, 2);
  assert.equal(new Set(pool.filter(s => s.source).map(s => s.source.id)).size, 2);
});

test('light slots fade before relocation, and discarded villages cannot retain lights', () => {
  const pool = createVillageLightPool(), a = light('a'), b = light('b', 8);
  converge(pool, [a]);
  const slot = pool.find(s => s.source?.id === 'a');
  const before = slot.level;
  stepVillageLightPool(pool, [a, b], [{ x: 8, y: 1, z: 0 }], viewer, 1, 1 / 60, { blocked: source => source.id === 'a' });
  assert.equal(slot.source.id, 'a'); assert.ok(slot.level < before && slot.level > 0.5);
  converge(pool, [a, b], [{ x: 8, y: 1, z: 0 }], { blocked: source => source.id === 'a' });
  assert.ok(pool.some(s => s.source?.id === 'b' && s.level > .99));
  stepVillageLightPool(pool, [], [receiver], viewer, 1, 1 / 60);
  assert.ok(pool.every(s => s.source === null && s.level === 0));
});

test('occluded, distant and daytime receivers cannot spend light slots', () => {
  for (const [receivers, night, options] of [
    [[receiver], 1, { blocked: () => true }],
    [[{ x: 50, y: 1, z: 0 }], 1, {}],
    [[receiver], 0, {}], [[receiver], 1, { enabled: false }],
  ]) {
    const pool = createVillageLightPool();
    for (let i = 0; i < 60; i++) stepVillageLightPool(pool, [light('a')], receivers, viewer, night, .016, options);
    assert.ok(pool.every(s => !s.source && s.level === 0));
  }
});

test('retention avoids light reassignment when receivers jitter between neighbours', () => {
  const pool = createVillageLightPool(), lights = Array.from({ length: 7 }, (_, i) => light(String(i), i - 3));
  converge(pool, lights);
  const initial = pool.map(s => s.source?.id);
  for (let i = 0; i < 200; i++) {
    stepVillageLightPool(pool, lights, [{ ...receiver, x: i % 2 ? .02 : -.02 }], viewer, 1, .016);
  }
  assert.deepEqual(pool.map(s => s.source?.id), initial);
});

test('only opted-in moving materials receive native village lights; other light types are untouched', () => {
  const source = 'void getPointLightInfo( const in PointLight pointLight, const in vec3 geometryPosition, out IncidentLight light ) {\nlight.color = pointLight.color;\n}';
  const patched = villageLightShaderChunk(source);
  assert.match(patched, /ifndef WANDER_VILLAGE_ACTOR/);
  assert.match(patched, /pointLight.distance == 12.03125/);
  assert.equal(villageLightShaderChunk(patched), patched);
  assert.throws(() => villageLightShaderChunk('incompatible chunk'), /Unsupported/);
  const material = { defines: { EXISTING: 1 } };
  enableVillageActorLighting(material);
  assert.deepEqual(material.defines, { EXISTING: 1, WANDER_VILLAGE_ACTOR: 1 });
  assert.equal(material.needsUpdate, true);
  assert.equal(villageNightLevel(0), 0); assert.equal(villageNightLevel(.25), 0);
  assert.ok(Math.abs(villageNightLevel(.475) - .5) < 1e-12); assert.ok(Math.abs(villageNightLevel(.7) - 1) < 1e-12);
});


test('empty slots and static surfaces skip the point-light BRDF without changing directional lighting', () => {
  const point = 'getPointLightInfo( pointLight, geometryPosition, directLight );\nRE_Direct( directLight, material, reflectedLight );';
  const directional = 'getDirectionalLightInfo( directionalLight, directLight );\nRE_Direct( directLight, material, reflectedLight );';
  const patched = villageDirectLightShaderChunk(point + '\n' + directional);
  assert.match(patched, /if \( directLight.visible \)/);
  assert.ok(patched.endsWith(directional));
  assert.equal(villageDirectLightShaderChunk(patched), patched);
  assert.throws(() => villageDirectLightShaderChunk('unsupported'), /Unsupported/);
});

test('a regenerated layout cannot move an illuminated slot under the same fixture id', () => {
  const pool = createVillageLightPool(); converge(pool, [light('a')]);
  const slot = pool.find(s => s.source?.id === 'a');
  assert.ok(slot.level > .99);
  stepVillageLightPool(pool, [light('a', 3)], [receiver], viewer, 1, .016);
  assert.ok(slot.level < .01);
  assert.equal(villageNightLevel(NaN), 0);
});
