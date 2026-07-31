import assert from 'node:assert/strict';
import {
  advanceConversation, advanceEmote, createConversation, createEmote,
  gestureAmount, nodPitch, pulseDelivery, pulseGesture, pulseNod, SOCIAL,
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

console.log('npcsocial PASS · gestures arc out and back · nods return the head · '
  + 'only the speaker gestures and only the listener nods · the floor changes hands · '
  + 'conversations end · delivered lines are marked · seeded');
