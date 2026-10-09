import { npcPersonPoint, npcWhereaboutsReply } from '../src/npcwhereabouts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { findMentionedTarget } from '../src/livingworldcontext.mjs';
import { npcDialogueText } from '../src/npcspeech.mjs';
import { resolveNpcPointTarget, refreshNpcPointTarget, npcPointOptions, npcPointMotion, npcPointTurnWeight } from '../src/npcpointing.mjs';
import { createEmote, pulsePoint, pulseDelivery, pointAmount, advanceEmote, SOCIAL } from '../src/npcsocial.mjs';

const source = await readFile(new URL('../src/stationkeeper.js', import.meta.url), 'utf8');
const render = source.slice(source.indexOf('  renderDialogue('), source.indexOf('\n  performSpeechSegment('));
const perform = source.slice(source.indexOf('  performSpeechSegment('), source.indexOf('\n  focusDialogue('));
const point = source.slice(source.indexOf('  pointOut('), source.indexOf('\n  conversationPartner('));

test('directional pointing waits for the spoken place segment and uses that place’s current world bearing', async () => {
  let resolveSpeech;
  const actor = { identity: { id: 'npc:maren' }, avatar: { root: { position: { x: 5, z: 12 } } }, emote: createEmote(42) };
  const globals = { findMentionedTarget, npcDialogueText, pulsePoint, pulseDelivery, resolveNpcPointTarget, npcPersonPoint, npcWhereaboutsReply, Promise };
  const population = vm.runInNewContext(`new (class {${render}\n${perform}\n${point}})()`, globals);
  Object.assign(population, {
    activeNpc: actor, dialogueOpen: true, requestToken: 1,
    conversationContext: { npc: actor.identity,
      targets: [{ id: 'mill', label: 'Harrow Mill', name: 'Harrow Mill', worldX: 90, worldZ: -40 }], pointPlaces: [] },
    actorById: id => id === actor.identity.id ? actor : null,
    renderTranscript() {}, speechPlayer: { enabled: true,
      speak: () => new Promise(resolve => { resolveSpeech = resolve; }), performanceFor: () => ({ mouthOpen: 0.4 }) },
  });
  population.renderDialogue({ text: 'Hello. <gesture:point> Harrow Mill lies along that lane.' }, 'openrouter', {});
  assert.equal(actor.emote.pointLive, false, 'receiving text or waiting for TTS cannot trigger the point');
  population.performSpeechSegment(actor.identity.id, { input: 'Hello.' }, 1);
  assert.equal(actor.emote.pointLive, false);
  population.performSpeechSegment(actor.identity.id, { input: 'Harrow Mill is worth a visit.', gesture: 'nod' }, 1.2);
  assert.equal(actor.emote.pointLive, false);
  population.performSpeechSegment(actor.identity.id, { input: 'It lies over there, along that lane.', gesture: 'point' }, 2.7);
  assert.equal(actor.emote.pointLive, true);
  assert.equal(actor.emote.pointBearing, Math.atan2(85, -52));
  assert.equal(actor.emote.pointHold, 2.7);
  assert.equal(actor.emote.pointDistance, Math.hypot(85, -52));
  assert.deepEqual({...actor.emote.pointTarget}, {worldX: 90, worldZ: -40});
  population.cancelSpeechPerformance(actor.identity.id);
  assert.equal(actor.emote.pointLive, false, 'closing or interrupting speech lowers the point');
  assert.equal(population.speechReferencePlace, null, 'an earlier utterance cannot aim the next one at an old place');
  resolveSpeech(true); await Promise.resolve();
});

test('a point cue without a known location cannot invent a world bearing', () => {
  const actor = { identity: { id: 'npc:maren' }, emote: createEmote(42) };
  const population = vm.runInNewContext(`new (class {${perform}})()`, { findMentionedTarget, npcDialogueText, pulseDelivery, npcPersonPoint });
  population.actorById = () => actor;
  population.performSpeechSegment(actor.identity.id, { input: 'Somewhere far away.', gesture: 'point' }, 3, { targets: [] });
  assert.equal(actor.emote.pointLive, false);
});

test('station rigs receive speech performance after solving gait and keep the occupied hand free of gestures', () => {
  const start = source.indexOf('  solveGait('), method = source.slice(start, source.indexOf('\n  solveGaze(', start));
  const speech = { mouthOpen: 0.4, gestureName: 'open-hand', gestureElapsed: 0.5 };
  let received;
  const population = vm.runInNewContext(`new (class {${method}})()`, {
    advanceNpcLocomotion: () => ({}), deriveNpcLoadout: () => ({ rightHand: 'basket' }),
    freeGestureHand: () => 'left', gestureAmount: () => 0, pointAmount: () => 0,
    npcPointOptions,
    HANDHELD_ACCESSORIES: new Set(['basket']),
  });
  population.features = { intentPropsEnabled: true }; population.worldState = {};
  population.speechPlayer = { performanceFor: () => speech };
  population.solveGait({ identity: { id: 'npc:maren', animation: { gestureHand: 'right' } },
    emote: createEmote(1), avatar: { root: { position: { x: 0, z: 0 } }, setIntentLoadout() {},
      applyPose(pose, y, options) { received = options; } }, groundY: 0, gestureTime: 1,
  }, {}, 0.016, true);
  assert.equal(received.speech, speech);
  assert.equal(received.speechGestureHand, 'left');
});


