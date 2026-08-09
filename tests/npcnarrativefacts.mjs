import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyNpcNarrativeFacts,
  confirmNpcNarrativeFacts,
  normalizeNarrativeClaimSynthesis,
  NPC_NARRATIVE_FACTS_VERSION,
  planNpcNarrativeFacts,
  projectNarrativeFactsToMemory,
} from '../src/npcnarrativefacts.mjs';

const speaker = { id: 'npc:ada', name: 'Ada' };
const subject = { id: 'npc:bea', name: 'Beatrice Bell', aliases: ['Bea'] };
const transcript = [
  { role: 'user', content: 'What does Bea do?', speakerId: 'player' },
  { role: 'assistant', content: 'Beatrice Bell repairs the old mill.', speakerId: 'npc:ada' },
];

function claim(overrides = {}) {
  return {
    subjectId: subject.id,
    factKey: 'occupation',
    value: 'mill repairer',
    statement: 'Beatrice Bell repairs the old mill.',
    classification: 'asserted-fact',
    evidence: { messageIndex: 1, quote: 'Beatrice Bell repairs the old mill.' },
    visibility: 'shared',
    ...overrides,
  };
}

function plan(claims = [claim()], options = {}) {
  return planNpcNarrativeFacts({
    synthesis: { version: NPC_NARRATIVE_FACTS_VERSION, thirdPartyClaims: claims },
    transcript, speaker, allowedSubjects: [speaker, subject], narrativeFacts: [], ...options,
  });
}

test('normalizes a bounded versioned synthesis envelope into plain JSON', () => {
  const source = { version: 99, thirdPartyClaims: Array.from({ length: 70 }, () => claim()) };
  const normalized = normalizeNarrativeClaimSynthesis(source);
  assert.equal(normalized.version, 1);
  assert.equal(normalized.thirdPartyClaims.length, 64);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), normalized);
  assert.deepEqual(normalizeNarrativeClaimSynthesis(null), { version: 1, thirdPartyClaims: [] });
});

