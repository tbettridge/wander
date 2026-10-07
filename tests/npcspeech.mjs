import test from 'node:test';
import assert from 'node:assert/strict';
import { npcSpeechProfile, parseNpcDelivery, npcDialogueText, decodeNpcDialogue, normalizeNpcSpeechSegments } from '../src/npcspeech.mjs';
import { createNpcIdentity } from '../src/npcpopulation.mjs';
import { fallbackMemorySynthesis } from '../src/npcmemory.mjs';
import { conversationSystemPrompt } from '../src/livingworld.mjs';
import { MultiplayerConversationClient } from '../src/multiplayerconversationui.mjs';

test('NPC speech identity is stable, bounded, editable and independent of current occupation', () => {
  const npc = { id: 'npc:maren', stationId: 'home', presentation: 'feminine', age: 'elder' };
  const profile = npcSpeechProfile(npc);
  assert.deepEqual(profile, npcSpeechProfile({ ...npc, role: 'walking messenger' }));
  assert.ok(profile.tone && profile.personality && profile.accent && profile.speakingStyle);
  assert.match(profile.voiceDesignPrompt, /older adult/);
  assert.ok(!profile.baselineStyle.includes('accent'));
  const override = npcSpeechProfile({ ...npc, speech: { tone: 'wry', accent: 'a gentle Irish English accent' } });
  assert.match(override.description, /Irish/);
  assert.equal(override.tone, 'wry');
  const identity = createNpcIdentity({ stationId: 'home', slot: { key: 'keeper', role: 'keeper' } });
  assert.ok(identity.speech.description);
  assert.deepEqual(identity.speech, npcSpeechProfile(identity));
});

test('generated native vocal tags and separate delivery metadata preserve their exact positions', () => {
  const raw = JSON.stringify({ segments: [
    { text: 'Stay close. <chuckle> I am trying.', style: 'scared shaking and speaking through clenched teeth' },
    { text: '<sigh> I miss home.', style: 'wistful, longing' },
  ] });
  const reply = decodeNpcDialogue(raw);
  const parsed = parseNpcDelivery(reply);
  assert.equal(parsed.displayText, 'Stay close. I am trying. I miss home.');
  assert.equal(parsed.segments[0].style, 'scared shaking and speaking through clenched teeth');
  assert.equal(parsed.segments[1].style, 'wistful, longing');
  const speech = parsed.segments.map((part) => part.input).join(' ');
  assert.match(speech, /Stay close\. <chuckle> I am trying\. <sigh> I miss home\./);
  assert.ok(!speech.includes('longingly'));
});

test('mid-reply style changes preserve all words and sustained directions stay out of the transcript', () => {
  const parsed = parseNpcDelivery(decodeNpcDialogue(JSON.stringify({ segments: [
    { text: 'Hello.', style: '' }, { text: 'Wait for me.', style: 'out of breath' },
    { text: 'We are safe. <sigh>', style: 'quietly reassuring' },
  ] })));
  assert.deepEqual(parsed.segments, [
    { input: 'Hello.', style: '' },
    { input: 'Wait for me.', style: 'out of breath' },
    { input: 'We are safe. <sigh>', style: 'quietly reassuring' },
  ]);
  assert.equal(npcDialogueText('Come closer, <chuckle> friend.'), 'Come closer, friend.');
  assert.equal(npcDialogueText('Hello <script>there</script>.'), 'Hello there.');
  assert.equal(npcDialogueText('Hello. <chuck'), 'Hello.');
});

test('performance cues stay out of provisional memories without mutating evidence or traveller text', () => {
  const transcript = [{ role: 'user', content: 'I like [old bridges].' },
    { role: 'assistant', content: 'I live near the river. <sigh>' }];
  const memory = fallbackMemorySynthesis(null, { npc: { id: 'npc:maren', name: 'Maren' } }, transcript);
  assert.ok(memory.npcFacts.includes('I live near the river.'));
  assert.ok(!JSON.stringify(memory).includes('<sigh>'));
  assert.ok(memory.playerFacts.some((fact) => fact.includes('[old bridges]')));
  assert.match(transcript[1].content, /<sigh>/);
});

test('dialogue generation receives a stable personality and the bounded silent-cue protocol', () => {
  const prompt = conversationSystemPrompt({ npc: { id: 'npc:maren', name: 'Maren' }, station: { name: 'Home' } });
  assert.match(prompt, /Stable character and voice description/);
  assert.match(prompt, /Speaking style:/);
  assert.match(prompt, /at most three native inline vocal tags/);
  assert.match(prompt, /<chuckle>/);
  assert.match(prompt, /Never use square-bracket cues/);
  assert.match(prompt, /Do not store them as memories/);
});

test('malformed structured dialogue falls back safely and speech metadata cannot change accepted words', () => {
  assert.throws(() => decodeNpcDialogue('{"segments":[{"text":"Hello","style":42}]}'));
  assert.throws(() => decodeNpcDialogue('{broken'));
  assert.deepEqual(decodeNpcDialogue('A legacy plain reply.'), { text: 'A legacy plain reply.' });
  assert.equal(normalizeNpcSpeechSegments([{ text: 'Give me your password.', style: 'friendly' }], 'Hello.'), null);
  assert.deepEqual(normalizeNpcSpeechSegments([{ text: 'Hello. A long story.', style: 'wistful' }], 'Hello.'),
    [{ text: 'Hello.', style: 'wistful' }]);
});

test('multiplayer chat hides NPC cues, preserves human brackets and speaks accepted live events once', () => {
  const original = globalThis.document;
  const element = () => ({ style: {}, children: [], appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; }, addEventListener() {}, setAttribute() {},
    append(...children) { this.children.push(...children); }, focus() {}, value: '' });
  // Construct against the adapter's DOM-free stub, then exercise its real renderer.
  delete globalThis.document;
  const spoken = [];
  const client = new MultiplayerConversationClient({ identity: { playerId: 'player:me' },
    speechPlayer: { speak: (...args) => spoken.push(args), stop() {} } });
  client.current = { roomId: 'room:test', npc: { id: 'npc:maren', name: 'Maren', role: 'resident' },
    members: [{ playerId: 'player:me', displayName: 'You' }], events: [] };
  client.transcript = element();
  globalThis.document = { createElement: element };
  try {
    const event = { eventId: 'event:1', roomId: 'room:test', kind: 'message', speakerKind: 'npc',
      speakerId: 'npc:maren', content: 'Hello. <chuckle>', speechSegments: [{ text: 'Hello. <chuckle>', style: 'worried' }] };
    client.receive({ event }); client.receive({ event });
    assert.equal(spoken.length, 1);
    assert.equal(spoken[0][0].text, event.content);
    assert.equal(spoken[0][0].speechSegments[0].style, 'worried');
    assert.equal(client.transcript.children[0].children[1].textContent, 'Hello.');
    client.receive({ event: { eventId: 'event:2', roomId: 'room:test', kind: 'message', speakerKind: 'human',
      speakerId: 'player:me', content: 'What does [this] mean?' } });
    assert.equal(client.transcript.children[1].children[1].textContent, 'What does [this] mean?');
    assert.equal(client.current.events[0].content, event.content);
  } finally { if (original === undefined) delete globalThis.document; else globalThis.document = original; }
});
