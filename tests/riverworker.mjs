import assert from 'node:assert/strict';
import { World as LegacyWorld } from './fixtures/legacy-river-world.mjs';
import { World } from '../src/world.js';
import { buildTerrainArrays, buildRiver } from '../src/chunkgen.js';

// Reproduce a returning browser loading the new mesher with a cached World
// that predates signedDepth. Physics saw water but every mesh was null.
const oldWorld = new LegacyWorld(20260612);
assert.ok(oldWorld.riverAt(-550, -960).wet);
const legacyTerrain = buildTerrainArrays(oldWorld, -4, -7, 96, 140);
assert.ok(legacyTerrain.river, 'legacy water disappeared during terrain sampling');
const legacyMesh = buildRiver(-4, -7, 96, 140, legacyTerrain.river);
assert.ok(legacyMesh?.indices.length, 'cached World produced invisible water');
assert.ok(legacyMesh.wet.some(depth => depth > 0.3), 'river has no visibly submerged interior');

// Exercise the actual worker entry point and transferable payload, including
// the ordinary trail-building step omitted by the standalone river lab.
const messages = [];
globalThis.self = {
  postMessage(message, transfer = []) {
    messages.push(structuredClone(message, { transfer }));
  },
};
await import('../src/worker.js');
self.onmessage({ data: { type: 'init', seed: 20260612 } });
self.onmessage({ data: {
  type: 'build', id: 1, cx: -4, cz: -7, res: 48, chunkSize: 140, doTerrain: true,
} });
const result = messages.at(-1);
assert.equal(result.type, 'built');
assert.ok(result.river?.indices.length, 'worker dropped the river surface');
assert.ok(result.river.wet.some(depth => depth > 1), 'worker erased shader depth');
for (const key of ['positions', 'wet', 'flow']) {
  assert.ok(result.river[key].every(Number.isFinite), `worker sent invalid ${key}`);
}
const terrain = buildTerrainArrays(new World(20260612), -4, -7, 48, 140);
const direct = buildRiver(-4, -7, 48, 140, terrain.river);
for (const key of ['positions', 'wet', 'flow', 'indices']) {
  assert.deepEqual(result.river[key], direct[key], `worker/main disagree on ${key}`);
}
delete globalThis.self;
console.log('riverworker PASS · cached World compatibility · visible depth · transferable worker/main agreement');
