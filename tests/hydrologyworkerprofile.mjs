import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REGIONAL_WINDOW_PROFILE_MAX_MS,
  REGIONAL_WINDOW_PROFILE_MAX_SAMPLES,
  createRegionalWindowProfile,
  recordRegionalWindowPhase,
  snapshotRegionalWindowProfile,
} from '../src/hydrologyworkerprofile.mjs';

test('regional worker profile has a fixed phase shape and records finite durations', () => {
  const profile = createRegionalWindowProfile();
  assert.deepEqual(snapshotRegionalWindowProfile(profile), {
    phaseMs: {
      'cache-read': 0, generation: 0, 'cache-write': 0, finalization: 0, encoding: 0,
    },
    samples: 0,
  });
  recordRegionalWindowPhase(profile, 'generation', 12.5);
  recordRegionalWindowPhase(profile, 'encoding', 3);
  recordRegionalWindowPhase(profile, 'unknown', 100);
  recordRegionalWindowPhase(profile, 'cache-read', -1);
  recordRegionalWindowPhase(profile, 'cache-write', Number.NaN);
  assert.deepEqual(snapshotRegionalWindowProfile(profile), {
    phaseMs: {
      'cache-read': 0, generation: 12.5, 'cache-write': 0, finalization: 0, encoding: 3,
    },
    samples: 2,
  });
});

test('regional worker profile caps duration and sample growth', () => {
  const profile = createRegionalWindowProfile();
  recordRegionalWindowPhase(profile, 'generation', REGIONAL_WINDOW_PROFILE_MAX_MS * 2);
  for (let index = 0; index < REGIONAL_WINDOW_PROFILE_MAX_SAMPLES + 10; index++) {
    recordRegionalWindowPhase(profile, 'generation', 1);
  }
  const snapshot = snapshotRegionalWindowProfile(profile);
  assert.equal(snapshot.phaseMs.generation, REGIONAL_WINDOW_PROFILE_MAX_MS);
  assert.equal(snapshot.samples, REGIONAL_WINDOW_PROFILE_MAX_SAMPLES);
  snapshot.phaseMs.generation = 0;
  assert.equal(profile.phaseMs.generation, REGIONAL_WINDOW_PROFILE_MAX_MS);
});
