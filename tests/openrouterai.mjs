import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterLivingWorldAI, savedAIProvider } from '../src/openrouterai.mjs';
import { LivingWorldDirector } from '../src/livingworld.mjs?v=speech1';

const context = {
  npc: { id: 'npc:maren', name: 'Maren', role: 'porter' },
  station: { id: 'halt', name: 'Harrow Mill' },
  memory: {}, targets: [{ id: 'halt', name: 'Harrow Mill' }],
};

function gateway(replies) {
  const calls = [];
  const ai = new OpenRouterLivingWorldAI({ endpoint: 'https://ai.example', fetchImpl: async (url, options) => {
    calls.push({ url, options, body: options?.body && JSON.parse(options.body) });
    if (url.endsWith('/health')) return Response.json({ configured: true });
    return Response.json({ text: replies.shift() });
  } });
  return { ai, calls };
}

test('default browser fetch preserves its Window receiver for health and dialogue', async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async function (url) {
    assert.equal(this, globalThis, 'native Window.fetch rejects a class instance as its receiver');
    calls.push(url);
    return url.endsWith('/health') ? Response.json({ configured: true })
      : Response.json({ text: JSON.stringify({ segments: [{ text: 'Welcome.', style: '' }] }) });
  };
  const ai = new OpenRouterLivingWorldAI({ endpoint: 'https://ai.example' });
  const director = new LivingWorldDirector({ ai });
  try {
    assert.equal(await director.initializeFromUserGesture(true), true);
    const opening = await director.requestChatOpening(context);
    assert.equal(opening.source, 'edge');
    assert.equal(opening.reply.text, 'Welcome.');
    assert.deepEqual(calls, ['https://ai.example/health', 'https://ai.example/chat']);
  } finally {
    await director.initializeFromUserGesture(false);
    globalThis.fetch = previous;
  }
});

test('cloud dialogue carries generated Gemini vocal tags and separate delivery styles through the director', async () => {
  const { ai, calls } = gateway([
    JSON.stringify({ segments: [{ text: 'Hello. <chuckle>', style: 'warm and amused' }] }),
    JSON.stringify({ segments: [{ text: 'Stay close.', style: 'scared, trembling' },
      { text: 'We will be fine.', style: 'quietly reassuring' }] }),
  ]);
  const director = new LivingWorldDirector({ ai });
  await director.initializeFromUserGesture(true);
  const opening = await director.requestChatOpening(context);
  assert.equal(opening.source, 'edge');
  assert.equal(opening.reply.text, 'Hello. <chuckle>');
  assert.equal(opening.reply.speechSegments[0].style, 'warm and amused');
  const reply = await director.requestChatReply(context, 'Did you hear that?', opening.conversationId);
  assert.equal(reply.reply.text, 'Stay close. We will be fine.');
  assert.equal(reply.reply.speechSegments[0].style, 'scared, trembling');
  assert.equal(reply.reply.speechSegments[1].style, 'quietly reassuring');
  assert.equal(calls.at(-1).body.schema.properties.segments.maxItems, 4);
  director.discardConversation(opening.conversationId);
});

test('provider defaults to OpenRouter, retains explicit local choice and tolerates blocked storage', () => {
  assert.equal(savedAIProvider({ getItem: () => null }), 'openrouter');
  assert.equal(savedAIProvider({ getItem: () => 'local' }), 'local');
  assert.equal(savedAIProvider({ getItem: () => 'invalid' }), 'openrouter');
  assert.equal(savedAIProvider({ getItem: () => { throw new Error('blocked'); } }), 'openrouter');
});

test('cloud sessions preserve persona and successful history without a browser model or provider key', async () => {
  const { ai, calls } = gateway(['Good morning.', 'The mill is nearby.']);
  await ai.initialize();
  const opening = await ai.beginChat(context);
  await ai.continueChat(opening.conversationId, 'Where is the mill?');
  assert.equal(calls.length, 3);
  const messages = calls.at(-1).body.messages;
  assert.match(messages[0].content, /You are Maren/);
  assert.deepEqual(messages.slice(-3), [
    { role: 'user', content: 'Open the conversation naturally, as if noticing a traveller nearby.' },
    { role: 'assistant', content: 'Good morning.' },
    { role: 'user', content: 'Where is the mill?' },
  ]);
  assert.equal(calls.at(-1).options.headers.authorization, undefined);
  ai.destroy();
  assert.equal(ai.liveSessions.size, 0);
});

