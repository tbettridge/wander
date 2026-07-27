import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { XR_BUTTON_BINDINGS, xrActionItems } from '../src/xractions.mjs';

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
assert.equal(xrActionItems({ mode: 'board' }).at(-1).action, 'BOARD TRAIN');
assert.deepEqual(xrActionItems({ mode: 'riding' }).map((item) => item.action),
  ['ALIGHT', 'SWITCH SEAT']);

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

console.log('xractions PASS · LS run · A jump · B board/alight · X physical seat switch · in-headset cues');
