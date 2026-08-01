// The one rule that decides whether a walker stands on a bridge or in the river.
//
// This existed only inside controls.js, tangled with THREE and a rig, so it was
// never asserted anywhere. It was also wrong for months in a way no test here
// could see: an active environment discarded a bridge deck outright, so the
// crossing code could be perfect — and was — while the player fell through.
//
// The measured failure that produced these cases:
//   [floor] env=active ground=19.31 deck=22.15 floor=19.30 y=19.33 wet=true
// The deck was found every frame, reported every frame, and used by nothing.

import assert from 'node:assert/strict';
import { resolveFloor } from '../src/floor.mjs';

const WATER = 0;
const base = {
  hasEnvironment: false, indoors: false, environmentFloor: null,
  deck: null, ground: 19.31, lastY: 19.33, waterLevel: WATER,
};

// --- the regression itself ----------------------------------------------------
{
  const floor = resolveFloor({
    ...base, hasEnvironment: true, indoors: false,
    environmentFloor: 19.30, deck: 22.15,
  });
  assert.equal(floor, 22.15,
    'an outdoor environment must not veto a bridge deck — this is the bug that '
    + 'made every trail crossing unwalkable while reporting itself as working');
}

// --- but an interior still owns its own vertical domain -----------------------
{
  const floor = resolveFloor({
    ...base, hasEnvironment: true, indoors: true,
    environmentFloor: 19.30, deck: 22.15,
  });
  assert.equal(floor, 19.30,
    'a deck must never pull a walker up through a cave roof');
}

// --- a missing environment floor freezes rather than drops --------------------
{
  const floor = resolveFloor({
    ...base, hasEnvironment: true, indoors: true,
    environmentFloor: null, deck: null, lastY: 12.5,
  });
  assert.equal(floor, 12.5,
    'no cave floor here means hold the last safe height, not fall to terrain');
}

// --- outdoors, the deck wins over terrain, and terrain wins over nothing ------
{
  assert.equal(resolveFloor({ ...base, deck: 22.15 }), 22.15,
    'a deck outdoors carries the walker');
  assert.equal(resolveFloor({ ...base, deck: null }), 19.31,
    'no deck means the ground');
  assert.equal(resolveFloor({ ...base, deck: 18.0 }), 19.31,
    'a deck below the ground is not a floor');
}

// --- wading is allowed, sinking forever is not --------------------------------
{
  const floor = resolveFloor({ ...base, ground: -40, deck: null });
  assert.equal(floor, WATER - 1.2,
    'a walker can wade, but the seabed does not swallow them');
}

// --- a deck the environment cannot see, at the height it was measured at ------
// The numbers are the ones read off the running game, so a regression here
// reproduces the exact experience rather than an abstraction of it.
{
  const samples = [
    { ground: 19.31, environmentFloor: 19.30, deck: 22.15 },
    { ground: 19.14, environmentFloor: 19.12, deck: 22.15 },
    { ground: 20.12, environmentFloor: 20.15, deck: 22.15 },
    { ground: 19.38, environmentFloor: 19.38, deck: 22.15 },
  ];
  for (const s of samples) {
    const floor = resolveFloor({ ...base, hasEnvironment: true, ...s });
    assert.equal(floor, 22.15,
      `standing on the deck at ground ${s.ground} must resolve to the deck`);
  }
}

console.log('floor PASS · an outdoor environment no longer discards a bridge deck · '
  + 'an interior still owns its vertical domain · a missing cave floor freezes '
  + 'rather than drops · wading is allowed and sinking is not');
