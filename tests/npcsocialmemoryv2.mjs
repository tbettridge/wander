import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivingWorldState, registerLivingWorldEntity } from '../src/livingworldstate.mjs';
import {
  applyRelationshipDelta,
  memoriesFor,
  migrateLegacyNpcMemory,
  relationshipBand,
  relationshipBetween,
  rememberSocialMemory,
  socialContextFor,
  SOCIAL_MEMORY_LIMIT,
} from '../src/npcsocialmemory.mjs';

const ownerId = 'npc:wren:porter';
const subjectId = 'npc:ash:keeper';

function fixture() {
  const state = createLivingWorldState({ worldSeed: 2 });
  registerLivingWorldEntity(state, { id: ownerId, kind: 'npc', name: 'Maren Bell', role: 'porter' });
  registerLivingWorldEntity(state, { id: subjectId, kind: 'npc', name: 'Alder Reed', role: 'keeper' });
  return state;
}

test('relationships are directed, clamped, and event sourced', () => {
  const state = fixture();
  const event = { id: 'event:meeting', atHour: 8 };
  applyRelationshipDelta(state, ownerId, subjectId, {
    familiarity: 0.3, trust: 2, affinity: 0.1,
  }, event);
  const forward = relationshipBetween(state, ownerId, subjectId);
  const reverse = relationshipBetween(state, subjectId, ownerId);
  assert.equal(forward.familiarity, 0.3);
  assert.equal(forward.trust, 1);
  assert.equal(forward.lastEventId, event.id);
  assert.equal(relationshipBand(forward), 'trusted');
  assert.equal(reverse, null, 'the other person does not inherit reciprocal feelings');
});

test('social memories reference entities and deduplicate by lineage', () => {
  const state = fixture();
  const base = {
    ownerId,
    subject: { kind: 'npc', id: subjectId },
    predicate: 'commitment.outcome',
    object: { status: 'succeeded' },
    summary: 'Alder received a letter.',
    source: { kind: 'world-event', id: 'event:delivery' },
    provenance: 'observed',
    originEventId: 'event:delivery',
    lineageId: 'claim:event:delivery',
    confidence: 0.7,
    salience: 0.8,
    privacy: 'public',
    createdAtHour: 4,
  };
  rememberSocialMemory(state, ownerId, base, { nowHour: 4 });
  rememberSocialMemory(state, ownerId, { ...base, confidence: 0.95 }, { nowHour: 7 });
  assert.equal(state.memories[ownerId].length, 1);
  assert.equal(state.memories[ownerId][0].confidence, 0.95);
  assert.equal(state.memories[ownerId][0].lastRecalledHour, 7);
});

test('memory remains bounded and deterministic under pressure', () => {
  const state = fixture();
  for (let i = 0; i < SOCIAL_MEMORY_LIMIT + 20; i++) {
    rememberSocialMemory(state, ownerId, {
      ownerId,
      subject: { kind: 'npc', id: `npc:${i}` },
      predicate: 'npc.seen',
      object: { i },
      summary: `Saw person ${i}.`,
      source: { kind: 'world-event', id: `event:${i}` },
      provenance: 'observed',
      originEventId: `event:${i}`,
      lineageId: `claim:${i}`,
      confidence: 0.5,
      salience: i / 100,
      privacy: 'public',
      createdAtHour: i,
      lastRecalledHour: i,
    }, { nowHour: 100 });
  }
  assert.equal(state.memories[ownerId].length, SOCIAL_MEMORY_LIMIT);
  assert.equal(memoriesFor(state, ownerId, { nowHour: 100 }).length, SOCIAL_MEMORY_LIMIT);
  assert.ok(memoriesFor(state, ownerId, { nowHour: 100 })[0].salience
    >= memoriesFor(state, ownerId, { nowHour: 100 }).at(-1).salience);
});

test('legacy string memory migrates without becoming authoritative world fact', () => {
  const state = fixture();
  const migrated = migrateLegacyNpcMemory(state, ownerId, {
    playerFacts: ['The traveller prefers the coast path.'],
    npcFacts: ['Maren worked the dawn platform.'],
    quests: ['The traveller is looking for the old ring.'],
  }, { nowHour: 12 });
  assert.equal(migrated.length, 3);
  assert.ok(migrated.every((memory) => memory.provenance === 'legacy'));
  assert.ok(migrated.every((memory) => memory.originEventId === null));
  assert.ok(migrated.some((memory) => memory.subject.id === 'player:local'));
});

test('dialogue context exposes qualitative relationships and sourced claims', () => {
  const state = fixture();
  applyRelationshipDelta(state, ownerId, subjectId, { familiarity: 0.4 }, {
    id: 'event:met', atHour: 4,
  });
  rememberSocialMemory(state, ownerId, {
    ownerId,
    subject: { kind: 'npc', id: subjectId },
    predicate: 'npc.arrived',
    object: { placeKey: 'ash' },
    summary: 'Alder arrived at Ash Gate.',
    source: { kind: 'npc', id: subjectId },
    provenance: 'told',
    lineageId: 'claim:arrival',
    confidence: 0.7,
    salience: 0.8,
    privacy: 'public',
    createdAtHour: 5,
  }, { nowHour: 5 });
  const context = socialContextFor(state, ownerId, { nowHour: 6 });
  assert.equal(context.relevantPeople[0].name, 'Alder Reed');
  assert.equal(context.relevantPeople[0].relationship, 'familiar');
  assert.equal(context.memories[0].sourceName, 'Alder Reed');
  assert.equal(context.memories[0].provenance, 'told');
});