test('accepts explicit exact assistant evidence about a distinct allowed NPC', () => {
  const result = plan();
  assert.equal(result.rejected.length, 0);
  assert.equal(result.proposals.length, 1);
  const fact = result.proposals[0].fact;
  assert.equal(fact.subjectId, subject.id);
  assert.equal(fact.status, 'asserted');
  assert.equal(fact.confidence, 0.7);
  assert.deepEqual(fact.knownBy, [speaker.id]);
  assert.deepEqual(fact.provenance, {
    speakerId: speaker.id, speakerName: speaker.name, role: 'assistant', messageIndex: 1,
    quote: 'Beatrice Bell repairs the old mill.',
  });
  assert.equal(Object.isFrozen(result), false);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('stable proposal, fact, and receipt IDs do not use time or randomness', () => {
  assert.deepEqual(plan(), plan());
  const changed = plan([claim({ value: 'carpenter' })]);
  assert.notEqual(changed.proposals[0].id, plan().proposals[0].id);
});

test('rejects invalid envelope versions without interpreting claims', () => {
  const result = planNpcNarrativeFacts({
    synthesis: { version: 2, thirdPartyClaims: [claim()] }, transcript, speaker,
    allowedSubjects: [subject], narrativeFacts: [],
  });
  assert.deepEqual(result, { version: 1, proposals: [], rejected: [{ index: -1, reason: 'invalid-envelope' }] });
});

test('rejects invented subjects and claims about the speaker', () => {
  assert.equal(plan([claim({ subjectId: 'npc:invented' })]).rejected[0].reason, 'invalid-subject');
  const self = claim({ subjectId: speaker.id });
  assert.equal(plan([self]).rejected[0].reason, 'invalid-subject');
});

test('rejects user, absent, wrong-speaker, and non-exact transcript evidence', () => {
  const cases = [
    [claim({ evidence: { messageIndex: 0, quote: 'What does Bea do?' } }), 'non-npc-evidence'],
    [claim({ evidence: { messageIndex: 9, quote: 'Beatrice Bell repairs the old mill.' } }), 'non-npc-evidence'],
    [claim({ evidence: { messageIndex: 1, quote: 'Beatrice repairs the mill.' } }), 'evidence-mismatch'],
  ];
  for (const [candidate, reason] of cases) assert.equal(plan([candidate]).rejected[0].reason, reason);
  const wrong = transcript.map((message) => ({ ...message }));
  wrong[1].speakerId = 'npc:other';
  assert.equal(plan([claim()], { transcript: wrong }).rejected[0].reason, 'speaker-mismatch');
  assert.equal(plan([claim({ statement: 'Beatrice Bell owns the old mill.' })]).rejected[0].reason,
    'evidence-mismatch');
  const authored = transcript.map((message) => ({ ...message }));
  authored[1].source = 'authored';
  assert.equal(plan([claim()], { transcript: authored }).rejected[0].reason,
    'non-generated-evidence');
});

test('requires an explicit subject name or alias in the evidence', () => {
  const vagueTranscript = [
    { role: 'assistant', speakerId: speaker.id, content: 'She repairs the old mill.' },
  ];
  const vague = claim({
    statement: 'She repairs the old mill.',
    evidence: { messageIndex: 0, quote: 'She repairs the old mill.' },
  });
  assert.equal(plan([vague], { transcript: vagueTranscript }).rejected[0].reason, 'subject-not-explicit');
});

test('rejects questions, hedging, hearsay, opinion, jokes, and hypotheticals', () => {
  for (const text of [
    'Maybe Bea repairs the mill.',
    'I heard Bea repairs the mill.',
    'I think Bea repairs the mill.',
    'Bea repairs the mill, just kidding.',
    'If Bea repaired the mill, it would run.',
    'Does Bea repair the mill?',
  ]) {
    const localTranscript = [{ role: 'assistant', speakerId: speaker.id, content: text }];
    const candidate = claim({ statement: text, evidence: { messageIndex: 0, quote: text } });
    assert.equal(plan([candidate], { transcript: localTranscript }).rejected[0].reason, 'non-asserted-evidence', text);
  }
});

test('rejects non-fact classifications, reserved rewrites, extra keys, and unsafe values', () => {
  assert.equal(plan([claim({ classification: 'opinion' })]).rejected[0].reason, 'invalid-classification');
  assert.equal(plan([claim({ factKey: 'residence.home' })]).rejected[0].reason, 'reserved-authoritative-field');
  assert.equal(plan([{ ...claim(), patch: { location: 'elsewhere' } }]).rejected[0].reason, 'malformed-claim');
  assert.equal(plan([claim({ value: { householdId: 'household:fake' } })]).rejected[0].reason, 'unsafe-value');
  assert.equal(plan([claim({ value: 'javascript:alert(1)' })]).rejected[0].reason, 'unsafe-value');
  assert.equal(plan([claim({ visibility: 'world-authoritative' })]).rejected[0].reason, 'invalid-visibility');
});

test('rejects duplicate claims in one synthesis and against stored facts', () => {
  const within = plan([claim(), claim()]);
  assert.equal(within.proposals.length, 1);
  assert.equal(within.rejected[0].reason, 'duplicate');
  const stored = plan().proposals[0].fact;
  const existing = plan([claim()], { narrativeFacts: [stored] });
  assert.equal(existing.rejected[0].reason, 'duplicate');
});

test('application is pure and exact-once with durable receipts', () => {
  const proposalPlan = plan();
  const initial = { narrativeFacts: [], receipts: [] };
  const first = applyNpcNarrativeFacts(initial, proposalPlan);
  assert.deepEqual(initial, { narrativeFacts: [], receipts: [] });
  assert.equal(first.applied.length, 1);
  assert.equal(first.narrativeFacts.length, 1);
  const second = applyNpcNarrativeFacts(first, proposalPlan);
  assert.equal(second.applied.length, 0);
  assert.equal(second.duplicates.length, 1);
  assert.deepEqual(second.narrativeFacts, first.narrativeFacts);
  assert.deepEqual(second.receipts, first.receipts);
  assert.deepEqual(JSON.parse(JSON.stringify(second)), second);
});

test('receipt collision and an orphaned fact ID fail closed', () => {
  const proposalPlan = plan();
  const proposal = proposalPlan.proposals[0];
  assert.throws(() => applyNpcNarrativeFacts({
    narrativeFacts: [], receipts: [{ id: proposal.receiptId, factId: 'other', proposalId: proposal.id }],
  }, proposalPlan), /receipt collision/);
  assert.throws(() => applyNpcNarrativeFacts({
    narrativeFacts: [{ ...proposal.fact }], receipts: [],
  }, proposalPlan), /exists without its receipt/);
});

test('contradictory values dispute both facts without erasing either account', () => {
  const existing = plan().proposals[0].fact;
  const contradiction = plan([claim({ value: 'baker' })], { narrativeFacts: [existing] });
  assert.equal(contradiction.proposals[0].fact.status, 'disputed');
  assert.deepEqual(contradiction.proposals[0].fact.contradicts, [existing.id]);
  const applied = applyNpcNarrativeFacts({ narrativeFacts: [existing], receipts: [] }, contradiction);
  assert.equal(applied.narrativeFacts.length, 2);
  assert.ok(applied.narrativeFacts.every((fact) => fact.status === 'disputed'));
});

test('authoritative subject confirmation is scoped, deterministic, and exact-once', () => {
  const existing = plan().proposals[0].fact;
  const initial = { narrativeFacts: [existing], receipts: [] };
  const first = confirmNpcNarrativeFacts(initial, { subjectId: subject.id, factIds: [existing.id] });
  assert.equal(first.narrativeFacts[0].status, 'confirmed');
  assert.equal(first.narrativeFacts[0].confidence, 1);
  assert.deepEqual(first.narrativeFacts[0].knownBy, [speaker.id, subject.id].sort());
  assert.equal(first.applied.length, 1);
  const retry = confirmNpcNarrativeFacts(first, { subjectId: subject.id, factIds: [existing.id] });
  assert.equal(retry.applied.length, 0);
  assert.equal(retry.receipts.length, 1);
  const wrong = confirmNpcNarrativeFacts(initial, { subjectId: 'npc:other', factIds: [existing.id] });
  assert.deepEqual(wrong.narrativeFacts, initial.narrativeFacts);
});

test('memory projection is bounded new-first, deduplicated, and never increments meetings', () => {
  const facts = Array.from({ length: 4 }, (_, index) => ({
    ...plan([claim({ factKey: `detail-${index}`, value: index })]).proposals[0].fact,
    id: `fact:${index}`,
    statement: index === 3 ? 'Old fact' : `New fact ${index}`,
    knownBy: [speaker.id],
  }));
  const memory = {
    version: 2, npcId: speaker.id, meetingCount: 7, npcFacts: ['Old fact', 'Ancient fact'],
    playerFacts: ['unchanged'], lastConversationSummary: 'also unchanged',
  };
  const projected = projectNarrativeFactsToMemory(memory, facts, { limit: 4 });
  assert.deepEqual(projected.npcFacts, ['New fact 0', 'New fact 1', 'New fact 2', 'Old fact']);
  assert.equal(projected.meetingCount, 7);
  assert.deepEqual(projected.playerFacts, ['unchanged']);
  assert.deepEqual(memory.npcFacts, ['Old fact', 'Ancient fact']);
  assert.deepEqual(projectNarrativeFactsToMemory(memory, facts, { targetNpcId: subject.id }).npcFacts,
    ['New fact 0', 'New fact 1', 'New fact 2', 'Old fact', 'Ancient fact']);
});

test('call-level malformed data throws before any application can occur', () => {
  assert.throws(() => planNpcNarrativeFacts(), /speaker/);
  assert.throws(() => planNpcNarrativeFacts({ speaker, allowedSubjects: {}, transcript: [] }), /allowedSubjects/);
  assert.throws(() => projectNarrativeFactsToMemory([], []), /memory/);
  assert.throws(() => applyNpcNarrativeFacts({ narrativeFacts: {}, receipts: [] }, plan()), /must be arrays/);
});
