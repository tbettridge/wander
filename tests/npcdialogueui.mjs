import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NPC_DIALOGUE_PANEL_STYLE } from '../src/npcdialogueui.mjs';

assert.equal(NPC_DIALOGUE_PANEL_STYLE.right, '18px');
assert.equal(NPC_DIALOGUE_PANEL_STYLE.bottom, '18px');
assert.equal(NPC_DIALOGUE_PANEL_STYLE.left, 'auto');
assert.equal(NPC_DIALOGUE_PANEL_STYLE.transform, 'none');
assert.match(NPC_DIALOGUE_PANEL_STYLE.width, /420px/);
assert.match(NPC_DIALOGUE_PANEL_STYLE.width, /100vw - 24px/);
assert.match(NPC_DIALOGUE_PANEL_STYLE.maxHeight, /480px/);
assert.match(NPC_DIALOGUE_PANEL_STYLE.maxHeight, /100vh - 32px/);

const [indexHtml, mainSource] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
]);
assert.match(indexHtml, /src="\.\/src\/main\.js\?v=79"/);
assert.match(mainSource, /from '\.\/stationkeeper\.js\?v=npcdialoguecorner1'/);

console.log('npcdialogueui PASS · compact bottom-right panel · deployed imports versioned');
