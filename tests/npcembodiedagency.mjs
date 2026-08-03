import test from 'node:test';
import assert from 'node:assert/strict';
import { createLivingWorldState, normalizeLivingWorldState } from '../src/livingworldstate.mjs';
import { ACTIVITY_PRIORITY, activityFor, claimActivity, createActivityArbiter, releaseActivity } from '../src/npcactivity.mjs';
import { auditIntentPropCatalog, createItem, deriveNpcLoadout, freeGestureHand, INTENT_PROP_RENDER_BUDGET, transferItem } from '../src/npcitems.mjs';
import { advanceInteractions, createInteractionEpisode, interactionCandidateFor, INTERACTION_KINDS, interactionLine, resolveInteraction } from '../src/npcinteraction.mjs';
import { applyGroupEpisodeEvent, advanceTravelGroup, createTravelGroup, formationOffset, groupEpisodeLine, groupForActor, removeGroupMember, setGroupEpisode } from '../src/npcgroup.mjs';
import { actionAnchorSignature, nearestActionAnchor, registerActionAnchor } from '../src/npcactionanchors.mjs';
import { advanceSituatedAction, planSituatedAction, situatedActionCandidatesFor, situatedActionLine, SITUATED_ACTIONS } from '../src/npcsituatedaction.mjs';
import { auditLivingWorldState } from '../src/livingworldquality.mjs';

function stateWithPeople() {
  const state = createLivingWorldState();
  for (const id of ['npc:a', 'npc:b', 'npc:c', 'player:local']) state.entities[id] = { id, kind: id.startsWith('npc') ? 'npc' : 'player' };
  return state;
}

test('activity arbiter lets safety and dialogue preempt lower-priority work', () => {
  const arbiter = createActivityArbiter();
  assert.equal(claimActivity(arbiter, 'npc:a', 'situated').accepted, true);
  assert.equal(claimActivity(arbiter, 'npc:a', 'ambient').accepted, false);
  const safety = claimActivity(arbiter, 'npc:a', 'safety', { priority: ACTIVITY_PRIORITY.safety });
  assert.equal(safety.interrupted.activity, 'situated');
  assert.equal(activityFor(arbiter, 'npc:a').activity, 'safety');
  assert.equal(releaseActivity(arbiter, 'npc:a', 'safety'), true);
});

test('v2 letters migrate to authoritative item instances', () => {
  const migrated = normalizeLivingWorldState({ version: 2, projections: { letters: { post: { ownerId: 'npc:a', status: 'sealed' } } } });
  assert.equal(migrated.version, 4);
  assert.equal(migrated.projections.items['item:post'].kind, 'letter');
  assert.equal(migrated.projections.letters.post.itemId, 'item:post');
});

test('loadout respects two hands and provides a free gesture hand when possible', () => {
  const state = stateWithPeople();
  createItem(state, { id: 'parcel:1', kind: 'parcel', ownerId: 'npc:a', purpose: 'commitment' });
  createItem(state, { id: 'lamp:1', kind: 'lantern', ownerId: 'npc:a', purpose: 'ambient' });
  const loadout = deriveNpcLoadout(state, 'npc:a');
  assert.equal(loadout.leftHand.itemId, 'parcel:1');
  assert.equal(loadout.rightHand.itemId, 'parcel:1');
  assert.equal(loadout.back.itemId, 'lamp:1');
  assert.equal(freeGestureHand(loadout), null);
  assert.equal(transferItem(state, 'parcel:1', 'npc:b', { eventId: 'handoff:1' }).transferred, true);
  assert.equal(transferItem(state, 'parcel:1', 'npc:b', { eventId: 'handoff:1' }).duplicate, true);
});

test('all seven core props have distinct silhouettes inside renderer/XR budgets', () => {
  const audit = auditIntentPropCatalog();
  assert.equal(audit.ok, true);
  assert.equal(audit.supported.length, 7);
  assert.equal(audit.distinctSilhouettes, 7);
  assert.equal(INTENT_PROP_RENDER_BUDGET.dynamicLights, 0);
  assert.equal(INTENT_PROP_RENDER_BUDGET.xrResidentCapReduction, 0);
});

