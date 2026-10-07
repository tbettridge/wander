import test from 'node:test';
import assert from 'node:assert/strict';
import { npcVoiceDemographics, npcVoiceBackground, VOICE_GENDERS, npcCastKeys, npcCastVoice } from '../src/npcvoiceidentity.mjs';
import { npcSpeechProfile, NPC_PREBUILT_VOICES } from '../src/npcspeech.mjs';
import { createNpcIdentity } from '../src/npcpopulation.mjs';
import { createSettlementResidentIdentity } from '../src/npcresidentidentity.mjs';
import { generateHouseholds } from '../src/npchousehold.mjs';
import { designNpcCast } from '../services/ai-worker/scripts/design-voices.mjs';

test('real numeric NPC presentations select the correct gender and survive compact dialogue context', () => {
  assert.equal(NPC_PREBUILT_VOICES.length, 30);
  assert.deepEqual(new Set(NPC_PREBUILT_VOICES), new Set([...VOICE_GENDERS.female, ...VOICE_GENDERS.male]));
  for (const [givenName, gender] of [['Tamsin', 'female'], ['Bram', 'male']]) {
    for (const ageBand of ['youth', 'adult', 'elder']) {
      const identity = createNpcIdentity({ stationId: 'home', givenName, ageBand,
        slot: { key: `${givenName}:${ageBand}`, role: 'resident' } });
      assert.equal(typeof identity.presentation, 'number');
      assert.equal(identity.speech.gender, gender);
      assert.ok(VOICE_GENDERS[gender].includes(identity.speech.voice));
      assert.equal(identity.speech.ageBand, ageBand);
      const context = { id: identity.id, name: identity.name, speech: identity.speech };
      assert.deepEqual(npcSpeechProfile(context), identity.speech);
      assert.match(identity.speech.voiceDesignPrompt, new RegExp(gender));
    }
  }
  assert.equal(npcVoiceDemographics({ gender: 'female', presentation: 0.1 }).gender, 'female');
});

test('legacy all-male generated profiles are upgraded without redrawing appearance', () => {
  const identity = createNpcIdentity({ stationId: 'home', givenName: 'Tamsin',
    slot: { key: 'keeper', role: 'keeper' } });
  const updated = npcSpeechProfile({ ...identity, speech: { version: 1, voice: 'Charon', tone: 'wry' } });
  assert.equal(updated.gender, 'female');
  assert.ok(VOICE_GENDERS.female.includes(updated.voice));
  assert.equal(updated.tone, 'wry');
  assert.equal(npcSpeechProfile({ ...identity, speech: { voice: 'Kore' } }).voice, 'Kore');
});

test('cast has broad voice diversity and overseas visitors stay rare with matching stories', () => {
  const voices = new Set();
  const backgrounds = [];
  const visitors = [];
  for (let i = 0; i < 1500; i++) {
    const npc = { id: `resident:${i}`, stationId: `home:${i}`, presentation: i % 2 ? 0.9 : 0.1, age: 'adult' };
    const profile = npcSpeechProfile(npc);
    voices.add(profile.voice); backgrounds.push(profile.background);
    visitors.push(npcVoiceBackground({ ...npc, role: 'traveller' }));
  }
  assert.ok(voices.size >= 25);
  assert.ok(backgrounds.filter((b) => b.originCountry === 'England').length > 1000);
  assert.ok(backgrounds.some((b) => b.originCountry === 'Scotland'));
  assert.ok(backgrounds.some((b) => b.originCountry === 'Ireland'));
  assert.ok(!backgrounds.some((b) => ['France', 'Spain'].includes(b.originCountry)));
  const overseas = visitors.filter((b) => ['France', 'Spain'].includes(b.originCountry));
  assert.ok(overseas.length > 10 && overseas.length < 75);
  for (const background of overseas) {
    assert.ok(background.visitor);
    assert.match(background.story, new RegExp(`visiting from there`));
    assert.match(background.story, new RegExp(background.originCountry));
  }
});

