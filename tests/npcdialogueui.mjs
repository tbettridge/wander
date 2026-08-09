import assert from 'node:assert/strict';
import { NPC_DIALOGUE_PANEL_STYLE } from '../src/npcdialogueui.mjs';

assert.equal(NPC_DIALOGUE_PANEL_STYLE.right, '18px');
assert.equal(NPC_DIALOGUE_PANEL_STYLE.bottom, '18px');
assert.equal(NPC_DIALOGUE_PANEL_STYLE.left, 'auto');
assert.equal(NPC_DIALOGUE_PANEL_STYLE.transform, 'none');
assert.match(NPC_DIALOGUE_PANEL_STYLE.width, /420px/);
assert.match(NPC_DIALOGUE_PANEL_STYLE.width, /100vw - 24px/);
assert.match(NPC_DIALOGUE_PANEL_STYLE.maxHeight, /480px/);
assert.match(NPC_DIALOGUE_PANEL_STYLE.maxHeight, /100vh - 32px/);

console.log('npcdialogueui PASS · compact responsive panel docked bottom-right');
