// How long a tame animal watches you for.
//
// A horse that has decided you are not a threat still turns its head when you
// walk up — and then it goes back to what it was doing. The old behaviour had
// no "and then": the alert stage held while the player was anywhere near, and
// the head stayed locked on for as long as you stood there, which is the stare
// of a predator rather than the glance of a grazing animal.
//
// So watching is a spell with an end. It runs for a couple of seconds, then the
// animal ignores you for a good deal longer, however close you are. Standing
// beside a horse for a minute gets you a handful of unhurried glances, which is
// what a horse in a field actually does.
//
// THREE-free, so the timing can be asserted without a renderer.

// How long one look lasts.
export const REGARD_HOLD = Object.freeze({ min: 1.4, max: 2.8 });
// And how long the animal goes back to its own business before another one is
// possible. Comfortably longer than the look, or the glances run together into
// the stare this exists to prevent.
export const REGARD_REST = Object.freeze({ min: 6.5, max: 15.0 });
// How far the head turns to look, in radians. A horse tracking you with its
// eyes barely moves its head — the wild-animal value of 0.62 (35 degrees) is a
// whole neck's worth of craning and read as a stare on its own.
export const REGARD_HEAD_TURN = 0.20;

export function createRegard() {
  return { hold: 0, rest: 0, weight: 0 };
}

/**
 * Advance the watching spell.
 *
 * `watching` is whether the player is close and visible RIGHT NOW — not whether
 * the animal remembers them, which persists for ten seconds or more and would
 * hold the look open long after the player had gone.
 *
 * Returns the 0..1 weight to scale the head turn by, ramped rather than
 * switched so the head swings round and back instead of snapping.
 */
export function advanceRegard(regard, dt, watching, rng = Math.random, rate = 2.4) {
  if (regard.hold > 0) {
    regard.hold -= dt;
    if (regard.hold <= 0) {
      regard.hold = 0;
      regard.rest = REGARD_REST.min + rng() * (REGARD_REST.max - REGARD_REST.min);
    }
  } else if (regard.rest > 0) {
    regard.rest = Math.max(0, regard.rest - dt);
  } else if (watching) {
    regard.hold = REGARD_HOLD.min + rng() * (REGARD_HOLD.max - REGARD_HOLD.min);
  }
  // A look that has begun plays out even if the player steps behind the animal
  // mid-glance; only a new one needs them to be there.
  const target = regard.hold > 0 ? 1 : 0;
  const k = 1 - Math.exp(-rate * Math.min(Math.max(dt, 0), 0.1));
  regard.weight += (target - regard.weight) * k;
  return regard.weight;
}
