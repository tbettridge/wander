// A tame animal glances at you; it does not stare.
//
// The reported bug: standing anywhere near a horse held its head locked on you
// for as long as you were there. What the numbers below pin down is that the
// looking is a small fraction of the time even when the player never leaves,
// and that the head barely moves while it happens.

import assert from 'node:assert/strict';
import {
  REGARD_HEAD_TURN, REGARD_HOLD, REGARD_REST, advanceRegard, createRegard,
} from '../src/animalregard.mjs';
import { mulberry32 } from '../src/noise.js';

const dt = 1 / 60;

function watchFor(seconds, watching, rng) {
  const regard = createRegard();
  const frames = Math.round(seconds / dt);
  let looking = 0, peak = 0, spells = 0, wasLooking = false;
  for (let i = 0; i < frames; i++) {
    const weight = advanceRegard(regard, dt, watching, rng);
    peak = Math.max(peak, weight);
    const nowLooking = regard.hold > 0;
    if (nowLooking && !wasLooking) spells++;
    if (nowLooking) looking++;
    wasLooking = nowLooking;
  }
  return { fraction: looking / frames, peak, spells };
}

// --- standing next to a horse for a minute gets you glances, not a stare ----------
{
  const { fraction, peak, spells } = watchFor(120, true, mulberry32(31));
  assert.ok(fraction < 0.30,
    `the horse watched for ${(fraction * 100).toFixed(0)}% of two minutes — that is a stare`);
  assert.ok(fraction > 0.05,
    `the horse barely looked at all (${(fraction * 100).toFixed(0)}%) — it should notice you`);
  assert.ok(spells >= 4, `expected several separate glances over two minutes, got ${spells}`);
  assert.ok(peak > 0.9, 'a glance should actually complete, not fade in and out unresolved');
}

// --- and each one is brief --------------------------------------------------------
{
  const rng = mulberry32(9);
  const regard = createRegard();
  // Run to the start of a look, then time it.
  while (regard.hold <= 0) advanceRegard(regard, dt, true, rng);
  let held = 0;
  while (regard.hold > 0) { advanceRegard(regard, dt, true, rng); held += dt; }
  assert.ok(held <= REGARD_HOLD.max + dt * 2, `a look ran ${held.toFixed(2)}s`);
  assert.ok(held >= REGARD_HOLD.min - dt * 2, `a look lasted only ${held.toFixed(2)}s`);
  // And the rest between looks is comfortably longer, or they run together.
  assert.ok(REGARD_REST.min > REGARD_HOLD.max,
    'the gap between looks must exceed a look, or the glances merge into a stare');
}

// --- the player leaving stops it starting again ---------------------------------------
{
  const away = watchFor(60, false, mulberry32(5));
  assert.equal(away.fraction, 0, 'an animal that cannot see you must not watch you');
  assert.equal(away.spells, 0);
}

// --- a look already begun plays out --------------------------------------------------
{
  const rng = mulberry32(17);
  const regard = createRegard();
  while (regard.hold <= 0) advanceRegard(regard, dt, true, rng);
  // The player steps out of sight mid-glance.
  const before = regard.hold;
  advanceRegard(regard, dt, false, rng);
  assert.ok(regard.hold > 0 && regard.hold < before,
    'a glance should finish rather than snapping off mid-turn');
}

// --- the head barely moves ------------------------------------------------------------
{
  // The wild-game value is 0.62rad — a whole neck's worth of craning, which is
  // what made a horse's polite glance read as a predator's stare.
  assert.ok(REGARD_HEAD_TURN < 0.30,
    `${REGARD_HEAD_TURN}rad is too much neck for a glance`);
  assert.ok(REGARD_HEAD_TURN > 0.10, 'but it should still be a visible turn of the head');
}

// --- deterministic for a seeded animal ---------------------------------------------------
{
  const a = watchFor(30, true, mulberry32(404));
  const b = watchFor(30, true, mulberry32(404));
  assert.deepEqual(a, b, 'the same animal must behave the same way twice');
}

console.log('animalregard PASS · brief glances · long rests · expires with the player · small turn');
