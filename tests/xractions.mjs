import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  XR_BUTTON_BINDINGS,
  XR_INTRO_HINT_SECONDS,
  xrActionHudVisible,
  xrActionItems,
} from '../src/xractions.mjs';

assert.deepEqual(XR_BUTTON_BINDINGS, {
  run: 'left-stick-click',
  jump: 'A',
  interact: 'B',
  switchSeat: 'X',
});
assert.deepEqual(xrActionItems(), [
  { button: 'LS', action: 'PRESS TO RUN' },
  { button: 'A', action: 'JUMP' },
]);
assert.deepEqual(xrActionItems({ mode: 'board' }), [
  { button: 'B', action: 'BOARD TRAIN' },
]);
assert.deepEqual(xrActionItems({ mode: 'riding' }).map((item) => item.action),
  ['ALIGHT', 'SWITCH SEAT']);
assert.equal(xrActionHudVisible(null, XR_INTRO_HINT_SECONDS), true,
  'locomotion legend should appear at session start');
assert.equal(xrActionHudVisible(null, 0), false,
  'locomotion legend should dismiss after its intro window');
assert.equal(xrActionHudVisible({ mode: 'board' }, 0), true,
  'a contextual boarding prompt must remain visible after onboarding');

const [controls, railservice, hud] = await Promise.all([
  readFile(new URL('../src/controls.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/railservice.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/xractionhud.js', import.meta.url), 'utf8'),
]);
assert.match(controls, /this\.xrActions\.run \|\|= !!gp\.buttons\?\.\[3\]/,
  'left stick click must enable VR run');
assert.match(controls, /jumpHeld \|\|= !!gp\.buttons\?\.\[4\]/,
  'Quest A must queue jump');
assert.match(controls, /interactHeld \|\|= !!gp\.buttons\?\.\[5\]/,
  'Quest B must be the contextual action');
assert.match(railservice, /xrSwitchSeat/,
  'train service must consume the XR switch-seat edge');
assert.match(railservice, /const seats = SEAT_LAYOUT\.map/,
  'seat switching must move between physical carriage anchors');
assert.match(hud, /camera\.add\(this\.sprite\)/,
  'controller and train cues must render inside the headset');
assert.match(hud, /this\.introRemaining[\s\S]*XR_INTRO_HINT_SECONDS/,
  'in-headset locomotion legend must have a session intro timer');

console.log('xractions PASS · LS run · A jump · B board/alight · X physical seat switch · in-headset cues');
