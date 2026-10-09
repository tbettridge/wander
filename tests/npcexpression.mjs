import test from 'node:test';
import assert from 'node:assert/strict';
import { NPC_GESTURES, npcBlinkAt, buildSpeechEnvelope, mouthAmountAt, npcGesturePose,
  npcGestureArmTargets, npcGestureChestBounce, npcGestureWeight } from '../src/npcexpression.mjs';
import { parseNpcDelivery, decodeNpcDialogue, NPC_DELIVERY_INSTRUCTIONS } from '../src/npcspeech.mjs';
import { npcBindDimensions } from '../src/npcanatomy.mjs';
import { solveNpcArmReach } from '../src/npcgestureik.mjs';
import { applyInteriorFurniturePose } from '../src/interiornpcpose.mjs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

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
  assert.match(NPC_DELIVERY_INSTRUCTIONS, /at least one and no more than two/);
});

test('all ten requested gestures are available and ordinary dialogue always gets one subtle fallback', () => {
  assert.equal(Object.keys(NPC_GESTURES).length, 19);
  for (const name of ['hand-beats', 'laugh-bounce', 'hold-on', 'crossed-arms', 'downcast',
    'hands-behind-back', 'hair-tuck', 'look-over-shoulder', 'fearful-glance', 'curious-lean']) assert.ok(NPC_GESTURES[name]);
  const plain = parseNpcDelivery('A quiet story about the lane.');
  assert.equal(plain.segments[0].gesture, 'hand-beats');
  assert.equal(plain.segments[0].input, plain.displayText);
  assert.match(NPC_DELIVERY_INSTRUCTIONS, /MUST contain one or two gesture markers/);
  assert.match(NPC_DELIVERY_INSTRUCTIONS, /If no specific gesture fits, use <gesture:hand-beats>/);
  assert.match(NPC_DELIVERY_INSTRUCTIONS, /story, emotion or meaning/);
  assert.equal(parseNpcDelivery('').segments.length, 0);
});

test('two-handed postures and hair brushing use finite anatomical reach targets across body shapes', () => {
  for (const proportions of [{}, { legScale: 0.8, build: 0.85, headScale: 1.3 }, { legScale: 1.1, build: 1.35 }]) {
    const dims = npcBindDimensions(proportions);
    for (const name of ['hold-on', 'crossed-arms', 'hands-behind-back', 'hair-tuck']) {
      const clip = NPC_GESTURES[name], targets = npcGestureArmTargets(name, clip.duration / 2, dims);
      assert.equal(targets.length, name === 'hair-tuck' ? 1 : 2);
      for (const target of targets) {
        assert.ok(target.offset.every(Number.isFinite));
        assert.ok(target.weight > 0.9);
      }
      assert.deepEqual(npcGestureArmTargets(name, clip.duration, dims), []);
    }
  }
  const stop = npcGestureArmTargets('hold-on', 1, npcBindDimensions());
  assert.ok(stop.every(target => target.palm === 0 && target.offset[2] > 0), 'both palms face out in front');
  assert.ok(npcGestureArmTargets('hands-behind-back', 1, npcBindDimensions()).every(target => target.offset[2] < 0));
});

test('arm reach preserves bone lengths, reaches 3D targets, and bounds unreachable or degenerate inputs', () => {
  for (const target of [[0.1, -0.2, 0.25], [-0.25, -0.15, 0.18], [0.05, -0.25, -0.3], [0.08, 0.22, 0.12]]) {
    const solved = solveNpcArmReach(target, 0.3, 0.25);
    assert.ok(Math.abs(Math.hypot(...solved.upper) - 1) < 1e-9);
    assert.ok(Math.abs(Math.hypot(...solved.lower) - 1) < 1e-9);
    const reached = solved.upper.map((value, i) => value * 0.3 + solved.lower[i] * 0.25);
    assert.ok(Math.hypot(...reached.map((value, i) => value - target[i])) < 1e-9);
  }
  for (const target of [[0, 0, 0], [0, -10, 0], [0, -0.4, 0]]) {
    const solved = solveNpcArmReach(target, 0.3, 0.25, [0, -1, 0]);
    assert.ok([...solved.upper, ...solved.lower, ...solved.wrist].every(Number.isFinite));
    assert.ok(Math.hypot(...solved.wrist) < 0.55);
  }
  assert.equal(solveNpcArmReach([NaN, 0, 0], 0.3, 0.25), null);
  assert.equal(solveNpcArmReach([0, 0, 0], Infinity, 0.25), null);
});

