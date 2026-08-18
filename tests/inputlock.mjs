// A player must always get their feet back.
//
// Travel takes the input lock and hands the release to a condition somewhere
// else: terrain finishing streaming, or a train arriving. Both releases used to
// funnel through one line in the render loop guarded by `if (!ready …)` — which
// the train case could never reach, because summoning the train happens while
// `ready` is still true. A journey that stalled therefore froze the player for
// the rest of the session with no timeout and no escape but a reload.
//
// These do not test that journeys succeed. They test that failing to succeed
// still leaves someone able to walk.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createInputLock, engageInputLock, tickInputLock } from '../src/inputlock.mjs';

// A stand-in for the controller's use of the lock: engage, tick each frame, and
// notice the frame on which it hands control back.
function lockHarness() {
  const lock = createInputLock();
  return {
    expiredWith: null,
    get inputLocked() { return lock.locked; },
    setInputLocked(locked, options) { engageInputLock(lock, locked, options); },
    tick(dt) {
      const expired = tickInputLock(lock, dt);
      if (expired) this.expiredWith = expired;
    },
  };
}

// --- an indefinite lock stays put, because scripted paths depend on it -------
{
  const controls = lockHarness();
  controls.setInputLocked(true);
  for (let i = 0; i < 600; i++) controls.tick(1 / 60);
  assert.equal(controls.inputLocked, true, 'a lock with no deadline is never released by time');
}

// --- a lock with a deadline releases itself, and names what it waited on -----
{
  const controls = lockHarness();
  controls.setInputLocked(true, { reason: 'waiting for the red commuter', timeoutSeconds: 30 });

  for (let i = 0; i < 29 * 60; i++) controls.tick(1 / 60);
  assert.equal(controls.inputLocked, true, 'the deadline is a deadline, not a hair trigger');

  for (let i = 0; i < 2 * 60; i++) controls.tick(1 / 60);
  assert.equal(controls.inputLocked, false, 'a wait that never resolves must hand control back');
  assert.equal(controls.expiredWith, 'waiting for the red commuter',
    'and must say which wait gave up, so the failure is legible');
}

// --- a journey that does complete is not interrupted -------------------------
{
  const controls = lockHarness();
  controls.setInputLocked(true, { reason: 'arriving', timeoutSeconds: 25 });
  for (let i = 0; i < 10 * 60; i++) controls.tick(1 / 60);
  controls.setInputLocked(false);                       // the arrival lands
  for (let i = 0; i < 60 * 60; i++) controls.tick(1 / 60);
  assert.equal(controls.expiredWith, null, 'a released lock must not expire afterwards');
  assert.equal(controls.inputLocked, false);
}

// --- every travel lock in main.js carries a deadline -------------------------
// The benchmark lock is deliberately indefinite; the travel ones must not be.
{
  const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const travelLocks = [...mainSource.matchAll(/setInputLocked\(true[^)]*\)/g)].map((m) => m[0]);
  assert.ok(travelLocks.length >= 3, 'the travel locks are still here to be checked');
  const withoutDeadline = travelLocks.filter((call) => !/timeoutSeconds/.test(call));
  assert.equal(withoutDeadline.length, 1,
    `only the scripted benchmark lock may be indefinite, found: ${withoutDeadline.join(' | ')}`);
  assert.match(mainSource, /controls\.onInputLockExpired = /,
    'an expired lock must be handled, not merely released');
}

console.log('inputlock PASS · indefinite locks unchanged · a stalled journey always returns control · '
  + 'a completed one is left alone · every travel lock carries a deadline');

// --- the controller must still answer every call the app makes to it ---------
// Refactoring the lock deleted suspendInput() and requestJump() outright: the
// edit spliced the file by text offsets and swallowed the two methods sitting
// between the pieces it meant to replace. Nothing failed at load — the throw
// only happened when the overlay was clicked, which is the one moment pointer
// lock is requested, so mouselook simply stopped working with no clue why.
{
  const controlsSource = await readFile(new URL('../src/controls.js', import.meta.url), 'utf8');
  const declared = new Set(
    [...controlsSource.matchAll(/^ {2}([a-zA-Z_][\w]*)\s*\(/gm)].map((m) => m[1]),
  );

  const sources = await Promise.all(
    ['main.js', 'debug.js'].map((f) => readFile(new URL(`../src/${f}`, import.meta.url), 'utf8')),
  );
  const called = new Set();
  for (const source of sources) {
    for (const [, name] of source.matchAll(/\bcontrols\.([a-zA-Z_][\w]*)\s*\(/g)) called.add(name);
  }

  const missing = [...called].filter((name) => !declared.has(name));
  assert.deepEqual(missing, [],
    `main.js and debug.js call PlayerControls methods that do not exist: ${missing.join(', ')}`);

  // The two that were actually lost, named so a regression is unmistakable.
  for (const method of ['suspendInput', 'requestJump', 'setInputLocked', 'place', 'update']) {
    assert.ok(declared.has(method), `PlayerControls must still declare ${method}()`);
  }
}

console.log('inputlock PASS · every controls method the app calls still exists');