test('only one grounded NPC offer may request attention and it resolves once', () => {
  const state = stateWithPeople();
  const offer = createInteractionEpisode(state, { actorId: 'npc:a', kind: 'warn-weather', reason: 'storm', evidence: { provenance: 'observed', fact: 'rain' } });
  assert.ok(offer);
  assert.equal(createInteractionEpisode(state, { actorId: 'npc:b', kind: 'ask-help', reason: 'load', evidence: { provenance: 'observed' } }), null);
  assert.equal(resolveInteraction(state, offer.id, 'listen').applied, true);
  assert.equal(resolveInteraction(state, offer.id, 'listen').duplicate, true);
  assert.equal(state.metrics.acceptedOffers, 1);
  const later = createInteractionEpisode(state, { actorId: 'npc:b', kind: 'confront', reason: 'rumor', evidence: { provenance: 'heard' } });
  assert.equal(later, null);
  advanceInteractions(state, 1);
});

test('the complete initiated-interaction catalog has authored grounded fallback lines', () => {
  for (const kind of INTERACTION_KINDS) {
    const state = stateWithPeople();
    const episode = createInteractionEpisode(state, {
      actorId: 'npc:a', kind, reason: 'fixture reason', evidence: { provenance: 'observed', fact: kind },
    });
    assert.ok(episode, kind);
    assert.match(interactionLine(episode, 'Mara'), /Mara/);
  }
});

test('live interaction planner can ground all six kinds without model-created facts', () => {
  const state = stateWithPeople();
  const actor = { id: 'npc:a' };
  const fixtures = [
    [{ confrontationEvidence: { provenance: 'observed', eventId: 'event:direct' } }, 'confront'],
    [{ storm: true, weather: 'storm' }, 'warn-weather'],
    [{ damagedEquipment: { id: 'item:broken' } }, 'ask-help'],
    [{ tradeItem: { id: 'item:basket', condition: 'full' } }, 'offer-trade'],
    [{ metPlayerBefore: true, relationshipEventId: 'event:met' }, 'recognize-player'],
    [{ destinationKey: 'place:north', commitmentId: 'commitment:one' }, 'request-directions'],
  ];
  for (const [facts, kind] of fixtures) assert.equal(interactionCandidateFor(state, actor, facts).kind, kind);
});

test('accepted interaction consequence is exactly once and updates relationship/holdings', () => {
  const state = stateWithPeople();
  const episode = createInteractionEpisode(state, { actorId: 'npc:a', kind: 'offer-trade', reason: 'owned goods', evidence: { provenance: 'observed', itemId: 'basket' } });
  resolveInteraction(state, episode.id, 'trade');
  resolveInteraction(state, episode.id, 'trade');
  assert.equal(state.projections.playerHoldings.tradeGoods, 1);
  assert.equal(state.projections.interactionOutcomes[episode.id].accepted, true);
  assert.ok(state.relationships['npc:a|player:local']);
});

test('groups have exclusive membership, slowest pace, formation, and safe split', () => {
  const state = stateWithPeople();
  const group = createTravelGroup(state, { memberIds: ['npc:a', 'npc:b'], pace: 2 });
  assert.ok(group);
  assert.equal(createTravelGroup(state, { memberIds: ['npc:a', 'npc:c'] }), null);
  advanceTravelGroup(group, 1, [{ pace: 0.4 }, { pace: 0.8 }]);
  assert.equal(group.progress, 0.4);
  assert.ok(formationOffset(group, 'npc:b'));
  setGroupEpisode(state, group.id, 'argue', { paused: true });
  assert.equal(group.state, 'paused');
  assert.equal(groupForActor(state, 'npc:a').id, group.id);
  removeGroupMember(state, group.id, 'npc:a');
  assert.equal(group.state, 'dissolved');
});

test('all five group episodes have deterministic event-sourced transitions and fallback text', () => {
  const state = stateWithPeople();
  const group = createTravelGroup(state, { memberIds: ['npc:a', 'npc:b', 'npc:c'] });
  const events = [
    { id: 'group:e1', type: 'group.rendezvous' },
    { id: 'group:e2', type: 'group.risk-entered', riskScore: 0.7 },
    { id: 'group:e3', type: 'group.risk-cleared' },
    { id: 'group:e4', type: 'group.argument-started' },
    { id: 'group:e5', type: 'group.argument-resolved', split: true },
    { id: 'group:e6', type: 'group.split-completed' },
  ];
  const seen = new Set([group.episode]);
  for (const event of events) {
    const result = applyGroupEpisodeEvent(state, group.id, event, { nowHour: events.indexOf(event) + 1 });
    assert.equal(result.applied, true);
    const current = state.groups[group.id];
    seen.add(current.episode);
    assert.match(groupEpisodeLine(current, ['A', 'B']), /A and B/);
  }
  assert.deepEqual([...seen].sort(), ['accompany-risk', 'argue', 'meet', 'split', 'walk']);
  assert.equal(applyGroupEpisodeEvent(state, group.id, events[5], { nowHour: 7 }).duplicate, true);
});