test('family upbringing is shared and cultivated London accents are more common in urban business families', () => {
  let urban = 0, rural = 0;
  for (let i = 0; i < 500; i++) {
    const npc = { id: `npc:${i}`, householdId: `family:${i}`, originSettlementId: `town:${i}` };
    const a = npcVoiceBackground({ ...npc, settlementKind: 'town', businessFamily: true });
    const b = npcVoiceBackground({ ...npc, id: `sibling:${i}`, settlementKind: 'town', businessFamily: true });
    assert.deepEqual(a, b);
    if (a.accentId === 'posh') urban++;
    if (npcVoiceBackground({ ...npc, settlementKind: 'hamlet' }).accentId === 'posh') rural++;
  }
  assert.ok(urban > rural * 4);
});

test('canonical resident voice retains household age, numeric gender and authored origin at the station', () => {
  const entity = { id: 'npc:tamsin', kind: 'npc', name: 'Tamsin Bell', role: 'householder', householdId: 'bell',
    voiceBackground: { accentId: 'irish', originCountry: 'Ireland', story: 'Grew up in Ireland.' } };
  const state = { worldSeed: 4, households: { bell: { id: 'bell', form: 'partners', homeBuildingId: 'home',
    memberIds: ['parent:1', 'parent:2', entity.id] } } };
  const identity = createSettlementResidentIdentity({ entity, state });
  assert.equal(identity.age, 'youth');
  assert.equal(identity.speech.gender, 'female');
  assert.equal(identity.speech.ageBand, 'youth');
  assert.equal(identity.speech.background.originCountry, 'Ireland');
  assert.deepEqual(npcSpeechProfile({ ...identity, role: 'railway porter' }), identity.speech);
});

test('saved households receive canonical business-family backgrounds once and keep them across later changes', () => {
  const plan = { site: { id: 'town:voice-proof', kind: 'town' }, buildings: [
    { id: 'home:business', seed: 4, program: 'dwelling', ownerHouseholdId: 'family:business', ownerSurname: 'Bell', rooms: [] },
    { id: 'home:domestic', seed: 8, program: 'dwelling', ownerHouseholdId: 'family:domestic', ownerSurname: 'Hill', rooms: [] },
    { id: 'inn', program: 'inn', ownerHouseholdId: 'family:business' },
  ] };
  const state = {};
  generateHouseholds(plan, state);
  // A saved world predating voices already has household records and members.
  for (const entity of Object.values(state.entities)) delete entity.voiceBackground;
  generateHouseholds(plan, state);
  const family = state.households['family:business'];
  const background = state.entities[family.memberIds[0]].voiceBackground;
  assert.equal(background.businessFamily, true);
  assert.equal(background.settlementKind, 'town');
  for (const id of family.memberIds) assert.deepEqual(state.entities[id].voiceBackground, background);
  const domestic = state.entities[state.households['family:domestic'].memberIds[0]];
  assert.equal(domestic.voiceBackground.businessFamily, false);
  plan.buildings.pop();
  generateHouseholds(plan, state);
  assert.deepEqual(state.entities[family.memberIds[0]].voiceBackground, background);
});

test('voice design is a bounded reusable cast and resumes after each saved voice', async () => {
  assert.equal(npcCastKeys().length, 144);
  assert.equal(npcCastVoice('injected:male:adult:0'), null);
  assert.equal(npcCastVoice('constructor:male:adult:0'), null);
  assert.equal(npcCastVoice(['yorkshire:female:elder:0']), null);
  const keys = ['yorkshire:female:elder:0', 'french:male:youth:1'];
  let calls = 0;
  const saved = [];
  const bank = await designNpcCast({ apiKey: 'fake-google-key', keys,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/voices');
      const body = JSON.parse(options.body);
      assert.equal(body.store, true);
      assert.equal(body.voice.language_code, 'en-GB');
      assert.match(body.voice.prompted.input, /English/);
      return Response.json({ id: `voice_test${calls}` });
    }, save: async (value) => saved.push({ ...value }) });
  assert.equal(saved.length, 2);
  assert.equal(Object.keys(saved[0]).length, 1);
  await designNpcCast({ apiKey: 'fake-google-key', keys, existing: bank,
    fetchImpl: async () => { throw new Error('must reuse designed voices'); } });
  assert.equal(calls, 2);
});
