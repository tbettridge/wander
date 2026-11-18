// The keeper's path. Firth Lighthouse is on the courier's round, so a trail
// runs to the foot of its ramp from the nearest networked landmark. This
// locks in that the spur exists on the real world, that it ends at the house
// entrance the keeper's resident plan uses, and that it is only drawn where
// trails are kept clear of buildings (the planning network has no spurs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { trailsAround, clearTrailCache } from '../src/trails.js';
import { majorLandmarksAround } from '../src/landmarks.js';
import { lighthousePlanInWorld, lighthouseTrailhead } from '../src/lighthouseplan.mjs';
import { lighthouseResidentPlan } from '../src/lighthouseresidents.mjs';

const world = new World(20260612);
const seed = world.seed;
const light = majorLandmarksAround(world, 0, 0, seed, 12000, []).find(lm => lm.type === 'lighthouse');

test('a trail runs to the foot of the lighthouse ramp', () => {
  assert.ok(light, 'the test world has a lighthouse near the post town');
  clearTrailCache();
  const edges = [];
  trailsAround(world, light.x, light.z, seed, 1500, edges);
  const spur = edges.find(edge => edge.toLighthouse?.key === light.key);
  assert.ok(spur, 'a spur reaches ' + light.key);
  const head = lighthouseTrailhead(lighthousePlanInWorld(world, light));
  assert.ok(Math.hypot(spur.toLighthouse.x - head.x, spur.toLighthouse.z - head.z) < 1, 'it ends at the trailhead below the ramp');
  assert.equal(spur.toLighthouse.nodeKey, light.key + ':entrance');
  const residents = lighthouseResidentPlan(lighthousePlanInWorld(world, light));
  assert.equal(residents.site.regionalEntrance.key, spur.toLighthouse.nodeKey, 'the same entrance the keeper walks from');
  // Asking again gives the same path.
  clearTrailCache();
  const again = [];
  trailsAround(world, light.x, light.z, seed, 1500, again);
  assert.equal(again.find(edge => edge.toLighthouse?.key === light.key)?.id, spur.id);
});

test('the planning network leaves the lighthouse spur out', () => {
  clearTrailCache();
  const edges = [];
  trailsAround(world, light.x, light.z, seed, 1500, edges, { clearOfBuildings: false });
  assert.equal(edges.some(edge => edge.toLighthouse), false);
});
