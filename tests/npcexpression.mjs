import test from 'node:test';
import assert from 'node:assert/strict';
import { NPC_GESTURES, npcBlinkAt, buildSpeechEnvelope, mouthAmountAt, npcGesturePose } from '../src/npcexpression.mjs';
import { parseNpcDelivery, decodeNpcDialogue, NPC_DELIVERY_INSTRUCTIONS } from '../src/npcspeech.mjs';

test('idle blinks are bounded, repeatable and offset between characters', () => {
  const series = seed => Array.from({ length: 1600 }, (_, i) => npcBlinkAt(i / 40, seed));
  const a = series(17), b = series(31);
  assert.deepEqual(a, series(17));
  assert.notDeepEqual(a, b);
  assert.ok(a.every(value => value >= 0 && value <= 1));
  assert.ok(a.filter(value => value > 0.9).length >= 5, 'blink while idle throughout the sampled scene');
  assert.ok(a.filter(value => value === 0).length > 1400, 'eyes stay open between blinks');
});

test('mouth movement follows audible syllables and rests during silence and outside playback', () => {
  const samples = new Float32Array(120);
  samples.fill(0.2, 20, 40); samples.fill(0.5, 60, 80);
  const envelope = buildSpeechEnvelope(samples, 1000);
  assert.equal(mouthAmountAt(envelope, 0), 0);
  assert.ok(mouthAmountAt(envelope, 0.02) > 0.4);
  assert.equal(mouthAmountAt(envelope, 0.04), 0);
  assert.ok(mouthAmountAt(envelope, 0.06) > mouthAmountAt(envelope, 0.02));
  assert.equal(mouthAmountAt(envelope, -0.1), 0);
  assert.equal(mouthAmountAt(envelope, 0.12), 0);
  assert.equal(mouthAmountAt(buildSpeechEnvelope(new Float32Array(2400)), 0.05), 0);
});

test('gesture clips touch only upper-body rotations and release without changing planted feet', () => {
  for (const [name, clip] of Object.entries(NPC_GESTURES)) {
    for (let i = 0; i < 20; i++) {
      const pose = npcGesturePose(name, i / 20 * clip.duration);
      assert.ok(pose);
      assert.ok(Object.keys(pose).every(bone => !/hips|Thigh|Shin|Foot/i.test(bone)));
      assert.ok(Object.values(pose).flat().every(Number.isFinite));
      if (!i) assert.ok(Object.values(pose).flat().every(value => value === 0));
    }
    assert.equal(npcGesturePose(name, clip.duration), null);
  }
  assert.equal(npcGesturePose('constructor', 0.5), null);
  assert.equal(npcGesturePose('invented', 0.5), null);
  const right = npcGesturePose('open-hand', 0.9), left = npcGesturePose('open-hand', 0.9, 'left');
  assert.equal(right.rightUpperArm[2], -left.leftUpperArm[2]);
});

test('silent gestures partition speech at exact cue positions without losing words, vocal tags or styles', () => {
  const raw = decodeNpcDialogue(JSON.stringify({ segments: [
    { text: 'Let me think. <gesture:nod> <chuckle> Yes, that is sensible.', style: 'thoughtful, then warmly agreeable' },
    { text: '<gesture:point> The mill lies along that lane.', style: 'helpful' },
  ] }));
  const parsed = parseNpcDelivery(raw);
  assert.equal(parsed.displayText, 'Let me think. Yes, that is sensible. The mill lies along that lane.');
  assert.deepEqual(parsed.segments, [
    { input: 'Let me think.', style: 'thoughtful, then warmly agreeable' },
    { input: '<chuckle> Yes, that is sensible.', style: 'thoughtful, then warmly agreeable', gesture: 'nod' },
    { input: 'The mill lies along that lane.', style: 'helpful', gesture: 'point' },
  ]);
  assert.ok(!parsed.segments.some(part => part.input.includes('gesture:')));
  assert.match(raw.text, /<gesture:point>/, 'the original evidence is preserved');
});

test('unknown cues and model-created gesture storms remain silent and bounded', () => {
  const parsed = parseNpcDelivery('Hello <gesture:invented>. <gesture:nod> Yes. <gesture:shrug> Perhaps. <gesture:wave> Goodbye.');
  assert.equal(parsed.segments.filter(part => part.gesture).length, 2);
  assert.equal(parsed.segments.map(part => part.input).join(' '), 'Hello. Yes. Perhaps. Goodbye.');
  assert.ok(!parsed.displayText.includes('<'));
  assert.match(NPC_DELIVERY_INSTRUCTIONS, /<gesture:point>/);
  assert.match(NPC_DELIVERY_INSTRUCTIONS, /at most two per reply/);
});
