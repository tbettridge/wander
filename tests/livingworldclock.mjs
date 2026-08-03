import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceLivingWorldClock,
  createLivingWorldClock,
  normalizeLivingWorldClock,
  snapshotLivingWorldClock,
} from '../src/livingworldclock.mjs';

test('living-world time advances only while the simulation is active', () => {
  const clock = createLivingWorldClock({ worldHours: 12, activeSeconds: 3 });
  advanceLivingWorldClock(clock, { dt: 2, hours: 0.5, active: false });
  assert.deepEqual(snapshotLivingWorldClock(clock), { activeSeconds: 3, worldHours: 12 });
  advanceLivingWorldClock(clock, { dt: 2, hours: 0.5, active: true });
  assert.deepEqual(snapshotLivingWorldClock(clock), { activeSeconds: 5, worldHours: 12.5 });
});

test('clock normalization rejects negative and non-finite catch-up', () => {
  assert.deepEqual(snapshotLivingWorldClock(normalizeLivingWorldClock({
    activeSeconds: -1,
    worldHours: Infinity,
  })), { activeSeconds: 0, worldHours: 0 });
});