test('situated actions require world anchors and preconditions and can be interrupted', () => {
  const state = stateWithPeople();
  registerActionAnchor(state, { id: 'shelter:one', kind: 'shelter', x: 2, z: 0 });
  assert.equal(nearestActionAnchor(state, 'shelter', { x: 0, z: 0 }).anchor.id, 'shelter:one');
  assert.equal(planSituatedAction(state, { actorId: 'npc:a', kind: 'shelter-rain', facts: {}, position: { x: 0, z: 0 } }), null);
  const action = planSituatedAction(state, { actorId: 'npc:a', kind: 'shelter-rain', facts: { raining: true }, position: { x: 0, z: 0 } });
  assert.equal(action.state, 'approaching');
  advanceSituatedAction(state, action.id, { distance: 1, hours: 0.001 });
  assert.equal(action.state, 'acting');
  advanceSituatedAction(state, action.id, { interruptedBy: 'dialogue' });
  assert.equal(action.state, 'interrupted');
  assert.equal(auditLivingWorldState(state).ok, true);
});

test('action anchor registration produces a stable seed-independent signature', () => {
  const a = stateWithPeople();
  const b = stateWithPeople();
  for (const state of [a, b]) {
    registerActionAnchor(state, { id: 'marker:b', kind: 'trail-marker', x: 2.345, z: 8.765, capacity: 2 });
    registerActionAnchor(state, { id: 'shelter:a', kind: 'shelter', x: 1, z: 4, capacity: 4 });
  }
  assert.equal(actionAnchorSignature(a), actionAnchorSignature(b));
});

test('the complete situated-action catalog plans against matching world facts', () => {
  const anchorFor = { shelter: 'shelter', stream: 'stream', 'map-point': 'map-point', 'repair-site': 'repair-site', 'trail-marker': 'trail-marker', platform: 'platform' };
  for (const [kind, rule] of Object.entries(SITUATED_ACTIONS)) {
    const state = stateWithPeople();
    registerActionAnchor(state, { id: `anchor:${kind}`, kind: anchorFor[rule.anchor], x: 0, z: 0 });
    const action = planSituatedAction(state, {
      actorId: 'npc:a', kind, position: { x: 0, z: 0 }, facts: { raining: true, thirsty: true, trainDue: true },
      itemKinds: ['map', 'boot-kit', 'tools'],
    });
    assert.ok(action, kind);
    advanceSituatedAction(state, action.id, { hours: action.durationHours, distance: 0, nowHour: 1 });
    assert.equal(action.state, 'completed', kind);
    assert.match(situatedActionLine(action, 'Mara'), /Mara/);
  }
});

test('situated scheduler exposes every eligible action and interrupts invalidated work', () => {
  const state = stateWithPeople();
  const candidates = situatedActionCandidatesFor(state, { id: 'npc:a' }, {
    raining: true, thirsty: true, hasStreamAnchor: true, bootsNeedRepair: true,
    hasTrailMarker: true, trainDue: true, hasRepairSite: true,
  }, ['map', 'boot-kit', 'tools']);
  assert.deepEqual(new Set(candidates.map((entry) => entry.kind)), new Set(Object.keys(SITUATED_ACTIONS)));
  registerActionAnchor(state, { id: 'platform:one', kind: 'platform', x: 0, z: 0 });
  const waiting = planSituatedAction(state, { actorId: 'npc:a', kind: 'wait-train', facts: { trainDue: true }, position: { x: 0, z: 0 } });
  advanceSituatedAction(state, waiting.id, { facts: { trainDue: false }, nowHour: 0.01 });
  assert.equal(waiting.state, 'interrupted');
  assert.equal(waiting.interruptedBy, 'precondition-ended');
});
