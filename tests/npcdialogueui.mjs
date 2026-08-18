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
assert.match(indexHtml, /src="\.\/src\/main\.js\?v=106"/);
assert.match(mainSource, /from '\.\/stationkeeper\.js\?v=mobility3'/);
assert.match(stationkeeperSource, /from '\.\/npcmemory\.mjs\?v=worldscope1'/);
assert.match(stationkeeperSource, /wander\.livingWorld\.encounters\.\$\{seed\}\./,
  'encounter counts are scoped by world seed');
assert.match(mainSource, /migrateLegacyNpcPersistence/,
  'legacy persistence migration is restricted to the persisted home world');
assert.match(mainSource, /from '\.\/livingworld\.mjs\?v=travellersubject5'/);
assert.match(mainSource, /from '\.\/livingworldcontext\.mjs\?v=pointplaces1'/);
assert.match(mainSource, /from '\.\/settlementstream\.js\?v=cachedplans1'/);

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

// --- a line becomes a gesture on every turn, not only the greeting -----------
// pointOut has exactly one caller (renderDialogue), and renderDialogue used to
// have exactly one caller (talk). A reply therefore never pointed and never
// nodded: residents went still the moment the conversation started.
const sendMessageSource = stationkeeperSource.slice(
  stationkeeperSource.indexOf('\n  sendMessage() {'),
  stationkeeperSource.indexOf('\n  requestDialogueClose() {'),
);
assert.match(sendMessageSource, /this\.renderDialogue\(reply, source, replyEntry\)/,
  'a reply must go through renderDialogue so it can gesture');
assert.doesNotMatch(sendMessageSource, /this\.renderTranscript\(\);\s*this\.updateChatControls\(\);\s*this\.focusDialogue\(\);/,
  'the reply path must not bypass renderDialogue by rendering the transcript directly');
assert.match(stationkeeperSource,
  /findMentionedTarget\(\[\s*\.\.\.\(this\.conversationContext\?\.targets \|\| \[\]\),\s*\.\.\.\(this\.conversationContext\?\.pointPlaces \|\| \[\]\)/,
  'pointing must consider community homes and workplaces, not only landmarks');

// --- village residents render the point their emote was already carrying -----
const settlementSource = await readFile(
  new URL('../src/settlementstream.js', import.meta.url), 'utf8',
);
assert.match(settlementSource, /gestureAmount, nodPitch, pointAmount, pulseDelivery, SOCIAL,/,
  'the settlement animation must import the point amount it renders');
assert.match(settlementSource,
  /const pointing = pointAmount\(resident\.emote\);\s*if \(pointing > 0\.01\) \{[\s\S]{0,200}resident\.emote\.pointBearing/,
  'a pointing resident squares up to the bearing before the arm reads it out');
assert.match(settlementSource, /point: pointing,\s*pointPitch: 0\.10,/,
  'the pose must receive the point amount');

// --- the wait for a reply has a body ----------------------------------------
// chatBusy used to be a UI flag and nothing more, so the several seconds an
// on-device reply takes were several seconds of a motionless resident holding
// the player's eye. Both request paths now bracket that wait.
assert.match(stationkeeperSource,
  /const deliberating = this\.deliberatingEmote\(\);\s*beginDeliberation\(deliberating\);\s*this\.director\.requestChatOpening/,
  'the greeting request must start deliberation');
assert.match(stationkeeperSource,
  /const deliberating = this\.deliberatingEmote\(\);\s*beginDeliberation\(deliberating\);\s*this\.director\.requestChatReply/,
  'the reply request must start deliberation');
// Ended on the captured emote at the very top of the handler, before any guard:
// a reply can land after the conversation moved on, and every path must clear.
for (const [request, handler] of [
  ['requestChatOpening', /requestChatOpening\(context\)\.then\(\([^)]*\) => \{\s*endDeliberation\(deliberating\);/],
  ['requestChatReply', /\}\)\.then\(\(\{ reply, source \}\) => \{\s*endDeliberation\(deliberating\);/],
]) {
  assert.match(stationkeeperSource, handler, `${request} must end deliberation before any guard`);
}
assert.match(stationkeeperSource,
  /completeDialogueClose\(\) \{\s*endDeliberation\(this\.deliberatingEmote\(\)\);/,
  'closing mid-thought must not leave a resident deliberating forever');
assert.match(stationkeeperSource,
  /if \(this\.activeNpc\) pulseNod\(this\.activeNpc\.emote\);[\s\S]{0,200}history\.push\(\{ role: 'user'/,
  'sending must be acknowledged before anything is composed');
assert.match(stationkeeperSource,
  /lockOn: deliberating \? \(heldLook \? 'held' : 'glance'\)/,
  'a thinking resident looks at what is in their hands, or at nothing');

assert.match(settlementSource, /deliberationLookAway, gestureAmount/,
  'village residents must import the same look-away');
assert.match(settlementSource,
  /lockOn: talkingToPlayer && deliberationLookAway\(resident\.emote\) \? 'glance'/,
  'village residents get the same rhythm as platform residents');
