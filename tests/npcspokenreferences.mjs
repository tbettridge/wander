import test from 'node:test';
import assert from 'node:assert/strict';
import { npcReferenceRoster, npcSpeechVocabulary, resolveNpcReference, NpcReferenceSession } from '../src/npcspokenreferences.mjs';

const faye = { id: 'npc:faye', name: 'Faye Barton', role: 'baker', place: 'Holtwick' };
const ada = { id: 'npc:ada', name: 'Ada Dale', role: 'innkeeper', nicknames: ['Addie'] };
const context = { npc: ada, homeCommunity: { residents: [ada] },
  courier: { people: [faye], offers: [{ id: 'letter', title: 'First Letter', recipient: faye.name, lastWitnessedState: 'accepted' }] },
  personWhereabouts: [{ subjectId: ada.id, name: ada.name, known: false }] };

test('a spoken homophone resolves a canonical contact outside the streamed community', () => {
  for (const text of ['Where is Faye Barton?', 'Where is Fay Barton?', 'Where is Fae Barton?', 'Where can I find Fay?', 'Tell me about Barton.']) {
    const result = resolveNpcReference(context, text);
    assert.equal(result.status, 'resolved', text);
    assert.equal(result.personId, faye.id, text);
    assert.match(result.canonicalText, /Faye Barton/);
  }
  assert.equal(npcReferenceRoster(context).find(person => person.id === ada.id).role, 'innkeeper');
  assert.equal(resolveNpcReference(context, 'Where is Addie?').personId, ada.id);
});

test('unfamiliar or similarly spelled surnames require confirmation or stay unknown', () => {
  assert.equal(resolveNpcReference(context, 'Where is Faye Burton?').status, 'ambiguous');
  assert.equal(resolveNpcReference(context, 'Where is Fay Bartun?').status, 'ambiguous');
  assert.equal(resolveNpcReference(context, 'Where is Faye Andersen?').status, 'unknown');
  assert.equal(resolveNpcReference(context, 'Where is Zanzibar?').status, 'unknown');
  assert.equal(resolveNpcReference(context, 'Is the road muddy?').status, 'none');
});

test('shared first names and homophones never silently choose the first resident', () => {
  const people = { ...context, homeCommunity: { residents: [{ id: 'npc:fay', name: 'Fay Cole', role: 'innkeeper' }] } };
  assert.equal(resolveNpcReference(people, 'Where is Fay?').status, 'ambiguous', 'a transcript spelling cannot distinguish homophones');
  const shared = { ...context, homeCommunity: { residents: [{ id: 'npc:other', name: 'Faye Cole', role: 'innkeeper' }] } };
  const result = resolveNpcReference(shared, 'Where is Fay?');
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(new Set(result.candidates.map(person => person.id)), new Set([faye.id, 'npc:other']));
  assert.match(result.clarification, /Faye Barton.*Faye Cole|Faye Cole.*Faye Barton/);
  assert.equal(resolveNpcReference(shared, 'Where is Fay Barton?').personId, faye.id);
});

test('descriptions identify real roles and the recipient of the active letter', () => {
  assert.equal(resolveNpcReference(context, 'Where is the innkeeper?').canonicalText, 'Where is Ada Dale?');
  assert.equal(resolveNpcReference(context, 'Where is the person receiving my letter?').personId, faye.id);
  const two = { ...context, homeCommunity: { residents: [ada, { id: 'npc:inn', name: 'Mira Cole', role: 'innkeeper' }] } };
  assert.equal(resolveNpcReference(two, 'Where is the innkeeper?').status, 'ambiguous');
});

test('a clarification resumes the original question and tracks pronouns within that session', () => {
  const session = new NpcReferenceSession();
  assert.equal(session.resolve(context, 'Where is Fay Bartun?').status, 'ambiguous');
  const confirmation = session.resolve(context, 'Yes');
  assert.equal(confirmation.personId, faye.id);
  assert.match(confirmation.canonicalText, /Where.*Faye Barton/);
  assert.equal(session.resolve(context, 'Where is she now?').canonicalText, 'Where is Faye Barton now?');
  assert.equal(session.resolve(context, 'Where is Fay Bartun now?').personId, faye.id, 'the confirmed spelling is remembered');
  assert.equal(new NpcReferenceSession().resolve(context, 'Where is she now?').status, 'none');
});

