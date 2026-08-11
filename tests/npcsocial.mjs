import assert from 'node:assert/strict';
import {
  advanceConversation, advanceEmote, beginDeliberation, createConversation, createEmote,
  deliberationLookAway, endDeliberation, gestureAmount, nodPitch, pulseDelivery,
  pulseGesture, pulseNod, SOCIAL,
} from '../src/npcsocial.mjs';

const dt = 1 / 60;

// --- a beat is an arc, out and back ------------------------------------------
{
  const emote = createEmote(1);
  assert.equal(gestureAmount(emote), 0, 'a resting resident is not mid-gesture');
  pulseGesture(emote);
  let peak = 0;
  let frames = 0;
  while (emote.gestureLive && frames < 600) {
    advanceEmote(emote, dt);
    peak = Math.max(peak, gestureAmount(emote));
    frames++;
  }
  assert.ok(peak > 0.9, `a gesture should reach its full extent, peaked at ${peak.toFixed(2)}`);
  assert.equal(gestureAmount(emote), 0, 'and must always come back down — no arm left in the air');
  assert.ok(Math.abs(frames * dt - SOCIAL.gestureDuration) < 0.05, 'over about its stated duration');
}

// --- a nod dips the chin and returns ------------------------------------------
{
  const emote = createEmote(2);
  pulseNod(emote);
  let peak = 0;
  while (emote.nodLive) { advanceEmote(emote, dt); peak = Math.max(peak, nodPitch(emote)); }
  assert.ok(peak > SOCIAL.nodDepth * 0.9, 'a nod should reach its depth');
  assert.ok(peak <= SOCIAL.nodDepth + 1e-9, 'and never exceed it');
  assert.equal(nodPitch(emote), 0, 'and always return the head to where it was');
}

// --- only the speaker gestures, only the listener nods -------------------------
{
  const convo = createConversation(4242);
  const emotes = [createEmote(10), createEmote(11)];
  let gestures = 0;
  let nods = 0;
  for (let f = 0; f < 60 * 60; f++) {
    const before = emotes.map((e) => ({ g: e.gestureT, n: e.nodT }));
    advanceConversation(convo, dt, emotes);
    if (convo.done) break;
    emotes.forEach((e, side) => {
      // A pulse resets its clock to zero; that is the frame it was triggered.
      if (e.gestureT === 0 && before[side].g !== 0) {
        assert.equal(side, convo.speaker, 'only whoever holds the floor may gesture');
        gestures++;
      }
      if (e.nodT === 0 && before[side].n !== 0) {
        assert.equal(side, 1 - convo.speaker, 'only whoever is listening may nod');
        nods++;
      }
    });
    emotes.forEach((e) => advanceEmote(e, dt));
  }
  assert.ok(gestures > 3, `a conversation should contain gestures, saw ${gestures}`);
  assert.ok(nods > 2, `and nods, saw ${nods}`);
}

// --- the floor changes hands, and the talk ends -------------------------------
{
  const convo = createConversation(77);
  const seen = new Set([convo.speaker]);
  let elapsed = 0;
  while (!convo.done && elapsed < 120) {
    advanceConversation(convo, dt, [createEmote(1), createEmote(2)]);
    seen.add(convo.speaker);
    elapsed += dt;
  }
  assert.equal(seen.size, 2, 'both residents should get a turn to speak');
  assert.ok(convo.done, 'a conversation must end rather than run forever');
  assert.ok(elapsed <= SOCIAL.maxDuration + 1, `and inside its stated life, ran ${elapsed.toFixed(1)}s`);
  // Once done it stays done and stops pulsing.
  const after = createEmote(3);
  advanceConversation(convo, dt, [after, after]);
  assert.ok(!after.gestureLive && !after.nodLive, 'a finished conversation must not keep gesturing');
}

// --- delivering a line to the player always marks it --------------------------
{
  const emote = createEmote(9);
  pulseDelivery(emote);
  assert.ok(emote.gestureLive, 'a delivered line is always marked with a gesture');
}

// --- one semantic beat becomes ready during the physical conversation ---------
{
  const convo = createConversation(41, {
    id: 'conversation:npc:a|npc:b:1', participantIds: ['npc:a', 'npc:b'],
  });
  assert.equal(convo.exchangeReady, false);
  while (!convo.exchangeReady && !convo.done) advanceConversation(convo, dt, []);
  assert.equal(convo.exchangeReady, true, 'the exchange seam should open during the talk');
  convo.exchangeDone = true;
  convo.exchangeReady = false;
  for (let i = 0; i < 600; i++) advanceConversation(convo, dt, []);
  assert.equal(convo.exchangeReady, false, 'a completed semantic beat never reopens');
}

