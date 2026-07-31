// Residents talking to each other, and the small physical business that makes a
// line land.
//
// Two things live here. The first is a conversation: two residents standing
// near each other fall into talk, hand the floor back and forth for a while,
// and part. Only one of them holds the floor at a time, and that is what drives
// the second thing — the beats. Whoever is speaking gestures; whoever is
// listening nods. It is a small amount of movement, but it is the difference
// between two figures standing near each other and two people talking.
//
// The same beats are used when a resident delivers a line to the player, which
// is why they are a separate, callable pulse rather than something a
// conversation owns privately: a reply arriving in the dialogue box triggers
// exactly the gesture a reply would.
//
// Envelopes run FORWARD from zero rather than decaying from one, so every beat
// is an arc — out and back — and an interrupted one can never leave an arm
// stuck in the air.
//
// THREE-free, so the behaviour can be asserted without a renderer.

import { mulberry32 } from './noise.js';

export const SOCIAL = Object.freeze({
  // How close two residents must be standing to fall into conversation, and how
  // far apart they may drift before it breaks off.
  range: 2.8,
  breakRange: 5.0,
  checkInterval: 2.5,
  startChance: 0.34,
  // Residents are posted the length of a platform apart, so someone has to
  // cross the distance before there is any conversation to have.
  approachRange: 16,
  approachChance: 0.26,
  minDuration: 10,
  maxDuration: 28,
  // How long one of them holds the floor before handing it over.
  turnMin: 2.4,
  turnMax: 6.0,
  // Beats within a turn: a speaker gestures every so often, not continuously.
  beatMin: 1.2,
  beatMax: 2.8,
  gestureChance: 0.62,
  nodChance: 0.5,
  gestureDuration: 0.85,
  nodDuration: 0.62,
  nodDepth: 0.17,
  // Pointing something out across country is a longer, held movement than a
  // conversational beat: the arm comes up, stays up while the sentence is
  // spoken, and drops.
  pointAttack: 0.42,
  pointHold: 2.6,
  pointRelease: 0.7,
});

export function createEmote(seed = 1) {
  return {
    rng: mulberry32(seed >>> 0),
    gestureT: 1, gestureLive: false,
    nodT: 1, nodLive: false,
    pointT: 0, pointLive: false, pointHold: 0, pointBearing: 0,
  };
}

/**
 * Point something out, and hold it there.
 *
 * `bearing` is a world direction, which the renderer both turns the body toward
 * and aims the arm along — the two have to agree or the resident points past
 * whatever they are talking about.
 */
export function pulsePoint(emote, bearing = 0, hold = SOCIAL.pointHold) {
  emote.pointT = 0;
  emote.pointHold = Math.max(0, hold);
  emote.pointLive = true;
  emote.pointBearing = bearing;
  return emote;
}

/** 0 at rest, 1 while the arm is up: attack, hold, release. */
export function pointAmount(emote) {
  if (!emote.pointLive) return 0;
  const { pointAttack, pointRelease } = SOCIAL;
  const t = emote.pointT;
  if (t < pointAttack) return t / pointAttack;
  const held = pointAttack + emote.pointHold;
  if (t < held) return 1;
  return Math.max(0, 1 - (t - held) / pointRelease);
}

export function pulseGesture(emote) {
  emote.gestureT = 0;
  emote.gestureLive = true;
  return emote;
}

export function pulseNod(emote) {
  emote.nodT = 0;
  emote.nodLive = true;
  return emote;
}

export function advanceEmote(emote, dt = 0.016) {
  if (emote.gestureLive) {
    emote.gestureT += dt / SOCIAL.gestureDuration;
    if (emote.gestureT >= 1) { emote.gestureT = 1; emote.gestureLive = false; }
  }
  if (emote.nodLive) {
    emote.nodT += dt / SOCIAL.nodDuration;
    if (emote.nodT >= 1) { emote.nodT = 1; emote.nodLive = false; }
  }
  if (emote.pointLive) {
    emote.pointT += dt;
    if (emote.pointT >= SOCIAL.pointAttack + emote.pointHold + SOCIAL.pointRelease) {
      emote.pointLive = false;
    }
  }
  return emote;
}

/** 0 at rest, peaking mid-beat: the arc of one gesture. */
export function gestureAmount(emote) {
  return emote.gestureLive ? Math.sin(emote.gestureT * Math.PI) : 0;
}

/** Head-pitch offset for a nod. Positive dips the chin, and it always returns. */
export function nodPitch(emote) {
  return emote.nodLive ? Math.sin(emote.nodT * Math.PI) * SOCIAL.nodDepth : 0;
}

export function createConversation(seed = 1) {
  const rng = mulberry32(seed >>> 0);
  return {
    rng,
    speaker: rng() < 0.5 ? 0 : 1,
    life: SOCIAL.minDuration + rng() * (SOCIAL.maxDuration - SOCIAL.minDuration),
    turn: SOCIAL.turnMin + rng() * (SOCIAL.turnMax - SOCIAL.turnMin),
    beat: 0,
    done: false,
  };
}

/**
 * Advance a conversation and pulse its two participants.
 *
 * `emotes` is [sideZero, sideOne], matching `speaker`. Gestures only ever fire
 * on whoever currently holds the floor, and nods only on whoever does not.
 */
export function advanceConversation(convo, dt = 0.016, emotes = []) {
  if (convo.done) return convo;
  convo.life -= dt;
  if (convo.life <= 0) {
    convo.done = true;
    return convo;
  }
  convo.turn -= dt;
  if (convo.turn <= 0) {
    convo.speaker = 1 - convo.speaker;
    convo.turn = SOCIAL.turnMin + convo.rng() * (SOCIAL.turnMax - SOCIAL.turnMin);
    // Taking the floor is itself worth a beat.
    convo.beat = 0;
  }
  convo.beat -= dt;
  if (convo.beat <= 0) {
    convo.beat = SOCIAL.beatMin + convo.rng() * (SOCIAL.beatMax - SOCIAL.beatMin);
    const speaking = emotes[convo.speaker];
    const listening = emotes[1 - convo.speaker];
    if (speaking && convo.rng() < SOCIAL.gestureChance) pulseGesture(speaking);
    if (listening && convo.rng() < SOCIAL.nodChance) pulseNod(listening);
  }
  return convo;
}

/**
 * The beat for a line delivered to the player: a gesture, and often a nod with
 * it. Called when a reply arrives, not while the dialogue box merely sits open,
 * so the movement marks the line instead of running underneath the whole
 * conversation.
 */
export function pulseDelivery(emote) {
  pulseGesture(emote);
  if (emote.rng() < 0.45) pulseNod(emote);
  return emote;
}