test('quest and memory operations retain schemas and authoritative game validation', async () => {
  const memory = { playerFacts: [], npcFacts: [], quests: [], landmarks: [], worldFacts: [],
    lastConversationSummary: 'We spoke about the mill.', narrativeClaims: { version: 1, thirdPartyClaims: [] },
    narrativeConfirmations: [] };
  const { ai, calls } = gateway([
    JSON.stringify({ title: 'Visit the mill', speakerText: 'Take a walk.', steps: [{ action: 'visit', targetId: 'halt' }] }),
    'Good morning.', JSON.stringify(memory),
  ]);
  await ai.initialize();
  const quest = await ai.generateQuest(context);
  assert.equal(quest.steps[0].targetId, 'halt');
  assert.ok(calls.at(-1).body.schema.properties.steps);
  const { conversationId } = await ai.beginChat(context);
  const transcript = [{ role: 'assistant', content: 'Good morning.' }];
  assert.deepEqual(await ai.synthesizeChat(conversationId, { context, transcript }), memory);
  assert.ok(calls.at(-1).body.schema.properties.narrativeClaims);
  assert.match(calls.at(-1).body.messages.at(-1).content, /VALIDATION_TRANSCRIPT_JSON/);
  assert.equal(ai.liveSessions.size, 0);
  assert.equal(ai.hasChat(conversationId), false);
});

test('aborted cloud replies do not enter history and disabled AI aborts fetches', async () => {
  const { ai } = gateway(['Good morning.']);
  await ai.initialize();
  const { conversationId } = await ai.beginChat(context);
  const session = ai.chatSessions.get(conversationId);
  let requestSignal;
  ai.fetchImpl = async (url, { signal }) => {
    requestSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const controller = new AbortController();
  const pending = ai.continueChat(conversationId, 'Never completed', { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new DOMException('Cancelled', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(requestSignal.aborted, true);
  assert.equal(session.messages.some(({ content }) => content === 'Never completed'), false);
  ai.destroy();
});

test('switching providers ignores late initialization and rebuilds an existing conversation', async () => {
  let finishOld;
  const old = { initialize: () => new Promise((resolve) => { finishOld = resolve; }), destroy() {} };
  const director = new LivingWorldDirector({ ai: old });
  const oldInitialization = director.initializeFromUserGesture(true);
  const { ai } = gateway(['Hello again.']);
  const id = director._stableConversation(context);
  director.conversations.get(id).transcript = [{ role: 'assistant', content: 'Earlier greeting.' }];
  await director.setAI(ai);
  finishOld();
  assert.equal(await oldInitialization, false);
  assert.equal(director.aiReady, true);
  const reply = await director.requestChatReply(context, 'Hello', id);
  assert.equal(reply.reply.text, 'Hello again.');
  assert.match(ai.chatSessions.get(id).messages[0].content, /Earlier greeting/);
  await director.initializeFromUserGesture(false);
});

test('unconfigured cloud service returns authored dialogue and stays disabled after a late initialization', async () => {
  const ai = new OpenRouterLivingWorldAI({ fetchImpl: async () => Response.json({ configured: false }) });
  const director = new LivingWorldDirector({ ai });
  assert.equal(await director.initializeFromUserGesture(true), false);
  assert.equal((await director.requestChatOpening(context)).source, 'authored');
  let finish;
  director.ai = { initialize: () => new Promise((resolve) => { finish = resolve; }), destroy() {} };
  const pending = director.initializeFromUserGesture(true);
  await director.initializeFromUserGesture(false);
  finish();
  assert.equal(await pending, false);
  assert.equal(director.availabilityState, 'disabled');
});
