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

const [indexHtml, mainSource, stationkeeperSource] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/stationkeeper.js', import.meta.url), 'utf8'),
]);
assert.match(indexHtml, /src="\.\/src\/main\.js\?v=86"/);
assert.match(mainSource, /from '\.\/stationkeeper\.js\?v=dialoguehold1'/);
assert.match(mainSource, /from '\.\/livingworld\.mjs\?v=leanturn1'/);
assert.match(mainSource, /from '\.\/livingworldcontext\.mjs\?v=placecontext1'/);
assert.match(mainSource, /from '\.\/settlementstream\.js\?v=dialoguehold1'/);

const talkSource = stationkeeperSource.slice(
  stationkeeperSource.indexOf('\n  talk() {'),
  stationkeeperSource.indexOf('\n  sendMessage() {'),
);
const openingRequestIndex = talkSource.indexOf('requestChatOpening(context)');
assert.ok(openingRequestIndex > 0);
assert.doesNotMatch(talkSource.slice(0, openingRequestIndex), /chatHistory\.push|fallbackDialogue|interactionLine/);
assert.ok(talkSource.indexOf('this.chatHistory.push(greetingEntry)') > openingRequestIndex);
assert.match(talkSource, /this\.chatOpeningPending = true;[\s\S]*this\.chatBusy = true;/);
assert.match(stationkeeperSource, /if \(this\.chatBusy && !this\.chatOpeningPending\)/);
assert.match(stationkeeperSource, /retrieveNpcConversationNarrative\(this\.narrativeConversation/);
assert.match(stationkeeperSource, /commitNpcConversationNarrative\(\{/);

console.log('npcdialogueui PASS · compact bottom-right panel · one deferred opening · deployed imports versioned');