test('sustained beats and postures hold through long phrases, then release cleanly', () => {
  for (const name of ['hand-beats', 'crossed-arms', 'hands-behind-back']) {
    assert.ok(npcGestureWeight(name, 12, 20) > 0.99);
    assert.ok(npcGesturePose(name, 12, 'right', 20));
    assert.equal(npcGesturePose(name, 20, 'right', 20), null);
  }
  assert.ok(npcGestureChestBounce('laugh-bounce', 0.3, 2, 0.45) > 0);
  assert.equal(npcGestureChestBounce('laugh-bounce', undefined, 2, 0.45), 0);
});

test('repeated gesture poses never accumulate wrist twist or shoulder bounce', async () => {
  const source = await readFile(new URL('../src/npcavatar.js', import.meta.url), 'utf8');
  const start = source.indexOf('    applyPose('), method = source.slice(start, source.indexOf('\n    setDetail(', start));
  const rotation = () => ({ x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } });
  const names = ['hips', 'spine', 'chest', 'head', ...['left', 'right'].flatMap(side =>
    ['UpperArm', 'Forearm', 'Hand', 'Thigh', 'Shin', 'Foot'].map(bone => side + bone))];
  const bones = Object.fromEntries(names.map(name => [name, { rotation: rotation(), position: { x: 0, y: 0.3, z: 0 } }]));
  const avatar = vm.runInNewContext(`({${method}})`, { bones, identity: { proportions: { height: 1 } },
    chestBindY: 0.3, occupiedHands: { left: false, right: false }, dims: { torsoLength: 0.45 },
    NPC_GESTURES, npcGesturePose, npcGestureArmTargets, npcGestureChestBounce, applyInteriorFurniturePose, updateFace() {},
  });
  const pose = { pelvis: { y: 1, sway: 0, lean: 0 }, torsoTwist: 0,
    legs: [-1, 1].map(side => ({ side, hip: 0.05, knee: 0.1, ankle: 0.1 })),
    arms: [-1, 1].map(side => ({ side, shoulder: 0.1, elbow: 0.1, wrist: 0.1, out: side * 0.04 })) };
  const speech = { gestureName: 'wave', gestureElapsed: 0.7, gestureDuration: 1.9 };
  avatar.applyPose(pose, 0, { speech });
  const twist = bones.rightHand.rotation.z;
  for (let i = 0; i < 50; i++) avatar.applyPose(pose, 0, { speech });
  assert.equal(bones.rightHand.rotation.z, twist);
  speech.gestureName = 'laugh-bounce'; avatar.applyPose(pose, 0, { speech });
  const bounce = bones.chest.position.y;
  for (let i = 0; i < 50; i++) avatar.applyPose(pose, 0, { speech });
  assert.equal(bones.chest.position.y, bounce);
  avatar.applyPose(pose, 0);
  assert.equal(bones.chest.position.y, 0.3);
  assert.equal(bones.rightHand.rotation.z, 0);
  avatar.applyPose(pose, 0, { furniturePose: { kind: 'sleep', height: 0.66, offsetZ: 0.6 } });
  avatar.applyPose(pose, 0);
  assert.equal(bones.hips.position.z, 0);
  assert.equal(bones.hips.rotation.x, 0);
  assert.equal(bones.hips.position.y, pose.pelvis.y);
});