// --- seeded and repeatable -----------------------------------------------------
{
  const a = createConversation(31337);
  const b = createConversation(31337);
  for (let f = 0; f < 600; f++) {
    advanceConversation(a, dt, []);
    advanceConversation(b, dt, []);
  }
  assert.equal(a.speaker, b.speaker, 'a seeded conversation must run the same way every time');
  assert.ok(Math.abs(a.life - b.life) < 1e-12, 'including how long it lasts');
}

// --- composing an answer has a shape -----------------------------------------
// The seconds an on-device reply takes used to be seconds of an unbroken stare.
{
  const emote = createEmote(9);
  assert.equal(deliberationLookAway(emote), false, 'a resting resident is not mid-thought');

  beginDeliberation(emote);
  assert.equal(deliberationLookAway(emote), false,
    'deliberation opens holding the asker\'s eye — the pause is a reaction, not a delay');

  // The eyes leave, come back, and leave again for as long as it takes.
  let sawAway = false;
  let sawReturn = false;
  let flips = 0;
  let previous = false;
  for (let step = 0; step < 60 / dt; step++) {
    advanceEmote(emote, dt);
    const away = deliberationLookAway(emote);
    if (away) sawAway = true; else if (sawAway) sawReturn = true;
    if (away !== previous) flips++;
    previous = away;
  }
  assert.ok(sawAway, 'a thinking resident looks away');
  assert.ok(sawReturn, 'and comes back, rather than staring off for the whole wait');
  assert.ok(flips > 12, `the rhythm keeps going, saw ${flips} changes`);

  // Away beats are the thinking; the returns are punctuation between them.
  let away = 0;
  for (let step = 0; step < 120 / dt; step++) {
    advanceEmote(emote, dt);
    if (deliberationLookAway(emote)) away++;
  }
  const awayShare = away / (120 / dt);
  assert.ok(awayShare > 0.5 && awayShare < 0.8,
    `most of a thought is spent looking away, got ${awayShare.toFixed(2)}`);

  endDeliberation(emote);
  assert.equal(deliberationLookAway(emote), false, 'the answer arriving returns the eyes');
  for (let step = 0; step < 5 / dt; step++) advanceEmote(emote, dt);
  assert.equal(deliberationLookAway(emote), false, 'and they stay returned');
}

// Hands move while a thought is gathered, but far less than while one is
// delivered — and a beat is never left mid-arc when the answer lands.
{
  const emote = createEmote(3);
  beginDeliberation(emote);
  let beats = 0;
  let live = false;
  for (let step = 0; step < 60 / dt; step++) {
    advanceEmote(emote, dt);
    if (emote.gestureLive && !live) beats++;
    live = emote.gestureLive;
  }
  assert.ok(beats > 0 && beats < 30, `thinking gestures are occasional, got ${beats} in a minute`);
  endDeliberation(emote);
  for (let step = 0; step < 2 / dt; step++) advanceEmote(emote, dt);
  assert.equal(gestureAmount(emote), 0, 'no arm is left raised when deliberation ends');
}

// Beginning twice must not restart the rhythm — a rebuild-and-retry inside one
// request would otherwise reset the eyes to the player every attempt.
{
  const emote = createEmote(5);
  beginDeliberation(emote);
  for (let step = 0; step < 3 / dt; step++) advanceEmote(emote, dt);
  const before = { away: deliberationLookAway(emote), timer: emote.thinkTimer };
  beginDeliberation(emote);
  assert.deepEqual({ away: deliberationLookAway(emote), timer: emote.thinkTimer }, before,
    'a second begin is a no-op while already thinking');
}

// Ending is safe on an absent emote: the dialogue can close before a reply
// lands, and the close path ends deliberation unconditionally.
assert.doesNotThrow(() => endDeliberation(null));
assert.equal(deliberationLookAway(null), false);

console.log('npcsocial PASS · gestures arc out and back · nods return the head · '
  + 'only the speaker gestures and only the listener nods · the floor changes hands · '
  + 'conversations end · delivered lines are marked · thinking has a rhythm · seeded');
