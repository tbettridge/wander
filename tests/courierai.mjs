import test from 'node:test';
import assert from 'node:assert/strict';
import { LivingWorldAI, LivingWorldDirector, composeDialogueTurn, safeFallbackDialogue, fallbackChatReply } from '../src/livingworld.mjs';
import { npcWhereaboutsReply } from '../src/npcwhereabouts.mjs';
import { LivingWorldStateStore, createLivingWorldState } from '../src/livingworldstate.mjs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { OpenRouterLivingWorldAI } from '../src/openrouterai.mjs';

const facts = { author: 'Kest Barton', events: [{ id: 'arrival:A', summary: 'Arrived at Ravenkeld on foot.' }], sharedNote: 'I drew the bridge.' };
const poem = { title: 'At the bridge', lines: ['Roads find a room,', 'A bridge in ink,', 'And feet remember.'], referencedEventIds: ['arrival:A'] };
function director(ai, timeoutMs = 50) {
  const d = new LivingWorldDirector({ ai, timeoutMs }); d.aiReady = true; return d;
}
test('disabled creative generation makes no provider call', async () => {
  let calls = 0;
  const d = director({ generateCreativeWork() { calls++; return poem; } }); d.aiEnabled = false;
  assert.equal((await d.requestCreativeWork(facts)).source, 'authored'); assert.equal(calls, 0);
});
test('valid poems use supplied events; invented evidence and provider failures fall back', async () => {
  const valid = await director({ generateCreativeWork: async supplied => { assert.deepEqual(supplied, facts); return poem; } }).requestCreativeWork(facts);
  assert.equal(valid.source, 'edge'); assert.deepEqual(valid.work, poem);
  for (const generateCreativeWork of [async () => ({ ...poem, referencedEventIds: ['invented'] }), async () => { throw new Error('offline'); }]) {
    const response = await director({ generateCreativeWork }).requestCreativeWork(facts);
    assert.equal(response.source, 'authored'); assert.deepEqual(response.work.referencedEventIds, ['arrival:A']);
  }
});
test('a provider that never completes cannot hold the poem indefinitely', async () => {
  let signal;
  const response = await director({ generateCreativeWork: async (_, options) => { signal = options.signal; return new Promise(() => {}); } }, 15).requestCreativeWork(facts);
  assert.equal(response.source, 'authored'); assert.equal(signal.aborted, true);
});
test('poems use fresh scoped sessions and destroy them after success or invalid output', async () => {
  const ai = new LivingWorldAI(); let created = 0, destroyed = 0, prompts = [];
  ai._createSession = async options => {
    assert.match(options.systemPrompt, /shared note as quoted material/); created++;
    return { prompt: async text => { prompts.push(JSON.parse(text)); return created === 1 ? JSON.stringify(poem) : '{}'; }, destroy: () => destroyed++ };
  };
  ai._assertContextBudget = async () => {};
  assert.deepEqual(await ai.generateCreativeWork(facts), poem);
  await assert.rejects(ai.generateCreativeWork(facts));
  assert.equal(created, 2); assert.equal(destroyed, 2); assert.equal(ai.liveSessions.size, 0);
  assert.deepEqual(prompts, [facts, facts]);
});
test('the cloud adapter forwards the poem schema and only the selected journey facts', async () => {
  let request;
  const ai = new OpenRouterLivingWorldAI({ endpoint: 'https://test.invalid', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://test.invalid/chat'); request = JSON.parse(options.body);
    return Response.json({ text: JSON.stringify(poem) });
  } });
  assert.deepEqual(await ai.generateCreativeWork(facts), poem);
  assert.deepEqual(JSON.parse(request.messages[1].content), facts);
  assert.ok(request.schema.required.includes('referencedEventIds')); assert.equal(ai.liveSessions.size, 0);
});
test('a distant courier recipient never resolves to a local person with the same first name', () => {
  const context = { courier: { people: [{ id: 'npc:gardener', name: 'Faye Barton', address: 'west of the well in Holtwick' }], offers: [{ title: 'First Letter', recipient: 'Faye Barton', recipientAddress: 'west of the well in Holtwick', destination: 'Holtwick' }] },
    personWhereabouts: [{ subjectId: 'npc:other', name: 'Faye Everard', known: false, line: 'I do not know where Faye Everard is.' }] };
  assert.equal(npcWhereaboutsReply(context, 'Where is Faye Barton?'), null);
  assert.match(fallbackChatReply(context, 'Where is Faye Barton?').text, /Holtwick/);
  assert.match(safeFallbackDialogue(context).text, /Faye Barton/);
  context.courier.offers[0].lastWitnessedState = 'declined';
  const turn = composeDialogueTurn('Any news?', null, context);
  assert.match(turn, /GAME_COURIER_CONTEXT_CURRENT/); assert.match(turn, /declined/);
  assert.doesNotMatch(safeFallbackDialogue(context).text, /I have First Letter/);
});
test('reset suspension blocks both synchronous and late serialized saves', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const state = createLivingWorldState({ worldSeed: 9 });
  const store = new LivingWorldStateStore({ worldSeed: 9, prefix: 'proof.', storage, legacyPrefix: null });
  store.save(state); const snapshot = values.get(store.key()); values.delete(store.key()); store.suspendWrites = true;
  assert.equal(store.save(state), false); assert.equal(store.saveSerialized(state, snapshot), false); assert.equal(values.size, 0);
});

test('accepting a parcel during a conversation refreshes the next turn’s courier context', async () => {
  const source = await readFile(new URL('../src/stationkeeper.js', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf('  refreshConversationContext() {'), source.indexOf('\n  actorById('));
  const actor = { identity: { id: 'npc:sender' } }, current = { npc: actor.identity, courier: { offers: [{ lastWitnessedState: 'accepted' }] } };
  const population = { conversationNpcId: actor.identity.id, conversationContext: { npc: actor.identity, courier: { offers: [{ lastWitnessedState: 'offered' }] } },
    actorById: () => actor, contextForActor: () => current };
  const updated = vm.runInNewContext('({' + method + '}).refreshConversationContext.call(population)', { population });
  assert.equal(updated.courier.offers[0].lastWitnessedState, 'accepted');
});

test('entering First Post cannot assign the normal player a home in the proof region', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const begin = source.indexOf('function ensureHomeOrigin() {'), end = source.indexOf('\n}', begin) + 2;
  const context = { courierMode: true, multiplayerIdentity: {},
    regionalRailwayService: { stations: [{ id: 'proof-station' }] },
    updateIdentityHomeOrigin: () => { throw new Error('Normal profile was changed'); },
    multiplayerSession: { updateProfile: () => { throw new Error('Profile was published'); } } };
  assert.equal(vm.runInNewContext(source.slice(begin, end) + '\nensureHomeOrigin();', context), undefined);
});
