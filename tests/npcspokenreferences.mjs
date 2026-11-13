import test from 'node:test';
import assert from 'node:assert/strict';
import { npcReferenceRoster, npcSpeechVocabulary, resolveNpcReference, NpcReferenceSession } from '../src/npcspokenreferences.mjs';

const faye = { id: 'npc:faye', name: 'Faye Barton', role: 'baker', place: 'Holtwick' };
const ada = { id: 'npc:ada', name: 'Ada Dale', role: 'innkeeper', nicknames: ['Addie'] };
const context = { npc: ada, homeCommunity: { residents: [ada] },
  courier: { people: [faye], offers: [{ id: 'letter', title: 'First Letter', recipient: faye.name, lastWitnessedState: 'accepted' }] },
  personWhereabouts: [{ subjectId: ada.id, name: ada.name, known: false }] };

// Two Fayes and nobody on the courier's round: nothing says which is meant.
const strangers = { npc: ada, homeCommunity: { residents: [ada, faye, { id: 'npc:other', name: 'Faye Cole', role: 'innkeeper' }] } };

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

test('a near miss with only one possible person resolves; a truly unfamiliar name stays unknown', () => {
  // Asking "Do you mean Faye Barton?" when nobody else could be meant only gets in the way.
  for (const text of ['Where is Faye Burton?', 'Where is Fay Bartun?', 'where is fey parton']) {
    assert.equal(resolveNpcReference(context, text).personId, faye.id, text);
  }
  assert.equal(resolveNpcReference(context, 'Where is Faye Andersen?').status, 'unknown');
  assert.equal(resolveNpcReference(context, 'Where is Zanzibar?').status, 'unknown');
  assert.equal(resolveNpcReference(context, 'Is the road muddy?').status, 'none');
});

test('shared first names and homophones never silently choose the first resident', () => {
  const people = { ...context, homeCommunity: { residents: [{ id: 'npc:fay', name: 'Fay Cole', role: 'innkeeper' }] } };
  assert.equal(resolveNpcReference(people, 'Where is Fay?').status, 'ambiguous', 'a transcript spelling cannot distinguish homophones');
  const shared = { ...context, homeCommunity: { residents: [{ id: 'npc:other', name: 'Faye Cole', role: 'innkeeper' }] } };
  // Two namesakes: the one on the courier's round is meant.
  assert.equal(resolveNpcReference(shared, 'Where is Fay?').personId, faye.id);
  assert.equal(resolveNpcReference(shared, 'Where is Faye Cole?').personId, 'npc:other', 'a full name still reaches the namesake');
  // With nobody on the round to prefer, it asks.
  const result = resolveNpcReference(strangers, 'Where is Fay?');
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(new Set(result.candidates.map(person => person.id)), new Set([faye.id, 'npc:other']));
  assert.match(result.clarification, /Faye Barton.*Faye Cole|Faye Cole.*Faye Barton/);
  assert.equal(resolveNpcReference(strangers, 'Where is Fay Barton?').personId, faye.id);
  // The person being spoken to is meant before another villager of that name.
  const adas = { npc: ada, homeCommunity: { residents: [ada, { id: 'npc:ada2', name: 'Ada Gable', role: 'householder' }] } };
  assert.equal(resolveNpcReference(adas, 'Hello Ada, any work?').personId, ada.id);
});

test('descriptions identify real roles and the recipient of the active letter', () => {
  assert.equal(resolveNpcReference(context, 'Where is the innkeeper?').canonicalText, 'Where is Ada Dale?');
  assert.equal(resolveNpcReference(context, 'Where is the person receiving my letter?').personId, faye.id);
  const two = { ...context, homeCommunity: { residents: [ada, { id: 'npc:inn', name: 'Mira Cole', role: 'innkeeper' }] } };
  assert.equal(resolveNpcReference(two, 'Where is the innkeeper?').status, 'ambiguous');
});

test('a clarification resumes the original question and tracks pronouns within that session', () => {
  const session = new NpcReferenceSession();
  assert.equal(session.resolve(strangers, 'Where is Fay?').status, 'ambiguous');
  const confirmation = session.resolve(strangers, 'Faye Barton');
  assert.equal(confirmation.personId, faye.id);
  assert.match(confirmation.canonicalText, /Where.*Faye Barton/);
  assert.equal(session.resolve(strangers, 'Where is she now?').canonicalText, 'Where is Faye Barton now?');
  assert.equal(session.resolve(strangers, 'Where is Fay now?').personId, faye.id, 'the confirmed spelling is remembered');
  assert.equal(new NpcReferenceSession().resolve(context, 'Where is she now?').status, 'none');
});

