import test from 'node:test';
import assert from 'node:assert/strict';
import { LANDING_STAGES, landingCopy, landingCreep, landingElapsed, landingStage } from '../src/landingprogress.mjs';
import { waterPlanningMessage } from '../src/hydrologystream.mjs';

test('the loading messages the game actually sends move the bar forward, in order', () => {
  const messages = [
    'generating terrain…',
    waterPlanningMessage(null, true),
    waterPlanningMessage({ completed: 5, total: 25, reused: 0 }, true),
    waterPlanningMessage({ completed: 20, total: 25, reused: 0 }, true),
    waterPlanningMessage({ completed: 25, total: 25, reused: 0 }, true),
    'Preparing the terrain around your lake…',
    'Preparing your lakeshore… 4 of 9 surrounding areas prepared.',
    'Preparing terrain…',
    'Preparing shaders… 40 left', 'Preparing shaders… 10 left',
    'Preparing the courier communities and their roads…',
    'Preparing your courier starting place…',
    'ready — click to walk',
  ];
  let last = -1, shaders = null;
  for (const message of messages) {
    const left = message.match(/(\d+) left/); if (left && shaders === null) shaders = Number(left[1]);
    const reading = landingStage(message, { shadersAtStart: shaders });
    assert.equal(reading.error, false, message);
    assert.ok(reading.fraction >= last, message + ' went backwards: ' + reading.fraction + ' < ' + last);
    assert.ok(!/[{}]|undefined/.test(reading.label), reading.label);
    last = reading.fraction;
  }
  assert.equal(last, 1);
  assert.equal(landingStage(waterPlanningMessage({ completed: 12, total: 25, reused: 0 }, true)).label, 'Laying out rivers, lakes and valleys · 12 of 25');
});
test('the landscape’s own words say whether the world was made or restored', () => {
  assert.equal(landingStage(waterPlanningMessage({ completed: 6, total: 25, reused: 6 }, true)).cached, true);
  assert.equal(landingStage(waterPlanningMessage({ completed: 6, total: 25, reused: 0 }, true)).cached, false);
  assert.equal(landingStage(waterPlanningMessage({ completed: 1, total: 25, reused: 0 }, true)).cached, null, 'too early to tell');
});
test('a failure is shown as it is, not as progress', () => {
  for (const message of ['Could not prepare this landscape. Reload to retry.', 'Courier start unavailable: Three connected courier communities could not be found.']) {
    const reading = landingStage(message);
    assert.equal(reading.error, true); assert.equal(reading.label, message);
  }
});
test('a long step keeps creeping but never reaches the next', () => {
  const reading = landingStage('Preparing terrain…'), terrain = LANDING_STAGES.find(stage => stage.id === 'terrain');
  assert.equal(landingCreep(reading, 0), terrain.from);
  assert.ok(landingCreep(reading, 10) > landingCreep(reading, 2));
  assert.ok(landingCreep(reading, 10_000) < terrain.to);
  assert.equal(landingCreep(landingStage('ready — click to walk'), 50), 1);
});
test('a first visit is told the world is made once; a return visit that it is only opened', () => {
  const first = landingCopy({ firstBuild: true });
  assert.equal(first.title, 'Creating your world');
  assert.match(first.note, /only once/); assert.match(first.note, /minute or two/); assert.match(first.note, /opens much faster/);
  const again = landingCopy({ firstBuild: false });
  assert.equal(again.title, 'Opening your world'); assert.match(again.note, /saved on this device/);
  assert.deepEqual([0, 9, 61, 125].map(landingElapsed), ['0:00', '0:09', '1:01', '2:05']);
});
