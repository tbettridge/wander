import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { findMentionedTarget } from '../src/livingworldcontext.mjs';
import { npcDialogueText } from '../src/npcspeech.mjs';
import { createEmote, pulsePoint, pulseDelivery } from '../src/npcsocial.mjs';

const source = await readFile(new URL('../src/stationkeeper.js', import.meta.url), 'utf8');
const render = source.slice(source.indexOf('  renderDialogue('), source.indexOf('\n  performSpeechSegment('));
const perform = source.slice(source.indexOf('  performSpeechSegment('), source.indexOf('\n  focusDialogue('));
const point = source.slice(source.indexOf('  pointOut('), source.indexOf('\n  conversationPartner('));

test('directional pointing waits for the spoken place segment and uses that place’s current world bearing', async () => {
  let resolveSpeech;
  const actor = { identity: { id: 'npc:maren' }, avatar: { root: { position: { x: 5, z: 12 } } }, emote: createEmote(42) };
  const globals = { findMentionedTarget, npcDialogueText, pulsePoint, pulseDelivery, Promise };
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
  population.cancelSpeechPerformance(actor.identity.id);
  assert.equal(actor.emote.pointLive, false, 'closing or interrupting speech lowers the point');
  assert.equal(population.speechReferencePlace, null, 'an earlier utterance cannot aim the next one at an old place');
  resolveSpeech(true); await Promise.resolve();
});

test('a point cue without a known location cannot invent a world bearing', () => {
  const actor = { identity: { id: 'npc:maren' }, emote: createEmote(42) };
  const population = vm.runInNewContext(`new (class {${perform}})()`, { findMentionedTarget, npcDialogueText, pulseDelivery });
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
    HANDHELD_ACCESSORIES: new Set(['basket']),
  });
  population.features = { intentPropsEnabled: true }; population.worldState = {};
  population.speechPlayer = { performanceFor: () => speech };
  population.solveGait({ identity: { id: 'npc:maren', animation: { gestureHand: 'right' } },
    avatar: { root: { position: { x: 0, z: 0 } }, setIntentLoadout() {},
      applyPose(pose, y, options) { received = options; } }, groundY: 0, gestureTime: 1,
  }, {}, 0.016, true);
  assert.equal(received.speech, speech);
  assert.equal(received.speechGestureHand, 'left');
});
