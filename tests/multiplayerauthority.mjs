import assert from 'node:assert/strict';
import test from 'node:test';
import { applyStateDelta } from '../src/multiplayerprotocol.mjs';
import { GuestWorldProjection, HostWorldAuthority } from '../src/multiplayerauthority.mjs';

test('host authority deduplicates intents and never exposes private narrative state', () => {
  const host = new HostWorldAuthority({
    regionId: 'region-a', worldSeed: 7,
    state: {
      regionFacts: { weather: 'clear' },
      entities: { 'npc:keeper': { id: 'npc:keeper', kind: 'npc', name: 'Mara', role: 'station keeper', secret: 'private' } },
      narrativeFacts: { secret: { statement: 'do not send' } },
      memories: { 'npc:keeper': [{ summary: 'private' }] },
    },
  });
  assert.equal(host.admit('player:guest').ok, true);
  const intent = { intentId: 'intent:1', kind: 'place-marker', marker: { x: 2, z: 3 } };
  const reduce = (state, incoming) => { state.publicProjections.markers = { [incoming.intentId]: incoming.marker }; };
  assert.equal(host.applyIntent('player:guest', intent, reduce).applied, true);
  assert.equal(host.applyIntent('player:guest', intent, reduce).duplicate, true);
  const snapshot = host.snapshotFor('player:guest');
  assert.equal(snapshot.state.narrativeFacts, undefined);
  assert.equal(snapshot.state.memories, undefined);
  assert.equal(snapshot.state.entities['npc:keeper'].secret, undefined);
  assert.equal(snapshot.state.publicProjections['markers']['intent:1'].x, 2);
});

test('guest projection requires contiguous host revisions', () => {
  const host = new HostWorldAuthority({ regionId: 'region-a', worldSeed: 7, state: { publicProjections: { count: 0 } } });
  host.admit('player:guest');
  const guest = new GuestWorldProjection();
  guest.applySnapshot(host.snapshotFor('player:guest'));
  host.applyIntent('player:guest', { intentId: 'i', kind: 'increment' }, (state) => { state.publicProjections.count += 1; });
  const delta = host.deltaFor('player:guest', [{ op: 'set', path: 'publicProjections.count', value: 1 }], 0);
  guest.applyDelta(delta, applyStateDelta);
  assert.equal(guest.state.publicProjections.count, 1);
  assert.throws(() => guest.applyDelta({ ...delta, baseRevision: 0, revision: 3 }, applyStateDelta), /contiguous/);
});

test('authority remains attached to the host state and only public graph facts cross the boundary', () => {
  const canonical = {
    revision: 4,
    entities: { 'npc:keeper': { id: 'npc:keeper', kind: 'npc', name: 'Mara', role: 'keeper' } },
    narrativeFacts: {
      publicFact: { id: 'publicFact', subjectId: 'npc:keeper', statement: 'The bell rings at dusk', visibility: 'public' },
      privateFact: { id: 'privateFact', subjectId: 'npc:keeper', statement: 'A private promise', visibility: 'private' },
    },
  };
  const host = new HostWorldAuthority({ regionId: 'region-a', worldSeed: 7, state: canonical });
  host.admit('player:guest');
  host.applyIntent('player:guest', { intentId: 'i:1', kind: 'set-public' }, (state) => {
    state.publicProjections.notice = 'shared';
    return { operations: [{ op: 'set', path: 'publicProjections.notice', value: 'shared' }] };
  });
  assert.equal(canonical.publicProjections.notice, 'shared');
  const snapshot = host.snapshotFor('player:guest');
  assert.equal(snapshot.state.publicKnowledgeGraph.facts.publicFact.statement, 'The bell rings at dusk');
  assert.equal(snapshot.state.publicKnowledgeGraph.facts.privateFact, undefined);
  assert.equal(snapshot.state.narrativeFacts, undefined);
});