test('landmark directions cover every compass octant from an offset speaker, including wraparound', () => {
  const origin = { x: -2817, z: 4139 };
  for (let i = -4; i < 4; i++) {
    const bearing = i * Math.PI / 4;
    const resolved = resolveNpcPointTarget(origin, {
      worldX: origin.x + Math.sin(bearing) * 240,
      worldZ: origin.z + Math.cos(bearing) * 240,
    });
    assert.ok(Math.abs(Math.atan2(Math.sin(resolved.bearing - bearing), Math.cos(resolved.bearing - bearing))) < 1e-12);
    assert.ok(Math.abs(resolved.distance - 240) < 1e-9);
  }
  for (const target of [{worldX: NaN, worldZ: 0}, {worldX: origin.x, worldZ: origin.z}, {}]) {
    assert.equal(resolveNpcPointTarget(origin, target), null);
  }
});

test('a held point recomputes distance and direction when its speaker moves', () => {
  const emote = createEmote(3), target = {worldX: 100, worldZ: 0};
  pulsePoint(emote, Math.PI / 2, 2, 100, target);
  target.worldX = 999; // The cue stores its own destination.
  refreshNpcPointTarget(emote, {x: 100, z: -40});
  assert.equal(emote.pointBearing, 0);
  assert.equal(emote.pointDistance, 40);
  assert.equal(npcPointMotion(emote.pointDistance).style, 'near');
  refreshNpcPointTarget(emote, {x: 100, z: 0});
  assert.equal(emote.pointLive, false, 'no arbitrary northward point at a co-located place');
});

test('distance poses have distinct height and palm orientation, with exactly two farthest throws', () => {
  assert.equal(npcPointMotion(79.99).style, 'near');
  assert.equal(npcPointMotion(80).style, 'far');
  assert.equal(npcPointMotion(949.99).style, 'far');
  assert.equal(npcPointMotion(950).style, 'farthest');
  const near = npcPointMotion(20), far = npcPointMotion(200), farthest = npcPointMotion(2000);
  assert.ok(near.upperPitch < far.upperPitch && far.upperPitch < farthest.upperPitch);
  assert.equal(near.palmUp, true); assert.equal(far.palmUp, false); assert.equal(farthest.palmUp, false);
  for (const hold of [1.2, 2.6, 4.5]) {
    let peaks = 0, last = 0, rising = false;
    for (let elapsed = 0; elapsed < hold + SOCIAL.pointAttack; elapsed += .002) {
      const paw = npcPointMotion(2000, elapsed, hold).paw;
      if (paw < last && rising) { peaks++; rising = false; }
      if (paw > last) rising = true;
      last = paw;
    }
    assert.equal(peaks, 2, `two throws in a ${hold}s phrase`);
    assert.equal(npcPointMotion(2000, hold + 1, hold).paw, 0, 'no extra throw during release');
    assert.equal(npcPointMotion(200, 1, hold).paw, 0);
  }
});

test('point lifts and releases smoothly, and waits to turn before reaching behind the back', () => {
  const emote = createEmote(1); pulsePoint(emote, 0, 1.2);
  assert.equal(pointAmount(emote), 0);
  advanceEmote(emote, .01); assert.ok(pointAmount(emote) < .002);
  advanceEmote(emote, SOCIAL.pointAttack); assert.equal(pointAmount(emote), 1);
  advanceEmote(emote, 4); assert.equal(pointAmount(emote), 0);
  assert.equal(npcPointTurnWeight(0), 1);
  assert.equal(npcPointTurnWeight(Math.PI / 3), 1);
  assert.equal(npcPointTurnWeight(Math.PI), 0);
  assert.equal(npcPointTurnWeight(-Math.PI), 0);
});


test('pointing to "right here" lowers an earlier landmark point instead of choosing north', () => {
  const actor = { avatar: {root: {position: {x: 5, z: 12}}}, emote: createEmote(1) };
  const population = vm.runInNewContext(`new (class {${point}})()`, {resolveNpcPointTarget, pulsePoint});
  population.pointOut(actor, {worldX: 100, worldZ: 50}, 2);
  assert.equal(actor.emote.pointLive, true);
  assert.equal(population.pointOut(actor, {worldX: 5, worldZ: 12}, 2), null);
  assert.equal(actor.emote.pointLive, false);
  assert.equal(actor.emote.pointTarget, null);
});


test('repeated landmark names use the spoken direction and distance instead of list order', () => {
  const near = {name: 'the great tree', distanceM: 480, distancePhrase: 'about five hundred metres', direction: 'north-east'};
  const far = {name: 'the great tree', distanceM: 760, distancePhrase: 'about eight hundred metres', direction: 'east'};
  assert.equal(findMentionedTarget([near, far], 'The great tree is eight hundred metres to the east.'), far);
  assert.equal(findMentionedTarget([far, near], 'The great tree is to the north-east.'), near);
  assert.equal(findMentionedTarget([far, near], 'The great tree is to the northeast.'), near);
  assert.equal(findMentionedTarget([far, near], 'The great tree is worth seeing.'), near);
  assert.equal(findMentionedTarget([near, far], 'The farther great tree is worth seeing.'), far);
});