test('yes cannot select between two candidates and unrelated turns clear pending confirmation', () => {
  const shared = { ...context, homeCommunity: { residents: [{ id: 'npc:other', name: 'Faye Cole', role: 'innkeeper' }] } };
  const session = new NpcReferenceSession();
  session.resolve(shared, 'Where is Fay?');
  assert.equal(session.resolve(shared, 'Yes').status, 'ambiguous');
  assert.equal(session.resolve(shared, 'The baker').personId, faye.id);
  assert.equal(session.resolve(shared, 'Where is Fay Andersen?').status, 'unknown', 'a learned first name cannot swallow a new surname');
  session.resolve(context, 'Where is Fay Bartun?');
  session.resolve(context, 'Nice weather today.');
  assert.equal(session.resolve(context, 'Yes').status, 'none');
});

test('ordinary words do not become residents and vocabulary is bounded and independent of the compact prompt', () => {
  const many = { ...context, homeCommunity: { residents: [...Array.from({ length: 120 }, (_, i) => ({ id: `npc:${i}`, name: `Resident ${i} Brown` })),
    { id: 'npc:will', name: 'Will Finn' }, { id: 'npc:may', name: 'May Thatcher' }] } };
  assert.equal(resolveNpcReference(many, 'I will take the letter.').status, 'none');
  assert.equal(resolveNpcReference(many, 'May I ask about work?').status, 'none');
  const vocabulary = npcSpeechVocabulary(many, [{ content: 'Resident 119 Brown' }]);
  assert.equal(vocabulary.length, 100);
  assert.equal(vocabulary[0], 'Resident 119 Brown');
  assert.ok(vocabulary.includes('Faye Barton'));
  assert.ok(!vocabulary.some(term => term.includes('undefined')));
});

test('apostrophes, accents and spoken hyphens preserve the canonical identity', () => {
  const context = { homeCommunity: { residents: [{ id: 'npc:anne', name: "Anne-Marie O’Connor", role: 'miller' },
    { id: 'npc:jose', name: 'José Silva' }] } };
  for (const text of ["Where is Anne-Marie O'Connor?", 'Where is Anne Marie O Connor?', 'Where is AnneMarie OConnor?']) {
    assert.equal(resolveNpcReference(context, text).personId, 'npc:anne', text);
  }
  assert.equal(resolveNpcReference(context, 'Where is Jose Silva?').personId, 'npc:jose');
});

test('ordinary words beside a name are not mistaken for another resident', () => {
  const iris = { id: 'npc:iris', name: 'Iris Dale', responsibility: 'guide' };
  const village = { npc: ada, courier: { people: [iris] },
    homeCommunity: { residents: [ada, { ...iris, responsibility: undefined, role: 'resident' },
      { id: 'npc:willa-h', name: 'Willa Harrow', role: 'householder' }, { id: 'npc:willa-f', name: 'Willa Flint', role: 'resident' },
      { id: 'npc:nott', name: 'Nott Reed', role: 'resident' }] } };
  for (const text of ['Who is Iris and where will I find her right now?', 'Where will I find Iris?', 'I will not ask Iris yet, where is she?']) {
    const result = resolveNpcReference(village, text);
    assert.equal(result.status, 'resolved', text);
    assert.equal(result.personId, iris.id, text);
  }
  assert.equal(npcReferenceRoster(village).find(person => person.id === iris.id).role, 'guide');
  assert.equal(resolveNpcReference(village, 'Where is Willa?').status, 'ambiguous');
  assert.equal(resolveNpcReference(village, 'Where is Wila Harrow?').candidates[0].id, 'npc:willa-h');
  assert.equal(resolveNpcReference(village, 'Where will I find work?').status, 'none');
});
