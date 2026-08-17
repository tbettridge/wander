import test from 'node:test';
import assert from 'node:assert/strict';
import { TRAILER_SHOTS, TRAILER_TIMELINE, validateTrailerPlan } from '../src/trailerplan.mjs';

test('approved trailer shot list is unique and exactly 92 seconds with titles', () => {
  assert.equal(validateTrailerPlan(), true);
  assert.equal(new Set(TRAILER_SHOTS.map((shot) => shot.id)).size, TRAILER_SHOTS.length);
  assert.equal(TRAILER_TIMELINE.footageDuration, 86);
  assert.equal(TRAILER_TIMELINE.totalDuration, 92);
  assert.equal(TRAILER_SHOTS.find((shot) => shot.id === '01_mountain_reveal')?.duration, 10);
  assert.equal(TRAILER_SHOTS.find((shot) => shot.id === '01_mountain_reveal')?.qualityLevel, 4);
  assert.equal(TRAILER_SHOTS.find((shot) => shot.id === '04a_crossing_stones')?.duration, 1);
  assert.equal(TRAILER_SHOTS.find((shot) => shot.id === '04b_plank_bridge_zoom')?.duration, 4);
  assert.equal(TRAILER_SHOTS.find((shot) => shot.id === '04b_plank_bridge_zoom')?.qualityLevel, 4);
  assert.equal(TRAILER_SHOTS.find((shot) => shot.id === '04b_plank_bridge_zoom')?.travelMeters, 28);
  assert.equal(TRAILER_SHOTS.find((shot) => shot.id === '05_wildlife')?.duration, 5);
  assert.equal(TRAILER_SHOTS.some((shot) => shot.id === '04b_crossing_log'), false);
  assert.equal(TRAILER_SHOTS.some((shot) => shot.id === '04c_crossing_bridge'), false);
  assert.equal(TRAILER_SHOTS.find((shot) => shot.id === '11_player_train')?.qualityLevel, 2);
  assert.equal(TRAILER_SHOTS.find((shot) => shot.id === '09_npc_memory')?.duration, 5);
  assert.equal(TRAILER_SHOTS.find((shot) => shot.id === '10_market')?.duration, 10);
  assert.equal(TRAILER_SHOTS.find((shot) => shot.id === '12_cave_exit')?.duration, 7);
  assert.equal(TRAILER_SHOTS.find((shot) => shot.id === '12_cave_exit')?.qualityLevel, 3);
});