test('yes cannot select between two candidates and unrelated turns clear pending confirmation', () => {
  const shared = strangers;
  const session = new NpcReferenceSession();
  session.resolve(shared, 'Where is Fay?');
  assert.equal(session.resolve(shared, 'Yes').status, 'ambiguous');
  assert.equal(session.resolve(shared, 'The baker').personId, faye.id);
  assert.equal(session.resolve(shared, 'Where is Fay Andersen?').status, 'unknown', 'a learned first name cannot swallow a new surname');
  session.resolve(shared, 'Where is Fay?');
  session.resolve(shared, 'Nice weather today.');
  assert.equal(session.resolve(shared, 'Yes').status, 'none');
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

// A real First Post village: 49 people sharing a handful of names, of whom four
// are on the courier's round. These are things a courier types or a recogniser hears.
test('in a village of namesakes, misheard and partial names find the right person', () => {
  const village = `Ada Dale|innkeeper;Hale Fallow|smith;Faye Barton|gardener;Lina Gable|;Iris Dale|;Willa Harrow|;Sable Harrow|;Sable Abbey|;Faye Everard|;Elsi Flint|;Elsi Barton|;Nessa Barton|;Orin Dale|;Ada Gable|;Maud Gable|;Idris Fallow|;Perrin Fallow|;Finn Fallow|;Quill Barton|;Silas Barton|;Albin Barton|miller;Hester Flint|;Willa Flint|;Lorne Fallow|;Elsi Fallow|;Bram Barton|;Kest Gable|;Eamon Fallow|`
    .split(';').map((entry, i) => { const [name, role] = entry.split('|'); return { id: 'r' + i, name, role: role || 'resident' }; });
  const who = name => village.find(person => person.name === name);
  const round = { npc: who('Ada Dale'), place: { name: 'Ravenkeld' }, homeCommunity: { residents: village },
    courier: { routes: [{ name: 'Oakgate' }, { name: 'Holtwick' }], people: [['Ada Dale', 'dispatcher'], ['Hale Fallow', 'guide'],
      ['Faye Barton', 'gardener'], ['Lina Gable', 'archivist']].map(([name, responsibility]) => ({ id: who(name).id, name, responsibility })) } };
  const found = {
    'Hale Fallow': ['Where is Hale?', 'where does hail fallow live', 'Where is Hale Fellow?', 'where is hell fallow', 'where is hale follow',
      'which way to hales house', 'im looking for hail', 'do you know where hail is', 'Where is Mr Fallow?', 'where is old Hale',
      'where is the guide', 'who is the trail guide', 'where is the smith', 'I have a note for hell fallow'],
    'Faye Barton': ['I have a letter for Faye', 'Where is Faye?', 'looking for fay', 'where does faye burton live', 'where is fey', 'Where is the gardener?'],
    'Lina Gable': ['where is leena gable', 'Where is Lina Cable', 'take this to Lena', 'is this for Lina', 'where is the archivist'],
    'Ada Dale': ['where is Ada', 'Hello Ada, any work?', 'thanks Ada', 'who is the dispatcher', 'where is Eda Dale'],
    // A full name always reaches the namesake who is not on the round.
    'Faye Everard': ['Where is Faye Everard?'], 'Ada Gable': ['where is Ada Gable'], 'Kest Gable': ['where is Kest'],
  };
  for (const [name, sayings] of Object.entries(found)) for (const text of sayings) {
    const result = resolveNpcReference(round, text);
    assert.equal(result.status === 'resolved' ? result.name : result.status, name, text);
  }
  // Namesakes with nobody on the round among them are still worth asking about.
  for (const text of ['where is Elsi', 'where is Sable', 'where is Willa']) assert.equal(resolveNpcReference(round, text).status, 'ambiguous', text);
  // Ordinary talk is never a name, known or unknown.
  for (const text of ['tell me about yourself', 'the weather is fine today', 'where is the hall', 'I will take it to the mill', 'I feel fine',
    'it is a long way to walk', 'how far is Oakgate', 'which way to Holtwick?', 'where is my horse', 'I am looking for work', 'where is everyone',
    'Is there any delivery work?', 'I will deliver it now', 'where do you live', 'good morning', 'where is the gate']) {
    assert.equal(resolveNpcReference(round, text).status, 'none', text);
  }
  assert.equal(npcReferenceRoster(round).find(person => person.name === 'Hale Fallow').role, 'guide', 'the courier’s word for someone leads');
  // The recogniser hears the round's names first.
  assert.deepEqual(new Set(npcSpeechVocabulary(round).slice(0, 4)), new Set(['Ada Dale', 'Hale Fallow', 'Faye Barton', 'Lina Gable']));
});
